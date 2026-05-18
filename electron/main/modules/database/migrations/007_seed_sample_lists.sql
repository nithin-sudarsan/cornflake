-- Move "To-do List", "High Priority", "Flagged" out of hardcoded UI and into
-- the lists table so they can be deleted by the user like any custom list.
-- created_at values of 1/2/3 keep them ordered before user-created lists.

INSERT OR IGNORE INTO lists (id, name, created_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'To-do List',    1),
  ('00000000-0000-0000-0000-000000000002', 'High Priority', 2),
  ('00000000-0000-0000-0000-000000000003', 'Flagged',       3);

UPDATE _meta SET value = '7' WHERE key = 'schema_version';
