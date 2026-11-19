#!/usr/bin/env python3
"""Build the morning review page for one dream run.

Usage: python3 build_page.py <run_dir> [--sample]

Reads  <run_dir>/plan.json      (chats read, from chats.py collect)
       <run_dir>/result.json    (what the dream workflow returned)
       <run_dir>/run.json       (model, effort, scope, times; written by the skill)
       the memory folders, diffed against <run_dir>/backup/ (the real changes,
       not what the agents said they did)
Writes <run_dir>/page/index.html, <run_dir>/page/state.json, <run_dir>/log.md

Row actions carry an "apply" object the apply step follows:
  none | revert | rewrite | write_memory | edit_file | move
"""
import difflib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import memstate  # noqa: E402


def uopen(path, mode="r", **kw):
    """Open a text file as UTF-8 on every system. Windows would use cp1252."""
    return open(path, mode, encoding="utf-8", **kw)


# Print UTF-8 too, so a Windows console does not crash on a pound sign or dash.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

BANNED = [("—", "em dash"), ("–", "en dash")]
BANNED_WORD = re.compile(r"\bship(s|ped|ping)?\b", re.I)
DIFF_LINES = 40


def where_label(target, global_file):
    """Short, plain name for where a rule goes."""
    if target == "cowork-settings":
        return "Cowork settings (you paste it in)"
    if "local-agent-mode-sessions" in target:
        return "Cowork global rules"
    if global_file and target == global_file:
        return "Claude Code global rules"
    return target.replace(os.path.expanduser("~"), "~")


def load(run, name, default):
    p = os.path.join(run, name)
    return json.load(uopen(p)) if os.path.exists(p) else default


def quiet_diff(run):
    """memstate.diff prints; capture its return value without the print."""
    import contextlib
    import io
    with contextlib.redirect_stdout(io.StringIO()):
        return memstate.diff(run)


def short(s, n=160):
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 3] + "..."


# ---------- plain words for people ----------
# The page is read by a person, not an agent. Notes are named by their title,
# never by file name, slug or [[link]]. Words like stub or organizer never show.

FM = re.compile(r"\A---\n.*?\n---\n?", re.S)
LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+\.md)\)")
WIKI = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")
STUB = re.compile(r"MOVED TO \[\[([^\]|#]+)", re.I)
FILES_OK = ("CLAUDE.md", "AGENTS.md")


def split_fm(text):
    """(frontmatter dict of simple keys, body) of a memory file."""
    if not text:
        return {}, ""
    m = FM.match(text)
    if not m:
        return {}, text
    fm = {}
    for line in m.group(0).splitlines():
        k, sep, v = line.partition(":")
        if sep and not line.startswith((" ", "-")):
            fm[k.strip()] = v.strip().strip('"').strip("'")
    return fm, text[m.end():]


def humanize(stem):
    s = re.sub(r"[-_]+", " ", stem).strip()
    return s[:1].upper() + s[1:]


class Notes:
    """Titles and text of one memory folder, now and before the run."""

    def __init__(self, live, bak):
        self.live, self.bak, self.titles = live, bak, {}
        for d in (bak, live):  # the live index wins
            for m in LINK.finditer(memstate.read(os.path.join(d or "", "MEMORY.md")) or ""):
                self.titles[os.path.basename(m.group(2))] = m.group(1).strip()

    def text(self, name, before=False):
        return memstate.read(os.path.join(self.bak if before else self.live, name))

    def title(self, name):
        name = name if name.endswith(".md") else name + ".md"
        if name == "MEMORY.md":
            return "your list of notes"
        if name in self.titles:
            return self.titles[name]
        for before in (False, True):
            fm, body = split_fm(self.text(name, before))
            h1 = re.search(r"^# (.+)$", body, re.M)
            if h1:
                return h1.group(1).strip()
        return humanize(name[:-3])


