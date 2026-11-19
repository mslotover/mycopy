// What Atrium spends on Claude. Every API call is logged with an estimated cost (list prices
// below), and each Monday a summary goes to the owner: by person and by feature, alongside the
// Anthropic Console's own figure for the whole organisation when ANTHROPIC_ADMIN_KEY is set.
import type Anthropic from "@anthropic-ai/sdk";
import { all, escapeHtml, now, run, type Env } from "./env";
import { emailLayout, sendMail } from "./mail";

/** US dollars per million tokens: input, output, cache read, cache write (5-minute). */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-fable-5-2": [8, 40, 0.2, 10],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};
function priceFor(model: string) {
  if (PRICES[model]) return PRICES[model];
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  return key ? PRICES[key] : PRICES["claude-opus-5-5"];
}

export type Feature = "ask" | "meeting_summary";
const FEATURE_NAMES: Record<string, string> = { ask: "Ask AI", meeting_summary: "Meeting summaries" };

/** Logs one Claude response. Never throws: a logging failure must not break the answer. */
export async function recordUsage(env: Env, userId: string | null, feature: Feature, message: Pick<Anthropic.Beta.BetaMessage, "model" | "usage">) {
  try {
    const u = message.usage;
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const [pi, po, pr, pw] = priceFor(message.model);
    const cost = (input * pi + output * po + cacheRead * pr + cacheWrite * pw) / 1e6;
    await run(
      env.DB,
      "INSERT INTO ai_usage (user_id, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      userId, feature, message.model, input, output, cacheRead, cacheWrite, cost, now(),
    );
  } catch (err) {
    console.error("usage logging failed", err);
  }
}

// ---------- Weekly email ----------

