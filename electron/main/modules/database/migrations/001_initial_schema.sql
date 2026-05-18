CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO _meta VALUES ('schema_version', '0');

CREATE TABLE IF NOT EXISTS meetings (
  id                         TEXT PRIMARY KEY,
  title                      TEXT NOT NULL,
  start_ms                   INTEGER NOT NULL,
  end_ms                     INTEGER,
  calendar_event_id          TEXT,
  requires_manual_labelling  INTEGER NOT NULL DEFAULT 0,
  summary                    TEXT,
  confirmed_at               INTEGER,
  created_at                 INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS speakers (
  id             TEXT PRIMARY KEY,
  meeting_id     TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  deepgram_id    TEXT,
  name           TEXT,
  email          TEXT,
  is_self        INTEGER NOT NULL DEFAULT 0,
  confidence     TEXT,
  has_cornflake  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS utterances (
  id          TEXT PRIMARY KEY,
  meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker_id  TEXT NOT NULL REFERENCES speakers(id),
  text        TEXT NOT NULL,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                    TEXT PRIMARY KEY,
  meeting_id            TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
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
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id          TEXT PRIMARY KEY,
  meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comms (
  id                     TEXT PRIMARY KEY,
  meeting_id             TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  recipient_speaker_id   TEXT NOT NULL REFERENCES speakers(id),
  message_body           TEXT NOT NULL,
  delivery_channel       TEXT NOT NULL DEFAULT 'push',
  recipient_email        TEXT,
  has_cornflake          INTEGER NOT NULL DEFAULT 0,
  include_install_invite INTEGER NOT NULL DEFAULT 0,
  send                   INTEGER NOT NULL DEFAULT 1,
  sent_at                INTEGER,
  send_error             TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_profiles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  email        TEXT,
  embedding    BLOB NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 1,
  updated_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

UPDATE _meta SET value = '1' WHERE key = 'schema_version';
