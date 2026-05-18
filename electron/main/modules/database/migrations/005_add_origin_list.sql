-- Add origin_list to tasks to track which list a task came from before
-- being moved to the Completed list.

ALTER TABLE tasks ADD COLUMN origin_list TEXT;

-- Back-fill existing rows: origin is wherever they currently live.
UPDATE tasks SET origin_list = list_name;

UPDATE _meta SET value = '5' WHERE key = 'schema_version';
