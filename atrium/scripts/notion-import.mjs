#!/usr/bin/env node
/**
 * Turns raw Notion connector results (import-data/raw, see notion-extract.py) into SQL for
 * Atrium's database, plus a script that loads the downloaded files into R2.
 *
 * What goes where:
 *   people          -> users (the person who ran the import is the owner; free-mail addresses are guests)
 *   teamspaces      -> spaces
 *   pages           -> pages (Notion markdown becomes HTML the editor reads)
 *   databases       -> database pages with rows, except:
 *   task databases  -> tasks        (anything called Tasks, Private Tasks, Action log)
 *   meeting notes   -> meetings     (summary, notes and transcript; minutes databases too)
 *   key decisions   -> Brain notes
 *
 * Privacy rule: nothing becomes visible to more people than it was in Notion. Private and
 * individually-shared pages stay private to the owner; private meetings keep their attendees
 * as names only; tasks from private databases stay with their creator.
 *
 * Usage: node scripts/notion-import.mjs [import-data]
 * Writes atrium-import.local.sql, load-files.sh and report.md into that folder.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Marked } from "marked";

const dir = process.argv[2] ?? "import-data";
const NOW = Date.now();
/**
 * Optional import-config.json beside the raw data, for what the data can't say:
 *   { "businessSpace": { "<value of a Business column>": "<space name>" },
 *     "spaceLook": { "<space name>": ["<emoji>", "<colour>"] } }
 */
const config = existsSync(join(dir, "import-config.json")) ? JSON.parse(readFileSync(join(dir, "import-config.json"), "utf8")) : {};

// ---------- Names this importer recognises ----------

const TASK_SOURCES = /^(tasks|private tasks|action log)$/i;
const MEETING_SOURCES = /(meeting|minutes)/i;
const SKIP_SOURCES = /^(todo list|meeting inbox)$/i; // Notion's sample list, and an empty inbox
const SKIP_PAGES = /^(getting started|to do list)$/i; // Notion onboarding pages
const FREE_MAIL = /@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail)\./i;
const SPACE_LOOK = [
  [/general/i, "🏠", "#0071e3"],
  [/restaurant|kitchen|cafe/i, "🍽️", "#ff3b30"],
  [/bakery/i, "🥐", "#ff9500"],
  [/chocolate/i, "🍫", "#a2845e"],
  [/hotel/i, "🏨", "#5856d6"],
  [/owner|board|director/i, "🔑", "#34c759"],
];
const USER_COLORS = ["#0071e3", "#34c759", "#ff9500", "#af52de", "#ff2d55", "#30b0c7", "#ff3b30", "#5856d6", "#a2845e", "#64d2ff"];

// ---------- Small helpers ----------

const ids32 = (s) => String(s ?? "").replace(/-/g, "").match(/[0-9a-f]{32}/gi) ?? [];
/** The page a Notion URL points at, and the block after the #, if any. */
const pageIdOf = (url) => ids32(String(url ?? "").split("#")[0]).pop()?.toLowerCase() ?? null;
const anchorOf = (url) => (String(url ?? "").includes("#") ? ids32(String(url).split("#")[1]).pop()?.toLowerCase() ?? null : null);
const sha = (s) => createHash("sha1").update(s).digest("hex");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const arr = (v) => (Array.isArray(v) ? v : typeof v === "string" && v.trim().startsWith("[") ? safeJSON(v, []) : v ? [v] : []);
const safeJSON = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const toMs = (s) => { const t = Date.parse(String(s ?? "").replace(" ", "T").replace(/(\d)Z?$/, "$1Z").replace("ZZ", "Z")); return Number.isFinite(t) ? t : null; };
const dateOnly = (s) => (s ? String(s).slice(0, 10) : null);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const niceDate = (iso, time) => { const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number); return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}${time ? `, ${time}` : ""}` : String(iso); };
const unescapeMd = (s) => String(s ?? "").replace(/\\([\\<>\[\]_*~`#|()!.+-])/g, "$1");
const htmlToText = (html) => String(html ?? "")
  .replace(/<(br|\/p|\/h\d|\/li|\/tr|\/div|\/blockquote)[^>]*>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\n{3,}/g, "\n\n").trim();
/** A title as plain text: tags out, date mentions written out. */
const plainTitle = (s) => unescapeMd(String(s ?? "")
  .replace(/<date start="([^"]+)"(?: start-time="([^"]+)")?[^>]*\/>/g, (_, d, t) => niceDate(d, t))
  .replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

// ---------- Read the raw results ----------

const raw = readdirSync(join(dir, "raw")).filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(readFileSync(join(dir, "raw", f), "utf8")))
  .map((r) => ({ ...r, j: safeJSON(r.result, null) }))
  .filter((r) => r.j);
const only = (tool) => raw.filter((r) => r.tool === tool);

const self = only("get-self")[0]?.j?.user;
if (!self) throw new Error("No get-self result: can't tell who the owner is.");
const people = (only("get-users").find((r) => !r.input.user_id)?.j?.results ?? []).filter((u) => u.type === "person" && u.email);
const teams = (only("get-teams")[0]?.j?.joinedTeams ?? []).filter((t) => !t.in_trash);
const privateIds = new Set((only("list-private-pages")[0]?.j?.results ?? []).map((p) => pageIdOf(p.url)));
const sharedIds = new Set((only("list-shared-pages")[0]?.j?.results ?? []).map((p) => pageIdOf(p.url)));
const teamOfNotion = new Map(); // page or database id -> teamspace id
for (const r of only("search")) {
  const team = r.input.teamspace_id && ids32(r.input.teamspace_id)[0];
  if (team) for (const hit of r.j.results ?? []) teamOfNotion.set(ids32(hit.id)[0], team);
}

/** Every fetched page or block, keeping the fullest copy (a copy with its transcript wins). */
const fetched = new Map();
const sources = new Map(); // collection id -> { title, dbId, state }
function addSource(text, dbUrl) {
  for (const m of text.matchAll(/<data-source url="\{\{collection:\/\/([0-9a-f-]+)\}\}">([\s\S]*?)<\/data-source>/g)) {
    const state = safeJSON(m[2].match(/<data-source-state>\n([\s\S]*?)\n<\/data-source-state>/)?.[1], null);
    const description = m[2].match(/The description of this Data Source is: (.*)/)?.[1]?.trim() ?? "";
    if (state) sources.set(ids32(m[1])[0], { id: ids32(m[1])[0], title: state.name, dbId: pageIdOf(dbUrl), state, description });
  }
}
for (const r of only("fetch")) {
  const kind = r.j.metadata?.type;
  const text = r.j.text ?? "";
  if (kind === "data_source" || kind === "database") { addSource(text, r.j.url); continue; }
  if (kind !== "page" && kind !== "block") continue;
  const id = pageIdOf(r.j.url);
  const prev = fetched.get(id);
  if (!prev || text.length > prev.text.length) fetched.set(id, { ...r.j, id, kind, text });
}

