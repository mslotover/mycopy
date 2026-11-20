// Meeting prep notes. Every five minutes, each person's connected Google Calendar is read and, for
// meetings starting in 10 to 20 minutes that include other Atrium people, a note is saved and pushed:
// what was decided in past meetings with those people, and the open tasks between them.
// Meetings with nobody else from Atrium in them get no note.
import { Hono } from "hono";
import { memberSpaceIds } from "./access";
import { all, bad, first, isDev, notFound, now, run, uid, type Env, type HonoEnv, type User } from "./env";
import { eventsStartingBetween } from "./ical";
import { fetchCalendar, visibleMeetingIds } from "./misc";
import { pushToUser } from "./push";

const MIN = 60_000;
const ph = (n: number) => Array(n).fill("?").join(",");

export type PrepBody = {
  with: { id: string; name: string }[];
  outside: number;
  decisions: { id: string; title: string; body: string; meeting_id: string; meeting_title: string; date: number }[];
  tasks: { id: string; title: string; due: string | null; owners: string[] }[];
  lastMeeting: { id: string; title: string; date: number } | null;
};

async function buildPrep(env: Env, me: User, others: { id: string; name: string }[], outside: number): Promise<PrepBody> {
  const ids = others.map((o) => o.id);
  const visible = await visibleMeetingIds(env, me, await memberSpaceIds(env, me));
  const past = await all<{ id: string; title: string; started_at: number }>(
    env.DB,
    `SELECT m.id, m.title, m.started_at FROM meetings m WHERE m.status = 'sent'
       AND m.id IN (SELECT meeting_id FROM meeting_participants WHERE user_id IN (${ph(ids.length)}))
     ORDER BY m.started_at DESC LIMIT 40`,
    ...ids,
  );
  const mine = past.filter((m) => visible.has(m.id));
  const decisions = mine.length
    ? await all<{ id: string; title: string; body: string; meeting_id: string; created_at: number }>(
        env.DB,
        `SELECT id, title, body, meeting_id, created_at FROM knowledge WHERE kind = 'decision' AND meeting_id IN (${ph(mine.length)}) ORDER BY created_at DESC LIMIT 6`,
        ...mine.map((m) => m.id),
      )
    : [];
  const meetingOf = new Map(mine.map((m) => [m.id, m]));
  const taskRows = await all<{ id: string; title: string; due: string | null }>(
    env.DB,
    `SELECT t.id, t.title, t.due FROM tasks t WHERE t.status != 'done' AND (
       (t.creator_id = ?1 AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.done_at IS NULL AND a.user_id IN (${ph(ids.length)})))
       OR (t.creator_id IN (${ph(ids.length)}) AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.done_at IS NULL AND a.user_id = ?1))
       OR (EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.done_at IS NULL AND a.user_id = ?1)
           AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id IN (${ph(ids.length)}))))
     ORDER BY t.due IS NULL, t.due, t.sort LIMIT 12`,
    // ?1 is the person; the plain ? lists are filled in order after it.
    me.id, ...ids, ...ids, ...ids,
  );
  const owners = taskRows.length
    ? await all<{ task_id: string; name: string }>(env.DB, `SELECT a.task_id, u.name FROM task_assignees a JOIN users u ON u.id = a.user_id WHERE a.task_id IN (${ph(taskRows.length)})`, ...taskRows.map((t) => t.id))
    : [];
  return {
    with: others, outside,
    decisions: decisions.map((k) => ({ id: k.id, title: k.title, body: k.body, meeting_id: k.meeting_id, meeting_title: meetingOf.get(k.meeting_id)?.title ?? "", date: meetingOf.get(k.meeting_id)?.started_at ?? k.created_at })),
    tasks: taskRows.map((t) => ({ ...t, owners: owners.filter((o) => o.task_id === t.id).map((o) => o.name) })),
    lastMeeting: mine[0] ? { id: mine[0].id, title: mine[0].title, date: mine[0].started_at } : null,
  };
}

