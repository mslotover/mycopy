-- Several people can own one task. tasks.assignee_id stays as the first (main) owner; this table lists
-- every owner and when each ticked their part off. The task is done when all of them have.
CREATE TABLE task_assignees (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  done_at INTEGER,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX idx_task_assignees_user ON task_assignees(user_id);
INSERT INTO task_assignees (task_id, user_id, done_at)
  SELECT id, assignee_id, CASE WHEN status = 'done' THEN COALESCE(completed_at, updated_at) END FROM tasks WHERE assignee_id IS NOT NULL;
