// Slack, in two small ways. (1) A task assigned to someone also arrives as a Slack message from the
// Atrium app. (2) A message shortcut, "Add to Atrium", turns one chosen Slack message into a
// task. Atrium never reads Slack on its own: it sees only the single message a person sends it.
// Needs two secrets: SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET. Without them everything here is skipped.
import { Hono } from "hono";
import { first, isDev, run, type Env, type HonoEnv } from "./env";
import { createTask } from "./tasks";

export const slackReady = (env: Env) => !!env.SLACK_BOT_TOKEN && !isDev(env);

async function slackApi(env: Env, method: string, body: Record<string, unknown>, form = false): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8" },
    body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  return res.json().catch(() => ({}));
}

/** Finds a person's Slack id from their email (remembered once found). */
async function slackIdFor(env: Env, userId: string): Promise<string | null> {
  const u = await first<{ email: string; slack_id: string | null }>(env.DB, "SELECT email, slack_id FROM users WHERE id = ?", userId);
  if (!u) return null;
  if (u.slack_id) return u.slack_id;
  const emails = [u.email, ...(await env.DB.prepare("SELECT email FROM user_emails WHERE user_id = ?").bind(userId).all<{ email: string }>()).results.map((r) => r.email)];
  for (const email of emails) {
    const r = await slackApi(env, "users.lookupByEmail", { email }, true);
    if (r.ok && r.user?.id) {
      await run(env.DB, "UPDATE users SET slack_id = ? WHERE id = ?", r.user.id, userId);
      return r.user.id;
    }
  }
  return null;
}

/** Sends a Slack message to a person, if Slack is set up and we can find them. Never throws. */
export async function slackDirectMessage(env: Env, userId: string, text: string): Promise<void> {
  if (!slackReady(env)) return;
  try {
    const sid = await slackIdFor(env, userId);
    if (!sid) return;
    const r = await slackApi(env, "chat.postMessage", { channel: sid, text, unfurl_links: false });
    if (!r.ok) console.error("slack dm failed", r.error);
  } catch (e) { console.error("slack dm failed", String(e).slice(0, 200)); }
}

