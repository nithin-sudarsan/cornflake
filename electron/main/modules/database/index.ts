import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'
import { runMigrations } from './migrate'
import { buildQueries, type Queries, registerWriteHook, registerDeleteHook } from './queries'

export type { Queries } from './queries'
export { registerWriteHook, registerDeleteHook } from './queries'
export type {
  Meeting, Speaker, Utterance, Task, Decision, Comm,
  ReviewPayload, NewTask, NewComm, Confidence, TaskStatus, TaskPriority, DeliveryChannel, ListRecord,
  PastMeeting, MeetingDetailData, TaskForApproval, TaskDetail,
} from './types'

let _db: Database.Database | null = null
let _queries: Queries | null = null

export function initDatabase(): Queries {
  if (_queries) return _queries

  const dbPath = path.join(app.getPath('userData'), 'cornflake.db')
  _db = new Database(dbPath)

  // WAL mode for better concurrent read performance
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')

  runMigrations(_db)

  _queries = buildQueries(_db)
  return _queries
}

export function getDb(): Queries {
  if (!_queries) throw new Error('Database not initialised — call initDatabase() first')
  return _queries
}

export function closeDatabase(): void {
  if (_db) {
    _db.close()
    _db = null
    _queries = null
  }
}