/** Rows of each queried data source, by collection id. Full SQL rows win over partial ones. */
const rowsOf = new Map();
const queries = only("query-data-sources").sort((a, b) => (a.input.data?.mode === "rows" ? 1 : 0) - (b.input.data?.mode === "rows" ? 1 : 0));
for (const r of queries) {
  const src = ids32(r.input.data?.data_source_urls?.[0] ?? r.input.data?.data_source_url)[0];
  if (!src) continue;
  const bag = rowsOf.get(src) ?? rowsOf.set(src, new Map()).get(src);
  for (const row of r.j.results ?? []) {
    const id = pageIdOf(row.url);
    if (id && !bag.has(id)) bag.set(id, row);
  }
}

// ---------- People and spaces ----------

const tidyName = (u) => {
  let n = u.name && !u.name.includes("@") ? u.name : u.email.split("@")[0].replace(/[._]+/g, " ");
  if (!/\s/.test(n) && u.email) { // "trentedmunds" -> try to split on the mailbox name
    const local = u.email.split("@")[0].toLowerCase();
    if (n.toLowerCase().startsWith(local) && n.length > local.length) n = `${n.slice(0, local.length)} ${n.slice(local.length)}`;
  }
  return n.split(/\s+/).map((w) => (w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
};
const users = people.map((u, i) => ({
  id: ids32(u.id)[0], email: u.email.toLowerCase(), name: tidyName(u), color: USER_COLORS[i % USER_COLORS.length],
  role: ids32(u.id)[0] === ids32(self.id)[0] ? "owner" : FREE_MAIL.test(u.email) ? "guest" : "member",
}));
const userById = new Map(users.map((u) => [u.id, u]));
const owner = users.find((u) => u.role === "owner");
const knownUsers = (v) => arr(v).map((x) => ids32(x)[0]).filter((x) => userById.has(x));
const unknownUsers = (v) => arr(v).map((x) => ids32(x)[0]).filter((x) => x && !userById.has(x));

const spaces = teams.map((t, i) => {
  const look = config.spaceLook?.[t.name] ? [null, ...config.spaceLook[t.name]] : SPACE_LOOK.find(([re]) => re.test(t.name));
  return { id: ids32(t.id)[0], name: t.name, icon: look?.[1] ?? "📁", color: look?.[2] ?? "#0071e3", sort: /general/i.test(t.name) ? 0 : i + 1, members: new Set([owner.id]) };
}).sort((a, b) => a.sort - b.sort);
const spaceById = new Map(spaces.map((s) => [s.id, s]));
const spaceNamed = (re) => spaces.find((s) => re.test(s.name)) ?? null;
const generalSpace = spaceNamed(/general/i);
const ownersSpace = spaceNamed(/owner|board/i);
/** A "Business" value names a space: by the config, by "Group"/"All" meaning everyone, or by sharing its name. */
const spaceForBusiness = (b) => {
  for (const name of arr(b)) {
    const low = String(name).toLowerCase();
    const mapped = config.businessSpace?.[name];
    const s = mapped ? spaces.find((x) => x.name === mapped)
      : /^(group|all|everyone|company)$/.test(low) ? generalSpace
      : spaces.find((x) => x.name.toLowerCase() === low) ?? spaces.find((x) => x.name.toLowerCase().includes(low) || low.includes(x.name.toLowerCase()));
    if (s) return s;
  }
  return null;
};
const join_ = (space, ids) => { if (space) for (const id of ids) if (userById.get(id)?.role !== "guest") space.members.add(id); };

// ---------- Parse pages ----------

function parsePage(f) {
  const t = f.text;
  const anc = t.match(/<ancestor-path>([\s\S]*?)<\/ancestor-path>/)?.[1] ?? "";
  const props = safeJSON(t.match(/<properties>\n([\s\S]*?)\n<\/properties>/)?.[1], {});
  const content = t.includes("<blank-page>") ? "" : t.match(/<content>\n?([\s\S]*)\n?<\/content>/)?.[1] ?? "";
  const icon = f.icon?.type === "emoji" ? f.icon.emoji : "";
  let title = String(f.title ?? "");
  if (icon && title.startsWith(icon)) title = title.slice(icon.length).trim();
  return {
    id: f.id, kind: f.kind, url: `https://app.notion.com/p/${f.id}`, title, icon, props, content,
    parentPage: pageIdOf(anc.match(/<parent-page url="([^"]+)"/)?.[1]),
    parentSource: ids32(anc.match(/<parent-data-source url="collection:\/\/([^"]+)"/)?.[1])[0] ?? null,
    grandparent: pageIdOf(anc.match(/<ancestor-3-page url="([^"]+)"/)?.[1]),
    edited: toMs(f.page_last_edited_at) ?? NOW,
    note: content.match(/<meeting-notes([^>]*)>([\s\S]*?)<\/meeting-notes>/),
  };
}
const pagesIn = [...fetched.values()].map(parsePage);
const pageIn = new Map(pagesIn.map((p) => [p.id, p]));

// ---------- Meetings ----------

function transcriptText(s) {
  if (!s || /Transcript omitted/.test(s)) return "";
  if (!/<line speaker=/.test(s)) return unescapeMd(s.replace(/<[^>]+>/g, "")).trim();
  const out = [];
  let last = null;
  for (const m of s.matchAll(/<line speaker="([^"]*)">\n?([\s\S]*?)\n?<\/line>/g)) {
    const who = m[1].trim() || "?";
    const said = unescapeMd(m[2]).trim();
    if (!said) continue;
    if (who === last) out[out.length - 1] += ` ${said}`;
    else out.push(`Speaker ${who}: ${said}`);
    last = who;
  }
  return out.join("\n\n");
}
const section = (inner, name) => inner.match(new RegExp(`<meeting-notes-section-${name}>\\n?([\\s\\S]*?)\\n?</meeting-notes-section-${name}>`))?.[1] ?? "";
/** A meeting-notes block fetched on its own: three paragraphs holding summary, notes, transcript. */
function blockParts(content) {
  const parts = [];
  let cur = null;
  for (const line of content.split("\n")) {
    if (cur === null && line === "<p>") cur = [];
    else if (cur !== null && line === "</p>") { parts.push(cur.join("\n")); cur = null; }
    else if (cur !== null) cur.push(line);
  }
  if (parts.length >= 3) return { summary: parts[0], notes: parts.slice(1, -1).join("\n\n"), transcript: parts[parts.length - 1] };
  if (parts.length === 2) return { summary: parts[0], notes: "", transcript: parts[1] };
  return { summary: parts[0] ?? content, notes: "", transcript: "" };
}

const listed = new Map((only("query-meeting-notes")[0]?.j?.results ?? []).map((r) => [pageIdOf(r.url), r]));
const wrapperOf = new Map(); // meeting block id -> the page that wraps it
for (const p of pagesIn) if (p.note) { const block = anchorOf(p.note[1].match(/view-url="([^"]+)"/)?.[1]); if (block && block !== p.id) wrapperOf.set(block, p); }

const generic = (t) => !t || /^(new )?meeting\b/i.test(t.trim()) || /^(untitled)?$/i.test(t.trim());
const meetings = [];
const meetingOf = new Map(); // any Notion id that stands for a meeting -> meeting
const skippedMeetings = [];

function addMeeting({ key, aliases = [], title, when, summary, notes, transcript, attendees, sourceId, page, extraHtmlTop = "" }) {
  const text = [summary, notes, transcript].join("").replace(/<[^>]+>/g, "").trim();
  if (text.length < 150 || (/^No transcript was captured/.test(text) && text.length < 400)) { skippedMeetings.push(title || "Untitled meeting"); return null; }
  const src = sourceId ? sources.get(sourceId) : null;
  const m = { id: key, title, when, summary, notes, transcript: transcriptText(transcript) || unescapeMd(String(transcript ?? "")).trim(), attendees: arr(attendees), src, page, extraHtmlTop };
  meetings.push(m);
  for (const a of [key, ...aliases]) if (a) meetingOf.set(a, m);
  return m;
}

// 1. Everything the meeting-notes list returned.
for (const [id, row] of listed) {
  const f = pageIn.get(id);
  if (!f) { skippedMeetings.push(`${plainTitle(row.Title) || "Untitled"} (not fetched)`); continue; }
  const wrap = wrapperOf.get(id);
  const when = toMs(row["Created time"]) ?? f.edited;
  if (f.note) { // a page that is a meeting note
    const inner = f.note[2];
    const named = plainTitle(String(f.props["Meeting name"] ?? f.props.Meeting ?? f.props.title ?? row.Title).replace(/<date[^>]*\/>/g, ""));
    addMeeting({
      key: id, aliases: [anchorOf(f.note[1].match(/view-url="([^"]+)"/)?.[1])], when, page: f, sourceId: f.parentSource,
      title: generic(named) ? `Meeting, ${niceDate(new Date(when).toISOString())}` : named,
      summary: section(inner, "summary"), notes: section(inner, "notes"), transcript: section(inner, "transcript"),
      attendees: (f.note[1].match(/attendees="([^"]*)"/)?.[1] ?? "").split(",").filter(Boolean).concat(arr(f.props.Attendees)),
    });
  } else { // a meeting-notes block inside another page
    const parts = blockParts(f.content);
    const own = plainTitle(f.props.title ?? row.Title);
    const title = wrap && !generic(wrap.title) ? plainTitle(wrap.title.replace(/@.*$/, "")) : !generic(own) ? own : `Meeting, ${niceDate(new Date(when).toISOString())}`;
    addMeeting({
      key: id, aliases: [wrap?.id], when, title, page: wrap ?? f, sourceId: wrap?.parentSource ?? null, ...parts,
      attendees: wrap ? (wrap.note[1].match(/attendees="([^"]*)"/)?.[1] ?? "").split(",").filter(Boolean) : [],
      extraHtmlTop: wrap && !generic(own) && own !== title ? `<p><strong>${esc(own)}</strong></p>` : "",
    });
  }
}
// 2. Meeting pages the list didn't return (other people's notes in shared databases), and minutes.
for (const p of pagesIn) {
  if (meetingOf.has(p.id) || [...wrapperOf.values()].some((w) => w.id === p.id && meetingOf.has(w.id))) continue;
  const src = p.parentSource ? sources.get(p.parentSource) : null;
  const isMinutes = src && MEETING_SOURCES.test(src.title) && !SKIP_SOURCES.test(src.title);
  if (!p.note && !isMinutes) continue;
  const titleProp = src ? Object.entries(src.state.schema).find(([, v]) => v.type === "title")?.[0] : null;
  const named = plainTitle(String((titleProp && p.props[titleProp]) ?? p.title).replace(/<date[^>]*\/>/g, "").replace(/@.*$/, ""));
  const when = toMs(p.props["date:Date:start"]) ?? p.edited;
  const decisions = plainTitle(p.props["Key decisions"] ?? "");
  const top = [
    decisions && `<div data-callout data-emoji="✅"><div><p><strong>Key decisions.</strong> ${esc(decisions)}</p></div></div>`,
    p.props.Recording && `<p><a href="${esc(p.props.Recording)}">Original recording</a></p>`,
  ].filter(Boolean).join("");
  const m = addMeeting({
    key: p.id, aliases: [p.note && anchorOf(p.note[1].match(/view-url="([^"]+)"/)?.[1])], when, page: p, sourceId: p.parentSource,
    title: generic(named) ? `Meeting, ${niceDate(new Date(when).toISOString())}` : named, extraHtmlTop: top,
    summary: p.note ? section(p.note[2], "summary") : p.content, notes: p.note ? section(p.note[2], "notes") : "", transcript: p.note ? section(p.note[2], "transcript") : "",
    attendees: (p.note?.[1].match(/attendees="([^"]*)"/)?.[1] ?? "").split(",").filter(Boolean).concat(arr(p.props.Attendees)),
  });
  if (m) m.decisions = decisions;
}

/** Where a meeting lives: its teamspace, narrowed to a business when the row names one. Private otherwise. */
function meetingSpace(m) {
  const p = m.page;
  if (!p || privateIds.has(p.id) || sharedIds.has(p.id)) return null;
  const biz = spaceForBusiness(p.props.Business);
  const team = teamOfNotion.get(p.id) ?? (m.src && teamOfNotion.get(m.src.dbId)) ?? teamOfNotion.get(p.grandparent) ?? teamOfNotion.get(p.parentPage);
  const space = team ? spaceById.get(team) : null;
  if (space && biz && space === generalSpace) return biz;
  return space ?? null;
}

// ---------- Which pages become what ----------

const wrapperIds = new Set([...wrapperOf.values()].map((w) => w.id));
const taskSourceIds = new Set([...sources.values()].filter((s) => TASK_SOURCES.test(s.title)).map((s) => s.id));
const meetingSourceIds = new Set([...sources.values()].filter((s) => MEETING_SOURCES.test(s.title)).map((s) => s.id));
const skipSourceIds = new Set([...sources.values()].filter((s) => SKIP_SOURCES.test(s.title)).map((s) => s.id));
const dbSources = [...sources.values()].filter((s) => !taskSourceIds.has(s.id) && !meetingSourceIds.has(s.id) && !skipSourceIds.has(s.id) && (rowsOf.get(s.id)?.size || pagesIn.some((p) => p.parentSource === s.id) || true));
const dbById = new Map(dbSources.map((s) => [s.dbId, s]));

const isViewsOnly = (p) => { // a teamspace "home" that only holds filtered views of databases kept elsewhere
  const rest = p.content.replace(/<database[^>]*>[\s\S]*?<\/database>/g, "").replace(/^#+ .*$/gm, "").replace(/\s+/g, " ").trim();
  return (p.content.match(/<database /g) ?? []).length >= 2 && rest.length < 400;
};
const skippedPages = [];
const spaceHome = new Map(); // a skipped teamspace home page -> the space that replaces it
const docs = []; // pages that become Atrium pages
for (const p of pagesIn) {
  if (p.kind !== "page" || meetingOf.has(p.id) || wrapperIds.has(p.id)) continue;
  if (p.parentSource && (taskSourceIds.has(p.parentSource) || meetingSourceIds.has(p.parentSource) || skipSourceIds.has(p.parentSource))) continue;
  if (SKIP_PAGES.test(p.title)) { skippedPages.push(`${p.title} (Notion sample page)`); continue; }
  if (!p.parentSource && !p.parentPage && isViewsOnly(p)) { if (spaceById.has(teamOfNotion.get(p.id))) spaceHome.set(p.id, teamOfNotion.get(p.id)); skippedPages.push(`${p.title} (only filtered views of the task, project and document lists)`); continue; }
  if (p.note) { skippedPages.push(`${p.title} (empty meeting note)`); continue; }
  docs.push(p);
}
const docIds = new Set(docs.map((p) => p.id));

// Where each database sits: the page whose content embeds it.
const dbParent = new Map();
for (const p of pagesIn) for (const m of p.content.matchAll(/<database url="([^"]+)"[^>]*>/g)) { const id = pageIdOf(m[1]); if (dbById.has(id) && !dbParent.has(id) && docIds.has(p.id)) dbParent.set(id, p.id); }
for (const p of pagesIn) if (p.parentSource && p.grandparent) { const s = sources.get(p.parentSource); if (s && dbById.has(s.dbId) && !dbParent.has(s.dbId) && docIds.has(p.grandparent)) dbParent.set(s.dbId, p.grandparent); }

/** Space of a page: private lists first, then its own teamspace, then whatever its parent has. */
const placeMemo = new Map();
function place(id, depth = 0) {
  if (placeMemo.has(id)) return placeMemo.get(id);
  let out = { space: null }; // private to the owner unless shown otherwise
  const p = pageIn.get(id);
  const db = dbById.get(id);
  if (privateIds.has(id) || sharedIds.has(id)) out = { space: null };
  else if (teamOfNotion.has(id) && spaceById.has(teamOfNotion.get(id))) out = { space: spaceById.get(teamOfNotion.get(id)) };
  else if (depth < 12) {
    const up = db ? dbParent.get(id) : p?.parentSource ? sources.get(p.parentSource)?.dbId : p?.parentPage;
    if (up) out = place(up, depth + 1);
  }
  placeMemo.set(id, out);
  return out;
}

// ---------- Notion markdown -> HTML ----------

const fileDir = join(dir, "files");
const files = new Map(); // Notion block id -> { fid, path, name, type, bytes }
const TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", pdf: "application/pdf", mp4: "video/mp4", mov: "video/quicktime", m4a: "audio/mp4", mp3: "audio/mpeg" };
if (existsSync(fileDir)) for (const name of readdirSync(fileDir)) {
  const [block, rest] = name.split("__");
  if (!rest) continue;
  const ext = rest.split(".").pop().toLowerCase();
  files.set(block.replace(/-/g, ""), { fid: sha(`notion-file:${block}`).slice(0, 24), path: join(fileDir, name), name: rest, type: TYPES[ext] ?? "application/octet-stream", bytes: statSync(join(fileDir, name)).size });
}
const usedFiles = new Set();
const missingFiles = [];
const taskIds = new Set();

function appLink(url) {
  if (/^user:\/\//.test(url)) return null;
  const id = pageIdOf(url);
  const anchor = anchorOf(url);
  if (!id || !/notion\.(com|so)/.test(url)) return url;
  const m = meetingOf.get(anchor) ?? meetingOf.get(id);
  if (m) return `/meetings/${m.id}`;
  if (docIds.has(id) || dbById.has(id)) return `/p/${id}`;
  if (taskIds.has(id)) return `/tasks?open=${id}`;
  if (spaceHome.has(id)) return `/space/${spaceHome.get(id)}`;
  const source = [...sources.values()].find((x) => x.dbId === id);
  if (source && taskSourceIds.has(source.id)) return "/tasks";
  if (source && meetingSourceIds.has(source.id)) return "/meetings";
  return url;
}

const KEEP_TAGS = new Set("a b i u s em strong code pre br p ul ol li table thead tbody tr td th h1 h2 h3 h4 h5 h6 blockquote hr img div mark sub sup del input label".split(" "));
const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    list(token) {
      const body = token.items.map((i) => this.listitem(i)).join("");
      if (token.items.length && token.items.every((i) => i.task)) return `<ul data-type="taskList">${body}</ul>\n`;
      const tag = token.ordered ? "ol" : "ul";
      return `<${tag}${token.ordered && token.start !== 1 && token.start !== "" ? ` start="${token.start}"` : ""}>${body}</${tag}>\n`;
    },
    listitem(item) {
      const tokens = item.tokens.filter((t) => t.type !== "checkbox");
      let inner = this.parser.parse(tokens, !!item.loose).trim();
      if (!item.task) return `<li>${/^<(p|ul|ol|div|table|blockquote|h\d|pre)/.test(inner) ? inner : wrapLead(inner)}</li>\n`;
      return `<li data-type="taskItem" data-checked="${item.checked ? "true" : "false"}"><label><input type="checkbox"${item.checked ? ' checked="checked"' : ""}><span></span></label><div>${/^<p/.test(inner) ? inner : wrapLead(inner)}</div></li>\n`;
    },
  },
});
/** Puts the leading inline text of a list item in a paragraph, leaving nested blocks after it. */
function wrapLead(html) {
  const cut = html.search(/<(ul|ol|div|table|blockquote|pre)[\s>]/);
  return cut < 0 ? `<p>${html}</p>` : `<p>${html.slice(0, cut).trim()}</p>${html.slice(cut)}`;
}

function eachBlock(text, tag, fn) {
  const re = new RegExp(`<(/?)${tag}\\b([^>]*)>`, "g");
  let out = "", depth = 0, start = 0, attrs = "", innerStart = 0, last = 0, m;
  while ((m = re.exec(text))) {
    const selfClosing = /\/\s*$/.test(m[2]);
    if (!m[1]) {
      if (depth === 0) { out += text.slice(last, m.index); start = m.index; attrs = m[2]; innerStart = re.lastIndex; if (selfClosing) { out += fn(attrs.replace(/\/\s*$/, ""), ""); last = re.lastIndex; continue; } }
      if (!selfClosing) depth++;
    } else if (depth > 0 && --depth === 0) { out += fn(attrs, text.slice(innerStart, m.index)); last = re.lastIndex; }
  }
  return depth > 0 ? out + text.slice(start) : out + text.slice(last);
}
const attr = (attrs, name) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";

function toHtml(source) {
  const held = [];
  const hold = (html) => `\n\n@@HOLD${held.push(html) - 1}@@\n\n`;
  const holdInline = (html) => `@@HOLD${held.push(html) - 1}@@`;
  const render = (text) => {
    let t = String(text ?? "").replace(/[ \t]*\[\^https?:\/\/[^\]\s]+\]/g, ""); // citation markers
    t = eachBlock(t, "meeting-notes", (a) => { const m = meetingOf.get(anchorOf(attr(a, "view-url"))) ?? meetingOf.get(pageIdOf(attr(a, "view-url"))); return m ? hold(`<p><a href="/meetings/${m.id}">🎙 ${esc(m.title)}</a></p>`) : ""; });
    t = eachBlock(t, "columns", (_, inner) => {
      const cells = [];
      eachBlock(inner, "column", (__, col) => { cells.push(render(col)); return ""; });
      return cells.length ? hold(`<table data-columns="${cells.length}"><tbody><tr>${cells.map((c) => `<td>${c.trim() || "<p></p>"}</td>`).join("")}</tr></tbody></table>`) : "";
    });
    t = eachBlock(t, "callout", (a, inner) => hold(`<div data-callout data-emoji="${esc(attr(a, "icon") || "💡")}"><div>${render(inner).trim() || "<p></p>"}</div></div>`));
    t = eachBlock(t, "toggle", (a, inner) => {
      const [head, ...rest] = inner.replace(/^\n+/, "").split("\n");
      const h = attr(a, "heading");
      return hold(`${h ? `<${h}>${mdInline(head)}</${h}>` : `<p><strong>${mdInline(head)}</strong></p>`}${render(rest.join("\n"))}`);
    });
    for (const tag of ["image", "video", "pdf", "audio", "file"]) {
      t = eachBlock(t, tag, (a, inner) => {
        const src = attr(a, "source").replace(/&amp;/g, "&");
        const caption = plainTitle(inner);
        const block = src.startsWith("notion-file-block://") ? ids32(src)[0] : null;
        const f = block ? files.get(block) : null;
        const label = caption || (f?.name ?? decodeURIComponent(src.match(/name=([^&]+)/)?.[1] ?? "File")).replace(/_/g, " ");
        if (block && !f) { missingFiles.push(label); return hold(`<p><em>${esc(label)} (file not copied from Notion)</em></p>`); }
        if (f) usedFiles.add(block);
        const href = f ? `/api/files/${f.fid}` : src;
        if (tag === "image") return hold(`<img src="${esc(href)}" alt="${esc(caption)}">${caption ? `<p>${esc(caption)}</p>` : ""}`);
        return hold(`<p><a href="${esc(href)}">${tag === "video" ? "🎬" : "📎"} ${esc(label)}</a></p>`);
      });
    }
    t = t
      .replace(/<mention-user url="[^"]*"\s*>([\s\S]*?)<\/mention-user>/g, (_, n) => `@${n}`)
      .replace(/<mention url="(user:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/mention>/g, (_, url, label) => { const u = userById.get(ids32(url)[0]); return u ? holdInline(`<span data-type="mention" class="mention" data-id="${u.id}" data-label="${esc(u.name)}">@${esc(u.name)}</span>`) : label; })
      .replace(/<mention url="([^"]+)"[^>]*>([\s\S]*?)<\/mention>/g, (_, url, label) => { const href = appLink(url); return href ? `<a href="${esc(href)}">${label || "link"}</a>` : label; })
      .replace(/<mention url="([^"]+)"[^>]*\/>/g, (_, url) => { const href = appLink(url); const id = pageIdOf(url); const name = pageIn.get(id)?.title ?? userById.get(ids32(url)[0])?.name; return name ? (href ? `<a href="${esc(href)}">${esc(name)}</a>` : `@${esc(name)}`) : ""; })
      .replace(/^([ \t]*)<page url="([^"]+)"[^>]*>([\s\S]*?)<\/page>/gm, (_, ind, url, label) => `${ind}<a href="${esc(appLink(url) ?? url)}">📄 ${label.trim() || "Page"}</a>\n`)
      .replace(/^([ \t]*)<database url="([^"]+)"([^>]*)>([\s\S]*?)<\/database>/gm, (_, ind, url, a, label) => {
        const id = pageIdOf(url);
        const src = ids32(attr(a, "data-source-url"))[0];
        const s = dbById.get(id) ?? (src && dbSources.find((x) => x.id === src));
        if (s) return `${ind}<a href="/p/${s.dbId}">📊 ${esc(plainTitle(label) || s.title)}</a>\n`;
        if (src && taskSourceIds.has(src)) return `${ind}<a href="/tasks">✅ ${esc(plainTitle(label) || "Tasks")}</a>\n`;
        if (src && meetingSourceIds.has(src)) return `${ind}<a href="/meetings">🎙 ${esc(plainTitle(label) || "Meetings")}</a>\n`;
        return plainTitle(label) ? `${ind}<em>${esc(plainTitle(label))} (a Notion database view, not imported)</em>\n` : "";
      })
      .replace(/<date start="([^"]+)"(?: start-time="([^"]+)")?(?: end="([^"]+)")?[^>]*\/>/g, (_, d, time, end) => niceDate(d, time) + (end ? ` – ${niceDate(end)}` : ""))
      .replace(/<\/?span\b[^>]*>/g, "")
      .replace(/<unknown\b[^>]*\/>/g, "").replace(/<table-of-contents\b[^>]*\/>/g, "")
      .replace(/^[ \t]*<p \/>[ \t]*$/gm, "").replace(/<p \/>/g, "")
      .replace(/<(\/?)([A-Za-z][^\s<>\/]*)([^<>]*)>/g, (all, _c, name) => (KEEP_TAGS.has(name.toLowerCase()) ? all : esc(all)));
    // Tab-indented paragraphs are Notion's nested blocks, not code.
    t = t.replace(/^(\t+)(?![-*+] |\d+\. |\t)/gm, (_, tabs) => "    ".repeat(Math.max(0, tabs.length - 1)) + (tabs.length > 1 ? "" : ""));
    return md.parse(t);
  };
  let html = render(source);
  for (let pass = 0; pass < 12 && /@@HOLD\d+@@/.test(html); pass++) {
    html = html.replace(/<p>\s*@@HOLD(\d+)@@\s*<\/p>|@@HOLD(\d+)@@/g, (_, a, b) => held[Number(a ?? b)] ?? "");
  }
  // Rows of Notion columns that sit one after another become one table.
  for (let again = true; again; ) {
    again = false;
    html = html.replace(/<table data-columns="(\d+)"><tbody>((?:(?!<\/table>)[\s\S])*)<\/tbody><\/table>\s*<table data-columns="\1"><tbody>/g, (_, n, body) => { again = true; return `<table data-columns="${n}"><tbody>${body}`; });
  }
  html = html.replace(/href="(https:\/\/(?:app|www)\.notion\.(?:com|so)\/[^"]*)"/g, (_, url) => `href="${esc(appLink(url.replace(/&amp;/g, "&")) ?? url)}"`);
  return html.replace(/<table data-columns="\d+">/g, "<table>").replace(/\n{3,}/g, "\n\n").trim();
}
const mdInline = (s) => md.parseInline(String(s ?? "").replace(/<\/?span\b[^>]*>/g, ""));

