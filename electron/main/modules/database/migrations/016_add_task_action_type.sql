-- Add action_type to tasks for action routing (EMAIL | CLAUDE_CODE | CALENDAR).
-- Set at extraction time; null for tasks created before this migration.

ALTER TABLE tasks ADD COLUMN action_type TEXT
  CHECK (action_type IN ('EMAIL', 'CLAUDE_CODE', 'CALENDAR'));

UPDATE _meta SET value = '16' WHERE key = 'schema_version';
