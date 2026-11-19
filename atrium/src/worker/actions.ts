// Things Ask AI can offer to do: create tasks, write a page, add a row to a database.
// Claude only ever *proposes*: the tool checks the request, resolves names to ids and returns
// ready-made API calls, which the panel shows as a card. Nothing happens until the person
// presses Confirm, and then their own browser makes the calls, so the normal permission
// checks on /api/tasks and /api/pages apply exactly as if they had clicked through the app.
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { loadAccess, memberSpaceIds } from "./access";
import { all, first, parseJSON, uid, type Env, type User } from "./env";

export type Proposal = {
  id: string;
  title: string; // "Create 3 tasks"
  lines: string[]; // what will happen, one line per item
  requests: { method: "POST"; path: string; body: unknown; label: string }[];
};

export const ACTION_TOOLS: Anthropic.Tool[] = [
  {
    name: "propose_tasks",
    description:
      "Offer to create one or more tasks. The person sees them with a Confirm button; nothing is created unless they confirm. Use people's email addresses for assignees (list_tasks and read_item show who is who); leave assignee out to give the task to the person asking.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short, starting with a verb." },
              assignee_email: { type: "string" },
              due: { type: "string", description: "YYYY-MM-DD, if there is a date." },
              space: { type: "string", description: "Space (business) name, if it belongs to one." },
              notes: { type: "string", description: "A sentence of context, if useful." },
            },
            required: ["title"],
          },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "propose_page",
    description:
      "Offer to create a new page, written in Markdown (headings, paragraphs, bullet and numbered lists, '- [ ]' to-dos, **bold**). Put it in a space by name, or under an existing page by id. The person sees it with a Confirm button; nothing is created unless they confirm.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        space: { type: "string", description: "Space (business) name. Leave out, with no parent, for the person's private pages." },
        parent_page_id: { type: "string", description: "Id of a page to put it under." },
        markdown: { type: "string" },
      },
      required: ["title", "markdown"],
    },
  },
  {
    name: "propose_database_row",
    description:
      "Offer to add a row to a database page. Read the database with read_item first to see its properties. Give values by property name: text, numbers, true/false for checkboxes, option names for select and status, a list of option names for multi-select, YYYY-MM-DD for dates and email addresses for people. The person sees it with a Confirm button; nothing is added unless they confirm.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        database_id: { type: "string" },
        title: { type: "string" },
        values: { type: "object", additionalProperties: true },
      },
      required: ["database_id", "title"],
    },
  },
];

const TasksInput = z.object({
  tasks: z.array(z.object({ title: z.string().min(1), assignee_email: z.string().nullish(), due: z.string().nullish(), space: z.string().nullish(), notes: z.string().nullish() })).min(1).max(30),
});
const PageInput = z.object({ title: z.string().min(1), space: z.string().nullish(), parent_page_id: z.string().nullish(), markdown: z.string() });
const RowInput = z.object({ database_id: z.string().min(1), title: z.string().min(1), values: z.record(z.string(), z.unknown()).nullish() });

const isoDay = /^\d{4}-\d{2}-\d{2}$/;
const norm = (s: string) => s.trim().toLowerCase();

async function lookups(env: Env, user: User) {
  const [people, spaces, mine] = await Promise.all([
    all<{ id: string; name: string; email: string }>(env.DB, "SELECT id, name, email FROM users WHERE active = 1"),
    all<{ id: string; name: string }>(env.DB, "SELECT id, name FROM spaces WHERE archived = 0"),
    memberSpaceIds(env, user),
  ]);
  const myspaces = spaces.filter((s) => mine.has(s.id));
  const person = (email: string) => people.find((p) => norm(p.email) === norm(email));
  const space = (name: string) => myspaces.find((s) => norm(s.name) === norm(name)) ?? myspaces.find((s) => norm(s.name).includes(norm(name)));
  return { people, myspaces, person, space };
}

// ---------- Markdown to the editor's document format ----------

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: { type: string }[] };

