import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { marked } from "marked";
import { memberSpaceIds } from "./access";
import { summariseMeeting, transcribe } from "./ai";
import { all, bad, escapeHtml, first, forbidden, htmlText, indexDoc, notFound, now, parseJSON, run, uid, unindexDoc, type Env, type HonoEnv, type User } from "./env";
import { emailLayout, notify, sendMail } from "./mail";
import { visibleMeetingIds } from "./misc";
import { createTask } from "./tasks";

type MeetingRow = {
  id: string; title: string; space_id: string | null; organizer_id: string;
  status: "recording" | "processing" | "review" | "sent" | "failed";
  started_at: number; duration_s: number; transcript: string; summary_doc: string | null; summary_html: string;
  error: string | null; sent_at: number | null; source_url: string | null; created_at: number;
};
type Participant = { id: string; meeting_id: string; user_id: string | null; name: string; email: string; notify: number };
type Segment = { meeting_id: string; idx: number; r2_key: string; mime: string; bytes: number; status: "pending" | "done" | "failed"; text: string };
type Item = { id: string; meeting_id: string; kind: "task" | "knowledge"; payload: string; accepted: number; sort: number };

export type TaskPayload = { title: string; assignee_id: string | null; owner_name: string | null; due: string | null; context: string; needs_owner: boolean; duplicate_of: string | null };
export type KnowledgePayload = { kind: string; title: string; body: string };

const MAX_SEGMENT_BYTES = 30 * 1024 * 1024;

async function getMeeting(env: Env, id: string): Promise<MeetingRow> {
  const m = await first<MeetingRow>(env.DB, "SELECT * FROM meetings WHERE id = ?", id);
  if (!m) throw notFound("That meeting doesn't exist.");
  return m;
}

/** The organiser (or anyone, for an already-sent meeting they can see). */
async function requireOrganiser(env: Env, user: User, id: string): Promise<MeetingRow> {
  const m = await getMeeting(env, id);
  if (m.organizer_id !== user.id) throw forbidden("Only the person who recorded this meeting can change it.");
  return m;
}

async function detail(env: Env, m: MeetingRow) {
  const [participants, segments, items] = await Promise.all([
    all<Participant>(env.DB, "SELECT * FROM meeting_participants WHERE meeting_id = ? ORDER BY rowid", m.id),
    all<Pick<Segment, "idx" | "status" | "bytes">>(env.DB, "SELECT idx, status, bytes FROM meeting_segments WHERE meeting_id = ? ORDER BY idx", m.id),
    all<Item>(env.DB, "SELECT * FROM meeting_items WHERE meeting_id = ? ORDER BY sort", m.id),
  ]);
  return {
    meeting: { ...m, summary_doc: parseJSON(m.summary_doc, null) },
    participants: participants.map((p) => ({ ...p, notify: !!p.notify })),
    segments,
    items: items.map((i) => ({ id: i.id, kind: i.kind, accepted: !!i.accepted, payload: parseJSON<Record<string, unknown>>(i.payload, {}) })),
  };
}

