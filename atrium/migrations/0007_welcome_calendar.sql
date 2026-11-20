-- Welcome tour: when each person finished (or skipped) it. Calendar: their private iCal address
-- from Google Calendar, used to prepare for meetings. It is a secret and never sent back to the browser.
ALTER TABLE users ADD COLUMN onboarded_at INTEGER;
ALTER TABLE users ADD COLUMN calendar_url TEXT;
