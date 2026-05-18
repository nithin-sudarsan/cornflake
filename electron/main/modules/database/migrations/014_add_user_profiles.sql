CREATE TABLE IF NOT EXISTS user_profiles (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL UNIQUE REFERENCES users(id),
  profile_md TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

UPDATE _meta SET value = '14' WHERE key = 'schema_version';
