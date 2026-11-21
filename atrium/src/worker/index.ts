import { Hono } from "hono";
import { ai } from "./ai";
import { auth, userFromRequest } from "./auth";
import { HttpError, type HonoEnv } from "./env";
import { inbound, keys } from "./keys";
import { meetings } from "./meetings";
import { misc } from "./misc";
import { pages } from "./pages";
import { prep, sendMeetingPreps } from "./prep";
import { privacyPage } from "./privacy";
import { push, remindDueToday } from "./push";
import { slack } from "./slack";
import { STATIC } from "./static.gen";
import { tasks } from "./tasks";
import { embedDirty } from "./vectors";
import { weeklyUsageReport } from "./usage";
import { sendMorningBriefs } from "./brief";

/** Runs and clears queued one-off jobs. */
async function runFlags(env: HonoEnv["Bindings"]) {
  const res = await env.DB.prepare("DELETE FROM app_flags WHERE name = 'brief_preview' RETURNING name").all();
  if (res.results.length) await sendMorningBriefs(env);
}



const app = new Hono<HonoEnv>();

app.use("/api/*", async (c, next) => {
  c.set("origin", new URL(c.req.url).origin);
  // State-changing requests must come from our own pages.
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin && origin !== c.var.origin) return c.json({ error: "Cross-site request blocked." }, 403);
  }
  await next();
});

app.route("/api/auth", auth);

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/") || c.req.path.startsWith("/api/inbound/")) return next();
  const user = await userFromRequest(c);
  if (!user) return c.json({ error: "Please sign in." }, 401);
  c.set("user", user);
  await next();
});

app.route("/api/inbound", inbound);
app.route("/api/me/keys", keys);
app.route("/api/pages", pages);
app.route("/api/tasks", tasks);
app.route("/api/meetings", meetings);
app.route("/api/ai", ai);
app.route("/api/push", push);
app.route("/api/prep", prep);
app.route("/api", misc);

app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

// The front end normally comes from Cloudflare's static-asset store and never reaches this
// code. When it has been packed into the Worker instead (deploy:embedded), serve it here,
// answering unknown paths with the app shell so its own routing can take over.
app.get("/privacy", (c) => privacyPage(c.env));
app.route("/slack", slack);

app.get("*", (c) => {
  const path = new URL(c.req.url).pathname;
  const exact = STATIC[path];
  const file = exact ?? STATIC["/index.html"];
  if (!file) return c.text("Not found.", 404);
  return new Response(file.data, {
    headers: {
      "Content-Type": file.type,
      "Cache-Control": exact && path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof SyntaxError) return c.json({ error: "Malformed request." }, 400);
  console.error("unhandled", c.req.method, c.req.path, err);
  return c.json({ error: "Something went wrong on our side. Please try again." }, 500);
});

export default {
  fetch: app.fetch,
  // One five-minute timer runs everything (the Workers free plan allows five timers per
  // account): embedding changed items for search every time, and at set UTC times the
  // morning brief (07:35, after the data connector's sync), due-today reminders (08:00) and
  // Monday's AI spending email (09:00). Every time, meeting prep notes go out for meetings
  // starting in 10 to 20 minutes on people's connected calendars. One-off jobs are queued as rows in app_flags.
  async scheduled(event: ScheduledController, env: HonoEnv["Bindings"], ctx: ExecutionContext) {
    const t = new Date(event.scheduledTime);
    const at = (h: number, m: number) => t.getUTCHours() === h && t.getUTCMinutes() === m;
    const jobs: Promise<unknown>[] = [embedDirty(env)];
    if (at(7, 35)) jobs.push(sendMorningBriefs(env));
    if (at(8, 0)) jobs.push(remindDueToday(env));
    if (at(9, 0) && t.getUTCDay() === 1) jobs.push(weeklyUsageReport(env));
    jobs.push(sendMeetingPreps(env));
    jobs.push(runFlags(env));
    ctx.waitUntil(Promise.allSettled(jobs));
  },
};