// ---------- Build the rows ----------

const sql = [];
const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/\u0000/g, "").replace(/'/g, "''")}'`);
/** D1 caps one statement at 100 KB, so long text goes in as an insert followed by appends. */
function pieces(text, max = 30000) {
  const out = [];
  let cur = "", size = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (size + n > max) { out.push(cur); cur = ""; size = 0; }
    cur += ch; size += n;
  }
  out.push(cur);
  return out;
}
function insert(table, row, key = "id") {
  const cols = Object.keys(row);
  const later = [];
  const vals = cols.map((c) => {
    const v = row[c];
    if (typeof v === "string" && Buffer.byteLength(v) > 30000) { const [first, ...rest] = pieces(v); later.push([c, rest]); return lit(first); }
    return lit(v);
  });
  sql.push(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${vals.join(", ")});`);
  const where = (Array.isArray(key) ? key : [key]).map((k) => `${k} = ${lit(row[k])}`).join(" AND ");
  for (const [c, rest] of later) for (const part of rest) sql.push(`UPDATE ${table} SET ${c} = ${c} || ${lit(part)} WHERE ${where};`);
}
const index = (kind, ref, title, body) => insert("search", { title, body: String(body ?? "").slice(0, 200000), kind, ref }, ["kind", "ref"]);

