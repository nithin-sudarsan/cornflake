ALTER TABLE tasks ADD COLUMN completed_at INTEGER;

UPDATE _meta SET value = '6' WHERE key = 'schema_version';
