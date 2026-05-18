CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,   -- WorkOS user_id
  email      TEXT NOT NULL,
  name       TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE meetings      ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE tasks         ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE speakers      ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE voice_profiles ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE lists          ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE oauth_tokens   ADD COLUMN user_id TEXT REFERENCES users(id);

UPDATE _meta SET value = '12' WHERE key = 'schema_version';
