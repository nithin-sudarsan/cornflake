/**
 * test-speaker-inference.js — verify Module 6 end-to-end.
 *
 * Creates a synthetic meeting with two unresolved remote speakers, injects
 * utterances containing self-introduction and direct-address patterns, then runs
 * inferSpeakers() to confirm the speakers are resolved and DB rows are updated.
 *
 * Run via Electron:
 *   electron --no-sandbox scripts/test-speaker-inference.js
 *
 * Optional flag --keep-data skips cleanup so you can inspect the DB afterwards.
 */

const path = require('path')
const fs   = require('fs')
const os   = require('os')

const PROJECT_ROOT = path.resolve(__dirname, '..')
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') })

const { initDatabase, closeDatabase, getDb } = require(path.join(PROJECT_ROOT, 'dist/main/modules/database'))
const { inferSpeakers }                       = require(path.join(PROJECT_ROOT, 'dist/main/modules/speaker-inference'))
const { stopSidecar }                         = require(path.join(PROJECT_ROOT, 'dist/main/sidecar/spawn'))

// Electron argv: [electron, '--no-sandbox', scriptPath, ...extras]
const scriptIdx = process.argv.findIndex(a => a.includes('test-speaker-inference'))
const extraArgs = process.argv.slice(scriptIdx + 1)
const keepData  = extraArgs.includes('--keep-data')

