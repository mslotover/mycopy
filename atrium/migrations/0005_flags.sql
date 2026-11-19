-- One-off jobs for the five-minute timer to pick up (e.g. 'brief_preview': send the morning brief now).
CREATE TABLE app_flags (
  name TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
