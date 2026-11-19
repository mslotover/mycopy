#!/usr/bin/env python3
"""Back up memory folders before a dream, show what changed, and revert.

Usage:
  memstate.py save <run_dir> <memory_dir> [<memory_dir> ...]
      Copy each memory folder to <run_dir>/backup/<slug>/memory/.
      Creates an empty folder first if the project has no memory yet.
  memstate.py diff <run_dir>
      Print JSON: every file added, changed or removed since the backup,
      with a unified diff. Reads the real files, not what the agents said.
  memstate.py restore <run_dir> <memory_dir> <file.md>
      Put one file back the way it was before the run (deletes it if the
      run created it). Copies the current version to <run_dir>/reverted/ first.
  memstate.py backup-file <run_dir> <path>
      Copy any file (a CLAUDE.md, an AGENTS.md) to <run_dir>/backup/apply/
      before the apply step edits it.
"""
import difflib
import json
import os
import shutil
import sys


def uopen(path, mode="r", **kw):
    """Open a text file as UTF-8 on every system. Windows would use cp1252."""
    return open(path, mode, encoding="utf-8", **kw)


# Print UTF-8 too, so a Windows console does not crash on a pound sign or dash.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

MAP = "backup/map.json"


def slug_of(memory_dir):
    return os.path.basename(os.path.dirname(os.path.abspath(memory_dir)))


def load_map(run):
    p = os.path.join(run, MAP)
    return json.load(uopen(p)) if os.path.exists(p) else {}


def save(run, dirs):
    m = load_map(run)
    for d in dirs:
        d = os.path.abspath(os.path.expanduser(d))
        os.makedirs(d, exist_ok=True)
        # Two folders can share a parent name (one Cowork project under two
        # accounts), so a name another folder already holds gets a number.
        name, n = slug_of(d), 2
        taken = {v for k, v in m.items() if k != d}
        dst = os.path.join(run, "backup", name, "memory")
        while dst in taken:
            dst = os.path.join(run, "backup", f"{name}-{n}", "memory")
            n += 1
        if os.path.exists(dst):
            shutil.rmtree(dst)
        shutil.copytree(d, dst)
        m[d] = dst
        print(f"saved {d} -> {dst} ({len(os.listdir(dst))} files)")
    os.makedirs(os.path.join(run, "backup"), exist_ok=True)
    json.dump(m, uopen(os.path.join(run, MAP), "w"), indent=2)


def read(p):
    try:
        return uopen(p, errors="replace").read()
    except FileNotFoundError:
        return None


def diff(run):
    out = []
    for live, bak in load_map(run).items():
        names = set(os.listdir(live) if os.path.isdir(live) else []) | set(os.listdir(bak))
        for n in sorted(names):
            if not n.endswith(".md"):
                continue
            a, b = read(os.path.join(bak, n)), read(os.path.join(live, n))
            if a == b:
                continue
            status = "added" if a is None else "removed" if b is None else "changed"
            lines = list(difflib.unified_diff((a or "").splitlines(), (b or "").splitlines(), "before", "after", n=0, lineterm=""))
            body = [l for l in lines if l[:1] in "+-" and not l.startswith(("+++", "---"))]
            out.append({"memory_dir": live, "file": n, "status": status,
                        "added": sum(1 for l in body if l.startswith("+")),
                        "removed": sum(1 for l in body if l.startswith("-")),
                        "diff": body})
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return out


def restore(run, memory_dir, name):
    live = os.path.abspath(os.path.expanduser(memory_dir))
    bak = load_map(run).get(live)
    if not bak:
        sys.exit(f"no backup for {live}")
    src, dst = os.path.join(bak, name), os.path.join(live, name)
    keep = os.path.join(run, "reverted", os.path.basename(os.path.dirname(bak)))
    os.makedirs(keep, exist_ok=True)
    if os.path.exists(dst):
        shutil.copy2(dst, os.path.join(keep, name))
    if os.path.exists(src):
        shutil.copy2(src, dst)
        print(f"restored {dst}")
    elif os.path.exists(dst):
        os.remove(dst)
        print(f"removed {dst} (the run created it)")


def backup_file(run, path):
    path = os.path.abspath(os.path.expanduser(path))
    # Drop the drive ("C:") and the leading slash, or os.path.join would
    # return the real file itself on Windows and the backup would do nothing.
    drive, rest = os.path.splitdrive(path)
    dst = os.path.join(run, "backup", "apply", drive.replace(":", ""), rest.lstrip("/\\"))
    if os.path.abspath(dst) == path:
        sys.exit(f"backup path is the file itself: {path}")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(path) and not os.path.exists(dst):
        shutil.copy2(path, dst)
    print(f"backed up {path} -> {dst}")


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cmd, run = sys.argv[1], os.path.abspath(os.path.expanduser(sys.argv[2]))
    if cmd == "save":
        save(run, sys.argv[3:])
    elif cmd == "diff":
        diff(run)
    elif cmd == "restore" and len(sys.argv) == 5:
        restore(run, sys.argv[3], sys.argv[4])
    elif cmd == "backup-file" and len(sys.argv) == 4:
        backup_file(run, sys.argv[3])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