def plain(text, notes):
    """Agent text made readable: titles for file names, no tool words."""
    s = str(text or "")
    s = re.sub(r"^\s*Organizer:\s*", "", s)
    s = re.sub(r"\s*\((analyzer|organizer) content untouched\)", "", s, flags=re.I)
    s = STUB.sub(lambda m: "moved to '" + notes.title(m.group(1)) + "'", s)
    s = WIKI.sub(lambda m: "'" + notes.title(m.group(1)) + "'", s)
    s = re.sub(r"(?<![\w/~.])([\w.-]+\.md)\b",
               lambda m: m.group(1) if m.group(1) in FILES_OK else "'" + notes.title(m.group(1)) + "'", s)
    for name in sorted(notes.titles, key=len, reverse=True):
        stem = name[:-3]
        if len(stem) > 8 and "-" in stem:
            s = re.sub(r"(?<![\w'-])" + re.escape(stem) + r"(?![\w-])", "'" + notes.titles[name] + "'", s)
    s = re.sub(r"\bstubs\b", "pointer notes", s, flags=re.I)
    s = re.sub(r"\bstub\b", "pointer note", s, flags=re.I)
    s = re.sub(r"\bfrontmatter\b", "header", s, flags=re.I)
    s = re.sub(r"\borganizers?\b", "clean-up step", s, flags=re.I)
    s = re.sub(r"\banalyzers?\b", "chat reader", s, flags=re.I)
    s = re.sub(r"\bMOVED TO\b", "moved to", s)
    return " ".join(s.split())


def sentence(s):
    s = " ".join(str(s or "").split()).rstrip()
    if not s:
        return ""
    s = s[:1].upper() + s[1:]
    return s if s[-1] in ".!?" else s + "."


def listing(titles, n=5):
    titles = ["'" + t + "'" for t in titles]
    if len(titles) > n:
        return ", ".join(titles[:n]) + f" and {len(titles) - n} more"
    return ", ".join(titles[:-1]) + (" and " if len(titles) > 1 else "") + titles[-1] if titles else ""


def norm(line):
    return re.sub(r"^[\s>*-]*(\d+\.\s+)?", "", line).strip().lower()


def before_after(notes, name, cap):
    """Only the lines that changed, header noise and blank lines taken out."""
    a, b = notes.text(name, True), notes.text(name)
    fa, ba = split_fm(a)
    fb, bb = split_fm(b)
    rows = list(difflib.unified_diff(ba.splitlines(), bb.splitlines(), n=0, lineterm=""))
    before = [l[1:] for l in rows if l.startswith("-") and not l.startswith("---") and l[1:].strip()]
    after = [l[1:] for l in rows if l.startswith("+") and not l.startswith("+++") and l[1:].strip()]
    da, db = fa.get("description", ""), fb.get("description", "")
    if da != db and a is not None and b is not None:
        before.insert(0, "Summary line: " + da)
        after.insert(0, "Summary line: " + db)
    cut = lambda xs: xs[:cap] + ([f"... and {len(xs) - cap} more lines"] if len(xs) > cap else [])
    return {"before": cut(before) if a is not None else [], "after": cut(after) if b is not None else [],
            "before_label": "Before" if a is not None else "Before (this note did not exist)",
            "after_label": "After" if b is not None else "After (this note is gone)"}


def chat_title(chats, ref):
    """Titles for an agent's chat field, which may hold several short ids."""
    out = []
    for tok in re.findall(r"[0-9a-f]{6,}(?:-[0-9a-f-]+)?", str(ref or "")):
        c = next((c for cid, c in chats.items() if cid.startswith(tok)), None)
        if c and c.get("title"):
            out.append("'" + short(c["title"], 60) + "'")
    return ", ".join(dict.fromkeys(out))


