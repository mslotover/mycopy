import { useQuery } from "@tanstack/react-query";
import { CheckCheck, Database, FilePlus, LayoutTemplate, Mic, Plus, Sparkles, Undo2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, invalidate, relTime, todayISO, useMeetings, useTasks, useTree, type Knowledge, type Notification, type Page } from "./api";
import { Toolbar, usePageActions, useShell } from "./App";
import { MeetingRow } from "./Meetings";
import { QuickAdd, TaskGroups, TaskRow, TaskSheet } from "./Tasks";
import { Avatar, AvatarStack, confirmDialog, Dropdown, Empty, MenuItem, PageGlyph, SpaceBadge, Spinner, toastError, useApp } from "./ui";

// ---------- Home ----------

export function Home() {
  const app = useApp();
  const shell = useShell();
  const acts = usePageActions();
  const [openTask, setOpenTask] = useState<string | null>(null);
  const { data: tasks } = useTasks("mine");
  const { data: meetings } = useMeetings();
  const { data: recent } = useQuery({ queryKey: ["recent"], queryFn: () => api<{ pages: (Page & { updated_by: string })[] }>("/recent").then((r) => r.pages) });
  const guest = app.me.role === "guest";

  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const open = (tasks ?? []).filter((t) => t.status !== "done");
  const today = todayISO();
  const focus = [...open].sort((a, b) => (a.due ?? "9999") < (b.due ?? "9999") ? -1 : 1).slice(0, 6);
  const overdue = open.filter((t) => t.due && t.due < today).length;
  const review = (meetings ?? []).filter((m) => m.organizer_id === app.me.id && m.status !== "sent");
  const latest = (meetings ?? []).filter((m) => m.status === "sent").slice(0, 3);

  return (
    <>
      <Toolbar crumbs={<span className="crumb current">Home</span>}>
        {!guest && <button className="btn quiet" onClick={() => shell.openAsk()}><Sparkles />Ask AI</button>}
        {!guest && <button className="btn primary" onClick={() => shell.openNewMeeting()}><Mic />Record</button>}
      </Toolbar>
      <div className="scroll">
        <div className="column wide">
          <div className="view-head" style={{ marginBottom: 26 }}>
            <div className="grow">
              <p className="h-sub" style={{ margin: "0 0 2px" }}>{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
              <h1 className="h-title" style={{ fontSize: 34 }}>{greeting}, {app.me.name.split(" ")[0]}</h1>
            </div>
          </div>

          {review.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-head"><h3>Waiting for you</h3></div>
              <div className="card-body">{review.map((m) => <MeetingRow key={m.id} m={m} />)}</div>
            </div>
          )}

          <div className="grid two">
            <div className="card">
              <div className="card-head"><h3>Your tasks{overdue ? <span style={{ color: "var(--red)", fontWeight: 500 }}> · {overdue} overdue</span> : ""}</h3><Link to="/tasks" className="btn plain" style={{ height: 24 }}>See all</Link></div>
              <div className="card-body">
                {!tasks ? <Spinner /> : focus.length ? focus.map((t) => <TaskRow key={t.id} task={t} onOpen={setOpenTask} showSpace />) : <div className="empty" style={{ padding: 22 }}>Nothing on your list. Enjoy it.</div>}
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h3>Recently updated</h3></div>
              <div className="card-body">
                {!recent ? <Spinner /> : recent.length ? recent.slice(0, 7).map((p) => (
                  <Link key={p.id} to={`/p/${p.id}`} className="row-link">
                    <PageGlyph icon={p.icon} kind={p.kind} />
                    <span className="t">{p.title || "Untitled"}</span>
                    <span className="m">{p.space_id ? app.spaceById.get(p.space_id)?.name : "Private"} · {relTime(p.updated_at)}</span>
                  </Link>
                )) : <div className="empty" style={{ padding: 22 }}>Pages you and your team edit will appear here.</div>}
              </div>
            </div>
          </div>

          {latest.length > 0 && (
            <div className="card" style={{ marginTop: 14 }}>
              <div className="card-head"><h3>Latest meetings</h3><Link to="/meetings" className="btn plain" style={{ height: 24 }}>See all</Link></div>
              <div className="card-body">{latest.map((m) => <MeetingRow key={m.id} m={m} />)}</div>
            </div>
          )}

          {!guest && (
            <>
              <div className="section-title" style={{ margin: "30px 0 10px 2px" }}>Spaces</div>
              <div className="grid three">
                {app.spaces.map((s) => (
                  <Link key={s.id} to={`/space/${s.id}`} className="card" style={{ padding: 16, color: "inherit", textDecoration: "none", display: "flex", gap: 12, alignItems: "center" }}>
                    <SpaceBadge space={s} size={38} />
                    <div style={{ minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 15, letterSpacing: "-0.01em" }}>{s.name}</div><div className="muted" style={{ fontSize: 12.5 }}>{s.member_ids.length} member{s.member_ids.length === 1 ? "" : "s"}</div></div>
                  </Link>
                ))}
                <button className="card inset" style={{ padding: 16, display: "flex", gap: 12, alignItems: "center" }} onClick={() => acts.create({ space_id: null })}>
                  <span className="space-dot" style={{ width: 38, height: 38, background: "var(--fill-2)", color: "var(--text-2)" }}><Plus size={18} /></span>
                  <div><div style={{ fontWeight: 600, fontSize: 15 }}>New private page</div><div className="muted" style={{ fontSize: 12.5 }}>Only you can see it</div></div>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {openTask && <TaskSheet id={openTask} onClose={() => setOpenTask(null)} />}
    </>
  );
}

// ---------- Inbox ----------

export function Inbox() {
  const app = useApp();
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ["notifications"], queryFn: () => api<{ notifications: Notification[] }>("/notifications").then((r) => r.notifications), refetchInterval: 45_000 });
  const read = async (id?: string) => { await api("/notifications/read", { body: id ? { id } : {} }).catch(() => {}); invalidate("notifications", "boot"); };
  const unread = (data ?? []).filter((n) => !n.read).length;
  return (
    <>
      <Toolbar crumbs={<span className="crumb current">Inbox</span>}>
        {unread > 0 && <button className="btn quiet" onClick={() => read()}><CheckCheck />Mark all as read</button>}
      </Toolbar>
      <div className="scroll">
        <div className="column">
          <div className="view-head"><div className="grow"><h1 className="h-title">Inbox</h1><p className="h-sub">{unread ? `${unread} unread` : "You're up to date"}</p></div></div>
          {!data ? <Spinner /> : !data.length ? <Empty icon="📭" title="Nothing yet">Mentions, new tasks, shared pages and meeting summaries arrive here.</Empty> : data.map((n) => (
            <button key={n.id} className={`notif ${n.read ? "read" : ""}`} onClick={() => { if (!n.read) read(n.id); if (n.url) navigate(n.url); }}>
              <span className="unread" />
              <Avatar user={n.actor_id ? app.userById.get(n.actor_id) : null} name={app.appName} color="#0071e3" size={30} />
              <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}><div className="tt">{n.title}</div>{n.body && <div className="bd">{n.body}</div>}</div>
              <span className="tm">{relTime(n.created_at)}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------- A space's overview ----------

export function SpaceView() {
  const { id = "" } = useParams();
  const app = useApp();
  const shell = useShell();
  const acts = usePageActions();
  const space = app.spaceById.get(id);
  const { data: tree } = useTree();
  const { data: tasks } = useTasks(`space:${id}`, !!space);
  const { data: meetings } = useMeetings();
  const { data: notes } = useQuery({ queryKey: ["knowledge"], queryFn: () => api<{ knowledge: Knowledge[] }>("/knowledge").then((r) => r.knowledge) });
  const [openTask, setOpenTask] = useState<string | null>(null);
  if (!space) return (<><Toolbar /><div className="center"><Empty icon="🔒" title="You're not a member of this space" /></div></>);
  const pages = (tree ?? []).filter((n) => n.space_id === id && n.root && !n.is_template);
  const spaceMeetings = (meetings ?? []).filter((m) => m.space_id === id).slice(0, 4);
  const spaceNotes = (notes ?? []).filter((n) => n.space_id === id).slice(0, 4);
  const members = space.member_ids.map((m) => app.userById.get(m)).filter(Boolean) as any[];
  return (
    <>
      <Toolbar crumbs={<span className="crumb current">{space.icon} {space.name}</span>}>
        <button className="btn quiet" onClick={() => shell.openNewMeeting(id)}><Mic />Record</button>
        <Dropdown width={200} placement="bottom-end" trigger={({ onClick }) => <button className="btn primary" onClick={onClick}><Plus />New</button>}>
          {(close) => (<>
            <MenuItem icon={<FilePlus />} onClick={() => { close(); acts.create({ space_id: id }); }}>Page</MenuItem>
            <MenuItem icon={<Database />} onClick={() => { close(); acts.create({ space_id: id, kind: "database" }); }}>Database</MenuItem>
            <MenuItem icon={<LayoutTemplate />} onClick={() => { close(); shell.pickTemplate({ space_id: id }); }}>From a template…</MenuItem>
          </>)}
        </Dropdown>
      </Toolbar>
      <div className="scroll">
        <div className="column wide">
          <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 26 }}>
            <SpaceBadge space={space} size={56} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 className="h-title">{space.name}</h1>
              {space.description && <p className="h-sub">{space.description}</p>}
            </div>
            <AvatarStack users={members} max={6} size={28} />
          </div>
          <div className="grid two">
            <div className="card">
              <div className="card-head"><h3>Pages</h3></div>
              <div className="card-body">
                {pages.length ? pages.map((p) => <Link key={p.id} to={`/p/${p.id}`} className="row-link"><PageGlyph icon={p.icon} kind={p.kind} /><span className="t" style={{ fontWeight: 500 }}>{p.title || "Untitled"}</span></Link>) : <div className="empty" style={{ padding: 22 }}>No pages yet</div>}
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h3>Open tasks</h3></div>
              <div className="card-body">
                <div style={{ padding: "0 4px" }}><QuickAdd defaults={{ space_id: id }} placeholder={`New task in ${space.name}`} /></div>
                {!tasks ? <Spinner /> : <TaskGroups tasks={tasks} onOpen={setOpenTask} showAssignee />}
              </div>
            </div>
          </div>
          {spaceMeetings.length > 0 && (
            <div className="card" style={{ marginTop: 14 }}>
              <div className="card-head"><h3>Meetings</h3><Link to="/meetings" className="btn plain" style={{ height: 24 }}>See all</Link></div>
              <div className="card-body">{spaceMeetings.map((m) => <MeetingRow key={m.id} m={m} />)}</div>
            </div>
          )}
          {spaceNotes.length > 0 && (
            <>
              <div className="section-title" style={{ margin: "28px 0 10px 2px" }}>From the Brain</div>
              <div className="grid two">{spaceNotes.map((n) => <Link key={n.id} to={`/brain?open=${n.id}`} className="note" style={{ color: "inherit", textDecoration: "none" }}><span className="chip" style={{ alignSelf: "flex-start" }}>{n.kind}</span><h4>{n.title}</h4><p style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{n.body}</p></Link>)}</div>
            </>
          )}
        </div>
      </div>
      {openTask && <TaskSheet id={openTask} onClose={() => setOpenTask(null)} />}
    </>
  );
}

// ---------- Trash ----------

export function Trash() {
  const app = useApp();
  const { data, refetch } = useQuery({ queryKey: ["trash"], queryFn: () => api<{ pages: Page[] }>("/pages/trash").then((r) => r.pages), staleTime: 0 });
  const restore = async (id: string) => { try { await api(`/pages/${id}/restore`, { body: {} }); invalidate("tree"); refetch(); } catch (e) { toastError(e); } };
  const destroy = async (p: Page) => {
    if (!(await confirmDialog({ title: `Delete “${p.title || "Untitled"}” for good?`, body: "The page and everything inside it will be permanently deleted. This can't be undone.", action: "Delete forever", danger: true }))) return;
    try { await api(`/pages/${p.id}?permanent=1`, { method: "DELETE" }); refetch(); } catch (e) { toastError(e); }
  };
  return (
    <>
      <Toolbar crumbs={<span className="crumb current">Trash</span>} />
      <div className="scroll">
        <div className="column">
          <div className="view-head"><div className="grow"><h1 className="h-title">Trash</h1><p className="h-sub">Deleted pages stay here until you remove them for good.</p></div></div>
          {!data ? <Spinner /> : !data.length ? <Empty icon="🗑️" title="The trash is empty" /> : data.map((p) => (
            <div key={p.id} className="row-link" style={{ cursor: "default" }}>
              <PageGlyph icon={p.icon} kind={p.kind} />
              <Link to={`/p/${p.id}`} className="t" style={{ color: "inherit" }}>{p.title || "Untitled"}</Link>
              <span className="m">{p.space_id ? app.spaceById.get(p.space_id)?.name : "Private"} · {relTime(p.updated_at)}</span>
              <button className="btn" style={{ height: 26 }} onClick={() => restore(p.id)}><Undo2 />Restore</button>
              <button className="btn quiet danger" style={{ height: 26 }} onClick={() => destroy(p)}>Delete forever</button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
