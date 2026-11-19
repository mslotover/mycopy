import DOMPurify from "dompurify";
import { ArrowUp, Check, FileText, Search, Sparkles, SquarePen, X } from "lucide-react";
import { marked } from "marked";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, invalidate, sse } from "./api";
import { useApp } from "./ui";

export type AskContext = { kind: "page" | "meeting"; id: string; title: string };
type Proposal = { id: string; title: string; lines: string[]; requests: { method: "POST"; path: string; body: unknown; label: string }[] };
type ProposalState = { status: "waiting" | "working" | "done" | "cancelled" | "failed"; links?: { label: string; url: string }[]; error?: string };
type Msg = { role: "user" | "assistant"; content: string; steps?: string[]; error?: string; proposals?: Proposal[] };

const STARTERS = ["What did we decide in the last meeting?", "What's overdue, and who owns it?", "How did the bakery do last week?"];
const CONTEXT_STARTERS = {
  page: ["Summarise this", "What's still undecided here?", "Turn this into tasks"],
  meeting: ["Summarise this meeting", "What did each person agree to do?", "What's still undecided?"],
};

/** A change Ask AI has offered to make. Nothing happens until Confirm; then the browser makes the same calls the app would. */
function ProposalCard({ p, state, onState }: { p: Proposal; state: ProposalState; onState: (s: ProposalState) => void }) {
  const navigate = useNavigate();
  const confirm = async () => {
    onState({ status: "working" });
    const links: { label: string; url: string }[] = [];
    try {
      for (const r of p.requests) {
        const res = await api<any>(r.path, { method: r.method, body: r.body });
        if (res?.task?.id) links.push({ label: r.label, url: `/tasks?open=${res.task.id}` });
        else if (res?.page?.id) links.push({ label: r.label, url: `/p/${res.page.id}` });
      }
      invalidate("tasks", "tree", "page");
      onState({ status: "done", links });
    } catch (e) {
      invalidate("tasks", "tree", "page");
      onState({ status: "failed", links, error: e instanceof Error ? e.message : "Something went wrong." });
    }
  };
  return (
    <div className={`proposal ${state.status}`}>
      <div className="proposal-title">{p.title}</div>
      <ul>{p.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
      {state.status === "waiting" && (
        <div className="proposal-acts">
          <button className="btn primary" onClick={confirm}><Check />Confirm</button>
          <button className="btn quiet" onClick={() => onState({ status: "cancelled" })}>Cancel</button>
        </div>
      )}
      {state.status === "working" && <div className="msg-step"><div className="spin" style={{ width: 13, height: 13 }} />Working…</div>}
      {state.status === "cancelled" && <div className="proposal-note">Cancelled. Nothing was changed.</div>}
      {(state.status === "done" || state.status === "failed") && (
        <div className="proposal-note">
          {state.status === "done" ? "Done. " : `Stopped: ${state.error} `}
          {state.links?.map((l, i) => <span key={i}>{i ? " · " : ""}<a href={l.url} onClick={(e) => { e.preventDefault(); navigate(l.url); }}>{l.label}</a></span>)}
        </div>
      )}
    </div>
  );
}

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
export function AskPanel({ initial, context, onClose }: { initial?: string; context?: AskContext; onClose: () => void }) {
  const app = useApp();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const asked = useRef(false);
  const [pstate, setPstate] = useState<Record<string, ProposalState>>({});
  const stateOf = (id: string): ProposalState => pstate[id] ?? { status: "waiting" };
  // What happened to each proposal goes back with the conversation, so follow-ups know.
  const withOutcomes = (m: Msg) => {
    const notes = (m.proposals ?? []).map((p) => {
      const st = stateOf(p.id).status;
      return st === "done" ? `[${p.title}: confirmed and done]` : st === "cancelled" ? `[${p.title}: cancelled by the user]` : st === "failed" ? `[${p.title}: failed]` : `[${p.title}: not confirmed yet]`;
    });
    return notes.length ? `${m.content}\n\n${notes.join("\n")}` : m.content;
  };

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
      const body = { messages: history.map((m) => ({ role: m.role, content: withOutcomes(m) })), context: context ? { kind: context.kind, id: context.id } : undefined };
      await sse("/ai/ask", body, (event, data) => {
        if (event === "proposal") patch((m) => ({ ...m, proposals: [...(m.proposals ?? []), data as Proposal] }));
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
        {msgs.length > 0 && <button className="icon-btn" title="New conversation" aria-label="New conversation" onClick={() => { abort.current?.abort(); setMsgs([]); setPstate({}); }}><SquarePen /></button>}
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <div className="panel-body">
        {!msgs.length ? (
          <div style={{ paddingTop: 30 }}>
            <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>{context ? `Ask about this ${context.kind}` : `Ask about anything in ${app.appName}`}</h2>
            <p className="sec" style={{ marginTop: 6, fontSize: 14 }}>
              {context ? "Ask about what's on screen, or anything else in the workspace." : "Answers come from the pages, meetings, tasks and notes you have access to, with links to the sources."}
              {app.me.role !== "guest" && " It can also offer to create tasks, pages or database rows; nothing changes until you confirm."}
            </p>
            {!app.aiReady && <div className="banner warn" style={{ marginTop: 14 }}>Ask AI needs an Anthropic API key, which hasn't been added yet.</div>}
            <div className="suggest">{(context ? CONTEXT_STARTERS[context.kind] : STARTERS).map((s) => <button key={s} onClick={() => ask(s)}>{s}</button>)}</div>
          </div>
        ) : (
          <div className="chat">
            {msgs.map((m, i) => m.role === "user" ? <div key={i} className="msg user">{m.content}</div> : (
              <div key={i} className="msg bot">
                {!!m.steps?.length && <div className="msg-steps">{m.steps.map((s, j) => <div key={j} className="msg-step"><Search />{s}</div>)}</div>}
                {m.content ? <Answer text={m.content} /> : !m.error && !m.proposals?.length && <div className="msg-step"><div className="spin" style={{ width: 13, height: 13 }} />Thinking…</div>}
                {m.proposals?.map((p) => <ProposalCard key={p.id} p={p} state={stateOf(p.id)} onState={(st) => setPstate((all) => ({ ...all, [p.id]: st }))} />)}
                {m.error && <div className="banner warn" style={{ marginTop: 8 }}>{m.error}</div>}
              </div>
            ))}
            <div ref={end} />
          </div>
        )}
      </div>
      <div className="panel-foot">
        {context && <div className="ask-context"><FileText size={13} />About: {context.title || "Untitled"}</div>}
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
