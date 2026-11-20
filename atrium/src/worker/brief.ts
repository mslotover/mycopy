// The morning brief: one email per person, sent after the overnight data sync. Yesterday's trading
// at their sites (compared with the same day last week), the restaurant's bookings, bakery
// wholesale, then their overdue tasks, tasks due today and new actions from meetings.
// Recipients are listed in BRIEF_RECIPIENTS while it's being tried out.
import { hasData, queryData } from "./data";
import { all, escapeHtml, isAdmin, type Env, type User } from "./env";
import { emailLayout, sendMail } from "./mail";

/** Till sites in the business data, and the space names that point to them. */
const SITES = [
  { site: "Toklas", label: "Toklas Restaurant", match: /restaurant/i, kind: "restaurant" as const },
  { site: "Toklas - Bakery", label: "Toklas Bakery shop", match: /bakery/i, kind: "bakery" as const },
];
const BOOKINGS_VENUE = "Toklas";

const DAY = 86_400_000;
const gbp = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(n);
const gbp2 = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const londonDate = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);

function change(now: number, before: number) {
  if (!before) return "";
  const pct = Math.round(((now - before) / before) * 100);
  const colour = pct > 0 ? "#1a7f37" : pct < 0 ? "#c62828" : "#86868b";
  return ` <span style="color:${colour};font-weight:600">${pct > 0 ? "+" : ""}${pct}%</span>`;
}

