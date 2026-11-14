import { api, ApiError, invalidate, qc } from "./api";

/**
 * What makes Atrium behave like an app on a phone: a service worker so it opens without a
 * connection, the last-seen workspace and task lists kept on the device, ticks made
 * offline held until they can be sent, and notifications.
 */

// ---------- Opening without a connection ----------

const KEEP = "atrium.kept.v1";
const KEPT_KEYS = new Set(["boot", "tasks"]);

/** Puts back the workspace and task lists as they were last seen, then keeps them saved. */
export function keepForOffline() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEEP) ?? "[]") as { key: unknown[]; data: unknown; at: number }[];
    for (const s of saved) qc.setQueryData(s.key, s.data, { updatedAt: s.at });
  } catch { /* nothing usable saved */ }
  let timer: ReturnType<typeof setTimeout> | undefined;
  qc.getQueryCache().subscribe((event) => {
    if (!KEPT_KEYS.has(String(event.query.queryKey[0]))) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const keep = qc.getQueryCache().getAll()
        .filter((q) => KEPT_KEYS.has(String(q.queryKey[0])) && q.state.data !== undefined)
        .map((q) => ({ key: q.queryKey, data: q.state.data, at: q.state.dataUpdatedAt }));
      try { localStorage.setItem(KEEP, JSON.stringify(keep)); } catch { /* storage full or unavailable */ }
    }, 400);
  });
}

/** Forget everything kept on this device (on sign-out, so the next person doesn't see it). */
export function forgetDevice() {
  localStorage.removeItem(KEEP);
  localStorage.removeItem(WAITING);
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.hostname === "localhost" && location.port === "5173") return;
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
}

// ---------- Changes made while offline ----------

const WAITING = "atrium.waiting.v1";
type Waiting = { id: string; patch: Record<string, unknown> };
const waiting = (): Waiting[] => { try { return JSON.parse(localStorage.getItem(WAITING) ?? "[]"); } catch { return []; } };
const setWaiting = (list: Waiting[]) => localStorage.setItem(WAITING, JSON.stringify(list));

/** True when a request failed because the network did, not because the server said no. */
export const isOffline = (e: unknown) => !(e instanceof ApiError);

/** Holds a task change until there is a connection. Later changes to the same task merge in. */
export function holdTaskChange(id: string, patch: Record<string, unknown>) {
  const list = waiting();
  const existing = list.find((w) => w.id === id);
  if (existing) Object.assign(existing.patch, patch);
  else list.push({ id, patch });
  setWaiting(list);
}

export const waitingCount = () => waiting().length;

let sending = false;
/** Sends held changes, oldest first. Stops at the first network failure and tries again later. */
export async function sendWaiting(): Promise<void> {
  if (sending || !waiting().length) return;
  sending = true;
  try {
    for (let list = waiting(); list.length; list = waiting()) {
      const next = list[0];
      try {
        await api(`/tasks/${next.id}`, { method: "PATCH", body: next.patch });
      } catch (e) {
        if (isOffline(e)) return; // still no connection
        // The server refused it (the task was deleted, say): drop it rather than retry forever.
      }
      setWaiting(waiting().filter((w) => w.id !== next.id));
    }
    invalidate("tasks");
  } finally {
    sending = false;
  }
}

export function watchConnection() {
  window.addEventListener("online", () => void sendWaiting());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void sendWaiting(); });
  void sendWaiting();
}

// ---------- Notifications ----------

export const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export type PushState = "on" | "off" | "blocked" | "needs-install" | "unsupported";

export async function pushState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    // iPhones only offer notifications to web apps that have been added to the Home Screen.
    return isIOS() && !isStandalone() ? "needs-install" : "unsupported";
  }
  if (Notification.permission === "denied") return "blocked";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

const keyBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

/** Asks permission (must be called from a tap) and registers this device. */
export async function turnOnPush(): Promise<PushState> {
  const { key } = await api<{ key: string | null }>("/push/key");
  if (!key) throw new Error("Notifications aren't set up on this workspace yet.");
  if ((await Notification.requestPermission()) !== "granted") return "blocked";
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  await api("/push/subscribe", { body: sub.toJSON() });
  return "on";
}

export async function turnOffPush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api("/push/unsubscribe", { body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  return "off";
}
