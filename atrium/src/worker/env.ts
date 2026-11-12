import type { Context } from "hono";

export type Env = {
  DB: D1Database;
  FILES: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  APP_NAME: string;
  MAIL_FROM: string;
  CLAUDE_MODEL: string;
  WHISPER_MODEL: string;
  ANTHROPIC_API_KEY?: string;
  RESEND_API_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** "1" in local development: emails are recorded but not sent, AI steps are simulated. */
  DEV_MODE?: string;
};

export type User = {
  id: string;
  email: string;
  name: string;
  color: string;
  role: "owner" | "admin" | "member" | "guest";
  active: number;
};

export type HonoEnv = { Bindings: Env; Variables: { user: User; origin: string } };
export type Ctx = Context<HonoEnv>;

export const now = () => Date.now();

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export function uid(len = 16): string {
  let out = "";
  while (out.length < len) {
    // 62 symbols: skip bytes >= 248 so the distribution stays uniform.
    for (const b of crypto.getRandomValues(new Uint8Array(len))) {
      if (b < 248 && out.length < len) out += ALPHABET[b % 62];
    }
  }
  return out;
}

export function token(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function all<T = Record<string, unknown>>(db: D1Database, sql: string, ...args: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...args).all<T>();
  return res.results ?? [];
}
export async function first<T = Record<string, unknown>>(db: D1Database, sql: string, ...args: unknown[]): Promise<T | null> {
  return await db.prepare(sql).bind(...args).first<T>();
}
export async function run(db: D1Database, sql: string, ...args: unknown[]) {
  return await db.prepare(sql).bind(...args).run();
}

export const isAdmin = (u: User) => u.role === "owner" || u.role === "admin";
export const isDev = (env: Env) => env.DEV_MODE === "1";

export function parseJSON<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Plain text of an editor document (TipTap JSON or `{html}`), used for search and AI context. */
export function docText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "object" && content !== null && "html" in content) {
    return htmlText(String((content as { html: unknown }).html ?? ""));
  }
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "text" && typeof n.text === "string") out.push(n.text);
    else if (n.type === "mention") out.push("@" + (n.attrs?.label ?? ""));
    else if (n.type === "hardBreak") out.push("\n");
    if (Array.isArray(n.content)) {
      n.content.forEach(walk);
      if (n.type !== "doc" && n.type !== "text") out.push("\n");
    }
  };
  walk(content);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlText(html: string): string {
  return html
    .replace(/<(br|\/p|\/h\d|\/li|\/tr|\/div|\/blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** User ids mentioned in an editor document. */
export function docMentions(content: unknown): Set<string> {
  const ids = new Set<string>();
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "mention" && n.attrs?.id) ids.add(String(n.attrs.id));
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(content);
  return ids;
}

export async function indexDoc(db: D1Database, kind: string, ref: string, title: string, body: string) {
  await db.batch([
    db.prepare("DELETE FROM search WHERE kind = ? AND ref = ?").bind(kind, ref),
    db.prepare("INSERT INTO search (title, body, kind, ref) VALUES (?, ?, ?, ?)").bind(title, body.slice(0, 200_000), kind, ref),
  ]);
}
export async function unindexDoc(db: D1Database, kind: string, ref: string) {
  await run(db, "DELETE FROM search WHERE kind = ? AND ref = ?", kind, ref);
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const bad = (msg: string) => new HttpError(400, msg);
export const forbidden = (msg = "You don't have access to this.") => new HttpError(403, msg);
export const notFound = (msg = "Not found.") => new HttpError(404, msg);
