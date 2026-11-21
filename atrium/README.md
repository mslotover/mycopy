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
- **Search and Ask AI** – search by keyword and by meaning (so "cold storage" finds the
  walk-in fridge page), and a chat panel that answers from the workspace with links to
  sources. Both only ever show what the person asking is allowed to see. The ✨ button on a
  page or meeting opens Ask AI about that item.
- **Business figures** – Ask AI can query the group's BigQuery history (tills, labour,
  bookings, wholesale, supplier bills) through the Toklas data connector, a separate Worker
  reached by service binding (`DATA`, shared key `ATRIUM_DATA_KEY`). The connector applies
  its own rules about who sees what. Guests never get these tools.
- **Changes from Ask AI** – Ask AI can propose tasks, a page or a database row
  (`src/worker/actions.ts`). The panel shows a card; only on Confirm does the browser call
  the normal APIs, under the person's own permissions.
- **Morning brief** – a daily email (`src/worker/brief.ts`) to the addresses in the
  `BRIEF_RECIPIENTS` secret: yesterday's trading against the same day last week, bookings,
  wholesale, best sellers, then tasks due, new meeting actions and overdue items.
- **Spending** – every Claude call is logged with an estimated cost (`ai_usage`), and each
  Monday a summary by person and feature goes to the `REPORT_TO` secret's address.

## Layout

| Path | What |
| --- | --- |
| `src/worker/` | API (Hono on Workers): auth, pages, tasks, meetings, AI, search |
| `src/web/` | React single-page app |
| `migrations/` | D1 schema |
| `scripts/api-test.mjs` | End-to-end API checks, including access rules (accounts in `tests/fixture.sql`) |
| `scripts/seed-demo.mjs` | Fictional sample content for local use |

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

1. Create the D1 database and R2 bucket, and put the database id in `wrangler.jsonc`. Create
   the search index: `wrangler vectorize create atrium-search --dimensions=1024 --metric=cosine`.
   A five-minute cron embeds new and changed items into it (`src/worker/vectors.ts`).
2. `npm run db:remote`
3. Set secrets: `wrangler secret put ANTHROPIC_API_KEY`, `wrangler secret put RESEND_API_KEY`
   (and optionally `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` to turn on Google sign-in;
   the redirect URI is `https://<your-domain>/api/auth/google/callback`).
4. `npm run deploy`

Scheduled work runs from one five-minute timer (the Workers free plan allows five timers per
account): search embedding every run, the morning brief at 07:35 UTC, due-today reminders at
08:00 and the spending email on Mondays at 09:00 (`scheduled` in `src/worker/index.ts`).
One-off jobs can be queued as rows in `app_flags` (e.g. `brief_preview`).

Optional secrets: `ATRIUM_DATA_KEY` (business figures), `BRIEF_RECIPIENTS`, `REPORT_TO`,
`ANTHROPIC_ADMIN_KEY` (adds the Console's figure to the spending email; needs a team
organisation). Addresses are secrets, not vars, because this repository is public.

People can sign in only if they have been invited; the first owner is created by the import
or by inserting a row into `users`.

## Signing in, and the welcome tour

People sign in with Google (the main button once `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set) or, for guests, an emailed link. One person can have extra sign-in addresses in the `user_emails` table; add them with SQL, never in code.
Business figures from the data connector are limited by email domain (see that repo's `businesses.ts`).

The first time someone signs in, a seven-step tour shows what Atrium does and offers to connect their Google Calendar by pasting its secret iCal address. It is replayable from Settings, Profile. The address is stored in `users.calendar_url`, accepted only from `calendar.google.com`, and never sent back to the browser.

## Recording a video call

The recorder listens to the microphone. On a call with headphones, the other people never
reach it, so the recording screen offers "On a call? Add its audio": the browser asks which
tab to share, and that tab's sound is mixed with the microphone. It needs a desktop
Chromium browser (Chrome, Edge, Arc, Brave) and the call running in a browser tab. If
sharing is stopped, recording carries on with the microphone alone.

## On a phone

Atrium installs from the browser; there is nothing in an app store. On an iPhone, open it
in Safari, tap Share, then "Add to Home Screen". It then opens full-screen on the task list.

- **Signing in.** An app on the Home Screen keeps its own storage, so a sign-in link opened
  in the browser doesn't sign it in. Every sign-in email therefore carries a six-digit code
  as well, to type into the app.
- **Notifications.** Turn them on from the prompt on the task list or under Settings,
  Profile. They cover being given a task, mentions, meeting summaries, and a morning
  reminder of what is due that day (a cron trigger, 08:00 UTC). iPhones only offer
  notifications to web apps that have been added to the Home Screen.
- **Patchy connections.** A service worker keeps the app opening offline with the task
  lists as last seen. Ticking a task off without a connection is held on the device and
  sent when the connection returns.

Notifications use Web Push. Generate a key pair once, put the public half in
`VAPID_PUBLIC_KEY` (wrangler.jsonc) and the private half in the `VAPID_PRIVATE_KEY`
secret. `scripts/push-test.mjs` checks the encryption against the example in RFC 8291.

## Slack

Optional. A task assigned to someone also reaches them as a Slack message, and a message shortcut,
"Add to Atrium", turns one chosen Slack message into a task. Atrium never reads Slack on its own.

1. At api.slack.com/apps choose Create New App, From a manifest, and paste `slack-app-manifest.json`.
2. Install it to the workspace. Copy the Bot User OAuth Token and, from Basic Information, the Signing Secret.
3. Add both as Worker secrets: `npx wrangler secret put SLACK_BOT_TOKEN` and `npx wrangler secret put SLACK_SIGNING_SECRET`.

People are matched to Slack by email address. Without the secrets, all of this is skipped.

## Access keys (add-only)

In Settings, Profile, a person can make a key that lets their own automation add tasks to their list,
for example a scheduled Claude task that reads their inbox. A key can do one thing, and nothing else:

    POST /api/inbound/tasks
    Authorization: Bearer atk_…
    {"title": "Reply to the supplier", "notes": "optional", "due": "2026-12-01", "source_url": "link or id of the email"}

`source_url` stops the same email or message becoming a task twice. A key is limited to 100 tasks a day.
Only a hash of each key is stored, so a lost key can't be looked up: remove it and make another.

## Where the content came from

The team's Notion workspace was brought across once, in November 2026, and Atrium no longer
talks to Notion. The one-off import scripts were removed afterwards; they are still in this
repository's history (the commit before "Remove the Notion import scripts"). Imported pages
keep a link back to their original, which stops working if the Notion workspace is closed.

## Privacy

Workspace content lives only in the D1 database and R2 bucket. `import-data/` is ignored by
git and must stay that way: this repository is public.
