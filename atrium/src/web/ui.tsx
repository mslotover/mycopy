import { autoUpdate, computePosition, flip, offset, shift, size, type Placement } from "@floating-ui/dom";
import { Check, Database, FileText, X } from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { initials, type Boot, type Space, type User } from "./api";

// ---------- App context ----------

type AppCtx = Boot & { userById: Map<string, User>; spaceById: Map<string, Space>; me: User };
const Ctx = createContext<AppCtx | null>(null);
export function AppProvider({ boot, children }: { boot: Boot; children: ReactNode }) {
  const value = useMemo<AppCtx>(
    () => ({ ...boot, me: boot.user, userById: new Map(boot.users.map((u) => [u.id, u])), spaceById: new Map(boot.spaces.map((s) => [s.id, s])) }),
    [boot],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useApp = () => useContext(Ctx)!;

// ---------- Basics ----------

export function Avatar({ user, name, color, size = 24 }: { user?: User | null; name?: string; color?: string; size?: number }) {
  const n = user?.name ?? name ?? "?";
  return (
    <span className="avatar" title={n} style={{ width: size, height: size, fontSize: Math.max(9, size * 0.4), backgroundColor: user?.color ?? color ?? "#8e8e93" }}>
      {initials(n)}
    </span>
  );
}

export function AvatarStack({ users, max = 4, size = 22 }: { users: (User | { name: string })[]; max?: number; size?: number }) {
  const shown = users.slice(0, max);
  return (
    <span className="avatar-stack">
      {shown.map((u, i) => ("id" in u ? <Avatar key={i} user={u} size={size} /> : <Avatar key={i} name={u.name} size={size} />))}
      {users.length > max && (
        <span className="avatar more" style={{ width: size, height: size, fontSize: size * 0.4 }}>+{users.length - max}</span>
      )}
    </span>
  );
}

export function PageGlyph({ icon, kind }: { icon?: string; kind?: string }) {
  if (icon) return <span className="glyph">{icon}</span>;
  return <span className="glyph">{kind === "database" ? <Database /> : <FileText />}</span>;
}

export const Spinner = () => <div className="center"><div className="spin" /></div>;

export function Empty({ icon, title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="big">{icon}</div>}
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function SpaceBadge({ space, size = 20 }: { space: Space; size?: number }) {
  if (space.icon) return <span className="space-dot emoji" style={{ width: size, height: size, fontSize: size * 0.82 }}>{space.icon}</span>;
  return <span className="space-dot" style={{ background: space.color, width: size, height: size, fontSize: size * 0.56 }}>{space.name[0]?.toUpperCase()}</span>;
}

// ---------- Popover ----------

/** A floating panel anchored to an element. It grows from its anchor and closes on outside press or Escape. */
export function Pop({ anchor, onClose, children, placement = "bottom-start", width, className }: { anchor: Element | null; onClose: () => void; children: ReactNode; placement?: Placement; width?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    return autoUpdate(anchor, el, () => {
      computePosition(anchor, el, {
        strategy: "fixed",
        placement,
        middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), size({ padding: 8, apply: ({ availableHeight, elements }) => { elements.floating.style.maxHeight = `${Math.max(160, Math.min(440, availableHeight))}px`; } })],
      }).then(({ x, y, placement: p }) => {
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.setProperty("--origin", `${p.startsWith("top") ? "bottom" : "top"} ${p.endsWith("end") ? "right" : "left"}`);
      });
    });
  }, [anchor, placement]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      // A popover opened from inside this one is portaled after it; a press there shouldn't close this one.
      const other = (t as Element).closest?.(".pop");
      if (other && ref.current && other !== ref.current && ref.current.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key, true); };
  }, [anchor, onClose]);
  if (!anchor) return null;
  return createPortal(
    <div ref={ref} className={`pop ${className ?? ""}`} style={{ width, left: -9999, top: -9999 }} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

/** Trigger + popover in one. `children` receives a close function. */
export function Dropdown({ trigger, children, placement, width }: { trigger: (p: { onClick: (e: React.MouseEvent) => void; open: boolean }) => ReactNode; children: (close: () => void) => ReactNode; placement?: Placement; width?: number }) {
  const [anchor, setAnchor] = useState<Element | null>(null);
  const close = () => setAnchor(null);
  return (
    <>
      {trigger({ open: !!anchor, onClick: (e) => { e.preventDefault(); e.stopPropagation(); setAnchor((a) => (a ? null : (e.currentTarget as Element))); } })}
      {anchor && <Pop anchor={anchor} onClose={close} placement={placement} width={width}>{children(close)}</Pop>}
    </>
  );
}

export function MenuItem({ icon, children, onClick, danger, sub, end, active }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; danger?: boolean; sub?: string; end?: ReactNode; active?: boolean }) {
  return (
    <button className={`menu-item ${danger ? "danger" : ""}`} onClick={onClick}>
      {icon}
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {children}
        {sub && <span className="sub" style={{ display: "block" }}>{sub}</span>}
      </span>
      {(end || active) && <span className="end">{end ?? <Check size={15} />}</span>}
    </button>
  );
}

