import { all, isAdmin, type Env, type User } from "./env";

/** 0 none · 1 view · 2 comment · 3 edit */
export type Level = 0 | 1 | 2 | 3;
const LEVELS: Record<string, Level> = { view: 1, comment: 2, edit: 3 };

type Node = { id: string; parent_id: string | null; space_id: string | null; owner_id: string };

export type Access = {
  memberSpaces: Set<string>;
  /** Access level for a page, inheriting shares from its ancestors. */
  level(pageId: string): Level;
  canSeeSpace(spaceId: string | null): boolean;
  node(pageId: string): Node | undefined;
};

/**
 * Builds the caller's view of the workspace in three small queries. Rules:
 *  - a page in a space is editable by the space's members (and workspace admins);
 *  - a page with no space is private to its owner;
 *  - a share on a page grants its level on that page and everything beneath it;
 *  - guests see only what is shared with them.
 */
export async function loadAccess(env: Env, user: User): Promise<Access> {
  const [pages, shares, memberships] = await Promise.all([
    all<Node>(env.DB, "SELECT id, parent_id, space_id, owner_id FROM pages"),
    all<{ page_id: string; level: string }>(env.DB, "SELECT page_id, level FROM page_shares WHERE user_id = ?", user.id),
    isAdmin(user)
      ? all<{ space_id: string }>(env.DB, "SELECT id AS space_id FROM spaces")
      : all<{ space_id: string }>(env.DB, "SELECT space_id FROM space_members WHERE user_id = ?", user.id),
  ]);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const shareMap = new Map(shares.map((s) => [s.page_id, LEVELS[s.level] ?? 1]));
  const memberSpaces = new Set(user.role === "guest" ? [] : memberships.map((m) => m.space_id));
  const cache = new Map<string, Level>();

  const level = (id: string, depth = 0): Level => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const p = byId.get(id);
    if (!p || depth > 64) return 0;
    let lvl: Level = 0;
    if (p.space_id ? memberSpaces.has(p.space_id) : p.owner_id === user.id) lvl = 3;
    if (lvl < 3) {
      lvl = Math.max(lvl, shareMap.get(id) ?? 0) as Level;
      if (lvl < 3 && p.parent_id) lvl = Math.max(lvl, level(p.parent_id, depth + 1)) as Level;
    }
    cache.set(id, lvl);
    return lvl;
  };

  return {
    memberSpaces,
    level: (id) => level(id),
    canSeeSpace: (spaceId) => (spaceId ? memberSpaces.has(spaceId) : true),
    node: (id) => byId.get(id),
  };
}

type TaskRow = { assignee_id: string | null; creator_id: string; space_id: string | null };
/** A task is visible to its assignee and creator, and to members of its space. */
export function canSeeTask(t: TaskRow, user: User, memberSpaces: Set<string>): boolean {
  if (t.assignee_id === user.id || t.creator_id === user.id) return true;
  return !!t.space_id && memberSpaces.has(t.space_id);
}

export async function memberSpaceIds(env: Env, user: User): Promise<Set<string>> {
  if (user.role === "guest") return new Set();
  const rows = isAdmin(user)
    ? await all<{ id: string }>(env.DB, "SELECT id FROM spaces")
    : await all<{ id: string }>(env.DB, "SELECT space_id AS id FROM space_members WHERE user_id = ?", user.id);
  return new Set(rows.map((r) => r.id));
}
