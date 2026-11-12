// Fills a local dev database with sample content (fictional), for trying the app out and for screenshots.
// Usage: npm run dev (in another terminal), then: node scripts/seed-demo.mjs
import { execSync } from "node:child_process";

const BASE = (process.argv[2] ?? "http://localhost:8787") + "/api";
const sql = (s) => execSync(`npx wrangler d1 execute atrium --local -c wrangler.dev.jsonc --command "${s.replace(/"/g, '\\"')}"`, { stdio: "pipe" });

sql(`INSERT OR IGNORE INTO users (id,email,name,color,role,created_at) VALUES
 ('demo-alex','alex@example.com','Alex Morgan','#0071e3','owner',0),
 ('demo-priya','priya@example.com','Priya Shah','#34c759','member',0),
 ('demo-tom','tom@example.com','Tom Okafor','#ff9500','member',0),
 ('demo-lena','lena@example.com','Lena Fischer','#af52de','member',0);
INSERT OR IGNORE INTO spaces (id,name,icon,color,description,sort,created_at) VALUES
 ('demo-rest','Harbour Restaurant','🍽️','#0071e3','Front of house, kitchen and bookings',1,0),
 ('demo-bake','Mill Lane Bakery','🥐','#ff9500','Production, wholesale and the shop',2,0),
 ('demo-choc','Chocolate Workshop','🍫','#a2845e','Bean-to-bar production and the opening',3,0);
INSERT OR IGNORE INTO space_members VALUES ('demo-rest','demo-alex'),('demo-rest','demo-priya'),('demo-bake','demo-alex'),('demo-bake','demo-tom'),('demo-choc','demo-alex'),('demo-choc','demo-lena'),('demo-choc','demo-tom');`);

let cookie = "";
const call = async (method, path, body) => {
  const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { text }; }
};
const post = (p, b) => call("POST", p, b ?? {});
const link = await post("/auth/request", { email: "alex@example.com" });
await post("/auth/verify", { token: link.devLink.split("token=")[1] });

const html = (h) => ({ html: h });
const page = (b) => post("/pages", b).then((r) => r.page);
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const hb = await page({ space_id: "demo-bake", title: "Bakery handbook", icon: "📖", content: html(`<div data-callout data-emoji="📍"><div><p>How we run Mill Lane, in one place. If you are explaining the same thing twice, write it down here.</p></div></div><h2>Daily rhythm</h2><p>The first bake goes in at <strong>4:30am</strong>. Doors open at 7:30. Wholesale orders leave by 6:45 so the van is back before the morning rush.</p><h2>Opening checklist</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Ovens on and at temperature</p></li><li data-type="taskItem" data-checked="true"><p>Levain fed and logged</p></li><li data-type="taskItem" data-checked="false"><p>Display case stocked, labels straight</p></li><li data-type="taskItem" data-checked="false"><p>Card reader and till float checked</p></li></ul><h2>Who to ask</h2><table><tbody><tr><th><p>Topic</p></th><th><p>Person</p></th></tr><tr><td><p>Wholesale accounts</p></td><td><p>Tom</p></td></tr><tr><td><p>Rota and holidays</p></td><td><p>Alex</p></td></tr></tbody></table>`) });
await page({ parent_id: hb.id, title: "Sourdough schedule", icon: "🍞", content: html("<p>Feed the levain at 6am and 6pm. Mix at 2pm, shape at 6pm, cold prove overnight, bake from 4:30am.</p>") });
await page({ parent_id: hb.id, title: "Allergen matrix", icon: "⚠️", content: html("<p>Updated whenever a recipe changes. Print a fresh copy for the counter.</p>") });
await page({ space_id: "demo-bake", title: "Wholesale price list", icon: "🧾", content: html("<p>Prices from 1 November. Minimum order 12 loaves.</p>") });
await page({ space_id: "demo-rest", title: "Service guide", icon: "🍷", content: html("<h2>The first two minutes</h2><p>Greet within thirty seconds, water on the table within two minutes.</p>") });
await page({ space_id: "demo-choc", title: "Opening plan", icon: "🚀", content: html("<p>Everything between now and opening day.</p>") });
await page({ title: "Scratchpad", icon: "✏️", content: html("<p>Ideas for the spring menu. Call the bank about the overdraft. Book the engineer for the mixer.</p>") });

const db = await page({ space_id: "demo-choc", title: "Suppliers", icon: "📦", kind: "database" });
const st = db.schema.props.find((p) => p.type === "status");
const owner = db.schema.props.find((p) => p.type === "person");
const date = db.schema.props.find((p) => p.type === "date");
const rows = [["Cacao farm co-operative", 2, "demo-lena", 3], ["Packaging printer", 1, "demo-tom", 9], ["Dairy", 1, "demo-alex", 14], ["Tempering machine service", 0, "demo-lena", 21], ["Label designer", 0, "demo-tom", null]];
for (const [title, s, who, d] of rows) await page({ parent_id: db.id, kind: "row", title, props: { [st.id]: st.options[s].id, [owner.id]: [who], ...(d ? { [date.id]: day(d) } : {}) } });

const task = (b) => post("/tasks", b);
await task({ title: "Sign off the winter menu", space_id: "demo-rest", due: day(-1) });
await task({ title: "Order replacement oven seals", space_id: "demo-bake", due: day(0) });
await task({ title: "Reply to the landlord about the lease", due: day(2) });
await task({ title: "Review the packaging proofs", space_id: "demo-choc", due: day(4) });
await task({ title: "Book fire safety training", space_id: "demo-rest" });
await task({ title: "Send wholesale price list to new cafés", space_id: "demo-bake", assignee_id: "demo-tom", due: day(1) });
await task({ title: "Confirm bean delivery date", space_id: "demo-choc", assignee_id: "demo-lena", due: day(6) });
const done = await task({ title: "Renew the food hygiene certificate", space_id: "demo-bake" });
await call("PATCH", `/tasks/${done.task.id}`, { status: "done" });

await post("/knowledge", { kind: "decision", space_id: "demo-bake", title: "Wholesale minimum order is 12 loaves", body: "Agreed with Tom on 3 November. Smaller orders cost more to deliver than they earn. Existing cafés keep their current terms until January." });
await post("/knowledge", { kind: "fact", space_id: "demo-choc", title: "Tempering machine holds 15 kg", body: "The larger machine holds 15 kg and the smaller 20 kg per batch. A full changeover between dark and milk takes about 40 minutes." });
await post("/knowledge", { kind: "contact", space_id: "demo-rest", title: "Wine supplier rep is Marta", body: "Marta visits on the first Tuesday of the month. She can do sale-or-return on cases for private events with two weeks' notice." });

// One finished meeting and one waiting for review.
for (const [title, space, send] of [["Weekly bakery meeting", "demo-bake", true], ["Opening countdown", "demo-choc", false]]) {
  const { id } = await post("/meetings", { title, space_id: space, participants: [{ user_id: space === "demo-bake" ? "demo-tom" : "demo-lena" }, { name: "Dana Reyes", email: "dana@supplier.example" }] });
  await fetch(`${BASE}/meetings/${id}/segments/0`, { method: "PUT", headers: { "Content-Type": "audio/webm", Cookie: cookie }, body: new Uint8Array(4000) });
  await post(`/meetings/${id}/finish`, { duration_s: 1860 });
  await post(`/meetings/${id}/process`);
  if (send) await post(`/meetings/${id}/send`);
}
console.log("Seeded. Sign in as alex@example.com at", BASE.replace("/api", ""));
