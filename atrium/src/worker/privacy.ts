// A public privacy policy page (needed for Google sign-in). No contact address is written here:
// the repo is public, so people are pointed to whoever invited them.
import type { Env } from "./env";

export function privacyPage(env: Env): Response {
  const name = env.APP_NAME.replace(/[<>&"]/g, "");
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy policy · ${name}</title>
<style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#1d1d1f}h1{font-size:28px}h2{font-size:18px;margin-top:28px}</style></head><body>
<h1>${name} privacy policy</h1>
<p>${name} is a private workspace used by the team at Toklas, Meret and Fort Road. It is only for people who have been invited. This page explains what it does with your information.</p>
<h2>Signing in with Google</h2>
<p>When you sign in with Google, ${name} receives your name and email address. It uses them only to recognise you and to match you to your invitation. It does not ask for access to your Gmail, Drive or any other Google data.</p>
<h2>What ${name} keeps</h2>
<ul>
<li>Your name, email address and role.</li>
<li>The pages, tasks, notes and comments you and your team write.</li>
<li>Meetings you record: the audio, the written transcript, the summary and the action points. People you list as taking part, including people outside the team, are recorded by name and email address so they can receive the minutes.</li>
<li>If you choose to connect your Google Calendar, the private calendar address you provide. It is stored securely, never shown back in the app, and used only to read meeting times and invitees so that ${name} can send you a preparation note before a meeting.</li>
<li>If your team has connected Slack, your Slack member id (found by matching your email address), so ${name} can message you when a task is assigned to you. ${name} does not read your Slack. If you choose "Add to Atrium" on a Slack message, only that one message is saved, as a task.</li>
<li>If you switch on notifications, the details your device gives ${name} so it can send them.</li>
</ul>
<h2>Who processes it</h2>
<p>${name} runs on Cloudflare, which stores the data and transcribes recordings. Summaries and answers to questions are written by Claude, an AI service from Anthropic, using only the text needed for that request. Emails are sent through an email service. Your information is not sold and is not used for advertising.</p>
<h2>Who can see it</h2>
<p>Pages, tasks and meetings are visible only to the people they are shared with. Business figures are limited to the business you belong to, apart from the owners, who see all of them.</p>
<h2>Your choices</h2>
<p>You can disconnect your calendar and switch off notifications in Settings at any time. To see, correct or delete your information, or to leave, ask the person who invited you to ${name}.</p>
<p style="color:#86868b;margin-top:32px">Last updated November 2026.</p>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
}
