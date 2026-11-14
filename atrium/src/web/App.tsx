import {
  Brain as BrainIcon, CheckCircle2, ChevronRight, Copy, Database, FilePlus, FolderInput, Home as HomeIcon, Inbox as InboxIcon, LayoutTemplate, LogOut,
  Menu, Mic, MoreHorizontal, Plus, Search, Settings as SettingsIcon, Sparkles, Trash2,
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, invalidate, useBoot, useTree, type TreeNode } from "./api";
import { AskPanel } from "./Ask";
import { Brain } from "./Brain";
import { Home, Inbox, SpaceView, Trash } from "./Home";
import { MeetingView, MeetingsView, NewMeetingSheet } from "./Meetings";
import { PageView } from "./PageView";
import { forgetDevice } from "./phone";
import { SearchPalette } from "./Search";
import { Settings } from "./Settings";
import { SignIn } from "./SignIn";
import { TasksView } from "./Tasks";
import { BUILTIN_TEMPLATES } from "./templates";
import { AppProvider, Avatar, Dropdown, MenuItem, Overlays, PageGlyph, Sheet, SpaceBadge, Spinner, toast, toastError, useApp } from "./ui";

// ---------- Shell context: things any screen can open ----------

type Shell = {
  openSearch: () => void; openAsk: (q?: string) => void; openNewMeeting: (spaceId?: string | null) => void;
  openSidebar: () => void; pickTemplate: (dest: { space_id?: string | null; parent_id?: string | null }) => void; movePage: (id: string) => void;
};
const ShellCtx = createContext<Shell>(null!);
export const useShell = () => useContext(ShellCtx);

/** Toolbar shared by every screen: sidebar toggle on small screens, breadcrumbs, actions on the right. */
export function Toolbar({ crumbs, children }: { crumbs?: ReactNode; children?: ReactNode }) {
  const shell = useShell();
  return (
    <div className="toolbar">
      <button className="icon-btn menu-btn" onClick={shell.openSidebar} aria-label="Open sidebar"><Menu /></button>
      <div className="crumbs">{crumbs}</div>
      {children}
    </div>
  );
}

// ---------- Page actions used from the sidebar and the page itself ----------

export function usePageActions() {
  const navigate = useNavigate();
  return {
    async create(dest: { space_id?: string | null; parent_id?: string | null; kind?: "page" | "database"; template_id?: string; title?: string; icon?: string; content?: unknown }) {
      try {
        const { page } = await api("/pages", { body: dest });
        invalidate("tree", "page");
        navigate(`/p/${page.id}`);
        return page;
      } catch (e) { toastError(e); }
    },
    async remove(id: string, title: string, after?: () => void) {
      try {
        await api(`/pages/${id}`, { method: "DELETE" });
        invalidate("tree", "page", "trash");
        after?.();
        toast(`Moved “${title || "Untitled"}” to the trash`, { action: { label: "Undo", run: async () => { await api(`/pages/${id}/restore`, { body: {} }); invalidate("tree", "page", "trash"); } } });
      } catch (e) { toastError(e); }
    },
    async duplicate(id: string, asTemplate = false) {
      try {
        const { page } = await api(`/pages/${id}/duplicate`, { body: { as_template: asTemplate } });
        invalidate("tree");
        if (asTemplate) toast("Saved as a template");
        else navigate(`/p/${page.id}`);
      } catch (e) { toastError(e); }
    },
  };
}

function PageMenu({ node, close }: { node: TreeNode; close: () => void }) {
  const acts = usePageActions();
  const shell = useShell();
  const loc = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <MenuItem icon={<FilePlus />} onClick={() => { close(); acts.create({ parent_id: node.id }); }}>Add a page inside</MenuItem>
      <MenuItem icon={<Copy />} onClick={() => { close(); acts.duplicate(node.id); }}>Duplicate</MenuItem>
      <MenuItem icon={<FolderInput />} onClick={() => { close(); shell.movePage(node.id); }}>Move to…</MenuItem>
      <MenuItem icon={<LayoutTemplate />} onClick={() => { close(); acts.duplicate(node.id, true); }}>Save as template</MenuItem>
      <div className="menu-sep" />
      <MenuItem icon={<Trash2 />} danger onClick={() => { close(); acts.remove(node.id, node.title, () => { if (loc.pathname === `/p/${node.id}`) navigate("/"); }); }}>Delete</MenuItem>
    </>
  );
}

