-- Personal add-only access keys: let a person's own automation (for example a scheduled Claude task)
-- add tasks to their list. Only a hash of each key is kept; the key itself is shown once.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
-- Which key created a task, so a runaway automation can be limited.
ALTER TABLE tasks ADD COLUMN via_key TEXT;
