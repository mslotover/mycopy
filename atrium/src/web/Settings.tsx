import { useQuery } from "@tanstack/react-query";
import { Plus, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { api, invalidate, relTime, type Role, type Space } from "./api";
import { Toolbar } from "./App";
import { pushState, turnOffPush, turnOnPush, type PushState } from "./phone";
import { Avatar, AvatarStack, Dropdown, EmojiPicker, Sheet, SpaceBadge, Spinner, toast, toastError, useApp } from "./ui";

const COLORS = ["#0071e3", "#34c759", "#ff9500", "#af52de", "#ff2d55", "#5856d6", "#00c7be", "#ff6482", "#a2845e", "#8e8e93"];

export function Settings() {
  const app = useApp();
  const admin = app.me.role === "owner" || app.me.role === "admin";
  const tabs = [["profile", "Profile"], ...(app.me.role !== "guest" ? [["people", "People"], ["spaces", "Spaces"]] : []), ...(admin ? [["email", "Email log"]] : [])] as [string, string][];
  const [tab, setTab] = useState("profile");
  return (
    <>
      <Toolbar crumbs={<span className="crumb current">Settings</span>} />
      <div className="scroll">
        <div className="column">
          <div className="view-head"><div className="grow"><h1 className="h-title">Settings</h1></div></div>
          <div className="bar"><div className="segmented">{tabs.map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}</div></div>
          {tab === "profile" && <Profile />}
          {tab === "people" && <People admin={admin} />}
          {tab === "spaces" && <Spaces admin={admin} />}
          {tab === "email" && <Outbox />}
        </div>
      </div>
    </>
  );
}

function Profile() {
  const app = useApp();
  const [name, setName] = useState(app.me.name);
  const save = async (body: { name?: string; color?: string }) => { try { await api("/me", { method: "PATCH", body }); invalidate("boot"); } catch (e) { toastError(e); } };
  return (
    <div>
      <div style={{ display: "flex", gap: 16, alignItems: "center", margin: "10px 0 24px" }}>
        <Avatar user={app.me} size={64} />
        <div><div style={{ fontSize: 20, fontWeight: 650, letterSpacing: "-0.02em" }}>{app.me.name}</div><div className="sec">{app.me.email} · {app.me.role[0].toUpperCase() + app.me.role.slice(1)}</div></div>
      </div>
      <div className="form-row"><label className="label">Name</label><input className="field" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== app.me.name && save({ name })} /></div>
      <div className="form-row"><label className="label">Colour</label><div className="swatches">{COLORS.map((c) => <button key={c} className={`swatch ${app.me.color.toLowerCase() === c ? "on" : ""}`} style={{ background: c }} aria-label={c} onClick={() => save({ color: c })} />)}</div></div>
      <div className="form-row"><label className="label">Notifications on this device</label><DeviceNotifications /></div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 24 }}>You sign in with a link or code sent to {app.me.email}. Emails about mentions, new tasks and meeting summaries go to the same address.</p>
    </div>
  );
}

const PUSH_HELP: Record<PushState, string> = {
  on: "On. You'll be told when you're given a task, mentioned, or have something due today.",
  off: "Off. Turn them on to hear when you're given a task, mentioned, or have something due today.",
  blocked: "Blocked. Allow notifications for this app in your device's settings, then come back here.",
  "needs-install": "On an iPhone, add Atrium to your Home Screen first (Share, then Add to Home Screen) and open it from there.",
  unsupported: "This browser doesn't support notifications.",
};

function DeviceNotifications() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { pushState().then(setState).catch(() => setState("unsupported")); }, []);
  if (!state) return <Spinner />;
  const run = async (fn: () => Promise<PushState>) => { setBusy(true); try { setState(await fn()); } catch (e) { toastError(e); } finally { setBusy(false); } };
  const test = async () => {
    try {
      const { delivered } = await api<{ delivered: number }>("/push/test", { body: {} });
      toast(delivered ? "Sent. It should arrive in a moment." : "Nothing was sent: no device has notifications on.");
    } catch (e) { toastError(e); }
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {state === "off" && <button className="btn primary" disabled={busy} onClick={() => run(turnOnPush)}>Turn on</button>}
        {state === "on" && <><button className="btn" onClick={test}>Send a test</button><button className="btn quiet" disabled={busy} onClick={() => run(turnOffPush)}>Turn off</button></>}
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: state === "on" || state === "off" ? "8px 0 0" : 0 }}>{PUSH_HELP[state]}</p>
    </div>
  );
}

