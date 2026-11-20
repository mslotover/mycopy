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

/** assignee_ids: everyone who owns the task. done_ids: the owners who have ticked their part off. */
export type Owned = { assignee_ids?: string[]; done_ids?: string[] };

const shape = (t: TaskRow & Owned & { meeting_title?: string | null }) => ({ ...t, needs_owner: !!t.needs_owner });

/** Adds assignee_ids / done_ids to task rows. The table is small, so it is read whole. */
export async function withOwners<T extends { id: string; assignee_id: string | null }>(env: Env, rows: T[]): Promise<(T & Owned)[]> {
  if (!rows.length) return [];
  const owners = await all<{ task_id: string; user_id: string; done_at: number | null }>(env.DB, "SELECT task_id, user_id, done_at FROM task_assignees");
  const by = new Map<string, { user_id: string; done_at: number | null }[]>();
  for (const o of owners) by.set(o.task_id, [...(by.get(o.task_id) ?? []), o]);
  return rows.map((t) => {
    const os = by.get(t.id) ?? [];
    const ids = os.map((o) => o.user_id);
    // The main owner first, so the list always agrees with tasks.assignee_id.
    if (t.assignee_id && ids.includes(t.assignee_id)) ids.splice(0, ids.length, t.assignee_id, ...ids.filter((x) => x !== t.assignee_id));
    return { ...t, assignee_ids: ids, done_ids: os.filter((o) => o.done_at).map((o) => o.user_id) };
  });
}

/** Makes the owner list exactly `ids` (keeping anyone's existing tick), main owner = first. Returns who is new. */
async function setOwners(env: Env, taskId: string, ids: string[]): Promise<string[]> {
  const have = await all<{ user_id: string }>(env.DB, "SELECT user_id FROM task_assignees WHERE task_id = ?", taskId);
  const had = new Set(have.map((h) => h.user_id));
  const stmts = [
    ...have.filter((h) => !ids.includes(h.user_id)).map((h) => env.DB.prepare("DELETE FROM task_assignees WHERE task_id = ? AND user_id = ?").bind(taskId, h.user_id)),
    ...ids.filter((id) => !had.has(id)).map((id) => env.DB.prepare("INSERT INTO task_assignees (task_id, user_id, done_at) VALUES (?, ?, NULL)").bind(taskId, id)),
    env.DB.prepare("UPDATE tasks SET assignee_id = ?, needs_owner = 0 WHERE id = ?").bind(ids[0] ?? null, taskId),
  ];
  await env.DB.batch(stmts);
  return ids.filter((id) => !had.has(id));
}

/** A task is done when every owner has ticked their part (a task with no owners follows its own status). */
async function syncStatus(env: Env, taskId: string, wanted?: TaskRow["status"]): Promise<void> {
  const os = await all<{ done_at: number | null }>(env.DB, "SELECT done_at FROM task_assignees WHERE task_id = ?", taskId);
  const t = (await first<{ status: TaskRow["status"] }>(env.DB, "SELECT status FROM tasks WHERE id = ?", taskId))!;
  const allDone = os.length > 0 && os.every((o) => o.done_at);
  let next: TaskRow["status"];
  if (!os.length) next = wanted ?? t.status;
  else if (allDone) next = "done";
  else if (wanted && wanted !== "done") next = wanted;
  else next = t.status === "done" ? "todo" : t.status;
  if (next !== t.status) await run(env.DB, "UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?", next, next === "done" ? now() : null, taskId);
}

const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function indexTask(env: Env, t: Pick<TaskRow, "id" | "title" | "notes" | "project">) {
  await indexDoc(env.DB, "task", t.id, t.title, `${t.notes}\n${t.project}`);
}

