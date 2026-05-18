-- Recreate tasks table to:
--   1. Make meeting_id nullable (supports standalone personal reminders with no meeting)
--   2. Add list_name column for sidebar list filtering

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS tasks_new (
  id                    TEXT PRIMARY KEY,
  meeting_id            TEXT REFERENCES meetings(id) ON DELETE CASCADE,
  assignee_speaker_id   TEXT REFERENCES speakers(id),
  title                 TEXT NOT NULL,
  deadline_text         TEXT,
  deadline_ms           INTEGER,
  remind_offset_ms      INTEGER DEFAULT -3600000,
  remind_at_ms          INTEGER,
  transcript_quote      TEXT,
  extraction_confidence TEXT,
  status                TEXT NOT NULL DEFAULT 'pending',
  note                  TEXT,
  list_name             TEXT NOT NULL DEFAULT 'Reminders',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

INSERT INTO tasks_new
  SELECT id, meeting_id, assignee_speaker_id, title, deadline_text, deadline_ms,
         remind_offset_ms, remind_at_ms, transcript_quote, extraction_confidence,
         status, note, 'Reminders', created_at, updated_at
  FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

PRAGMA foreign_keys = ON;

UPDATE _meta SET value = '3' WHERE key = 'schema_version';
