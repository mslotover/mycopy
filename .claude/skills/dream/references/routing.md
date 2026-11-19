# What goes where

Every fact a dream finds goes to exactly one place, or nowhere. Decide with this page. When unsure between two places, choose the narrower one (project memory over global, global over vault) or hold it back for review.

## The test every fact must pass first

A fact is worth keeping only if all three are true:

1. **Learned, not looked up.** It came from experience in the chat: a correction, a trap, a decision, a working method, a confirmed preference. It is not something a future chat can read from the files, the code, the git history or a CLAUDE.md file.
2. **Still true.** The chat shows it as current. A fact the chat later proved wrong is a correction, not a new fact.
3. **Useful again.** A future chat on different work would act differently because of it.

Never save:

- Secrets: keys, tokens, passwords. Name the credential ("the Stripe key in ~/.zshrc") without its value.
- Task status or handoff notes: "stopped at step 3", "next, do X". These die when the task ends.
- The story of a session: "first we tried X, then Y". Write the lesson as a plain present-tense fact instead.
- Guesses Claude made that the chat never confirmed.
- Long copies of chat text. One short quote at most.

## Where each chat's lessons go

| The chat ran in | Personal facts | Rules for every chat (proposed only) |
|---|---|---|
| Claude Code | that project's `~/.claude/projects/<project>/memory/` (or the `memory_dir` set in config.json) | `~/.claude/CLAUDE.md` |
| Local Cowork, inside a Cowork project | that project's `.../local-agent-mode-sessions/<org>/<user>/spaces/<id>/memory/` | Cowork's own `.../<org>/<user>/memory/CLAUDE.md`, or `cowork-settings` (pasted by hand) if that file does not exist |
| Local Cowork, outside any project | the `cowork.memory_dir` folder from setup | the same Cowork target as the row above |
| Cloud Cowork (Cloud mode) | the Claude.ai memory | the project's own instruction files |

Cowork never loads `~/.claude/CLAUDE.md`, and Claude Code never loads Cowork's file. A rule both need gets one proposal for each file. The Claude.ai memory is a third store: it is neither file.

## 1. Personal memory (project level)

Folder: `~/.claude/projects/<project>/memory/`, or the `memory_dir` set in config.json. Index: `MEMORY.md` in that folder. Only this project's chats load it. Written directly, then shown for review.

Holds the four Claude Code memory types:

| Type | What | Example |
|---|---|---|
| user | Who the user is, their role, what they know | "Sam runs video prep for the marketing team" |
| feedback | A correction the user gave, or an approach they confirmed | "Plans go in a table and wait for approval" |
| project | A decision or constraint no file records | "The dashboard publishes to the team copy, not the old personal copy" |
| reference | Where outside information lives | "Fireflies holds the sales calls; use the other-owner recovery steps" |

Also: tool traps and their fixes, commands that worked after several failed tries, IDs and paths that took effort to find.

## 2. Global (`~/.claude/CLAUDE.md`)

Loads into every chat in every project. Proposed only, never written directly.

Holds rules that apply everywhere:

- Writing style rules and banned words.
- How the user wants to work with Claude in any project (plan format, approval rules, tone).
- Tool preferences that hold across projects.

Propose a global line only when one of these is true:

- The user said "always", "every time", "everywhere", "in every project", or the like.
- The same rule shows up in chats from two or more different projects.
- A project memory note already states it and it is clearly not about that project (the organizer reports these as `move_out`).

Keep each proposed line to one or two sentences. Check the current file first and never propose what it already says.

## 3. Team vault (only if the user set one up)

The vault's own instruction files: its root `AGENTS.md` or `CLAUDE.md`, or a folder's `CLAUDE.md`. Proposed only, never written directly.

Holds what the whole team needs:

- A rule for how agents should work in that vault ("sales notes route to Intelligence/meetings/").
- A correction to a vault rule that the chat proved wrong or out of date.
- A company fact or decision that every teammate's Claude should know, routed per the vault's own routing table.

Never put a personal preference in the vault. "Sam hates em dashes" is personal. "Every client email is reviewed before sending" is team.

If no vault is set up, skip this section entirely. Do not invent a vault target.

## Hold back instead of writing

Even in project memory, return a fact as `held` (shown for approval, not written) when:

- It contradicts something the user said more recently in another chat.
- It would delete or overwrite an existing memory, not just add to it.
- It is about a person (a teammate, a client) and not about how to work.
- The lessons in `preferences.md` say this kind of fact is doubtful.
- You are unsure it passes the three tests above.
