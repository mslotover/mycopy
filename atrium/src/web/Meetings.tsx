import { useQuery } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import { AlertCircle, Check, ChevronDown, ChevronRight, Copy, Headphones, Lock, Mic, MoreHorizontal, Pause, Play, Plus, RotateCw, Send, Sparkles, Trash2, UserPlus, X } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, clock, fmtDuration, invalidate, qc, sse, useMeetings, useTasks, type Knowledge, type MeetingDetail, type MeetingItem, type MeetingListItem, type MeetingStatus, type Participant, type User } from "./api";
import { Toolbar, useShell } from "./App";
import { Editor } from "./Editor";
import { CommentThread } from "./PageView";
import { TaskRow, TaskSheet } from "./Tasks";
import { Avatar, AvatarStack, confirmDialog, Dropdown, Empty, MenuItem, PersonList, PersonPill, Sheet, SpaceBadge, SpaceSelect, Spinner, toast, toastError, useApp, useDebouncedSave } from "./ui";

const SEGMENT_SECONDS = 90;

const STATUS: Record<MeetingStatus, { label: string; cls: string }> = {
  recording: { label: "Recording", cls: "red" }, processing: { label: "Processing", cls: "blue" }, review: { label: "Needs review", cls: "orange" },
  sent: { label: "Sent", cls: "green" }, failed: { label: "Failed", cls: "red" },
};

type Person = { user_id?: string | null; name: string; email: string };

// ---------- List ----------

