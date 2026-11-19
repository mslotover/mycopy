#!/usr/bin/env python3
"""Find Claude Code chats and slim them to plain text for a dream run.

Usage:
  chats.py where
      Say where this chat runs: "code" (Claude Code on a computer, with real
      project folders) or "cowork" (a Cowork sandbox, where /dream cannot
      read the chats). Used to pick the mode.

  chats.py list [--days N]
      Print every Claude Code project folder with its chat count, last use,
      real folder path and memory size, as JSON. Used by the setup talk.

  chats.py collect <run_dir> --config <config.json> [--since ISO] [--max-group-kb N]
      Find chats in the configured scope that changed since the last run,
      slim each one to text (secrets removed), and write:
        <run_dir>/chats/<project-slug>/<chat-id>.txt
        <run_dir>/plan.json   (chat list, groups for the analyzers, totals)

Only reads ~/.claude/projects/. Never edits a chat file.
"""
import argparse
import glob
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone


def uopen(path, mode="r", **kw):
    """Open a text file as UTF-8 on every system. Windows would use cp1252."""
    return open(path, mode, encoding="utf-8", **kw)


# Print UTF-8 too, so a Windows console does not crash on a pound sign or dash.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

PROJECTS = os.path.expanduser("~/.claude/projects")
# Local Cowork chats: <org>/<user>/local_<id>/.claude/projects/<slug>/<session>.jsonl
COWORK = os.path.expanduser("~/Library/Application Support/Claude/local-agent-mode-sessions")

# A chat still being written to is skipped. It is picked up on the next run.
QUIET_MINUTES = 20

TOOL_RESULT_CHARS = 300
TOOL_INPUT_CHARS = 150
USER_TEXT_CHARS = 6000
ASSISTANT_TEXT_CHARS = 6000

SECRET_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"sk-(?:proj-)?[A-Za-z0-9_\-]{20,}"),
    re.compile(r"(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}"),
    re.compile(r"xox[abprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"AIza[0-9A-Za-z_\-]{30,}"),
    re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9_\-\.=]{20,}"),
    re.compile(r"(?i)((?:api[_-]?key|secret|token|password|passwd|pwd)[\"']?\s*[:=]\s*[\"']?)[^\s\"',}]{8,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
]
REMINDER = re.compile(r"<system-reminder>[\s\S]*?</system-reminder>")


def redact(text):
    n = 0
    for p in SECRET_PATTERNS:
        def sub(m):
            nonlocal n
            n += 1
            g = m.groups()
            return (g[0] if g else "") + "[SECRET REMOVED]"
        text = p.sub(sub, text)
    return text, n


def cut(text, limit):
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit] + f" [...{len(text) - limit} more chars]"


def block_text(b):
    if isinstance(b, str):
        return b
    if isinstance(b, dict):
        if b.get("type") == "text":
            return b.get("text", "")
        if isinstance(b.get("content"), (str, list)):
            return block_text(b["content"])
    if isinstance(b, list):
        return "\n".join(block_text(x) for x in b)
    return ""