function inline(text: string): Node[] {
  const out: Node[] = [];
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) out.push({ type: "text", text: part.slice(2, -2), marks: [{ type: "bold" }] });
    else out.push({ type: "text", text: part });
  }
  return out;
}
const para = (text: string): Node => ({ type: "paragraph", ...(text ? { content: inline(text) } : {}) });

export function markdownToDoc(md: string): Node {
  const content: Node[] = [];
  let list: Node | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length) content.push(para(buffer.join(" ")));
    buffer = [];
  };
  const listOf = (type: string) => {
    if (!list || list.type !== type) {
      list = { type, content: [] };
      content.push(list);
    }
    return list;
  };
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if (!line.trim()) { flush(); list = null; continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flush(); list = null; content.push({ type: "heading", attrs: { level: m[1].length }, content: inline(m[2]) }); continue; }
    if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))) { flush(); listOf("taskList").content!.push({ type: "taskItem", attrs: { checked: m[1] !== " " }, content: [para(m[2])] }); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { flush(); listOf("bulletList").content!.push({ type: "listItem", content: [para(m[1])] }); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flush(); listOf("orderedList").content!.push({ type: "listItem", content: [para(m[1])] }); continue; }
    list = null;
    buffer.push(line.trim());
  }
  flush();
  return { type: "doc", content: content.length ? content : [para("")] };
}

// ---------- Building proposals ----------

type Result = { ok: true; proposal: Proposal } | { ok: false; error: string };

