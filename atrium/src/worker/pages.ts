import { Hono } from "hono";
import { loadAccess, type Access } from "./access";
import { all, bad, docMentions, docText, first, forbidden, indexDoc, notFound, now, parseJSON, run, uid, unindexDoc, type Env, type HonoEnv, type User } from "./env";
import { notify } from "./mail";

type PageRow = {
  id: string; space_id: string | null; owner_id: string; parent_id: string | null; kind: "page" | "database" | "row";
  title: string; icon: string; content: string | null; text: string; props: string | null; schema: string | null;
  sort: number; is_template: number; archived: number; source_url: string | null;
  created_by: string; updated_by: string; created_at: number; updated_at: number;
};

const VERSION_GAP_MS = 10 * 60_000;
const MAX_VERSIONS = 60;

const LEVEL_NAME = ["none", "view", "comment", "edit"] as const;

function shape(p: PageRow, includeContent = true) {
  return {
    id: p.id, space_id: p.space_id, owner_id: p.owner_id, parent_id: p.parent_id, kind: p.kind,
    title: p.title, icon: p.icon, sort: p.sort, is_template: !!p.is_template, archived: !!p.archived,
    source_url: p.source_url, created_by: p.created_by, updated_by: p.updated_by,
    created_at: p.created_at, updated_at: p.updated_at,
    props: parseJSON<Record<string, unknown>>(p.props, {}),
    schema: p.kind === "database" ? parseJSON(p.schema, { props: [], views: [] }) : undefined,
    content: includeContent ? parseJSON<unknown>(p.content, null) : undefined,
  };
}

async function getPage(env: Env, id: string): Promise<PageRow> {
  const p = await first<PageRow>(env.DB, "SELECT * FROM pages WHERE id = ?", id);
  if (!p) throw notFound("This page doesn't exist.");
  return p;
}

async function reindex(env: Env, p: Pick<PageRow, "id" | "title" | "text" | "props" | "archived" | "is_template">) {
  if (p.archived) return unindexDoc(env.DB, "page", p.id);
  const propText = Object.values(parseJSON<Record<string, unknown>>(p.props, {}))
    .filter((v) => typeof v === "string" || typeof v === "number")
    .join(" ");
  await indexDoc(env.DB, "page", p.id, p.title, `${p.text}\n${propText}`);
}

/** All descendants of a page (including itself). */
async function subtreeIds(env: Env, id: string): Promise<string[]> {
  const rows = await all<{ id: string }>(
    env.DB,
    `WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN t ON p.parent_id = t.id) SELECT id FROM t`,
    id,
  );
  return rows.map((r) => r.id);
}

export const pages = new Hono<HonoEnv>();

// Everything the sidebar needs: every page the caller can see (database rows excluded).
pages.get("/tree", async (c) => {
  const user = c.var.user;
  const access = await loadAccess(c.env, user);
  const rows = await all<Pick<PageRow, "id" | "parent_id" | "space_id" | "owner_id" | "kind" | "title" | "icon" | "sort" | "is_template">>(
    c.env.DB,
    "SELECT id, parent_id, space_id, owner_id, kind, title, icon, sort, is_template FROM pages WHERE archived = 0 AND kind != 'row' ORDER BY sort, created_at",
  );
  const visible = rows.filter((r) => access.level(r.id) > 0);
  const ids = new Set(visible.map((r) => r.id));
  return c.json({
    pages: visible.map((r) => {
      const own = r.space_id ? access.memberSpaces.has(r.space_id) : r.owner_id === user.id;
      return {
        ...r,
        is_template: !!r.is_template,
        // "shared" pages reach the caller through a share rather than a space or their private area.
        section: own ? (r.space_id ? "space" : "private") : "shared",
        root: !r.parent_id || !ids.has(r.parent_id),
      };
    }),
  });
});

pages.get("/templates", async (c) => {
  const access = await loadAccess(c.env, c.var.user);
  const rows = await all<PageRow>(c.env.DB, "SELECT * FROM pages WHERE is_template = 1 AND archived = 0 ORDER BY title");
  return c.json({ templates: rows.filter((r) => access.level(r.id) > 0).map((r) => shape(r, false)) });
});

pages.get("/trash", async (c) => {
  const access = await loadAccess(c.env, c.var.user);
  const rows = await all<PageRow>(c.env.DB, "SELECT * FROM pages WHERE archived = 1 ORDER BY updated_at DESC LIMIT 300");
  // Show only the top of each deleted subtree.
  const archived = new Set(rows.map((r) => r.id));
  return c.json({
    pages: rows.filter((r) => access.level(r.id) === 3 && !(r.parent_id && archived.has(r.parent_id))).map((r) => shape(r, false)),
  });
});