def explain(d, notes, chats, agent_notes, stub_of, moved_global):
    """One plain sentence on what changed and one on why."""
    name, status = d["file"], d["status"]
    title = notes.title(name)
    pl = [x for x in agent_notes if x.get("plain")]
    if pl:  # new runs: the agents wrote it for a person already
        what = " ".join(sentence(plain(x["plain"].get("what"), notes)) for x in pl)
        why = " ".join(dict.fromkeys(sentence(plain(x["plain"].get("why"), notes)) for x in pl))
        return what, why

    live, old = notes.text(name), notes.text(name, True)
    if name == "MEMORY.md":
        now = [os.path.basename(m.group(2)) for m in LINK.finditer(live or "")]
        was = [os.path.basename(m.group(2)) for m in LINK.finditer(old or "")]
        heads = len(re.findall(r"^#{2,3} ", live or "", re.M))
        added = [notes.title(x) for x in dict.fromkeys(now) if x not in was]
        gone = [notes.title(x) for x in dict.fromkeys(was) if x not in now]
        what = f"Rewrote your list of notes. It now lists {len(set(now))} notes under {heads} headings (it listed {len(set(was))})."
        if added:
            what += f" Added {listing(added)}."
        if gone:
            what += f" Took off {listing(gone)}, because they were merged into other notes or moved out."
        return what, "So each note shows up once, in a group that fits, with one full line about it."

    stub = STUB.search(live or "")
    if status == "changed" and stub:
        target = stub.group(1).strip() + ".md"
        tt = notes.title(target)
        tgt_text = (notes.text(target) or "").lower()
        _, old_body = split_fm(old)
        facts = [norm(l) for l in old_body.splitlines() if norm(l) and not l.lstrip().startswith("#")]
        lost = [f for f in facts if f not in tgt_text]
        what = f"Merged into the note '{tt}'. This note now only points there."
        why = "Both notes covered the same topic. " + (
            "No facts were lost." if not lost else
            f"Check it: {len(lost)} of its lines are not word for word in '{tt}'. Open the exact lines to compare.")
        return what, why

    what, why = [], []
    merged_in = [notes.title(s) for s, t in stub_of.items() if t == name]
    if merged_in:
        what.append(f"Took in the facts from {listing(merged_in)}.")
        why.append("Those notes covered the same topic, so now there is one note.")
    if status == "added":
        fm, _ = split_fm(live)
        what.insert(0, f"New note: '{title}'." + (" " + sentence(fm["description"]) if fm.get("description") else ""))
    if status == "removed":
        what.insert(0, "Taken out of your project memory.")
        why.append("It is a rule for every project, so it moved to your global file." if name in moved_global
                   else "Open the exact lines to see what it held.")
    for x in agent_notes:
        src, summ = x.get("source"), plain(x.get("summary"), notes)
        if src == "organizer" and (re.match(r"(?i)(now a )?pointer note|merged ", summ) or merged_in):
            continue  # already said above in plainer words
        if src == "organizer" and re.match(r"(?i)description updated", summ):
            what.append("Updated its one-line summary.")
            continue
        kind = x.get("kind")
        lead = {"corrected": "Fixed a wrong fact: ", "created": "", "updated": "Added new facts: "}.get(kind, "")
        what.append(sentence(lead + summ) if summ else "")
        ct = chat_title(chats, x.get("chat"))
        if ct:
            why.append(f"You worked on this in the chat {ct}.")
    if not [w for w in what if w]:
        what.append(f"Added {d['added']} lines and took out {d['removed']} lines.")
    if not why:
        why.append("The dream left no note on why. Open the exact lines to check." if not agent_notes
                   else "It keeps the note tidy and up to date.")
    return " ".join(w for w in what if w), " ".join(dict.fromkeys(why))