def slim(path, since_ts=0):
    """Return (title, text, info) for one chat file.

    Only turns at or after since_ts are kept, so a long chat that was
    continued today gives only today's turns. Its first message is kept
    as context.
    """
    title, lines, cwd, first_user = "", [], "", ""
    n_user = n_asst = 0
    old_turns = 0
    for raw in uopen(path, errors="replace"):
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        t = d.get("type")
        if t == "custom-title" and d.get("customTitle"):
            title = d["customTitle"]
        if t not in ("user", "assistant") or d.get("isSidechain"):
            continue
        cwd = cwd or d.get("cwd", "")
        ts = (d.get("timestamp") or "")[:16].replace("T", " ")
        try:
            old = since_ts and datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00")).timestamp() < since_ts
        except (KeyError, ValueError, AttributeError):
            old = False
        content = (d.get("message") or {}).get("content")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content or ""}]
        for b in blocks:
            if not isinstance(b, dict):
                continue
            k = b.get("type")
            if t == "user" and k == "text":
                txt = REMINDER.sub("", b.get("text", "")).strip()
                if not txt:
                    continue
                if txt.startswith("Base directory for this skill:"):
                    if not old:
                        lines.append(f"[{ts}] SKILL LOADED: {txt.splitlines()[0][31:]}")
                    continue
                if old:
                    first_user = first_user or txt
                    old_turns += 1
                    continue
                first_user = first_user or txt
                n_user += 1
                lines.append(f"[{ts}] USER: {cut(txt, USER_TEXT_CHARS)}")
            elif old:
                continue
            elif t == "user" and k == "tool_result":
                res = block_text(b.get("content"))
                err = " (error)" if b.get("is_error") else ""
                lines.append(f"  RESULT{err}: {cut(REMINDER.sub('', res), TOOL_RESULT_CHARS)}")
            elif t == "assistant" and k == "text":
                txt = b.get("text", "").strip()
                if txt:
                    n_asst += 1
                    lines.append(f"[{ts}] CLAUDE: {cut(txt, ASSISTANT_TEXT_CHARS)}")
            elif t == "assistant" and k in ("tool_use", "server_tool_use"):
                inp = json.dumps(b.get("input", {}), ensure_ascii=False)
                lines.append(f"  TOOL {b.get('name')}: {cut(inp, TOOL_INPUT_CHARS)}")
    if old_turns:
        lines.insert(0, f"(This chat started earlier. {old_turns} older user turns were read in past runs and are left out. It began with: {cut(first_user, 400)})\n")
    text, n_secrets = redact("\n".join(lines))
    info = {"cwd": cwd, "user_turns": n_user, "claude_turns": n_asst,
            "secrets_removed": n_secrets, "first_user": first_user[:200]}
    return title, text, info


def project_path(slug_dir):
    """Real folder path for a project folder, read from its newest chat."""
    for f in sorted(glob.glob(os.path.join(slug_dir, "*.jsonl")), key=os.path.getmtime, reverse=True)[:3]:
        for raw in uopen(f, errors="replace"):
            if '"cwd"' in raw:
                try:
                    c = json.loads(raw).get("cwd")
                    if c:
                        return c
                except ValueError:
                    pass
    return ""


def memory_info(slug_dir):
    mdir = os.path.join(slug_dir, "memory")
    idx = os.path.join(mdir, "MEMORY.md")
    files = glob.glob(os.path.join(mdir, "*.md"))
    lines = sum(1 for _ in uopen(idx)) if os.path.exists(idx) else 0
    return {"memory_dir": mdir, "memory_files": len(files), "memory_index_lines": lines}


def cmd_list(days):
    cutoff = time.time() - days * 86400
    out = []
    for d in sorted(glob.glob(os.path.join(PROJECTS, "*/"))):
        chats = glob.glob(os.path.join(d, "*.jsonl"))
        if not chats:
            continue
        recent = [c for c in chats if os.path.getmtime(c) >= cutoff]
        last = max(os.path.getmtime(c) for c in chats)
        row = {"slug": os.path.basename(d.rstrip("/\\")), "path": project_path(d),
               "chats": len(chats), f"chats_last_{days}_days": len(recent),
               "last_used": datetime.fromtimestamp(last).strftime("%Y-%m-%d")}
        row.update(memory_info(d))
        out.append(row)
    out.sort(key=lambda r: r["last_used"], reverse=True)
    out.append(cowork_row(days))  # always last; never a project choice
    print(json.dumps(out, indent=2))


def cowork_chats():
    """Main chat files of local Cowork sessions. Not subagents/ or audit.jsonl."""
    pat = os.path.join(COWORK, "*", "*", "local_*", ".claude", "projects", "*", "*.jsonl")
    return [f for f in glob.glob(pat) if os.path.basename(f) != "audit.jsonl"]


def cowork_meta(f):
    """The session's local_<id>.json, next to its folder."""
    sess = f.split(os.sep + ".claude" + os.sep)[0]
    try:
        return json.load(uopen(sess + ".json"))
    except (OSError, ValueError):
        return {}


def cowork_title(f):
    return cowork_meta(f).get("title", "")


def cowork_account(f):
    """<org>/<user> folder that holds this chat's session."""
    return f.split(os.sep + "local_")[0]


def cowork_spaces(account):
    """{space id: name} from the account's spaces.json."""
    try:
        data = json.load(uopen(os.path.join(account, "spaces.json")))
    except (OSError, ValueError):
        return {}
    return {s["id"]: s.get("name", "") for s in data.get("spaces", []) if isinstance(s, dict) and s.get("id")}