/** Saves and pushes a prep note for each meeting in the window. Returns how many were sent. */
async function prepFor(env: Env, me: User, ics: string, directory: Map<string, { id: string; name: string }>, at: number): Promise<number> {
  let sent = 0;
  for (const ev of eventsStartingBetween(ics, at + 10 * MIN, at + 20 * MIN)) {
    // Skip meetings the person has declined.
    const mine = new Set([me.email.toLowerCase(), ...[...directory].filter(([, u]) => u.id === me.id).map(([e]) => e)]);
    if (ev.attendees.some((a) => mine.has(a.email) && a.status === "DECLINED")) continue;
    const others = new Map<string, { id: string; name: string }>();
    let outside = 0;
    for (const a of ev.attendees) {
      if (mine.has(a.email)) continue;
      const u = directory.get(a.email);
      if (u) others.set(u.id, u); else outside++;
    }
    if (!others.size) continue;
    const key = `${ev.uid}@${ev.start}`;
    if (await first(env.DB, "SELECT 1 FROM meeting_prep WHERE user_id = ? AND event_key = ?", me.id, key)) continue;
    const body = await buildPrep(env, me, [...others.values()], outside);
    const id = uid();
    const res = await env.DB.prepare("INSERT OR IGNORE INTO meeting_prep (id, user_id, event_key, title, starts_at, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, me.id, key, ev.title.slice(0, 200), ev.start, JSON.stringify(body), now()).run();
    if (!res.meta.changes) continue;
    const names = body.with.map((o) => o.name.split(" ")[0]);
    const bits = [`${body.decisions.length} past decision${body.decisions.length === 1 ? "" : "s"}`, `${body.tasks.length} open task${body.tasks.length === 1 ? "" : "s"}`];
    const title = `${ev.title} in about 15 minutes`;
    const text = `With ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} · ${bits.join(" · ")}`;
    const url = `/prep/${id}`;
    await run(env.DB, "INSERT INTO notifications (id, user_id, actor_id, type, title, body, url, created_at) VALUES (?, ?, NULL, 'prep', ?, ?, ?, ?)", uid(), me.id, title, text, url, now());
    await pushToUser(env, me.id, { title, body: text, url });
    sent++;
  }
  return sent;
}

async function directory(env: Env) {
  const rows = await all<{ email: string; id: string; name: string }>(
    env.DB,
    `SELECT LOWER(u.email) AS email, u.id, u.name FROM users u WHERE u.active = 1
     UNION SELECT LOWER(e.email), u.id, u.name FROM user_emails e JOIN users u ON u.id = e.user_id WHERE u.active = 1`,
  );
  return new Map(rows.map((r) => [r.email, { id: r.id, name: r.name }]));
}

/** The five-minute job. */
export async function sendMeetingPreps(env: Env, at = now()): Promise<number> {
  const people = await all<User & { calendar_url: string }>(env.DB, "SELECT * FROM users WHERE active = 1 AND calendar_url IS NOT NULL");
  if (!people.length) return 0;
  const dir = await directory(env);
  let sent = 0;
  for (const p of people) {
    try {
      const cal = await fetchCalendar(p.calendar_url);
      if (!cal.text) { console.error("prep: calendar not readable", p.id, cal.status, cal.problem ?? ""); continue; }
      sent += await prepFor(env, p, cal.text, dir, at);
    } catch (e) { console.error("prep failed", p.id, String(e).slice(0, 200)); }
  }
  return sent;
}

export const prep = new Hono<HonoEnv>();

prep.get("/:id", async (c) => {
  const row = await first<{ id: string; title: string; starts_at: number; body: string }>(c.env.DB, "SELECT id, title, starts_at, body FROM meeting_prep WHERE id = ? AND user_id = ?", c.req.param("id"), c.var.user.id);
  if (!row) throw notFound();
  return c.json({ id: row.id, title: row.title, starts_at: row.starts_at, ...(JSON.parse(row.body) as PrepBody) });
});

// Local development only: runs the job on pasted calendar text so the whole path can be checked
// without Google. `minutes` is how far ahead the meeting is.
prep.post("/test", async (c) => {
  if (!isDev(c.env)) throw notFound();
  const b = await c.req.json<{ ics?: string; at?: number }>();
  if (!b.ics) throw bad("Paste some calendar text.");
  const sent = await prepFor(c.env, c.var.user, b.ics, await directory(c.env), b.at ?? now());
  const latest = await first<{ id: string }>(c.env.DB, "SELECT id FROM meeting_prep WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", c.var.user.id);
  return c.json({ sent, id: latest?.id ?? null });
});