def build(run, sample=False):
    plan = load(run, "plan.json", {"chats": [], "totals": {}, "skipped": {}})
    res = load(run, "result.json", {"projects": [], "proposals": {"global": [], "vault": [], "dropped": []}, "moves": []})
    info = load(run, "run.json", {})
    chats = {c["id"]: c for c in plan.get("chats", [])}
    folder_of = {}
    for c in plan.get("chats", []):
        folder_of[c["memory_dir"]] = c["folder"]
    bak_of = memstate.load_map(run)

    def proj(memory_dir):
        f = folder_of.get(os.path.abspath(memory_dir), "") or folder_of.get(memory_dir, "")
        return os.path.basename(f.rstrip("/\\")) if f else os.path.basename(os.path.dirname(memory_dir))

    note_cache = {}

    def notes_of(memory_dir):
        k = os.path.abspath(memory_dir or "")
        if k not in note_cache:
            note_cache[k] = Notes(k, bak_of.get(k, ""))
        return note_cache[k]

    def chat_label(cid):
        return chat_title(chats, cid).replace("'", "") or ("an earlier chat" if cid else "")

    # What the agents said, keyed by (memory_dir, file)
    said = {}
    for p in res.get("projects", []):
        md = os.path.abspath(p["memory_dir"])
        for r in p.get("analyzed", []):
            for ch in r.get("changes", []):
                said.setdefault((md, os.path.basename(ch["file"])), []).append({**ch, "source": "analyzer"})
        for ch in (p.get("organized") or {}).get("changes", []):
            said.setdefault((md, os.path.basename(ch["file"])), []).append({**ch, "source": "organizer"})

    props = res.get("proposals", {})
    moved_global = {os.path.basename(g["memory_file"]) for g in props.get("global", []) if g.get("memory_file")}
    parts = []
    changed = quiet_diff(run)

    # 1. Memory changes (already written; review, revert or rewrite)
    rows = []
    for i, d in enumerate(changed):
        notes = notes_of(d["memory_dir"])
        stub_of = {}
        for e in changed:
            if e["memory_dir"] == d["memory_dir"]:
                m = STUB.search(notes.text(e["file"]) or "")
                if m and e["status"] == "changed":
                    stub_of[e["file"]] = m.group(1).strip() + ".md"
        what, why = explain(d, notes, chats, said.get((os.path.abspath(d["memory_dir"]), d["file"]), []), stub_of, moved_global)
        cap = 400 if d["file"] == "MEMORY.md" else DIFF_LINES  # the index rewrite needs a full review
        name = notes.title(d["file"])
        rows.append({
            "id": f"mem-{i}", "mode": "approve", "folder": proj(d["memory_dir"]),
            "cells": [name[:1].upper() + name[1:] if d["file"] == "MEMORY.md" else name, what, why],
            "lines": before_after(notes, d["file"], cap),
            "actions": [
                {"label": "Keep", "apply": {"kind": "none"}},
                {"label": "Revert", "apply": {"kind": "revert", "memory_dir": d["memory_dir"], "file": d["file"]}},
                {"label": "Change it (comment)", "apply": {"kind": "rewrite", "memory_dir": d["memory_dir"], "file": d["file"]}},
            ],
            "default": 0,
        })
    parts.append({"part": "memory", "title": "Notes changed",
                  "summary": "These changes are already saved in your project memory. Keep them, revert them, or write a comment to change them. Rows you do not tick stay as they are.",
                  "tables": [{"id": "t-mem", "title": "What changed and why",
                              "note": "Open \"Show exact lines\" under a note to see its text before and after.",
                              "columns": ["Note", "What changed", "Why"], "rows": rows}]})

    # 2. Held back (not written; approve to add)
    rows = []
    for p in res.get("projects", []):
        notes = notes_of(p["memory_dir"])
        for r in p.get("analyzed", []):
            for h in r.get("held", []):
                rows.append({
                    "id": f"held-{len(rows)}", "mode": "approve", "folder": proj(p["memory_dir"]),
                    "cells": [sentence(plain(h["title"], notes)), sentence(plain(h["text"], notes)),
                              sentence(plain(h["why_unsure"], notes)), chat_label(h.get("chat"))],
                    "actions": [
                        {"label": "Add to memory", "apply": {"kind": "write_memory", "memory_dir": p["memory_dir"], "title": h["title"], "text": h["text"], "type": h.get("type", "")}},
                        {"label": "Skip", "apply": {"kind": "none"}},
                    ],
                    "default": 0,
                })
    parts.append({"part": "held", "title": "Held back",
                  "summary": "The dream was not sure about these, so it saved nothing. Tick one to add it, or skip it and say why in a comment.",
                  "tables": [{"id": "t-held", "title": "Waiting for you", "columns": ["Note", "What it would save", "Why it waited", "From chat"], "rows": rows}]})

    # 3. Global and 4. vault proposals
    any_notes = notes_of(res["projects"][0]["memory_dir"]) if res.get("projects") else Notes("", "")
    for key, title, summary in (
        ("global", "Global rules", "Rules that would load into every chat in every project, from your global file {f}. Nothing is added until you tick it."),
        ("vault", "Team vault", "Rules the whole team's Claude would follow. Nothing is added until you tick it."),
    ):
        rows = []
        # Local Cowork chats add a second global file (Cowork never loads the
        # Claude Code one), so the table then says where each rule goes.
        multi_global = any(g.get("target_file") != info.get("global_file") for g in props.get("global", []))
        for j, g in enumerate(props.get(key, [])):
            is_move = bool(g.get("memory_file"))
            add = {"kind": "move" if is_move else "edit_file", "target_file": g["target_file"], "text": g["text"]}
            mv = {}
            if is_move:
                mv = next((m for m in res.get("moves", []) if os.path.basename(m["memory_file"]) == os.path.basename(g["memory_file"])), {})
                add.update({"memory_file": os.path.basename(g["memory_file"]), "memory_dir": mv.get("memory_dir", "")})
            notes = notes_of(mv.get("memory_dir")) if mv.get("memory_dir") else any_notes
            why = sentence(plain(g["why"], notes))
            if is_move:
                why = f"The note '{notes.title(g['memory_file'])}' becomes this rule and leaves your project memory. " + why
            cells = [plain(g["text"], notes), why, ", ".join(chat_label(c) for c in (g.get("chats") or [])[:3])]
            if key == "vault" or (key == "global" and multi_global):
                cells.insert(1, where_label(g["target_file"], info.get("global_file")))
            rows.append({
                "id": f"{key}-{j}", "mode": "approve", "cells": cells,
                "actions": [{"label": "Move it" if is_move else "Add", "apply": add}, {"label": "Skip", "apply": {"kind": "none"}}],
                "default": 0,
            })
        if key == "vault" and not info.get("vault"):
            continue
        if key == "global" and not info.get("global_file"):
            continue
        cols = ["Rule to add", "Why", "From chats"] if key == "global" and not multi_global else ["Rule to add", "Where it goes", "Why", "From chats"]
        gf = (info.get("global_file") or "~/.claude/CLAUDE.md").replace(os.path.expanduser("~"), "~")
        if key == "global" and multi_global:
            summary = "Rules that would load into every chat. Claude Code rules go to {f}; local Cowork rules go to Cowork's own global rules. Nothing is added until you tick it."
        parts.append({"part": key, "title": title, "summary": summary.format(f=gf),
                      "tables": [{"id": f"t-{key}", "title": "Suggested rules", "columns": cols, "rows": rows}]})

    # 5. Left out (teaches the dream what you do want)
    rows = []
    for p in res.get("projects", []):
        notes = notes_of(p["memory_dir"])
        for r in p.get("analyzed", []):
            for n in r.get("not_saved", []):
                rows.append({
                    "id": f"out-{len(rows)}", "mode": "approve", "folder": proj(p["memory_dir"]),
                    "cells": [sentence(plain(n["text"], notes)), sentence(plain(n["reason"], notes)), chat_label(n.get("chat"))],
                    "actions": [
                        {"label": "Leave out", "apply": {"kind": "none"}},
                        {"label": "Save it", "apply": {"kind": "write_memory", "memory_dir": p["memory_dir"], "title": short(n["text"], 60), "text": n["text"], "type": ""}},
                    ],
                    "default": 0,
                })
    for d in props.get("dropped", []):
        rows.append({"id": f"out-{len(rows)}", "mode": "info",
                     "cells": [sentence(plain(d["text"], any_notes)), "Not suggested as a rule: " + sentence(plain(d["reason"], any_notes)), ""]})
    parts.append({"part": "notsaved", "title": "Left out",
                  "summary": "Things the dream chose not to save. Pick Save it if it got one wrong, and add a comment so it learns.",
                  "tables": [{"id": "t-out", "title": "Not saved", "columns": ["What", "Why it was left out", "From chat"], "rows": rows}]})

    # 6. The run itself (info)
    t = plan.get("totals", {})
    sk = plan.get("skipped", {})
    idx = [f'now {p["organized"]["index_lines"]} lines' for p in res.get("projects", []) if p.get("organized")]
    problems = [(p, x) for p in res.get("projects", []) if p.get("organized") for x in p["organized"].get("problems", [])]
    stats = [
        {"label": "Chats read", "value": str(t.get("chats", 0))},
        {"label": "Text read", "value": f'{round(t.get("kb", 0) / 1024, 1)} MB'},
        {"label": "Chat batches read side by side", "value": str(t.get("groups", 0))},
        {"label": "Secrets taken out before reading", "value": str(t.get("secrets_removed", 0))},
        {"label": "Chats still open, read next time", "value": str(sk.get("still_open", 0))},
        {"label": "Model", "value": f'{info.get("model", "sonnet")}, {info.get("effort", "medium")} effort'},
        {"label": "Run time", "value": info.get("duration", "unknown")},
        {"label": "Chat batches that failed", "value": str(res.get("failed_groups", 0))},
    ] + [{"label": "List of notes", "value": x} for x in idx]
    chat_rows = [{"id": f"chat-{k}", "mode": "info", "folder": os.path.basename(c["folder"].rstrip("/\\")),
                  "cells": [short(c["title"] or c["id"], 80), os.path.basename(c["folder"].rstrip("/\\")), f'{c["kb"]} KB']}
                 for k, c in enumerate(sorted(plan.get("chats", []), key=lambda c: -c["kb"]))]
    run_tables = [{"id": "t-chats", "title": "Chats read", "columns": ["Chat", "Project", "Size"], "rows": chat_rows}]
    if problems:
        run_tables.insert(0, {"id": "t-prob", "title": "Things to check by hand", "columns": ["What to check"],
                              "rows": [{"id": f"prob-{i}", "mode": "info", "cells": [sentence(plain(x, notes_of(p["memory_dir"])))]}
                                       for i, (p, x) in enumerate(problems)]})
    parts.append({"part": "run", "title": "The run", "summary": f'Chats changed since {plan.get("since", "the last run")[:16].replace("T", " ")} UTC.',
                  "stats": stats, "tables": run_tables})

    return parts, plan, info, changed