// ---------- Sidebar ----------

const EXPANDED_KEY = "atrium.expanded";
function useExpanded() {
  const [set, setSet] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]")); } catch { return new Set(); }
  });
  const save = (s: Set<string>) => { setSet(s); localStorage.setItem(EXPANDED_KEY, JSON.stringify([...s].slice(-400))); };
  return {
    has: (id: string) => set.has(id),
    toggle: (id: string) => { const s = new Set(set); s.has(id) ? s.delete(id) : s.add(id); save(s); },
    open: (ids: string[]) => { if (ids.some((i) => !set.has(i))) save(new Set([...set, ...ids])); },
  };
}

function TreeRows({ nodes, kids, depth, exp, activeId }: { nodes: TreeNode[]; kids: Map<string, TreeNode[]>; depth: number; exp: ReturnType<typeof useExpanded>; activeId?: string }) {
  const acts = usePageActions();
  return (
    <>
      {nodes.map((n) => {
        const children = kids.get(n.id) ?? [];
        const open = exp.has(n.id);
        return (
          <div key={n.id}>
            <Link to={`/p/${n.id}`} className={`tree-row ${activeId === n.id ? "active" : ""}`} style={{ paddingLeft: 4 + depth * 14 }}>
              <button className={`twist ${open ? "open" : ""} ${children.length ? "" : "leaf"}`} aria-label={open ? "Collapse" : "Expand"} onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (children.length) exp.toggle(n.id); }}>
                <ChevronRight />
              </button>
              <PageGlyph icon={n.icon} kind={n.kind} />
              <span className={`label ${n.title ? "" : "untitled"}`}>{n.title || "Untitled"}</span>
              <span className="acts">
                <Dropdown width={220} trigger={({ onClick }) => <button className="icon-btn sm" aria-label="Page options" onClick={onClick}><MoreHorizontal /></button>}>
                  {(close) => <PageMenu node={n} close={close} />}
                </Dropdown>
                {n.kind === "page" && n.section !== "shared" && (
                  <button className="icon-btn sm" aria-label="Add a page inside" onClick={(e) => { e.preventDefault(); e.stopPropagation(); exp.open([n.id]); acts.create({ parent_id: n.id }); }}><Plus /></button>
                )}
              </span>
            </Link>
            {open && children.length > 0 && <TreeRows nodes={children} kids={kids} depth={depth + 1} exp={exp} activeId={activeId} />}
          </div>
        );
      })}
    </>
  );
}

function AddMenu({ dest, close }: { dest: { space_id?: string | null; parent_id?: string | null }; close: () => void }) {
  const acts = usePageActions();
  const shell = useShell();
  return (
    <>
      <MenuItem icon={<FilePlus />} onClick={() => { close(); acts.create(dest); }}>Page</MenuItem>
      <MenuItem icon={<Database />} onClick={() => { close(); acts.create({ ...dest, kind: "database" }); }}>Database</MenuItem>
      <MenuItem icon={<LayoutTemplate />} onClick={() => { close(); shell.pickTemplate(dest); }}>From a template…</MenuItem>
    </>
  );
}

