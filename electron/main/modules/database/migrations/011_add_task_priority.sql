ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';

UPDATE _meta SET value = '11' WHERE key = 'schema_version';