// Tasks first (pages link to them), collected before anything is written.
const tasks = [];
const projectTitle = new Map(); // project page id -> name
for (const s of sources.values()) if (/project/i.test(s.title)) for (const [id, row] of rowsOf.get(s.id) ?? []) projectTitle.set(id, plainTitle(row.name ?? row["Project name"] ?? pageIn.get(id)?.title ?? ""));
for (const p of pagesIn) if (p.parentSource && /project/i.test(sources.get(p.parentSource)?.title ?? "")) projectTitle.set(p.id, plainTitle(p.props["Project name"] ?? p.title));

const STATUS = { "not started": "todo", open: "todo", proposed: "todo", "in progress": "doing", waiting: "doing", done: "done", archived: "done", dropped: "done" };
const refOf = (id) => id.slice(-6);
const strangers = new Map(); // people tasks were assigned to who aren't in the member list -> count
for (const s of sources.values()) {
  if (!taskSourceIds.has(s.id)) continue;
  const titleProp = Object.entries(s.state.schema).find(([, v]) => v.type === "title")?.[0];
  const personProp = Object.entries(s.state.schema).find(([, v]) => v.type === "person")?.[0];
  const isPrivate = privateIds.has(s.dbId) || sharedIds.has(s.dbId);
  const inOwners = !isPrivate && ownersSpace && (teamOfNotion.get(s.dbId) === ownersSpace.id || [...(rowsOf.get(s.id)?.values() ?? [])].some((r) => arr(r["Raised in"]).some((u) => meetingOf.get(pageIdOf(u)) && meetingSpace(meetingOf.get(pageIdOf(u))) === ownersSpace)));
  let n = 0;
  for (const [id, row] of rowsOf.get(s.id) ?? []) {
    const title = plainTitle(row[titleProp]);
    if (!title) continue;
    const statusName = String(row.Status ?? "").toLowerCase();
    const known = knownUsers(row[personProp]);
    const unknown = unknownUsers(row[personProp]);
    for (const u of unknown) strangers.set(u, (strangers.get(u) ?? 0) + 1);
    const space = isPrivate ? null : inOwners ? ownersSpace : spaceForBusiness(row.Business) ?? generalSpace;
    // A private list's tasks stay with the owner: assigning one would show it to the assignee.
    const assignee = isPrivate ? (known.includes(owner.id) ? owner.id : null) : known[0] ?? null;
    const meeting = [...arr(row.Meeting), ...arr(row["Raised in"])].map((u) => meetingOf.get(pageIdOf(u))).find(Boolean) ?? null;
    const projects = arr(row.Project).map((u) => projectTitle.get(pageIdOf(u))).filter(Boolean);
    const parent = arr(row["Parent-task"]).map((u) => plainTitle(rowsOf.get(s.id).get(pageIdOf(u))?.[titleProp])).filter(Boolean);
    const notes = [
      row.Update && plainTitle(row.Update),
      row.Workstream && `Workstream: ${row.Workstream}`,
      row["Task type"] === "milestone" && "Milestone",
      /^(proposed|waiting|archived|dropped)$/.test(statusName) && `${row.Status} in Notion`,
      parent.length && `Part of: ${parent.join(", ")}`,
      inOwners && row.Business && `Business: ${row.Business}`,
      isPrivate && known.filter((u) => u !== owner.id).length && `Assigned in Notion to ${known.filter((u) => u !== owner.id).map((u) => userById.get(u).name).join(", ")} (kept private here; assign it to share it)`,
      !isPrivate && known.length > 1 && `Also assigned: ${known.slice(1).map((u) => userById.get(u).name).join(", ")}`,
      unknown.length && `Assigned in Notion to ${unknown.length > 1 ? "people" : "someone"} not in the member list (ref ${unknown.map(refOf).join(", ")})`,
      row.Source && `Source: ${row.Source}`,
    ].filter(Boolean).join("\n");
    const created = toMs(row["date:Created time:start"]) ?? toMs(row.createdTime) ?? NOW;
    const status = STATUS[statusName] ?? "todo";
    tasks.push({
      id, title, notes, status, assignee_id: assignee, creator_id: owner.id, space_id: space?.id ?? null,
      project: projects.join(", ") || (!inOwners && space && row.Business && !space.name.toLowerCase().includes(String(row.Business).toLowerCase()) && space !== generalSpace ? String(row.Business) : ""),
      due: dateOnly(row["date:Due:start"] ?? row["date:Due date:start"]), meeting_id: meeting?.id ?? null,
      needs_owner: !assignee && unknown.length ? 1 : 0, sort: ++n, completed_at: status === "done" ? created : null,
      source_url: `https://app.notion.com/p/${id}`, created_at: created, updated_at: created,
    });
    taskIds.add(id);
    if (!isPrivate && space) join_(space, known);
  }
}