/** Slack signs each request; reject anything that isn't from Slack or is more than five minutes old. */
async function validSignature(env: Env, raw: string, ts: string | undefined, sig: string | undefined): Promise<boolean> {
  if (!env.SLACK_SIGNING_SECRET || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SLACK_SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${raw}`)));
  const want = "v0=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** Slack's message text with its markup (<@U1>, <https://x|label>, &amp;) turned into plain text. */
export function plainSlackText(s: string): string {
  return s
    .replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, "@someone")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!([a-z]+)[^>]*>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]*)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

type MessageAction = {
  type: string; callback_id: string; response_url: string;
  user: { id: string }; channel: { id: string }; message: { text?: string; ts: string };
};

async function replyPrivately(url: string, text: string) {
  try { await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", text }), signal: AbortSignal.timeout(4000) }); } catch { /* nothing more to do */ }
}

/** The Atrium account for a Slack person, matched by email address. */
async function atriumUserFor(env: Env, slackUserId: string): Promise<{ id: string } | null> {
  const info = await slackApi(env, "users.info", { user: slackUserId }, true);
  const email = String(info.user?.profile?.email ?? "").toLowerCase();
  if (!email) return null;
  return first<{ id: string }>(
    env.DB,
    `SELECT id FROM users WHERE active = 1 AND LOWER(email) = ?1
     UNION SELECT u.id FROM user_emails e JOIN users u ON u.id = e.user_id WHERE u.active = 1 AND LOWER(e.email) = ?1`,
    email,
  );
}

async function addTaskFromMessage(env: Env, origin: string, p: MessageAction) {
  try {
    const person = await atriumUserFor(env, p.user.id);
    if (!person) return replyPrivately(p.response_url, "I couldn't match your Slack email to an Atrium account, so no task was made. Ask the person who invited you to check your email address in Atrium.");
    const text = plainSlackText(p.message.text ?? "").trim();
    if (!text) return replyPrivately(p.response_url, "That message has no text to turn into a task.");
    const title = (text.split("\n")[0] ?? text).slice(0, 120);
    const task = await createTask(env, { title, notes: text.length > title.length ? text : "", assignee_id: person.id, creator_id: person.id });
    const link = await slackApi(env, "chat.getPermalink", { channel: p.channel.id, message_ts: p.message.ts }, true);
    if (link.ok && link.permalink) await run(env.DB, "UPDATE tasks SET source_url = ? WHERE id = ?", link.permalink, task.id);
    return replyPrivately(p.response_url, `Added to Atrium: ${origin}/tasks?open=${task.id}`);
  } catch (e) {
    console.error("slack add task failed", String(e).slice(0, 200));
    return replyPrivately(p.response_url, "Sorry, that didn't work. Please try again in a minute.");
  }
}

export const slack = new Hono<HonoEnv>();

slack.post("/interactions", async (c) => {
  const raw = await c.req.text();
  if (!(await validSignature(c.env, raw, c.req.header("x-slack-request-timestamp"), c.req.header("x-slack-signature")))) return c.text("Not allowed.", 401);
  let payload: MessageAction;
  try { payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? ""); } catch { return c.text("Bad request.", 400); }
  if (payload.type === "message_action" && payload.callback_id === "add_task") {
    // Slack wants an answer within three seconds, so reply now and finish in the background.
    c.executionCtx.waitUntil(addTaskFromMessage(c.env, c.env.APP_URL ?? new URL(c.req.url).origin, payload));
  }
  return c.body(null, 200);
});

// ---------- Reacting with the Atrium emoji ----------
// A reaction only says where it happened, so Atrium reads that one message back. That works only in
// channels the Atrium app has been added to; elsewhere the person is told to use the shortcut instead.

/** Reacting with any of these emoji makes a task from the message. */
export const TASK_EMOJI = ["atrium"];

type ReactionEvent = { type: string; user: string; reaction: string; item: { type: string; channel: string; ts: string } };

async function findMessage(env: Env, channel: string, ts: string): Promise<{ text: string } | null> {
  const h = await slackApi(env, "conversations.history", { channel, latest: ts, inclusive: "true", limit: "1" }, true);
  if (!h.ok) throw new Error(String(h.error ?? "history failed"));
  const hit = (h.messages ?? []).find((m: { ts: string }) => m.ts === ts);
  if (hit) return hit;
  // A reply inside a thread isn't in the channel history; ask for the thread instead.
  const r = await slackApi(env, "conversations.replies", { channel, ts, latest: ts, inclusive: "true", limit: "10" }, true);
  return r.ok ? (r.messages ?? []).find((m: { ts: string }) => m.ts === ts) ?? null : null;
}

async function tellReactor(env: Env, ev: ReactionEvent, userId: string, text: string) {
  const r = await slackApi(env, "chat.postEphemeral", { channel: ev.item.channel, user: ev.user, text }, true);
  if (!r.ok) await slackDirectMessage(env, userId, text);
}

async function addTaskFromReaction(env: Env, origin: string, ev: ReactionEvent) {
  try {
    const person = await atriumUserFor(env, ev.user);
    if (!person) {
      const r = await slackApi(env, "chat.postMessage", { channel: ev.user, text: "I couldn't match your Slack email to an Atrium account, so no task was made. Ask the person who invited you to check your email address in Atrium." });
      if (!r.ok) console.error("slack reply failed", r.error);
      return;
    }
    let msg: { text: string } | null = null;
    try { msg = await findMessage(env, ev.item.channel, ev.item.ts); } catch (e) {
      return tellReactor(env, ev, person.id, "I can't read that message because Atrium isn't in that channel. Add it by typing /invite @Atrium there, or use the \"Add to Atrium\" message shortcut instead.");
    }
    const text = plainSlackText(msg?.text ?? "").trim();
    if (!text) return tellReactor(env, ev, person.id, "That message has no text to turn into a task.");
    const link = await slackApi(env, "chat.getPermalink", { channel: ev.item.channel, message_ts: ev.item.ts }, true);
    const source = link.ok && link.permalink ? String(link.permalink) : `slack:${ev.item.channel}:${ev.item.ts}`;
    // Reacting twice, or Slack sending the event again, must not make a second task.
    const dup = await first<{ id: string }>(env.DB, "SELECT id FROM tasks WHERE creator_id = ? AND source_url = ?", person.id, source);
    if (dup) return tellReactor(env, ev, person.id, `Already in Atrium: ${origin}/tasks?open=${dup.id}`);
    const title = (text.split("\n")[0] ?? text).slice(0, 120);
    const task = await createTask(env, { title, notes: text.length > title.length ? text : "", assignee_id: person.id, creator_id: person.id });
    await run(env.DB, "UPDATE tasks SET source_url = ? WHERE id = ?", source, task.id);
    return tellReactor(env, ev, person.id, `Added to Atrium: ${origin}/tasks?open=${task.id}`);
  } catch (e) {
    console.error("slack reaction failed", String(e).slice(0, 200));
  }
}

slack.post("/events", async (c) => {
  const raw = await c.req.text();
  if (!(await validSignature(c.env, raw, c.req.header("x-slack-request-timestamp"), c.req.header("x-slack-signature")))) return c.text("Not allowed.", 401);
  let body: { type: string; challenge?: string; event?: ReactionEvent };
  try { body = JSON.parse(raw); } catch { return c.text("Bad request.", 400); }
  // Slack checks the address once when the app is set up.
  if (body.type === "url_verification") return c.json({ challenge: body.challenge });
  const ev = body.event;
  // A retry means Slack didn't hear our first answer; the first one is already being handled.
  if (body.type === "event_callback" && ev?.type === "reaction_added" && ev.item?.type === "message" && TASK_EMOJI.includes(ev.reaction) && !c.req.header("x-slack-retry-num")) {
    c.executionCtx.waitUntil(addTaskFromReaction(c.env, c.env.APP_URL ?? new URL(c.req.url).origin, ev));
  }
  return c.body(null, 200);
});
