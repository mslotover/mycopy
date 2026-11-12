import { Hono } from "hono";
import { canSeeTask, loadAccess, memberSpaceIds } from "./access";
import { listDirectory } from "./auth";
import { all, bad, escapeHtml, first, forbidden, indexDoc, isAdmin, notFound, now, run, uid, unindexDoc, type Env, type HonoEnv, type User } from "./env";
import { emailLayout, notify, sendMail } from "./mail";
import type { TaskRow } from "./tasks";

export type MeetingLite = { id: string; title: string; space_id: string | null; organizer_id: string; status: string };

/** Until its summary is sent, a meeting is visible only to its organiser. Afterwards, to participants and the space. */
export async function visibleMeetingIds(env: Env, user: User, spaces: Set<string>): Promise<Set<string>> {
  const rows = await all<{ id: string }>(
    env.DB,
    `SELECT m.id FROM meetings m WHERE m.organizer_id = ?1
       OR (m.status = 'sent' AND (m.id IN (SELECT meeting_id FROM meeting_participants WHERE user_id = ?1)
            ${spaces.size ? `OR m.space_id IN (${[...spaces].map((_, i) => `?${i + 2}`).join(",")})` : ""}))`,
    user.id, ...spaces,
  );
  return new Set(rows.map((r) => r.id));
}

const SPACE_COLORS = ["#0071e3", "#34c759", "#ff9500", "#af52de", "#ff2d55", "#5ac8fa", "#ffcc00", "#8e8e93"];

export const misc = new Hono<HonoEnv>();

// Everything the shell needs on load.
misc.get("/bootstrap", async (c) => {
  const user = c.var.user;
  const [users, spaces, members, unread] = await Promise.all([
    listDirectory(c.env),
    all<{ id: string; name: string; icon: string; color: string; description: string; sort: number }>(c.env.DB, "SELECT id, name, icon, color, description, sort FROM spaces WHERE archived = 0 ORDER BY sort, name"),
    all<{ space_id: string; user_id: string }>(c.env.DB, "SELECT space_id, user_id FROM space_members"),
    first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0", user.id),
  ]);
  const mine = await memberSpaceIds(c.env, user);
  return c.json({
    user,
    appName: c.env.APP_NAME,
    aiReady: !!c.env.ANTHROPIC_API_KEY || c.env.DEV_MODE === "1",
    // Guests only learn about the people they need to: everyone else sees the whole directory.
    users: user.role === "guest" ? users.filter((u) => u.id === user.id || u.role !== "guest") : users,
    spaces: spaces.filter((s) => mine.has(s.id)).map((s) => ({ ...s, member_ids: members.filter((m) => m.space_id === s.id).map((m) => m.user_id) })),
    unread: unread?.n ?? 0,
  });
});

misc.patch("/me", async (c) => {
  const b = await c.req.json<{ name?: string; color?: string }>();
  if (b.name !== undefined && !b.name.trim()) throw bad("Your name can't be empty.");
  if (b.name) await run(c.env.DB, "UPDATE users SET name = ? WHERE id = ?", b.name.trim().slice(0, 80), c.var.user.id);
  if (b.color && /^#[0-9a-f]{6}$/i.test(b.color)) await run(c.env.DB, "UPDATE users SET color = ? WHERE id = ?", b.color, c.var.user.id);
  return c.json({ ok: true });
});

misc.get("/recent", async (c) => {
  const access = await loadAccess(c.env, c.var.user);
  const rows = await all<{ id: string; title: string; icon: string; kind: string; space_id: string | null; parent_id: string | null; updated_at: number; updated_by: string }>(
    c.env.DB,
    "SELECT id, title, icon, kind, space_id, parent_id, updated_at, updated_by FROM pages WHERE archived = 0 AND is_template = 0 AND kind != 'row' ORDER BY updated_at DESC LIMIT 200",
  );
  return c.json({ pages: rows.filter((r) => access.level(r.id) > 0).slice(0, 12) });
});

// ---------- Files (images pasted into pages) ----------

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/avif"];

misc.post("/files", async (c) => {
  if (c.var.user.role === "guest") throw forbidden();
  const type = (c.req.header("content-type") ?? "").split(";")[0];
  if (!IMAGE_TYPES.includes(type)) throw bad("Only images can be added to pages.");
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > 15 * 1024 * 1024) throw bad("Images can be up to 15 MB.");
  const id = uid(24);
  await c.env.FILES.put(`files/${id}`, buf, { httpMetadata: { contentType: type } });
  return c.json({ url: `/api/files/${id}` });
});