// Membership from the evidence: who is given work, runs projects or attends meetings in each business.
join_(generalSpace, users.map((u) => u.id));
for (const m of meetings) join_(meetingSpace(m), knownUsers(m.attendees));
for (const p of pagesIn) if (p.parentSource && /project/i.test(sources.get(p.parentSource)?.title ?? "")) join_(spaceForBusiness(p.props.Business), [...knownUsers(p.props.Owner), ...knownUsers(p.props.Collaborators)]);
if (ownersSpace) for (const s of spaces) if (s !== ownersSpace) join_(s, [...ownersSpace.members]); // the owners' group oversees every business

// ---- users, spaces
for (const u of users) insert("users", { id: u.id, email: u.email, name: u.name, color: u.color, role: u.role, active: 1, source_id: u.id, created_at: NOW });
for (const s of spaces) {
  insert("spaces", { id: s.id, name: s.name, icon: s.icon, color: s.color, description: "", sort: s.sort, archived: 0, source_id: s.id, created_at: NOW });
  for (const uid of s.members) sql.push(`INSERT INTO space_members (space_id, user_id) VALUES (${lit(s.id)}, ${lit(uid)});`);
}

// ---- pages and databases
const NOTION_COLORS = { default: "gray", gray: "gray", brown: "brown", orange: "orange", yellow: "yellow", green: "green", blue: "blue", purple: "purple", pink: "pink", red: "red" };
function buildSchema(s) {
  const props = [];
  let n = 0;
  for (const [name, def] of Object.entries(s.state.schema)) {
    if (def.type === "title") continue;
    const id = `p${++n}`;
    const options = (list) => list.map((o, i) => ({ id: `${id}o${i + 1}`, name: o.name, color: NOTION_COLORS[o.color] ?? "gray" }));
    if (def.type === "status") props.push({ id, name, type: "status", options: options([...(def.groups?.to_do ?? []), ...(def.groups?.in_progress ?? []), ...(def.groups?.complete ?? [])]) });
    else if (def.type === "select" || def.type === "multi_select") props.push({ id, name, type: def.type, options: options(def.options ?? []) });
    else if (["person", "date", "checkbox", "number", "url"].includes(def.type)) props.push({ id, name, type: def.type });
    else if (["text", "email", "phone_number", "relation"].includes(def.type)) props.push({ id, name, type: "text", from: def.type });
    // files, formulas, roll-ups and created-by columns have no equivalent and are left out
  }
  const group = props.find((p) => p.type === "status") ?? props.find((p) => p.type === "select");
  const views = [{ id: "v1", name: "Table", type: "table" }];
  if (group) views.push({ id: "v2", name: "Board", type: "board", groupBy: group.id });
  return { props: props.map(({ from, ...p }) => p), views, sourceTypes: Object.fromEntries(props.map((p) => [p.id, p.from ?? p.type])) };
}
function rowProps(schema, source) {
  const out = {};
  for (const p of schema.props) {
    const kind = schema.sourceTypes[p.id];
    const v = source[p.name];
    if (p.type === "date") { const d = source[`date:${p.name}:start`]; if (d) out[p.id] = dateOnly(d); continue; }
    if (v === null || v === undefined || v === "") continue;
    if (p.type === "checkbox") out[p.id] = v === "__YES__" || v === true;
    else if (p.type === "person") { const ids = knownUsers(v); if (ids.length) out[p.id] = ids; }
    else if (p.type === "multi_select") { const ids = arr(v).map((name) => p.options.find((o) => o.name === name)?.id).filter(Boolean); if (ids.length) out[p.id] = ids; }
    else if (p.type === "select" || p.type === "status") { const o = p.options.find((x) => x.name === v); if (o) out[p.id] = o.id; }
    else if (p.type === "number") out[p.id] = Number(v);
    else if (kind === "relation") {
      const links = arr(v);
      const names = links.map((u) => { const id = pageIdOf(u); return pageIn.get(id)?.title ?? projectTitle.get(id) ?? meetingOf.get(id)?.title ?? null; }).filter(Boolean);
      out[p.id] = names.length === links.length && names.length <= 6 ? names.join(", ") : `${links.length} linked`;
    } else out[p.id] = plainTitle(v);
  }
  return out;
}

