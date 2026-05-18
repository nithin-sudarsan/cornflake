/**
 * verify-llm-extraction.js — Module 7 verification script.
 *
 * Finds the most recent meeting in the DB that has named speakers and utterances,
 * runs the full LLM extraction pipeline against it, then logs:
 *   - Extracted tasks with assignee names and confidence
 *   - Extracted decisions
 *   - Generated summary
 *   - Comms copy for each assignee (after auto-confirming all tasks)
 *
 * Usage:
 *   electron --no-sandbox scripts/verify-llm-extraction.js [--meetingId=<id>]
 *
 * Options:
 *   --meetingId=<id>  Use a specific meeting ID instead of the most recent one.
 */

const path = require('path')
const PROJECT_ROOT = path.resolve(__dirname, '..')
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') })

const { app }          = require('electron')
app.setName('cornflake')

const { initDatabase, closeDatabase, getDb } = require(path.join(PROJECT_ROOT, 'dist/main/modules/database'))
const { runExtractionPipeline, generateCommsForMeeting } =
  require(path.join(PROJECT_ROOT, 'dist/main/modules/llm/extraction'))

// ── argv ─────────────────────────────────────────────────────────────────────
const scriptIdx  = process.argv.findIndex(a => a.includes('verify-llm-extraction'))
const extraArgs  = process.argv.slice(scriptIdx + 1)
const meetingIdArg = (extraArgs.find(a => a.startsWith('--meetingId=')) || '').slice('--meetingId='.length) || null

