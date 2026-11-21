-- Documents attached to tasks. The file itself lives in the FILES bucket under attachments/<id>.
CREATE TABLE task_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_task_attachments_task ON task_attachments(task_id);

-- Notes people send from the "Send feedback" button.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  message TEXT NOT NULL,
  page TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
