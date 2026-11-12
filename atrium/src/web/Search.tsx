import { Brain, CheckCircle2, FileText, Mic, Search, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api, useTree, type Hit } from "./api";
import { useShell } from "./App";
import { useApp } from "./ui";

const ICON: Record<Hit["kind"], ReactNode> = { page: <FileText />, task: <CheckCircle2 />, meeting: <Mic />, knowledge: <Brain /> };

/** Renders a search snippet, bolding the matched words (marked by control characters, never HTML). */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/[\u0001\u0002]/);
  return <>{parts.map((p, i) => (i % 2 ? <b key={i}>{p}</b> : p))}</>;
}

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const shell = useShell();
  const navigate = useNavigate();
  const { data: tree } = useTree();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [sel, setSel] = useState(0);
  const seq = useRef(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const query = q.trim();
    if (!query) { setHits(null); return; }
    const n = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const { results } = await api<{ results: Hit[] }>(`/search?q=${encodeURIComponent(query)}`);
        if (n === seq.current) { setHits(results); setSel(0); }
      } catch { if (n === seq.current) setHits([]); }
    }, 140);
    return () => clearTimeout(t);
  }, [q]);

  // Before typing: the pages you can jump to. Title matches appear instantly while results load.
  const quick: Hit[] = (tree ?? [])
    .filter((n) => !n.is_template && (!q.trim() || n.title.toLowerCase().includes(q.trim().toLowerCase())))
    .slice(0, q.trim() ? 4 : 8)
    .map((n) => ({ kind: "page", id: n.id, title: n.title || "Untitled", snippet: "", url: `/p/${n.id}`, where: n.space_id ? app.spaceById.get(n.space_id)?.name ?? "" : "Private" }));
  const seen = new Set(quick.map((h) => h.id));
  const rows = [...quick, ...(hits ?? []).filter((h) => !(h.kind === "page" && seen.has(h.id)))];
  const total = rows.length + (q.trim() ? 1 : 0);

  const go = (i: number) => {
    onClose();
    if (i === rows.length) shell.openAsk(q.trim());
    else navigate(rows[i].url);
  };
  useEffect(() => { list.current?.querySelector(".hl")?.scrollIntoView({ block: "nearest" }); }, [sel]);

  return createPortal(
    <div className="scrim top" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-label="Search">
        <div className="palette-input">
          <Search />
          <input className="bare" autoFocus placeholder="Search pages, meetings, tasks and notes" value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(total - 1, s + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              if (e.key === "Enter" && total) { e.preventDefault(); go(sel); }
            }} />
        </div>
        <div className="palette-list" ref={list}>
          {!q.trim() && rows.length > 0 && <div className="menu-title">Jump to</div>}
          {rows.map((h, i) => (
            <button key={h.kind + h.id} className={`hit ${i === sel ? "hl" : ""}`} onMouseMove={() => setSel(i)} onClick={() => go(i)}>
              <span className="ic">{ICON[h.kind]}</span>
              <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                <div className="tt">{h.title}</div>
                {h.snippet && <div className="sn"><Snippet text={h.snippet} /></div>}
              </span>
              <span className="wh">{h.where}</span>
            </button>
          ))}
          {q.trim() && (
            <button className={`hit ${sel === rows.length ? "hl" : ""}`} onMouseMove={() => setSel(rows.length)} onClick={() => go(rows.length)}>
              <span className="ic"><Sparkles /></span>
              <span style={{ flex: 1, textAlign: "left" }}><div className="tt">Ask AI: “{q.trim()}”</div><div className="sn">Get an answer drawn from everything you can see</div></span>
            </button>
          )}
          {q.trim() && hits && !rows.length && <div className="empty" style={{ padding: 18 }}>No matches for “{q.trim()}”</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