export function MeetingsView() {
  const app = useApp();
  const shell = useShell();
  const { data, isLoading } = useMeetings();
  const [spaceId, setSpaceId] = useState("");
  const list = (data ?? []).filter((m) => !spaceId || m.space_id === spaceId);
  const months = useMemo(() => {
    const out = new Map<string, MeetingListItem[]>();
    for (const m of list) {
      const k = new Date(m.started_at).toLocaleDateString(undefined, { month: "long", year: "numeric" });
      out.set(k, [...(out.get(k) ?? []), m]);
    }
    return [...out];
  }, [list]);
  return (
    <>
      <Toolbar crumbs={<span className="crumb current">Meetings</span>}>
        <button className="btn primary" onClick={() => shell.openNewMeeting(spaceId || null)}><Mic />Record</button>
      </Toolbar>
      <div className="scroll">
        <div className="column">
          <div className="view-head">
            <div className="grow"><h1 className="h-title">Meetings</h1><p className="h-sub">Recorded, transcribed and summarised. Actions go to each person's task list.</p></div>
            {app.spaces.length > 0 && (
              <select className="field" style={{ width: "auto", height: 30, fontSize: 13 }} value={spaceId} onChange={(e) => setSpaceId(e.target.value)} aria-label="Filter by space">
                <option value="">All spaces</option>
                {app.spaces.map((s) => <option key={s.id} value={s.id}>{s.icon} {s.name}</option>)}
              </select>
            )}
          </div>
          {isLoading ? <Spinner /> : !list.length ? (
            <Empty icon="🎙️" title="No meetings yet">Record a meeting or a call on speaker. You'll get a summary to review before anything is sent.<div><button className="btn primary" onClick={() => shell.openNewMeeting(spaceId || null)}><Mic />Record a meeting</button></div></Empty>
          ) : months.map(([month, items]) => (
            <div key={month} style={{ marginBottom: 22 }}>
              <div className="section-title" style={{ marginLeft: 16 }}>{month}</div>
              {items.map((m) => <MeetingRow key={m.id} m={m} />)}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export function MeetingRow({ m }: { m: MeetingListItem }) {
  const app = useApp();
  const d = new Date(m.started_at);
  const people = m.people.map((p) => app.userById.get(p) ?? { name: p });
  const space = m.space_id ? app.spaceById.get(m.space_id) : null;
  return (
    <Link to={`/meetings/${m.id}`} className="meeting-row">
      <div className="date"><div className="mo">{d.toLocaleDateString(undefined, { month: "short" })}</div><div className="d">{d.getDate()}</div></div>
      <div className="body">
        <div className="ttl">{m.title || "Untitled meeting"}{m.status !== "sent" && <span className={`chip ${STATUS[m.status].cls}`}>{STATUS[m.status].label}</span>}</div>
        {m.preview && <div className="pv">{m.preview}</div>}
        <div className="ft">
          <AvatarStack users={people} size={18} />
          <span>{d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}{m.duration_s ? ` · ${fmtDuration(m.duration_s)}` : ""}</span>
          {space && <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}><SpaceBadge space={space} size={15} />{space.name}</span>}
        </div>
      </div>
    </Link>
  );
}

// ---------- New meeting ----------

function PeopleEditor({ people, onChange, lockedId }: { people: Person[]; onChange: (p: Person[]) => void; lockedId?: string }) {
  const app = useApp();
  const [ext, setExt] = useState<{ name: string; email: string } | null>(null);
  const ids = people.map((p) => p.user_id).filter(Boolean) as string[];
  const addExt = () => {
    if (!ext?.name.trim()) return;
    onChange([...people, { name: ext.name.trim(), email: ext.email.trim() }]);
    setExt(null);
  };
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {people.map((p, i) => {
          const u = p.user_id ? app.userById.get(p.user_id) : null;
          return (
            <span key={i} className="chip" style={{ height: 28, paddingLeft: 4 }}>
              <Avatar user={u} name={p.name} size={20} />{u?.name ?? p.name}{!u && <span className="muted">· outside</span>}
              {p.user_id !== lockedId && <button className="icon-btn sm" style={{ width: 16, height: 16 }} aria-label={`Remove ${p.name}`} onClick={() => onChange(people.filter((_, j) => j !== i))}><X /></button>}
            </span>
          );
        })}
      </div>
      {ext ? (
        <div style={{ display: "flex", gap: 6 }}>
          <input className="field" placeholder="Name" autoFocus value={ext.name} onChange={(e) => setExt({ ...ext, name: e.target.value })} />
          <input className="field" type="email" placeholder="Email (to send them the summary)" value={ext.email} onChange={(e) => setExt({ ...ext, email: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") addExt(); }} />
          <button className="btn primary" style={{ height: 36 }} onClick={addExt} disabled={!ext.name.trim()}>Add</button>
          <button className="btn" style={{ height: 36 }} onClick={() => setExt(null)}>Cancel</button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6 }}>
          <Dropdown width={260} trigger={({ onClick }) => <button className="btn" onClick={onClick}><UserPlus />Add people</button>}>
            {() => <PersonList multi value={ids} users={app.users.filter((u) => u.id !== lockedId)} onPick={(id) => { if (!id) return; onChange(ids.includes(id) ? people.filter((p) => p.user_id !== id) : [...people, { user_id: id, name: app.userById.get(id)!.name, email: app.userById.get(id)!.email }]); }} />}
          </Dropdown>
          <button className="btn quiet" onClick={() => setExt({ name: "", email: "" })}>Someone outside the team</button>
        </div>
      )}
    </div>
  );
}

export function NewMeetingSheet({ spaceId, onClose }: { spaceId: string | null; onClose: () => void }) {
  const app = useApp();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [space, setSpace] = useState<string | null>(spaceId ?? null);
  const [people, setPeople] = useState<Person[]>([{ user_id: app.me.id, name: app.me.name, email: app.me.email }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const recording = useRecording();
  const start = async () => {
    if (recording.phase !== "idle") { setErr(`“${recording.title || "Another meeting"}” is still recording. Finish it before starting a new one.`); return; }
    setBusy(true);
    setErr("");
    try {
      // Ask for the microphone before creating anything, so a refusal is explained here.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      setErr("Microphone access was blocked. Allow it for this site in your browser's settings, then try again.");
      setBusy(false);
      return;
    }
    try {
      const { id } = await api<{ id: string }>("/meetings", { body: { title, space_id: space, participants: people.filter((p) => p.user_id !== app.me.id) } });
      invalidate("meetings");
      onClose();
      navigate(`/meetings/${id}`, { state: { autostart: true } });
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't start the meeting."); setBusy(false); }
  };
  return (
    <Sheet title="Record a meeting" onClose={onClose} wide footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy} onClick={start}><Mic />{busy ? "Starting…" : "Start recording"}</button>
    </>}>
      <div className="form-row"><label className="label">Title</label><input className="field" placeholder="e.g. Weekly bakery meeting" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="form-row"><label className="label">Business</label><SpaceSelect value={space} onChange={setSpace} privateLabel="None (private to participants)" /></div>
      <div className="form-row"><label className="label">Who's in the meeting</label><PeopleEditor people={people} onChange={setPeople} lockedId={app.me.id} /></div>
      <p className="muted" style={{ fontSize: 12.5 }}>Let everyone know the meeting is being recorded. Nothing is sent to anyone until you've reviewed the summary.</p>
      {err && <div className="banner warn" style={{ marginTop: 12 }}><AlertCircle />{err}</div>}
    </Sheet>
  );
}

// ---------- Recording ----------

type RecPhase = "idle" | "recording" | "paused" | "finishing";

/** Whether this browser can share another tab's sound (desktop Chrome, Edge and their relatives). */
const CAN_SHARE_CALL = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && !/Mobi|Android|iPhone|iPad/.test(navigator.userAgent) && /Chrome|Chromium|Edg\//.test(navigator.userAgent);

/**
 * The recorder lives at the top of the app, not on the meeting page, so moving around the
 * workspace during a meeting doesn't stop it. One recording at a time.
 */
function useRecorder(onFinished: (meetingId: string) => void) {
  const [phase, setPhase] = useState<RecPhase>("idle");
  const [meetingId, setMeetingId] = useState("");
  const [title, setTitle] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(56).fill(0));
  const [pending, setPending] = useState(0);
  const [error, setError] = useState("");
  const [call, setCall] = useState(false);
  const r = useRef({ mic: null as MediaStream | null, shared: null as MediaStream | null, analyser: null as AnalyserNode | null, stream: null as MediaStream | null, rec: null as MediaRecorder | null, meetingId: "", idx: 0, active: 0, segStart: 0, last: 0, timer: 0 as any, ctx: null as AudioContext | null, wake: null as any, queue: Promise.resolve(), inflight: 0, mime: "" });

  const upload = (idx: number, blob: Blob) => {
    const s = r.current;
    const meetingId = s.meetingId;
    s.inflight++;
    setPending(s.inflight);
    s.queue = s.queue.then(async () => {
      // Keep trying: a flaky connection shouldn't lose part of the meeting.
      for (let attempt = 0; ; attempt++) {
        try { await api(`/meetings/${meetingId}/segments/${idx}`, { method: "PUT", raw: blob }); break; } catch (e) {
          if (e instanceof ApiError && e.status >= 400 && e.status < 500) { setError(e.message); break; }
          await new Promise((res) => setTimeout(res, Math.min(15000, 1000 * 2 ** attempt)));
        }
      }
      s.inflight--;
      setPending(s.inflight);
    });
  };

  const startSegment = () => {
    const s = r.current;
    if (!s.stream) return;
    const rec = new MediaRecorder(s.stream, s.mime ? { mimeType: s.mime, audioBitsPerSecond: 40_000 } : { audioBitsPerSecond: 40_000 });
    const idx = s.idx++;
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => { const blob = new Blob(chunks, { type: rec.mimeType || s.mime || "audio/webm" }); if (blob.size > 200) upload(idx, blob); };
    rec.start();
    s.rec = rec;
    s.segStart = s.active;
  };

  const start = async (id: string, firstIdx: number, name: string) => {
    const s = r.current;
    if (s.stream) return; // already recording
    s.meetingId = id;
    s.idx = firstIdx;
    s.active = 0;
    s.segStart = 0;
    setMeetingId(id);
    setTitle(name);
    setSeconds(0);
    setLevels(Array(56).fill(0));
    setCall(false);
    setError("");
    try {
      s.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      setError("Microphone access was blocked. Allow it for this site in your browser's settings.");
      return;
    }
    s.mic = s.stream;
    s.mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    startSegment();
    // Level meter
    try {
      s.ctx = new AudioContext();
      const analyser = s.ctx.createAnalyser();
      analyser.fftSize = 256;
      s.ctx.createMediaStreamSource(s.stream).connect(analyser);
      s.analyser = analyser;
      const data = new Uint8Array(analyser.fftSize);
      (s as any).sample = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        return Math.min(1, peak / 70);
      };
    } catch { /* the meter is optional */ }
    try { s.wake = await (navigator as any).wakeLock?.request("screen"); } catch { /* optional */ }
    s.last = performance.now();
    s.timer = setInterval(() => {
      const t = performance.now();
      if (s.rec?.state === "recording") {
        s.active += (t - s.last) / 1000;
        setSeconds(Math.floor(s.active));
        setLevels((l) => [...l.slice(1), (s as any).sample?.() ?? 0.2]);
        // Start the next segment before stopping the current one so no audio falls between them.
        if (s.active - s.segStart >= SEGMENT_SECONDS) { const old = s.rec; startSegment(); old.stop(); }
      }
      s.last = t;
    }, 100);
    setPhase("recording");
  };

  /** Swaps what is being recorded, starting a fresh segment so nothing is lost at the join. */
  const switchTo = (stream: MediaStream) => {
    const s = r.current;
    const old = s.rec;
    const wasPaused = old?.state === "paused";
    s.stream = stream;
    startSegment();
    if (wasPaused) s.rec?.pause();
    if (old && old.state !== "inactive") old.stop();
  };

  /**
   * Adds the sound of a call in another tab to the recording. With headphones on, the other
   * people never reach the microphone, so the browser is asked to share that tab's audio
   * and it is mixed with the mic. Must be called from a click.
   */
  const addCall = async () => {
    const s = r.current;
    if (!s.mic || s.shared) return;
    setError("");
    let shared: MediaStream;
    try {
      shared = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 }, // the browser insists on video; it is never recorded
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: "include",
      } as DisplayMediaStreamOptions);
    } catch {
      return; // the picker was cancelled
    }
    const audio = shared.getAudioTracks();
    if (!audio.length) {
      shared.getTracks().forEach((t) => t.stop());
      setError("No call audio came through. Choose the tab your call is in, and keep “Also share tab audio” switched on.");
      return;
    }
    try {
      const ctx = s.ctx ?? (s.ctx = new AudioContext());
      await ctx.resume();
      const mix = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(s.mic).connect(mix);
      const theirs = ctx.createMediaStreamSource(new MediaStream(audio));
      theirs.connect(mix);
      if (s.analyser) theirs.connect(s.analyser);
      s.shared = shared;
      // If sharing is stopped from the browser's own bar, carry on with the microphone alone.
      audio[0].addEventListener("ended", () => {
        if (s.shared !== shared) return;
        shared.getTracks().forEach((t) => t.stop());
        s.shared = null;
        setCall(false);
        if (s.mic) { switchTo(s.mic); toast("Call audio stopped. Still recording your microphone."); }
      });
      switchTo(mix.stream);
      setCall(true);
    } catch {
      shared.getTracks().forEach((t) => t.stop());
      setError("The call's audio couldn't be added. Your microphone is still recording.");
    }
  };

  const pause = () => { r.current.rec?.pause(); setPhase("paused"); };
  const resume = () => { r.current.rec?.resume(); setPhase("recording"); };

  const release = () => {
    const s = r.current;
    clearInterval(s.timer);
    for (const media of [s.stream, s.mic, s.shared]) media?.getTracks().forEach((t) => t.stop());
    s.mic = null;
    s.shared = null;
    s.ctx?.close().catch(() => {});
    s.wake?.release?.().catch(() => {});
    s.stream = null;
  };

  /** Stops and uploads. `id` lets an interrupted recording be finished without restarting it. */
  const finish = async (knownSeconds = 0, id?: string) => {
    const s = r.current;
    if (id) { s.meetingId = id; setMeetingId(id); }
    const meetingId = s.meetingId;
    setPhase("finishing");
    if (s.rec && s.rec.state !== "inactive") {
      await new Promise<void>((res) => { s.rec!.addEventListener("stop", () => res(), { once: true }); s.rec!.stop(); });
    }
    release();
    await new Promise((res) => setTimeout(res, 50));
    await s.queue;
    try {
      await api(`/meetings/${meetingId}/finish`, { body: { duration_s: Math.round(s.active) || knownSeconds } });
      s.meetingId = "";
      setMeetingId("");
      setPhase("idle");
      onFinished(meetingId);
    } catch (e) { toastError(e); setPhase("idle"); }
  };

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (r.current.stream) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); if (r.current.rec?.state !== "inactive") r.current.rec?.stop(); release(); };
  }, []);

  return { phase, meetingId, title, seconds, levels, pending, error, call, start, addCall, pause, resume, finish };
}

