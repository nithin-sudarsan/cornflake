-- Decisions: richer metadata for traceability + edit workflow.
--
-- See docs/decisions-supabase-migration.sql for the matching Supabase columns.
-- Note: Supabase stores updated_at as TIMESTAMPTZ (server-managed via trigger);
-- locally we store it as INTEGER unix-ms (client-managed). The sync layer's
-- DROP_COLS skips updated_at on push, so the two clocks stay independent.

ALTER TABLE decisions ADD COLUMN transcript_quote      TEXT;
ALTER TABLE decisions ADD COLUMN decided_by_speaker_id TEXT REFERENCES speakers(id);
ALTER TABLE decisions ADD COLUMN extraction_confidence TEXT
  CHECK (extraction_confidence IN ('high', 'medium', 'low'));
ALTER TABLE decisions ADD COLUMN parent_decision_id    TEXT REFERENCES decisions(id);
ALTER TABLE decisions ADD COLUMN updated_at            INTEGER NOT NULL DEFAULT 0;

UPDATE _meta SET value = '15' WHERE key = 'schema_version';