pages.post("/", async (c) => {
  const user = c.var.user;
  const body = await c.req.json<{
    space_id?: string | null; parent_id?: string | null; kind?: PageRow["kind"]; title?: string; icon?: string;
    content?: unknown; props?: Record<string, unknown>; schema?: unknown; template_id?: string; is_template?: boolean;
  }>();
  const access = await loadAccess(c.env, user);
  let spaceId = body.space_id ?? null;
  let ownerId = user.id;
  const kind = body.kind ?? "page";
  if (body.parent_id) {
    const parent = await getPage(c.env, body.parent_id);
    if (access.level(parent.id) < 3) throw forbidden("You can't add pages here.");
    // Children always live where their parent lives.
    spaceId = parent.space_id;
    ownerId = parent.owner_id;
    if (kind === "row" && parent.kind !== "database") throw bad("Rows can only be added to a database.");
  } else {
    if (kind === "row") throw bad("A row needs a parent database.");
    if (spaceId && !access.memberSpaces.has(spaceId)) throw forbidden("You're not a member of that space.");
    if (!spaceId && user.role === "guest") throw forbidden("Guests can't create private pages.");
  }
  let title = body.title ?? "";
  let icon = body.icon ?? "";
  let content: unknown = body.content ?? null;
  let schema: unknown = kind === "database" ? body.schema ?? defaultSchema() : null;
  let effKind = kind;
  if (body.template_id) {
    const t = await getPage(c.env, body.template_id);
    if (access.level(t.id) < 1) throw forbidden();
    content = parseJSON(t.content, null);
    icon = icon || t.icon;
    title = title || t.title;
    if (t.kind === "database") {
      effKind = "database";
      schema = parseJSON(t.schema, defaultSchema());
    }
  }
  const max = await first<{ m: number | null }>(
    c.env.DB,
    body.parent_id ? "SELECT MAX(sort) AS m FROM pages WHERE parent_id = ?" : "SELECT MAX(sort) AS m FROM pages WHERE parent_id IS NULL AND space_id IS ?",
    body.parent_id ?? spaceId,
  );
  const id = uid();
  const t = now();
  const text = docText(content);
  await run(
    c.env.DB,
    `INSERT INTO pages (id, space_id, owner_id, parent_id, kind, title, icon, content, text, props, schema, sort, is_template, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, spaceId, ownerId, body.parent_id ?? null, effKind, title, icon,
    content ? JSON.stringify(content) : null, text,
    body.props ? JSON.stringify(body.props) : null, schema ? JSON.stringify(schema) : null,
    (max?.m ?? 0) + 1, body.is_template ? 1 : 0, user.id, user.id, t, t,
  );
  const page = await getPage(c.env, id);
  await reindex(c.env, page);
  return c.json({ page: shape(page) });
});

function defaultSchema() {
  const s = () => uid(8);
  const todo = s(), doing = s(), done = s();
  const status = s();
  return {
    props: [
      { id: status, name: "Status", type: "status", options: [
        { id: todo, name: "Not started", color: "gray" },
        { id: doing, name: "In progress", color: "blue" },
        { id: done, name: "Done", color: "green" },
      ] },
      { id: s(), name: "Owner", type: "person" },
      { id: s(), name: "Date", type: "date" },
    ],
    views: [
      { id: s(), name: "Table", type: "table" },
      { id: s(), name: "Board", type: "board", groupBy: status },
    ],
  };
}

pages.get("/:id", async (c) => {
  const user = c.var.user;
  const page = await getPage(c.env, c.req.param("id"));
  const access = await loadAccess(c.env, user);
  const level = access.level(page.id);
  if (!level) throw forbidden("You don't have access to this page.");
  // Breadcrumbs stop where the caller's access stops.
  const crumbs: { id: string; title: string; icon: string }[] = [];
  let cur: PageRow | null = page;
  for (let i = 0; cur?.parent_id && i < 30; i++) {
    cur = await first<PageRow>(c.env.DB, "SELECT * FROM pages WHERE id = ?", cur.parent_id);
    if (!cur || !access.level(cur.id)) break;
    crumbs.unshift({ id: cur.id, title: cur.title, icon: cur.icon });
  }
  const out: Record<string, unknown> = { page: shape(page), level: LEVEL_NAME[level], crumbs };
  if (page.kind === "database") {
    const rows = await all<PageRow>(c.env.DB, "SELECT * FROM pages WHERE parent_id = ? AND kind = 'row' AND archived = 0 ORDER BY sort, created_at", page.id);
    out.rows = rows.map((r) => ({ ...shape(r, false), has_content: !!r.text }));
  }
  if (page.kind === "row" && page.parent_id) {
    const db = await first<PageRow>(c.env.DB, "SELECT * FROM pages WHERE id = ?", page.parent_id);
    if (db) out.database = { id: db.id, title: db.title, schema: parseJSON(db.schema, { props: [], views: [] }) };
  }
  const subpages = await all<Pick<PageRow, "id" | "title" | "icon" | "kind">>(
    c.env.DB,
    "SELECT id, title, icon, kind FROM pages WHERE parent_id = ? AND archived = 0 AND kind != 'row' ORDER BY sort, created_at",
    page.id,
  );
  out.subpages = subpages;
  return c.json(out);
});

pages.patch("/:id", async (c) => {
  const user = c.var.user;
  const page = await getPage(c.env, c.req.param("id"));
  const access = await loadAccess(c.env, user);
  if (access.level(page.id) < 3) throw forbidden("You can view this page but not edit it.");
  const body = await c.req.json<{
    title?: string; icon?: string; content?: unknown; props?: Record<string, unknown>; schema?: unknown;
    sort?: number; is_template?: boolean; parent_id?: string | null; space_id?: string | null;
  }>();
  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); args.push(v); };

  if (body.title !== undefined) set("title", String(body.title).slice(0, 500));
  if (body.icon !== undefined) set("icon", String(body.icon).slice(0, 16));
  if (body.sort !== undefined) set("sort", Number(body.sort));
  if (body.is_template !== undefined) set("is_template", body.is_template ? 1 : 0);
  if (body.props !== undefined) set("props", JSON.stringify({ ...parseJSON(page.props, {}), ...body.props }));
  if (body.schema !== undefined && page.kind === "database") set("schema", JSON.stringify(body.schema));
  if (body.content !== undefined) {
    const text = docText(body.content);
    set("content", JSON.stringify(body.content));
    set("text", text);
    await snapshot(c.env, page, user);
    await notifyMentions(c.env, c.var.origin, user, page, body.content);
  }

  // Moving: to another parent, or to the top level of a space / the private area.
  let moved = false;
  if (body.parent_id !== undefined || body.space_id !== undefined) {
    if (page.kind === "row") throw bad("Database rows can't be moved.");
    let spaceId: string | null;
    let ownerId: string;
    let parentId: string | null;
    if (body.parent_id) {
      const parent = await getPage(c.env, body.parent_id);
      if (access.level(parent.id) < 3) throw forbidden("You can't move pages there.");
      if ((await subtreeIds(c.env, page.id)).includes(parent.id)) throw bad("A page can't be moved inside itself.");
      spaceId = parent.space_id; ownerId = parent.owner_id; parentId = parent.id;
    } else {
      parentId = null;
      spaceId = body.space_id === undefined ? page.space_id : body.space_id;
      if (spaceId && !access.memberSpaces.has(spaceId)) throw forbidden("You're not a member of that space.");
      ownerId = spaceId ? page.owner_id : user.id;
    }
    set("parent_id", parentId);
    if (spaceId !== page.space_id || ownerId !== page.owner_id) {
      const ids = await subtreeIds(c.env, page.id);
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        await run(c.env.DB, `UPDATE pages SET space_id = ?, owner_id = ? WHERE id IN (${chunk.map(() => "?").join(",")})`, spaceId, ownerId, ...chunk);
      }
    }
    moved = true;
  }

  if (!sets.length && !moved) return c.json({ page: shape(page) });
  set("updated_by", user.id);
  set("updated_at", now());
  if (sets.length) await run(c.env.DB, `UPDATE pages SET ${sets.join(", ")} WHERE id = ?`, ...args, page.id);
  const fresh = await getPage(c.env, page.id);
  await reindex(c.env, fresh);
  return c.json({ page: shape(fresh, false) });
});

/** Keeps a copy of the page as it was before an edit, at most once every ten minutes per editor. */
async function snapshot(env: Env, page: PageRow, user: User) {
  if (!page.content) return;
  const last = await first<{ created_at: number; created_by: string }>(
    env.DB, "SELECT created_at, created_by FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1", page.id,
  );
  if (last && last.created_by === user.id && now() - last.created_at < VERSION_GAP_MS) return;
  await run(
    env.DB, "INSERT INTO page_versions (id, page_id, title, content, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    uid(), page.id, page.title, page.content, page.updated_by, page.updated_at,
  );
  await run(
    env.DB,
    "DELETE FROM page_versions WHERE page_id = ? AND id NOT IN (SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT ?)",
    page.id, page.id, MAX_VERSIONS,
  );
}

async function notifyMentions(env: Env, origin: string, user: User, page: PageRow, content: unknown) {
  const before = docMentions(parseJSON(page.content, null));
  const added = [...docMentions(content)].filter((id) => !before.has(id) && id !== user.id);
  if (!added.length) return;
  const access = new Map<string, Access>();
  for (const id of added.slice(0, 20)) {
    const target = await first<User>(env.DB, "SELECT * FROM users WHERE id = ? AND active = 1", id);
    if (!target) continue;
    if (!access.has(id)) access.set(id, await loadAccess(env, target));
    // Only tell people about pages they can open.
    if (!access.get(id)!.level(page.id)) continue;
    await notify(env, origin, {
      user_id: id, actor_id: user.id, type: "mention",
      title: `${user.name} mentioned you in ${page.title || "Untitled"}`,
      url: `/p/${page.id}`, email: true,
    });
  }
}

// Deleting moves a page and everything under it to the trash; it can be restored from there.
pages.delete("/:id", async (c) => {
  const page = await getPage(c.env, c.req.param("id"));
  const access = await loadAccess(c.env, c.var.user);
  if (access.level(page.id) < 3) throw forbidden();
  const permanent = c.req.query("permanent") === "1";
  const ids = await subtreeIds(c.env, page.id);
  if (permanent) {
    if (!page.archived) throw bad("Move the page to the trash first.");
    for (const id of ids) await unindexDoc(c.env.DB, "page", id);
    await run(c.env.DB, "DELETE FROM pages WHERE id = ?", page.id);
    return c.json({ ok: true });
  }
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const marks = chunk.map(() => "?").join(",");
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE pages SET archived = 1, updated_at = ? WHERE id IN (${marks})`).bind(now(), ...chunk),
      c.env.DB.prepare(`DELETE FROM search WHERE kind = 'page' AND ref IN (${marks})`).bind(...chunk),
    ]);
  }
  return c.json({ ok: true });
});