// ---------- Sheet (modal) ----------

export function Sheet({ title, onClose, children, footer, wide }: { title?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`sheet ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        {title && (
          <div className="sheet-head">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
          </div>
        )}
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Toasts and confirmation ----------

type Toast = { id: number; text: string; error?: boolean; action?: { label: string; run: () => void } };
let pushToast: (t: Omit<Toast, "id">) => void = () => {};
export const toast = (text: string, opts: { error?: boolean; action?: Toast["action"] } = {}) => pushToast({ text, ...opts });
export const toastError = (e: unknown) => toast(e instanceof Error ? e.message : "Something went wrong.", { error: true });

type Confirm = { title: string; body?: string; action: string; danger?: boolean; resolve: (ok: boolean) => void };
let pushConfirm: (c: Confirm) => void = () => {};
/** Asks before a destructive action. Resolves true when confirmed. */
export const confirmDialog = (c: Omit<Confirm, "resolve">) => new Promise<boolean>((resolve) => pushConfirm({ ...c, resolve }));

export function Overlays() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  useEffect(() => {
    let n = 0;
    pushToast = (t) => {
      const id = ++n;
      setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
      setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.action ? 7000 : t.error ? 5000 : 2600);
    };
    pushConfirm = setConfirm;
  }, []);
  const answer = (ok: boolean) => { confirm?.resolve(ok); setConfirm(null); };
  return (
    <>
      {createPortal(
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.error ? "error" : ""}`}>
              {t.text}
              {t.action && <button onClick={() => { t.action!.run(); setToasts((ts) => ts.filter((x) => x.id !== t.id)); }}>{t.action.label}</button>}
            </div>
          ))}
        </div>,
        document.body,
      )}
      {confirm && (
        <Sheet title={confirm.title} onClose={() => answer(false)} footer={<>
          <button className="btn" onClick={() => answer(false)}>Cancel</button>
          <button className={`btn primary ${confirm.danger ? "danger" : ""}`} autoFocus onClick={() => answer(true)}>{confirm.action}</button>
        </>}>
          {confirm.body && <p className="sec" style={{ fontSize: 14.5 }}>{confirm.body}</p>}
        </Sheet>
      )}
    </>
  );
}

// ---------- Pickers ----------

const EMOJI = "📄 📝 📌 📎 📁 📚 📖 🗂️ 🗒️ 📅 ✅ ⭐ 💡 🎯 🚀 🔥 ⚙️ 🔑 🔒 💬 📣 📈 📊 💰 🧾 🏦 🤝 👥 👋 🏠 🏢 🏨 🏗️ 🛠️ 🧰 🧪 🍽️ 🍷 🥂 ☕ 🥐 🍞 🥖 🧁 🍰 🍫 🍪 🍦 🧀 🥗 🍅 🌿 🌱 🌍 ☀️ 🌙 ✈️ 🚚 📦 🛒 🎨 🖼️ 📷 🎬 🎵 🧠 ❤️ 🤖 🧭 🗺️ ⏱️ 🔔 🧹 🧼 👨‍🍳 🧑‍💼 🎉 🏆 ❓ ⚠️".split(" ");