const td = "padding:7px 14px 7px 0;border-bottom:1px solid #e5e5ea;vertical-align:top";
function table(head: string[], rows: string[][]) {
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 4px;font-size:14px;width:100%"><tr>${head
    .map((h, i) => `<th style="${td};text-align:${i ? "right" : "left"};color:#86868b;font-weight:600">${h}</th>`)
    .join("")}</tr>${rows.map((r) => `<tr>${r.map((c, i) => `<td style="${td};text-align:${i ? "right" : "left"}">${c}</td>`).join("")}</tr>`).join("")}</table>`;
}
const h2 = (t: string) => `<h2 style="margin:26px 0 6px;font-size:17px;letter-spacing:-.01em">${t}</h2>`;
const note = (t: string) => `<p style="margin:4px 0;color:#86868b;font-size:13px">${t}</p>`;

async function tradingSection(env: Env, user: User, spaceNames: string[], day: string): Promise<string> {
  if (!hasData(env, user)) return "";
  const sites = SITES.filter((s) => isAdmin(user) || spaceNames.some((n) => s.match.test(n)));
  if (!sites.length) return "";
  const lastWeek = shift(day, -7);
  const list = sites.map((s) => `'${s.site}'`).join(", ");
  const wantBookings = sites.some((s) => s.kind === "restaurant");
  const wantWholesale = sites.some((s) => s.kind === "bakery");
  try {
    const [sales, items, bookings, wholesale] = await Promise.all([
      queryData<{ site: string; d: string; net: number; receipts: number; covers: number }>(
        env, user.email,
        `SELECT site, CAST(date AS STRING) AS d, SUM(net_ex_vat) AS net, SUM(receipts) AS receipts, SUM(covers) AS covers
           FROM sales_daily WHERE date IN ('${day}', '${lastWeek}') AND site IN (${list}) GROUP BY site, d`,
      ),
      queryData<{ site: string; item: string; q: number }>(
        env, user.email,
        `SELECT site, item, SUM(quantity) AS q FROM sales_items WHERE date = '${day}' AND site IN (${list})
           AND NOT REGEXP_CONTAINS(LOWER(item), r'\\bopen\\b|\\bevents?\\b|donation') -- open-price till buttons aren't products
           GROUP BY site, item QUALIFY ROW_NUMBER() OVER (PARTITION BY site ORDER BY SUM(quantity) DESC) <= 3`,
      ),
      wantBookings
        ? queryData<{ status: string; b: number; c: number }>(
            env, user.email,
            `SELECT status, SUM(bookings) AS b, SUM(covers) AS c FROM bookings_daily WHERE date = '${day}' AND venue = '${BOOKINGS_VENUE}' GROUP BY status`,
          )
        : Promise.resolve([]),
      wantWholesale
        ? queryData<{ d: string; v: number; n: number }>(
            env, user.email,
            `SELECT CAST(date AS STRING) AS d, SUM(value) AS v, COUNT(DISTINCT customer) AS n FROM wholesale_daily WHERE date IN ('${day}', '${lastWeek}') GROUP BY d`,
          )
        : Promise.resolve([]),
    ]);

    const get = (site: string, d: string) => sales.find((r) => r.site === site && r.d === d);
    if (!sales.some((r) => r.d === day)) return h2(`Yesterday, ${shortDate(day)}`) + note("Yesterday's till figures haven't loaded yet.");

    const rows: string[][] = [];
    for (const s of sites) {
      const y = get(s.site, day);
      const w = get(s.site, lastWeek);
      if (!y) { rows.push([escapeHtml(s.label), "no sales", "", ""]); continue; }
      const people = s.kind === "restaurant" ? y.covers : y.receipts;
      const before = s.kind === "restaurant" ? w?.covers ?? 0 : w?.receipts ?? 0;
      const per = people ? y.net / people : 0;
      rows.push([
        escapeHtml(s.label),
        gbp(y.net) + change(y.net, w?.net ?? 0),
        `${people} ${s.kind === "restaurant" ? "covers" : "receipts"}${change(people, before)}`,
        people ? `${gbp2(per)} ${s.kind === "restaurant" ? "a cover" : "a receipt"}` : "",
      ]);
    }
    let html = h2(`Yesterday, ${shortDate(day)}`) + table(["Site", "Net sales ex VAT", "Customers", "Average"], rows);
    html += note(`Changes compare with ${shortDate(lastWeek)}, the same day last week.`);

    if (wantBookings && bookings.length) {
      const sum = (pred: (s: string) => boolean, f: "b" | "c") => bookings.filter((r) => pred(r.status)).reduce((a, r) => a + (r[f] ?? 0), 0);
      const noShow = (s: string) => /no.?show/i.test(s);
      const cancelled = (s: string) => /cancel/i.test(s);
      const came = sum((s) => !noShow(s) && !cancelled(s), "c");
      const ns = sum(noShow, "b");
      const cx = sum(cancelled, "b");
      html += `<p style="margin:12px 0 0;font-size:14px"><strong>Restaurant bookings:</strong> ${came} covers from bookings${ns ? `, ${ns} no-show${ns === 1 ? "" : "s"}` : ""}${cx ? `, ${cx} cancelled` : ""}.</p>`;
    }
    if (wantWholesale) {
      const y = wholesale.find((r) => r.d === day);
      const w = wholesale.find((r) => r.d === lastWeek);
      html += `<p style="margin:8px 0 0;font-size:14px"><strong>Bakery wholesale:</strong> ${
        y ? `${gbp(y.v)} to ${y.n} customer${y.n === 1 ? "" : "s"}${change(y.v, w?.v ?? 0)}` : "nothing recorded"
      }.</p>`;
    }
    const best = sites
      .map((s) => ({ s, top: items.filter((i) => i.site === s.site) }))
      .filter((x) => x.top.length)
      .map((x) => `${escapeHtml(x.s.label)}: ${x.top.map((i) => `${escapeHtml(i.item)} (${Math.round(i.q)})`).join(", ")}`);
    if (best.length) html += `<p style="margin:8px 0 0;font-size:14px"><strong>Best sellers:</strong><br>${best.join("<br>")}</p>`;
    return html;
  } catch (err) {
    console.error("brief trading failed", err);
    return h2(`Yesterday, ${shortDate(day)}`) + note("The figures couldn't be fetched this morning.");
  }
}

type TaskRow = { id: string; title: string; due: string | null; space: string | null; meeting: string | null };

async function tasksSection(env: Env, user: User, today: string, link: (path: string) => string, since: number): Promise<string> {
  const base = `SELECT t.id, t.title, t.due, s.name AS space, m.title AS meeting FROM tasks t
    LEFT JOIN spaces s ON s.id = t.space_id LEFT JOIN meetings m ON m.id = t.meeting_id
    WHERE t.id IN (SELECT task_id FROM task_assignees WHERE user_id = ? AND done_at IS NULL) AND t.status != 'done'`;
  const [overdue, dueToday, fromMeetings] = await Promise.all([
    all<TaskRow>(env.DB, `${base} AND t.due < ? ORDER BY t.due DESC LIMIT 50`, user.id, today),
    all<TaskRow>(env.DB, `${base} AND t.due = ? ORDER BY t.sort LIMIT 30`, user.id, today),
    all<TaskRow>(env.DB, `${base} AND t.meeting_id IS NOT NULL AND t.created_at >= ? ORDER BY t.created_at DESC LIMIT 20`, user.id, since),
  ]);
  const item = (t: TaskRow, extra = "") =>
    `<li style="margin:3px 0"><a href="${link(`/tasks?open=${t.id}`)}" style="color:#0071e3;text-decoration:none">${escapeHtml(t.title)}</a>${extra}</li>`;
  const ul = (items: string[]) => `<ul style="margin:4px 0 0;padding-left:20px;font-size:14px">${items.join("")}</ul>`;
  let html = "";
  if (dueToday.length) html += h2("Due today") + ul(dueToday.map((t) => item(t, t.space ? ` <span style="color:#86868b">· ${escapeHtml(t.space)}</span>` : "")));
  if (fromMeetings.length) html += h2("New from meetings") + ul(fromMeetings.map((t) => item(t, t.meeting ? ` <span style="color:#86868b">· ${escapeHtml(t.meeting)}</span>` : "")));
  if (overdue.length) {
    const shown = overdue.slice(0, 8);
    html += h2(`Overdue (${overdue.length})`) + ul(shown.map((t) => item(t, ` <span style="color:#c62828">· due ${shortDate(t.due!)}</span>`)));
    if (overdue.length > shown.length) html += note(`<a href="${link("/tasks")}" style="color:#0071e3">See all ${overdue.length} in Atrium</a>`);
  }
  if (!html) html = h2("Your tasks") + `<p style="margin:4px 0;font-size:14px">Nothing due today and nothing overdue.</p>`;
  return html;
}

export async function buildBrief(env: Env, user: User, at = Date.now()) {
  const today = londonDate(at);
  const yesterday = shift(today, -1);
  const base = (env.APP_URL ?? "").replace(/\/$/, "");
  const link = (path: string) => escapeHtml(base + path);
  const spaces = await all<{ name: string }>(env.DB, "SELECT s.name FROM spaces s JOIN space_members m ON m.space_id = s.id WHERE m.user_id = ? AND s.archived = 0", user.id);
  const [trading, tasks] = await Promise.all([
    tradingSection(env, user, spaces.map((s) => s.name), yesterday),
    tasksSection(env, user, today, link, at - DAY),
  ]);
  const first = user.name.split(" ")[0] || user.name;
  const body = `<p style="margin:0">Good morning, ${escapeHtml(first)}. Here's ${escapeHtml(longDate(today))}.</p>${trading}${tasks}`;
  return {
    subject: `Your morning brief · ${shortDate(today)}`,
    html: emailLayout(env, { heading: "Morning brief", body, cta: base ? { label: "Open Atrium", url: `${base}/tasks` } : undefined }),
  };
}

/** Sends the brief to everyone in BRIEF_RECIPIENTS (comma-separated emails). */
export async function sendMorningBriefs(env: Env) {
  const emails = (env.BRIEF_RECIPIENTS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) return;
  const users = await all<User>(
    env.DB,
    `SELECT * FROM users WHERE active = 1 AND role != 'guest' AND lower(email) IN (${emails.map(() => "?").join(",")})`,
    ...emails,
  );
  for (const u of users) {
    try {
      const { subject, html } = await buildBrief(env, u);
      await sendMail(env, u.email, subject, html);
    } catch (err) {
      console.error("brief failed", u.email, err);
    }
  }
}