type Recording = ReturnType<typeof useRecorder>;
const RecordingCtx = createContext<Recording | null>(null);
export const useRecording = () => useContext(RecordingCtx)!;

/** Holds the one recorder for the whole app. Put it inside the router, around everything signed in. */
export function RecordingProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const rec = useRecorder((id) => {
    qc.invalidateQueries({ queryKey: ["meeting", id] });
    invalidate("meetings");
    navigate(`/meetings/${id}`); // the summary is made from the meeting's page
  });
  return <RecordingCtx.Provider value={rec}>{children}</RecordingCtx.Provider>;
}

/** A small bar that follows you around the app while a meeting records elsewhere. */
export function RecordingBar() {
  const rec = useRecording();
  const loc = useLocation();
  const navigate = useNavigate();
  if (rec.phase === "idle" || loc.pathname === `/meetings/${rec.meetingId}`) return null;
  const paused = rec.phase === "paused";
  return (
    <div className="rec-bar" role="status">
      <button className="rec-bar-main" onClick={() => navigate(`/meetings/${rec.meetingId}`)} title="Back to the recording">
        <span className={`rec-state ${paused ? "paused" : ""}`}><i /></span>
        <span className="rec-bar-time">{clock(rec.seconds)}</span>
        <span className="rec-bar-title">{rec.phase === "finishing" ? "Saving…" : paused ? `Paused · ${rec.title || "Meeting"}` : rec.title || "Recording"}</span>
      </button>
      {rec.phase !== "finishing" && (<>
        <button className="icon-btn" onClick={paused ? rec.resume : rec.pause} aria-label={paused ? "Resume" : "Pause"}>{paused ? <Play /> : <Pause />}</button>
        <button className="rec-stop sm" onClick={() => rec.finish()} aria-label="Finish recording" title="Finish recording"><i /></button>
      </>)}
    </div>
  );
}

