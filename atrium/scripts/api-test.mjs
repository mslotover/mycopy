// End-to-end API checks against a local dev server (npm run dev) with a freshly migrated database.
// Usage: node scripts/api-test.mjs [baseUrl]
const BASE = (process.argv[2] ?? "http://localhost:8787") + "/api";
let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
};

function client() {
  let cookie = "";
  const call = async (method, path, body, raw) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body && !raw ? { "Content-Type": "application/json" } : raw ? { "Content-Type": "audio/webm" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { text }; }
    return { status: res.status, ...json };
  };
  return {
    get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), patch: (p, b) => call("PATCH", p, b),
    put: (p, b) => call("PUT", p, b), del: (p) => call("DELETE", p), raw: (p, bytes) => call("PUT", p, bytes, true),
    async login(email) {
      const r = await call("POST", "/auth/request", { email });
      const token = r.devLink?.split("token=")[1];
      return call("POST", "/auth/verify", { token });
    },
  };
}

const owner = client(), sam = client(), guest = client();
const invite = async (email, name, role, space_ids) => (await owner.post("/admin/users", { email, name, role, space_ids })).id;

console.log("auth");
check("unauthenticated is rejected", (await client().get("/bootstrap")).status === 401);
check("unknown email gets no link", !(await client().post("/auth/request", { email: "nobody@example.com" })).devLink);
check("owner signs in", (await owner.login("owner@example.com")).ok);
const boot = await owner.get("/bootstrap");
const [s1, s2] = [boot.spaces.find((s) => s.name === "Restaurant").id, boot.spaces.find((s) => s.name === "Bakery").id];
const samId = boot.users.find((u) => u.email === "sam@example.com").id;
const guestId = boot.users.find((u) => u.email === "guest@example.com").id;
const ownerId = boot.user.id;
await sam.login("sam@example.com");
await guest.login("guest@example.com");
check("member sees only their spaces", (await sam.get("/bootstrap")).spaces.map((s) => s.id).join() === s1);
check("guest sees no spaces", (await guest.get("/bootstrap")).spaces.length === 0);

console.log("pages and permissions");
const doc = (t) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });
const p1 = (await owner.post("/pages", { space_id: s1, title: "Opening checklist", content: doc("Check the walk-in fridge temperature") })).page;
check("page created in space", p1?.space_id === s1);
check("space member can read", (await sam.get(`/pages/${p1.id}`)).level === "edit");
check("guest cannot read space page", (await guest.get(`/pages/${p1.id}`)).status === 403);
const p2 = (await owner.post("/pages", { space_id: s2, title: "Sourdough schedule", content: doc("Levain feed at 6am") })).page;
check("non-member cannot read other space", (await sam.get(`/pages/${p2.id}`)).status === 403);
check("non-member cannot create in other space", (await sam.post("/pages", { space_id: s2, title: "x" })).status === 403);
const priv = (await owner.post("/pages", { title: "Private notes", content: doc("Fundraising thoughts zanzibar") })).page;
check("private page has no space", priv.space_id === null);
check("others cannot read a private page", (await sam.get(`/pages/${priv.id}`)).status === 403);
const child = (await owner.post("/pages", { parent_id: priv.id, title: "Child" })).page;
check("share requires a real level", (await owner.put(`/pages/${priv.id}/shares/${guestId}`, { level: "root" })).status === 400);
await owner.put(`/pages/${priv.id}/shares/${guestId}`, { level: "view" });
check("guest can view shared page", (await guest.get(`/pages/${priv.id}`)).level === "view");
check("share covers subpages", (await guest.get(`/pages/${child.id}`)).level === "view");
check("view-only cannot edit", (await guest.patch(`/pages/${priv.id}`, { title: "hacked" })).status === 403);
check("view-only cannot share onward", (await guest.put(`/pages/${priv.id}/shares/${samId}`, { level: "edit" })).status === 403);
const gTree = (await guest.get("/pages/tree")).pages;
check("guest tree shows only shared pages", gTree.length === 2 && gTree.every((p) => p.section === "shared"), JSON.stringify(gTree.map((p) => p.title)));
check("guest got a share notification", (await guest.get("/notifications")).notifications.some((n) => n.type === "share"));
await owner.del(`/pages/${priv.id}/shares/${guestId}`);
check("unsharing removes access", (await guest.get(`/pages/${priv.id}`)).status === 403);