pages.post("/:id/restore", async (c) => {
  const page = await getPage(c.env, c.req.param("id"));
  const access = await loadAccess(c.env, c.var.user);
  if (access.level(page.id) < 3) throw forbidden();
  const ids = await subtreeIds(c.env, page.id);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    await run(c.env.DB, `UPDATE pages SET archived = 0 WHERE id IN (${chunk.map(() => "?").join(",")})`, ...chunk);
  }
  // If the parent is still in the trash, bring the page back at the top level.
  if (page.parent_id) {
    const parent = await first<PageRow>(c.env.DB, "SELECT * FROM pages WHERE id = ?", page.parent_id);
    if (parent?.archived && page.kind !== "row") await run(c.env.DB, "UPDATE pages SET parent_id = NULL WHERE id = ?", page.id);
  }
  for (const id of ids) await reindex(c.env, await getPage(c.env, id));
  return c.json({ ok: true });
});

pages.post("/:id/duplicate", async (c) => {
  const user = c.var.user;
  const page = await getPage(c.env, c.req.param("id"));
  const access = await loadAccess(c.env, user);
  if (access.level(page.id) < 1) throw forbidden();
  const { as_template } = await c.req.json<{ as_template?: boolean }>().catch(() => ({ as_template: false }));
  // A copy lands next to the original when the caller can edit there, otherwise in their private area.
  const canEditParent = page.parent_id ? access.level(page.parent_id) === 3 : access.level(page.id) === 3;
  const id = uid();
  const t = now();
  await run(
    c.env.DB,
    `INSERT INTO pages (id, space_id, owner_id, parent_id, kind, title, icon, content, text, props, schema, sort, is_template, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, canEditParent ? page.space_id : null, canEditParent ? page.owner_id : user.id, canEditParent ? page.parent_id : null,
    page.kind, as_template ? page.title : `${page.title} copy`, page.icon, page.content, page.text, page.props, page.schema,
    page.sort + 0.5, as_template ? 1 : 0, user.id, user.id, t, t,
  );
  const fresh = await getPage(c.env, id);
  await reindex(c.env, fresh);
  return c.json({ page: shape(fresh, false) });
});

// Version history
pages.get("/:id/versions", async (c) => {
  const page = await getPage(c.env, c.req.param("id"));
  const access = await loadAccess(c.env, c.var.user);
  if (!access.level(page.id)) throw forbidden();
  const versions = await all(c.env.DB, "SELECT id, title, created_by, created_at FROM page_versions WHERE page_id = ? ORDER BY created_at DESC", page.id);
  return c.json({ versions });
});

pages.get("/:id/versions/:vid", async (c) => {
  const page = await getPage(c.env, c.req.param("id"));
  const access = await loadAccess(c.env, c.var.user);
  if (!access.level(page.id)) throw forbidden();
  const v = await first<{ id: string; title: string; content: string; created_by: string; created_at: number }>(
    c.env.DB, "SELECT * FROM page_versions WHERE id = ? AND page_id = ?", c.req.param("vid"), page.id,
  );
  if (!v) throw notFound();
  return c.json({ version: { ...v, content: parseJSON(v.content, null) } });
});

pages.post("/:id/versions/:vid/restore", async (c) => {
  const user = c.var.user;
  const page = await getPage(c.env, c.req.param("id"));
  const access = await loadAccess(c.env, user);
  if (access.level(page.id) < 3) throw forbidden();
  const v = await first<{ title: string; content: string }>(c.env.DB, "SELECT title, content FROM page_versions WHERE id = ? AND page_id = ?", c.req.param("vid"), page.id);
  if (!v) throw notFound();
  // The current state becomes a version too, so a restore can itself be undone.
  if (page.content) {
    await run(c.env.DB, "INSERT INTO page_versions (id, page_id, title, content, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", uid(), page.id, page.title, page.content, page.updated_by, page.updated_at);
  }
  const text = docText(parseJSON(v.content, null));
  await run(c.env.DB, "UPDATE pages SET title = ?, content = ?, text = ?, updated_by = ?, updated_at = ? WHERE id = ?", v.title, v.content, text, user.id, now(), page.id);
  const fresh = await getPage(c.env, page.id);
  await reindex(c.env, fresh);
  return c.json({ page: shape(fresh) });
});

// Per-page sharing
pages.get("/:id/shares", async (c) => {
  const page = await getPage(c.env, c.req.param("id"));
  const access = await loadAccess(c.env, c.var.user);
  if (!access.level(page.id)) throw forbidden();
  const shares = await all(c.env.DB, "SELECT user_id, level FROM page_shares WHERE page_id = ?", page.id);
  // Shares on ancestors also apply here; show them so it's clear who can see the page.
  const inherited = await all(
    c.env.DB,
    `WITH RECURSIVE anc(id, parent_id) AS (
       SELECT id, parent_id FROM pages WHERE id = (SELECT parent_id FROM pages WHERE id = ?)
       UNION ALL SELECT p.id, p.parent_id FROM pages p JOIN anc ON p.id = anc.parent_id)
     SELECT s.user_id, s.level, pg.title AS via FROM page_shares s JOIN anc ON anc.id = s.page_id JOIN pages pg ON pg.id = s.page_id`,
    page.id,
  );
  return c.json({ shares, inherited });
});

pages.put("/:id/shares/:userId", async (c) => {
  const user = c.var.user;
  const page = await getPage(c.env, c.req.param("id"));
  const access = await loadAccess(c.env, user);
  if (access.level(page.id) < 3) throw forbidden("Only people who can edit a page can share it.");
  const { level } = await c.req.json<{ level?: string }>();
  if (!level || !["view", "comment", "edit"].includes(level)) throw bad("Unknown access level.");
  const target = await first<User>(c.env.DB, "SELECT * FROM users WHERE id = ? AND active = 1", c.req.param("userId"));
  if (!target) throw notFound("That person isn't in the workspace.");
  const existing = await first(c.env.DB, "SELECT 1 FROM page_shares WHERE page_id = ? AND user_id = ?", page.id, target.id);
  await run(
    c.env.DB,
    `INSERT INTO page_shares (page_id, user_id, level, created_by, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (page_id, user_id) DO UPDATE SET level = excluded.level`,
    page.id, target.id, level, user.id, now(),
  );
  if (!existing) {
    await notify(c.env, c.var.origin, {
      user_id: target.id, actor_id: user.id, type: "share",
      title: `${user.name} shared “${page.title || "Untitled"}” with you`,
      url: `/p/${page.id}`, email: true,
    });
  }
  return c.json({ ok: true });
});

pages.delete("/:id/shares/:userId", async (c) => {
  const page = await getPage(c.env, c.req.param("id"));
  const access = await loadAccess(c.env, c.var.user);
  // People can always remove themselves; otherwise editing rights are needed.
  if (access.level(page.id) < 3 && c.req.param("userId") !== c.var.user.id) throw forbidden();
  await run(c.env.DB, "DELETE FROM page_shares WHERE page_id = ? AND user_id = ?", page.id, c.req.param("userId"));
  return c.json({ ok: true });
});