const pageRows = [];
const addPage = (row) => { const text = htmlToText(row.html ?? ""); pageRows.push({ ...row, text }); };
const sortOf = new Map();
const nextSort = (key) => { const n = (sortOf.get(key) ?? 0) + 1; sortOf.set(key, n); return n; };

for (const p of docs) {
  if (p.parentSource) continue; // database rows are added with their database
  const { space } = place(p.id);
  const parent = p.parentPage && docIds.has(p.parentPage) ? p.parentPage : null;
  addPage({ id: p.id, space_id: space?.id ?? null, parent_id: parent, kind: "page", title: plainTitle(p.title), icon: p.icon, html: toHtml(p.content), props: null, schema: null, source_url: p.url, at: p.edited });
}
for (const s of dbSources) {
  const { space } = place(s.dbId);
  const parent = dbParent.get(s.dbId) ?? null;
  const schema = buildSchema(s);
  const titleProp = Object.entries(s.state.schema).find(([, v]) => v.type === "title")?.[0];
  const rowIds = new Set([...(rowsOf.get(s.id)?.keys() ?? []), ...pagesIn.filter((p) => p.parentSource === s.id).map((p) => p.id)]);
  if (!rowIds.size && !parent && !teamOfNotion.has(s.dbId)) continue; // an empty database nobody links to
  addPage({ id: s.dbId, space_id: space?.id ?? null, parent_id: parent, kind: "database", title: s.title, icon: "", html: s.description ? `<p>${esc(s.description)}</p>` : "", props: null, schema: { props: schema.props, views: schema.views }, source_url: `https://app.notion.com/p/${s.dbId}`, at: NOW });
  for (const id of rowIds) {
    const p = pageIn.get(id);
    const row = rowsOf.get(s.id)?.get(id) ?? {};
    const values = { ...row, ...(p?.props ?? {}) };
    addPage({
      id, space_id: space?.id ?? null, parent_id: s.dbId, kind: "row", title: plainTitle(values[titleProp] ?? p?.title ?? row.Name ?? row.name ?? "Untitled"), icon: p?.icon ?? "",
      html: p ? toHtml(p.content) : "", props: rowProps(schema, values), schema: null, source_url: `https://app.notion.com/p/${id}`, at: p?.edited ?? toMs(row.createdTime) ?? NOW,
    });
    docIds.add(id);
  }
}
// Parents before children, so foreign keys hold.
const placed = new Set();
const ordered = [];
for (let guard = 0; ordered.length < pageRows.length && guard < 50; guard++) {
  for (const r of pageRows) if (!placed.has(r.id) && (!r.parent_id || placed.has(r.parent_id) || !pageRows.some((x) => x.id === r.parent_id))) { placed.add(r.id); ordered.push(r); }
}
for (const r of ordered) {
  const parentOk = r.parent_id && placed.has(r.parent_id) ? r.parent_id : null;
  const content = r.html ? JSON.stringify({ html: r.html }) : null;
  insert("pages", {
    id: r.id, space_id: r.space_id, owner_id: owner.id, parent_id: parentOk, kind: r.kind, title: r.title, icon: r.icon, content, text: r.text,
    props: r.props ? JSON.stringify(r.props) : null, schema: r.schema ? JSON.stringify(r.schema) : null, sort: nextSort(parentOk ?? `root:${r.space_id}`),
    is_template: 0, archived: 0, source_url: r.source_url, created_by: owner.id, updated_by: owner.id, created_at: r.at, updated_at: r.at,
  });
  const propText = Object.values(r.props ?? {}).filter((v) => typeof v === "string" || typeof v === "number").join(" ");
  index("page", r.id, r.title, `${r.text}\n${propText}`);
}

