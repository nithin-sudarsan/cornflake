CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider   TEXT PRIMARY KEY,
  tokens     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

UPDATE _meta SET value = '2' WHERE key = 'schema_version';