async function setParticipants(env: Env, meetingId: string, list: { user_id?: string | null; name?: string; email?: string; notify?: boolean }[]) {
  const users = await all<{ id: string; name: string; email: string }>(env.DB, "SELECT id, name, email FROM users WHERE active = 1");
  const byId = new Map(users.map((u) => [u.id, u]));
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
  const stmts = [env.DB.prepare("DELETE FROM meeting_participants WHERE meeting_id = ?").bind(meetingId)];
  const seen = new Set<string>();
  for (const p of list.slice(0, 60)) {
    const email = (p.email ?? "").trim().toLowerCase();
    const u = (p.user_id && byId.get(p.user_id)) || (email && byEmail.get(email)) || null;
    const key = u ? u.id : email || (p.name ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    stmts.push(
      env.DB.prepare("INSERT INTO meeting_participants (id, meeting_id, user_id, name, email, notify) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(uid(), meetingId, u?.id ?? null, u?.name ?? (p.name ?? "").trim().slice(0, 120), u?.email ?? email, p.notify === false ? 0 : 1),
    );
  }
  await env.DB.batch(stmts);
}

async function transcribeSegment(env: Env, m: MeetingRow, idx: number, hint: string) {
  const seg = await first<Segment>(env.DB, "SELECT * FROM meeting_segments WHERE meeting_id = ? AND idx = ?", m.id, idx);
  if (!seg || seg.status === "done") return;
  try {
    const obj = await env.FILES.get(seg.r2_key);
    if (!obj) throw new Error("recording segment is missing");
    const text = await transcribe(env, await obj.arrayBuffer(), hint);
    await run(env.DB, "UPDATE meeting_segments SET status = 'done', text = ? WHERE meeting_id = ? AND idx = ?", text, m.id, idx);
  } catch (e) {
    console.error("transcription failed", m.id, idx, e);
    await run(env.DB, "UPDATE meeting_segments SET status = 'failed' WHERE meeting_id = ? AND idx = ?", m.id, idx);
  }
}

/** Names and terms that help Whisper spell things correctly. */
async function vocabularyHint(env: Env, m: MeetingRow): Promise<string> {
  const people = await all<{ name: string }>(env.DB, "SELECT name FROM meeting_participants WHERE meeting_id = ?", m.id);
  const spaces = await all<{ name: string }>(env.DB, "SELECT name FROM spaces WHERE archived = 0");
  return `${m.title}. ${[...people.map((p) => p.name), ...spaces.map((s) => s.name)].filter(Boolean).join(", ")}.`;
}

export const meetings = new Hono<HonoEnv>();

meetings.get("/", async (c) => {
  const user = c.var.user;
  const visible = await visibleMeetingIds(c.env, user, await memberSpaceIds(c.env, user));
  const rows = await all<MeetingRow & { people: string | null }>(
    c.env.DB,
    `SELECT m.id, m.title, m.space_id, m.organizer_id, m.status, m.started_at, m.duration_s, m.sent_at, m.error,
            substr(m.summary_html, 1, 600) AS summary_html,
            (SELECT group_concat(COALESCE(p.user_id, p.name), '|') FROM meeting_participants p WHERE p.meeting_id = m.id) AS people
       FROM meetings m ORDER BY m.started_at DESC LIMIT 500`,
  );
  return c.json({
    meetings: rows.filter((m) => visible.has(m.id)).map((m) => ({ ...m, summary_html: undefined, preview: htmlText(m.summary_html).slice(0, 220), people: m.people ? m.people.split("|") : [] })),
  });
});

meetings.post("/", async (c) => {
  const user = c.var.user;
  if (user.role === "guest") throw forbidden("Guests can't record meetings.");
  const b = await c.req.json<{ title?: string; space_id?: string | null; participants?: { user_id?: string; name?: string; email?: string }[] }>();
  if (b.space_id && !(await memberSpaceIds(c.env, user)).has(b.space_id)) throw forbidden("You're not a member of that space.");
  const id = uid();
  const t = now();
  await run(
    c.env.DB, "INSERT INTO meetings (id, title, space_id, organizer_id, status, started_at, created_at) VALUES (?, ?, ?, ?, 'recording', ?, ?)",
    id, (b.title ?? "").trim().slice(0, 200), b.space_id ?? null, user.id, t, t,
  );
  await setParticipants(c.env, id, [{ user_id: user.id }, ...(b.participants ?? [])]);
  return c.json({ id });
});

meetings.get("/:id", async (c) => {
  const user = c.var.user;
  const m = await getMeeting(c.env, c.req.param("id"));
  const visible = await visibleMeetingIds(c.env, user, await memberSpaceIds(c.env, user));
  if (!visible.has(m.id)) throw forbidden("You don't have access to this meeting.");
  const d = await detail(c.env, m);
  // The review queue belongs to the organiser; everyone else sees the finished result.
  if (m.organizer_id !== user.id) d.items = [];
  return c.json({ ...d, isOrganiser: m.organizer_id === user.id });
});

meetings.patch("/:id", async (c) => {
  const m = await requireOrganiser(c.env, c.var.user, c.req.param("id"));
  const b = await c.req.json<{ title?: string; space_id?: string | null; summary_doc?: unknown; summary_html?: string; participants?: { user_id?: string | null; name?: string; email?: string; notify?: boolean }[] }>();
  if (b.title !== undefined) await run(c.env.DB, "UPDATE meetings SET title = ? WHERE id = ?", b.title.trim().slice(0, 200), m.id);
  if (b.space_id !== undefined) {
    if (b.space_id && !(await memberSpaceIds(c.env, c.var.user)).has(b.space_id)) throw forbidden();
    await run(c.env.DB, "UPDATE meetings SET space_id = ? WHERE id = ?", b.space_id, m.id);
  }
  if (b.summary_html !== undefined) {
    await run(c.env.DB, "UPDATE meetings SET summary_html = ?, summary_doc = ? WHERE id = ?", b.summary_html, b.summary_doc ? JSON.stringify(b.summary_doc) : null, m.id);
  }
  if (b.participants) await setParticipants(c.env, m.id, b.participants);
  const fresh = await getMeeting(c.env, m.id);
  if (fresh.status === "sent") await indexDoc(c.env.DB, "meeting", m.id, fresh.title, `${htmlText(fresh.summary_html)}\n${fresh.transcript}`);
  return c.json({ ok: true });
});

// The recorder uploads audio in self-contained segments while the meeting is still going,
// so a dropped connection or closed tab loses at most the segment in progress.
meetings.put("/:id/segments/:idx", async (c) => {
  const m = await requireOrganiser(c.env, c.var.user, c.req.param("id"));
  if (m.status !== "recording" && m.status !== "processing") throw bad("This meeting is no longer recording.");
  const idx = Number(c.req.param("idx"));
  if (!Number.isInteger(idx) || idx < 0 || idx > 2000) throw bad("Bad segment number.");
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) throw bad("Empty segment.");
  if (buf.byteLength > MAX_SEGMENT_BYTES) throw bad("Segment too large.");
  const mime = (c.req.header("content-type") ?? "audio/webm").split(";")[0];
  const key = `meetings/${m.id}/${String(idx).padStart(4, "0")}`;
  await c.env.FILES.put(key, buf, { httpMetadata: { contentType: mime } });
  await run(
    c.env.DB,
    `INSERT INTO meeting_segments (meeting_id, idx, r2_key, mime, bytes) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (meeting_id, idx) DO UPDATE SET bytes = excluded.bytes, mime = excluded.mime, status = 'pending', text = ''`,
    m.id, idx, key, mime, buf.byteLength,
  );
  // Start transcribing straight away so most of the work is done by the time the meeting ends.
  c.executionCtx.waitUntil(vocabularyHint(c.env, m).then((hint) => transcribeSegment(c.env, m, idx, hint)));
  return c.json({ ok: true });
});

meetings.post("/:id/finish", async (c) => {
  const m = await requireOrganiser(c.env, c.var.user, c.req.param("id"));
  const b = await c.req.json<{ duration_s?: number }>().catch(() => ({} as { duration_s?: number }));
  if (m.status === "recording") {
    await run(c.env.DB, "UPDATE meetings SET status = 'processing', duration_s = ? WHERE id = ?", Math.max(0, Math.round(b.duration_s ?? 0)), m.id);
  }
  return c.json({ ok: true });
});

// Transcribes whatever is left, then asks Claude for the summary, tasks and knowledge notes.
// Progress is streamed so the organiser sees what is happening; the call is safe to repeat.
meetings.post("/:id/process", async (c) => {
  const user = c.var.user;
  const m = await requireOrganiser(c.env, user, c.req.param("id"));
  if (m.status === "sent") throw bad("This meeting has already been sent.");
  const env = c.env;
  const origin = c.var.origin;

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
    const beat = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }), 10_000);
    try {
      await run(env.DB, "UPDATE meetings SET status = 'processing', error = NULL WHERE id = ?", m.id);
      const hint = await vocabularyHint(env, m);
      // Segments may still be transcribing from the upload; give those a moment, then do the rest here.
      let pending = await all<Segment>(env.DB, "SELECT * FROM meeting_segments WHERE meeting_id = ? AND status != 'done' ORDER BY idx", m.id);
      const total = (await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM meeting_segments WHERE meeting_id = ?", m.id))?.n ?? 0;
      if (!total) throw new Error("No audio was recorded for this meeting.");
      await send("progress", { stage: "transcribing", done: total - pending.length, total });
      for (let i = 0; i < pending.length; i += 3) {
        await Promise.all(pending.slice(i, i + 3).map((s) => transcribeSegment(env, m, s.idx, hint)));
        await send("progress", { stage: "transcribing", done: total - Math.max(0, pending.length - i - 3), total });
      }
      pending = await all<Segment>(env.DB, "SELECT * FROM meeting_segments WHERE meeting_id = ? AND status != 'done'", m.id);
      if (pending.length === total) throw new Error("The recording couldn't be transcribed. Try again in a minute.");

      const segs = await all<Segment>(env.DB, "SELECT * FROM meeting_segments WHERE meeting_id = ? ORDER BY idx", m.id);
      const transcript = segs.map((s) => s.text.trim()).filter(Boolean).join("\n\n");
      await run(env.DB, "UPDATE meetings SET transcript = ? WHERE id = ?", transcript, m.id);
      if (transcript.replace(/\s/g, "").length < 20 && env.DEV_MODE !== "1") throw new Error("No speech was detected in the recording.");

      await send("progress", { stage: "summarising" });
      const [participants, directory, space, openTasks] = await Promise.all([
        all<Participant>(env.DB, "SELECT * FROM meeting_participants WHERE meeting_id = ?", m.id),
        all<{ id: string; name: string; email: string }>(env.DB, "SELECT id, name, email FROM users WHERE active = 1 AND role != 'guest'"),
        m.space_id ? first<{ name: string }>(env.DB, "SELECT name FROM spaces WHERE id = ?", m.space_id) : null,
        all<{ id: string; title: string; assignee: string | null }>(
          env.DB,
          `SELECT t.id, t.title, u.name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
            WHERE t.status != 'done' AND ${m.space_id ? "t.space_id = ?" : "t.creator_id = ?"} ORDER BY t.created_at DESC LIMIT 150`,
          m.space_id ?? user.id,
        ),
      ]);
      const fresh = await getMeeting(env, m.id);
      const result = await summariseMeeting(env, {
        title: fresh.title,
        spaceName: space?.name ?? null,
        startedAt: fresh.started_at,
        transcript,
        participants: participants.map((p) => ({ name: p.name, email: p.email })),
        directory: directory.map((d) => ({ name: d.name, email: d.email })),
        openTasks,
      });

      const byEmail = new Map(directory.map((d) => [d.email.toLowerCase(), d]));
      const stmts = [env.DB.prepare("DELETE FROM meeting_items WHERE meeting_id = ?").bind(m.id)];
      result.action_items.forEach((a, i) => {
        const owner = a.owner_email ? byEmail.get(a.owner_email.toLowerCase()) : undefined;
        const payload: TaskPayload = {
          title: a.title,
          // No clear owner inside the workspace: hand it to the organiser to sort out, and flag it.
          assignee_id: owner?.id ?? user.id,
          owner_name: owner ? null : a.owner_name,
          due: a.due_date && /^\d{4}-\d{2}-\d{2}$/.test(a.due_date) ? a.due_date : null,
          context: a.context,
          needs_owner: !owner || a.owner_uncertain,
          duplicate_of: a.duplicate_of && openTasks.some((t) => t.id === a.duplicate_of) ? a.duplicate_of : null,
        };
        // Likely duplicates start unticked so they aren't created twice by accident.
        stmts.push(env.DB.prepare("INSERT INTO meeting_items (id, meeting_id, kind, payload, accepted, sort) VALUES (?, ?, 'task', ?, ?, ?)").bind(uid(), m.id, JSON.stringify(payload), payload.duplicate_of ? 0 : 1, i));
      });
      result.knowledge.forEach((k, i) => {
        stmts.push(env.DB.prepare("INSERT INTO meeting_items (id, meeting_id, kind, payload, accepted, sort) VALUES (?, ?, 'knowledge', ?, 1, ?)").bind(uid(), m.id, JSON.stringify(k satisfies KnowledgePayload), 1000 + i));
      });
      const html = await marked.parse(result.summary_markdown, { async: true });
      stmts.push(
        env.DB.prepare("UPDATE meetings SET status = 'review', title = CASE WHEN title = '' THEN ? ELSE title END, summary_html = ?, summary_doc = NULL, error = NULL WHERE id = ?").bind(result.title, html, m.id),
      );
      await env.DB.batch(stmts);
      await notify(env, origin, { user_id: user.id, type: "meeting_ready", title: `“${fresh.title || result.title}” is ready to review`, url: `/meetings/${m.id}` });
      await send("done", {});
    } catch (e) {
      const message = e instanceof Error ? e.message : "Processing failed.";
      console.error("meeting processing failed", m.id, e);
      await run(env.DB, "UPDATE meetings SET status = 'failed', error = ? WHERE id = ?", message.slice(0, 500), m.id);
      await send("error", { message });
    } finally {
      clearInterval(beat);
    }
  });
});

