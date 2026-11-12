import {
  ArrowDown, ArrowUp, Calendar as CalIcon, CalendarDays, CheckSquare, ChevronLeft, ChevronRight, CircleDot, Hash, Kanban, Link2, List as ListIcon, Maximize2,
  MoreHorizontal, Plus, Search, Table2, Tags, Trash2, Type, User as UserIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { addDays, api, fmtDate, invalidate, qc, rid, todayISO, type Option, type Page, type PageDetail, type Prop, type PropType, type Schema, type View } from "./api";
import { Avatar, AvatarStack, Dropdown, MenuItem, PersonList, toastError, useApp } from "./ui";

const COLORS = ["gray", "blue", "green", "orange", "red", "purple"];
const TYPE_META: Record<PropType, { label: string; icon: ReactNode }> = {
  text: { label: "Text", icon: <Type /> }, number: { label: "Number", icon: <Hash /> }, select: { label: "Select", icon: <CircleDot /> },
  multi_select: { label: "Multi-select", icon: <Tags /> }, status: { label: "Status", icon: <CircleDot /> }, date: { label: "Date", icon: <CalIcon /> },
  person: { label: "Person", icon: <UserIcon /> }, checkbox: { label: "Checkbox", icon: <CheckSquare /> }, url: { label: "Link", icon: <Link2 /> },
};
const VIEW_META: Record<View["type"], { label: string; icon: ReactNode }> = {
  table: { label: "Table", icon: <Table2 /> }, board: { label: "Board", icon: <Kanban /> }, calendar: { label: "Calendar", icon: <CalendarDays /> }, list: { label: "List", icon: <ListIcon /> },
};
export const propIcon = (t: PropType) => TYPE_META[t]?.icon ?? <Type />;

// ---------- A single property value, editable in place ----------

function OptionPicker({ prop, value, multi, onChange, onSchema, close }: { prop: Prop; value: string[]; multi: boolean; onChange: (v: string[]) => void; onSchema?: (p: Prop) => void; close: () => void }) {
  const [q, setQ] = useState("");
  const opts = (prop.options ?? []).filter((o) => o.name.toLowerCase().includes(q.toLowerCase()));
  const exact = (prop.options ?? []).some((o) => o.name.toLowerCase() === q.trim().toLowerCase());
  const pick = (id: string) => {
    if (multi) onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
    else { onChange(value[0] === id ? [] : [id]); close(); }
  };
  const create = () => {
    const o: Option = { id: rid(), name: q.trim(), color: COLORS[(prop.options?.length ?? 0) % COLORS.length] };
    onSchema?.({ ...prop, options: [...(prop.options ?? []), o] });
    onChange(multi ? [...value, o.id] : [o.id]);
    setQ("");
    if (!multi) close();
  };
  return (
    <div>
      <input className="pop-search" placeholder={onSchema ? "Search or create an option" : "Search"} value={q} autoFocus onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && q.trim() && !exact && onSchema) create(); }} />
      {opts.map((o) => (
        <MenuItem key={o.id} onClick={() => pick(o.id)} active={value.includes(o.id)}><span className={`chip ${o.color}`}>{o.name}</span></MenuItem>
      ))}
      {q.trim() && !exact && onSchema && <MenuItem icon={<Plus />} onClick={create}>Create “{q.trim()}”</MenuItem>}
      {!opts.length && !q && <div className="empty" style={{ padding: 12 }}>Type to add an option</div>}
    </div>
  );
}