const DAY = 86_400_000;
const usd = (n: number) => `$${n.toFixed(2)}`;
const fmtDay = (t: number) => new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** The organisation's spend between two instants from Anthropic's cost API, in dollars; null if unavailable. */
async function consoleSpend(env: Env, from: number, to: number): Promise<{ usd: number; refreshedAt: string | null } | null> {
  if (!env.ANTHROPIC_ADMIN_KEY) return null;
  try {
    let total = 0;
    let page: string | null = null;
    let refreshedAt: string | null = null;
    for (let i = 0; i < 20; i++) {
      const q = new URLSearchParams({ starting_at: new Date(from).toISOString(), ending_at: new Date(to).toISOString(), limit: "1000" });
      if (page) q.set("page", page);
      const res = await fetch(`https://api.anthropic.com/v1/organizations/analytics/cost?${q}`, {
        headers: { "x-api-key": env.ANTHROPIC_ADMIN_KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "analytics-usage-cost-2026-08-24" },
      });
      if (!res.ok) throw new Error(`cost API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { data?: { amount?: string }[]; has_more?: boolean; next_page?: string | null; data_refreshed_at?: string | null };
      for (const row of body.data ?? []) total += Number(row.amount ?? 0) / 100; // amounts are in cents
      refreshedAt = body.data_refreshed_at ?? refreshedAt;
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }
    return { usd: total, refreshedAt };
  } catch (err) {
    console.error("console spend failed", err);
    return null;
  }
}

/** The Monday-to-Monday (UTC) week before the one containing `t`. */
function lastWeek(t: number) {
  const d = new Date(t);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
  return { from: monday - 7 * DAY, to: monday };
}

export async function weeklyUsageReport(env: Env, at = Date.now()) {
  const { from, to } = lastWeek(at);
  const lastDay = new Date(to - 1);
  const monthStart = Date.UTC(lastDay.getUTCFullYear(), lastDay.getUTCMonth(), 1);
  const sum = async (a: number, b: number) =>
    (await all<{ c: number | null; n: number }>(env.DB, "SELECT SUM(cost_usd) AS c, COUNT(*) AS n FROM ai_usage WHERE created_at >= ? AND created_at < ?", a, b))[0];
  const [week, prev, month, people, features, consoleWeek, consoleMonth] = await Promise.all([
    sum(from, to),
    sum(from - 7 * DAY, from),
    sum(monthStart, to),
    all<{ name: string | null; c: number; n: number }>(
      env.DB,
      `SELECT u.name, SUM(a.cost_usd) AS c, COUNT(*) AS n FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.created_at >= ? AND a.created_at < ? GROUP BY a.user_id ORDER BY c DESC`,
      from, to,
    ),
    all<{ feature: string; c: number; n: number }>(
      env.DB,
      "SELECT feature, SUM(cost_usd) AS c, COUNT(*) AS n FROM ai_usage WHERE created_at >= ? AND created_at < ? GROUP BY feature ORDER BY c DESC",
      from, to,
    ),
    consoleSpend(env, from, to),
    consoleSpend(env, monthStart, to),
  ]);

  const w = week?.c ?? 0;
  const p = prev?.c ?? 0;
  const change = p > 0 ? ` (${w >= p ? "up" : "down"} ${Math.abs(Math.round(((w - p) / p) * 100))}% on the week before, ${usd(p)})` : "";
  const td = "padding:6px 14px 6px 0;border-bottom:1px solid #e5e5ea";
  const table = (head: string[], rows: string[][]) =>
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 20px;font-size:14px"><tr>${head
      .map((h) => `<th style="${td};text-align:left;color:#86868b;font-weight:600">${h}</th>`)
      .join("")}</tr>${rows.map((r) => `<tr>${r.map((c, i) => `<td style="${td}${i ? ";text-align:right" : ""}">${c}</td>`).join("")}</tr>`).join("")}</table>`;

  let consoleLine: string;
  if (!env.ANTHROPIC_ADMIN_KEY) consoleLine = `<p style="color:#86868b">The Anthropic Console figure isn't included: no admin key has been added yet.</p>`;
  else if (!consoleWeek) consoleLine = `<p style="color:#86868b">The Anthropic Console figure couldn't be fetched this week.</p>`;
  else {
    const partial =
      consoleWeek.refreshedAt && Date.parse(consoleWeek.refreshedAt) < to
        ? ` Anthropic's figures were complete up to ${escapeHtml(new Date(consoleWeek.refreshedAt).toUTCString().slice(0, 22))} UTC, so the last hours may be missing.`
        : "";
    consoleLine = `<p><strong>Anthropic Console (whole account):</strong> ${usd(consoleWeek.usd)} last week, ${consoleMonth ? usd(consoleMonth.usd) : "?"} so far this month.${partial}</p>`;
  }

  const body = `
<p><strong>${usd(w)}</strong> spent by Atrium on Claude from ${fmtDay(from)} to ${fmtDay(to - DAY)}${change}, across ${week?.n ?? 0} AI requests. ${usd(month?.c ?? 0)} so far this month.</p>
${consoleLine}
${people.length ? `<p style="margin-bottom:0"><strong>By person</strong></p>${table(["Person", "Requests", "Cost"], people.map((r) => [escapeHtml(r.name ?? "Background work"), String(r.n), usd(r.c)]))}` : ""}
${features.length ? `<p style="margin-bottom:0"><strong>By feature</strong></p>${table(["Feature", "Requests", "Cost"], features.map((r) => [escapeHtml(FEATURE_NAMES[r.feature] ?? r.feature), String(r.n), usd(r.c)]))}` : ""}
<p style="color:#86868b;font-size:13px">Atrium's figures are estimates from Anthropic's list prices, in US dollars as the Console bills. You can cap spending in the Console under Settings, Limits.</p>`;
  if (!env.REPORT_TO) return;
  await sendMail(env, env.REPORT_TO, `${env.APP_NAME}: ${usd(w)} spent on AI last week`, emailLayout(env, { heading: "Weekly AI spending", body }));
}