console.log("editing, versions, trash");
await owner.patch(`/pages/${p1.id}`, { content: doc("Check the walk-in fridge temperature and log it") });
const vs = (await owner.get(`/pages/${p1.id}/versions`)).versions;
check("an edit keeps the previous version", vs.length === 1);
await owner.post(`/pages/${p1.id}/versions/${vs[0].id}/restore`);
check("restore brings old content back", JSON.stringify((await owner.get(`/pages/${p1.id}`)).page.content).endsWith('temperature"}]}]}'));
check("cannot move a page inside itself", (await owner.patch(`/pages/${priv.id}`, { parent_id: child.id })).status === 400);
await owner.del(`/pages/${p1.id}`);
check("deleted page leaves the tree", !(await owner.get("/pages/tree")).pages.some((p) => p.id === p1.id));
check("deleted page is in the trash", (await owner.get("/pages/trash")).pages.some((p) => p.id === p1.id));
await owner.post(`/pages/${p1.id}/restore`);
check("restored page is back", (await owner.get("/pages/tree")).pages.some((p) => p.id === p1.id));

console.log("databases");
const db = (await owner.post("/pages", { space_id: s1, title: "Suppliers", kind: "database" })).page;
const statusProp = db.schema.props.find((p) => p.type === "status");
const row = (await owner.post("/pages", { parent_id: db.id, kind: "row", title: "Natoora", props: { [statusProp.id]: statusProp.options[0].id } })).page;
await sam.patch(`/pages/${row.id}`, { props: { [statusProp.id]: statusProp.options[2].id } });
const dbGet = await owner.get(`/pages/${db.id}`);
check("database returns its rows", dbGet.rows.length === 1 && dbGet.rows[0].props[statusProp.id] === statusProp.options[2].id);
check("rows stay out of the sidebar tree", !(await owner.get("/pages/tree")).pages.some((p) => p.id === row.id));

console.log("tasks");
const t1 = (await owner.post("/tasks", { title: "Order new aprons", assignee_id: samId, space_id: s1, due: "2026-12-01" })).task;
check("assignee sees task in their list", (await sam.get("/tasks?scope=mine")).tasks.some((t) => t.id === t1.id));
check("assignee was notified", (await sam.get("/notifications")).notifications.some((n) => n.type === "task"));
const t2 = (await owner.post("/tasks", { title: "Personal: renew passport" })).task;
check("private task hidden from others", !(await sam.get("/tasks?scope=all")).tasks.some((t) => t.id === t2.id));
check("stranger cannot edit a private task", (await sam.patch(`/tasks/${t2.id}`, { status: "done" })).status === 403);
check("guest cannot see space tasks", (await guest.get("/tasks?scope=all")).tasks.length === 0);
check("assignee can tick it off", (await sam.patch(`/tasks/${t1.id}`, { status: "done" })).task.status === "done");
check("creator hears it is done", (await owner.get("/notifications")).notifications.some((n) => n.type === "task_done"));
check("empty title rejected", (await owner.post("/tasks", { title: "  " })).status === 400);

console.log("comments");
check("member can comment", !!(await sam.post("/comments", { kind: "page", id: p1.id, body: "Looks good", mentions: [ownerId] })).id);
check("guest cannot read comments on a hidden page", (await guest.get(`/comments?kind=page&id=${p1.id}`)).status === 403);
check("mention notifies", (await owner.get("/notifications")).notifications.some((n) => n.type === "mention"));

