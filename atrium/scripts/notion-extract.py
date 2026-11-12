#!/usr/bin/env python3
"""Collects raw Notion connector results from a Claude Code session into import-data/raw/.

During the import session, pages were read through the Notion connector. The connector's
replies are kept verbatim in the session transcript (and, for very large replies, in
tool-results/). This script copies them out, one JSON file per call, so the importer can
work from exact copies rather than anything retyped.

Usage: python3 -I scripts/notion-extract.py <session.jsonl> <tool-results-dir> <out-dir>
"""
import hashlib
import json
import os
import re
import sys

transcript, big_dir, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)

calls = {}      # tool_use id -> (tool name, input)
results = {}    # tool_use id -> text
for line in open(transcript, encoding="utf-8"):
    try:
        rec = json.loads(line)
    except ValueError:
        continue
    msg = rec.get("message") or {}
    content = msg.get("content")
    if not isinstance(content, list):
        continue
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "tool_use" and str(block.get("name", "")).startswith("mcp__Notion__"):
            calls[block["id"]] = (block["name"].replace("mcp__Notion__notion-", ""), block.get("input") or {})
        elif block.get("type") == "tool_result" and block.get("tool_use_id") in calls:
            c = block.get("content")
            text = c if isinstance(c, str) else "".join(p.get("text", "") for p in c if isinstance(p, dict))
            results[block["tool_use_id"]] = text

saved = re.compile(r"(?:Output has been saved to|Full output saved to:?)\s+(\S+\.(?:txt|json))")


def read_saved(path):
    """A saved result is either the raw text or a JSON list of {type: text, text} parts."""
    body = open(path, encoding="utf-8").read()
    if path.endswith(".json"):
        try:
            parts = json.loads(body)
            if isinstance(parts, list):
                return "".join(p.get("text", "") for p in parts if isinstance(p, dict))
        except ValueError:
            pass
    return body


n = 0
for tid, (tool, inp) in calls.items():
    text = results.get(tid)
    if text is None:
        continue
    m = saved.search(text[:600])
    if m:
        path = os.path.join(big_dir, os.path.basename(m.group(1)))
        if not os.path.exists(path):
            print("missing large result", path, file=sys.stderr)
            continue
        text = read_saved(path)
    if text.startswith("Error"):
        continue
    key = hashlib.sha1(json.dumps([tool, inp], sort_keys=True).encode()).hexdigest()[:12]
    with open(os.path.join(out, f"{tool}-{key}.json"), "w", encoding="utf-8") as f:
        json.dump({"tool": tool, "input": inp, "result": text}, f, ensure_ascii=False)
    n += 1
print(f"{n} connector results written to {out}")
