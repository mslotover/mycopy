import { Hono } from "hono";
import { ai } from "./ai";
import { auth, userFromRequest } from "./auth";
import { HttpError, type HonoEnv } from "./env";
import { meetings } from "./meetings";
import { misc } from "./misc";
import { pages } from "./pages";
import { STATIC } from "./static.gen";
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

// The front end normally comes from Cloudflare's static-asset store and never reaches this
// code. When it has been packed into the Worker instead (deploy:embedded), serve it here,
// answering unknown paths with the app shell so its own routing can take over.
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

export default app;
