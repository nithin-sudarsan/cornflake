ALTER TABLE meetings ADD COLUMN deleted_at INTEGER;

UPDATE _meta SET value = '8' WHERE key = 'schema_version';
