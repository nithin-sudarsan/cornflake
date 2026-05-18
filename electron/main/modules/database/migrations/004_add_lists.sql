-- Custom user-created lists. Default lists (Reminders, To-do List, High Priority, Flagged)
-- are hardcoded in the UI and never stored here.

CREATE TABLE IF NOT EXISTS lists (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

UPDATE _meta SET value = '4' WHERE key = 'schema_version';
