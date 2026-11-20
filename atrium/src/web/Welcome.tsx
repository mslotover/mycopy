import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { api, invalidate } from "./api";
import { Sheet, toast, toastError, useApp } from "./ui";

type Setup = { onboarded: boolean; calendar: boolean };
export const useSetup = () => useQuery({ queryKey: ["setup"], queryFn: () => api<Setup>("/me/setup"), staleTime: 60_000 });

/** Paste box for the Google Calendar secret iCal address. Used in the tour and under Settings. */
export function CalendarConnect({ connected, onSaved }: { connected: boolean; onSaved?: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api("/me/calendar", { method: "PUT", body: { url } });
      setUrl("");
      invalidate("setup");
      toast("Calendar connected");
      onSaved?.();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const remove = async () => {
    try { await api("/me/calendar", { method: "DELETE" }); invalidate("setup"); toast("Calendar disconnected"); } catch (e) { toastError(e); }
  };
  return (
    <div>
      {connected && <p style={{ margin: "0 0 10px" }}>✓ Your calendar is connected. <button className="btn plain" onClick={remove}>Disconnect</button></p>}
      <ol className="sec" style={{ paddingLeft: 20, margin: "0 0 12px", lineHeight: 1.6 }}>
        <li>Open <b>Google Calendar</b> on a computer and press the cog, then <b>Settings</b>.</li>
        <li>On the left, under <b>Settings for my calendars</b>, press your own calendar.</li>
        <li>Scroll to <b>Secret address in iCal format</b> and copy it.</li>
        <li>Paste it below. Treat it like a password: anyone with it can read your calendar.</li>
      </ol>
      <input className="field" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} />
      <div style={{ marginTop: 8 }}><button className="btn primary" disabled={busy || !url.trim()} onClick={save}>{busy ? "Checking…" : connected ? "Replace address" : "Connect calendar"}</button></div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Atrium only reads it, to get your meetings ready. If you can't see the secret address, your Google admin has switched it off; ask them. Skip it if you'd rather not.</p>
    </div>
  );
}

type Step = { title: string; body: ReactNode };

const STEPS = (calendar: boolean): Step[] => [
  { title: "Welcome to Atrium", body: (
    <>
      <p>Atrium is where the team keeps its pages, tasks and meetings, for all the businesses, in one place. This takes about two minutes, and you can replay it any time from <b>Settings</b>.</p>
      <p className="sec">The left-hand list has a space for each business you belong to, plus a private area that only you can see.</p>
    </>) },
  { title: "Pages and spaces", body: (
    <ul className="tour-list">
      <li>Press <b>+</b> beside a space to add a page. Type <b>/</b> in a page to add headings, to-do lists, tables, images and more.</li>
      <li>Type <b>@</b> to mention a colleague. They get a notification.</li>
      <li>Everything you write is saved as you type, and earlier versions are kept.</li>
      <li>Use <b>Share</b> on a page to let someone else, or a guest outside the company, see it.</li>
    </ul>) },
  { title: "Tasks", body: (
    <ul className="tour-list">
      <li><b>Tasks</b> in the sidebar is your own list. Tick a task to finish it.</li>
      <li>You can give a task to someone else, and tasks given to you appear in your list and as a notification.</li>
      <li>The <b>Stale</b> filter shows tasks that have gone quiet.</li>
    </ul>) },
  { title: "Meetings", body: (
    <ul className="tour-list">
      <li>Press <b>New meeting</b> to record in your browser. On a video call, choose <b>Add its audio</b> so everyone is captured (a computer with Chrome, Edge, Arc or Brave).</li>
      <li>Afterwards Atrium writes a summary and suggests who does what. You check it and edit it. Nothing is sent until you approve.</li>
      <li>Approving emails the summary to the people there and adds each action to the right person's task list.</li>
      <li>Decisions and know-how are saved in the <b>Brain</b>, which everyone can search.</li>
    </ul>) },
  { title: "Search and Ask AI", body: (
    <ul className="tour-list">
      <li>Press <b>Ctrl+K</b> (or <b>⌘K</b>) to search. It understands meaning, so “cold storage” finds the walk-in fridge page.</li>
      <li>Press <b>Ctrl+J</b> (or <b>⌘J</b>), or the ✨ button on a page or meeting, to ask a question. Ask AI answers from the workspace and links its sources.</li>
      <li>You can also ask about your business's figures (sales, bookings, labour). You'll only see the figures for your own business.</li>
      <li>Ask AI can suggest tasks and pages, but only does them when you press <b>Confirm</b>.</li>
    </ul>) },
  { title: "On your phone and Mac", body: (
    <ul className="tour-list">
      <li><b>iPhone:</b> open Atrium in Safari, press <b>Share</b>, then <b>Add to Home Screen</b>. Open it from there.</li>
      <li><b>Android:</b> open it in Chrome and choose <b>Install app</b>.</li>
      <li><b>Mac, Safari:</b> open Atrium, then in the menu bar choose <b>File</b>, then <b>Add to Dock</b>. It gets its own icon and window, like an app.</li>
      <li><b>Mac, Chrome, Edge or Arc:</b> open Atrium, press the <b>⋮</b> menu, then <b>Save and share</b> (or <b>Cast, save and share</b>), then <b>Install page as app</b>.</li>
      <li>Then turn on notifications under <b>Settings, Profile</b>, to hear about tasks, mentions and what's due today.</li>
    </ul>) },
  { title: "Connect your calendar (optional)", body: (
    <>
      <p>With your calendar connected, Atrium can get you ready for meetings: past decisions with those people and open tasks between you.</p>
      <CalendarConnect connected={calendar} />
    </>) },
];

/** First-run tour. Shows once for each person (not guests), and can be replayed from Settings. */
export function Welcome({ onClose, replay }: { onClose: () => void; replay?: boolean }) {
  const app = useApp();
  const { data: setup } = useSetup();
  const [i, setI] = useState(0);
  const steps = STEPS(!!setup?.calendar);
  const last = i === steps.length - 1;
  const finish = async () => {
    if (!replay) { try { await api("/me/onboarded", { body: {} }); invalidate("setup"); } catch { /* shown again next time */ } }
    onClose();
  };
  return (
    <Sheet
      title={i === 0 ? `Hello, ${app.me.name.split(" ")[0]}` : steps[i]!.title}
      onClose={finish}
      footer={
        <>
          <span className="muted" style={{ marginRight: "auto", alignSelf: "center", fontSize: 12.5 }}>{i + 1} of {steps.length}</span>
          {i === 0 && <button className="btn plain" onClick={finish}>Skip</button>}
          {i > 0 && <button className="btn" onClick={() => setI(i - 1)}>Back</button>}
          {last ? <button className="btn primary" onClick={finish}>{setup?.calendar ? "Finish" : "Skip and finish"}</button> : <button className="btn primary" onClick={() => setI(i + 1)}>{i === 0 ? "Show me" : "Next"}</button>}
        </>
      }
    >
      {i === 0 && <h3 style={{ marginTop: 0 }}>{steps[0]!.title}</h3>}
      {steps[i]!.body}
    </Sheet>
  );
}
