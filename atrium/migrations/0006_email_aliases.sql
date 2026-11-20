-- Extra sign-in addresses for one person (e.g. someone who works across two businesses).
-- Signing in with any of them opens the same account. Rows are added by an admin, never in code.
CREATE TABLE user_emails (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_user_emails_user ON user_emails(user_id);