export function PropValue({ prop, value, editable, onChange, onSchema }: { prop: Prop; value: any; editable: boolean; onChange: (v: any) => void; onSchema?: (p: Prop) => void }) {
  const app = useApp();
  const [draft, setDraft] = useState<string | null>(null);
  const optById = new Map((prop.options ?? []).map((o) => [o.id, o]));

  if (prop.type === "checkbox") return <input type="checkbox" className="check-sq" checked={!!value} disabled={!editable} onChange={(e) => onChange(e.target.checked)} />;

  if (prop.type === "text" || prop.type === "number" || prop.type === "url") {
    const shown = draft ?? (value ?? "").toString();
    if (!editable) return prop.type === "url" && value ? <a href={value} target="_blank" rel="noopener noreferrer">{value}</a> : <span>{shown}</span>;
    const commit = () => {
      if (draft === null) return;
      const v = prop.type === "number" ? (draft.trim() === "" || isNaN(Number(draft)) ? null : Number(draft)) : draft;
      setDraft(null);
      if (v !== (value ?? (prop.type === "number" ? null : ""))) onChange(v);
    };
    return <input className="bare" inputMode={prop.type === "number" ? "decimal" : undefined} value={shown} placeholder="Empty" onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />;
  }

  if (prop.type === "date") {
    if (!editable) return <span>{value ? fmtDate(value) : ""}</span>;
    return (
      <Dropdown width={230} trigger={({ onClick }) => <button className="cell" onClick={onClick}>{value ? fmtDate(value) : <span className="muted">Empty</span>}</button>}>
        {(close) => (
          <div style={{ padding: 6 }}>
            <input type="date" className="field" value={value ?? ""} autoFocus onChange={(e) => { onChange(e.target.value || null); if (e.target.value) close(); }} />
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              <button className="btn" onClick={() => { onChange(todayISO()); close(); }}>Today</button>
              <button className="btn" onClick={() => { onChange(addDays(todayISO(), 1)); close(); }}>Tomorrow</button>
              {value && <button className="btn quiet" onClick={() => { onChange(null); close(); }}>Clear</button>}
            </div>
          </div>
        )}
      </Dropdown>
    );
  }

  if (prop.type === "person") {
    const ids: string[] = Array.isArray(value) ? value : value ? [value] : [];
    const people = ids.map((i) => app.userById.get(i)).filter(Boolean) as any[];
    const face = people.length === 1 ? (<><Avatar user={people[0]} size={20} /><span>{people[0].name}</span></>) : people.length ? <AvatarStack users={people} /> : editable ? <span className="muted">Empty</span> : null;
    if (!editable) return <span className="cell" style={{ cursor: "default" }}>{face}</span>;
    return (
      <Dropdown width={250} trigger={({ onClick }) => <button className="cell" onClick={onClick}>{face}</button>}>
        {() => <PersonList multi value={ids} onPick={(id) => id && onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])} />}
      </Dropdown>
    );
  }

  // select · multi_select · status
  const multi = prop.type === "multi_select";
  const ids: string[] = (Array.isArray(value) ? value : value ? [value] : []).filter((i: string) => optById.has(i));
  const chips = ids.map((i) => <span key={i} className={`chip ${optById.get(i)!.color}`}>{prop.type === "status" && <span className="dot" />}{optById.get(i)!.name}</span>);
  if (!editable) return <span className="cell" style={{ cursor: "default" }}>{chips}</span>;
  return (
    <Dropdown width={240} trigger={({ onClick }) => <button className="cell" onClick={onClick}>{chips.length ? chips : <span className="muted">Empty</span>}</button>}>
      {(close) => <OptionPicker prop={prop} value={ids} multi={multi} close={close} onSchema={onSchema} onChange={(v) => onChange(multi ? v : v[0] ?? null)} />}
    </Dropdown>
  );
}

// ---------- The database ----------

