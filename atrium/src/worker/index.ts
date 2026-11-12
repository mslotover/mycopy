import { Hono } from "hono";
import { ai } from "./ai";
import { auth, userFromRequest } from "./auth";
import { HttpError, type HonoEnv } from "./env";
import { meetings } from "./meetings";
import { misc } from "./misc";
import { pages } from "./pages";
import { tasks } from "./tasks";

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
  if (c.req.path.startsWith("/api/auth/")) return next();
  const user = await userFromRequest(c);
  if (!user) return c.json({ error: "Please sign in." }, 401);
  c.set("user", user);
  await next();
});

app.route("/api/pages", pages);
app.route("/api/tasks", tasks);
app.route("/api/meetings", meetings);
app.route("/api/ai", ai);
app.route("/api", misc);

app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof SyntaxError) return c.json({ error: "Malformed request." }, 400);
  console.error("unhandled", c.req.method, c.req.path, err);
  return c.json({ error: "Something went wrong on our side. Please try again." }, 500);
});

export default app;