def cowork_space(f):
    """(space id, name, memory folder) for a chat in a Cowork project, else None.

    Local Cowork keeps one memory folder per project ("space"):
    <org>/<user>/spaces/<space id>/memory/, with MEMORY.md and topic files in
    the same shape as Claude Code project memory.
    """
    sid = cowork_meta(f).get("spaceId")
    if not sid:
        return None
    account = cowork_account(f)
    name = cowork_spaces(account).get(sid, "")
    if not name:  # the same project can be listed under another account only
        for other in glob.glob(os.path.join(COWORK, "*", "*")):
            name = cowork_spaces(other).get(sid, "")
            if name:
                break
    return sid, name, os.path.join(account, "spaces", sid, "memory")


COWORK_SETTINGS = "cowork-settings"


def cowork_global(f):
    """Where a Cowork-wide rule goes. Older Cowork accounts keep their global
    instructions in <org>/<user>/memory/CLAUDE.md and copy it into each chat.
    Cowork never loads ~/.claude/CLAUDE.md. Without that file, the rule is
    shown for the user to paste into Cowork's settings by hand."""
    path = os.path.join(cowork_account(f), "memory", "CLAUDE.md")
    return path if os.path.exists(path) else COWORK_SETTINGS


def cowork_slug(name, sid, account):
    """One slug per memory folder. The same project id can sit under two
    accounts, each with its own folder, so the account goes in the slug."""
    clean = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-") or "project"
    org = os.path.basename(os.path.dirname(account))[:4]
    return f"cowork-{clean}-{sid[:8]}-{org}"


def cowork_row(days):
    files = cowork_chats()
    cutoff = time.time() - days * 86400
    spaces = {}
    no_space = 0
    for f in files:
        if os.path.getmtime(f) < cutoff:
            continue
        sp = cowork_space(f)
        if not sp:
            no_space += 1
            continue
        sid, name, mdir = sp
        row = spaces.setdefault(sid, {"name": name or sid[:8], "memory_dir": mdir, f"chats_last_{days}_days": 0})
        row[f"chats_last_{days}_days"] += 1
    for row in spaces.values():
        idx = os.path.join(row["memory_dir"], "MEMORY.md")
        row["memory_index_lines"] = sum(1 for _ in uopen(idx)) if os.path.exists(idx) else 0
    return {"source": "cowork", "slug": "(cowork)", "path": COWORK, "chats": len(files),
            f"chats_last_{days}_days": sum(1 for f in files if os.path.getmtime(f) >= cutoff),
            "last_used": datetime.fromtimestamp(max(map(os.path.getmtime, files))).strftime("%Y-%m-%d") if files else "",
            "spaces": sorted(spaces.values(), key=lambda r: -r[f"chats_last_{days}_days"]),
            "chats_outside_projects": no_space,
            "note": "Local Cowork chats. Not a project. Opt in with config cowork.enabled. "
                    "Chats in a Cowork project go to that project's memory; the rest go to cowork.memory_dir."}


def cmd_where():
    """code: Claude Code on a computer. cowork: a Cowork sandbox (local or cloud)."""
    real = [d for d in glob.glob(os.path.join(PROJECTS, "*/"))
            if not os.path.basename(d.rstrip("/\\")).startswith("-sessions-") and glob.glob(os.path.join(d, "*.jsonl"))]
    cwd = os.getcwd()
    # Both Cowork sandboxes run Linux, and cloud Cowork may keep its own chat
    # under ~/.claude/projects. So only a Mac or Windows counts as Claude Code.
    desktop = sys.platform in ("darwin", "win32")
    if real and desktop and not cwd.startswith("/sessions/"):
        print(json.dumps({"where": "code", "projects": len(real)}))
    else:
        print(json.dumps({"where": "cowork", "cwd": cwd,
                          "note": "No Claude Code project chats here. Local Cowork: run /dream in the Code tab. "
                                  "Cloud Cowork: use Cloud mode."}))


def is_dream_chat(info):
    """Skip the dream's own run chats so it never dreams about dreaming."""
    first = info.get("first_user", "").lower().lstrip()
    # Typed "/dream", a slash command (stored as <command-message>dream or
    # <command-name>/dream), or the scheduled task (<scheduled-task name="dream").
    return (first.startswith("/dream") or "dream run" in first[:80]
            or "<command-message>dream</command-message>" in first[:200]
            or "<command-name>/dream" in first[:300]
            or first.startswith('<scheduled-task name="dream"'))


