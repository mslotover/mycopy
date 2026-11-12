import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { Extension, mergeAttributes, Node as TNode } from "@tiptap/react";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Mention } from "@tiptap/extension-mention";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { PluginKey } from "@tiptap/pm/state";
import { EditorContent, ReactRenderer, useEditor, useEditorState, type Editor as TEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { StarterKit } from "@tiptap/starter-kit";
import { Suggestion, type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import {
  Bold, Code, FilePlus, Heading1, Heading2, Heading3, Highlighter, ImageIcon, Italic, Lightbulb, Link2, List, ListChecks, ListOrdered, Minus, Quote,
  SquareCode, Strikethrough, Table2, Type, Underline as UnderlineIcon,
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, type User } from "./api";
import { Avatar, toastError } from "./ui";

/** A tinted box with an emoji, for notes that should stand out. */
const Callout = TNode.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return { emoji: { default: "💡", parseHTML: (el) => el.getAttribute("data-emoji") || "💡", renderHTML: (a) => ({ "data-emoji": a.emoji }) } };
  },
  parseHTML() {
    return [{ tag: "div[data-callout]", contentElement: (el: HTMLElement) => (el.querySelector(":scope > div") as HTMLElement) ?? el }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-callout": "" }), ["div", 0]];
  },
});

// ---------- Suggestion popups (slash commands and @mentions) ----------

type ListHandle = { onKeyDown: (e: KeyboardEvent) => boolean };
type SuggestItem = { key: string; title: string; sub?: string; icon: ReactNode };

const SuggestList = forwardRef<ListHandle, { items: SuggestItem[]; onPick: (i: SuggestItem) => void; slash?: boolean }>(({ items, onPick, slash }, ref) => {
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setSel(0), [items]);
  useEffect(() => { box.current?.querySelector(".hl")?.scrollIntoView({ block: "nearest" }); }, [sel]);
  useImperativeHandle(ref, () => ({
    onKeyDown: (e) => {
      if (!items.length) return false;
      if (e.key === "ArrowDown") { setSel((s) => (s + 1) % items.length); return true; }
      if (e.key === "ArrowUp") { setSel((s) => (s - 1 + items.length) % items.length); return true; }
      if (e.key === "Enter" || e.key === "Tab") { onPick(items[sel]); return true; }
      return false;
    },
  }));
  if (!items.length) return <div className="pop" style={{ position: "static" }}><div className="empty" style={{ padding: 12 }}>No matches</div></div>;
  return (
    <div className="pop" ref={box} style={{ position: "static", width: slash ? 280 : 240 }}>
      {items.map((it, i) => (
        <button key={it.key} className={`menu-item ${slash ? "slash-item" : ""} ${i === sel ? "hl" : ""}`} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); onPick(it); }}>
          {slash ? <span className="ic">{it.icon}</span> : it.icon}
          <span style={{ flex: 1, minWidth: 0 }}>
            {it.title}
            {it.sub && <span className="sub" style={{ display: "block" }}>{it.sub}</span>}
          </span>
        </button>
      ))}
    </div>
  );
});

function suggestionRender<T extends SuggestItem>(slash: boolean): SuggestionOptions<T>["render"] {
  return () => {
    let renderer: ReactRenderer<ListHandle> | null = null;
    let host: HTMLDivElement | null = null;
    const place = (props: SuggestionProps<T>) => {
      const rect = props.clientRect?.();
      if (!rect || !host) return;
      computePosition({ getBoundingClientRect: () => rect }, host, { strategy: "fixed", placement: "bottom-start", middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })] }).then(({ x, y }) => {
        if (host) { host.style.left = `${x}px`; host.style.top = `${y}px`; }
      });
    };
    return {
      onStart: (props) => {
        host = document.createElement("div");
        host.style.cssText = "position:fixed;z-index:70;left:-9999px;top:-9999px";
        document.body.appendChild(host);
        renderer = new ReactRenderer(SuggestList, { editor: props.editor, props: { items: props.items, slash, onPick: (i: T) => props.command(i) } });
        host.appendChild(renderer.element);
        place(props);
      },
      onUpdate: (props) => {
        renderer?.updateProps({ items: props.items, slash, onPick: (i: T) => props.command(i) });
        place(props);
      },
      onKeyDown: ({ event }) => {
        if (event.key === "Escape") { host?.remove(); host = null; return true; }
        return renderer?.ref?.onKeyDown(event) ?? false;
      },
      onExit: () => { renderer?.destroy(); host?.remove(); host = null; renderer = null; },
    };
  };
}