// ---------- Review queue ----------

meetings.post("/:id/items", async (c) => {
  const m = await requireOrganiser(c.env, c.var.user, c.req.param("id"));
  const b = await c.req.json<{ kind?: "task" | "knowledge"; payload?: Record<string, unknown> }>();
  if (b.kind !== "task" && b.kind !== "knowledge") throw bad("Unknown item kind.");
  const id = uid();
  const max = await first<{ m: number | null }>(c.env.DB, "SELECT MAX(sort) AS m FROM meeting_items WHERE meeting_id = ? AND kind = ?", m.id, b.kind);
  await run(c.env.DB, "INSERT INTO meeting_items (id, meeting_id, kind, payload, accepted, sort) VALUES (?, ?, ?, ?, 1, ?)", id, m.id, b.kind, JSON.stringify(b.payload ?? {}), (max?.m ?? (b.kind === "task" ? 0 : 1000)) + 1);
  return c.json({ id });
});

meetings.patch("/:id/items/:itemId", async (c) => {
  const m = await requireOrganiser(c.env, c.var.user, c.req.param("id"));
  const item = await first<Item>(c.env.DB, "SELECT * FROM meeting_items WHERE id = ? AND meeting_id = ?", c.req.param("itemId"), m.id);
  if (!item) throw notFound();
  const b = await c.req.json<{ accepted?: boolean; payload?: Record<string, unknown> }>();
  const payload = b.payload ? { ...parseJSON<Record<string, unknown>>(item.payload, {}), ...b.payload } : null;
  await run(
    c.env.DB, "UPDATE meeting_items SET accepted = COALESCE(?, accepted), payload = COALESCE(?, payload) WHERE id = ?",
    b.accepted === undefined ? null : b.accepted ? 1 : 0, payload ? JSON.stringify(payload) : null, item.id,
  );
  return c.json({ ok: true });
});

