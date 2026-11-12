import { useQuery } from "@tanstack/react-query";
import type { Editor as TEditor } from "@tiptap/react";
import { ArrowUp, Check, Clock, Copy, ExternalLink, Eye, FolderInput, LayoutTemplate, Link2, Lock, MessageCircle, MoreHorizontal, Smile, Trash2, UserPlus, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, invalidate, qc, relTime, type Comment, type PageDetail, type Prop } from "./api";
import { Toolbar, usePageActions, useShell } from "./App";
import { DatabaseView, propIcon, PropValue } from "./Database";
import { Editor } from "./Editor";
import { AutoText, Avatar, Dropdown, EmojiPicker, Empty, MenuItem, PageGlyph, PersonList, Sheet, Spinner, toast, toastError, useApp, useDebouncedSave } from "./ui";

export function PageView() {
  const { id = "" } = useParams();
  const app = useApp();
  const acts = usePageActions();
  const shell = useShell();
  const navigate = useNavigate();
  const { data, error, isLoading } = useQuery({ queryKey: ["page", id], queryFn: () => api<PageDetail>(`/pages/${id}`), refetchOnWindowFocus: true });
  const [title, setTitle] = useState<string | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [comments, setComments] = useState(false);
  const [history, setHistory] = useState(false);
  const editorRef = useRef<TEditor | null>(null);
  const lastSeen = useRef(0);

  const patch = async (body: Record<string, unknown>) => {
    setSaving("saving");
    try {
      const res = await api<{ page: { updated_at: number } }>(`/pages/${id}`, { method: "PATCH", body });
      lastSeen.current = res.page.updated_at;
      setSaving("saved");
      if ("title" in body || "icon" in body) invalidate("tree");
    } catch (e) { setSaving("idle"); toastError(e); }
  };
  const saveContent = useDebouncedSave<unknown>((content) => patch({ content }), 800);
  const saveTitle = useDebouncedSave<string>((t) => patch({ title: t }), 500);

  const page = data?.page;
  useEffect(() => { if (page) document.title = `${page.title || "Untitled"} · ${app.appName}`; return () => { document.title = app.appName; }; }, [page?.title]);

  // When someone else has saved a newer version and nothing here is unsaved, show theirs.
  useEffect(() => {
    if (!page) return;
    if (!lastSeen.current) { lastSeen.current = page.updated_at; return; }
    if (page.updated_at > lastSeen.current && !saveContent.isPending() && page.updated_by !== app.me.id) {
      lastSeen.current = page.updated_at;
      const ed = editorRef.current;
      if (ed && !ed.isFocused && page.content) ed.commands.setContent("html" in page.content ? page.content.html : page.content, { emitUpdate: false });
      setTitle(null);
    }
  }, [page?.updated_at]);

  if (isLoading) return (<><Toolbar /><Spinner /></>);
  if (error || !data || !page) {
    const denied = error instanceof ApiError && error.status === 403;
    return (<><Toolbar /><div className="center"><Empty icon={denied ? "🔒" : "🫥"} title={denied ? "You don't have access to this page" : "This page doesn't exist"}>{denied ? "Ask the owner to share it with you." : "It may have been deleted."}<div><Link className="btn" to="/">Go home</Link></div></Empty></div></>);
  }

  const canEdit = data.level === "edit" && !page.archived;
  const space = page.space_id ? app.spaceById.get(page.space_id) : null;
  const shownTitle = title ?? page.title;
  const isDb = page.kind === "database";
  const editor = app.userById.get(page.updated_by);
  const setIcon = (icon: string) => { qc.setQueryData<PageDetail>(["page", id], (d) => (d ? { ...d, page: { ...d.page, icon } } : d)); patch({ icon }); };
  const copyLink = async () => { await navigator.clipboard.writeText(`${location.origin}/p/${id}`); toast("Link copied"); };

  return (
    <>
      <Toolbar crumbs={<>
        {space ? <Link className="crumb" to={`/space/${space.id}`}>{space.icon} {space.name}</Link> : <span className="crumb" style={{ cursor: "default" }}>{page.owner_id === app.me.id ? "Private" : "Shared"}</span>}
        {data.crumbs.map((c) => (<span key={c.id} style={{ display: "contents" }}><span className="crumb-sep">›</span><Link className="crumb" to={`/p/${c.id}`}>{c.icon} {c.title || "Untitled"}</Link></span>))}
        <span className="crumb-sep">›</span><span className="crumb current">{shownTitle || "Untitled"}</span>
      </>}>
        <span className="muted" style={{ fontSize: 12.5, marginRight: 4, minWidth: 44, textAlign: "right" }}>{saving === "saving" ? "Saving…" : saving === "saved" ? "Saved" : ""}</span>
        {canEdit && page.kind !== "row" && <ShareButton detail={data} />}
        <button className={`icon-btn ${comments ? "on" : ""}`} aria-label="Comments" title="Comments" onClick={() => setComments((c) => !c)}><MessageCircle /></button>
        <Dropdown width={220} placement="bottom-end" trigger={({ onClick }) => <button className="icon-btn" aria-label="More" onClick={onClick}><MoreHorizontal /></button>}>
          {(close) => (
            <>
              <MenuItem icon={<Link2 />} onClick={() => { close(); copyLink(); }}>Copy link</MenuItem>
              {!isDb && <MenuItem icon={<Clock />} onClick={() => { close(); setHistory(true); }}>Version history</MenuItem>}
              {page.kind !== "row" && <MenuItem icon={<Copy />} onClick={() => { close(); acts.duplicate(id); }}>Duplicate</MenuItem>}
              {canEdit && page.kind !== "row" && <MenuItem icon={<FolderInput />} onClick={() => { close(); shell.movePage(id); }}>Move to…</MenuItem>}
              {page.kind !== "row" && <MenuItem icon={<LayoutTemplate />} onClick={() => { close(); acts.duplicate(id, true); }}>Save as template</MenuItem>}
              {page.source_url && <MenuItem icon={<ExternalLink />} onClick={() => { close(); window.open(page.source_url!, "_blank", "noopener"); }}>Open original in Notion</MenuItem>}
              {canEdit && (<><div className="menu-sep" /><MenuItem danger icon={<Trash2 />} onClick={() => { close(); acts.remove(id, page.title, () => navigate(page.parent_id ? `/p/${page.parent_id}` : "/")); }}>Delete</MenuItem></>)}
            </>
          )}
        </Dropdown>
      </Toolbar>

      <div className="scroll">
        <div className={`column ${isDb ? "wide" : ""}`}>
          {page.archived && <div className="banner warn"><Trash2 />This page is in the trash.<button className="btn" onClick={async () => { await api(`/pages/${id}/restore`, { body: {} }); invalidate("tree", "page", "trash"); }}>Restore</button></div>}
          {page.is_template && <div className="banner"><LayoutTemplate />This is a template. Changes here affect new pages made from it.<button className="btn" onClick={() => acts.create({ space_id: page.space_id, template_id: id })}>Use template</button></div>}
          {!canEdit && !page.archived && <div className="banner"><Eye />You can {data.level === "comment" ? "view and comment on" : "view"} this page, but not edit it.</div>}

          <div className="page-head">
            {canEdit && !page.icon && (
              <div className="page-hover-acts">
                <Dropdown trigger={({ onClick }) => <button className="btn quiet" style={{ height: 26 }} onClick={onClick}><Smile />Add icon</button>}>
                  {(close) => <EmojiPicker onPick={(e) => { setIcon(e); close(); }} />}
                </Dropdown>
              </div>
            )}
            {page.icon && (canEdit ? (
              <Dropdown trigger={({ onClick }) => <button className="page-icon" onClick={onClick} aria-label="Change icon">{page.icon}</button>}>
                {(close) => <EmojiPicker onPick={(e) => { setIcon(e); close(); }} onRemove={() => { setIcon(""); close(); }} />}
              </Dropdown>
            ) : <div className="page-icon">{page.icon}</div>)}
            <AutoText className="page-title" value={shownTitle} placeholder="Untitled" readOnly={!canEdit} autoFocus={canEdit && !page.title && !page.content}
              onChange={(v) => { setTitle(v); saveTitle.schedule(v); }} onEnter={() => editorRef.current?.commands.focus("start")} />
            <div className="page-meta">
              {editor && <><Avatar user={editor} size={16} />Edited by {editor.id === app.me.id ? "you" : editor.name.split(" ")[0]} {relTime(page.updated_at)}</>}
              {!page.space_id && page.owner_id === app.me.id && <span className="chip"><Lock />Private</span>}
            </div>
          </div>

          {page.kind === "row" && data.database && <RowProps detail={data} editable={canEdit} />}

          {isDb ? <DatabaseView detail={data} editable={canEdit} /> : (
            <Editor content={page.content} editable={canEdit} users={app.users} onReady={(e) => (editorRef.current = e)}
              onChange={(doc) => { setSaving("saving"); saveContent.schedule(doc); }}
              onSubpage={page.kind === "page" ? () => acts.create({ parent_id: id }) : undefined} />
          )}

          {data.subpages.length > 0 && (
            <div className="subpages">
              <h4>Pages inside</h4>
              {data.subpages.map((s) => <Link key={s.id} to={`/p/${s.id}`} className="sub-link"><PageGlyph icon={s.icon} kind={s.kind} />{s.title || "Untitled"}</Link>)}
            </div>
          )}
        </div>
      </div>

      {comments && (
        <div className="panel">
          <div className="panel-head"><h3>Comments</h3><button className="icon-btn" onClick={() => setComments(false)} aria-label="Close"><X /></button></div>
          <CommentThread kind="page" id={id} />
        </div>
      )}
      {history && <HistorySheet pageId={id} canRestore={canEdit} onClose={() => setHistory(false)} onRestored={() => { setHistory(false); navigate(0); }} />}
    </>
  );
}

