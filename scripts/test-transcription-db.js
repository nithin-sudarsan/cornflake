// Integration test: full pipeline including SQLite writes.
// Creates a real DB in /tmp, creates a meeting record, runs transcription, verifies utterance rows.
//
// Usage:
//   node scripts/test-transcription-db.js <micPath> <systemAudioPath>

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const fs = require('fs')
const Database = require('better-sqlite3')
const { randomUUID } = require('crypto')

// Electron adds its flags to process.argv, shifting indices.
// Use slice(-2) to reliably get the last two args regardless of runtime.
const [micPath, sysPath] = process.argv.slice(-2)
if (!micPath || !sysPath || micPath.startsWith('-') || sysPath.startsWith('-')) {
  console.error('Usage: node scripts/test-transcription-db.js <micPath> <systemAudioPath>')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Minimal DB setup (mirrors the real schema — just the tables we need)
// ---------------------------------------------------------------------------
const dbPath = `/tmp/cornflake_test_${Date.now()}.db`
const db = new Database(dbPath)
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE meetings (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, start_ms INTEGER NOT NULL,
    end_ms INTEGER, calendar_event_id TEXT, requires_manual_labelling INTEGER NOT NULL DEFAULT 0,
    summary TEXT, confirmed_at INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE speakers (
    id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    deepgram_id TEXT, name TEXT, email TEXT, is_self INTEGER NOT NULL DEFAULT 0,
    confidence TEXT, has_cornflake INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE utterances (
    id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker_id TEXT NOT NULL REFERENCES speakers(id), text TEXT NOT NULL,
    start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE voice_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, email TEXT, embedding BLOB NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id),
    assignee_speaker_id TEXT, title TEXT NOT NULL, deadline_text TEXT, deadline_ms INTEGER,
    remind_offset_ms INTEGER, remind_at_ms INTEGER, transcript_quote TEXT,
    extraction_confidence TEXT, status TEXT NOT NULL DEFAULT 'pending', note TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE decisions (
    id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id), text TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE comms (
    id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id),
    recipient_speaker_id TEXT NOT NULL, message_body TEXT NOT NULL, delivery_channel TEXT NOT NULL DEFAULT 'push',
    recipient_email TEXT, has_cornflake INTEGER NOT NULL DEFAULT 0, include_install_invite INTEGER NOT NULL DEFAULT 0,
    send INTEGER NOT NULL DEFAULT 1, sent_at INTEGER, send_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_tokens (
    provider TEXT PRIMARY KEY, tokens TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
`)

const now = Date.now()
const meetingId = randomUUID()

// Create meeting + self speaker
db.prepare(`INSERT INTO meetings (id, title, start_ms, created_at) VALUES (?, ?, ?, ?)`)
  .run(meetingId, 'Test Meeting', now, now)

const selfId = randomUUID()
db.prepare(`INSERT INTO speakers (id, meeting_id, name, is_self, created_at) VALUES (?, ?, 'You', 1, ?)`)
  .run(selfId, meetingId, now)

console.log(`Created test DB at ${dbPath}`)
console.log(`Meeting ID: ${meetingId}`)

// ---------------------------------------------------------------------------
// Monkey-patch the database module to use our test DB
// ---------------------------------------------------------------------------
// The compiled transcription module uses getDb() from database/index.js.
// We override it here to return query helpers backed by our test DB.
const queriesModule = require('/Users/nithin/Documents/cornflake/dist/main/modules/database/queries.js')
const queries = queriesModule.buildQueries(db)

// Override getDb in the database module
const dbModule = require('/Users/nithin/Documents/cornflake/dist/main/modules/database/index.js')
dbModule.getDb = () => queries

// ---------------------------------------------------------------------------
// Run the pipeline
// ---------------------------------------------------------------------------
const { runTranscriptionPipeline } = require('/Users/nithin/Documents/cornflake/dist/main/modules/transcription/index.js')

async function main() {
  console.log('\nRunning transcription pipeline...')
  const transcript = await runTranscriptionPipeline(
    { micPath, systemAudioPath: sysPath },
    meetingId
  )

  // Verify utterances were written
  const utterances = db.prepare(`
    SELECT u.*, s.name as speaker_name, s.deepgram_id, s.is_self
    FROM utterances u
    JOIN speakers s ON s.id = u.speaker_id
    WHERE u.meeting_id = ?
    ORDER BY u.start_ms
  `).all(meetingId)

  console.log(`\n=== DB Verification ===`)
  console.log(`Utterance rows in DB: ${utterances.length}`)
  for (const u of utterances) {
    const label = u.is_self ? 'you' : `deepgram_${u.deepgram_id}`
    console.log(`  [${label.padEnd(12)}] ${u.start_ms}ms  "${u.text}"`)
  }

  const speakers = db.prepare(`SELECT * FROM speakers WHERE meeting_id = ?`).all(meetingId)
  console.log(`\nSpeaker rows in DB: ${speakers.length}`)
  for (const s of speakers) {
    console.log(`  ${s.id.substring(0,8)}  name=${s.name ?? 'null'}  deepgram_id=${s.deepgram_id ?? 'null'}  is_self=${s.is_self}`)
  }

  if (utterances.length > 0) {
    console.log('\n✓ DB write verified — utterances exist in the database')
  } else {
    console.error('\n✗ No utterances written to DB')
    process.exit(1)
  }

  // Cleanup
  db.close()
  fs.unlinkSync(dbPath)
  console.log(`\nTest DB cleaned up.`)
}

main().catch(err => {
  console.error('Integration test failed:', err)
  db.close()
  fs.unlinkSync(dbPath)
  process.exit(1)
})