export function DatabaseView({ detail, editable }: { detail: PageDetail; editable: boolean }) {
  const db = detail.page;
  const navigate = useNavigate();
  const [schema, setSchema] = useState<Schema>(db.schema ?? { props: [], views: [] });
  const [rows, setRows] = useState<Page[]>(detail.rows ?? []);
  const [viewId, setViewId] = useState<string>(() => localStorage.getItem(`atrium.view.${db.id}`) ?? "");
  const [q, setQ] = useState("");
  const focusRow = useRef<string | null>(null);

  // Pick up changes made elsewhere (another person, or the row's own page).
  useEffect(() => { setRows(detail.rows ?? []); }, [detail.rows]);
  useEffect(() => { if (db.schema) setSchema(db.schema); }, [db.updated_at]);

  const view = schema.views.find((v) => v.id === viewId) ?? schema.views[0];
  const pickView = (id: string) => { setViewId(id); localStorage.setItem(`atrium.view.${db.id}`, id); };

  const saveSchema = async (next: Schema) => {
    setSchema(next);
    try { await api(`/pages/${db.id}`, { method: "PATCH", body: { schema: next } }); } catch (e) { toastError(e); qc.invalidateQueries({ queryKey: ["page", db.id] }); }
  };
  const saveProp = (p: Prop) => saveSchema({ ...schema, props: schema.props.map((x) => (x.id === p.id ? p : x)) });
  const patchView = (patch: Partial<View>) => saveSchema({ ...schema, views: schema.views.map((v) => (v.id === view?.id ? { ...v, ...patch } : v)) });

  const addRow = async (props: Record<string, any> = {}, open = false) => {
    try {
      const { page } = await api<{ page: Page }>("/pages", { body: { parent_id: db.id, kind: "row", title: "", props } });
      focusRow.current = page.id;
      setRows((r) => [...r, page]);
      if (open) navigate(`/p/${page.id}`);
    } catch (e) { toastError(e); }
  };
  const updateRow = async (id: string, patch: { title?: string; props?: Record<string, any> }) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...(patch.title !== undefined ? { title: patch.title } : {}), props: { ...r.props, ...(patch.props ?? {}) } } : r)));
    try { await api(`/pages/${id}`, { method: "PATCH", body: patch }); invalidate("recent"); } catch (e) { toastError(e); qc.invalidateQueries({ queryKey: ["page", db.id] }); }
  };
  const deleteRow = async (id: string) => {
    setRows((rs) => rs.filter((r) => r.id !== id));
    try { await api(`/pages/${id}`, { method: "DELETE" }); } catch (e) { toastError(e); }
  };

  const addProp = (type: PropType, name?: string): Prop => {
    const p: Prop = { id: rid(), name: name ?? TYPE_META[type].label, type };
    if (type === "status") p.options = [{ id: rid(), name: "Not started", color: "gray" }, { id: rid(), name: "In progress", color: "blue" }, { id: rid(), name: "Done", color: "green" }];
    if (type === "select" || type === "multi_select") p.options = [];
    return p;
  };
  const addView = (type: View["type"]) => {
    let props = schema.props;
    const v: View = { id: rid(), name: VIEW_META[type].label, type };
    if (type === "board") {
      let g = props.find((p) => p.type === "status" || p.type === "select");
      if (!g) { g = addProp("status"); props = [...props, g]; }
      v.groupBy = g.id;
    }
    if (type === "calendar") {
      let d = props.find((p) => p.type === "date");
      if (!d) { d = addProp("date"); props = [...props, d]; }
      v.dateProp = d.id;
    }
    saveSchema({ props, views: [...schema.views, v] });
    pickView(v.id);
  };

  const shown = useMemo(() => {
    let out = rows.filter((r) => !q || r.title.toLowerCase().includes(q.toLowerCase()));
    const s = view?.sort;
    if (s) {
      const p = schema.props.find((x) => x.id === s.prop);
      const key = (r: Page): string | number => {
        if (s.prop === "title") return r.title.toLowerCase();
        const v = r.props[s.prop];
        if (v == null || v === "") return "￿";
        if (p?.options) { const idx = p.options.findIndex((o) => o.id === (Array.isArray(v) ? v[0] : v)); return idx < 0 ? 999 : idx; }
        return typeof v === "number" ? v : String(Array.isArray(v) ? v.join() : v).toLowerCase();
      };
      out = [...out].sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * (s.dir === "asc" ? 1 : -1); });
    }
    return out;
  }, [rows, q, view?.sort, schema.props]);

  if (!view) {
    return <div className="empty">This database has no views yet.{editable && <div><button className="btn" onClick={() => addView("table")}>Add a table view</button></div>}</div>;
  }

  return (
    <div>
      <div className="db-tabs">
        {schema.views.map((v) => (
          <button key={v.id} className={`db-tab ${v.id === view.id ? "on" : ""}`} onClick={() => pickView(v.id)}>{VIEW_META[v.type].icon}{v.name}</button>
        ))}
        {editable && (
          <Dropdown width={190} trigger={({ onClick }) => <button className="icon-btn" aria-label="Add a view" onClick={onClick}><Plus /></button>}>
            {(close) => (<>{(Object.keys(VIEW_META) as View["type"][]).map((t) => <MenuItem key={t} icon={VIEW_META[t].icon} onClick={() => { close(); addView(t); }}>{VIEW_META[t].label}</MenuItem>)}</>)}
          </Dropdown>
        )}
        <span style={{ flex: 1 }} />
        <label className="chip" style={{ height: 28, gap: 6, cursor: "text" }}><Search /><input className="bare" style={{ width: 110 }} placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        {editable && (
          <Dropdown width={230} placement="bottom-end" trigger={({ onClick }) => <button className="icon-btn" aria-label="View options" onClick={onClick}><MoreHorizontal /></button>}>
            {(close) => (
              <>
                <div style={{ padding: "4px 4px 6px" }}><input className="pop-search" style={{ margin: 0 }} defaultValue={view.name} aria-label="View name" onBlur={(e) => e.target.value.trim() && e.target.value !== view.name && patchView({ name: e.target.value.trim() })} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /></div>
                {view.type === "board" && (<>
                  <div className="menu-title">Group by</div>
                  {schema.props.filter((p) => p.type === "status" || p.type === "select").map((p) => <MenuItem key={p.id} active={view.groupBy === p.id} onClick={() => { patchView({ groupBy: p.id }); close(); }}>{p.name}</MenuItem>)}
                </>)}
                {view.type === "calendar" && (<>
                  <div className="menu-title">Show by</div>
                  {schema.props.filter((p) => p.type === "date").map((p) => <MenuItem key={p.id} active={view.dateProp === p.id} onClick={() => { patchView({ dateProp: p.id }); close(); }}>{p.name}</MenuItem>)}
                </>)}
                {view.sort && <MenuItem onClick={() => { patchView({ sort: undefined }); close(); }}>Clear sorting</MenuItem>}
                {schema.views.length > 1 && (<><div className="menu-sep" /><MenuItem danger icon={<Trash2 />} onClick={() => { close(); saveSchema({ ...schema, views: schema.views.filter((v) => v.id !== view.id) }); }}>Delete this view</MenuItem></>)}
              </>
            )}
          </Dropdown>
        )}
        {editable && <button className="btn primary" style={{ height: 28 }} onClick={() => addRow({}, view.type !== "table")}><Plus />New</button>}
      </div>

      {view.type === "table" && <TableView {...{ schema, rows: shown, view, editable, focusRow, addRow, updateRow, deleteRow, saveSchema, saveProp, patchView, addProp }} />}
      {view.type === "board" && <BoardView {...{ schema, rows: shown, view, editable, addRow, updateRow, saveProp }} />}
      {view.type === "calendar" && <CalendarView {...{ schema, rows: shown, view, editable, addRow }} />}
      {view.type === "list" && (
        <div style={{ paddingTop: 8 }}>
          {shown.map((r) => (
            <Link key={r.id} to={`/p/${r.id}`} className="row-link">
              <span className="t" style={{ fontWeight: 500 }}>{r.icon} {r.title || <span className="muted">Untitled</span>}</span>
              <RowChips row={r} schema={schema} />
            </Link>
          ))}
          {!shown.length && <div className="empty">Nothing here yet</div>}
        </div>
      )}
    </div>
  );
}

