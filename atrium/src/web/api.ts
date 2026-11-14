import { QueryClient, useQuery } from "@tanstack/react-query";

export type Role = "owner" | "admin" | "member" | "guest";
export type User = { id: string; email: string; name: string; color: string; role: Role; active: number };
export type Space = { id: string; name: string; icon: string; color: string; description: string; member_ids: string[] };
export type Boot = { user: User; appName: string; aiReady: boolean; users: User[]; spaces: Space[]; unread: number };

export type TreeNode = {
  id: string; parent_id: string | null; space_id: string | null; owner_id: string; kind: "page" | "database";
  title: string; icon: string; sort: number; is_template: boolean; section: "space" | "private" | "shared"; root: boolean;
};

export type PropType = "text" | "number" | "select" | "multi_select" | "status" | "date" | "person" | "checkbox" | "url";
export type Option = { id: string; name: string; color: string };
export type Prop = { id: string; name: string; type: PropType; options?: Option[] };
export type View = { id: string; name: string; type: "table" | "board" | "calendar" | "list"; groupBy?: string; dateProp?: string; sort?: { prop: string; dir: "asc" | "desc" } };
export type Schema = { props: Prop[]; views: View[] };

export type Page = {
  id: string; space_id: string | null; owner_id: string; parent_id: string | null; kind: "page" | "database" | "row";
  title: string; icon: string; sort: number; is_template: boolean; archived: boolean; source_url: string | null;
  created_by: string; updated_by: string; created_at: number; updated_at: number;
  props: Record<string, any>; schema?: Schema; content?: any; has_content?: boolean;
};
export type PageDetail = {
  page: Page; level: "view" | "comment" | "edit"; crumbs: { id: string; title: string; icon: string }[];
  rows?: Page[]; database?: { id: string; title: string; schema: Schema }; subpages: { id: string; title: string; icon: string; kind: string }[];
};

export type Task = {
  id: string; title: string; notes: string; status: "todo" | "doing" | "done"; assignee_id: string | null; creator_id: string;
  space_id: string | null; project: string; due: string | null; meeting_id: string | null; meeting_title?: string | null;
  needs_owner: boolean; sort: number; completed_at: number | null; source_url: string | null; created_at: number; updated_at: number;
};

export type MeetingStatus = "recording" | "processing" | "review" | "sent" | "failed";
export type MeetingListItem = {
  id: string; title: string; space_id: string | null; organizer_id: string; status: MeetingStatus;
  started_at: number; duration_s: number; sent_at: number | null; error: string | null; preview: string; people: string[];
};
export type Participant = { id: string; user_id: string | null; name: string; email: string; notify: boolean };
export type MeetingItem = { id: string; kind: "task" | "knowledge"; accepted: boolean; payload: Record<string, any> };
export type MeetingDetail = {
  meeting: MeetingListItem & { transcript: string; summary_html: string; summary_doc: any; source_url: string | null };
  participants: Participant[]; segments: { idx: number; status: string; bytes: number }[]; items: MeetingItem[]; isOrganiser: boolean;
};

export type Knowledge = { id: string; space_id: string | null; owner_id: string; kind: string; title: string; body: string; meeting_id: string | null; meeting_title: string | null; created_at: number };
export type Notification = { id: string; actor_id: string | null; type: string; title: string; body: string; url: string; read: number; created_at: number };
export type Comment = { id: string; author_id: string; body: string; resolved: number; created_at: number };
export type Hit = { kind: "page" | "task" | "meeting" | "knowledge"; id: string; title: string; snippet: string; url: string; where: string };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: Blob } = {}): Promise<T> {
  const res = await fetch("/api" + path, {
    method: opts.method ?? (opts.body !== undefined || opts.raw ? "POST" : "GET"),
    headers: opts.raw ? { "Content-Type": opts.raw.type || "audio/webm" } : opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    credentials: "same-origin",
  });
  if (res.status === 401 && !path.startsWith("/auth/")) {
    // Signed out: don't leave the last-seen workspace on the device.
    try { localStorage.removeItem("atrium.kept.v1"); localStorage.removeItem("atrium.waiting.v1"); } catch { /* storage unavailable */ }
    if (!location.pathname.startsWith("/signin")) location.assign("/signin");
    throw new ApiError(401, "Please sign in.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as any).error ?? "Something went wrong.");
  return data as T;
}

/** Reads a server-sent event stream from a POST request, calling `on` for each event. */
export async function sse(path: string, body: unknown, on: (event: string, data: any) => void, signal?: AbortSignal) {
  const res = await fetch("/api" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}), signal });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (data as any).error ?? "Something went wrong.");
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length) {
        try { on(event, JSON.parse(data.join("\n"))); } catch { /* ignore a malformed event */ }
      }
    }
  }
}

export const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2 } },
});

export const useBoot = () => useQuery({ queryKey: ["boot"], queryFn: () => api<Boot>("/bootstrap"), staleTime: 60_000, refetchInterval: 60_000 });
export const useTree = () => useQuery({ queryKey: ["tree"], queryFn: () => api<{ pages: TreeNode[] }>("/pages/tree").then((r) => r.pages) });
export const useTasks = (scope: string, enabled = true) =>
  useQuery({ queryKey: ["tasks", scope], queryFn: () => api<{ tasks: Task[] }>(`/tasks?scope=${encodeURIComponent(scope)}`).then((r) => r.tasks), enabled });
export const useMeetings = () => useQuery({ queryKey: ["meetings"], queryFn: () => api<{ meetings: MeetingListItem[] }>("/meetings").then((r) => r.meetings) });

export const invalidate = (...keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

// ---------- small helpers ----------

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

export function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`;
  if (d < 7 * 86400_000) return `${Math.floor(d / 86400_000)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export function dueLabel(iso: string): { text: string; tone: "overdue" | "today" | "soon" | "later" } {
  const t = todayISO();
  if (iso < t) return { text: iso === addDays(t, -1) ? "Yesterday" : fmtDate(iso), tone: "overdue" };
  if (iso === t) return { text: "Today", tone: "today" };
  if (iso === addDays(t, 1)) return { text: "Tomorrow", tone: "soon" };
  if (iso < addDays(t, 7)) return { text: new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "long" }), tone: "soon" };
  return { text: fmtDate(iso), tone: "later" };
}
export const fmtDate = (iso: string) =>
  new Date(iso + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: iso.slice(0, 4) === String(new Date().getFullYear()) ? undefined : "numeric" });
export const fmtDuration = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.round(s / 60)} min` : `${s}s`);
export const clock = (s: number) => `${s >= 3600 ? Math.floor(s / 3600) + ":" : ""}${String(Math.floor((s % 3600) / 60)).padStart(s >= 3600 ? 2 : 1, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const rid = () => Math.random().toString(36).slice(2, 10);