def group_row(slug, c, files, size, chats):
    """One analyzer group. It lists the local Cowork chats in it, and the
    Cowork global rules file their global rules go to."""
    g = {"slug": slug, "memory_dir": c["memory_dir"], "chats": files, "kb": round(size, 1)}
    cw = [x for x in chats if x["file"] in files and x["source"] == "cowork"]
    if cw:
        g["cowork_chats"] = [x["id"] for x in cw]
        g["cowork_global_file"] = cw[0]["cowork_global_file"]
    return g


def same_path(p):
    """A path in one form, so two spellings of one folder compare equal."""
    return os.path.normcase(os.path.abspath(os.path.expanduser(p)))


def memory_dir_for(cfg, slug):
    """The memory folder for one Claude Code project.

    Default: ~/.claude/projects/<slug>/memory, where Claude Code keeps it.
    A project in config.json can set its own "memory_dir". A top-level
    "memory_dir" sends every project to one folder, for people who moved
    or merged their memory somewhere else.
    """
    for p in cfg.get("projects", []):
        if p.get("slug") == slug and p.get("memory_dir"):
            return os.path.abspath(os.path.expanduser(p["memory_dir"]))
    if cfg.get("memory_dir"):
        return os.path.abspath(os.path.expanduser(cfg["memory_dir"]))
    return os.path.join(PROJECTS, slug, "memory")


def owner_slug(slug, mdir):
    """One slug per memory folder, so one organizer owns each folder, even
    when several projects write to the same custom folder."""
    if same_path(mdir) == same_path(os.path.join(PROJECTS, slug, "memory")):
        return slug
    clean = re.sub(r"[^A-Za-z0-9]+", "-", mdir).strip("-")[-60:].strip("-")
    return "custom-" + (clean or "memory")