// ---- meetings
const knowledge = [];
for (const m of meetings) {
  const space = meetingSpace(m);
  const attendees = [...new Set(m.attendees.map((a) => ids32(a)[0]).filter(Boolean))];
  const present = attendees.filter((a) => userById.has(a));
  const organizer = !space || present.includes(owner.id) || !present.length ? owner.id : present.find((a) => userById.get(a).role !== "guest") ?? owner.id;
  const summaryHtml = [m.extraHtmlTop, toHtml(m.summary), m.notes.replace(/<p \/>/g, "").trim() ? `<h3>Notes</h3>${toHtml(m.notes)}` : ""].filter(Boolean).join("\n");
  insert("meetings", {
    id: m.id, title: m.title, space_id: space?.id ?? null, organizer_id: organizer, status: "sent", started_at: m.when, duration_s: 0,
    transcript: m.transcript, summary_doc: null, summary_html: summaryHtml, error: null, sent_at: m.when, source_url: m.page?.url ?? `https://app.notion.com/p/${m.id}`, created_at: m.when,
  });
  present.forEach((a, i) => {
    const u = userById.get(a);
    // In a private meeting people are listed by name only: linking them would open the notes to them.
    insert("meeting_participants", { id: sha(`mp:${m.id}:${a}`).slice(0, 20), meeting_id: m.id, user_id: space ? a : a === owner.id ? a : null, name: u.name, email: space || a === owner.id ? u.email : "", notify: 0 });
  });
  if (!present.includes(owner.id) && organizer === owner.id) insert("meeting_participants", { id: sha(`mp:${m.id}:owner`).slice(0, 20), meeting_id: m.id, user_id: owner.id, name: owner.name, email: owner.email, notify: 0 });
  index("meeting", m.id, m.title, `${htmlToText(summaryHtml)}\n${m.transcript}`);
  m.space = space;
  for (const [i, d] of (m.decisions ?? "").split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((x) => x.trim()).filter((x) => x.length > 8).entries()) {
    knowledge.push({ id: sha(`k:${m.id}:${i}`).slice(0, 20), space_id: space?.id ?? null, owner_id: owner.id, kind: "decision", title: d.replace(/\.$/, ""), body: `Decided at “${m.title}” on ${niceDate(new Date(m.when).toISOString())}.`, meeting_id: m.id, created_at: m.when });
  }
}