function Recorder({ detail }: { detail: MeetingDetail }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const m = detail.meeting;
  const saved = detail.segments.length;
  const nextIdx = saved ? Math.max(...detail.segments.map((s) => s.idx)) + 1 : 0;
  const recording = useRecording();
  const mine = recording.meetingId === m.id;
  const elsewhere = recording.phase !== "idle" && !mine;
  // This page shows the app-wide recorder when it is recording this meeting.
  const rec = { ...recording, phase: mine ? recording.phase : ("idle" as RecPhase), error: mine ? recording.error : "", start: () => recording.start(m.id, nextIdx, m.title) };
  const started = useRef(false);
  useEffect(() => {
    if ((loc.state as any)?.autostart && !started.current) { started.current = true; if (!elsewhere) rec.start(); navigate(loc.pathname, { replace: true, state: null }); }
  }, []);
  const discard = async () => {
    if (!(await confirmDialog({ title: "Discard this recording?", body: "The audio recorded so far will be deleted.", action: "Discard", danger: true }))) return;
    try { await api(`/meetings/${m.id}`, { method: "DELETE" }); invalidate("meetings"); navigate("/meetings"); } catch (e) { toastError(e); }
  };

  if (elsewhere) {
    return (
      <div className="recorder">
        <div style={{ fontSize: 44 }}>🎙️</div>
        <h2 className="h-title" style={{ marginTop: 8 }}>{m.title || "Untitled meeting"}</h2>
        <p className="h-sub" style={{ maxWidth: 420 }}>“{recording.title || "Another meeting"}” is recording. Finish it before recording this one.</p>
        <div className="rec-actions" style={{ marginTop: 24 }}><Link className="btn lg pill" to={`/meetings/${recording.meetingId}`}>Go to the recording</Link></div>
      </div>
    );
  }
  if (rec.phase === "idle") {
    return (
      <div className="recorder">
        <div style={{ fontSize: 44 }}>🎙️</div>
        <h2 className="h-title" style={{ marginTop: 8 }}>{m.title || "Untitled meeting"}</h2>
        <p className="h-sub" style={{ maxWidth: 420 }}>{saved ? "This recording was interrupted. The audio captured so far is safe. Carry on recording, or finish and get the summary." : "Ready when you are."}</p>
        {rec.error && <div className="banner warn" style={{ marginTop: 16 }}><AlertCircle />{rec.error}</div>}
        <div className="rec-actions" style={{ marginTop: 24 }}>
          <button className="btn lg pill primary" onClick={rec.start}><Mic />{saved ? "Continue recording" : "Start recording"}</button>
          {saved > 0 && <button className="btn lg pill" onClick={() => recording.finish(saved * SEGMENT_SECONDS, m.id)}>Finish and summarise</button>}
        </div>
        <button className="btn quiet danger" style={{ marginTop: 18 }} onClick={discard}>Discard</button>
      </div>
    );
  }
  return (
    <div className="recorder">
      <div className={`rec-state ${rec.phase === "paused" ? "paused" : ""}`}><i />{rec.phase === "paused" ? "Paused" : rec.phase === "finishing" ? "Saving" : "Recording"}</div>
      <div className="rec-time">{clock(rec.seconds)}</div>
      <div style={{ fontSize: 17, fontWeight: 500, marginTop: 10 }}>{m.title || "Untitled meeting"}</div>
      <div className="wave" aria-hidden>{rec.levels.map((l, i) => <i key={i} style={{ height: `${Math.max(4, (rec.phase === "recording" ? l : 0.02) * 100)}%`, opacity: 0.35 + (i / rec.levels.length) * 0.65 }} />)}</div>
      {rec.phase === "finishing" ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }} className="sec"><div className="spin" />Uploading the last of the audio…</div>
      ) : (
        <div className="rec-actions">
          <button className="btn lg pill" onClick={rec.phase === "paused" ? rec.resume : rec.pause} style={{ minWidth: 118 }}>{rec.phase === "paused" ? <><Play />Resume</> : <><Pause />Pause</>}</button>
          <button className="rec-stop" onClick={() => rec.finish()} aria-label="Finish recording" title="Finish recording"><i /></button>
          <span style={{ minWidth: 118, textAlign: "left" }} className="muted">{rec.pending > 0 ? "Saving audio…" : rec.seconds >= SEGMENT_SECONDS ? "Audio saved as you go" : ""}</span>
        </div>
      )}
      {rec.phase !== "finishing" && CAN_SHARE_CALL && (rec.call
        ? <div className="chip green" style={{ marginTop: 18 }}><Headphones />Recording your microphone and the call</div>
        : <button className="btn pill" style={{ marginTop: 18 }} onClick={rec.addCall}><Headphones />On a call? Add its audio</button>)}
      {rec.error && <div className="banner warn" style={{ marginTop: 18 }}><AlertCircle />{rec.error}</div>}
      <p className="rec-hint">{CAN_SHARE_CALL && !rec.call ? "On a video call with headphones, only your own voice reaches the microphone. Add the call's audio so everyone is transcribed. " : ""}You can use the rest of Atrium while this records. Keep this tab open, and press the red button when the meeting ends to get the summary.</p>
    </div>
  );
}