function RowProps({ detail, editable }: { detail: PageDetail; editable: boolean }) {
  const db = detail.database!;
  const [props, setProps] = useState(detail.page.props);
  const [schema, setSchema] = useState(db.schema);
  const set = async (pid: string, v: unknown) => {
    setProps((p) => ({ ...p, [pid]: v }));
    try { await api(`/pages/${detail.page.id}`, { method: "PATCH", body: { props: { [pid]: v } } }); qc.invalidateQueries({ queryKey: ["page", db.id] }); } catch (e) { toastError(e); }
  };
  const saveProp = async (p: Prop) => {
    const next = { ...schema, props: schema.props.map((x) => (x.id === p.id ? p : x)) };
    setSchema(next);
    try { await api(`/pages/${db.id}`, { method: "PATCH", body: { schema: next } }); } catch (e) { toastError(e); }
  };
  return (
    <div className="props">
      {schema.props.map((p) => (
        <div key={p.id} style={{ display: "contents" }}>
          <div className="k">{propIcon(p.type)}{p.name}</div>
          <div className="v"><PropValue prop={p} value={props[p.id]} editable={editable} onChange={(v) => set(p.id, v)} onSchema={saveProp} /></div>
        </div>
      ))}
    </div>
  );
}

// ---------- Sharing ----------

