// Smoke test for Module 2 — Database Layer
// Runs outside Electron, so we bypass initDatabase() (which needs app.getPath)
// and call runMigrations + buildQueries directly with a temp file.

import Database from 'better-sqlite3'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { runMigrations } from '../electron/main/modules/database/migrate'
import { buildQueries } from '../electron/main/modules/database/queries'

const dbPath = path.join(os.tmpdir(), `cornflake-test-${Date.now()}.db`)

try {
  // 1. Initialise
  console.log('1. Initialising database at', dbPath)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)

  const q = buildQueries(db)
  console.log('   Migrations applied.')

  // 2. Create a meeting (manual start — no calendar_event_id)
  console.log('\n2. Creating meeting...')
  const meeting = q.createMeeting('Morning standup')
  console.log('   id:', meeting.id)
  console.log('   title:', meeting.title)
  console.log('   calendarEventId:', meeting.calendarEventId)   // should be null
  console.log('   requiresManualLabelling:', meeting.requiresManualLabelling)

  // 3. Create a self speaker
  console.log('\n3. Creating self speaker...')
  const self = q.createSelfSpeaker(meeting.id, 'nithin@basegraph.co')
  console.log('   id:', self.id)
  console.log('   name:', self.name)
  console.log('   isSelf:', self.isSelf)
  console.log('   email:', self.email)

  // 4. Create one task assigned to that speaker
  console.log('\n4. Creating task...')
  const [task] = q.createTasks([{
    meetingId: meeting.id,
    assigneeSpeakerId: self.id,
    title: 'Send the updated brief to the team',
    deadlineText: 'Tomorrow, 5pm',
    deadlineMs: Date.now() + 86_400_000,
    remindOffsetMs: -3_600_000,
    remindAtMs: null,
    transcriptQuote: "I'll send the updated brief to the team by tomorrow at 5pm.",
    extractionConfidence: 'high',
    note: null,
  }])
  console.log('   id:', task.id)
  console.log('   title:', task.title)
  console.log('   assigneeSpeakerId:', task.assigneeSpeakerId)
  console.log('   deadlineText:', task.deadlineText)
  console.log('   status:', task.status)

  // 5. getMeetingReviewPayload
  console.log('\n5. getMeetingReviewPayload...')
  const payload = q.getMeetingReviewPayload(meeting.id)

  console.log('\n--- ReviewPayload ---')
  console.log(JSON.stringify(payload, (_, v) => (Buffer.isBuffer(v) ? '<Buffer>' : v), 2))

  // Assertions
  const errors: string[] = []
  if (payload.meeting.id !== meeting.id)             errors.push('meeting.id mismatch')
  if (payload.meeting.calendarEventId !== null)      errors.push('calendarEventId should be null')
  if (payload.speakers.length !== 1)                 errors.push('expected 1 speaker')
  if (!payload.speakers[0].isSelf)                   errors.push('speaker should be self')
  if (payload.tasks.length !== 1)                    errors.push('expected 1 task')
  if (payload.tasks[0].title !== task.title)         errors.push('task title mismatch')
  if (payload.tasks[0].assigneeSpeakerId !== self.id) errors.push('task assignee mismatch')
  if (payload.decisions.length !== 0)                errors.push('expected 0 decisions')
  if (payload.comms.length !== 0)                    errors.push('expected 0 comms')

  if (errors.length > 0) {
    console.error('\nASSERTION FAILURES:')
    errors.forEach(e => console.error(' -', e))
    process.exit(1)
  }

  // 6. Close
  console.log('\n6. Closing database.')
  db.close()

  console.log('\nModule 2 verified.')

} finally {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
}