function People({ admin }: { admin: boolean }) {
  const app = useApp();
  const [inviting, setInviting] = useState(false);
  const patch = async (id: string, body: { role?: string; active?: boolean }) => { try { await api(`/admin/users/${id}`, { method: "PATCH", body }); invalidate("boot"); } catch (e) { toastError(e); } };
  const people = [...app.users].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  return (
    <div>
      <div className="bar"><span className="grow sec">{app.users.filter((u) => u.active).length} people</span><button className="btn primary" onClick={() => setInviting(true)}><UserPlus />{admin ? "Invite" : "Invite a guest"}</button></div>
      <div className="settings-list">
        {people.map((u) => (
          <div key={u.id} className="settings-row" style={{ opacity: u.active ? 1 : 0.5 }}>
            <Avatar user={u} size={32} />
            <div className="grow"><div>{u.name}{u.id === app.me.id ? " (you)" : ""}</div><span>{u.email}{u.active ? "" : " · deactivated"}</span></div>
            {admin && u.role !== "owner" && u.id !== app.me.id ? (
              <>
                <select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })} aria-label={`Role for ${u.name}`}>
                  <option value="admin">Admin</option><option value="member">Member</option><option value="guest">Guest</option>
                </select>
                <button className="btn quiet" style={{ height: 28 }} onClick={() => patch(u.id, { active: !u.active })}>{u.active ? "Deactivate" : "Reactivate"}</button>
              </>
            ) : <span className="chip">{u.role[0].toUpperCase() + u.role.slice(1)}</span>}
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>Members see the spaces they belong to. Guests see only the pages shared with them. Admins can see every space and manage people.</p>
      {inviting && <InviteSheet admin={admin} onClose={() => setInviting(false)} />}
    </div>
  );
}

function InviteSheet({ admin, onClose }: { admin: boolean; onClose: () => void }) {
  const app = useApp();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>(admin ? "member" : "guest");
  const [spaces, setSpaces] = useState<string[]>([]);
  const send = async () => {
    try {
      const res = await api<{ existing?: boolean }>("/admin/users", { body: { name, email, role, space_ids: spaces } });
      invalidate("boot");
      toast(res.existing ? "They're already in the workspace" : "Invitation sent");
      onClose();
    } catch (e) { toastError(e); }
  };
  return (
    <Sheet title={admin ? "Invite someone" : "Invite a guest"} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!email.includes("@")} onClick={send}>Send invitation</button></>}>
      <div className="form-row"><label className="label">Name</label><input className="field" value={name} autoFocus onChange={(e) => setName(e.target.value)} /></div>
      <div className="form-row"><label className="label">Email</label><input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      {admin && (
        <div className="form-row"><label className="label">Role</label>
          <div className="segmented">{(["member", "admin", "guest"] as Role[]).map((r) => <button key={r} className={role === r ? "on" : ""} onClick={() => setRole(r)}>{r[0].toUpperCase() + r.slice(1)}</button>)}</div>
        </div>
      )}
      {role !== "guest" ? (
        <div className="form-row"><label className="label">Add to spaces</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {app.spaces.map((s) => <button key={s.id} className={`chip ${spaces.includes(s.id) ? "blue" : ""}`} style={{ height: 28 }} onClick={() => setSpaces((v) => (v.includes(s.id) ? v.filter((x) => x !== s.id) : [...v, s.id]))}>{s.icon} {s.name}</button>)}
          </div>
        </div>
      ) : <p className="muted" style={{ fontSize: 12.5 }}>Guests can open only the pages you share with them. Share a page from its Share menu after inviting.</p>}
    </Sheet>
  );
}

