ALTER TABLE tasks ADD COLUMN sort_order INTEGER;

-- Back-fill existing rows: preserve created_at ordering within each list.
-- Uses a window-style rank via a correlated subquery so each task gets
-- a unique integer within its (list_name) partition.
UPDATE tasks
SET sort_order = (
  SELECT COUNT(*)
  FROM tasks t2
  WHERE t2.list_name = tasks.list_name
    AND (t2.created_at < tasks.created_at
         OR (t2.created_at = tasks.created_at AND t2.id <= tasks.id))
);

UPDATE _meta SET value = '10' WHERE key = 'schema_version';