function ShareButton({ detail }: { detail: PageDetail }) {
  const app = useApp();
  const page = detail.page;
  const space = page.space_id ? app.spaceById.get(page.space_id) : null;
  const key = ["shares", page.id];
  const { data } = useQuery({ queryKey: key, queryFn: () => api<{ shares: { user_id: string; level: string }[]; inherited: { user_id: string; level: string; via: string }[] }>(`/pages/${page.id}/shares`) });
  const [guest, setGuest] = useState<{ name: string; email: string } | null>(null);
  const share = async (userId: string, level: string | null) => {
    try {
      if (level) await api(`/pages/${page.id}/shares/${userId}`, { method: "PUT", body: { level } });
      else await api(`/pages/${page.id}/shares/${userId}`, { method: "DELETE" });
      qc.invalidateQueries({ queryKey: key });
    } catch (e) { toastError(e); }
  };
  const inviteGuest = async () => {
    if (!guest) return;
    try {
      const { id } = await api<{ id: string }>("/admin/users", { body: { ...guest, role: "guest" } });
      await share(id, "view");
      invalidate("boot");
      setGuest(null);
      toast("Invited as a guest");
    } catch (e) { toastError(e); }
  };
  const shared = new Set((data?.shares ?? []).map((s) => s.user_id));
  const n = (data?.shares.length ?? 0) + (data?.inherited.length ?? 0);
  return (
    <Dropdown width={340} placement="bottom-end" trigger={({ onClick }) => <button className="btn quiet" style={{ height: 28 }} onClick={onClick}><Users />Share{n ? ` · ${n}` : ""}</button>}>
      {() => (
        <div style={{ padding: 6 }}>
          <div className="person-line">
            <span className="avatar" style={{ width: 28, height: 28, background: "var(--fill-2)", color: "var(--text-2)" }}>{space ? space.icon || space.name[0] : <Lock size={14} />}</span>
            <div className="nm"><div>{space ? `Everyone in ${space.name}` : "Private to " + (page.owner_id === app.me.id ? "you" : app.userById.get(page.owner_id)?.name ?? "its owner")}</div><span>{space ? `${space.member_ids.length} members can edit` : "Only people you add below can open it"}</span></div>
          </div>
          {data?.inherited.map((s) => (
            <div className="person-line" key={"i" + s.user_id}>
              <Avatar user={app.userById.get(s.user_id)} size={28} />
              <div className="nm"><div>{app.userById.get(s.user_id)?.name ?? "Someone"}</div><span>Can {s.level} · through “{s.via || "Untitled"}”</span></div>
            </div>
          ))}
          {data?.shares.map((s) => {
            const u = app.userById.get(s.user_id);
            return (
              <div className="person-line" key={s.user_id}>
                <Avatar user={u} size={28} />
                <div className="nm"><div>{u?.name ?? "Someone"}</div><span>{u?.role === "guest" ? "Guest · " : ""}{u?.email}</span></div>
                <select className="field" style={{ width: 110, height: 28, fontSize: 13 }} value={s.level} onChange={(e) => share(s.user_id, e.target.value === "remove" ? null : e.target.value)}>
                  <option value="view">Can view</option><option value="comment">Can comment</option><option value="edit">Can edit</option><option value="remove">Remove</option>
                </select>
              </div>
            );
          })}
          <div className="menu-sep" />
          {guest ? (
            <div style={{ padding: 4 }}>
              <input className="field" placeholder="Their name" value={guest.name} autoFocus onChange={(e) => setGuest({ ...guest, name: e.target.value })} style={{ marginBottom: 6 }} />
              <input className="field" type="email" placeholder="Their email" value={guest.email} onChange={(e) => setGuest({ ...guest, email: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") inviteGuest(); }} />
              <p className="muted" style={{ fontSize: 12, margin: "8px 2px" }}>Guests can open only the pages shared with them.</p>
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}><button className="btn" onClick={() => setGuest(null)}>Cancel</button><button className="btn primary" disabled={!guest.email.includes("@")} onClick={inviteGuest}>Invite</button></div>
            </div>
          ) : (
            <>
              <Dropdown width={260} trigger={({ onClick }) => <button className="menu-item" onClick={onClick}><UserPlus />Add people</button>}>
                {(close) => <PersonList value={[...shared]} users={app.users.filter((u) => !shared.has(u.id) && u.id !== app.me.id && !(space && space.member_ids.includes(u.id)))} onPick={(uid) => { if (uid) share(uid, "edit"); close(); }} />}
              </Dropdown>
              {app.me.role !== "guest" && <button className="menu-item" onClick={() => setGuest({ name: "", email: "" })}><ExternalLink />Invite someone outside the team</button>}
            </>
          )}
        </div>
      )}
    </Dropdown>
  );
}

// ---------- Version history ----------

function HistorySheet({ pageId, canRestore, onClose, onRestored }: { pageId: string; canRestore: boolean; onClose: () => void; onRestored: () => void }) {
  const app = useApp();
  const { data } = useQuery({ queryKey: ["versions", pageId], queryFn: () => api<{ versions: { id: string; title: string; created_by: string; created_at: number }[] }>(`/pages/${pageId}/versions`), staleTime: 0 });
  const [sel, setSel] = useState<string | null>(null);
  const cur = sel ?? data?.versions[0]?.id ?? null;
  const { data: v } = useQuery({ queryKey: ["version", pageId, cur], queryFn: () => api<{ version: { title: string; content: any } }>(`/pages/${pageId}/versions/${cur}`), enabled: !!cur });
  const restore = async () => {
    try { await api(`/pages/${pageId}/versions/${cur}/restore`, { body: {} }); qc.removeQueries({ queryKey: ["page", pageId] }); invalidate("tree"); toast("Version restored"); onRestored(); } catch (e) { toastError(e); }
  };
  return (
    <Sheet title="Version history" onClose={onClose} wide footer={cur && canRestore ? <button className="btn primary" onClick={restore}>Restore this version</button> : undefined}>
      {!data ? <Spinner /> : !data.versions.length ? <Empty icon="🕰️" title="No earlier versions yet">A version is kept each time the page is edited, at most every ten minutes.</Empty> : (
        <div style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: 16, minHeight: 320 }}>
          <div style={{ maxHeight: 420, overflow: "auto", margin: "0 -6px" }}>
            {data.versions.map((x) => (
              <button key={x.id} className="row-link" style={{ background: x.id === cur ? "var(--fill-2)" : undefined, display: "block" }} onClick={() => setSel(x.id)}>
                <div style={{ fontSize: 13.5, fontWeight: 500 }}>{new Date(x.created_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</div>
                <div className="muted" style={{ fontSize: 12 }}>{app.userById.get(x.created_by)?.name ?? "Someone"}</div>
              </button>
            ))}
          </div>
          <div className="card inset" style={{ padding: 18, maxHeight: 420, overflow: "auto" }}>
            {v ? (<><h3 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 10 }}>{v.version.title || "Untitled"}</h3><Editor key={cur} content={v.version.content} editable={false} users={app.users} compact /></>) : <Spinner />}
          </div>
        </div>
      )}
    </Sheet>
  );
}

