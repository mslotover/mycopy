import { useQuery } from "@tanstack/react-query";
import { CalendarDays } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "./api";
import { Toolbar } from "./App";
import { Empty, Spinner } from "./ui";

type Upcoming = { connected: boolean; problem?: boolean; events: { key: string; title: string; start: number; people: string[] }[] };

const dayKey = (t: number) => new Date(t).toDateString();
const dayLabel = (t: number) => {
  const d = new Date(t), today = new Date();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  const base = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  return diff === 0 ? `Today · ${base}` : diff === 1 ? `Tomorrow · ${base}` : base;
};

/** The next week of meetings from the person's connected Google Calendar. */
export function CalendarView() {
  const { data, isLoading, error } = useQuery({ queryKey: ["calendar-upcoming"], queryFn: () => api<Upcoming>("/prep/upcoming"), refetchOnWindowFocus: true, staleTime: 60_000 });
  const days = new Map<string, Upcoming["events"]>();
  for (const e of data?.events ?? []) days.set(dayKey(e.start), [...(days.get(dayKey(e.start)) ?? []), e]);
  return (
    <>
      <Toolbar crumbs={<span className="crumb current">Calendar</span>} />
      <div className="scroll">
        <div className="column">
          <div className="view-head"><div className="grow"><h1 className="h-title">Calendar</h1><div className="muted">Your next seven days, from your Google Calendar.</div></div></div>
          {isLoading ? <Spinner /> : error ? (
            <Empty icon="📅" title="Couldn't load your calendar">Try again in a minute.</Empty>
          ) : !data?.connected ? (
            <Empty icon="📅" title="Your calendar isn't connected">Connect it in <Link to="/settings">Settings</Link> to see your meetings here.</Empty>
          ) : data.problem ? (
            <Empty icon="📅" title="Google didn't give us your calendar">Open <Link to="/settings">Settings</Link> and paste the calendar address again.</Empty>
          ) : !data.events.length ? (
            <Empty icon="🎉" title="Nothing in the next seven days" />
          ) : (
            [...days.entries()].map(([k, evs]) => (
              <div key={k} style={{ marginBottom: 22 }}>
                <div className="section-title">{dayLabel(evs[0]!.start)}</div>
                {evs.map((e) => (
                  <div key={e.key} style={{ display: "flex", gap: 14, padding: "8px 0", alignItems: "baseline" }}>
                    <span className="muted" style={{ width: 52, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{new Date(e.start).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}><CalendarDays style={{ width: 14, height: 14, marginRight: 6, verticalAlign: "-2px" }} />{e.title || "Untitled"}</div>
                      {e.people.length > 0 && <div className="muted" style={{ fontSize: 13 }}>With {e.people.join(", ")}</div>}
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