def cmd_collect(run_dir, config_path, since, max_group_kb):
    cfg = json.load(uopen(config_path))
    if cfg.get("scope") == "all":
        slugs = [os.path.basename(d.rstrip("/\\")) for d in glob.glob(os.path.join(PROJECTS, "*/"))]
    else:
        slugs = [p["slug"] for p in cfg.get("projects", [])]
    if since:
        since_ts = datetime.fromisoformat(since).timestamp()
    elif cfg.get("last_run"):
        since_ts = datetime.fromisoformat(cfg["last_run"]).timestamp()
    else:
        since_ts = time.time() - int(cfg.get("first_run_days", 7)) * 86400
    quiet_ts = time.time() - QUIET_MINUTES * 60

    pending_ts = {}
    for k, v in (cfg.get("pending") or {}).items():
        try:
            pending_ts[k] = datetime.fromisoformat(v).timestamp()
        except (TypeError, ValueError):
            pass
    new_pending = {}

    sources = [(f, owner_slug(slug, mdir), mdir, "code")
               for slug in slugs for mdir in [memory_dir_for(cfg, slug)]
               for f in glob.glob(os.path.join(PROJECTS, slug, "*.jsonl"))]
    cw = cfg.get("cowork") or {}
    if cw.get("enabled"):
        # A chat in a Cowork project ("space") goes to that project's own
        # memory folder. A chat outside any project goes to the picked folder
        # (default: the first project in scope). When that folder belongs to
        # a Claude Code project, those chats join its slug, so one organizer
        # owns the folder.
        fallback = os.path.expanduser(cw.get("memory_dir") or (memory_dir_for(cfg, slugs[0]) if slugs else ""))
        fslug = "cowork"
        if fallback:
            fallback = os.path.abspath(fallback)
            owners = {same_path(memory_dir_for(cfg, x)): owner_slug(x, memory_dir_for(cfg, x)) for x in slugs}
            parent = os.path.basename(os.path.dirname(fallback))
            if same_path(fallback) in owners:
                fslug = owners[same_path(fallback)]
            elif same_path(os.path.dirname(os.path.dirname(fallback))) == same_path(PROJECTS):
                fslug = parent
        for f in cowork_chats():
            sp = cowork_space(f)
            if sp:
                sid, name, mdir = sp
                sources.append((f, cowork_slug(name, sid, cowork_account(f)), mdir, "cowork"))
            elif fallback:
                sources.append((f, fslug, fallback, "cowork"))

    chats, skipped = [], {"still_open": 0, "dream_runs": 0, "empty": 0}
    for f, slug, mdir, source in sources:
        m = os.path.getmtime(f)
        cid = os.path.basename(f)[:-6]
        # A chat skipped as open on an earlier run keeps that run's start.
        chat_since = min(since_ts, pending_ts.get(cid, since_ts))
        if m < chat_since:
            continue
        if m > quiet_ts:
            skipped["still_open"] += 1
            new_pending[cid] = datetime.fromtimestamp(chat_since, timezone.utc).isoformat(timespec="seconds")
            continue
        title, text, info = slim(f, chat_since)
        if source == "cowork":
            title = title or cowork_title(f)
        if info["user_turns"] == 0:
            skipped["empty"] += 1
            continue
        if is_dream_chat(info):
            skipped["dream_runs"] += 1
            continue
        out = os.path.join(run_dir, "chats", slug, cid + ".txt")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        src = "Claude Code"
        if source == "cowork":
            sp = cowork_space(f)
            src = f"local Cowork, project {sp[1] or sp[0][:8]}" if sp else "local Cowork, no project"
        header = f"CHAT {cid}\nSOURCE {src}\nTITLE {title or '(none)'}\nFOLDER {info['cwd']}\nLAST CHANGED {datetime.fromtimestamp(m).strftime('%Y-%m-%d %H:%M')}\n\n"
        with uopen(out, "w") as fh:
            fh.write(header + text)
        row = {"id": cid, "slug": slug, "title": title, "folder": info["cwd"],
               "file": out, "kb": round(os.path.getsize(out) / 1024, 1),
               "secrets_removed": info["secrets_removed"],
               "memory_dir": mdir, "source": source}
        if source == "cowork":
            row["cowork_global_file"] = cowork_global(f)
            sp = cowork_space(f)
            row["cowork_project"] = (sp[1] or sp[0][:8]) if sp else ""
        chats.append(row)

    # Groups: chats from one project together, each group under max_group_kb.
    # One analyzer per group. A chat bigger than the cap gets a group of its own.
    groups = []
    for slug in sorted({c["slug"] for c in chats}):
        cur, size = [], 0
        for c in sorted((c for c in chats if c["slug"] == slug), key=lambda c: -c["kb"]):
            if cur and size + c["kb"] > max_group_kb:
                groups.append(group_row(slug, c, cur, size, chats))
                cur, size = [], 0
            cur.append(c["file"])
            size += c["kb"]
        if cur:
            groups.append(group_row(slug, c, cur, size, chats))

    plan = {
        "run_dir": os.path.abspath(run_dir),
        "since": datetime.fromtimestamp(since_ts, timezone.utc).isoformat(timespec="minutes"),
        "chats": chats,
        "groups": groups,
        "projects": sorted({c["slug"] for c in chats}),
        "totals": {"chats": len(chats), "kb": round(sum(c["kb"] for c in chats), 1),
                   "groups": len(groups), "secrets_removed": sum(c["secrets_removed"] for c in chats),
                   "cowork_chats": sum(1 for c in chats if c["source"] == "cowork")},
        "skipped": skipped,
        "pending": new_pending,
    }
    with uopen(os.path.join(run_dir, "plan.json"), "w") as fh:
        json.dump(plan, fh, indent=2)
    # Remember chats left open, so the next run reads them from this run's
    # start even after last_run moves on. Only the "pending" key changes.
    cfg_now = json.load(uopen(config_path))
    cfg_now["pending"] = new_pending
    with uopen(config_path, "w") as fh:
        json.dump(cfg_now, fh, indent=2)
    print(json.dumps({"totals": plan["totals"], "skipped": skipped, "projects": plan["projects"],
                      "plan": os.path.join(run_dir, "plan.json")}, indent=2))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("where")
    l = sub.add_parser("list")
    l.add_argument("--days", type=int, default=30)
    c = sub.add_parser("collect")
    c.add_argument("run_dir")
    c.add_argument("--config", required=True)
    c.add_argument("--since")
    c.add_argument("--max-group-kb", type=float, default=400)
    a = ap.parse_args()
    if a.cmd == "where":
        cmd_where()
    elif a.cmd == "list":
        cmd_list(a.days)
    else:
        os.makedirs(a.run_dir, exist_ok=True)
        cmd_collect(a.run_dir, a.config, a.since, a.max_group_kb)


if __name__ == "__main__":
    main()
