-- Rollback the additive migration in decisions-supabase-migration.sql.
-- Run only if you want to truly remove the columns and trigger.
-- WARNING: Dropping columns is destructive — any data in them is lost.
-- Most of the time you do NOT need to run this; the columns can sit dormant.

DROP TRIGGER IF EXISTS decisions_updated_at ON decisions;
DROP FUNCTION IF EXISTS decisions_set_updated_at();

ALTER TABLE decisions
  DROP COLUMN IF EXISTS transcript_quote,
  DROP COLUMN IF EXISTS decided_by_speaker_id,
  DROP COLUMN IF EXISTS extraction_confidence,
  DROP COLUMN IF EXISTS parent_decision_id,
  DROP COLUMN IF EXISTS updated_at;
