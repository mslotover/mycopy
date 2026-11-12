import { Hono } from "hono";
import { canSeeTask, memberSpaceIds } from "./access";
import { all, bad, first, forbidden, indexDoc, notFound, now, run, uid, unindexDoc, type Env, type HonoEnv } from "./env";
import { notify } from "./mail";

export type TaskRow = {
  id: string; title: string; notes: string; status: "todo" | "doing" | "done";
  assignee_id: string | null; creator_id: string; space_id: string | null; project: string;
  due: string | null; meeting_id: string | null; needs_owner: number; sort: number;
  completed_at: number | null; source_url: string | null; created_at: number; updated_at: number;
};

const shape = (t: TaskRow & { meeting_title?: string | null }) => ({ ...t, needs_owner: !!t.needs_owner });

const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function indexTask(env: Env, t: Pick<TaskRow, "id" | "title" | "notes" | "project">) {
  await indexDoc(env.DB, "task", t.id, t.title, `${t.notes}\n${t.project}`);
}

/** Inserts a task. Shared by the API and by the meeting pipeline. */
export async function createTask(
  env: Env,
  t: { title: string; notes?: string; assignee_id?: string | null; creator_id: string; space_id?: string | null; project?: string; due?: string | null; meeting_id?: string | null; needs_owner?: boolean; status?: TaskRow["status"] },
): Promise<TaskRow> {
  const id = uid();
  const ts = now();
  const status = t.status ?? "todo";
  await run(
    env.DB,
    `INSERT INTO tasks (id, title, notes, status, assignee_id, creator_id, space_id, project, due, meeting_id, needs_owner, sort, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, t.title.slice(0, 500), t.notes ?? "", status, t.assignee_id ?? null, t.creator_id, t.space_id ?? null,
    t.project ?? "", isDate(t.due) ? t.due : null, t.meeting_id ?? null, t.needs_owner ? 1 : 0, ts,
    status === "done" ? ts : null, ts, ts,
  );
  const row = (await first<TaskRow>(env.DB, "SELECT * FROM tasks WHERE id = ?", id))!;
  await indexTask(env, row);
  return row;
}

export const tasks = new Hono<HonoEnv>();

// scope: mine (assigned to me) · delegated (I created, someone else owns) · space:<id> · all (everything I can see)
tasks.get("/", async (c) => {
  const user = c.var.user;
  const scope = c.req.query("scope") ?? "mine";
  const spaces = await memberSpaceIds(c.env, user);
  const sel = `SELECT t.*, m.title AS meeting_title FROM tasks t LEFT JOIN meetings m ON m.id = t.meeting_id`;
  let rows: (TaskRow & { meeting_title: string | null })[];
  if (scope === "mine") {
    rows = await all(c.env.DB, `${sel} WHERE t.assignee_id = ?`, user.id);
  } else if (scope === "delegated") {
    rows = await all(c.env.DB, `${sel} WHERE t.creator_id = ? AND (t.assignee_id IS NULL OR t.assignee_id != ?)`, user.id, user.id);
  } else if (scope.startsWith("space:")) {
    const sid = scope.slice(6);
    if (!spaces.has(sid)) throw forbidden("You're not a member of that space.");
    rows = await all(c.env.DB, `${sel} WHERE t.space_id = ?`, sid);
  } else if (scope.startsWith("meeting:")) {
    rows = (await all<TaskRow & { meeting_title: string | null }>(c.env.DB, `${sel} WHERE t.meeting_id = ?`, scope.slice(8))).filter((t) => canSeeTask(t, user, spaces));
  } else {
    rows = (await all<TaskRow & { meeting_title: string | null }>(c.env.DB, sel)).filter((t) => canSeeTask(t, user, spaces));
  }
  // Open tasks first by due date, then recently completed ones.
  const cutoff = now() - 30 * 86400_000;
  rows = rows.filter((t) => t.status !== "done" || (t.completed_at ?? 0) > cutoff || c.req.query("done") === "all");
  rows.sort((a, b) => {
    const da = a.status === "done" ? 1 : 0, db = b.status === "done" ? 1 : 0;
    if (da !== db) return da - db;
    if (da) return (b.completed_at ?? 0) - (a.completed_at ?? 0);
    if ((a.due ?? "9") !== (b.due ?? "9")) return (a.due ?? "9") < (b.due ?? "9") ? -1 : 1;
    return a.sort - b.sort;
  });
  return c.json({ tasks: rows.map(shape) });
});

tasks.post("/", async (c) => {
  const user = c.var.user;
  const b = await c.req.json<{ title?: string; notes?: string; assignee_id?: string | null; space_id?: string | null; project?: string; due?: string | null }>();
  const title = (b.title ?? "").trim();
  if (!title) throw bad("Give the task a name.");
  const spaces = await memberSpaceIds(c.env, user);
  if (b.space_id && !spaces.has(b.space_id)) throw forbidden("You're not a member of that space.");
  const assignee = b.assignee_id === undefined ? user.id : b.assignee_id;
  const task = await createTask(c.env, { title, notes: b.notes, assignee_id: assignee, creator_id: user.id, space_id: b.space_id, project: b.project, due: b.due });
  if (assignee && assignee !== user.id) {
    await notify(c.env, c.var.origin, {
      user_id: assignee, actor_id: user.id, type: "task",
      title: `${user.name} assigned you a task`, body: title, url: `/tasks?open=${task.id}`, email: true,
    });
  }
  return c.json({ task: shape(task) });
});

tasks.patch("/:id", async (c) => {
  const user = c.var.user;
  const task = await first<TaskRow>(c.env.DB, "SELECT * FROM tasks WHERE id = ?", c.req.param("id"));
  if (!task) throw notFound("That task no longer exists.");
  const spaces = await memberSpaceIds(c.env, user);
  if (!canSeeTask(task, user, spaces)) throw forbidden();
  const b = await c.req.json<Partial<Pick<TaskRow, "title" | "notes" | "status" | "assignee_id" | "space_id" | "project" | "due" | "sort">>>();
  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); args.push(v); };
  if (b.title !== undefined) {
    if (!b.title.trim()) throw bad("A task needs a name.");
    set("title", b.title.trim().slice(0, 500));
  }
  if (b.notes !== undefined) set("notes", String(b.notes));
  if (b.project !== undefined) set("project", String(b.project));
  if (b.sort !== undefined) set("sort", Number(b.sort));
  if (b.due !== undefined) set("due", isDate(b.due) ? b.due : null);
  if (b.space_id !== undefined) {
    if (b.space_id && !spaces.has(b.space_id)) throw forbidden("You're not a member of that space.");
    set("space_id", b.space_id);
  }
  if (b.status !== undefined) {
    if (!["todo", "doing", "done"].includes(b.status)) throw bad("Unknown status.");
    set("status", b.status);
    set("completed_at", b.status === "done" ? now() : null);
  }
  if (b.assignee_id !== undefined) {
    set("assignee_id", b.assignee_id);
    set("needs_owner", 0);
  }
  if (!sets.length) return c.json({ task: shape(task) });
  set("updated_at", now());
  await run(c.env.DB, `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...args, task.id);
  const fresh = (await first<TaskRow>(c.env.DB, "SELECT * FROM tasks WHERE id = ?", task.id))!;
  await indexTask(c.env, fresh);
  if (b.assignee_id && b.assignee_id !== task.assignee_id) {
    await notify(c.env, c.var.origin, {
      user_id: b.assignee_id, actor_id: user.id, type: "task",
      title: `${user.name} assigned you a task`, body: fresh.title, url: `/tasks?open=${fresh.id}`, email: true,
    });
  }
  // Let the person who handed the task out know it's finished.
  if (b.status === "done" && task.status !== "done" && task.creator_id !== user.id) {
    await notify(c.env, c.var.origin, {
      user_id: task.creator_id, actor_id: user.id, type: "task_done",
      title: `${user.name} completed a task`, body: fresh.title, url: `/tasks?open=${fresh.id}`,
    });
  }
  return c.json({ task: shape(fresh) });
});

tasks.delete("/:id", async (c) => {
  const user = c.var.user;
  const task = await first<TaskRow>(c.env.DB, "SELECT * FROM tasks WHERE id = ?", c.req.param("id"));
  if (!task) return c.json({ ok: true });
  if (!canSeeTask(task, user, await memberSpaceIds(c.env, user))) throw forbidden();
  await run(c.env.DB, "DELETE FROM tasks WHERE id = ?", task.id);
  await run(c.env.DB, "DELETE FROM comments WHERE target_kind = 'task' AND target_id = ?", task.id);
  await unindexDoc(c.env.DB, "task", task.id);
  return c.json({ ok: true });
});