function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const app = useApp();
  const shell = useShell();
  const loc = useLocation();
  const navigate = useNavigate();
  const { data: tree } = useTree();
  const exp = useExpanded();
  const activeId = loc.pathname.startsWith("/p/") ? loc.pathname.slice(3) : undefined;

  const { kids, bySpace, priv, shared } = useMemo(() => {
    const nodes = (tree ?? []).filter((n) => !n.is_template);
    const kids = new Map<string, TreeNode[]>();
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of nodes) if (n.parent_id && ids.has(n.parent_id)) kids.set(n.parent_id, [...(kids.get(n.parent_id) ?? []), n]);
    const roots = nodes.filter((n) => !n.parent_id || !ids.has(n.parent_id));
    const bySpace = new Map<string, TreeNode[]>();
    for (const n of roots.filter((r) => r.section === "space")) bySpace.set(n.space_id!, [...(bySpace.get(n.space_id!) ?? []), n]);
    return { kids, bySpace, priv: roots.filter((r) => r.section === "private"), shared: roots.filter((r) => r.section === "shared") };
  }, [tree]);

  // Reveal the open page in the tree.
  useEffect(() => {
    if (!activeId || !tree) return;
    const byId = new Map(tree.map((n) => [n.id, n]));
    const chain: string[] = [];
    let cur = byId.get(activeId);
    if (cur?.space_id && cur.section === "space") chain.push("space:" + cur.space_id);
    while (cur?.parent_id) { chain.push(cur.parent_id); cur = byId.get(cur.parent_id); }
    if (chain.length) exp.open(chain);
  }, [activeId, tree]);

  const signOut = async () => { await api("/auth/logout", { body: {} }); forgetDevice(); location.assign("/signin"); };
  const nav = (to: string, icon: ReactNode, label: string, count?: ReactNode) => (
    <NavLink to={to} end={to === "/"} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>{icon}{label}{count}</NavLink>
  );

  return (
    <aside className={`sidebar ${open ? "open" : ""}`} onClick={(e) => { if ((e.target as HTMLElement).closest("a")) onNavigate(); }}>
      <div className="side-head">
        <Link to="/" className="brand" style={{ textDecoration: "none", color: "inherit" }}>
          <span className="brand-mark">{app.appName[0]}</span>
          <span className="brand-name">{app.appName}</span>
        </Link>
        {app.me.role !== "guest" && (
          <Dropdown width={210} placement="bottom-end" trigger={({ onClick }) => <button className="icon-btn" aria-label="New" onClick={onClick}><Plus /></button>}>
            {(close) => (
              <>
                <div className="menu-title">New private page</div>
                <AddMenu dest={{ space_id: null }} close={close} />
              </>
            )}
          </Dropdown>
        )}
      </div>
      <button className="side-search" onClick={() => { shell.openSearch(); onNavigate(); }}><Search size={14} />Search<kbd>⌘K</kbd></button>
      <div className="side-scroll">
        {nav("/", <HomeIcon />, "Home")}
        {nav("/inbox", <InboxIcon />, "Inbox", app.unread ? <span className="count hot">{app.unread}</span> : null)}
        {nav("/tasks", <CheckCircle2 />, "My tasks")}
        {app.me.role !== "guest" && nav("/meetings", <Mic />, "Meetings")}
        {app.me.role !== "guest" && nav("/brain", <BrainIcon />, "Brain")}
        <button className="nav-item" onClick={() => { shell.openAsk(); onNavigate(); }}><Sparkles />Ask AI</button>

        {app.spaces.length > 0 && <div className="side-label">Spaces</div>}
        {app.spaces.map((s) => {
          const key = "space:" + s.id;
          const open = exp.has(key);
          const roots = bySpace.get(s.id) ?? [];
          return (
            <div key={s.id}>
              <Link to={`/space/${s.id}`} className={`tree-row space-row ${loc.pathname === `/space/${s.id}` ? "active" : ""}`} style={{ paddingLeft: 4 }}>
                <button className={`twist ${open ? "open" : ""}`} aria-label={open ? "Collapse" : "Expand"} onClick={(e) => { e.preventDefault(); e.stopPropagation(); exp.toggle(key); }}><ChevronRight /></button>
                <SpaceBadge space={s} />
                <span className="label" style={{ paddingLeft: 6 }}>{s.name}</span>
                <span className="acts">
                  <Dropdown width={200} trigger={({ onClick }) => <button className="icon-btn sm" aria-label={`Add to ${s.name}`} onClick={onClick}><Plus /></button>}>
                    {(close) => <AddMenu dest={{ space_id: s.id }} close={() => { close(); exp.open([key]); }} />}
                  </Dropdown>
                </span>
              </Link>
              {open && (roots.length ? <TreeRows nodes={roots} kids={kids} depth={1} exp={exp} activeId={activeId} /> : <div className="tree-empty">No pages yet</div>)}
            </div>
          );
        })}

        {shared.length > 0 && (
          <>
            <div className="side-label">Shared with me</div>
            <TreeRows nodes={shared} kids={kids} depth={0} exp={exp} activeId={activeId} />
          </>
        )}

        {app.me.role !== "guest" && (
          <>
            <div className="side-label">Private</div>
            <TreeRows nodes={priv} kids={kids} depth={0} exp={exp} activeId={activeId} />
            {!priv.length && <div className="tree-empty" style={{ paddingLeft: 12 }}>Pages only you can see</div>}
          </>
        )}

        <div style={{ height: 14 }} />
        {nav("/trash", <Trash2 />, "Trash")}
        {nav("/settings", <SettingsIcon />, "Settings")}
      </div>
      <div className="side-foot">
        {app.me.role !== "guest" && <button className="record-btn" onClick={() => { shell.openNewMeeting(); onNavigate(); }}><i />Record a meeting</button>}
        <Dropdown width={230} placement="top-start" trigger={({ onClick }) => (
          <button className="me-row" onClick={onClick}><Avatar user={app.me} size={24} /><span className="name">{app.me.name}</span></button>
        )}>
          {(close) => (
            <>
              <div className="menu-title">{app.me.email}</div>
              <MenuItem icon={<SettingsIcon />} onClick={() => { close(); navigate("/settings"); }}>Settings</MenuItem>
              <MenuItem icon={<LogOut />} onClick={signOut}>Sign out</MenuItem>
            </>
          )}
        </Dropdown>
      </div>
    </aside>
  );
}

