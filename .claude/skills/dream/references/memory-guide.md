# The ideal MEMORY.md

Claude Code loads only the first 200 lines or 25 KB of `MEMORY.md` into each chat, whichever comes first. Everything past that is gone at session start. Topic files load only when Claude opens them. So `MEMORY.md` is a map, not a store. The organizer keeps it in this shape on every run.

## Shape

```markdown
# Memory

## How <user> works
- [Plans come first](plans-first.md): show a short plan table and wait for approval before big changes

## Tools and traps
- [CRM export traps](crm-export-traps.md): the API caps pages at 100 rows; dates come back in UTC

## Where things live
- [Sales dashboard](sales-dashboard.md): publishes to the team copy, not the old personal copy
```

## Rules

1. **150 lines at most.** That leaves room under the 200-line cap. Over 150, merge close memories into one topic file with one index line.
2. **One line per memory.** Format: `- [Title](file.md): hook`. No blank lines inside a group. No duplicate lines.
3. **The hook states the fact.** It is a complete phrase under about 150 characters that a reader could act on without opening the file. Never cut off mid-sentence. "Routines can update artifacts if Artifact is loaded" beats "Routines CAN update artifacts if Artifact is".
4. **Group under 4 to 8 `##` headings** by what the memory helps with (how the user works, tools and traps, where things live, a project or product name). Pick headings that fit this project. Keep the same headings from run to run unless a group outgrows them.
5. **Most-used groups first.** Behavior rules and corrections go near the top, so they survive if the file is ever cut.
6. **No rules that belong elsewhere.** A rule that applies to every project goes to `~/.claude/CLAUDE.md`. A team rule goes to the vault. The organizer lists these as `move_out` and keeps them until the user approves the move.
7. **No docs.** A memory that only repeats what a skill's SKILL.md, a README or a CLAUDE.md file says is removed from the index, with its file kept and linked from the topic file that needs it, or listed as `move_out` if a file should own it.

## Topic files

Each topic file:

```markdown
---
name: <slug, same as the file name without .md>
description: <one line, the same fact as the index hook>
metadata:
  type: user | feedback | project | reference
---

<The fact as a plain present-tense statement.>

**Why:** <what happened that taught it, with the date>
**How to apply:** <what to do next time>

History: <date> <old version>, replaced because <reason>
```

- Keep any extra frontmatter fields already there (for example `originSessionId`, `modified`).
- Date verified facts: "verified 2026-11-09".
- A replaced fact keeps one `History:` line. Do not silently delete it.
- Link related memories with `[[slug]]`.
- One topic per file. Two files on the same topic get merged into the better-named one. The other becomes a stub: `MOVED TO [[slug]]`.
