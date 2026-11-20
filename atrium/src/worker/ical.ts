// A small reader for Google Calendar's secret iCal feed. It finds meetings that start inside a
// time window, including repeating ones (daily, weekly, monthly, yearly) and one-off changes to them.
// All-day events are ignored. Unusual repeat rules (e.g. BYSETPOS) are not understood and are skipped.

export type Attendee = { email: string; name: string; status: string };
export type CalEvent = { uid: string; title: string; start: number; attendees: Attendee[] };

type Prop = { name: string; params: Record<string, string>; value: string };
type Local = { y: number; mo: number; d: number; h: number; mi: number };

const DAY = 86_400_000;

function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

function parseLine(line: string): Prop | null {
  let inQuote = false, colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuote = !inQuote;
    else if (line[i] === ":" && !inQuote) { colon = i; break; }
  }
  if (colon < 1) return null;
  const [name, ...rest] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  // Parameters can hold quoted values with ';' inside, but the ones we use (TZID, CN, PARTSTAT, VALUE) never do.
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

const unescapeText = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");

function tzOffset(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(t));
  const g = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(t / 1000) * 1000;
}

/** Turns a wall-clock time in a time zone into a real instant. */
export function zonedToUtc(l: Local, tz: string): number {
  const guess = Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi);
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz);
  return t;
}

const validTz = (tz: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

type Dt = { t: number; tz: string; local: Local };

/** Reads DTSTART-style values. Returns null for all-day dates. */
function parseDt(p: Prop): Dt | null {
  if (p.params.VALUE === "DATE" || /^\d{8}$/.test(p.value)) return null;
  const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)?(Z)?$/.exec(p.value);
  if (!m) return null;
  const local: Local = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
  if (m[7]) return { t: Date.UTC(local.y, local.mo - 1, local.d, local.h, local.mi), tz: "UTC", local };
  const tz = p.params.TZID && validTz(p.params.TZID) ? p.params.TZID : "UTC";
  return { t: zonedToUtc(local, tz), tz, local };
}

const localDate = (t: number, tz: string) => new Date(t).toLocaleDateString("en-CA", { timeZone: tz });
const dayNum = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

type Rule = { freq: string; interval: number; byday: { n: number; day: number }[]; bymonthday: number[]; count: number; until: number | null };

function parseRule(value: string): Rule | null {
  const kv: Record<string, string> = {};
  for (const part of value.split(";")) { const [k, v] = part.split("="); if (k && v) kv[k.toUpperCase()] = v; }
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(kv.FREQ)) return null;
  if (kv.BYSETPOS || kv.BYWEEKNO || kv.BYYEARDAY) return null;
  const byday = (kv.BYDAY ?? "").split(",").filter(Boolean).map((s) => {
    const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(s);
    return m && WEEKDAYS.includes(m[2]) ? { n: m[1] ? Number(m[1]) : 0, day: WEEKDAYS.indexOf(m[2]) } : null;
  });
  if (byday.some((b) => !b)) return null;
  let until: number | null = null;
  if (kv.UNTIL) {
    const dt = parseDt({ name: "UNTIL", params: {}, value: kv.UNTIL.length === 8 ? `${kv.UNTIL}T235959Z` : kv.UNTIL });
    until = dt ? dt.t : null; // a date-only end includes that whole day
  }
  return {
    freq: kv.FREQ, interval: Math.max(1, Number(kv.INTERVAL) || 1), byday: byday as { n: number; day: number }[],
    bymonthday: (kv.BYMONTHDAY ?? "").split(",").filter(Boolean).map(Number), count: Number(kv.COUNT) || 0, until,
  };
}

/** Does the repeat rule produce an occurrence on this calendar day? */
function ruleMatches(rule: Rule, start: Local, iso: string): boolean {
  const startIso = `${String(start.y).padStart(4, "0")}-${String(start.mo).padStart(2, "0")}-${String(start.d).padStart(2, "0")}`;
  const dn = dayNum(iso), sn = dayNum(startIso);
  if (dn < sn) return false;
  const date = new Date(`${iso}T12:00:00Z`);
  const wd = date.getUTCDay();
  switch (rule.freq) {
    case "DAILY": return (dn - sn) % rule.interval === 0;
    case "WEEKLY": {
      const days = rule.byday.length ? rule.byday.map((b) => b.day) : [new Date(`${startIso}T12:00:00Z`).getUTCDay()];
      const week = (n: number) => Math.floor((n + 3) / 7); // weeks start on Monday
      return days.includes(wd) && (week(dn) - week(sn)) % rule.interval === 0;
    }
    case "MONTHLY":
    case "YEARLY": {
      const months = (date.getUTCFullYear() - start.y) * 12 + (date.getUTCMonth() + 1 - start.mo);
      if (rule.freq === "MONTHLY" ? months % rule.interval !== 0 : months % (12 * rule.interval) !== 0) return false;
      if (rule.freq === "YEARLY" && date.getUTCMonth() + 1 !== start.mo) return false;
      if (rule.byday.length) {
        const dom = date.getUTCDate();
        const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
        return rule.byday.some((b) => {
          if (b.day !== wd) return false;
          if (!b.n) return true;
          return b.n > 0 ? Math.ceil(dom / 7) === b.n : Math.ceil((daysInMonth - dom + 1) / 7) === -b.n;
        });
      }
      const dom = date.getUTCDate();
      const wanted = rule.bymonthday.length ? rule.bymonthday : [start.d];
      return wanted.includes(dom);
    }
  }
  return false;
}

