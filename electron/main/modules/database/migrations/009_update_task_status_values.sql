-- Introduce 'awaiting_approval' status for meeting tasks not yet approved.
-- Previously 'pending' was used for both unapproved meeting tasks and active reminders.
--
-- New model:
--   awaiting_approval  meeting task extracted, shown in ACTION ITEMS only
--   pending            active reminder (approved meeting task or standalone)
--   confirmed          completed task (moved to Completed list)
--   dismissed          removed

-- Step 1 FIRST: unapproved meeting tasks (originally 'pending') → awaiting_approval
-- Must run before step 2 so newly-pendinged tasks from step 2 are not caught here.
UPDATE tasks SET status = 'awaiting_approval' WHERE meeting_id IS NOT NULL AND status = 'pending';

-- Step 2 SECOND: approved meeting tasks in reminders (originally 'confirmed') → pending
-- These had status='confirmed' from the old confirmTask() call and are active reminders.
UPDATE tasks SET status = 'pending' WHERE status = 'confirmed' AND list_name != 'Completed';

-- Standalone pending tasks (meeting_id IS NULL + status = 'pending') stay pending.
-- Completed tasks (confirmed + list_name = 'Completed') stay confirmed.
-- Dismissed tasks stay dismissed.

UPDATE _meta SET value = '9' WHERE key = 'schema_version';
