-- One row per Claude API call, for the weekly spending email (see usage.ts).
CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,                 -- who caused it; null for background work
  feature TEXT NOT NULL,        -- 'ask' | 'meeting_summary'
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, -- estimated from list prices at the time
  created_at INTEGER NOT NULL
);
CREATE INDEX ai_usage_created ON ai_usage (created_at);