type Raw = { uid: string; title: string; status: string; dtstart: Dt; rrule: Rule | null; exdates: number[]; recurrenceId: number | null; attendees: Attendee[] };

function parseEvents(ics: string): Raw[] {
  const out: Raw[] = [];
  let cur: { props: Prop[] } | null = null;
  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") { cur = { props: [] }; continue; }
    if (line === "END:VEVENT" && cur) {
      const get = (n: string) => cur!.props.find((p) => p.name === n);
      const start = get("DTSTART");
      const dtstart = start && parseDt(start);
      const uid = get("UID")?.value;
      if (dtstart && uid) {
        const rr = get("RRULE");
        const rid = get("RECURRENCE-ID");
        const exdates = cur.props.filter((p) => p.name === "EXDATE").flatMap((p) => p.value.split(",").map((v) => parseDt({ ...p, value: v })?.t ?? NaN)).filter((t) => !isNaN(t));
        const attendees = cur.props.filter((p) => p.name === "ATTENDEE" || p.name === "ORGANIZER").map((p) => ({
          email: p.value.replace(/^mailto:/i, "").trim().toLowerCase(), name: p.params.CN ?? "", status: (p.params.PARTSTAT ?? "").toUpperCase(),
        })).filter((a) => a.email.includes("@"));
        out.push({
          uid, title: unescapeText(get("SUMMARY")?.value ?? "") || "Meeting", status: (get("STATUS")?.value ?? "").toUpperCase(), dtstart,
          rrule: rr ? parseRule(rr.value) : null, exdates, recurrenceId: rid ? parseDt(rid)?.t ?? null : null, attendees,
        });
      }
      cur = null; continue;
    }
    if (cur) { const p = parseLine(line); if (p) cur.props.push(p); }
  }
  return out;
}

/** Meetings from the calendar that start at or after `from` and before `to` (milliseconds). */
export function eventsStartingBetween(ics: string, from: number, to: number): CalEvent[] {
  const raw = parseEvents(ics);
  // Changed or cancelled single occurrences replace the repeating event's own occurrence.
  const replaced = new Map<string, number[]>();
  for (const e of raw) if (e.recurrenceId !== null) replaced.set(e.uid, [...(replaced.get(e.uid) ?? []), e.recurrenceId]);
  const found: CalEvent[] = [];
  const add = (e: Raw, start: number) => {
    if (e.status === "CANCELLED") return;
    found.push({ uid: e.uid, title: e.title, start, attendees: e.attendees });
  };
  for (const e of raw) {
    if (!e.rrule || e.recurrenceId !== null) {
      if (e.dtstart.t >= from && e.dtstart.t < to) add(e, e.dtstart.t);
      continue;
    }
    const skip = new Set([...e.exdates, ...(replaced.get(e.uid) ?? [])]);
    const days = new Set([localDate(from, e.dtstart.tz), localDate(to - 1, e.dtstart.tz)]);
    for (const iso of days) {
      const [y, mo, d] = iso.split("-").map(Number);
      const t = zonedToUtc({ y, mo, d, h: e.dtstart.local.h, mi: e.dtstart.local.mi }, e.dtstart.tz);
      if (t < from || t >= to || skip.has(t)) continue;
      if (e.rrule.until !== null && t > e.rrule.until) continue;
      if (!ruleMatches(e.rrule, e.dtstart.local, iso)) continue;
      if (e.rrule.count) {
        let n = 0;
        const start = dayNum(`${String(e.dtstart.local.y).padStart(4, "0")}-${String(e.dtstart.local.mo).padStart(2, "0")}-${String(e.dtstart.local.d).padStart(2, "0")}`);
        for (let k = start; k <= dayNum(iso) && n <= e.rrule.count; k++) if (ruleMatches(e.rrule, e.dtstart.local, new Date(k * DAY + DAY / 2).toISOString().slice(0, 10))) n++;
        if (n > e.rrule.count) continue;
      }
      add(e, t);
    }
  }
  return found.sort((a, b) => a.start - b.start);
}
