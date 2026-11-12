-- Atrium schema

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0071e3',
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member','guest')),
  active INTEGER NOT NULL DEFAULT 1,
  source_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#0071e3',
  description TEXT NOT NULL DEFAULT '',
  sort REAL NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  source_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE space_members (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (space_id, user_id)
);

-- A page is a document, a database, a database row, or a template.
-- space_id NULL means the page lives in owner_id's private area.
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id),
  parent_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page','database','row')),
  title TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  content TEXT,
  text TEXT NOT NULL DEFAULT '',
  props TEXT,
  schema TEXT,
  sort REAL NOT NULL DEFAULT 0,
  is_template INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  source_url TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX pages_parent ON pages(parent_id);
CREATE INDEX pages_space ON pages(space_id);
CREATE INDEX pages_owner ON pages(owner_id);

CREATE TABLE page_shares (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'edit' CHECK (level IN ('view','comment','edit')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX shares_user ON page_shares(user_id);

CREATE TABLE page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX versions_page ON page_versions(page_id, created_at);

CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  organizer_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'recording'
    CHECK (status IN ('recording','processing','review','sent','failed')),
  started_at INTEGER NOT NULL,
  duration_s INTEGER NOT NULL DEFAULT 0,
  transcript TEXT NOT NULL DEFAULT '',
  summary_doc TEXT,
  summary_html TEXT NOT NULL DEFAULT '',
  error TEXT,
  sent_at INTEGER,
  source_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX meetings_org ON meetings(organizer_id);

CREATE TABLE meeting_participants (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  notify INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX mp_meeting ON meeting_participants(meeting_id);
CREATE INDEX mp_user ON meeting_participants(user_id);

CREATE TABLE meeting_segments (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'audio/webm',
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  text TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (meeting_id, idx)
);

-- Proposed outputs of a meeting, reviewed by the organiser before sending.
CREATE TABLE meeting_items (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('task','knowledge')),
  payload TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 1,
  sort REAL NOT NULL DEFAULT 0
);
CREATE INDEX mi_meeting ON meeting_items(meeting_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  creator_id TEXT NOT NULL REFERENCES users(id),
  space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  project TEXT NOT NULL DEFAULT '',
  due TEXT,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  needs_owner INTEGER NOT NULL DEFAULT 0,
  sort REAL NOT NULL DEFAULT 0,
  completed_at INTEGER,
  source_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX tasks_space ON tasks(space_id, status);
CREATE INDEX tasks_meeting ON tasks(meeting_id);

-- The second brain: durable notes distilled from meetings (or added by hand).
CREATE TABLE knowledge (
  id TEXT PRIMARY KEY,
  space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'fact',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX knowledge_space ON knowledge(space_id, created_at);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('page','task','meeting')),
  target_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX comments_target ON comments(target_kind, target_id, created_at);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX notif_user ON notifications(user_id, read, created_at);

-- Every email the app sends (or would send, in dev mode) is recorded here.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);

-- Full-text index over everything; maintained by the app on write.
CREATE VIRTUAL TABLE search USING fts5(
  title, body,
  kind UNINDEXED, ref UNINDEXED,
  tokenize = 'porter unicode61'
);
