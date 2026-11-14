import { Hono } from "hono";
import { all, bad, now, run, uid, type Env, type HonoEnv } from "./env";

/**
 * Notifications to phones and browsers through the Web Push protocol: a signed request
 * (VAPID, RFC 8292) carrying a message encrypted for one device (RFC 8291, aes128gcm).
 * Everything here is WebCrypto, so it runs in a Worker without Node's crypto.
 */

const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/**
 * Encrypts a message for one subscription. `fixed` supplies the sender key pair and salt
 * so the published test vector can be reproduced; in normal use both are random.
 */
export async function encryptPush(
  plaintext: Uint8Array, p256dh: string, auth: string,
  fixed?: { salt: Uint8Array; keys: CryptoKeyPair },
): Promise<Uint8Array> {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const keys = fixed?.keys ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, keys.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: the message, then 0x02 to mark it as the last.
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const header = concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublic.length]), asPublic); // record size 4096
  return concat(header, body);
}

/** The "Authorization: vapid ..." value that proves a push comes from this app. */
export async function vapidAuth(env: Env, endpoint: string, at = Date.now()): Promise<string> {
  const pub = unb64u(env.VAPID_PUBLIC_KEY!);
  const jwk = { kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE_KEY!, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const contact = env.MAIL_FROM.match(/<([^>]+)>/)?.[1] ?? env.MAIL_FROM;
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(at / 1000) + 12 * 3600, sub: `mailto:${contact}` })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

/** Push services we will post to. A subscription's address comes from the browser, so it is checked. */
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const allowedEndpoint = (endpoint: string) => {
  try { const u = new URL(endpoint); return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname)); } catch { return false; }
};

export const pushReady = (env: Env) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

export type PushMessage = { title: string; body?: string; url?: string };

/** Sends a notification to every device a person has switched on. Never throws. */
export async function pushToUser(env: Env, userId: string, message: PushMessage): Promise<number> {
  if (!pushReady(env)) return 0;
  let delivered = 0;
  try {
    const subs = await all<{ id: string; endpoint: string; p256dh: string; auth: string }>(env.DB, "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?", userId);
    const payload = enc.encode(JSON.stringify(message));
    await Promise.all(subs.map(async (s) => {
      try {
        if (!allowedEndpoint(s.endpoint)) return;
        const res = await fetch(s.endpoint, {
          method: "POST",
          headers: { Authorization: await vapidAuth(env, s.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "normal" },
          body: await encryptPush(payload, s.p256dh, s.auth),
        });
        if (res.ok) delivered++;
        // The device has unsubscribed or the app was removed.
        else if (res.status === 404 || res.status === 410) await run(env.DB, "DELETE FROM push_subscriptions WHERE id = ?", s.id);
        else console.error("push rejected", res.status, (await res.text()).slice(0, 200));
      } catch (e) { console.error("push failed", String(e).slice(0, 200)); }
    }));
  } catch (e) { console.error("push lookup failed", String(e).slice(0, 200)); }
  return delivered;
}

export const push = new Hono<HonoEnv>();

push.get("/key", (c) => c.json({ key: c.env.VAPID_PUBLIC_KEY ?? null }));

push.post("/subscribe", async (c) => {
  const b = await c.req.json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>();
  if (!b.endpoint || !b.keys?.p256dh || !b.keys?.auth || !allowedEndpoint(b.endpoint)) throw bad("This device's notification details weren't recognised.");
  await run(
    c.env.DB,
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    uid(), c.var.user.id, b.endpoint, b.keys.p256dh, b.keys.auth, now(),
  );
  return c.json({ ok: true });
});

push.post("/unsubscribe", async (c) => {
  const b = await c.req.json<{ endpoint?: string }>();
  if (b.endpoint) await run(c.env.DB, "DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?", b.endpoint, c.var.user.id);
  return c.json({ ok: true });
});

push.post("/test", async (c) => {
  const delivered = await pushToUser(c.env, c.var.user.id, { title: "Notifications are on", body: `You'll hear from ${c.env.APP_NAME} when you're given a task or one is due.`, url: "/tasks" });
  return c.json({ delivered });
});

/** Morning reminder: one notification per person for the tasks due today. */
export async function remindDueToday(env: Env): Promise<number> {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
  const due = await all<{ id: string; title: string; assignee_id: string }>(
    env.DB,
    "SELECT id, title, assignee_id FROM tasks WHERE due = ? AND status != 'done' AND assignee_id IS NOT NULL AND (reminded_on IS NULL OR reminded_on != ?) ORDER BY sort",
    today, today,
  );
  const byPerson = new Map<string, { id: string; title: string }[]>();
  for (const t of due) byPerson.set(t.assignee_id, [...(byPerson.get(t.assignee_id) ?? []), t]);
  for (const [userId, tasks] of byPerson) {
    const title = tasks.length === 1 ? "Due today" : `${tasks.length} tasks due today`;
    const body = tasks.length === 1 ? tasks[0].title : tasks.slice(0, 3).map((t) => t.title).join(" · ") + (tasks.length > 3 ? ` and ${tasks.length - 3} more` : "");
    const url = tasks.length === 1 ? `/tasks?open=${tasks[0].id}` : "/tasks";
    await run(env.DB, "INSERT INTO notifications (id, user_id, actor_id, type, title, body, url, created_at) VALUES (?, ?, NULL, 'due', ?, ?, ?, ?)", uid(), userId, title, body, url, now());
    await pushToUser(env, userId, { title, body, url });
  }
  if (due.length) await run(env.DB, `UPDATE tasks SET reminded_on = ? WHERE id IN (${due.map(() => "?").join(",")})`, today, ...due.map((t) => t.id));
  return due.length;
}