meetings.delete("/:id/items/:itemId", async (c) => {
  const m = await requireOrganiser(c.env, c.var.user, c.req.param("id"));
  await run(c.env.DB, "DELETE FROM meeting_items WHERE id = ? AND meeting_id = ?", c.req.param("itemId"), m.id);
  return c.json({ ok: true });
});

// ---------- Send ----------

// Nothing leaves the organiser's hands until they approve it here. Sending creates the
// accepted tasks, files the knowledge notes, shares the meeting, and emails participants.
meetings.post("/:id/send", async (c) => {
  const user = c.var.user;
  const env = c.env;
  const origin = c.var.origin;
  const m = await requireOrganiser(env, user, c.req.param("id"));
  if (m.status !== "review") throw bad(m.status === "sent" ? "This meeting has already been sent." : "This meeting isn't ready to send yet.");
  const b = await c.req.json<{ summary_html?: string; summary_doc?: unknown }>().catch(() => ({} as { summary_html?: string; summary_doc?: unknown }));
  if (b.summary_html !== undefined) {
    await run(env.DB, "UPDATE meetings SET summary_html = ?, summary_doc = ? WHERE id = ?", b.summary_html, b.summary_doc ? JSON.stringify(b.summary_doc) : null, m.id);
  }
  // Claim the send first so a double click can't create everything twice.
  const claim = await run(env.DB, "UPDATE meetings SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'review'", now(), m.id);
  if (!claim.meta.changes) throw bad("This meeting has already been sent.");

  const meeting = await getMeeting(env, m.id);
  const [participants, items, users, space] = await Promise.all([
    all<Participant>(env.DB, "SELECT * FROM meeting_participants WHERE meeting_id = ?", m.id),
    all<Item>(env.DB, "SELECT * FROM meeting_items WHERE meeting_id = ? AND accepted = 1 ORDER BY sort", m.id),
    all<{ id: string; name: string; email: string }>(env.DB, "SELECT id, name, email FROM users WHERE active = 1"),
    m.space_id ? first<{ name: string }>(env.DB, "SELECT name FROM spaces WHERE id = ?", m.space_id) : null,
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));

  const created: { title: string; assignee_id: string | null; owner_name: string | null; due: string | null }[] = [];
  for (const it of items) {
    if (it.kind === "task") {
      const p = parseJSON<TaskPayload>(it.payload, null as unknown as TaskPayload);
      if (!p?.title?.trim()) continue;
      const assignee = p.assignee_id && userById.has(p.assignee_id) ? p.assignee_id : user.id;
      await createTask(env, {
        title: p.title.trim(),
        notes: [p.context, p.owner_name ? `Owner mentioned in the meeting: ${p.owner_name}` : ""].filter(Boolean).join("\n"),
        assignee_id: assignee, creator_id: user.id, space_id: meeting.space_id, due: p.due, meeting_id: m.id, needs_owner: p.needs_owner,
      });
      created.push({ title: p.title.trim(), assignee_id: assignee, owner_name: p.owner_name, due: p.due });
    } else {
      const k = parseJSON<KnowledgePayload>(it.payload, null as unknown as KnowledgePayload);
      if (!k?.title?.trim()) continue;
      const kid = uid();
      await run(env.DB, "INSERT INTO knowledge (id, space_id, owner_id, kind, title, body, meeting_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", kid, meeting.space_id, user.id, k.kind || "fact", k.title.trim(), k.body ?? "", m.id, now());
      await indexDoc(env.DB, "knowledge", kid, k.title.trim(), k.body ?? "");
    }
  }
  await indexDoc(env.DB, "meeting", m.id, meeting.title, `${htmlText(meeting.summary_html)}\n${meeting.transcript}`);

  // One email per participant: the summary, their own actions first, then everyone's.
  const date = new Date(meeting.started_at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" });
  const fmtDue = (d: string | null) => (d ? ` <span style="color:#86868b">· due ${new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>` : "");
  const line = (t: (typeof created)[number], showOwner: boolean) =>
    `<tr><td style="padding:7px 10px 7px 0;vertical-align:top;color:#86868b;font-size:15px">○</td><td style="padding:7px 0;font-size:15px;line-height:1.45">${escapeHtml(t.title)}${showOwner ? ` <span style="color:#86868b">· ${escapeHtml(t.owner_name ?? userById.get(t.assignee_id ?? "")?.name ?? "Unassigned")}</span>` : ""}${fmtDue(t.due)}</td></tr>`;
  const sectionTitle = (s: string) => `<p style="margin:28px 0 8px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#86868b">${s}</p>`;
  let sent = 0;
  for (const p of participants) {
    if (p.user_id && p.user_id !== user.id) {
      const mine = created.filter((t) => t.assignee_id === p.user_id).length;
      await notify(env, origin, {
        user_id: p.user_id, actor_id: user.id, type: "meeting",
        title: `Summary of “${meeting.title || "Meeting"}”`, body: mine ? `You have ${mine} action${mine === 1 ? "" : "s"} from this meeting.` : "", url: `/meetings/${m.id}`,
      });
    }
    if (!p.notify || !p.email) continue;
    const own = p.user_id
      ? created.filter((t) => t.assignee_id === p.user_id && !t.owner_name)
      : created.filter((t) => t.owner_name && p.name && t.owner_name.toLowerCase().includes(p.name.split(" ")[0].toLowerCase()));
    const others = created.filter((t) => !own.includes(t));
    const body =
      `<p style="margin:0 0 20px;color:#86868b;font-size:14px">${escapeHtml(date)}${space ? ` · ${escapeHtml(space.name)}` : ""} · recorded by ${escapeHtml(user.name)}</p>` +
      (own.length ? `${sectionTitle("Your actions")}<table role="presentation" cellpadding="0" cellspacing="0">${own.map((t) => line(t, false)).join("")}</table>` : "") +
      `${sectionTitle("Summary")}<div style="color:#1d1d1f">${meeting.summary_html}</div>` +
      (others.length ? `${sectionTitle(own.length ? "Other actions" : "Actions")}<table role="presentation" cellpadding="0" cellspacing="0">${others.map((t) => line(t, true)).join("")}</table>` : "");
    await sendMail(
      env, p.email, `${meeting.title || "Meeting"}: summary and actions`,
      emailLayout(env, {
        heading: meeting.title || "Meeting summary",
        body,
        cta: p.user_id ? { label: own.length ? "Open your tasks" : "Open the meeting", url: origin + (own.length ? "/tasks" : `/meetings/${m.id}`) } : undefined,
        footer: `Sent by ${user.name} via ${env.APP_NAME}`,
      }),
    );
    sent++;
  }
  return c.json({ ok: true, tasks: created.length, emails: sent });
});

meetings.delete("/:id", async (c) => {
  const m = await requireOrganiser(c.env, c.var.user, c.req.param("id"));
  const segs = await all<{ r2_key: string }>(c.env.DB, "SELECT r2_key FROM meeting_segments WHERE meeting_id = ?", m.id);
  if (segs.length) await c.env.FILES.delete(segs.map((s) => s.r2_key));
  await run(c.env.DB, "DELETE FROM meetings WHERE id = ?", m.id);
  await run(c.env.DB, "DELETE FROM comments WHERE target_kind = 'meeting' AND target_id = ?", m.id);
  await unindexDoc(c.env.DB, "meeting", m.id);
  return c.json({ ok: true });
});
