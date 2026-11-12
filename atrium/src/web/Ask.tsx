import DOMPurify from "dompurify";
import { ArrowUp, Search, Sparkles, SquarePen, X } from "lucide-react";
import { marked } from "marked";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sse } from "./api";
import { useApp } from "./ui";

type Msg = { role: "user" | "assistant"; content: string; steps?: string[]; error?: string };

const STARTERS = ["What did we decide in the last meeting?", "What's overdue, and who owns it?", "Summarise what's open for the bakery"];

function Answer({ text }: { text: string }) {
  const navigate = useNavigate();
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return (
    <div
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        const href = a?.getAttribute("href");
        if (!href) return;
        e.preventDefault();
        // Citations point at pages in the app; anything else opens in a new tab.
        if (href.startsWith("/") && !href.startsWith("//")) navigate(href);
        else window.open(href, "_blank", "noopener,noreferrer");
      }}
    />
  );
}

/** A side panel for questions answered from the workspace. It floats beside the page rather than replacing it. */
export function AskPanel({ initial, onClose }: { initial?: string; onClose: () => void }) {
  const app = useApp();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const asked = useRef(false);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const history = [...msgs, { role: "user" as const, content: q }];
    setMsgs([...history, { role: "assistant", content: "", steps: [] }]);
    setText("");
    setBusy(true);
    const patch = (fn: (m: Msg) => Msg) => setMsgs((all) => all.map((m, i) => (i === all.length - 1 ? fn(m) : m)));
    abort.current = new AbortController();
    try {
      await sse("/ai/ask", { messages: history.map((m) => ({ role: m.role, content: m.content })) }, (event, data) => {
        if (event === "text") patch((m) => ({ ...m, content: m.content + data.delta }));
        if (event === "step") patch((m) => ({ ...m, steps: [...(m.steps ?? []), data.label] }));
        if (event === "error") patch((m) => ({ ...m, error: data.message }));
      }, abort.current.signal);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) patch((m) => ({ ...m, error: e instanceof Error ? e.message : "Something went wrong." }));
    }
    setBusy(false);
  };

  useEffect(() => { if (initial && !asked.current) { asked.current = true; ask(initial); } }, [initial]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs]);
  useEffect(() => () => abort.current?.abort(), []);

  return (
    <div className="panel" role="complementary" aria-label="Ask AI">
      <div className="panel-head">
        <Sparkles size={16} style={{ color: "var(--accent)" }} />
        <h3>Ask AI</h3>
        {msgs.length > 0 && <button className="icon-btn" title="New conversation" aria-label="New conversation" onClick={() => { abort.current?.abort(); setMsgs([]); }}><SquarePen /></button>}
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <div className="panel-body">
        {!msgs.length ? (
          <div style={{ paddingTop: 30 }}>
            <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>Ask about anything in {app.appName}</h2>
            <p className="sec" style={{ marginTop: 6, fontSize: 14 }}>Answers come from the pages, meetings, tasks and notes you have access to, with links to the sources.</p>
            {!app.aiReady && <div className="banner warn" style={{ marginTop: 14 }}>Ask AI needs an Anthropic API key, which hasn't been added yet.</div>}
            <div className="suggest">{STARTERS.map((s) => <button key={s} onClick={() => ask(s)}>{s}</button>)}</div>
          </div>
        ) : (
          <div className="chat">
            {msgs.map((m, i) => m.role === "user" ? <div key={i} className="msg user">{m.content}</div> : (
              <div key={i} className="msg bot">
                {!!m.steps?.length && <div className="msg-steps">{m.steps.map((s, j) => <div key={j} className="msg-step"><Search />{s}</div>)}</div>}
                {m.content ? <Answer text={m.content} /> : !m.error && <div className="msg-step"><div className="spin" style={{ width: 13, height: 13 }} />Thinking…</div>}
                {m.error && <div className="banner warn" style={{ marginTop: 8 }}>{m.error}</div>}
              </div>
            ))}
            <div ref={end} />
          </div>
        )}
      </div>
      <div className="panel-foot">
        <div className="composer">
          <textarea rows={1} autoFocus placeholder="Ask a question" value={text}
            onChange={(e) => { setText(e.target.value); e.target.style.height = "0"; e.target.style.height = e.target.scrollHeight + "px"; }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(text); } }} />
          <button className="send" disabled={!text.trim() || busy} onClick={() => ask(text)} aria-label="Send"><ArrowUp /></button>
        </div>
      </div>
    </div>
  );
}
