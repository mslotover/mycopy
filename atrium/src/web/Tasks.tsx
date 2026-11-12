import { AlertCircle, ChevronRight, Mic, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { addDays, api, dueLabel, invalidate, qc, todayISO, useTasks, type Task } from "./api";
import { Toolbar } from "./App";
import { CommentThread } from "./PageView";
import { Avatar, AutoText, Empty, PersonPill, Sheet, SpaceBadge, SpaceSelect, Spinner, toastError, useApp } from "./ui";

/** Applies a change to a task everywhere it is cached, then saves it. */
export async function patchTask(id: string, patch: Partial<Task>) {
  qc.setQueriesData<Task[]>({ queryKey: ["tasks"] }, (list) => list?.map((t) => (t.id === id ? { ...t, ...patch, completed_at: patch.status ? (patch.status === "done" ? Date.now() : null) : t.completed_at } : t)));
  try {
    await api(`/tasks/${id}`, { method: "PATCH", body: patch });
  } catch (e) {
    toastError(e);
  }
  invalidate("tasks");
}

export function TaskRow({ task, onOpen, showAssignee, showSpace }: { task: Task; onOpen: (id: string) => void; showAssignee?: boolean; showSpace?: boolean }) {
  const app = useApp();
  const due = task.due && task.status !== "done" ? dueLabel(task.due) : null;
  const space = task.space_id ? app.spaceById.get(task.space_id) : null;
  return (
    <div className={`task ${task.status === "done" ? "done" : ""}`}>
      <input type="checkbox" className="check" aria-label={task.status === "done" ? "Mark as not done" : "Mark as done"} checked={task.status === "done"} onChange={(e) => patchTask(task.id, { status: e.target.checked ? "done" : "todo" })} />
      <div className="t" onClick={() => onOpen(task.id)}>{task.title}</div>
      <div className="meta">
        {task.needs_owner && task.status !== "done" && <span className="chip orange" title="It wasn't clear in the meeting who owns this"><AlertCircle />Check owner</span>}
        {task.status === "doing" && <span className="chip blue">In progress</span>}
        {showSpace && space && <span className="chip" style={{ background: "transparent", padding: 0 }}><SpaceBadge space={space} size={16} /></span>}
        {due && <span className={`due ${due.tone}`}>{due.text}</span>}
        {showAssignee && (task.assignee_id ? <Avatar user={app.userById.get(task.assignee_id)} size={20} /> : <span className="avatar more" style={{ width: 20, height: 20, fontSize: 10 }}>?</span>)}
      </div>
    </div>
  );
}

function group(tasks: Task[]) {
  const t = todayISO();
  const week = addDays(t, 7);
  const g = { overdue: [] as Task[], today: [] as Task[], week: [] as Task[], later: [] as Task[], none: [] as Task[], done: [] as Task[] };
  for (const x of tasks) {
    if (x.status === "done") g.done.push(x);
    else if (!x.due) g.none.push(x);
    else if (x.due < t) g.overdue.push(x);
    else if (x.due === t) g.today.push(x);
    else if (x.due < week) g.week.push(x);
    else g.later.push(x);
  }
  return g;
}

/** Tasks grouped by when they are due, with completed ones tucked away. */
export function TaskGroups({ tasks, onOpen, showAssignee, showSpace }: { tasks: Task[]; onOpen: (id: string) => void; showAssignee?: boolean; showSpace?: boolean }) {
  const g = useMemo(() => group(tasks), [tasks]);
  const [showDone, setShowDone] = useState(false);
  const section = (label: string, list: Task[], cls = "") =>
    list.length > 0 && (
      <div className="task-group">
        <h4 className={cls}>{label}<span className="n">{list.length}</span></h4>
        {list.map((t) => <TaskRow key={t.id} task={t} onOpen={onOpen} showAssignee={showAssignee} showSpace={showSpace} />)}
      </div>
    );
  return (
    <>
      {section("Overdue", g.overdue, "overdue")}
      {section("Today", g.today)}
      {section("Next 7 days", g.week)}
      {section("Later", g.later)}
      {section("No date", g.none)}
      {g.done.length > 0 && (
        <div className="task-group">
          <h4><button className="btn quiet" style={{ height: 24, padding: "0 6px", marginLeft: -6 }} onClick={() => setShowDone((s) => !s)}>
            <ChevronRight style={{ transform: showDone ? "rotate(90deg)" : undefined, transition: "transform 200ms" }} />Completed<span className="n" style={{ marginLeft: 6 }}>{g.done.length}</span>
          </button></h4>
          {showDone && g.done.map((t) => <TaskRow key={t.id} task={t} onOpen={onOpen} showAssignee={showAssignee} showSpace={showSpace} />)}
        </div>
      )}
    </>
  );
}

export function QuickAdd({ defaults, placeholder = "New task" }: { defaults: Partial<Task>; placeholder?: string }) {
  const [v, setV] = useState("");
  const add = async () => {
    const title = v.trim();
    if (!title) return;
    setV("");
    try { await api("/tasks", { body: { title, ...defaults } }); invalidate("tasks"); } catch (e) { toastError(e); setV(title); }
  };
  return (
    <div className="quick-add">
      <span className="plus"><Plus /></span>
      <input className="bare" placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
      {v.trim() && <button className="btn primary" style={{ height: 28 }} onClick={add}>Add</button>}
    </div>
  );
}

export function TasksView() {
  const app = useApp();
  const [params, setParams] = useSearchParams();
  const [scope, setScope] = useState<"mine" | "delegated" | "all">("mine");
  const [spaceId, setSpaceId] = useState<string>("");
  const { data, isLoading } = useTasks(scope);
  const tasks = (data ?? []).filter((t) => !spaceId || t.space_id === spaceId);
  const openId = params.get("open");
  const open = (id: string | null) => setParams(id ? { open: id } : {}, { replace: true });
  const openCount = tasks.filter((t) => t.status !== "done").length;
  useEffect(() => { document.title = `Tasks · ${app.appName}`; return () => { document.title = app.appName; }; }, []);

  return (
    <>
      <Toolbar crumbs={<span className="crumb current">Tasks</span>} />
      <div className="scroll">
        <div className="column">
          <div className="view-head">
            <div className="grow">
              <h1 className="h-title">{scope === "mine" ? "My tasks" : scope === "delegated" ? "Assigned by me" : "All tasks"}</h1>
              <p className="h-sub">{isLoading ? " " : openCount ? `${openCount} open` : "Nothing open"}</p>
            </div>
          </div>
          <div className="bar">
            <div className="segmented">
              <button className={scope === "mine" ? "on" : ""} onClick={() => setScope("mine")}>Mine</button>
              <button className={scope === "delegated" ? "on" : ""} onClick={() => setScope("delegated")}>Assigned by me</button>
              {app.me.role !== "guest" && <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>Everyone</button>}
            </div>
            <span className="grow" />
            {app.spaces.length > 0 && (
              <select className="field" style={{ width: "auto", height: 30, fontSize: 13 }} value={spaceId} onChange={(e) => setSpaceId(e.target.value)} aria-label="Filter by space">
                <option value="">All spaces</option>
                {app.spaces.map((s) => <option key={s.id} value={s.id}>{s.icon} {s.name}</option>)}
              </select>
            )}
          </div>
          {scope !== "delegated" && <QuickAdd defaults={{ space_id: spaceId || null }} placeholder={spaceId ? `New task in ${app.spaceById.get(spaceId)?.name}` : "New task"} />}
          {isLoading ? <Spinner /> : tasks.length ? (
            <TaskGroups tasks={tasks} onOpen={open} showAssignee={scope !== "mine"} showSpace={!spaceId} />
          ) : (
            <Empty icon="✅" title={scope === "mine" ? "You're all caught up" : "No tasks here"}>
              {scope === "mine" ? "Tasks assigned to you, including actions from meetings, show up here." : "Tasks you hand to other people show up here."}
            </Empty>
          )}
        </div>
      </div>
      {openId && <TaskSheet id={openId} onClose={() => open(null)} />}
    </>
  );
}

export function TaskSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const app = useApp();
  // The task may be in any cached list; fall back to the full list.
  const cached = qc.getQueriesData<Task[]>({ queryKey: ["tasks"] }).flatMap(([, v]) => v ?? []).find((t) => t.id === id);
  const { data: all } = useTasks("all", !cached);
  const task = cached ?? all?.find((t) => t.id === id);
  const [title, setTitle] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);

  if (!task) return <Sheet onClose={onClose}>{all ? <Empty icon="🫥" title="This task no longer exists" /> : <Spinner />}</Sheet>;
  const remove = async () => { try { await api(`/tasks/${id}`, { method: "DELETE" }); invalidate("tasks"); onClose(); } catch (e) { toastError(e); } };
  const commit = (field: "title" | "notes" | "project", v: string | null) => { if (v !== null && v !== task[field] && (field !== "title" || v.trim())) patchTask(id, { [field]: v }); };

  return (
    <Sheet onClose={onClose}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", paddingTop: 10 }}>
        <input type="checkbox" className="check" style={{ marginTop: 5 }} checked={task.status === "done"} onChange={(e) => patchTask(id, { status: e.target.checked ? "done" : "todo" })} aria-label="Done" />
        <AutoText className="page-title" value={title ?? task.title} onChange={setTitle} placeholder="Task name" onEnter={() => commit("title", title)} />
      </div>
      <div onBlur={() => { commit("title", title); commit("notes", notes); commit("project", project); }}>
        {task.needs_owner && task.status !== "done" && (
          <div className="banner warn" style={{ marginTop: 12 }}><AlertCircle />It wasn't clear in the meeting who should own this. Reassign it or keep it.<button className="btn" onClick={() => patchTask(id, { assignee_id: task.assignee_id })}>Keep</button></div>
        )}
        <div className="props" style={{ marginTop: 14, gridTemplateColumns: "110px minmax(0,1fr)" }}>
          <div className="k">Status</div>
          <div className="v" style={{ background: "none" }}>
            <div className="segmented">
              {(["todo", "doing", "done"] as const).map((s) => <button key={s} className={task.status === s ? "on" : ""} onClick={() => patchTask(id, { status: s })}>{s === "todo" ? "To do" : s === "doing" ? "In progress" : "Done"}</button>)}
            </div>
          </div>
          <div className="k">Assignee</div>
          <div className="v"><PersonPill id={task.assignee_id} onChange={(v) => patchTask(id, { assignee_id: v })} /></div>
          <div className="k">Due</div>
          <div className="v"><input type="date" className="bare" value={task.due ?? ""} onChange={(e) => patchTask(id, { due: e.target.value || null })} /></div>
          {app.me.role !== "guest" && (<>
            <div className="k">Space</div>
            <div className="v" style={{ background: "none" }}><SpaceSelect value={task.space_id} onChange={(v) => patchTask(id, { space_id: v })} privateLabel="Private" /></div>
          </>)}
          <div className="k">Project</div>
          <div className="v"><input className="bare" placeholder="None" value={project ?? task.project} onChange={(e) => setProject(e.target.value)} /></div>
          {task.meeting_id && (<>
            <div className="k">From</div>
            <div className="v"><Link to={`/meetings/${task.meeting_id}`} className="chip blue" onClick={onClose}><Mic />{task.meeting_title || "Meeting"}</Link></div>
          </>)}
        </div>
        <textarea className="field" placeholder="Notes" value={notes ?? task.notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
      </div>
      <div className="section-title" style={{ marginTop: 20 }}>Comments</div>
      <CommentThread kind="task" id={id} compact />
      <div style={{ display: "flex", alignItems: "center", margin: "18px 0 14px" }}>
        <span className="muted" style={{ fontSize: 12.5, flex: 1 }}>Created by {app.userById.get(task.creator_id)?.name ?? "someone"} · {new Date(task.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>
        <button className="btn quiet danger" onClick={remove}><Trash2 />Delete</button>
        <button className="btn primary" style={{ marginLeft: 8 }} onClick={onClose}>Done</button>
      </div>
    </Sheet>
  );
}
