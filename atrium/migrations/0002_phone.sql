-- Using Atrium as a phone app: sign-in codes, push notifications, due-date reminders.

-- A six-digit code emailed with each sign-in link, for places a link can't reach
-- (an app on the home screen has its own storage, so a link opened in the browser
-- doesn't sign it in). One live code per address; five wrong tries retire it.
CREATE TABLE login_codes (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  code_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- One row per device that has asked for notifications.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX push_user ON push_subscriptions(user_id);

-- The day a task's "due today" reminder went out, so it is sent once.
ALTER TABLE tasks ADD COLUMN reminded_on TEXT;
