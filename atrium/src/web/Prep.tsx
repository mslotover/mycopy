import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, fmtDate } from "./api";
import { Toolbar } from "./App";
import { Empty, Spinner } from "./ui";

type Prep = {
  id: string; title: string; starts_at: number;
  with: { id: string; name: string }[]; outside: number;
  decisions: { id: string; title: string; body: string; meeting_id: string; meeting_title: string; date: number }[];
  tasks: { id: string; title: string; due: string | null; owners: string[] }[];
  lastMeeting: { id: string; title: string; date: number } | null;
};

/** The note sent shortly before a calendar meeting: what's been decided and what's open with the people in it. */
export function PrepView() {
  const { id } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["prep", id], queryFn: () => api<Prep>(`/prep/${id}`) });
  const time = data ? new Date(data.starts_at).toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) : "";
  return (
    <>
      <Toolbar crumbs={<span className="crumb current">Meeting prep</span>} />
      <div className="scroll">
        <div className="column">
          {isLoading ? <Spinner /> : error || !data ? (
            <Empty icon="📅" title="This note isn't available">It may belong to someone else.</Empty>
          ) : (
            <>
              <div className="view-head"><div className="grow">
                <h1 className="h-title">{data.title}</h1>
                <p className="h-sub">{time} · with {data.with.map((o) => o.name).join(", ")}{data.outside ? ` and ${data.outside} from outside the team` : ""}</p>
              </div></div>
              <h3>Decided before</h3>
              {!data.decisions.length ? <p className="muted">No recorded decisions from meetings with {data.with.length === 1 ? "this person" : "these people"} yet.</p> : data.decisions.map((d) => (
                <Link key={d.id} to={`/brain?open=${d.id}`} className="note" style={{ textAlign: "left", marginBottom: 8, display: "block" }}>
                  <h4>{d.title}</h4>
                  <p style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{d.body}</p>
                  <div className="ft">{d.meeting_title || "Meeting"} · {new Date(d.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</div>
                </Link>
              ))}
              {data.lastMeeting && <p className="muted">Last met: <Link to={`/meetings/${data.lastMeeting.id}`}>{data.lastMeeting.title || "Meeting"}</Link>, {new Date(data.lastMeeting.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.</p>}
              <h3 style={{ marginTop: 24 }}>Open tasks between you</h3>
              {!data.tasks.length ? <p className="muted">Nothing open.</p> : data.tasks.map((t) => (
                <Link key={t.id} to={`/tasks?open=${t.id}`} className="note" style={{ textAlign: "left", marginBottom: 8, display: "block" }}>
                  <h4>{t.title}</h4>
                  <div className="ft">{t.owners.join(", ")}{t.due ? ` · due ${fmtDate(t.due)}` : ""}</div>
                </Link>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}
