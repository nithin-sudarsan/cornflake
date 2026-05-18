import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

export function runMigrations(db: Database.Database): void {
  // Ensure _meta exists so we can read the version even on a brand-new DB.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO _meta VALUES ('schema_version', '0');
  `)

  const currentVersion = parseInt(
    (db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as { value: string }).value,
    10
  )

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d+_.+\.sql$/.test(f))
    .sort()

  for (const file of files) {
    const migrationVersion = parseInt(file.split('_')[0], 10)
    if (migrationVersion <= currentVersion) continue

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')

    try {
      db.exec(sql)
    } catch (err) {
      const msg = (err as Error).message ?? ''

      // "duplicate column name" — ALTER TABLE ADD COLUMN on a column that already exists
      // "already exists"       — CREATE TABLE / CREATE INDEX on an object that already exists
      // Both indicate the migration was partially applied outside the runner (e.g. manual
      // testing). The schema is already in the desired state, so treat as success and
      // advance schema_version so the runner never retries this migration.
      if (msg.includes('duplicate column name') || msg.includes('already exists')) {
        console.warn(`[migrate] ${file}: idempotent schema change already applied ("${msg}") — marking version ${migrationVersion} and continuing`)
        db.prepare(`UPDATE _meta SET value = ? WHERE key = 'schema_version'`).run(String(migrationVersion))
      } else {
        throw new Error(`Migration ${file} failed: ${msg}`)
      }
    }
  }
}