// ---------- Processing ----------

function Processing({ detail, onDone }: { detail: MeetingDetail; onDone: () => void }) {
  const m = detail.meeting;
  const navigate = useNavigate();
  const [stage, setStage] = useState<{ stage: "transcribing" | "summarising"; done?: number; total?: number }>({ stage: "transcribing" });
  const [error, setError] = useState(m.status === "failed" ? m.error ?? "Processing failed." : "");
  const running = useRef(false);
  const run = async () => {
    if (running.current) return;
    running.current = true;
    setError("");
    setStage({ stage: "transcribing" });
    try {
      let failed = "";
      await sse(`/meetings/${m.id}/process`, {}, (event, data) => {
        if (event === "progress") setStage(data);
        if (event === "error") failed = data.message;
      });
      if (failed) setError(failed);
      else onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Processing was interrupted.");
    }
    running.current = false;
  };
  useEffect(() => { if (m.status === "processing") run(); }, []);
  const remove = async () => {
    if (!(await confirmDialog({ title: "Delete this meeting?", body: "The recording and anything produced from it will be deleted.", action: "Delete", danger: true }))) return;
    try { await api(`/meetings/${m.id}`, { method: "DELETE" }); invalidate("meetings"); navigate("/meetings"); } catch (e) { toastError(e); }
  };

  if (error) {
    return (
      <div className="recorder">
        <div style={{ fontSize: 44 }}>⚠️</div>
        <h2 className="h-title" style={{ marginTop: 8 }}>The summary couldn't be made</h2>
        <p className="h-sub" style={{ maxWidth: 460 }}>{error} The recording itself is safe.</p>
        <div className="rec-actions" style={{ marginTop: 22 }}>
          <button className="btn lg pill primary" onClick={run}><RotateCw />Try again</button>
          <button className="btn lg pill danger" onClick={remove}>Delete meeting</button>
        </div>
      </div>
    );
  }
  const t = stage.stage === "transcribing";
  const pct = t && stage.total ? Math.round(((stage.done ?? 0) / stage.total) * 100) : 0;
  return (
    <div className="recorder">
      <div className="spin" style={{ width: 30, height: 30, borderWidth: 3 }} />
      <h2 className="h-title" style={{ marginTop: 18 }}>Working on “{m.title || "your meeting"}”</h2>
      <p className="h-sub">This usually takes a minute or two. You can leave this page; it'll be waiting in Meetings.</p>
      <div className="steps">
        <div className="step ok"><span className="mark"><Check /></span>Recording saved</div>
        <div className={`step ${t ? "on" : "ok"}`}>
          <span className="mark">{t ? <div className="spin" /> : <Check />}</span>
          <div style={{ flex: 1 }}>Transcribing{t && stage.total ? ` · ${stage.done ?? 0} of ${stage.total}` : ""}{t && stage.total ? <div className="progress"><i style={{ width: `${pct}%` }} /></div> : null}</div>
        </div>
        <div className={`step ${t ? "" : "on"}`}><span className="mark">{t ? <span className="o" /> : <div className="spin" />}</span>Writing the summary and picking out actions</div>
        <div className="step"><span className="mark"><span className="o" /></span>Ready for your review</div>
      </div>
    </div>
  );
}

// ---------- Review ----------