// ── Helpers ───────────────────────────────────────────────────────────────────
function hr(char = '─', n = 60) { return char.repeat(n) }
function header(title) { console.log(`\n${hr()}\n  ${title}\n${hr()}`) }
function indent(msg, n = 4) { return ' '.repeat(n) + msg }
function log(msg) { console.log(indent(msg)) }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nModule 7 — LLM Extraction Verification')
  console.log(`Provider: ${process.env.LLM_PROVIDER ?? 'claude'}`)

  initDatabase()
  const db = getDb()

  // ── Find target meeting ───────────────────────────────────────────────────

  let meetingId = meetingIdArg

  if (!meetingId) {
    // Pick the most recent meeting that has utterances and at least one named speaker
    const Database = require('better-sqlite3')
    const dbPath   = path.join(app.getPath('userData'), 'cornflake.db')
    const rawDb    = new Database(dbPath)

    const row = rawDb.prepare(`
      SELECT m.id
      FROM meetings m
      JOIN speakers s ON s.meeting_id = m.id AND s.name IS NOT NULL AND s.is_self = 0
      JOIN utterances u ON u.meeting_id = m.id
      GROUP BY m.id
      ORDER BY m.start_ms DESC
      LIMIT 1
    `).get()

    rawDb.close()

    if (!row) {
      console.error('\n  ✗  No suitable meeting found in DB.')
      console.error('     Run the app, do a real meeting, and stop recording first.')
      process.exit(1)
    }

    meetingId = row.id
  }

  const meeting = db.getMeetingById(meetingId)
  if (!meeting) {
    console.error(`\n  ✗  Meeting not found: ${meetingId}`)
    process.exit(1)
  }

  header(`Meeting: "${meeting.title}"`)
  log(`ID:    ${meeting.id}`)
  log(`Date:  ${new Date(meeting.startMs).toLocaleString()}`)

  // Show existing speakers
  const speakers = db.getSpeakersByMeeting(meetingId)
  log(`\nSpeakers (${speakers.length}):`)
  for (const s of speakers) {
    log(`  ${s.name ?? '(unresolved)'} — ${s.isSelf ? 'self' : `deepgram_${s.deepgramId}`}  confidence=${s.confidence ?? 'n/a'}`)
  }

  // Show utterance count
  const utterances = db.getUtterancesByMeeting(meetingId)
  log(`\nUtterances: ${utterances.length}`)
  if (utterances.length > 0) {
    const sample = utterances.slice(0, 3)
    log('  (first 3):')
    for (const u of sample) {
      const spName = speakers.find(s => s.id === u.speakerId)?.name ?? '?'
      log(`  [${Math.floor(u.startMs/1000)}s] ${spName}: "${u.text.slice(0, 80)}${u.text.length > 80 ? '…' : ''}"`)
    }
  }

  // ── Delete any existing extraction data so we get a clean run ─────────────
  // We use better-sqlite3 directly to avoid coupling to the DB module's helpers.
  const Database = require('better-sqlite3')
  const dbPath   = path.join(app.getPath('userData'), 'cornflake.db')
  const rawDb    = new Database(dbPath)
  rawDb.prepare(`DELETE FROM tasks     WHERE meeting_id = ?`).run(meetingId)
  rawDb.prepare(`DELETE FROM decisions WHERE meeting_id = ?`).run(meetingId)
  rawDb.prepare(`UPDATE meetings SET summary = NULL WHERE id = ?`).run(meetingId)
  rawDb.prepare(`DELETE FROM comms     WHERE meeting_id = ?`).run(meetingId)
  rawDb.close()
  log('\nCleared existing extraction data for a clean run.')

  // ── Run extraction pipeline ───────────────────────────────────────────────
  header('Running extraction pipeline (tasks + decisions + summary in parallel)…')
  console.log('  This will make real API calls to the configured LLM provider.')

  const t0 = Date.now()
  const reviewPayload = await runExtractionPipeline(meetingId)
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n  Completed in ${elapsed}s`)

  // ── Log tasks ─────────────────────────────────────────────────────────────
  header(`Extracted Tasks (${reviewPayload.tasks.length})`)
  if (reviewPayload.tasks.length === 0) {
    log('(none extracted)')
  } else {
    for (const t of reviewPayload.tasks) {
      const assigneeName = t.assigneeSpeakerId
        ? (speakers.find(s => s.id === t.assigneeSpeakerId)?.name ?? 'Unknown')
        : 'Unassigned'
      log(`• ${t.title}`)
      log(`  Assignee:   ${assigneeName}  (confidence: ${t.extractionConfidence ?? 'n/a'})`)
      log(`  Deadline:   ${t.deadlineText ?? 'none'} → ${t.deadlineMs ? new Date(t.deadlineMs).toLocaleDateString() : 'not resolved'}`)
      log(`  Quote:      "${(t.transcriptQuote ?? '').slice(0, 100)}…"`)
      log('')
    }
  }

  // ── Log decisions ─────────────────────────────────────────────────────────
  header(`Extracted Decisions (${reviewPayload.decisions.length})`)
  if (reviewPayload.decisions.length === 0) {
    log('(none extracted)')
  } else {
    for (const d of reviewPayload.decisions) {
      log(`• ${d.text}`)
    }
  }

  // ── Log summary ───────────────────────────────────────────────────────────
  header('Generated Summary')
  const meetingAfter = db.getMeetingById(meetingId)
  if (meetingAfter?.summary) {
    log(meetingAfter.summary)
  } else {
    log('(no summary generated)')
  }

  // ── Auto-confirm all tasks and generate comms ─────────────────────────────
  header('Generating Comms Copy (auto-confirming all tasks first)…')

  for (const t of reviewPayload.tasks) {
    db.confirmTask(t.id)
  }

  const t1 = Date.now()
  const comms = await generateCommsForMeeting(meetingId)
  const elapsed2 = ((Date.now() - t1) / 1000).toFixed(1)
  console.log(`  Completed in ${elapsed2}s`)

  if (comms.length === 0) {
    log('\n(no comms generated — no confirmed tasks with named assignees)')
  } else {
    for (const c of comms) {
      const recipientName = speakers.find(s => s.id === c.recipientSpeakerId)?.name ?? 'Unknown'
      log(`\n● To: ${recipientName}  (channel: ${c.deliveryChannel}, hasCornflake: ${c.hasCornflake})`)
      log(`  "${c.messageBody}"`)
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${hr('═')}`)
  console.log(`  Tasks: ${reviewPayload.tasks.length}  |  Decisions: ${reviewPayload.decisions.length}  |  Comms: ${comms.length}`)
  console.log(`  Extraction: ${elapsed}s  |  Comms: ${elapsed2}s`)
  console.log(`${hr('═')}\n`)

  closeDatabase()
  process.exit(0)
}

main().catch(err => {
  console.error('\n[verify] Fatal error:', err.message || err)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