function RowChips({ row, schema, skip }: { row: Page; schema: Schema; skip?: string }) {
  const app = useApp();
  const out: ReactNode[] = [];
  for (const p of schema.props) {
    if (p.id === skip) continue;
    const v = row.props[p.id];
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (p.options) for (const id of Array.isArray(v) ? v : [v]) { const o = p.options.find((x) => x.id === id); if (o) out.push(<span key={p.id + id} className={`chip ${o.color}`}>{o.name}</span>); }
    else if (p.type === "date") out.push(<span key={p.id} className="due">{fmtDate(v)}</span>);
    else if (p.type === "person") out.push(<AvatarStack key={p.id} size={18} users={(Array.isArray(v) ? v : [v]).map((i: string) => app.userById.get(i)).filter(Boolean) as any[]} />);
  }
  return <>{out.slice(0, 4)}</>;
}

type Common = { schema: Schema; rows: Page[]; view: View; editable: boolean };

function TableView({ schema, rows, view, editable, focusRow, addRow, updateRow, deleteRow, saveSchema, saveProp, patchView, addProp }: Common & {
  focusRow: React.MutableRefObject<string | null>; addRow: (p?: Record<string, any>) => void; updateRow: (id: string, patch: { title?: string; props?: Record<string, any> }) => void; deleteRow: (id: string) => void;
  saveSchema: (s: Schema) => void; saveProp: (p: Prop) => void; patchView: (p: Partial<View>) => void; addProp: (t: PropType, name?: string) => Prop;
}) {
  const sortIcon = (id: string) => (view.sort?.prop === id ? (view.sort.dir === "asc" ? <ArrowUp /> : <ArrowDown />) : null);
  const headMenu = (id: string, prop?: Prop) => (close: () => void) => (
    <>
      {prop && editable && (
        <div style={{ padding: "4px 4px 6px" }}>
          <input className="pop-search" style={{ margin: 0 }} defaultValue={prop.name} aria-label="Property name" autoFocus onBlur={(e) => e.target.value.trim() && e.target.value !== prop.name && saveProp({ ...prop, name: e.target.value.trim() })} onKeyDown={(e) => { if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); close(); } }} />
        </div>
      )}
      <MenuItem icon={<ArrowUp />} onClick={() => { patchView({ sort: { prop: id, dir: "asc" } }); close(); }}>Sort ascending</MenuItem>
      <MenuItem icon={<ArrowDown />} onClick={() => { patchView({ sort: { prop: id, dir: "desc" } }); close(); }}>Sort descending</MenuItem>
      {prop && editable && (<><div className="menu-sep" /><MenuItem danger icon={<Trash2 />} onClick={() => { close(); saveSchema({ ...schema, props: schema.props.filter((p) => p.id !== prop.id) }); }}>Delete property</MenuItem></>)}
    </>
  );
  return (
    <div className="table-wrap">
      <table className="db">
        <thead>
          <tr>
            <th><Dropdown width={210} trigger={({ onClick }) => <button onClick={onClick}><Type />Name{sortIcon("title")}</button>}>{headMenu("title")}</Dropdown></th>
            {schema.props.map((p) => (
              <th key={p.id}><Dropdown width={220} trigger={({ onClick }) => <button onClick={onClick}>{propIcon(p.type)}{p.name}{sortIcon(p.id)}</button>}>{headMenu(p.id, p)}</Dropdown></th>
            ))}
            {editable && (
              <th style={{ width: 40 }}>
                <Dropdown width={200} placement="bottom-end" trigger={({ onClick }) => <button onClick={onClick} aria-label="Add a property"><Plus /></button>}>
                  {(close) => (<><div className="menu-title">New property</div>{(Object.keys(TYPE_META) as PropType[]).map((t) => (
                    <MenuItem key={t} icon={TYPE_META[t].icon} onClick={() => { close(); saveSchema({ ...schema, props: [...schema.props, addProp(t)] }); }}>{TYPE_META[t].label}</MenuItem>
                  ))}</>)}
                </Dropdown>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="title">
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <TitleCell row={r} editable={editable} autoFocus={focusRow.current === r.id} onDone={() => (focusRow.current = null)} onSave={(t) => updateRow(r.id, { title: t })} />
                  <Link to={`/p/${r.id}`} className="icon-btn sm open" aria-label="Open" title="Open"><Maximize2 /></Link>
                  {editable && (
                    <Dropdown width={170} trigger={({ onClick }) => <button className="icon-btn sm open" style={{ marginLeft: 0 }} aria-label="Row options" onClick={onClick}><MoreHorizontal /></button>}>
                      {(close) => <MenuItem danger icon={<Trash2 />} onClick={() => { close(); deleteRow(r.id); }}>Delete</MenuItem>}
                    </Dropdown>
                  )}
                </div>
              </td>
              {schema.props.map((p) => (
                <td key={p.id}><PropValue prop={p} value={r.props[p.id]} editable={editable} onSchema={saveProp} onChange={(v) => updateRow(r.id, { props: { [p.id]: v } })} /></td>
              ))}
              {editable && <td />}
            </tr>
          ))}
        </tbody>
      </table>
      {editable ? <button className="db-add" onClick={() => addRow()}><Plus />New row</button> : !rows.length && <div className="empty">Nothing here yet</div>}
    </div>
  );
}