// ---------- Comments (pages, tasks and meetings) ----------

export function CommentThread({ kind, id, compact }: { kind: "page" | "task" | "meeting"; id: string; compact?: boolean }) {
  const app = useApp();
  const key = ["comments", kind, id];
  const { data } = useQuery({ queryKey: key, queryFn: () => api<{ comments: Comment[]; canComment: boolean }>(`/comments?kind=${kind}&id=${id}`), refetchInterval: 30_000 });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    // "@Name" in the text notifies that person.
    const mentions = app.users.filter((u) => body.toLowerCase().includes("@" + u.name.toLowerCase()) || body.toLowerCase().includes("@" + u.name.split(" ")[0].toLowerCase())).map((u) => u.id);
    try { await api("/comments", { body: { kind, id, body, mentions } }); setText(""); qc.invalidateQueries({ queryKey: key }); } catch (e) { toastError(e); }
    setBusy(false);
  };
  const act = async (c: Comment, what: "resolve" | "delete") => {
    try {
      if (what === "delete") await api(`/comments/${c.id}`, { method: "DELETE" });
      else await api(`/comments/${c.id}`, { method: "PATCH", body: { resolved: !c.resolved } });
      qc.invalidateQueries({ queryKey: key });
    } catch (e) { toastError(e); }
  };
  const list = (
    <>
      {data?.comments.map((c) => {
        const u = app.userById.get(c.author_id);
        return (
          <div key={c.id} className={`comment ${c.resolved ? "resolved" : ""}`}>
            <Avatar user={u} size={26} />
            <div className="b">
              <div className="hd"><b>{u?.name ?? "Someone"}</b><span>{relTime(c.created_at)}</span>
                <span className="acts" style={{ marginLeft: "auto" }}>
                  <button className="icon-btn sm" title={c.resolved ? "Reopen" : "Resolve"} onClick={() => act(c, "resolve")}><Check /></button>
                  {(c.author_id === app.me.id || app.me.role === "owner" || app.me.role === "admin") && <button className="icon-btn sm" title="Delete" onClick={() => act(c, "delete")}><Trash2 /></button>}
                </span>
              </div>
              <div className="tx">{c.body}</div>
            </div>
          </div>
        );
      })}
      {data && !data.comments.length && !compact && <Empty icon="💬" title="No comments yet">Type @ and a name to notify someone.</Empty>}
    </>
  );
  const composer = data?.canComment !== false && (
    <div className="composer">
      <textarea rows={1} placeholder="Add a comment" value={text} onChange={(e) => { setText(e.target.value); e.target.style.height = "0"; e.target.style.height = e.target.scrollHeight + "px"; }}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
      <button className="send" disabled={!text.trim() || busy} onClick={send} aria-label="Send"><ArrowUp /></button>
    </div>
  );
  if (compact) return (<div>{list}<div style={{ marginTop: 8 }}>{composer}</div></div>);
  return (<><div className="panel-body">{list}</div><div className="panel-foot">{composer}</div></>);
}