misc.get("/files/:id", async (c) => {
  if (!/^[0-9A-Za-z]{24}$/.test(c.req.param("id"))) throw notFound();
  // Range requests let browsers seek within video and resume large downloads.
  const wantsRange = !!c.req.header("range");
  const obj = await c.env.FILES.get(`files/${c.req.param("id")}`, wantsRange ? { range: c.req.raw.headers } : undefined);
  if (!obj) throw notFound();
  const headers = new Headers({
    "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  });
  const r = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (wantsRange && r) {
    const start = r.suffix !== undefined ? Math.max(0, obj.size - r.suffix) : r.offset ?? 0;
    const length = r.suffix !== undefined ? Math.min(r.suffix, obj.size) : r.length ?? obj.size - start;
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${obj.size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
});

// ---------- Spaces ----------

misc.post("/spaces", async (c) => {
  const user = c.var.user;
  if (user.role === "guest") throw forbidden("Guests can't create spaces.");
  const b = await c.req.json<{ name?: string; icon?: string; description?: string; member_ids?: string[] }>();
  const name = (b.name ?? "").trim();
  if (!name) throw bad("Give the space a name.");
  const id = uid();
  const count = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM spaces");
  await run(
    c.env.DB, "INSERT INTO spaces (id, name, icon, color, description, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id, name.slice(0, 80), (b.icon ?? "").slice(0, 16), SPACE_COLORS[(count?.n ?? 0) % SPACE_COLORS.length], (b.description ?? "").slice(0, 500), (count?.n ?? 0) + 1, now(),
  );
  for (const uidv of new Set([user.id, ...(b.member_ids ?? [])])) {
    await run(c.env.DB, "INSERT OR IGNORE INTO space_members (space_id, user_id) SELECT ?, id FROM users WHERE id = ? AND role != 'guest'", id, uidv);
  }
  return c.json({ id });
});

misc.patch("/spaces/:id", async (c) => {
  const user = c.var.user;
  const id = c.req.param("id");
  if (!(await memberSpaceIds(c.env, user)).has(id)) throw forbidden();
  const b = await c.req.json<{ name?: string; icon?: string; description?: string; color?: string; archived?: boolean }>();
  if (b.name !== undefined) {
    if (!b.name.trim()) throw bad("A space needs a name.");
    await run(c.env.DB, "UPDATE spaces SET name = ? WHERE id = ?", b.name.trim().slice(0, 80), id);
  }
  if (b.icon !== undefined) await run(c.env.DB, "UPDATE spaces SET icon = ? WHERE id = ?", b.icon.slice(0, 16), id);
  if (b.description !== undefined) await run(c.env.DB, "UPDATE spaces SET description = ? WHERE id = ?", b.description.slice(0, 500), id);
  if (b.color && /^#[0-9a-f]{6}$/i.test(b.color)) await run(c.env.DB, "UPDATE spaces SET color = ? WHERE id = ?", b.color, id);
  if (b.archived !== undefined) {
    if (!isAdmin(user)) throw forbidden("Only workspace admins can archive a space.");
    await run(c.env.DB, "UPDATE spaces SET archived = ? WHERE id = ?", b.archived ? 1 : 0, id);
  }
  return c.json({ ok: true });
});

misc.put("/spaces/:id/members/:userId", async (c) => {
  const id = c.req.param("id");
  if (!(await memberSpaceIds(c.env, c.var.user)).has(id)) throw forbidden();
  const target = await first<User>(c.env.DB, "SELECT * FROM users WHERE id = ?", c.req.param("userId"));
  if (!target) throw notFound();
  if (target.role === "guest") throw bad("Guests can't join spaces. Share individual pages with them instead.");
  await run(c.env.DB, "INSERT OR IGNORE INTO space_members (space_id, user_id) VALUES (?, ?)", id, target.id);
  const space = await first<{ name: string }>(c.env.DB, "SELECT name FROM spaces WHERE id = ?", id);
  await notify(c.env, c.var.origin, { user_id: target.id, actor_id: c.var.user.id, type: "space", title: `${c.var.user.name} added you to ${space?.name ?? "a space"}`, url: `/space/${id}` });
  return c.json({ ok: true });
});

misc.delete("/spaces/:id/members/:userId", async (c) => {
  const id = c.req.param("id");
  if (!(await memberSpaceIds(c.env, c.var.user)).has(id)) throw forbidden();
  await run(c.env.DB, "DELETE FROM space_members WHERE space_id = ? AND user_id = ?", id, c.req.param("userId"));
  return c.json({ ok: true });
});

// ---------- Comments ----------

async function canComment(env: Env, user: User, kind: string, id: string): Promise<{ view: boolean; ok: boolean; title: string; url: string; watchers: string[] }> {
  if (kind === "page") {
    const p = await first<{ title: string; owner_id: string; created_by: string }>(env.DB, "SELECT title, owner_id, created_by FROM pages WHERE id = ?", id);
    if (!p) throw notFound();
    const access = await loadAccess(env, user);
    return { view: access.level(id) >= 1, ok: access.level(id) >= 2, title: p.title || "Untitled", url: `/p/${id}`, watchers: [p.owner_id, p.created_by] };
  }
  if (kind === "task") {
    const t = await first<TaskRow>(env.DB, "SELECT * FROM tasks WHERE id = ?", id);
    if (!t) throw notFound();
    const ok = canSeeTask(t, user, await memberSpaceIds(env, user));
    return { view: ok, ok, title: t.title, url: `/tasks?open=${id}`, watchers: [t.creator_id, ...(t.assignee_id ? [t.assignee_id] : [])] };
  }
  if (kind === "meeting") {
    const m = await first<MeetingLite>(env.DB, "SELECT id, title, space_id, organizer_id, status FROM meetings WHERE id = ?", id);
    if (!m) throw notFound();
    const visible = await visibleMeetingIds(env, user, await memberSpaceIds(env, user));
    return { view: visible.has(id), ok: visible.has(id), title: m.title || "Meeting", url: `/meetings/${id}`, watchers: [m.organizer_id] };
  }
  throw bad("Unknown comment target.");
}

misc.get("/comments", async (c) => {
  const kind = c.req.query("kind") ?? "";
  const id = c.req.query("id") ?? "";
  const target = await canComment(c.env, c.var.user, kind, id);
  // Reading comments needs only view access; `ok` gates writing.
  if (!target.view) throw forbidden();
  const rows = await all(c.env.DB, "SELECT id, author_id, body, resolved, created_at FROM comments WHERE target_kind = ? AND target_id = ? ORDER BY created_at", kind, id);
  return c.json({ comments: rows, canComment: target.ok });
});

misc.post("/comments", async (c) => {
  const user = c.var.user;
  const b = await c.req.json<{ kind?: string; id?: string; body?: string; mentions?: string[] }>();
  const text = (b.body ?? "").trim();
  if (!text) throw bad("Write something first.");
  const target = await canComment(c.env, user, b.kind ?? "", b.id ?? "");
  if (!target.ok) throw forbidden("You can't comment here.");
  const cid = uid();
  await run(c.env.DB, "INSERT INTO comments (id, target_kind, target_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)", cid, b.kind, b.id, user.id, text.slice(0, 10_000), now());
  const mentions = new Set((b.mentions ?? []).slice(0, 20));
  const earlier = await all<{ author_id: string }>(c.env.DB, "SELECT DISTINCT author_id FROM comments WHERE target_kind = ? AND target_id = ?", b.kind, b.id);
  const audience = new Set([...target.watchers, ...earlier.map((e) => e.author_id), ...mentions]);
  for (const uidv of audience) {
    const mentioned = mentions.has(uidv);
    await notify(c.env, c.var.origin, {
      user_id: uidv, actor_id: user.id, type: mentioned ? "mention" : "comment",
      title: mentioned ? `${user.name} mentioned you in a comment on ${target.title}` : `${user.name} commented on ${target.title}`,
      body: text.slice(0, 280), url: target.url, email: mentioned,
    });
  }
  return c.json({ id: cid });
});

misc.patch("/comments/:id", async (c) => {
  const row = await first<{ target_kind: string; target_id: string }>(c.env.DB, "SELECT target_kind, target_id FROM comments WHERE id = ?", c.req.param("id"));
  if (!row) throw notFound();
  if (!(await canComment(c.env, c.var.user, row.target_kind, row.target_id)).ok) throw forbidden();
  const b = await c.req.json<{ resolved?: boolean }>();
  await run(c.env.DB, "UPDATE comments SET resolved = ? WHERE id = ?", b.resolved ? 1 : 0, c.req.param("id"));
  return c.json({ ok: true });
});

misc.delete("/comments/:id", async (c) => {
  const row = await first<{ author_id: string }>(c.env.DB, "SELECT author_id FROM comments WHERE id = ?", c.req.param("id"));
  if (!row) return c.json({ ok: true });
  if (row.author_id !== c.var.user.id && !isAdmin(c.var.user)) throw forbidden("You can only delete your own comments.");
  await run(c.env.DB, "DELETE FROM comments WHERE id = ?", c.req.param("id"));
  return c.json({ ok: true });
});

// ---------- Notifications ----------

misc.get("/notifications", async (c) => {
  const rows = await all(c.env.DB, "SELECT id, actor_id, type, title, body, url, read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", c.var.user.id);
  return c.json({ notifications: rows });
});

misc.post("/notifications/read", async (c) => {
  const b = await c.req.json<{ id?: string }>().catch(() => ({} as { id?: string }));
  if (b.id) await run(c.env.DB, "UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?", b.id, c.var.user.id);
  else await run(c.env.DB, "UPDATE notifications SET read = 1 WHERE user_id = ?", c.var.user.id);
  return c.json({ ok: true });
});

// ---------- Search ----------

export type Hit = { kind: "page" | "task" | "meeting" | "knowledge"; id: string; title: string; snippet: string; url: string; where: string };

/** Full-text search across pages, tasks, meetings and knowledge, limited to what the caller may see. */
export async function searchWorkspace(env: Env, user: User, query: string, limit = 20): Promise<Hit[]> {
  const terms = (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
  if (!terms.length) return [];
  const run1 = (match: string) =>
    all<{ kind: Hit["kind"]; ref: string; title: string; snip: string }>(
      env.DB,
      // \u0001 and \u0002 mark the match so the client can highlight without trusting any HTML.
      "SELECT kind, ref, title, snippet(search, 1, char(1), char(2), '…', 18) AS snip FROM search WHERE search MATCH ? ORDER BY bm25(search, 8.0, 1.0) LIMIT 80",
      match,
    );
  // Prefer documents containing every term; fall back to any term.
  let rows = await run1(terms.map((t) => `"${t}"*`).join(" "));
  if (rows.length < 3 && terms.length > 1) {
    const seen = new Set(rows.map((r) => r.kind + r.ref));
    rows = rows.concat((await run1(terms.map((t) => `"${t}"*`).join(" OR "))).filter((r) => !seen.has(r.kind + r.ref)));
  }
  if (!rows.length) return [];

  const access = await loadAccess(env, user);
  const spaces = access.memberSpaces;
  const spaceNames = new Map((await all<{ id: string; name: string }>(env.DB, "SELECT id, name FROM spaces")).map((s) => [s.id, s.name]));
  const where = (spaceId: string | null) => (spaceId ? spaceNames.get(spaceId) ?? "" : "Private");
  const meetings = await visibleMeetingIds(env, user, spaces);
  const out: Hit[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (r.kind === "page") {
      if (!access.level(r.ref)) continue;
      out.push({ kind: "page", id: r.ref, title: r.title || "Untitled", snippet: r.snip, url: `/p/${r.ref}`, where: where(access.node(r.ref)?.space_id ?? null) });
    } else if (r.kind === "task") {
      const t = await first<TaskRow>(env.DB, "SELECT * FROM tasks WHERE id = ?", r.ref);
      if (!t || !canSeeTask(t, user, spaces)) continue;
      out.push({ kind: "task", id: r.ref, title: r.title, snippet: r.snip, url: `/tasks?open=${r.ref}`, where: where(t.space_id) });
    } else if (r.kind === "meeting") {
      if (!meetings.has(r.ref)) continue;
      const m = await first<{ space_id: string | null }>(env.DB, "SELECT space_id FROM meetings WHERE id = ?", r.ref);
      out.push({ kind: "meeting", id: r.ref, title: r.title || "Meeting", snippet: r.snip, url: `/meetings/${r.ref}`, where: where(m?.space_id ?? null) });
    } else if (r.kind === "knowledge") {
      const k = await first<{ space_id: string | null; owner_id: string }>(env.DB, "SELECT space_id, owner_id FROM knowledge WHERE id = ?", r.ref);
      if (!k || !(k.space_id ? spaces.has(k.space_id) : k.owner_id === user.id)) continue;
      out.push({ kind: "knowledge", id: r.ref, title: r.title, snippet: r.snip, url: `/brain?open=${r.ref}`, where: where(k.space_id) });
    }
  }
  return out;
}

misc.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  return c.json({ results: q ? await searchWorkspace(c.env, c.var.user, q, 30) : [] });
});

// ---------- Knowledge (the second brain) ----------

misc.get("/knowledge", async (c) => {
  const user = c.var.user;
  const spaces = await memberSpaceIds(c.env, user);
  const rows = await all<{ id: string; space_id: string | null; owner_id: string; kind: string; title: string; body: string; meeting_id: string | null; created_at: number; meeting_title: string | null }>(
    c.env.DB,
    "SELECT k.*, m.title AS meeting_title FROM knowledge k LEFT JOIN meetings m ON m.id = k.meeting_id ORDER BY k.created_at DESC LIMIT 1000",
  );
  return c.json({ knowledge: rows.filter((k) => (k.space_id ? spaces.has(k.space_id) : k.owner_id === user.id)) });
});

misc.post("/knowledge", async (c) => {
  const user = c.var.user;
  const b = await c.req.json<{ title?: string; body?: string; kind?: string; space_id?: string | null }>();
  if (!b.title?.trim()) throw bad("Give the note a title.");
  if (b.space_id && !(await memberSpaceIds(c.env, user)).has(b.space_id)) throw forbidden();
  const id = uid();
  await run(c.env.DB, "INSERT INTO knowledge (id, space_id, owner_id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, b.space_id ?? null, user.id, b.kind ?? "fact", b.title.trim(), b.body ?? "", now());
  await indexDoc(c.env.DB, "knowledge", id, b.title.trim(), b.body ?? "");
  return c.json({ id });
});

async function ownKnowledge(env: Env, user: User, id: string) {
  const k = await first<{ id: string; space_id: string | null; owner_id: string; title: string; body: string }>(env.DB, "SELECT * FROM knowledge WHERE id = ?", id);
  if (!k) throw notFound();
  if (!(k.space_id ? (await memberSpaceIds(env, user)).has(k.space_id) : k.owner_id === user.id)) throw forbidden();
  return k;
}

misc.patch("/knowledge/:id", async (c) => {
  const k = await ownKnowledge(c.env, c.var.user, c.req.param("id"));
  const b = await c.req.json<{ title?: string; body?: string; kind?: string }>();
  const title = b.title?.trim() || k.title;
  const body = b.body ?? k.body;
  await run(c.env.DB, "UPDATE knowledge SET title = ?, body = ?, kind = COALESCE(?, kind) WHERE id = ?", title, body, b.kind ?? null, k.id);
  await indexDoc(c.env.DB, "knowledge", k.id, title, body);
  return c.json({ ok: true });
});

misc.delete("/knowledge/:id", async (c) => {
  const k = await ownKnowledge(c.env, c.var.user, c.req.param("id"));
  await run(c.env.DB, "DELETE FROM knowledge WHERE id = ?", k.id);
  await unindexDoc(c.env.DB, "knowledge", k.id);
  return c.json({ ok: true });
});

// ---------- People (admin) ----------

const USER_COLORS = ["#0071e3", "#34c759", "#ff9500", "#af52de", "#ff2d55", "#5856d6", "#00c7be", "#ff6482", "#a2845e"];

misc.post("/admin/users", async (c) => {
  const actor = c.var.user;
  const b = await c.req.json<{ email?: string; name?: string; role?: string; space_ids?: string[] }>();
  const email = (b.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("Enter a valid email address.");
  const role = b.role ?? "member";
  // Any member can invite a guest (to share a page with them); only admins can add members.
  if (role !== "guest" && !isAdmin(actor)) throw forbidden("Only workspace admins can add members.");
  if (actor.role === "guest") throw forbidden();
  if (!["admin", "member", "guest"].includes(role)) throw bad("Unknown role.");
  const existing = await first<User>(c.env.DB, "SELECT * FROM users WHERE email = ?", email);
  if (existing) {
    if (existing.active) return c.json({ id: existing.id, existing: true });
    await run(c.env.DB, "UPDATE users SET active = 1 WHERE id = ?", existing.id);
    return c.json({ id: existing.id, existing: true });
  }
  const id = uid();
  const count = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM users");
  const name = (b.name ?? "").trim() || email.split("@")[0];
  await run(c.env.DB, "INSERT INTO users (id, email, name, color, role, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, email, name.slice(0, 80), USER_COLORS[(count?.n ?? 0) % USER_COLORS.length], role, now());
  if (role !== "guest") {
    const allowed = await memberSpaceIds(c.env, actor);
    for (const sid of b.space_ids ?? []) if (allowed.has(sid)) await run(c.env.DB, "INSERT OR IGNORE INTO space_members (space_id, user_id) VALUES (?, ?)", sid, id);
  }
  await sendMail(
    c.env, email, `${actor.name} invited you to ${c.env.APP_NAME}`,
    emailLayout(c.env, {
      heading: `You've been invited to ${c.env.APP_NAME}`,
      body: `<p style="margin:0;color:#424245">${escapeHtml(actor.name)} added you${role === "guest" ? " as a guest" : ""}. Sign in with this email address (${escapeHtml(email)}) to get started.</p>`,
      cta: { label: "Open " + c.env.APP_NAME, url: `${c.var.origin}/signin` },
    }),
  );
  return c.json({ id });
});

misc.patch("/admin/users/:id", async (c) => {
  const actor = c.var.user;
  if (!isAdmin(actor)) throw forbidden("Only workspace admins can change people's roles.");
  const target = await first<User>(c.env.DB, "SELECT * FROM users WHERE id = ?", c.req.param("id"));
  if (!target) throw notFound();
  const b = await c.req.json<{ role?: string; active?: boolean; name?: string }>();
  if (target.role === "owner" && (b.role !== undefined || b.active === false)) throw bad("The workspace owner's role can't be changed.");
  if (b.role !== undefined) {
    if (!["admin", "member", "guest"].includes(b.role)) throw bad("Unknown role.");
    await run(c.env.DB, "UPDATE users SET role = ? WHERE id = ?", b.role, target.id);
    if (b.role === "guest") await run(c.env.DB, "DELETE FROM space_members WHERE user_id = ?", target.id);
  }
  if (b.name?.trim()) await run(c.env.DB, "UPDATE users SET name = ? WHERE id = ?", b.name.trim().slice(0, 80), target.id);
  if (b.active !== undefined) {
    await run(c.env.DB, "UPDATE users SET active = ? WHERE id = ?", b.active ? 1 : 0, target.id);
    if (!b.active) await run(c.env.DB, "DELETE FROM sessions WHERE user_id = ?", target.id);
  }
  return c.json({ ok: true });
});

misc.get("/admin/outbox", async (c) => {
  if (!isAdmin(c.var.user)) throw forbidden();
  return c.json({ outbox: await all(c.env.DB, "SELECT id, to_email, subject, status, error, created_at FROM outbox ORDER BY created_at DESC LIMIT 100") });
});
