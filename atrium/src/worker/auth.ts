import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { all, bad, escapeHtml, first, isDev, now, run, sha256, token, type Ctx, type Env, type HonoEnv, type User } from "./env";
import { emailLayout, sendMail } from "./mail";

const COOKIE = "atrium_session";
const SESSION_DAYS = 60;
const LINK_MINUTES = 20;

export async function userFromRequest(c: Ctx): Promise<User | null> {
  const sid = getCookie(c, COOKIE);
  if (!sid) return null;
  const row = await first<User & { expires_at: number }>(
    c.env.DB,
    `SELECT u.id, u.email, u.name, u.color, u.role, u.active, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    await sha256(sid),
  );
  if (!row || !row.active || row.expires_at < now()) return null;
  return { id: row.id, email: row.email, name: row.name, color: row.color, role: row.role, active: row.active };
}

async function startSession(c: Ctx, userId: string) {
  const sid = token();
  const expires = now() + SESSION_DAYS * 86400_000;
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(await sha256(sid), userId, expires, now()),
    c.env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(now(), userId),
    c.env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()),
  ]);
  setCookie(c, COOKIE, sid, {
    httpOnly: true,
    secure: c.var.origin.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

const googleEnabled = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export const auth = new Hono<HonoEnv>();

auth.get("/config", (c) => c.json({ appName: c.env.APP_NAME, google: googleEnabled(c.env) }));

// Step 1: email a one-time sign-in link. Only people already invited can sign in, and the
// response is the same whether or not the address is known.
auth.post("/request", async (c) => {
  const { email } = await c.req.json<{ email?: string }>();
  const addr = (email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw bad("Enter a valid email address.");
  const user = await first<User>(c.env.DB, "SELECT * FROM users WHERE email = ? AND active = 1", addr);
  let devLink: string | undefined;
  if (user) {
    const recent = await first<{ n: number }>(
      c.env.DB,
      "SELECT COUNT(*) AS n FROM login_tokens WHERE user_id = ? AND expires_at > ?",
      user.id, now() + (LINK_MINUTES - 10) * 60_000,
    );
    if ((recent?.n ?? 0) < 5) {
      const t = token();
      await run(c.env.DB, "INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)", await sha256(t), user.id, now() + LINK_MINUTES * 60_000);
      const link = `${c.var.origin}/signin?token=${t}`;
      if (isDev(c.env)) devLink = link;
      await sendMail(
        c.env,
        user.email,
        `Sign in to ${c.env.APP_NAME}`,
        emailLayout(c.env, {
          heading: `Sign in to ${c.env.APP_NAME}`,
          body: `<p style="margin:0;color:#424245">Hi ${escapeHtml(user.name.split(" ")[0])}, use the button below to sign in. The link works once and expires in ${LINK_MINUTES} minutes.</p>`,
          cta: { label: "Sign in", url: link },
          footer: "If you didn't ask for this, you can ignore this email.",
        }),
      );
    }
  }
  return c.json({ ok: true, devLink });
});

// Step 2: the sign-in page posts the token (a POST, so mail scanners that prefetch links can't use it up).
auth.post("/verify", async (c) => {
  const { token: t } = await c.req.json<{ token?: string }>();
  if (!t) throw bad("Missing token.");
  const hash = await sha256(t);
  const row = await first<{ user_id: string; expires_at: number; used_at: number | null }>(c.env.DB, "SELECT * FROM login_tokens WHERE token_hash = ?", hash);
  if (!row || row.used_at || row.expires_at < now()) throw bad("This sign-in link has expired or was already used. Request a new one.");
  await run(c.env.DB, "UPDATE login_tokens SET used_at = ? WHERE token_hash = ?", now(), hash);
  await run(c.env.DB, "DELETE FROM login_tokens WHERE expires_at < ?", now() - 86400_000);
  await startSession(c, row.user_id);
  return c.json({ ok: true });
});

auth.post("/logout", async (c) => {
  const sid = getCookie(c, COOKIE);
  if (sid) await run(c.env.DB, "DELETE FROM sessions WHERE id_hash = ?", await sha256(sid));
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// Google sign-in, available once GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
auth.get("/google", async (c) => {
  if (!googleEnabled(c.env)) throw bad("Google sign-in is not configured.");
  const state = token();
  setCookie(c, "atrium_oauth", state, { httpOnly: true, secure: c.var.origin.startsWith("https://"), sameSite: "Lax", path: "/", maxAge: 600 });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${c.var.origin}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  }).toString();
  return c.redirect(url.toString());
});

auth.get("/google/callback", async (c) => {
  if (!googleEnabled(c.env)) throw bad("Google sign-in is not configured.");
  const fail = (msg: string) => c.redirect(`/signin?error=${encodeURIComponent(msg)}`);
  const state = getCookie(c, "atrium_oauth");
  deleteCookie(c, "atrium_oauth", { path: "/" });
  if (!state || state !== c.req.query("state")) return fail("Sign-in was interrupted. Please try again.");
  const code = c.req.query("code");
  if (!code) return fail("Google sign-in was cancelled.");
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${c.var.origin}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return fail("Google sign-in failed. Please try again.");
  const { access_token } = await tokenRes.json<{ access_token: string }>();
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${access_token}` } });
  if (!infoRes.ok) return fail("Google sign-in failed. Please try again.");
  const info = await infoRes.json<{ email?: string; email_verified?: boolean }>();
  if (!info.email || !info.email_verified) return fail("Your Google account has no verified email.");
  const user = await first<User>(c.env.DB, "SELECT * FROM users WHERE email = ? AND active = 1", info.email.toLowerCase());
  if (!user) return fail(`${info.email} hasn't been invited to this workspace.`);
  await startSession(c, user.id);
  return c.redirect("/");
});

export async function listDirectory(env: Env) {
  return all<Omit<User, "active"> & { active: number }>(env.DB, "SELECT id, email, name, color, role, active FROM users ORDER BY name COLLATE NOCASE");
}