// ---------- Template and move sheets ----------

function TemplateSheet({ dest, onClose }: { dest: { space_id?: string | null; parent_id?: string | null }; onClose: () => void }) {
  const acts = usePageActions();
  const { data: tree } = useTree();
  const saved = (tree ?? []).filter((n) => n.is_template);
  return (
    <Sheet title="Start from a template" onClose={onClose} wide>
      <div className="grid three" style={{ paddingBottom: 14 }}>
        {BUILTIN_TEMPLATES.map((t) => (
          <button key={t.key} className="card inset" style={{ padding: 14, textAlign: "left" }} onClick={() => { onClose(); acts.create({ ...dest, title: t.title, icon: t.icon, content: { html: t.html } }); }}>
            <div style={{ fontSize: 26 }}>{t.icon}</div>
            <div style={{ fontWeight: 600, marginTop: 6 }}>{t.title}</div>
            <div className="sec" style={{ fontSize: 12.5 }}>{t.blurb}</div>
          </button>
        ))}
      </div>
      {saved.length > 0 && (
        <>
          <div className="section-title">Saved by your team</div>
          {saved.map((t) => (
            <button key={t.id} className="row-link" onClick={() => { onClose(); acts.create({ ...dest, template_id: t.id }); }}>
              <PageGlyph icon={t.icon} kind={t.kind} /><span className="t">{t.title || "Untitled"}</span>
            </button>
          ))}
          <div style={{ height: 10 }} />
        </>
      )}
    </Sheet>
  );
}