function Review({ detail, refetch }: { detail: MeetingDetail; refetch: () => void }) {
  const app = useApp();
  const m = detail.meeting;
  const [items, setItems] = useState<MeetingItem[]>(detail.items);
  const [people, setPeople] = useState<Participant[]>(detail.participants);
  const [sending, setSending] = useState(false);
  const summary = useRef<{ doc: any; html: string } | null>(null);
  const saveSummary = useDebouncedSave<{ doc: any; html: string }>((s) => api(`/meetings/${m.id}`, { method: "PATCH", body: { summary_doc: s.doc, summary_html: s.html } }).catch(toastError), 900);

  const patchItem = (id: string, patch: { accepted?: boolean; payload?: Record<string, any> }) => {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...(patch.accepted !== undefined ? { accepted: patch.accepted } : {}), payload: { ...i.payload, ...(patch.payload ?? {}) } } : i)));
    api(`/meetings/${m.id}/items/${id}`, { method: "PATCH", body: patch }).catch(toastError);
  };
  const addItem = async (kind: "task" | "knowledge") => {
    const payload = kind === "task" ? { title: "", assignee_id: app.me.id, owner_name: null, due: null, context: "", needs_owner: false, duplicate_of: null } : { kind: "fact", title: "", body: "" };
    try { const { id } = await api<{ id: string }>(`/meetings/${m.id}/items`, { body: { kind, payload } }); setItems((l) => [...l, { id, kind, accepted: true, payload }]); } catch (e) { toastError(e); }
  };
  const removeItem = (id: string) => { setItems((l) => l.filter((i) => i.id !== id)); api(`/meetings/${m.id}/items/${id}`, { method: "DELETE" }).catch(toastError); };
  const savePeople = (next: Participant[]) => { setPeople(next); api(`/meetings/${m.id}`, { method: "PATCH", body: { participants: next } }).catch(toastError); };

  const tasks = items.filter((i) => i.kind === "task");
  const notes = items.filter((i) => i.kind === "knowledge");
  const nTasks = tasks.filter((i) => i.accepted && i.payload.title?.trim()).length;
  const recipients = people.filter((p) => p.notify && p.email);
  const space = m.space_id ? app.spaceById.get(m.space_id) : null;

  const send = async () => {
    const ok = await confirmDialog({
      title: recipients.length ? `Send to ${recipients.length} ${recipients.length === 1 ? "person" : "people"}?` : "Finish without emailing anyone?",
      body: `${recipients.length ? `The summary will be emailed to ${recipients.map((p) => p.name || p.email).join(", ")}. ` : ""}${nTasks} task${nTasks === 1 ? "" : "s"} will be added to people's lists${notes.some((n) => n.accepted) ? ", and the notes will be filed in the Brain" : ""}.${space ? ` Everyone in ${space.name} will be able to see the meeting.` : ""}`,
      action: recipients.length ? "Send" : "Finish",
    });
    if (!ok) return;
    setSending(true);
    try {
      await saveSummary.flush();
      const res = await api<{ tasks: number; emails: number }>(`/meetings/${m.id}/send`, { body: summary.current ? { summary_doc: summary.current.doc, summary_html: summary.current.html } : {} });
      toast(`Sent to ${res.emails} · ${res.tasks} task${res.tasks === 1 ? "" : "s"} created`);
      invalidate("meetings", "tasks", "knowledge", "boot");
      refetch();
    } catch (e) { toastError(e); setSending(false); }
  };

  return (
    <>
      <div className="scroll">
        <div className="column wide">
          <div className="banner" style={{ background: "var(--orange-soft)", color: "var(--orange)" }}><AlertCircle />Check the summary and actions below. Nothing has been sent yet.</div>
          <MeetingHead detail={detail} editable />
          <div className="review">
            <div>
              <div className="section-title">Summary</div>
              <Editor content={m.summary_doc ?? { html: m.summary_html }} users={app.users} compact onChange={(doc, html) => { summary.current = { doc, html }; saveSummary.schedule({ doc, html }); }} />
              <Transcript text={m.transcript} />
            </div>
            <div>
              <div className="section-title">Actions · {nTasks}</div>
              {tasks.map((i) => (
                <div key={i.id} className={`review-item ${i.accepted ? "" : "off"}`}>
                  <input type="checkbox" className="check" checked={i.accepted} onChange={(e) => patchItem(i.id, { accepted: e.target.checked })} aria-label="Create this task" />
                  <div className="body">
                    <input className="bare" placeholder="What needs doing?" defaultValue={i.payload.title} onBlur={(e) => e.target.value !== i.payload.title && patchItem(i.id, { payload: { title: e.target.value } })} />
                    <textarea className="bare" rows={i.payload.context ? 2 : 1} placeholder="Context" defaultValue={i.payload.context} onBlur={(e) => e.target.value !== i.payload.context && patchItem(i.id, { payload: { context: e.target.value } })} />
                    <div className="ctl">
                      <PersonPill id={i.payload.assignee_id} allowNone={false} onChange={(v) => patchItem(i.id, { payload: { assignee_id: v, needs_owner: false, owner_name: null } })} />
                      <label className="chip"><input type="date" className="bare" style={{ width: i.payload.due ? 112 : 92, fontSize: 12 }} value={i.payload.due ?? ""} onChange={(e) => patchItem(i.id, { payload: { due: e.target.value || null } })} aria-label="Due date" /></label>
                      {i.payload.needs_owner && <span className="chip orange" title="Assigned to you until you choose someone"><AlertCircle />{i.payload.owner_name ? `Mentioned: ${i.payload.owner_name}` : "Owner unclear"}</span>}
                      {i.payload.duplicate_of && <span className="chip purple" title="An open task already looks like this one"><Copy />Possible duplicate</span>}
                      <button className="icon-btn sm" style={{ marginLeft: "auto" }} onClick={() => removeItem(i.id)} aria-label="Remove"><X /></button>
                    </div>
                  </div>
                </div>
              ))}
              <button className="db-add" onClick={() => addItem("task")}><Plus />Add an action</button>

              <div className="section-title" style={{ marginTop: 26 }}>For the Brain · {notes.filter((n) => n.accepted).length}</div>
              {notes.map((i) => (
                <div key={i.id} className={`review-item ${i.accepted ? "" : "off"}`}>
                  <input type="checkbox" className="check" checked={i.accepted} onChange={(e) => patchItem(i.id, { accepted: e.target.checked })} aria-label="Keep this note" />
                  <div className="body">
                    <input className="bare" placeholder="Headline" defaultValue={i.payload.title} onBlur={(e) => e.target.value !== i.payload.title && patchItem(i.id, { payload: { title: e.target.value } })} />
                    <textarea className="bare" rows={3} placeholder="What should be remembered?" defaultValue={i.payload.body} onBlur={(e) => e.target.value !== i.payload.body && patchItem(i.id, { payload: { body: e.target.value } })} />
                    <div className="ctl">
                      <select className="chip" style={{ border: 0 }} value={i.payload.kind} onChange={(e) => patchItem(i.id, { payload: { kind: e.target.value } })} aria-label="Kind">
                        {KINDS.map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
                      </select>
                      <button className="icon-btn sm" style={{ marginLeft: "auto" }} onClick={() => removeItem(i.id)} aria-label="Remove"><X /></button>
                    </div>
                  </div>
                </div>
              ))}
              <button className="db-add" onClick={() => addItem("knowledge")}><Plus />Add a note</button>

              <div className="section-title" style={{ marginTop: 26 }}>Send the summary to</div>
              {people.map((p) => (
                <div className="person-line" key={p.id}>
                  <Avatar user={p.user_id ? app.userById.get(p.user_id) : null} name={p.name} size={28} />
                  <div className="nm"><div>{p.name || p.email}</div><span>{p.email || "No email address, so nothing will be sent"}</span></div>
                  <input type="checkbox" className="switch" checked={p.notify && !!p.email} disabled={!p.email} onChange={(e) => savePeople(people.map((x) => (x.id === p.id ? { ...x, notify: e.target.checked } : x)))} aria-label={`Email ${p.name}`} />
                </div>
              ))}
              <AddParticipant onAdd={(np) => api(`/meetings/${m.id}`, { method: "PATCH", body: { participants: [...people, np] } }).then(refetch).catch(toastError)} existing={people} />
            </div>
          </div>
        </div>
        <div className="send-bar">
          <span className="grow">{recipients.length ? `Emails ${recipients.length} ${recipients.length === 1 ? "person" : "people"}` : "No one will be emailed"} · creates {nTasks} task{nTasks === 1 ? "" : "s"}</span>
          <button className="btn primary lg pill" disabled={sending} onClick={send}><Send />{sending ? "Sending…" : recipients.length ? "Send summary" : "Finish"}</button>
        </div>
      </div>
    </>
  );
}