function Spaces({ admin }: { admin: boolean }) {
  const app = useApp();
  const [editing, setEditing] = useState<Space | "new" | null>(null);
  return (
    <div>
      <div className="bar"><span className="grow sec">One space per business or team. Everyone in a space can see and edit its pages, tasks and meetings.</span><button className="btn primary" onClick={() => setEditing("new")}><Plus />New space</button></div>
      <div className="settings-list">
        {app.spaces.map((s) => (
          <div key={s.id} className="settings-row">
            <SpaceBadge space={s} size={32} />
            <div className="grow"><div>{s.name}</div><span>{s.description || `${s.member_ids.length} members`}</span></div>
            <AvatarStack users={s.member_ids.map((m) => app.userById.get(m)).filter(Boolean) as any[]} max={5} />
            <button className="btn" style={{ height: 28 }} onClick={() => setEditing(s)}>Edit</button>
          </div>
        ))}
        {!app.spaces.length && <div className="empty">No spaces yet</div>}
      </div>
      {editing && <SpaceSheet space={editing === "new" ? null : editing} admin={admin} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SpaceSheet({ space, admin, onClose }: { space: Space | null; admin: boolean; onClose: () => void }) {
  const app = useApp();
  const [name, setName] = useState(space?.name ?? "");
  const [icon, setIcon] = useState(space?.icon ?? "");
  const [description, setDescription] = useState(space?.description ?? "");
  const [members, setMembers] = useState<string[]>(space?.member_ids ?? [app.me.id]);
  const save = async () => {
    try {
      if (space) {
        await api(`/spaces/${space.id}`, { method: "PATCH", body: { name, icon, description } });
        for (const id of members.filter((m) => !space.member_ids.includes(m))) await api(`/spaces/${space.id}/members/${id}`, { method: "PUT", body: {} });
        for (const id of space.member_ids.filter((m) => !members.includes(m))) await api(`/spaces/${space.id}/members/${id}`, { method: "DELETE" });
      } else await api("/spaces", { body: { name, icon, description, member_ids: members } });
      invalidate("boot");
      onClose();
    } catch (e) { toastError(e); }
  };
  const archive = async () => { try { await api(`/spaces/${space!.id}`, { method: "PATCH", body: { archived: true } }); invalidate("boot", "tree"); onClose(); } catch (e) { toastError(e); } };
  const candidates = app.users.filter((u) => u.active && u.role !== "guest");
  return (
    <Sheet title={space ? "Edit space" : "New space"} onClose={onClose} footer={<>
      {space && admin && <button className="btn quiet danger" style={{ marginRight: "auto" }} onClick={archive}>Archive space</button>}
      <button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()} onClick={save}>{space ? "Save" : "Create"}</button>
    </>}>
      <div className="form-row" style={{ display: "flex", gap: 10 }}>
        <Dropdown trigger={({ onClick }) => <button className="field" style={{ width: 52, fontSize: 20, padding: 0, textAlign: "center" }} onClick={onClick} aria-label="Icon">{icon || "＋"}</button>}>
          {(close) => <EmojiPicker onPick={(e) => { setIcon(e); close(); }} onRemove={() => { setIcon(""); close(); }} />}
        </Dropdown>
        <input className="field" placeholder="Name, e.g. Toklas Bakery" value={name} autoFocus={!space} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-row"><input className="field" placeholder="What is this space for? (optional)" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      <label className="label">Members</label>
      <div style={{ maxHeight: 260, overflow: "auto" }}>
        <PersonListInline users={candidates} value={members} onToggle={(id) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]))} />
      </div>
    </Sheet>
  );
}

function PersonListInline({ users, value, onToggle }: { users: any[]; value: string[]; onToggle: (id: string) => void }) {
  return (
    <div>
      {users.map((u) => (
        <label key={u.id} className="person-line" style={{ cursor: "pointer" }}>
          <Avatar user={u} size={28} />
          <div className="nm"><div>{u.name}</div><span>{u.email}</span></div>
          <input type="checkbox" className="switch" checked={value.includes(u.id)} onChange={() => onToggle(u.id)} />
        </label>
      ))}
    </div>
  );
}

function Outbox() {
  const { data } = useQuery({ queryKey: ["outbox"], queryFn: () => api<{ outbox: { id: string; to_email: string; subject: string; status: string; error: string | null; created_at: number }[] }>("/admin/outbox").then((r) => r.outbox), staleTime: 0 });
  return (
    <div>
      <p className="sec" style={{ marginBottom: 12 }}>Every email the app has sent: sign-in links, invitations, notifications and meeting summaries.</p>
      <div className="settings-list">
        {(data ?? []).map((o) => (
          <div key={o.id} className="settings-row">
            <div className="grow"><div>{o.subject}</div><span>{o.to_email} · {relTime(o.created_at)}{o.error ? ` · ${o.error}` : ""}</span></div>
            <span className={`chip ${o.status === "sent" ? "green" : o.status === "failed" ? "red" : "gray"}`}>{o.status === "skipped" ? "Not sent (dev)" : o.status}</span>
          </div>
        ))}
        {data && !data.length && <div className="empty">No emails yet</div>}
      </div>
    </div>
  );
}