def secret_scan(changed):
    """Flag any written line that looks like a secret. The skill reverts that file."""
    from chats import SECRET_PATTERNS
    hits = []
    for d in changed:
        for line in d["diff"]:
            if line.startswith("+") and any(p.search(line) for p in SECRET_PATTERNS):
                hits.append(f"SECRET? {d['memory_dir']}/{d['file']}: revert this file before publishing")
                break
    return hits


def check(parts):
    problems, seen = [], set()
    for p in parts:
        for t in p["tables"]:
            for r in t["rows"]:
                if r["id"] in seen:
                    problems.append(f"duplicate row id {r['id']}")
                seen.add(r["id"])
                if len(r["cells"]) != len(t["columns"]):
                    problems.append(f"{r['id']}: {len(r['cells'])} cells for {len(t['columns'])} columns")
    # Memory diff lines are the real file text; only agent-written text is checked.
    text = json.dumps(_readable(_without_diffs(parts)[0]), ensure_ascii=False)
    for ch, name in BANNED:
        if ch in text:
            problems.append(f"{text.count(ch)} x {name} (replaced with commas)")
    # A quoted word or a file name only names the word (a rule that bans it), so skip those.
    named = re.sub(r'\\"[^"\\]{0,30}\\"|[\u201c\'][^\u201d\']{0,30}[\u201d\']|[\w\-]+\.md', "", text)
    if BANNED_WORD.search(named):
        problems.append("banned word s-h-i-p found in agent text")
    # The page is for a person: no file names, links or tool words outside the exact lines.
    for pat, what in ((r"(?<!CLAUDE)(?<!AGENTS)\.md\b", "a file name"), (r"\[\[", "a [[link]]"),
                      (r"(?i)\bstubs?\b", "the word stub"), (r"(?i)\borganizer", "the word organizer"),
                      (r"(?i)frontmatter", "the word frontmatter"), (r"MOVED TO", "MOVED TO")):
        n = len(re.findall(pat, text))
        if n:
            problems.append(f"plain words: {n} x {what} in the page text")
    return problems


