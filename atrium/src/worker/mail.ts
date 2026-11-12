import { escapeHtml, isDev, now, run, uid, type Env } from "./env";

/**
 * Sends an email through Resend and records it in the outbox. In dev mode, or when no
 * Resend key is configured, the message is recorded but not sent.
 */
export async function sendMail(env: Env, to: string, subject: string, html: string): Promise<boolean> {
  let status = "skipped";
  let error: string | null = null;
  if (env.RESEND_API_KEY && !isDev(env)) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, html }),
      });
      status = res.ok ? "sent" : "failed";
      if (!res.ok) error = (await res.text()).slice(0, 500);
    } catch (e) {
      status = "failed";
      error = String(e).slice(0, 500);
    }
  }
  await run(
    env.DB,
    "INSERT INTO outbox (id, to_email, subject, html, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    uid(), to, subject, html, status, error, now(),
  );
  return status === "sent";
}

/** A plain, system-font email layout that reads well in every client. */
export function emailLayout(env: Env, opts: { heading: string; body: string; cta?: { label: string; url: string }; footer?: string }): string {
  const cta = opts.cta
    ? `<p style="margin:28px 0 0"><a href="${escapeHtml(opts.cta.url)}" style="display:inline-block;background:#0071e3;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 22px;border-radius:980px">${escapeHtml(opts.cta.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f5f5f7;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1d1d1f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;padding:36px 40px;text-align:left">
<tr><td>
<p style="margin:0 0 20px;font-size:13px;font-weight:600;letter-spacing:.02em;color:#86868b">${escapeHtml(env.APP_NAME)}</p>
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.2;letter-spacing:-.02em;font-weight:700">${escapeHtml(opts.heading)}</h1>
<div style="font-size:15px;line-height:1.55;color:#1d1d1f">${opts.body}</div>
${cta}
</td></tr></table>
<p style="margin:18px 0 0;font-size:12px;color:#86868b">${escapeHtml(opts.footer ?? `Sent by ${env.APP_NAME}`)}</p>
</td></tr></table></body></html>`;
}

/** Records an in-app notification and, optionally, emails the recipient. */
export async function notify(
  env: Env,
  origin: string,
  n: { user_id: string; actor_id?: string | null; type: string; title: string; body?: string; url: string; email?: boolean },
) {
  if (n.actor_id && n.actor_id === n.user_id) return;
  await run(
    env.DB,
    "INSERT INTO notifications (id, user_id, actor_id, type, title, body, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    uid(), n.user_id, n.actor_id ?? null, n.type, n.title, n.body ?? "", n.url, now(),
  );
  if (n.email) {
    const u = await env.DB.prepare("SELECT email, active FROM users WHERE id = ?").bind(n.user_id).first<{ email: string; active: number }>();
    if (u?.active) {
      await sendMail(
        env,
        u.email,
        n.title,
        emailLayout(env, {
          heading: n.title,
          body: n.body ? `<p style="margin:0;color:#424245">${escapeHtml(n.body)}</p>` : "",
          cta: { label: `Open in ${env.APP_NAME}`, url: origin + n.url },
        }),
      );
    }
  }
}
