-- WorkOS user IDs (e.g. user_01KRQZ0S0PEYRMSE9Y8TC4DYAN) are not valid UUIDs.
-- Any Supabase table with user_id typed as UUID rejects sync pushes from the
-- Electron client with a type cast error, silently returning HTTP 200 to the
-- client while logging the error on the backend.
--
-- This migration converts user_id to TEXT on every table that stores a WorkOS
-- user ID reference. Safe to run multiple times — Postgres allows ALTER COLUMN
-- TYPE TEXT on a column that is already TEXT.
--
-- Run once in the Supabase SQL editor against the production project.

ALTER TABLE tasks          ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;
ALTER TABLE decisions      ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;
ALTER TABLE meetings       ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;
ALTER TABLE speakers       ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;
ALTER TABLE utterances     ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;
ALTER TABLE comms          ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;
ALTER TABLE lists          ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;
ALTER TABLE voice_profiles ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;
ALTER TABLE user_profiles  ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;