const KINDS = ["decision", "fact", "process", "contact", "idea", "risk"];

function AddParticipant({ onAdd, existing }: { onAdd: (p: Person & { notify: boolean }) => void; existing: Participant[] }) {
  const app = useApp();
  const [ext, setExt] = useState<{ name: string; email: string } | null>(null);
  const have = new Set(existing.map((p) => p.user_id));
  if (ext) {
    return (
      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        <input className="field" style={{ flex: 1, minWidth: 120 }} placeholder="Name" autoFocus value={ext.name} onChange={(e) => setExt({ ...ext, name: e.target.value })} />
        <input className="field" style={{ flex: 1.4, minWidth: 160 }} type="email" placeholder="Email" value={ext.email} onChange={(e) => setExt({ ...ext, email: e.target.value })} />
        <button className="btn primary" style={{ height: 36 }} disabled={!ext.name.trim()} onClick={() => { onAdd({ ...ext, notify: true }); setExt(null); }}>Add</button>
        <button className="btn" style={{ height: 36 }} onClick={() => setExt(null)}>Cancel</button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
      <Dropdown width={260} trigger={({ onClick }) => <button className="btn" onClick={onClick}><UserPlus />Add</button>}>
        {(close) => <PersonList value={[]} users={app.users.filter((u) => !have.has(u.id))} onPick={(id) => { const u = id && app.userById.get(id); if (u) onAdd({ user_id: u.id, name: u.name, email: u.email, notify: true }); close(); }} />}
      </Dropdown>
      <button className="btn quiet" onClick={() => setExt({ name: "", email: "" })}>Someone outside the team</button>
    </div>
  );
}

function Transcript({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div style={{ marginTop: 28 }}>
      <button className="btn quiet" style={{ marginLeft: -8 }} onClick={() => setOpen((o) => !o)}><ChevronRight style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 200ms" }} />Transcript</button>
      {open && <div className="transcript" style={{ marginTop: 10 }}>{text}</div>}
    </div>
  );
}

function MeetingHead({ detail, editable }: { detail: MeetingDetail; editable?: boolean }) {
  const app = useApp();
  const m = detail.meeting;
  const d = new Date(m.started_at);
  const space = m.space_id ? app.spaceById.get(m.space_id) : null;
  const people = detail.participants.map((p) => (p.user_id && app.userById.get(p.user_id)) || { name: p.name || p.email });
  const moveTo = (space_id: string | null) => {
    if (space_id === m.space_id) return;
    api(`/meetings/${m.id}`, { method: "PATCH", body: { space_id } })
      .then(() => { invalidate("meeting", "meetings"); toast(space_id ? `Shared with ${app.spaceById.get(space_id)?.name ?? "the space"}` : "Now private to the people in it"); })
      .catch(toastError);
  };
  return (
    <div style={{ marginBottom: 22 }}>
      {editable
        ? <input className="bare h-title" style={{ fontSize: 30 }} placeholder="Untitled meeting" defaultValue={m.title} onBlur={(e) => { if (e.target.value !== m.title) api(`/meetings/${m.id}`, { method: "PATCH", body: { title: e.target.value } }).then(() => invalidate("meetings")).catch(toastError); }} />
        : <h1 className="h-title" style={{ fontSize: 30 }}>{m.title || "Untitled meeting"}</h1>}
      <div className="page-meta" style={{ marginTop: 8 }}>
        <span>{d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · {d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}{m.duration_s ? ` · ${fmtDuration(m.duration_s)}` : ""}</span>
        {m.organizer_id === app.user.id ? (
          <Dropdown width={250} trigger={({ onClick }) => (
            <button className="chip" onClick={onClick} title="Who can see this meeting">
              {space ? <><SpaceBadge space={space} size={14} />{space.name}</> : <><Lock />Private</>}<ChevronDown />
            </button>
          )}>
            {(close) => (<>
              <MenuItem icon={<Lock size={15} />} active={!m.space_id} sub="Only the people in the meeting" onClick={() => { moveTo(null); close(); }}>Private</MenuItem>
              {app.spaces.map((s) => <MenuItem key={s.id} icon={<SpaceBadge space={s} size={16} />} active={m.space_id === s.id} onClick={() => { moveTo(s.id); close(); }}>{s.name}</MenuItem>)}
            </>)}
          </Dropdown>
        ) : space && <Link to={`/space/${space.id}`} className="chip"><SpaceBadge space={space} size={14} />{space.name}</Link>}
        <AvatarStack users={people as (User | { name: string })[]} max={8} />
      </div>
    </div>
  );
}

// ---------- A finished meeting ----------

function Sent({ detail }: { detail: MeetingDetail }) {
  const app = useApp();
  const m = detail.meeting;
  const [openTask, setOpenTask] = useState<string | null>(null);
  const { data: tasks } = useTasks(`meeting:${m.id}`);
  const { data: notes } = useQuery({ queryKey: ["knowledge"], queryFn: () => api<{ knowledge: Knowledge[] }>("/knowledge").then((r) => r.knowledge) });
  const mine = (notes ?? []).filter((n) => n.meeting_id === m.id);
  const html = useMemo(() => DOMPurify.sanitize(m.summary_html), [m.summary_html]);
  return (
    <div className="scroll">
      <div className="column">
        <MeetingHead detail={detail} />
        <div className="prose" style={{ minHeight: 0 }} dangerouslySetInnerHTML={{ __html: html }} />
        {tasks && tasks.length > 0 && (
          <div style={{ marginTop: 30 }}>
            <div className="section-title">Actions</div>
            {tasks.map((t) => <TaskRow key={t.id} task={t} onOpen={setOpenTask} showAssignee />)}
          </div>
        )}
        {m.organizer_id === app.user.id && (
          <div style={{ marginTop: 30 }}>
            <div className="section-title">Send the summary to someone else</div>
            <p className="sec" style={{ margin: "0 0 2px" }}>They are added to this meeting and emailed the summary and actions.</p>
            <AddParticipant existing={detail.participants} onAdd={(p) => api<{ emailed: boolean; name: string }>(`/meetings/${m.id}/share`, { body: p })
              .then((r) => { invalidate("meeting", "meetings"); toast(r.emailed ? `Summary sent to ${r.name}` : `${r.name} was added, but the email could not be sent`); })
              .catch(toastError)} />
          </div>
        )}
        {mine.length > 0 && (
          <div style={{ marginTop: 30 }}>
            <div className="section-title">Added to the Brain</div>
            <div className="grid">{mine.map((n) => <div key={n.id} className="note"><span className="chip" style={{ alignSelf: "flex-start" }}>{n.kind}</span><h4>{n.title}</h4><p>{n.body}</p></div>)}</div>
          </div>
        )}
        <Transcript text={m.transcript} />
        <div style={{ marginTop: 30 }}>
          <div className="section-title">Comments</div>
          <CommentThread kind="meeting" id={m.id} compact />
        </div>
      </div>
      {openTask && <TaskSheet id={openTask} onClose={() => setOpenTask(null)} />}
    </div>
  );
}

// ---------- Route ----------

export function MeetingView() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const app = useApp();
  const shell = useShell();
  const { data, error, isLoading, refetch } = useQuery({ queryKey: ["meeting", id], queryFn: () => api<MeetingDetail>(`/meetings/${id}`), refetchOnWindowFocus: false });
  const again = () => { qc.invalidateQueries({ queryKey: ["meeting", id] }); invalidate("meetings"); };
  if (isLoading) return (<><Toolbar /><Spinner /></>);
  if (error || !data) {
    const denied = error instanceof ApiError && error.status === 403;
    return (<><Toolbar /><div className="center"><Empty icon={denied ? "🔒" : "🫥"} title={denied ? "You can't open this meeting" : "This meeting doesn't exist"}>{denied && "It's shared with participants once its summary has been sent."}<div><Link className="btn" to="/meetings">All meetings</Link></div></Empty></div></>);
  }
  const m = data.meeting;
  const remove = async () => {
    if (!(await confirmDialog({ title: "Delete this meeting?", body: "The recording, transcript and summary will be deleted. Tasks already created from it are kept.", action: "Delete", danger: true }))) return;
    try { await api(`/meetings/${id}`, { method: "DELETE" }); invalidate("meetings"); navigate("/meetings"); } catch (e) { toastError(e); }
  };
  let body;
  if (!data.isOrganiser || m.status === "sent") body = m.status === "sent" ? <Sent detail={data} /> : <div className="center"><Empty icon="⏳" title="Not ready yet">The organiser is still reviewing this meeting.</Empty></div>;
  else if (m.status === "recording") body = <Recorder detail={data} />;
  else if (m.status === "processing" || m.status === "failed") body = <Processing key={m.status} detail={data} onDone={again} />;
  else body = <Review key={m.status} detail={data} refetch={() => { refetch(); invalidate("meetings"); }} />;
  return (
    <>
      <Toolbar crumbs={<><Link className="crumb" to="/meetings">Meetings</Link><span className="crumb-sep">›</span><span className="crumb current">{m.title || "Untitled meeting"}</span></>}>
        <span className={`chip ${STATUS[m.status].cls}`}>{STATUS[m.status].label}</span>
        {app.aiReady && m.status === "sent" && <button className="icon-btn" aria-label="Ask AI about this meeting" title="Ask AI about this meeting" onClick={() => shell.openAsk(undefined, { kind: "meeting", id: m.id, title: m.title })}><Sparkles /></button>}
        {data.isOrganiser && m.status !== "recording" && (
          <Dropdown width={190} placement="bottom-end" trigger={({ onClick }) => <button className="icon-btn" aria-label="More" onClick={onClick}><MoreHorizontal /></button>}>
            {(close) => <MenuItem danger icon={<Trash2 />} onClick={() => { close(); remove(); }}>Delete meeting</MenuItem>}
          </Dropdown>
        )}
      </Toolbar>
      {body}
    </>
  );
}
