#!/usr/bin/env python3
"""Downloads Notion-hosted files (images, videos, PDFs) into import-data/files/.

Signed download links from the Notion connector last five minutes, so run this straight
after asking the connector for them. It reads the links from the session transcript and
saves each file under the id of the Notion block it belongs to.

Usage: python3 -I scripts/notion-files.py <session.jsonl> <tool-results-dir> <out-dir>
"""
import json
import os
import re
import subprocess
import sys

transcript, big_dir, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
want = {}


def add(ref, url):
    m = re.match(r"notion-file-block://([0-9a-f-]+)/[^?]+\?.*?name=(.+)$", ref or "")
    if m and isinstance(url, str) and url.startswith("https://"):
        want[m.group(1)] = (re.sub(r"[^\w.\-]+", "_", m.group(2)), url.split("#")[0])


def walk(node):
    """Finds reference -> signed URL pairs wherever the connector put them."""
    if isinstance(node, list):
        for item in node:
            walk(item)
    elif isinstance(node, dict):
        if isinstance(node.get("reference"), str) and "url" in node:
            add(node["reference"], node["url"])
        for key, value in node.items():
            if isinstance(key, str) and key.startswith("notion-file-block://"):
                add(key, value.get("url") if isinstance(value, dict) else value)
            walk(value)
            if key == "text" and isinstance(value, str) and value.lstrip().startswith(("{", "[")):
                collect(value)


def collect(text):
    try:
        walk(json.loads(text))
    except ValueError:
        pass


for name in os.listdir(big_dir) if os.path.isdir(big_dir) else []:
    body = open(os.path.join(big_dir, name), encoding="utf-8", errors="replace").read()
    if "prod-files-secure" in body:
        collect(body)
for line in open(transcript, encoding="utf-8"):
    if "prod-files-secure" not in line and "notion-file-block" not in line:
        continue
    try:
        rec = json.loads(line)
    except ValueError:
        continue
    content = (rec.get("message") or {}).get("content")
    if not isinstance(content, list):
        continue
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_result":
            continue
        c = block.get("content")
        text = c if isinstance(c, str) else "".join(p.get("text", "") for p in c if isinstance(p, dict))
        collect(text)

ok = skipped = failed = 0
for block_id, (name, url) in want.items():
    dest = os.path.join(out, f"{block_id}__{name}")
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        skipped += 1
        continue
    r = subprocess.run(["curl", "-sS", "-f", "-L", "--max-time", "180", "-o", dest, url], capture_output=True, text=True)
    if r.returncode == 0 and os.path.getsize(dest) > 0:
        ok += 1
    else:
        failed += 1
        if os.path.exists(dest):
            os.remove(dest)
        print("failed", name, r.stderr.strip()[:160], file=sys.stderr)
print(f"{ok} downloaded, {skipped} already present, {failed} failed")