console.log("meetings");
const mid = (await owner.post("/meetings", { title: "Weekly ops", space_id: s1, participants: [{ user_id: samId }, { name: "Dana Supplier", email: "dana@supplier.example" }] })).id;
check("meeting created", !!mid);
check("others cannot upload audio", (await sam.raw(`/meetings/${mid}/segments/0`, new Uint8Array(2000))).status === 403);
check("segment upload", (await owner.raw(`/meetings/${mid}/segments/0`, new Uint8Array(2000))).ok);
check("second segment upload", (await owner.raw(`/meetings/${mid}/segments/1`, new Uint8Array(3000))).ok);
await owner.post(`/meetings/${mid}/finish`, { duration_s: 125 });
check("participant cannot see it before it is sent", (await sam.get(`/meetings/${mid}`)).status === 403);
const proc = await owner.post(`/meetings/${mid}/process`);
check("processing finishes", proc.text?.includes("event: done"), proc.text?.slice(0, 300));
const review = await owner.get(`/meetings/${mid}`);
check("ready for review with proposed tasks", review.meeting.status === "review" && review.items.filter((i) => i.kind === "task").length === 3);
check("unclear owner is flagged", review.items.some((i) => i.kind === "task" && i.payload.needs_owner));
const drop = review.items.find((i) => i.kind === "task" && i.payload.needs_owner);
await owner.patch(`/meetings/${mid}/items/${drop.id}`, { accepted: false });
check("only the organiser can send", (await sam.post(`/meetings/${mid}/send`)).status === 403);
const sent = await owner.post(`/meetings/${mid}/send`);
check("send creates only accepted tasks", sent.tasks === 2 && sent.emails === 3, JSON.stringify(sent));
check("sending twice is refused", (await owner.post(`/meetings/${mid}/send`)).status === 400);
check("participant sees the sent meeting", (await sam.get(`/meetings/${mid}`)).meeting?.status === "sent");
check("participant does not see the review queue", (await sam.get(`/meetings/${mid}`)).items.length === 0);
check("meeting tasks land on the owner's list", (await sam.get("/tasks?scope=mine")).tasks.some((t) => t.meeting_id === mid));
check("knowledge note filed", (await sam.get("/knowledge")).knowledge.some((k) => k.meeting_id === mid));
const outbox = (await owner.get("/admin/outbox")).outbox;
check("summary emailed to external participant", outbox.some((o) => o.to_email === "dana@supplier.example"));
check("outbox is admin-only", (await sam.get("/admin/outbox")).status === 403);

console.log("search");
const hit = (c, q) => c.get(`/search?q=${encodeURIComponent(q)}`).then((r) => r.results);
check("finds page text", (await hit(owner, "fridge")).some((r) => r.id === p1.id));
check("private content hidden from others", (await hit(sam, "zanzibar")).length === 0 && (await hit(owner, "zanzibar")).length === 1);
check("other space hidden", (await hit(sam, "levain")).length === 0);
check("finds meetings", (await hit(sam, "Tuesday")).some((r) => r.kind === "meeting" || r.kind === "knowledge"));
check("finds tasks", (await hit(sam, "aprons")).some((r) => r.kind === "task"));
check("odd query syntax is safe", Array.isArray(await hit(owner, '"AND ( NEAR *')));

console.log("people");
check("members cannot add members", (await sam.post("/admin/users", { email: "x@example.com", role: "member" })).status === 403);
check("members can invite a guest", !!(await sam.post("/admin/users", { email: "designer@example.com", name: "Des", role: "guest" })).id);
check("guests cannot invite", (await guest.post("/admin/users", { email: "y@example.com", role: "guest" })).status === 403);
const newId = await invite("new@example.com", "New Person", "member", [s2]);
const np = client(); await np.login("new@example.com");
check("invited member lands in chosen space", (await np.get("/bootstrap")).spaces.map((s) => s.id).join() === s2);
await owner.patch(`/admin/users/${newId}`, { active: false });
check("deactivated user is signed out", (await np.get("/bootstrap")).status === 401);
check("owner role is protected", (await owner.patch(`/admin/users/${ownerId}`, { role: "guest" })).status === 400);

console.log("ask");
const ask = await sam.post("/ai/ask", { messages: [{ role: "user", content: "aprons" }] });
check("ask streams an answer", ask.text?.includes("event: done") && ask.text.includes("aprons"));

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
