-- Prep notes sent about 15 minutes before a calendar meeting. One row per person per meeting:
-- the unique key stops the same meeting being sent twice.
CREATE TABLE meeting_prep (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  title TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, event_key)
);
CREATE INDEX idx_meeting_prep_user ON meeting_prep(user_id, starts_at);