export function EmojiPicker({ onPick, onRemove }: { onPick: (e: string) => void; onRemove?: () => void }) {
  return (
    <div>
      <div className="emoji-grid">{EMOJI.map((e) => <button key={e} onClick={() => onPick(e)}>{e}</button>)}</div>
      {onRemove && (<><div className="menu-sep" /><MenuItem onClick={onRemove}>Remove icon</MenuItem></>)}
    </div>
  );
}

/** Searchable list of people. With `multi`, stays open and shows ticks. */
export function PersonList({ value, onPick, multi, allowNone, users }: { value: string[]; onPick: (id: string | null) => void; multi?: boolean; allowNone?: boolean; users?: User[] }) {
  const app = useApp();
  const [q, setQ] = useState("");
  const list = (users ?? app.users).filter((u) => u.active && (u.name + u.email).toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <input className="pop-search" placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {allowNone && !q && <MenuItem onClick={() => onPick(null)} active={!multi && !value.length}>No one</MenuItem>}
      {list.map((u) => (
        <MenuItem key={u.id} icon={<Avatar user={u} size={20} />} onClick={() => onPick(u.id)} active={value.includes(u.id)} sub={u.role === "guest" ? "Guest" : undefined}>
          {u.name}{u.id === app.me.id ? " (you)" : ""}
        </MenuItem>
      ))}
      {!list.length && <div className="empty" style={{ padding: 14 }}>No one found</div>}
    </div>
  );
}

export function PersonPill({ id, placeholder = "Assign", onChange, allowNone = true }: { id: string | null; placeholder?: string; onChange?: (id: string | null) => void; allowNone?: boolean }) {
  const app = useApp();
  const u = id ? app.userById.get(id) : null;
  const face = u ? (<><Avatar user={u} size={18} />{u.name.split(" ")[0]}</>) : <span className="muted">{placeholder}</span>;
  if (!onChange) return <span className="chip" style={{ background: "transparent", paddingLeft: 0 }}>{face}</span>;
  return (
    <Dropdown width={250} trigger={({ onClick }) => <button className="chip" onClick={onClick}>{face}</button>}>
      {(close) => <PersonList value={id ? [id] : []} allowNone={allowNone} onPick={(v) => { onChange(v); close(); }} />}
    </Dropdown>
  );
}

export function SpaceSelect({ value, onChange, privateLabel = "Private (only me)" }: { value: string | null; onChange: (id: string | null) => void; privateLabel?: string | null }) {
  const app = useApp();
  return (
    <select className="field" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      {privateLabel !== null && <option value="">{privateLabel}</option>}
      {app.spaces.map((s) => <option key={s.id} value={s.id}>{s.icon ? s.icon + " " : ""}{s.name}</option>)}
    </select>
  );
}

/** Text that grows with its content; used for titles. */
export function AutoText({ value, onChange, className, placeholder, readOnly, onEnter, autoFocus }: { value: string; onChange: (v: string) => void; className?: string; placeholder?: string; readOnly?: boolean; onEnter?: () => void; autoFocus?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = el.scrollHeight + "px";
  }, [value]);
  return (
    <textarea
      ref={ref} rows={1} className={className} value={value} placeholder={placeholder} readOnly={readOnly} autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value.replace(/\n/g, " "))}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onEnter?.(); } }}
    />
  );
}

/** Debounces a save function; flushes on unmount so nothing typed is lost. */
export function useDebouncedSave<T>(save: (v: T) => Promise<unknown> | void, delay = 700) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ v: T } | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current) {
      const { v } = pending.current;
      pending.current = null;
      return saveRef.current(v);
    }
  };
  useEffect(() => () => void flush(), []);
  return {
    schedule: (v: T) => {
      pending.current = { v };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    },
    flush,
    isPending: () => !!pending.current,
  };
}
