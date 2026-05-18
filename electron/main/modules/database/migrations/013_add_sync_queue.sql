CREATE TABLE IF NOT EXISTS sync_queue (
  id              TEXT PRIMARY KEY,
  table_name      TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  operation       TEXT NOT NULL,   -- 'upsert' | 'delete'
  payload         TEXT,            -- JSON
  created_at      INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER
);
