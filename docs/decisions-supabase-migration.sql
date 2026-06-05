-- Decisions: rich metadata for traceability + edit workflow.
-- Run this in the Supabase SQL editor against the production project.
-- These columns mirror local SQLite migration 015_decisions_metadata.sql.
-- Apply only once.

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS transcript_quote      TEXT,
  ADD COLUMN IF NOT EXISTS decided_by_speaker_id TEXT REFERENCES speakers(id),
  ADD COLUMN IF NOT EXISTS extraction_confidence TEXT
    CHECK (extraction_confidence IN ('high', 'medium', 'low')),
  ADD COLUMN IF NOT EXISTS parent_decision_id    TEXT REFERENCES decisions(id),
  ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ NOT NULL DEFAULT now();

-- Auto-bump updated_at on UPDATE so it reflects the last edit, not the create.
CREATE OR REPLACE FUNCTION decisions_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decisions_updated_at ON decisions;
CREATE TRIGGER decisions_updated_at
  BEFORE UPDATE ON decisions
  FOR EACH ROW EXECUTE FUNCTION decisions_set_updated_at();