export async function buildProposal(env: Env, user: User, name: string, input: unknown): Promise<Result | null> {
  if (user.role === "guest") return { ok: false, error: "Guests can't make changes through Ask AI." };

  if (name === "propose_tasks") {
    const p = TasksInput.safeParse(input);
    if (!p.success) return { ok: false, error: `Invalid input: ${p.error.message}` };
    const L = await lookups(env, user);
    const requests: Proposal["requests"] = [];
    const lines: string[] = [];
    for (const t of p.data.tasks) {
      const who = t.assignee_email ? L.person(t.assignee_email) : null;
      if (t.assignee_email && !who)
        return { ok: false, error: `No one in Atrium has the email ${t.assignee_email}. People: ${L.people.map((x) => `${x.name} <${x.email}>`).join(", ")}` };
      const sp = t.space ? L.space(t.space) : null;
      if (t.space && !sp) return { ok: false, error: `"${t.space}" isn't a space ${user.name} belongs to. Their spaces: ${L.myspaces.map((s) => s.name).join(", ") || "none"}` };
      if (t.due && !isoDay.test(t.due)) return { ok: false, error: `Due dates must be YYYY-MM-DD (got ${t.due}).` };
      const assignee = who?.id ?? user.id;
      requests.push({
        method: "POST", path: "/tasks", label: t.title,
        body: { title: t.title.trim(), notes: t.notes ?? "", assignee_id: assignee, space_id: sp?.id ?? null, due: t.due ?? null },
      });
      lines.push([t.title.trim(), assignee === user.id ? "you" : who!.name, t.due ? `due ${t.due}` : "", sp?.name ?? ""].filter(Boolean).join(" · "));
    }
    const n = requests.length;
    return { ok: true, proposal: { id: uid(), title: `Create ${n} task${n === 1 ? "" : "s"}`, lines, requests } };
  }

  if (name === "propose_page") {
    const p = PageInput.safeParse(input);
    if (!p.success) return { ok: false, error: `Invalid input: ${p.error.message}` };
    let where = "your private pages";
    let body: Record<string, unknown> = { title: p.data.title.trim(), content: markdownToDoc(p.data.markdown) };
    if (p.data.parent_page_id) {
      const access = await loadAccess(env, user);
      const parent = await first<{ id: string; title: string; kind: string }>(env.DB, "SELECT id, title, kind FROM pages WHERE id = ? AND archived = 0", p.data.parent_page_id);
      if (!parent || access.level(parent.id) < 3) return { ok: false, error: `${user.name} can't add pages under that page.` };
      if (parent.kind === "database") return { ok: false, error: "That's a database: use propose_database_row to add to it." };
      body = { ...body, parent_id: parent.id };
      where = `under “${parent.title || "Untitled"}”`;
    } else if (p.data.space) {
      const L = await lookups(env, user);
      const sp = L.space(p.data.space);
      if (!sp) return { ok: false, error: `"${p.data.space}" isn't a space ${user.name} belongs to. Their spaces: ${L.myspaces.map((s) => s.name).join(", ") || "none"}` };
      body = { ...body, space_id: sp.id };
      where = `in ${sp.name}`;
    }
    const words = p.data.markdown.split(/\s+/).filter(Boolean).length;
    return {
      ok: true,
      proposal: { id: uid(), title: "Create a page", lines: [`“${p.data.title.trim()}” ${where}`, `${words} words`], requests: [{ method: "POST", path: "/pages", label: p.data.title.trim(), body }] },
    };
  }

  if (name === "propose_database_row") {
    const p = RowInput.safeParse(input);
    if (!p.success) return { ok: false, error: `Invalid input: ${p.error.message}` };
    const access = await loadAccess(env, user);
    const db = await first<{ id: string; title: string; kind: string; schema: string | null }>(env.DB, "SELECT id, title, kind, schema FROM pages WHERE id = ? AND archived = 0", p.data.database_id);
    if (!db || db.kind !== "database" || access.level(db.id) < 1) return { ok: false, error: "That isn't a database this person can see." };
    if (access.level(db.id) < 3) return { ok: false, error: `${user.name} can view this database but not add to it.` };
    const schema = parseJSON<{ props: { id: string; name: string; type: string; options?: { id: string; name: string }[] }[] }>(db.schema, { props: [] });
    const L = await lookups(env, user);
    const props: Record<string, unknown> = {};
    const shown: string[] = [];
    for (const [key, value] of Object.entries(p.data.values ?? {})) {
      if (value === null || value === undefined || value === "") continue;
      const prop = schema.props.find((x) => norm(x.name) === norm(key));
      if (!prop) return { ok: false, error: `“${db.title}” has no property “${key}”. Properties: ${schema.props.map((x) => `${x.name} (${x.type})`).join(", ")}` };
      const option = (v: unknown) => prop.options?.find((o) => norm(o.name) === norm(String(v)));
      const choices = () => (prop.options ?? []).map((o) => o.name).join(", ") || "none yet";
      switch (prop.type) {
        case "select":
        case "status": {
          const o = option(value);
          if (!o) return { ok: false, error: `“${value}” isn't an option for ${prop.name}. Options: ${choices()}` };
          props[prop.id] = o.id;
          break;
        }
        case "multi_select": {
          const ids: string[] = [];
          for (const v of Array.isArray(value) ? value : String(value).split(",")) {
            const o = option(v);
            if (!o) return { ok: false, error: `“${v}” isn't an option for ${prop.name}. Options: ${choices()}` };
            ids.push(o.id);
          }
          props[prop.id] = ids;
          break;
        }
        case "person": {
          const ids: string[] = [];
          for (const v of Array.isArray(value) ? value : [value]) {
            const who = L.person(String(v));
            if (!who) return { ok: false, error: `No one in Atrium has the email ${v}.` };
            ids.push(who.id);
          }
          props[prop.id] = ids;
          break;
        }
        case "number": {
          const n = Number(value);
          if (!Number.isFinite(n)) return { ok: false, error: `${prop.name} needs a number.` };
          props[prop.id] = n;
          break;
        }
        case "checkbox":
          props[prop.id] = value === true || norm(String(value)) === "true" || norm(String(value)) === "yes";
          break;
        case "date":
          if (!isoDay.test(String(value))) return { ok: false, error: `${prop.name} needs a date as YYYY-MM-DD.` };
          props[prop.id] = String(value);
          break;
        default:
          props[prop.id] = String(value);
      }
      shown.push(`${prop.name}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
    }
    return {
      ok: true,
      proposal: {
        id: uid(),
        title: `Add a row to “${db.title || "Untitled"}”`,
        lines: [p.data.title.trim(), ...shown],
        requests: [{ method: "POST", path: "/pages", label: p.data.title.trim(), body: { parent_id: db.id, kind: "row", title: p.data.title.trim(), props } }],
      },
    };
  }
  return null;
}
