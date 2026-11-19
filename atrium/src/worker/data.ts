// Business figures from the Toklas data connector (a separate Worker reached through the DATA
// service binding). Atrium names the person asking; the connector decides what they may see.
import type { Env, User } from "./env";

export const hasData = (env: Env, user: Pick<User, "role">) => !!env.DATA && !!env.ATRIUM_DATA_KEY && user.role !== "guest";

/** Calls /atrium/tables or /atrium/query; returns the raw JSON text and whether it succeeded. */
export async function callData(env: Env, email: string, path: string, body: unknown): Promise<{ ok: boolean; text: string }> {
  const res = await env.DATA!.fetch(`https://toklas-data-connector${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-atrium-key": env.ATRIUM_DATA_KEY!, "x-atrium-user": email },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 404 && !text.startsWith("{")) throw new Error("The business data connector isn't accepting Atrium's requests yet.");
  return { ok: res.ok, text };
}

/** Runs one SELECT and returns its rows; throws with the connector's message on failure. */
export async function queryData<T = Record<string, unknown>>(env: Env, email: string, sql: string): Promise<T[]> {
  const r = await callData(env, email, "/atrium/query", { sql });
  const body = JSON.parse(r.text) as { rows?: T[]; error?: string };
  if (!r.ok) throw new Error(body.error ?? "Query failed");
  return body.rows ?? [];
}