// ---- tasks, brain
for (const t of tasks) { insert("tasks", t); index("task", t.id, t.title, `${t.notes}\n${t.project}`); }
for (const s of dbSources) if (/contact|supplier/i.test(s.title)) for (const [id, row] of rowsOf.get(s.id) ?? []) {
  const body = [row["Contact name"] && `Contact: ${row["Contact name"]}`, row.Email, row.Phone, row.Notes].filter(Boolean).join("\n");
  if (row.Name && body) knowledge.push({ id: sha(`k:${id}`).slice(0, 20), space_id: (spaceForBusiness(row.Business) ?? place(s.dbId).space)?.id ?? null, owner_id: owner.id, kind: "contact", title: `${row.Name}${row.Type ? ` (${String(row.Type).toLowerCase()})` : ""}`, body, meeting_id: null, created_at: toMs(row.createdTime) ?? NOW });
}
for (const k of knowledge) { insert("knowledge", k); index("knowledge", k.id, k.title, k.body); }

// ---------- Write everything out ----------

writeFileSync(join(dir, "atrium-import.local.sql"), `-- Atrium import from Notion. Private data: never commit this file.\nPRAGMA defer_foreign_keys = true;\n${sql.join("\n")}\n`);

const toLoad = [...files.entries()].filter(([block]) => usedFiles.has(block)).map(([, f]) => f);
writeFileSync(join(dir, "load-files.sh"), `#!/bin/sh
# Loads the files copied from Notion into the R2 bucket. Private data: never commit this file.
# Usage: sh ${dir}/load-files.sh --local   (the dev server's bucket)
#        sh ${dir}/load-files.sh --remote  (the real bucket)
# Set MAX_MB to leave out anything bigger, e.g. MAX_MB=20 for a quick local load.
MODE="\${1:---local}"
CONFIG="\${2:-wrangler.jsonc}"
put() {
  if [ -n "$MAX_MB" ] && [ "$3" -gt "$((MAX_MB * 1048576))" ]; then echo "skipped (large): $2"; return; fi
  npx wrangler r2 object put "atrium-files/files/$1" --file "$2" --content-type "$4" "$MODE" -c "$CONFIG" >/dev/null 2>&1 && echo "ok: $2" || echo "FAILED: $2"
}
${toLoad.map((f) => `put ${f.fid} '${f.path.replace(/'/g, "'\\''")}' ${f.bytes} ${f.type}`).join("\n")}
`);

const count = (re) => sql.filter((s) => re.test(s)).length;
const byStatus = (st) => tasks.filter((t) => t.status === st).length;
const report = `# Notion import report

Generated ${new Date(NOW).toISOString().slice(0, 16).replace("T", " ")} UTC from ${raw.length} connector results.

## What was imported

- People: ${users.length} (${users.map((u) => `${u.name} [${u.role}]`).join(", ")})
- Spaces: ${spaces.map((s) => `${s.name} (${[...s.members].map((u) => userById.get(u).name.split(" ")[0]).join(", ")})`).join("; ")}
- Pages: ${pageRows.filter((r) => r.kind === "page").length}, databases: ${pageRows.filter((r) => r.kind === "database").length} with ${pageRows.filter((r) => r.kind === "row").length} rows
  - private to the owner: ${pageRows.filter((r) => !r.space_id && r.kind !== "row").map((r) => r.title).join("; ")}
- Tasks: ${tasks.length} (${byStatus("todo")} to do, ${byStatus("doing")} in progress, ${byStatus("done")} done); ${tasks.filter((t) => !t.space_id).length} private; ${tasks.filter((t) => t.needs_owner).length} need an owner
- Meetings: ${meetings.length} (${meetings.filter((m) => m.transcript.length > 50).length} with a transcript; ${meetings.filter((m) => !m.space).length} private)
${meetings.map((m) => `  - ${new Date(m.when).toISOString().slice(0, 10)} · ${m.title} · ${m.space?.name ?? "private"} · transcript ${Math.round(m.transcript.length / 1000)}k`).join("\n")}
- Brain notes: ${knowledge.length}
- Files: ${toLoad.length} (${Math.round(toLoad.reduce((n, f) => n + f.bytes, 0) / 1048576)} MB)${missingFiles.length ? `; not copied: ${missingFiles.join(", ")}` : ""}

## Worth checking

- In General only (add them to a business in Settings, Spaces, if they should see its pages and tasks): ${users.filter((u) => u.role !== "guest" && spaces.every((sp) => sp === generalSpace || !sp.members.has(u.id))).map((u) => u.name).join(", ") || "nobody"}
- Guests (see only what is shared with them, their own tasks and meetings they were in): ${users.filter((u) => u.role === "guest").map((u) => u.name).join(", ") || "none"}

## Left out

- Meetings with nothing in them: ${skippedMeetings.length} (${[...new Set(skippedMeetings)].join("; ")})
- Pages: ${skippedPages.join("; ") || "none"}
- Databases: ${[...sources.values()].filter((s) => skipSourceIds.has(s.id)).map((s) => s.title).join("; ") || "none"}

## People Notion would not name

Tasks were assigned in Notion to ${strangers.size} people who are not in the member list, so the connector gives no name or address for them.
Those tasks are marked as needing an owner, with a short reference in the notes:
${[...strangers].sort((a, b) => b[1] - a[1]).map(([id, n]) => `- ref ${refOf(id)}: ${n} tasks`).join("\n")}

## Statements

${sql.length} SQL statements (${count(/^INSERT INTO pages/)} pages, ${count(/^INSERT INTO tasks/)} tasks, ${count(/^INSERT INTO meetings /)} meetings, ${count(/^INSERT INTO search/)} search entries).
`;
writeFileSync(join(dir, "report.md"), report);
console.log(report);
