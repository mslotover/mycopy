-- Ask AI conversations, saved per person so they can be reopened. Only the owner can read or delete them.
CREATE TABLE ask_chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ask_chats_user ON ask_chats(user_id, updated_at);
