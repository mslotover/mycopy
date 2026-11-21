-- Each person's Slack member id, found by matching their email, so Atrium can message them.
ALTER TABLE users ADD COLUMN slack_id TEXT;