def _readable(parts):
    """Only the text a person reads on the page (no apply objects)."""
    out = []
    for p in parts:
        out += [p["title"], p.get("summary", "")] + [s["label"] + " " + s["value"] for s in p.get("stats", [])]
        for t in p["tables"]:
            out += [t["title"], t.get("note", "")] + t["columns"]
            for r in t["rows"]:
                out += [str(c) for c in r["cells"]] + [a["label"] for a in r.get("actions", [])]
    return out


def _without_diffs(parts):
    """Copy of parts with memory diff lines taken out, plus those lines by row id."""
    parts = json.loads(json.dumps(parts, ensure_ascii=False))
    kept = {}
    for p in parts:
        if p["part"] != "memory":
            continue
        for t in p["tables"]:
            for r in t["rows"]:
                if "lines" in r:
                    kept[r["id"]] = r.pop("lines")
    return parts, kept


def clean(parts):
    """Replace dashes in agent text. Memory diffs stay exactly as the files are."""
    parts, kept = _without_diffs(parts)
    raw = json.dumps(parts, ensure_ascii=False)
    raw = raw.replace(" — ", ", ").replace("—", ", ").replace("–", "-")
    parts = json.loads(raw)
    for p in parts:
        for t in p["tables"]:
            for r in t["rows"]:
                if r["id"] in kept:
                    r["lines"] = kept[r["id"]]
    return parts