type SlashItem = SuggestItem & { run: (editor: TEditor) => void; words: string };

function slashItems(extras: { onSubpage?: () => void; pickImage: () => void }): SlashItem[] {
  const I = { size: 16, strokeWidth: 2 };
  const items: SlashItem[] = [
    { key: "text", title: "Text", sub: "Plain paragraph", words: "text paragraph plain", icon: <Type {...I} />, run: (e) => e.chain().focus().setParagraph().run() },
    { key: "h1", title: "Heading 1", sub: "Large section heading", words: "heading h1 title", icon: <Heading1 {...I} />, run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
    { key: "h2", title: "Heading 2", sub: "Medium heading", words: "heading h2 subtitle", icon: <Heading2 {...I} />, run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
    { key: "h3", title: "Heading 3", sub: "Small heading", words: "heading h3", icon: <Heading3 {...I} />, run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
    { key: "todo", title: "To-do list", sub: "Checkboxes you can tick off", words: "todo task check checkbox", icon: <ListChecks {...I} />, run: (e) => e.chain().focus().toggleTaskList().run() },
    { key: "ul", title: "Bulleted list", words: "bullet list unordered", icon: <List {...I} />, run: (e) => e.chain().focus().toggleBulletList().run() },
    { key: "ol", title: "Numbered list", words: "numbered list ordered", icon: <ListOrdered {...I} />, run: (e) => e.chain().focus().toggleOrderedList().run() },
    { key: "quote", title: "Quote", words: "quote blockquote", icon: <Quote {...I} />, run: (e) => e.chain().focus().toggleBlockquote().run() },
    { key: "callout", title: "Callout", sub: "A note that stands out", words: "callout note info box", icon: <Lightbulb {...I} />, run: (e) => e.chain().focus().wrapIn("callout").run() },
    { key: "divider", title: "Divider", words: "divider line rule hr", icon: <Minus {...I} />, run: (e) => e.chain().focus().setHorizontalRule().run() },
    { key: "table", title: "Table", words: "table grid", icon: <Table2 {...I} />, run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { key: "code", title: "Code block", words: "code snippet", icon: <SquareCode {...I} />, run: (e) => e.chain().focus().toggleCodeBlock().run() },
    { key: "image", title: "Image", sub: "Upload from your device", words: "image photo picture upload", icon: <ImageIcon {...I} />, run: () => extras.pickImage() },
  ];
  if (extras.onSubpage) items.push({ key: "page", title: "Page", sub: "A new page inside this one", words: "page subpage child", icon: <FilePlus {...I} />, run: () => extras.onSubpage!() });
  return items;
}

async function uploadImage(file: File): Promise<string> {
  const { url } = await api<{ url: string }>("/files", { raw: file });
  return url;
}

// ---------- Editor ----------

export function Editor({ content, editable = true, onChange, placeholder, compact, users, onSubpage, onReady }: {
  content: any; editable?: boolean; onChange?: (doc: any, html: string) => void; placeholder?: string; compact?: boolean;
  users: User[]; onSubpage?: () => void; onReady?: (e: TEditor) => void;
}) {
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const live = useRef({ onChange, onSubpage, users });
  live.current = { onChange, onSubpage, users };

  const editor = useEditor({
    editable,
    content: content && typeof content === "object" && "html" in content ? content.html : content ?? "",
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer" } } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Image,
      Highlight,
      Callout,
      Placeholder.configure({ placeholder: ({ node }) => (node.type.name === "heading" ? "Heading" : placeholder ?? "Write, or press / for commands") }),
      Mention.configure({
        HTMLAttributes: { class: "mention" },
        suggestion: {
          items: ({ query }): any[] =>
            live.current.users
              .filter((u) => u.active && u.name.toLowerCase().includes(query.toLowerCase()))
              .slice(0, 8)
              .map((u) => ({ key: u.id, id: u.id, label: u.name, title: u.name, icon: <Avatar user={u} size={20} /> })),
          render: suggestionRender<any>(false),
        },
      }),
      Extension.create({
        name: "slash",
        addProseMirrorPlugins() {
          return [
            Suggestion<SlashItem>({
              editor: this.editor,
              pluginKey: new PluginKey("slash"),
              char: "/",
              startOfLine: false,
              items: ({ query }) => {
                const q = query.toLowerCase();
                return slashItems({ onSubpage: live.current.onSubpage, pickImage: () => fileInput.current?.click() }).filter((i) => (i.title + " " + i.words).toLowerCase().includes(q));
              },
              command: ({ editor, range, props }) => {
                editor.chain().focus().deleteRange(range).run();
                props.run(editor as TEditor);
              },
              render: suggestionRender<SlashItem>(true),
            }),
          ];
        },
      }),
    ],
    editorProps: {
      attributes: { class: `prose ${compact ? "compact" : ""}`, spellcheck: "true" },
      handleDOMEvents: {
        click: (_view, event) => {
          const a = (event.target as HTMLElement).closest("a");
          const href = a?.getAttribute("href");
          if (!href) return false;
          event.preventDefault();
          // Links to other pages stay inside the app; everything else opens in a new tab.
          if (href.startsWith("/") && !href.startsWith("/api/")) navigate(href);
          else window.open(href, "_blank", "noopener,noreferrer");
          return true;
        },
      },
      handlePaste: (view, event) => {
        const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
        if (!file || !view.editable) return false;
        event.preventDefault();
        void insertImage(file);
        return true;
      },
      handleDrop: (view, event) => {
        const file = [...((event as DragEvent).dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
        if (!file || !view.editable) return false;
        event.preventDefault();
        void insertImage(file);
        return true;
      },
    },
    onUpdate: ({ editor }) => live.current.onChange?.(editor.getJSON(), editor.getHTML()),
  });

  const insertImage = async (file: File) => {
    try {
      const url = await uploadImage(file);
      editor?.chain().focus().setImage({ src: url }).run();
    } catch (e) {
      toastError(e);
    }
  };

  useEffect(() => { if (editor) onReady?.(editor); }, [editor]);
  useEffect(() => { editor?.setEditable(editable); }, [editor, editable]);

  if (!editor) return null;
  return (
    <>
      {editable && <Bubble editor={editor} />}
      <EditorContent editor={editor} />
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void insertImage(f); e.target.value = ""; }} />
    </>
  );
}

function Bubble({ editor }: { editor: TEditor }) {
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("");
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"), italic: e.isActive("italic"), underline: e.isActive("underline"), strike: e.isActive("strike"),
      code: e.isActive("code"), highlight: e.isActive("highlight"), link: e.isActive("link"), href: e.getAttributes("link").href as string | undefined,
    }),
  });
  const applyLink = () => {
    const v = url.trim();
    if (!v) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: /^(https?:|mailto:|\/)/i.test(v) ? v : `https://${v}` }).run();
    setLinking(false);
  };
  const B = ({ on, run, label, children }: { on: boolean; run: () => void; label: string; children: ReactNode }) => (
    <button className={`icon-btn ${on ? "on" : ""}`} aria-label={label} title={label} onMouseDown={(e) => { e.preventDefault(); run(); }}>{children}</button>
  );
  return (
    <BubbleMenu editor={editor} options={{ placement: "top", offset: 8 }} shouldShow={({ editor: e, state }) => !state.selection.empty && !e.isActive("codeBlock") && !e.isActive("image")}>
      <div className="bubble">
        {linking ? (
          <>
            <input className="pop-search" style={{ margin: 0, width: 230 }} autoFocus placeholder="Paste a link" value={url} onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } if (e.key === "Escape") setLinking(false); }} />
            <button className="btn plain" onMouseDown={(e) => { e.preventDefault(); applyLink(); }}>{url.trim() ? "Apply" : "Remove"}</button>
          </>
        ) : (
          <>
            <B on={s.bold} label="Bold" run={() => editor.chain().focus().toggleBold().run()}><Bold /></B>
            <B on={s.italic} label="Italic" run={() => editor.chain().focus().toggleItalic().run()}><Italic /></B>
            <B on={s.underline} label="Underline" run={() => editor.chain().focus().toggleUnderline().run()}><UnderlineIcon /></B>
            <B on={s.strike} label="Strikethrough" run={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></B>
            <B on={s.code} label="Code" run={() => editor.chain().focus().toggleCode().run()}><Code /></B>
            <B on={s.highlight} label="Highlight" run={() => editor.chain().focus().toggleHighlight().run()}><Highlighter /></B>
            <span className="sep" />
            <B on={s.link} label="Link" run={() => { setUrl(s.href ?? ""); setLinking(true); }}><Link2 /></B>
            <span className="sep" />
            <B on={false} label="Heading" run={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 /></B>
            <B on={false} label="To-do" run={() => editor.chain().focus().toggleTaskList().run()}><ListChecks /></B>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}