function MoveSheet({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const app = useApp();
  const { data: tree } = useTree();
  const [q, setQ] = useState("");
  const move = async (body: { parent_id?: string | null; space_id?: string | null }) => {
    try {
      await api(`/pages/${pageId}`, { method: "PATCH", body });
      invalidate("tree", "page");
      toast("Moved");
      onClose();
    } catch (e) { toastError(e); }
  };
  // A page can't move under itself or its own descendants.
  const blocked = useMemo(() => {
    const out = new Set([pageId]);
    let grew = true;
    while (grew) { grew = false; for (const n of tree ?? []) if (n.parent_id && out.has(n.parent_id) && !out.has(n.id)) { out.add(n.id); grew = true; } }
    return out;
  }, [tree, pageId]);
  const matches = (tree ?? []).filter((n) => n.kind === "page" && !n.is_template && !blocked.has(n.id) && n.section !== "shared" && n.title.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  return (
    <Sheet title="Move to" onClose={onClose}>
      <input className="field" placeholder="Search for a page to move it under" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div style={{ maxHeight: 340, overflow: "auto", margin: "10px -8px 10px" }}>
        {!q && (
          <>
            <div className="menu-title">Top level of</div>
            <button className="row-link" onClick={() => move({ parent_id: null, space_id: null })}><span className="glyph">🔒</span><span className="t">Private</span></button>
            {app.spaces.map((s) => (
              <button key={s.id} className="row-link" onClick={() => move({ parent_id: null, space_id: s.id })}><SpaceBadge space={s} /><span className="t">{s.name}</span></button>
            ))}
            <div className="menu-title" style={{ marginTop: 6 }}>Inside a page</div>
          </>
        )}
        {matches.map((n) => (
          <button key={n.id} className="row-link" onClick={() => move({ parent_id: n.id })}>
            <PageGlyph icon={n.icon} kind={n.kind} /><span className="t">{n.title || "Untitled"}</span>
            <span className="m">{n.space_id ? app.spaceById.get(n.space_id)?.name : "Private"}</span>
          </button>
        ))}
        {q && !matches.length && <div className="empty">No pages match</div>}
      </div>
    </Sheet>
  );
}

// ---------- App ----------

export function App() {
  const loc = useLocation();
  if (loc.pathname.startsWith("/signin")) return (<><SignIn /><Overlays /></>);
  return <Authed />;
}

function Authed() {
  const { data: boot, error } = useBoot();
  const loc = useLocation();
  const [search, setSearch] = useState(false);
  const [ask, setAsk] = useState<{ q?: string } | null>(null);
  const [meeting, setMeeting] = useState<{ spaceId?: string | null } | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [template, setTemplate] = useState<{ space_id?: string | null; parent_id?: string | null } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearch((s) => !s); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); setAsk((a) => (a ? null : {})); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => { if (boot) document.title = boot.appName; }, [boot?.appName]);

  const shell = useMemo<Shell>(() => ({
    openSearch: () => setSearch(true),
    openAsk: (q) => setAsk({ q }),
    openNewMeeting: (spaceId) => setMeeting({ spaceId }),
    openSidebar: () => setSidebar(true),
    pickTemplate: setTemplate,
    movePage: setMoving,
  }), []);

  if (error && !boot) return <div className="center" style={{ height: "100dvh" }}><div className="empty"><h3>Can't reach the workspace</h3>Check your connection and reload.</div></div>;
  if (!boot) return <div style={{ height: "100dvh" }}><Spinner /></div>;

  return (
    <AppProvider boot={boot}>
      <ShellCtx.Provider value={shell}>
        <div className="app">
          {sidebar && <div className="side-scrim" onClick={() => setSidebar(false)} />}
          <Sidebar open={sidebar} onNavigate={() => setSidebar(false)} />
          <main className="main">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/inbox" element={<Inbox />} />
              <Route path="/tasks" element={<TasksView />} />
              <Route path="/meetings" element={<MeetingsView />} />
              <Route path="/meetings/:id" element={<MeetingView key={loc.pathname} />} />
              <Route path="/brain" element={<Brain />} />
              <Route path="/space/:id" element={<SpaceView key={loc.pathname} />} />
              <Route path="/p/:id" element={<PageView key={loc.pathname} />} />
              <Route path="/trash" element={<Trash />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<div className="center"><div className="empty"><h3>Nothing here</h3><Link className="btn" to="/">Go home</Link></div></div>} />
            </Routes>
            {ask && <AskPanel initial={ask.q} onClose={() => setAsk(null)} />}
          </main>
        </div>
        {search && <SearchPalette onClose={() => setSearch(false)} />}
        {meeting && <NewMeetingSheet spaceId={meeting.spaceId ?? null} onClose={() => setMeeting(null)} />}
        {template && <TemplateSheet dest={template} onClose={() => setTemplate(null)} />}
        {moving && <MoveSheet pageId={moving} onClose={() => setMoving(null)} />}
        <Overlays />
      </ShellCtx.Provider>
    </AppProvider>
  );
}

