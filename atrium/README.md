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

## Privacy

Workspace content lives only in the D1 database and R2 bucket. `import-data/` is ignored by
git and must stay that way: this repository is public.