let PASS = 0
let FAIL = 0

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓  ${msg}`)
    PASS++
  } else {
    console.error(`  ✗  ${msg}`)
    FAIL++
  }
}

// ---------------------------------------------------------------------------

async function main() {
  initDatabase()
  const db = getDb()

  // ------------------------------------------------------------------
  // Setup: create a synthetic meeting + 2 unresolved remote speakers
  // ------------------------------------------------------------------

  console.log('\n── Creating synthetic meeting ──')
  const meeting = db.createMeeting('Test Inference Meeting')
  console.log(`  Meeting id: ${meeting.id}`)

  // Create self speaker
  const selfSpeaker = db.createSelfSpeaker(meeting.id, 'nithin@example.com')
  assert(selfSpeaker.isSelf, 'self speaker has isSelf=true')

  // Create two remote speakers (as transcription module would)
  const [sp0, sp1] = db.createSpeakers(meeting.id, ['0', '1'])
  assert(sp0.name === null, 'deepgram_0 starts with name=null')
  assert(sp1.name === null, 'deepgram_1 starts with name=null')
  assert(sp0.deepgramId === '0', 'deepgram_0 has deepgramId="0"')
  assert(sp1.deepgramId === '1', 'deepgram_1 has deepgramId="1"')

  // ------------------------------------------------------------------
  // Transcript with inference patterns
  //
  // Pattern A (deepgram_0): self-introduction → "I'm Alice, nice to meet you"
  // Pattern B (deepgram_1): direct address    → "Bob, can you share your screen?"
  //   (the previous speaker was deepgram_0, so deepgram_0 is Bob — BUT
  //    self-intro already resolved deepgram_0 to Alice, so this tests that
  //    direct address on a resolved speaker is skipped correctly)
  //
  // To also test direct address resolving an unresolved speaker, we need
  // deepgram_1 to be addressed after it speaks. We'll add a second round:
  //   deepgram_1: "Actually, this is Charlie speaking."  → self-intro → Charlie
  // ------------------------------------------------------------------

  const now = Date.now()
  const utterances = [
    // deepgram_0 self-introduction
    { meetingId: meeting.id, speakerId: sp0.id, text: "Hi everyone, I'm Alice nice to meet you all.", startMs: now + 1000, endMs: now + 4000 },
    // deepgram_1 direct-addresses deepgram_0 as "Alice" (confirms the name already set)
    { meetingId: meeting.id, speakerId: sp1.id, text: "Alice, can you share the slide deck?",          startMs: now + 5000, endMs: now + 8000 },
    // deepgram_1 self-introduction → should resolve to "Charlie"
    { meetingId: meeting.id, speakerId: sp1.id, text: "Sure, by the way my name is Charlie.",          startMs: now + 9000, endMs: now + 12000 },
    // You (self)
    { meetingId: meeting.id, speakerId: selfSpeaker.id, text: "Great, let's get started.",             startMs: now + 13000, endMs: now + 15000 },
  ]

  db.createUtterances(utterances)
  assert(db.getUtterancesByMeeting(meeting.id).length === 4, '4 utterances written to DB')

  // Build the transcript in the same shape as the transcription module produces
  const transcript = [
    { speakerId: 'deepgram_0', text: utterances[0].text, startMs: utterances[0].startMs, endMs: utterances[0].endMs },
    { speakerId: 'deepgram_1', text: utterances[1].text, startMs: utterances[1].startMs, endMs: utterances[1].endMs },
    { speakerId: 'deepgram_1', text: utterances[2].text, startMs: utterances[2].startMs, endMs: utterances[2].endMs },
    { speakerId: 'you',        text: utterances[3].text, startMs: utterances[3].startMs, endMs: utterances[3].endMs },
  ]

  console.log('\n── Running inferSpeakers() ──')
  // No real audio file — voice profile Step 1 will be skipped gracefully
  const result = await inferSpeakers(transcript, meeting.id, '/nonexistent_audio.wav')

  // ------------------------------------------------------------------
  // Assertions on DB state after inference
  // ------------------------------------------------------------------

  console.log('\n── Checking DB after inference ──')
  const speakersAfter = db.getSpeakersByMeeting(meeting.id)
  const alice   = speakersAfter.find(s => s.deepgramId === '0')
  const charlie = speakersAfter.find(s => s.deepgramId === '1')

  assert(alice?.name   === 'Alice',   `deepgram_0 resolved to "Alice"   (got "${alice?.name}")`)
  assert(alice?.confidence === 'high', `deepgram_0 confidence = high     (got "${alice?.confidence}")`)

  assert(charlie?.name   === 'Charlie',  `deepgram_1 resolved to "Charlie" (got "${charlie?.name}")`)
  assert(charlie?.confidence === 'high', `deepgram_1 confidence = high     (got "${charlie?.confidence}")`)

  const meetingAfter = db.getMeetingById(meeting.id)
  assert(meetingAfter?.requiresManualLabelling === false, 'requires_manual_labelling = false (all resolved)')
  assert(result.unresolvedSpeakers.length === 0,          'no unresolved speakers returned')

  // ------------------------------------------------------------------
  // Test 2: unresolved speakers case (no patterns in transcript)
  // ------------------------------------------------------------------

  console.log('\n── Testing unresolved speaker labelling ──')
  const meeting2 = db.createMeeting('Test Unresolved Meeting')
  db.createSelfSpeaker(meeting2.id)
  const [spX, spY] = db.createSpeakers(meeting2.id, ['0', '1'])

  const transcript2 = [
    { speakerId: 'deepgram_0', text: 'The metrics look good this week.',     startMs: now + 1000, endMs: now + 4000 },
    { speakerId: 'deepgram_1', text: 'We should increase the budget by 10%.', startMs: now + 5000, endMs: now + 8000 },
  ]
  db.createUtterances([
    { meetingId: meeting2.id, speakerId: spX.id, text: transcript2[0].text, startMs: transcript2[0].startMs, endMs: transcript2[0].endMs },
    { meetingId: meeting2.id, speakerId: spY.id, text: transcript2[1].text, startMs: transcript2[1].startMs, endMs: transcript2[1].endMs },
  ])

  const result2 = await inferSpeakers(transcript2, meeting2.id, '/nonexistent.wav')

  assert(result2.requiresManualLabelling === true,           'requires_manual_labelling = true (no patterns)')
  assert(result2.unresolvedSpeakers.length === 2,            '2 unresolved speakers returned')
  assert(result2.unresolvedSpeakers[0].label === 'Speaker A','first unresolved = "Speaker A"')
  assert(result2.unresolvedSpeakers[1].label === 'Speaker B','second unresolved = "Speaker B"')

  const m2After = db.getMeetingById(meeting2.id)
  assert(m2After?.requiresManualLabelling === true, 'DB flag requires_manual_labelling = true')

  // ------------------------------------------------------------------
  // Test 3: bulk resolve (simulates SpeakerLabeller → SPEAKERS_LABEL IPC)
  // ------------------------------------------------------------------

  console.log('\n── Testing bulkResolveSpeakers (SpeakerLabeller flow) ──')
  db.bulkResolveSpeakers([
    { speakerId: spX.id, name: 'Diana', email: 'diana@example.com' },
    { speakerId: spY.id, name: 'Edward' },
  ])
  db.setMeetingRequiresLabelling(meeting2.id, false)

  const afterBulk = db.getSpeakersByMeeting(meeting2.id)
  const diana  = afterBulk.find(s => s.deepgramId === '0')
  const edward = afterBulk.find(s => s.deepgramId === '1')
  assert(diana?.name       === 'Diana',  `spX resolved to "Diana"   (got "${diana?.name}")`)
  assert(diana?.confidence === 'manual', `spX confidence = manual   (got "${diana?.confidence}")`)
  assert(edward?.name      === 'Edward', `spY resolved to "Edward"  (got "${edward?.name}")`)
  assert(db.getMeetingById(meeting2.id)?.requiresManualLabelling === false, 'flag cleared after manual labelling')

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------

  if (!keepData) {
    // SQLite CASCADE deletes speakers, utterances etc. automatically
    // (no delete helper in queries.ts yet — run raw SQL)
    const Database = require('better-sqlite3')
    const { app }  = require('electron')
    const rawDb    = new Database(path.join(app.getPath('userData'), 'cornflake.db'))
    rawDb.prepare(`DELETE FROM meetings WHERE id IN (?, ?)`).run(meeting.id, meeting2.id)
    rawDb.close()
    console.log('\n  Test data cleaned up.')
  } else {
    console.log(`\n  Test data kept (--keep-data). Meeting IDs: ${meeting.id}, ${meeting2.id}`)
  }

  stopSidecar()
  closeDatabase()

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------

  console.log(`\n──────────────────────────────────────────`)
  console.log(`  ${PASS} passed  /  ${FAIL} failed`)
  if (FAIL > 0) {
    console.error('  SOME TESTS FAILED')
    process.exit(1)
  } else {
    console.log('  All tests passed ✓')
    process.exit(0)
  }
}

main().catch(err => {
  console.error('[test] Unhandled error:', err.message || err)
  process.exit(1)
})