def inline(obj):
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/")


def write_log(run, parts, plan, info, changed):
    n = {p["part"]: sum(len(t["rows"]) for t in p["tables"]) for p in parts}
    lines = [f"# Dream run {os.path.basename(run)}", "",
             f"- Chats read: {plan.get('totals', {}).get('chats', 0)}",
             f"- Memory files changed: {len(changed)}",
             f"- Held back: {n.get('held', 0)}",
             f"- Global proposals: {n.get('global', 0)}",
             f"- Vault proposals: {n.get('vault', 0)}",
             f"- Left out: {n.get('notsaved', 0)}",
             f"- Model: {info.get('model', 'sonnet')}, {info.get('effort', 'medium')} effort",
             f"- Page: {info.get('page_url', 'not published yet')}", "",
             "## Memory changes", ""]
    for d in changed:
        lines.append(f"- {d['file']} ({d['status']}, +{d['added']} -{d['removed']})")
    lines += ["", "## Review", "", "(Filled in after you approve.)", ""]
    uopen(os.path.join(run, "log.md"), "w").write("\n".join(lines))


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    run = os.path.abspath(sys.argv[1])
    sample = "--sample" in sys.argv
    parts, plan, info, changed = build(run, sample)
    problems = secret_scan(changed) + check(parts)
    parts = clean(parts)
    n_approve = sum(1 for p in parts for t in p["tables"] for r in t["rows"] if r["mode"] == "approve")
    n_rows = sum(len(t["rows"]) for p in parts for t in p["tables"])
    folders = sorted({r.get("folder") for p in parts for t in p["tables"] for r in t["rows"] if r.get("folder")})
    n = {p["part"]: sum(len(t["rows"]) for t in p["tables"]) for p in parts}
    notes_changed = sum(1 for d in changed if d["file"] != "MEMORY.md")
    say = [f"Read {plan.get('totals', {}).get('chats', 0)} chats.",
           f"Changed {notes_changed} note{'s' if notes_changed != 1 else ''}" + (" and your list of notes." if any(d["file"] == "MEMORY.md" for d in changed) else ".")]
    if n.get("held"):
        say.append(f"{n['held']} held back for you to decide.")
    if n.get("global"):
        say.append(f"{n['global']} rule{'s' if n['global'] != 1 else ''} suggested for your global file.")
    if n.get("vault"):
        say.append(f"{n['vault']} rule{'s' if n['vault'] != 1 else ''} suggested for the team vault.")
    say.append(f"{n_approve} items to review.")
    meta = {"run": os.path.basename(run), "sample": sample, "folders": folders, "savings": 0, "savings_est": False,
            "changed": len(changed), "subtitle": " ".join(say)}
    state = {"status": "draft", "ticks": {}, "comments": {}, "report": []}
    tpl = uopen(os.path.join(HERE, "..", "assets", "page.html")).read()
    logo = uopen(os.path.join(HERE, "..", "assets", "logo.svg")).read()
    tpl = tpl.replace("<title>Dream report</title>", f"<title>Dream report {os.path.basename(run)}</title>", 1)
    html = (tpl.replace("__LOGO__", logo).replace("__FINDINGS__", inline(parts))
               .replace("__META__", inline(meta)).replace("__STATE__", inline(state)))
    out = os.path.join(run, "page")
    os.makedirs(out, exist_ok=True)
    uopen(os.path.join(out, "index.html"), "w").write(html)
    json.dump(state, uopen(os.path.join(out, "state.json"), "w"), indent=2)
    json.dump(parts, uopen(os.path.join(run, "findings.json"), "w"), indent=2, ensure_ascii=False)
    write_log(run, parts, plan, info, changed)
    print(f"page: {os.path.join(out, 'index.html')}")
    print(f"rows: {n_rows}  to review: {n_approve}  memory files changed: {len(changed)}")
    for p in problems:
        print("check:", p)


if __name__ == "__main__":
    main()
