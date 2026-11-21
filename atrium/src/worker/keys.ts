// Personal add-only access keys. A key lets someone's own automation (for example a scheduled Claude
// task reading their inbox) add tasks to THEIR list, and nothing else: it cannot read, edit or delete
// anything, and it is useless on every other route. Only a hash is stored; the key is shown once.
import { Hono } from "hono";
import { all, bad, first, forbidden, notFound, now, run, sha256, token, uid, type HonoEnv, type User } from "./env";
import { createTask } from "./tasks";

const MAX_KEYS = 5;
const MAX_PER_DAY = 100;

/** Routes for managing your own keys (signed in on the website). */
export const keys = new Hono<HonoEnv>();

keys.get("/", async (c) => {
  const rows = await all(c.env.DB, "SELECT id, label, hint, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at", c.var.user.id);
  return c.json({ keys: rows });
});

keys.post("/", async (c) => {
  if (c.var.user.role === "guest") throw forbidden("Guests can't create access keys.");
  const b = await c.req.json<{ label?: string }>().catch(() => ({} as { label?: string }));
  const label = (b.label ?? "").trim().slice(0, 60) || "My automation";
  const count = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?", c.var.user.id);
  if ((count?.n ?? 0) >= MAX_KEYS) throw bad(`You can have up to ${MAX_KEYS} keys. Remove one first.`);
  const secret = "atk_" + token();
  const id = uid();
  await run(c.env.DB, "INSERT INTO api_keys (id, user_id, label, hash, hint, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, c.var.user.id, label, await sha256(secret), secret.slice(-4), now());
  // The only time the key is ever shown.
  return c.json({ id, label, key: secret });
});

keys.delete("/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM api_keys WHERE id = ? AND user_id = ?", c.req.param("id"), c.var.user.id);
  return c.json({ ok: true });
});

/** The only route a key works on: add a task. Not behind the website sign-in. */
export const inbound = new Hono<HonoEnv>();

async function userForKey(c: { req: { header(n: string): string | undefined }; env: HonoEnv["Bindings"] }): Promise<{ user: User; keyId: string } | null> {
  const m = /^Bearer (atk_[0-9a-f]{64})$/.exec(c.req.header("authorization") ?? "");
  if (!m) return null;
  const row = await first<{ key_id: string } & User>(
    c.env.DB,
    "SELECT k.id AS key_id, u.* FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.hash = ? AND u.active = 1 AND u.role != 'guest'",
    await sha256(m[1]!),
  );
  if (!row) return null;
  await run(c.env.DB, "UPDATE api_keys SET last_used_at = ? WHERE id = ?", now(), row.key_id);
  return { user: row, keyId: row.key_id };
}

inbound.post("/tasks", async (c) => {
  const who = await userForKey(c);
  if (!who) return c.json({ error: "That access key isn't valid." }, 401);
  const b = await c.req.json<{ title?: string; notes?: string; due?: string; source_url?: string }>().catch(() => null);
  if (!b) throw bad("Send the task as JSON.");
  const title = String(b.title ?? "").trim();
  if (!title) throw bad("A task needs a title.");
  const source = String(b.source_url ?? "").trim().slice(0, 500);
  // The same email or message must not become a task twice: a repeat returns the first one.
  if (source) {
    const dup = await first<{ id: string; title: string }>(c.env.DB, "SELECT id, title FROM tasks WHERE creator_id = ? AND source_url = ?", who.user.id, source);
    if (dup) return c.json({ ok: true, duplicate: true, task: { id: dup.id, title: dup.title, url: `${c.var.origin}/tasks?open=${dup.id}` } });
  }
  const today = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM tasks WHERE via_key = ? AND created_at > ?", who.keyId, now() - 86_400_000);
  if ((today?.n ?? 0) >= MAX_PER_DAY) return c.json({ error: `This key has added ${MAX_PER_DAY} tasks today. Try again tomorrow.` }, 429);
  const task = await createTask(c.env, { title, notes: String(b.notes ?? "").slice(0, 4000), due: b.due ?? null, assignee_id: who.user.id, creator_id: who.user.id });
  await run(c.env.DB, "UPDATE tasks SET via_key = ?, source_url = ? WHERE id = ?", who.keyId, source || null, task.id);
  return c.json({ ok: true, duplicate: false, task: { id: task.id, title: task.title, url: `${c.var.origin}/tasks?open=${task.id}` } });
});

// Everything else under /api/inbound is closed.
inbound.all("*", (c) => c.json({ error: "Not found." }, 404));
