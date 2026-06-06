-- Rebuild tasks table to expand action_type CHECK: adds REMINDER for unclassified tasks.
-- SQLite cannot ALTER a CHECK constraint, so we recreate the table.
PRAGMA foreign_keys=OFF;

CREATE TABLE tasks_rebuild (
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
  updated_at            INTEGER NOT NULL,
  origin_list           TEXT,
  completed_at          INTEGER,
  sort_order            INTEGER,
  priority              TEXT NOT NULL DEFAULT 'normal',
  user_id               TEXT REFERENCES users(id),
  action_type           TEXT CHECK (action_type IN ('EMAIL', 'CLAUDE_CODE', 'CALENDAR', 'REMINDER'))
);

INSERT INTO tasks_rebuild SELECT * FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_rebuild RENAME TO tasks;

PRAGMA foreign_keys=ON;
UPDATE _meta SET value = '17' WHERE key = 'schema_version';