/** Inserts a task. Shared by the API and by the meeting pipeline. */
export async function createTask(
  env: Env,
  t: { title: string; notes?: string; assignee_id?: string | null; assignee_ids?: string[]; creator_id: string; space_id?: string | null; project?: string; due?: string | null; meeting_id?: string | null; needs_owner?: boolean; status?: TaskRow["status"] },
): Promise<TaskRow> {
  const id = uid();
  const ts = now();
  const status = t.status ?? "todo";
  const owners = [...new Set(t.assignee_ids?.length ? t.assignee_ids : t.assignee_id ? [t.assignee_id] : [])];
  await run(
    env.DB,
    `INSERT INTO tasks (id, title, notes, status, assignee_id, creator_id, space_id, project, due, meeting_id, needs_owner, sort, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, t.title.slice(0, 500), t.notes ?? "", status, owners[0] ?? null, t.creator_id, t.space_id ?? null,
    t.project ?? "", isDate(t.due) ? t.due : null, t.meeting_id ?? null, t.needs_owner ? 1 : 0, ts,
    status === "done" ? ts : null, ts, ts,
  );
  if (owners.length) await env.DB.batch(owners.map((o) => env.DB.prepare("INSERT INTO task_assignees (task_id, user_id, done_at) VALUES (?, ?, ?)").bind(id, o, status === "done" ? ts : null)));
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
  let rows: (TaskRow & Owned & { meeting_title: string | null })[];
  if (scope === "mine") {
    rows = await all(c.env.DB, `${sel} WHERE t.assignee_id = ?1 OR t.id IN (SELECT task_id FROM task_assignees WHERE user_id = ?1)`, user.id);
  } else if (scope === "delegated") {
    rows = await all(c.env.DB, `${sel} WHERE t.creator_id = ?1 AND NOT EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?1)`, user.id);
  } else if (scope.startsWith("space:")) {
    const sid = scope.slice(6);
    if (!spaces.has(sid)) throw forbidden("You're not a member of that space.");
    rows = await all(c.env.DB, `${sel} WHERE t.space_id = ?`, sid);
  } else if (scope.startsWith("meeting:")) {
    rows = await all(c.env.DB, `${sel} WHERE t.meeting_id = ?`, scope.slice(8));
  } else {
    rows = await all(c.env.DB, sel);
  }
  rows = await withOwners(c.env, rows);
  if (scope.startsWith("meeting:") || !(scope === "mine" || scope === "delegated" || scope.startsWith("space:"))) rows = rows.filter((t) => canSeeTask(t, user, spaces));
  // In "mine", a task you have ticked counts as done for you even if a co-owner hasn't finished.
  const mineDone = (t: (typeof rows)[number]) => scope === "mine" && !!t.done_ids?.includes(user.id);
  // Open tasks first by due date, then recently completed ones.
  const cutoff = now() - 30 * 86400_000;
  rows = rows.filter((t) => (t.status !== "done" && !mineDone(t)) || (t.completed_at ?? t.updated_at) > cutoff || c.req.query("done") === "all");
  rows.sort((a, b) => {
    const da = a.status === "done" || mineDone(a) ? 1 : 0, db = b.status === "done" || mineDone(b) ? 1 : 0;
    if (da !== db) return da - db;
    if (da) return (b.completed_at ?? 0) - (a.completed_at ?? 0);
    if ((a.due ?? "9") !== (b.due ?? "9")) return (a.due ?? "9") < (b.due ?? "9") ? -1 : 1;
    return a.sort - b.sort;
  });
  return c.json({ tasks: rows.map((t) => ({ ...shape(t), my_done: t.assignee_ids?.includes(user.id) ? !!t.done_ids?.includes(user.id) : t.status === "done" })) });
});

tasks.post("/", async (c) => {
  const user = c.var.user;
  const b = await c.req.json<{ title?: string; notes?: string; assignee_id?: string | null; assignee_ids?: string[]; space_id?: string | null; project?: string; due?: string | null }>();
  const title = (b.title ?? "").trim();
  if (!title) throw bad("Give the task a name.");
  const spaces = await memberSpaceIds(c.env, user);
  if (b.space_id && !spaces.has(b.space_id)) throw forbidden("You're not a member of that space.");
  const owners = [...new Set(b.assignee_ids ?? (b.assignee_id === undefined ? [user.id] : b.assignee_id ? [b.assignee_id] : []))].slice(0, 10);
  const task = await createTask(c.env, { title, notes: b.notes, assignee_ids: owners, creator_id: user.id, space_id: b.space_id, project: b.project, due: b.due });
  for (const o of owners.filter((o) => o !== user.id)) {
    await notify(c.env, c.var.origin, {
      user_id: o, actor_id: user.id, type: "task",
      title: `${user.name} assigned you a task`, body: title, url: `/tasks?open=${task.id}`, email: true,
    });
  }
  const [out] = await withOwners(c.env, [task]);
  return c.json({ task: shape(out!) });
});

tasks.patch("/:id", async (c) => {
  const user = c.var.user;
  const row = await first<TaskRow>(c.env.DB, "SELECT * FROM tasks WHERE id = ?", c.req.param("id"));
  if (!row) throw notFound("That task no longer exists.");
  const [task] = await withOwners(c.env, [row]);
  const spaces = await memberSpaceIds(c.env, user);
  if (!canSeeTask(task!, user, spaces)) throw forbidden();
  const b = await c.req.json<Partial<Pick<TaskRow, "title" | "notes" | "status" | "assignee_id" | "space_id" | "project" | "due" | "sort">> & { assignee_ids?: string[] }>();
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
  if (b.status !== undefined && !["todo", "doing", "done"].includes(b.status)) throw bad("Unknown status.");
  const newOwners = b.assignee_ids !== undefined ? [...new Set(b.assignee_ids)].slice(0, 10) : b.assignee_id !== undefined ? (b.assignee_id ? [b.assignee_id] : []) : null;
  if (!sets.length && b.status === undefined && !newOwners) return c.json({ task: shape(task!) });
  set("updated_at", now());
  await run(c.env.DB, `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...args, task!.id);
  const added = newOwners ? await setOwners(c.env, task!.id, newOwners) : [];
  if (b.status !== undefined) {
    // Ticking is per person: an owner ticks their own part; anyone else (e.g. the creator) sets it for everyone.
    const mine = (newOwners ?? task!.assignee_ids ?? []).includes(user.id);
    if (mine) await run(c.env.DB, "UPDATE task_assignees SET done_at = ? WHERE task_id = ? AND user_id = ?", b.status === "done" ? now() : null, task!.id, user.id);
    else await run(c.env.DB, "UPDATE task_assignees SET done_at = ? WHERE task_id = ?", b.status === "done" ? now() : null, task!.id);
    await syncStatus(c.env, task!.id, b.status);
  } else if (newOwners) await syncStatus(c.env, task!.id);
  const [fresh] = await withOwners(c.env, [(await first<TaskRow>(c.env.DB, "SELECT * FROM tasks WHERE id = ?", task!.id))!]);
  await indexTask(c.env, fresh!);
  for (const o of added.filter((o) => o !== user.id)) {
    await notify(c.env, c.var.origin, {
      user_id: o, actor_id: user.id, type: "task",
      title: `${user.name} assigned you a task`, body: fresh!.title, url: `/tasks?open=${fresh!.id}`, email: true,
    });
  }
  // Let the person who handed the task out know it's finished (once everyone has done their part).
  if (fresh!.status === "done" && task!.status !== "done" && task!.creator_id !== user.id) {
    await notify(c.env, c.var.origin, {
      user_id: task.creator_id, actor_id: user.id, type: "task_done",
      title: `${user.name} completed a task`, body: fresh!.title, url: `/tasks?open=${fresh!.id}`,
    });
  }
  return c.json({ task: shape(fresh!) });
});

tasks.delete("/:id", async (c) => {
  const user = c.var.user;
  const task = await first<TaskRow>(c.env.DB, "SELECT * FROM tasks WHERE id = ?", c.req.param("id"));
  if (!task) return c.json({ ok: true });
  const [owned] = await withOwners(c.env, [task]);
  if (!canSeeTask(owned!, user, await memberSpaceIds(c.env, user))) throw forbidden();
  await run(c.env.DB, "DELETE FROM tasks WHERE id = ?", task.id);
  await run(c.env.DB, "DELETE FROM comments WHERE target_kind = 'task' AND target_id = ?", task.id);
  await unindexDoc(c.env.DB, "task", task.id);
  return c.json({ ok: true });
});
