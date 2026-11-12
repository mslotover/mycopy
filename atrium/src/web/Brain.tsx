import { useQuery } from "@tanstack/react-query";
import { Mic, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, invalidate, relTime, type Knowledge } from "./api";
import { Toolbar, useShell } from "./App";
import { Empty, Sheet, SpaceBadge, SpaceSelect, Spinner, toastError, useApp } from "./ui";

const KINDS = ["decision", "fact", "process", "contact", "idea", "risk"];
const KIND_CLS: Record<string, string> = { decision: "blue", fact: "gray", process: "green", contact: "purple", idea: "orange", risk: "red" };

/** The second brain: what the business has learned, mostly distilled from meetings. */
export function Brain() {
  const app = useApp();
  const shell = useShell();
  const [params, setParams] = useSearchParams();
  const { data, isLoading } = useQuery({ queryKey: ["knowledge"], queryFn: () => api<{ knowledge: Knowledge[] }>("/knowledge").then((r) => r.knowledge) });
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [adding, setAdding] = useState(false);
  const openId = params.get("open");
  const list = useMemo(
    () => (data ?? []).filter((k) => (!kind || k.kind === kind) && (!spaceId || k.space_id === spaceId) && (!q || (k.title + " " + k.body).toLowerCase().includes(q.toLowerCase()))),
    [data, q, kind, spaceId],
  );
  const open = data?.find((k) => k.id === openId);

  return (
    <>
      <Toolbar crumbs={<span className="crumb current">Brain</span>}>
        <button className="btn quiet" onClick={() => shell.openAsk()}><Sparkles />Ask AI</button>
        <button className="btn primary" onClick={() => setAdding(true)}><Plus />Add a note</button>
      </Toolbar>
      <div className="scroll">
        <div className="column wide">
          <div className="view-head"><div className="grow"><h1 className="h-title">Brain</h1><p className="h-sub">Decisions, facts and know-how, kept as the business learns them. Every meeting adds to it.</p></div></div>
          <div className="bar">
            <label className="field" style={{ display: "flex", alignItems: "center", gap: 8, maxWidth: 320 }}><Search size={15} className="muted" /><input className="bare" placeholder="Search the Brain" value={q} onChange={(e) => setQ(e.target.value)} /></label>
            <div className="segmented">
              <button className={kind === "" ? "on" : ""} onClick={() => setKind("")}>All</button>
              {KINDS.map((k) => <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{k[0].toUpperCase() + k.slice(1)}s</button>)}
            </div>
            <span className="grow" />
            {app.spaces.length > 0 && (
              <select className="field" style={{ width: "auto", height: 30, fontSize: 13 }} value={spaceId} onChange={(e) => setSpaceId(e.target.value)} aria-label="Filter by space">
                <option value="">All spaces</option>
                {app.spaces.map((s) => <option key={s.id} value={s.id}>{s.icon} {s.name}</option>)}
              </select>
            )}
          </div>
          {isLoading ? <Spinner /> : !list.length ? (
            <Empty icon="🧠" title={data?.length ? "Nothing matches" : "The Brain is empty"}>{!data?.length && "Record a meeting and its decisions and facts will be filed here automatically, or add a note yourself."}</Empty>
          ) : (
            <div className="grid three">
              {list.map((k) => {
                const space = k.space_id ? app.spaceById.get(k.space_id) : null;
                return (
                  <button key={k.id} className="note" style={{ textAlign: "left" }} onClick={() => setParams({ open: k.id }, { replace: true })}>
                    <span className={`chip ${KIND_CLS[k.kind] ?? "gray"}`} style={{ alignSelf: "flex-start" }}>{k.kind}</span>
                    <h4>{k.title}</h4>
                    <p style={{ display: "-webkit-box", WebkitLineClamp: 5, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{k.body}</p>
                    <div className="ft">
                      {space ? <><SpaceBadge space={space} size={14} />{space.name}</> : "Private"} · {relTime(k.created_at)}
                      {k.meeting_id && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>· <Mic size={11} />{k.meeting_title || "Meeting"}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {open && <NoteSheet note={open} onClose={() => setParams({}, { replace: true })} />}
      {adding && <NoteSheet onClose={() => setAdding(false)} defaultSpace={spaceId || null} />}
    </>
  );
}

function NoteSheet({ note, onClose, defaultSpace }: { note?: Knowledge; onClose: () => void; defaultSpace?: string | null }) {
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  const [kind, setKind] = useState(note?.kind ?? "fact");
  const [space, setSpace] = useState<string | null>(note?.space_id ?? defaultSpace ?? null);
  const save = async () => {
    try {
      if (note) await api(`/knowledge/${note.id}`, { method: "PATCH", body: { title, body, kind } });
      else await api("/knowledge", { body: { title, body, kind, space_id: space } });
      invalidate("knowledge");
      onClose();
    } catch (e) { toastError(e); }
  };
  const remove = async () => { try { await api(`/knowledge/${note!.id}`, { method: "DELETE" }); invalidate("knowledge"); onClose(); } catch (e) { toastError(e); } };
  return (
    <Sheet title={note ? "Note" : "Add to the Brain"} onClose={onClose} footer={<>
      {note && <button className="btn quiet danger" style={{ marginRight: "auto" }} onClick={remove}><Trash2 />Delete</button>}
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!title.trim()} onClick={save}>Save</button>
    </>}>
      <div className="form-row"><input className="field" placeholder="Headline" value={title} autoFocus={!note} onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="form-row"><textarea className="field" rows={6} placeholder="What should be remembered? Include names, figures and dates." value={body} onChange={(e) => setBody(e.target.value)} /></div>
      <div className="form-row" style={{ display: "flex", gap: 10 }}>
        <select className="field" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">{KINDS.map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}</select>
        {!note && <SpaceSelect value={space} onChange={setSpace} />}
      </div>
      {note?.meeting_id && <Link to={`/meetings/${note.meeting_id}`} className="chip blue" onClick={onClose}><Mic />From {note.meeting_title || "a meeting"}</Link>}
    </Sheet>
  );
}