function TitleCell({ row, editable, autoFocus, onDone, onSave }: { row: Page; editable: boolean; autoFocus: boolean; onDone: () => void; onSave: (t: string) => void }) {
  const [v, setV] = useState(row.title);
  useEffect(() => setV(row.title), [row.title]);
  useEffect(() => { if (autoFocus) onDone(); }, []);
  if (!editable) return <Link to={`/p/${row.id}`} style={{ color: "inherit", flex: 1 }}>{row.icon} {row.title || "Untitled"}</Link>;
  return <input className="bare" style={{ fontWeight: 500 }} value={v} placeholder="Untitled" autoFocus={autoFocus} onChange={(e) => setV(e.target.value)} onBlur={() => v !== row.title && onSave(v)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />;
}

function BoardView({ schema, rows, view, editable, addRow, updateRow }: Common & { addRow: (p?: Record<string, any>, open?: boolean) => void; updateRow: (id: string, patch: { props?: Record<string, any> }) => void; saveProp: (p: Prop) => void }) {
  const group = schema.props.find((p) => p.id === view.groupBy) ?? schema.props.find((p) => p.type === "status" || p.type === "select");
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  if (!group) return <div className="empty">Add a Status or Select property to group this board.</div>;
  const cols: { id: string | null; name: string; color: string }[] = [...(group.options ?? []), { id: null as any, name: `No ${group.name.toLowerCase()}`, color: "gray" }];
  const inCol = (id: string | null) => rows.filter((r) => (r.props[group.id] ?? null) === id || (id === null && !(group.options ?? []).some((o) => o.id === r.props[group.id])));
  return (
    <div className="board">
      {cols.map((c) => {
        const items = inCol(c.id);
        if (c.id === null && !items.length) return null;
        const key = c.id ?? "none";
        return (
          <div key={key} className={`board-col ${over === key ? "over" : ""}`}
            onDragOver={(e) => { if (editable) { e.preventDefault(); setOver(key); } }} onDragLeave={() => setOver((o) => (o === key ? null : o))}
            onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/row"); if (id) updateRow(id, { props: { [group.id]: c.id } }); }}>
            <h5><span className={`chip ${c.color}`}><span className="dot" />{c.name}</span><span className="n">{items.length}</span></h5>
            {items.map((r) => (
              <Link key={r.id} to={`/p/${r.id}`} draggable={editable} className={`board-card ${dragging === r.id ? "dragging" : ""}`}
                onDragStart={(e) => { e.dataTransfer.setData("text/row", r.id); e.dataTransfer.effectAllowed = "move"; setDragging(r.id); }} onDragEnd={() => setDragging(null)}>
                {r.icon} {r.title || <span className="muted">Untitled</span>}
                <div className="meta"><RowChips row={r} schema={schema} skip={group.id} /></div>
              </Link>
            ))}
            {editable && <button className="db-add" style={{ height: 32 }} onClick={() => addRow({ [group.id]: c.id }, true)}><Plus />New</button>}
          </div>
        );
      })}
    </div>
  );
}

function CalendarView({ schema, rows, view, editable, addRow }: Common & { addRow: (p?: Record<string, any>, open?: boolean) => void }) {
  const dateProp = schema.props.find((p) => p.id === view.dateProp) ?? schema.props.find((p) => p.type === "date");
  const [month, setMonth] = useState(() => todayISO().slice(0, 7));
  if (!dateProp) return <div className="empty">Add a Date property to place rows on the calendar.</div>;
  const first = new Date(month + "-01T12:00:00");
  const start = addDays(month + "-01", -((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const weeks = days[35].slice(0, 7) === month ? 6 : 5;
  const shift = (n: number) => { const d = new Date(month + "-01T12:00:00"); d.setMonth(d.getMonth() + n); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const today = todayISO();
  return (
    <div>
      <div className="cal-head">
        <h4>{first.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h4>
        <button className="btn" onClick={() => setMonth(today.slice(0, 7))}>Today</button>
        <button className="icon-btn" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft /></button>
        <button className="icon-btn" aria-label="Next month" onClick={() => shift(1)}><ChevronRight /></button>
      </div>
      <div className="cal">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="dow">{d}</div>)}
        {days.slice(0, weeks * 7).map((d) => (
          <div key={d} className={`day ${d.slice(0, 7) === month ? "" : "out"} ${d === today ? "today" : ""}`}>
            {editable && <button className="icon-btn sm add" aria-label="Add" onClick={() => addRow({ [dateProp.id]: d }, true)}><Plus /></button>}
            <span className="num">{Number(d.slice(8))}</span>
            {rows.filter((r) => r.props[dateProp.id] === d).map((r) => <Link key={r.id} to={`/p/${r.id}`} className="cal-chip">{r.title || "Untitled"}</Link>)}
          </div>
        ))}
      </div>
    </div>
  );
}
