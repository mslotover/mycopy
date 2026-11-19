// Meaning-based search. Each searchable item's text (as held in the keyword index) is cut
// into overlapping chunks, embedded with a Workers AI model and stored in Vectorize, so a
// search for "cold storage" can find a page that only says "walk-in fridge".
//
// Saving an item only marks it dirty (indexDoc in env.ts); a cron job does the embedding
// every few minutes, so saves never wait on it and a failure never blocks keyword search.
import { all, first, type Env } from "./env";

const MODEL = "@cf/baai/bge-m3"; // multilingual, 1024 dimensions, long inputs
const CHUNK = 1200; // characters per chunk
const OVERLAP = 200;
const MAX_CHUNKS = 150; // per item; enough for a two-hour meeting transcript
const EMBED_BATCH = 50;
/** Cosine similarity below which a chunk isn't considered related. */
const MIN_SCORE = 0.5;

export function hasVectors(env: Env): env is Env & { VECTORS: Vectorize } {
  return !!env.VECTORS && !!env.AI && env.DEV_MODE !== "1";
}

const vid = (kind: string, ref: string, n: number) => `${kind}:${ref}:${n}`;

export function chunkText(body: string): string[] {
  const text = body.replace(/\s+/g, " ").trim();
  const out: string[] = [];
  let start = 0;
  while (start < text.length && out.length < MAX_CHUNKS) {
    let end = Math.min(text.length, start + CHUNK);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > start + CHUNK / 2) end = space;
    }
    out.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    let next = end - OVERLAP;
    const space = text.indexOf(" ", next);
    if (space !== -1 && space < end) next = space + 1;
    start = Math.max(next, start + 1);
  }
  return out;
}

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const res = (await env.AI.run(MODEL, { text: texts.slice(i, i + EMBED_BATCH), truncate_inputs: true })) as { data?: number[][] };
    if (!res.data || res.data.length !== Math.min(EMBED_BATCH, texts.length - i)) throw new Error("Unexpected embedding response");
    out.push(...res.data);
  }
  return out;
}

async function sha(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Embeds items whose text changed. Runs from the cron trigger; returns how many chunks it embedded. */
export async function embedDirty(env: Env, budget = 600): Promise<number> {
  if (!hasVectors(env)) return 0;
  const docs = await all<{ kind: string; ref: string; hash: string | null; chunks: number; dirty: number }>(
    env.DB,
    "SELECT kind, ref, hash, chunks, dirty FROM vector_docs WHERE dirty > 0 LIMIT 60",
  );
  let used = 0;
  for (const d of docs) {
    if (used >= budget) break;
    try {
      const src = await first<{ title: string; body: string }>(env.DB, "SELECT title, body FROM search WHERE kind = ? AND ref = ?", d.kind, d.ref);
      const oldIds = Array.from({ length: d.chunks }, (_, n) => vid(d.kind, d.ref, n));
      const title = src?.title.trim() ?? "";
      const parts = src ? chunkText(src.body) : [];
      if (!parts.length && title) parts.push("");

      if (!parts.length) {
        // Deleted, or nothing to embed.
        if (oldIds.length) await env.VECTORS.deleteByIds(oldIds);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM vector_chunks WHERE kind = ? AND ref = ?").bind(d.kind, d.ref),
          env.DB.prepare("DELETE FROM vector_docs WHERE kind = ? AND ref = ? AND dirty = ?").bind(d.kind, d.ref, d.dirty),
        ]);
        continue;
      }

      const hash = await sha(`${title}\n${src!.body}`);
      if (hash !== d.hash) {
        const vectors = await embed(env, parts.map((p) => (p ? `${title}\n${p}` : title)));
        await env.VECTORS.upsert(vectors.map((values, n) => ({ id: vid(d.kind, d.ref, n), values, metadata: { kind: d.kind } })));
        if (oldIds.length > parts.length) await env.VECTORS.deleteByIds(oldIds.slice(parts.length));
        await env.DB.batch([
          env.DB.prepare("DELETE FROM vector_chunks WHERE kind = ? AND ref = ?").bind(d.kind, d.ref),
          ...parts.map((p, n) =>
            env.DB.prepare("INSERT INTO vector_chunks (id, kind, ref, title, text) VALUES (?, ?, ?, ?, ?)").bind(vid(d.kind, d.ref, n), d.kind, d.ref, title, p),
          ),
        ]);
        used += parts.length;
      }
      // Only clear the flag if nobody saved the item while we were working on it.
      await env.DB.prepare("UPDATE vector_docs SET hash = ?, chunks = ?, dirty = CASE WHEN dirty = ? THEN 0 ELSE dirty END WHERE kind = ? AND ref = ?")
        .bind(hash, parts.length, d.dirty, d.kind, d.ref)
        .run();
    } catch (err) {
      console.error("embedding failed", d.kind, d.ref, err);
    }
  }
  return used;
}

export type SemanticHit = { kind: string; ref: string; title: string; text: string; score: number };

/** Items whose meaning is closest to the query, best first, one entry per item. Never throws. */
export async function semanticSearch(env: Env, query: string, topK = 50): Promise<SemanticHit[]> {
  if (!hasVectors(env) || !query.trim()) return [];
  try {
    const [vector] = await embed(env, [query.slice(0, 2000)]);
    const res = await env.VECTORS.query(vector, { topK, returnValues: false, returnMetadata: "none" });
    const matches = res.matches.filter((m) => m.score >= MIN_SCORE);
    if (!matches.length) return [];
    const rows = await all<{ id: string; kind: string; ref: string; title: string; text: string }>(
      env.DB,
      `SELECT id, kind, ref, title, text FROM vector_chunks WHERE id IN (${matches.map(() => "?").join(",")})`,
      ...matches.map((m) => m.id),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: SemanticHit[] = [];
    const seen = new Set<string>();
    for (const m of matches) {
      const r = byId.get(m.id);
      if (!r || seen.has(r.kind + r.ref)) continue;
      seen.add(r.kind + r.ref);
      out.push({ kind: r.kind, ref: r.ref, title: r.title, text: r.text, score: m.score });
    }
    return out;
  } catch (err) {
    console.error("semantic search failed", err);
    return [];
  }
}
