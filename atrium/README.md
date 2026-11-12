# Atrium

A private team workspace: pages and databases organised by business, a personal area for
each person, tasks, and meetings that are recorded, transcribed, summarised and turned into
tasks. It runs on Cloudflare (Workers, D1, R2, Workers AI) and uses Claude for summaries
and for answering questions about the workspace.

## What it does

- **Spaces and pages** – one space per business, a private area per person, pages with a
  block editor (headings, to-dos, tables, callouts, images, @mentions, `/` commands),
  version history, templates, comments, and per-page sharing including outside guests.
- **Databases** – custom properties with table, board, calendar and list views.
- **Tasks** – one list per person. Tick things off; hand tasks to others; see a space's tasks.
- **Meetings** – record in the browser. Audio is transcribed with Whisper, then Claude writes a
  summary, proposes action items with owners and due dates, and distils notes for the Brain.
  The organiser reviews and edits everything; nothing is sent until they approve. Sending
  emails the summary to participants and puts each action on its owner's task list.
- **Brain** – decisions, facts and know-how distilled from meetings, searchable alongside
  everything else.
- **Search and Ask AI** – full-text search, and a chat panel that answers from the workspace
  with links to sources. Both only ever show what the person asking is allowed to see.

## Layout

| Path | What |
| --- | --- |
| `src/worker/` | API (Hono on Workers): auth, pages, tasks, meetings, AI, search |
| `src/web/` | React single-page app |
| `migrations/` | D1 schema |
| `scripts/api-test.mjs` | End-to-end API checks, including access rules |
| `scripts/seed-demo.mjs` | Fictional sample content for local use |
| `scripts/notion-import.mjs` | Builds SQL from an exported Notion workspace in `import-data/` |

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

Then open http://localhost:8787. In dev mode (`DEV_MODE=1`) emails are logged rather than
sent, the sign-in page shows the link directly, and the AI steps return sample output, so no
keys are needed. `node scripts/seed-demo.mjs` adds sample content; sign in as
`alex@example.com`.

## Deploy

1. Create the D1 database and R2 bucket, and put the database id in `wrangler.jsonc`.
2. `npm run db:remote`
3. Set secrets: `wrangler secret put ANTHROPIC_API_KEY`, `wrangler secret put RESEND_API_KEY`
   (and optionally `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` to turn on Google sign-in;
   the redirect URI is `https://<your-domain>/api/auth/google/callback`).
4. `npm run deploy`

People can sign in only if they have been invited; the first owner is created by the import
or by inserting a row into `users`.

## Bringing a Notion workspace across

The import runs from a Claude Code session that has the Notion connector, because that is
what can read the workspace. Three small scripts do the rest; everything they produce lands
in `import-data/`, which git ignores. **Never commit it: it is the workspace's private content.**

1. Read the workspace through the connector: people, teamspaces, every page, each database's
   rows, meeting notes with transcripts.
2. `python3 -I scripts/notion-extract.py <session.jsonl> <tool-results-dir> import-data/raw`
   copies the connector's replies out of the session, word for word.
3. `python3 -I scripts/notion-files.py <session.jsonl> <tool-results-dir> import-data/files`
   downloads images, videos and PDFs. Notion's download links last five minutes, so run it
   straight after asking for them.
4. `node scripts/notion-import.mjs import-data` writes `atrium-import.local.sql`,
   `load-files.sh` and `report.md`, which lists what came across and what did not.
5. Load it:

   ```bash
   npx wrangler d1 execute atrium --remote --file=import-data/atrium-import.local.sql
   ```

   ```bash
   sh import-data/load-files.sh --remote
   ```

   Use `--local -c wrangler.dev.jsonc` and `--local wrangler.dev.jsonc` to try it on the dev server first.

How things map: teamspaces become spaces; pages keep their place and their links to each
other; databases become database pages, except task lists (which become tasks) and meeting
notes and minutes (which become meetings, with summary, notes and transcript). Key decisions
recorded against minutes become Brain notes.

The importer never widens who can see something. Private pages, pages shared with
individuals, private meetings and tasks from private lists stay with the person who ran the
import, who can then share them from inside the app. Notion does not expose who belongs to
each teamspace, so space membership is worked out from who is given work, runs projects or
attends meetings there; check it under Settings, Spaces. `import-data/import-config.json`
(optional) maps a "Business" column value to a space when the names differ, and sets a
space's emoji and colour.

## Privacy

Workspace content lives only in the D1 database and R2 bucket. `import-data/` is ignored by
git and must stay that way: this repository is public.
