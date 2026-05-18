/**
 * pipeline-check.js — Full pipeline audit for the most recent meeting.
 *
 * Checks (in order):
 *   1. Audio          — WAV file presence and sizes
 *   2. Transcription  — utterances, speaker IDs, mic vs system audio tagging
 *   3. Speaker inference — resolved names, confidence levels, methods
 *   4. LLM extraction — tasks, decisions, summary, comms copy
 *   5. DB integrity   — referential integrity, expected populated fields
 *
 * Flags any issue with a clear ✗ marker and an explanation.
 *
 * Usage:
 *   electron --no-sandbox scripts/pipeline-check.js [--meetingId=<id>]
 */

const path = require('path')
const fs   = require('fs')
const os   = require('os')

const PROJECT_ROOT = path.resolve(__dirname, '..')
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') })

const { app }      = require('electron')
app.setName('cornflake')

const { initDatabase, closeDatabase, getDb } =
  require(path.join(PROJECT_ROOT, 'dist/main/modules/database'))

const Database = require('better-sqlite3')

// ── argv ──────────────────────────────────────────────────────────────────────
const scriptIdx    = process.argv.findIndex(a => a.includes('pipeline-check'))
const extraArgs    = process.argv.slice(scriptIdx + 1)
const meetingIdArg = (extraArgs.find(a => a.startsWith('--meetingId=')) || '').slice('--meetingId='.length) || null

// ── State ─────────────────────────────────────────────────────────────────────
let PASS = 0, WARN = 0, FAIL = 0
const issues = []

// ── Reporters ─────────────────────────────────────────────────────────────────
function ok(msg)   { console.log(`  ✓  ${msg}`); PASS++ }
function warn(msg) { console.log(`  ⚠  ${msg}`); WARN++; issues.push({ level: 'warn', msg }) }
function fail(msg) { console.log(`  ✗  ${msg}`); FAIL++; issues.push({ level: 'fail', msg }) }
function info(msg) { console.log(`     ${msg}`) }
function header(t) { console.log(`\n${'─'.repeat(62)}\n  ${t}\n${'─'.repeat(62)}`) }

function bytes(n) {
  if (n < 1024)         return `${n} B`
  if (n < 1024 * 1024)  return `${(n/1024).toFixed(1)} KB`
  return `${(n/(1024*1024)).toFixed(2)} MB`
}

function msToTime(ms) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${(s % 60).toString().padStart(2,'0')}`
}

// ── Raw DB (bypasses getDb() singleton for integrity queries) ─────────────────
function rawDb() {
  const dbPath = path.join(app.getPath('userData'), 'cornflake.db')
  return new Database(dbPath)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Audio
// ─────────────────────────────────────────────────────────────────────────────

function checkAudio(meetingId, meetingStartMs) {
  header('1. Audio — WAV file check')

  const tmpDir = os.tmpdir()

  // Find WAV pairs where session UUID matches in both mic and sys file names.
  // The most recent pair whose mtime is >= meeting start time is the one.
  const allFiles = fs.readdirSync(tmpDir)
  const sysPairs = allFiles
    .filter(f => f.startsWith('cf_sys_') && f.endsWith('.wav'))
    .map(f => {
      const sessionId = f.slice('cf_sys_'.length, -'.wav'.length)
      const sysPath   = path.join(tmpDir, f)
      const micPath   = path.join(tmpDir, `cf_mic_${sessionId}.wav`)
      const sysStat   = fs.existsSync(sysPath) ? fs.statSync(sysPath) : null
      const micStat   = fs.existsSync(micPath) ? fs.statSync(micPath) : null
      return { sessionId, sysPath, micPath, sysStat, micStat }
    })
    .filter(p => p.sysStat && p.micStat)
    .sort((a, b) => b.sysStat.mtimeMs - a.sysStat.mtimeMs)

  if (sysPairs.length === 0) {
    fail('No cf_mic_*/cf_sys_* WAV pairs found in tmpdir')
    info(`Tmpdir: ${tmpDir}`)
    info('Files are removed on "Confirm & send" — if this meeting was confirmed, that is expected.')
    return null
  }

  // Pick the most recent pair (likely matches the most recent recording session)
  const best = sysPairs[0]
  const ageSec = Math.round((Date.now() - best.sysStat.mtimeMs) / 1000)
  info(`Tmpdir: ${tmpDir}`)
  info(`Most recent session: ${best.sessionId}`)
  info(`  cf_sys: ${bytes(best.sysStat.size)}  mtime=${new Date(best.sysStat.mtimeMs).toLocaleTimeString()}  (${ageSec}s ago)`)
  info(`  cf_mic: ${bytes(best.micStat.size)}  mtime=${new Date(best.micStat.mtimeMs).toLocaleTimeString()}`)

  // Check sizes
  if (best.sysStat.size <= 44) {
    fail(`cf_sys WAV is empty or header-only (${bytes(best.sysStat.size)}) — system audio was not captured`)
  } else if (best.sysStat.size < 50_000) {
    warn(`cf_sys WAV is very small (${bytes(best.sysStat.size)}) — recording may have been very short`)
  } else {
    ok(`cf_sys WAV has content: ${bytes(best.sysStat.size)}`)
  }

  if (best.micStat.size <= 44) {
    fail(`cf_mic WAV is empty or header-only (${bytes(best.micStat.size)}) — mic was not captured`)
  } else if (best.micStat.size < 50_000) {
    warn(`cf_mic WAV is very small (${bytes(best.micStat.size)}) — mic may have been nearly silent`)
  } else {
    ok(`cf_mic WAV has content: ${bytes(best.micStat.size)}`)
  }

  // Duration from file size (16kHz 16-bit mono = 32 bytes/ms)
  const sysDurationSec  = Math.round((best.sysStat.size - 44) / 32000)
  const micDurationSec  = Math.round((best.micStat.size - 44) / 32000)
  info(`  Computed duration — sys: ~${sysDurationSec}s   mic: ~${micDurationSec}s`)

  if (Math.abs(sysDurationSec - micDurationSec) > 5) {
    warn(`sys and mic durations differ by >5s (${sysDurationSec}s vs ${micDurationSec}s) — streams may have desynchronised`)
  } else {
    ok(`sys and mic durations are consistent (~${sysDurationSec}s)`)
  }

  if (sysPairs.length > 1) {
    info(`  (${sysPairs.length - 1} older WAV pair(s) also present — not checked)`)
  }

  return { sysPath: best.sysPath, micPath: best.micPath, durationSec: sysDurationSec }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Transcription
// ─────────────────────────────────────────────────────────────────────────────

function checkTranscription(meetingId, db) {
  header('2. Transcription — utterances and speaker tagging')

  const utterances = db.getUtterancesByMeeting(meetingId)
  const speakers   = db.getSpeakersByMeeting(meetingId)
  const selfSp     = speakers.find(s => s.isSelf)

  info(`Total utterances: ${utterances.length}`)
  info(`Total speakers:   ${speakers.length}`)

  if (utterances.length === 0) {
    fail('No utterances in DB — transcription did not complete or was not run')
    return { utterances, speakers }
  }

  ok(`${utterances.length} utterance rows in DB`)

  // Speaker ID distribution
  const countBySpeaker = new Map()
  for (const u of utterances) {
    countBySpeaker.set(u.speakerId, (countBySpeaker.get(u.speakerId) ?? 0) + 1)
  }

  const selfUtterances = selfSp ? (countBySpeaker.get(selfSp.id) ?? 0) : 0
  const remoteIds      = new Set(speakers.filter(s => !s.isSelf).map(s => s.id))
  const remoteUttCount = utterances.filter(u => remoteIds.has(u.speakerId)).length

  info(`\n  Speaker breakdown:`)
  for (const sp of speakers) {
    const count = countBySpeaker.get(sp.id) ?? 0
    const tag   = sp.isSelf ? 'self/mic' : `deepgram_${sp.deepgramId}`
    info(`    ${sp.name ?? '(unresolved)'} [${tag}]: ${count} utterance(s)`)
  }

  if (selfSp) {
    if (selfUtterances === 0) {
      warn('No utterances tagged as "You" (self/mic) — mic channel produced no transcription')
    } else {
      ok(`Mic utterances correctly tagged as "You": ${selfUtterances}`)
    }
  } else {
    fail('No self-speaker row found — createSelfSpeaker() was not called')
  }

  if (remoteIds.size === 0) {
    warn('No remote speaker rows — system audio either produced no speech or was not diarised')
  } else {
    ok(`System audio diarised into ${remoteIds.size} remote speaker(s), ${remoteUttCount} utterances`)
  }

  // Timeline check — are timestamps monotonically sane?
  let outOfOrder = 0
  for (let i = 1; i < utterances.length; i++) {
    if (utterances[i].startMs < utterances[i-1].startMs - 500) outOfOrder++
  }
  if (outOfOrder > 0) {
    warn(`${outOfOrder} utterance(s) have start_ms earlier than the previous utterance (> 500ms gap) — possible merge issue`)
  } else {
    ok('Utterance timestamps are in chronological order')
  }

  // Show full transcript
  info('\n  Full transcript:')
  const nameMap = new Map(speakers.map(s => [s.id, s.name ?? (s.isSelf ? 'You' : `deepgram_${s.deepgramId}`)]))
  for (const u of utterances) {
    const name = nameMap.get(u.speakerId) ?? '?'
    info(`    [${msToTime(u.startMs)}–${msToTime(u.endMs)}] ${name}: "${u.text}"`)
  }

  return { utterances, speakers }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Speaker Inference
// ─────────────────────────────────────────────────────────────────────────────

function checkSpeakerInference(meetingId, speakers, db) {
  header('3. Speaker Inference — resolved names and confidence')

  const meeting = db.getMeetingById(meetingId)
  const remotes = speakers.filter(s => !s.isSelf)

  info(`Meeting requiresManualLabelling: ${meeting.requiresManualLabelling}`)
  info(`Remote speakers: ${remotes.length}`)
  info('')

  for (const sp of speakers) {
    const tag = sp.isSelf ? 'self' : `deepgram_${sp.deepgramId}`

    if (sp.isSelf) {
      info(`  You [${tag}]  — always resolved (mic stream)`)
      ok('Self-speaker correctly set to "You"')
      continue
    }

    if (!sp.name) {
      fail(`Speaker [${tag}] has no resolved name — inference failed and was not manually labelled`)
      continue
    }

    // Infer the method used from the confidence value
    let method = '?'
    if (sp.confidence === 'high') {
      // Could be voice-profile match or self-intro — check for voice profile
      const profile = db.getVoiceProfileByName(sp.name)
      method = profile ? `voice-profile match (${profile.sampleCount} sample(s))` : 'self-introduction heuristic'
    } else if (sp.confidence === 'medium') {
      method = 'direct-address heuristic'
    } else if (sp.confidence === 'low') {
      method = 'elimination (calendar attendee list)'
    } else if (sp.confidence === 'manual') {
      method = 'user labelled manually'
    }

    info(`  ${sp.name} [${tag}]  confidence=${sp.confidence}  method=${method}  email=${sp.email ?? 'none'}`)
    ok(`[deepgram_${sp.deepgramId}] → "${sp.name}"  (${sp.confidence}, ${method})`)
  }

  if (meeting.requiresManualLabelling) {
    warn('meeting.requires_manual_labelling = 1 — some speakers were not resolved before extraction')
  }

  const unresolved = remotes.filter(s => !s.name)
  if (unresolved.length > 0) {
    fail(`${unresolved.length} remote speaker(s) still unresolved: ${unresolved.map(s => `deepgram_${s.deepgramId}`).join(', ')}`)
  } else if (remotes.length > 0) {
    ok(`All ${remotes.length} remote speaker(s) resolved`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. LLM Extraction
// ─────────────────────────────────────────────────────────────────────────────

function checkLlmExtraction(meetingId, speakers, db) {
  header('4. LLM Extraction — tasks, decisions, summary, comms')

  const payload = db.getMeetingReviewPayload(meetingId)
  const nameMap = new Map(speakers.map(s => [s.id, s.name ?? '?']))

  // ── Tasks ───────────────────────────────────────────────────────────────────
  info(`Tasks (${payload.tasks.length}):`)
  if (payload.tasks.length === 0) {
    warn('No tasks extracted — either extraction was not run or the transcript had no commitments')
  } else {
    for (const t of payload.tasks) {
      const assignee = t.assigneeSpeakerId ? (nameMap.get(t.assigneeSpeakerId) ?? 'MISSING SPEAKER') : 'Unassigned'
      const deadlineStr = t.deadlineMs
        ? `${t.deadlineText ?? ''} → ${new Date(t.deadlineMs).toLocaleDateString()}`
        : (t.deadlineText ? `"${t.deadlineText}" → not resolved` : 'none')

      info(`\n  • ${t.title}`)
      info(`    Assignee:   ${assignee}${t.assigneeSpeakerId ? '' : '  ← ⚠ Unassigned'}`)
      info(`    Deadline:   ${deadlineStr}`)
      info(`    Confidence: ${t.extractionConfidence ?? 'n/a'}`)
      info(`    Status:     ${t.status}`)
      info(`    Quote:      "${(t.transcriptQuote ?? '').slice(0, 100)}${(t.transcriptQuote ?? '').length > 100 ? '…' : ''}"`)

      if (!t.assigneeSpeakerId) {
        warn(`Task "${t.title.slice(0,50)}" has no assignee — LLM could not infer owner`)
      } else if (assignee === 'MISSING SPEAKER') {
        fail(`Task "${t.title.slice(0,50)}" has assignee_speaker_id ${t.assigneeSpeakerId} that does NOT exist in speakers table`)
      } else {
        ok(`Task "${t.title.slice(0,50)}" assigned to ${assignee} (${t.extractionConfidence})`)
      }
    }
  }

  // ── Decisions ───────────────────────────────────────────────────────────────
  info(`\nDecisions (${payload.decisions.length}):`)
  if (payload.decisions.length === 0) {
    warn('No decisions extracted — either extraction was not run or the meeting had no decisions')
  } else {
    for (const d of payload.decisions) {
      info(`  • ${d.text}`)
    }
    ok(`${payload.decisions.length} decision(s) extracted`)
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  info('\nSummary:')
  const summary = payload.meeting.summary
  if (!summary) {
    warn('meeting.summary is null — summary generation was not run or failed')
  } else {
    info(`  "${summary}"`)
    const sentenceCount = (summary.match(/[.!?]+/g) ?? []).length
    if (sentenceCount < 3) {
      warn(`Summary is short (${sentenceCount} sentence(s)) — expected 3–5`)
    } else {
      ok(`Summary generated (${sentenceCount} sentence(s), ${summary.length} chars)`)
    }
  }

  // ── Comms ────────────────────────────────────────────────────────────────────
  info(`\nComms (${payload.comms.length}):`)
  if (payload.comms.length === 0) {
    info('  (none — either no confirmed tasks with named assignees, or comms not yet generated)')
  } else {
    for (const c of payload.comms) {
      const recipient = nameMap.get(c.recipientSpeakerId) ?? `MISSING (${c.recipientSpeakerId})`
      info(`\n  ● ${recipient}  channel=${c.deliveryChannel}  hasCornflake=${c.hasCornflake}  send=${c.send}  sentAt=${c.sentAt ?? 'null'}`)
      info(`    "${c.messageBody}"`)
      if (!c.messageBody || c.messageBody.trim().length < 10) {
        fail(`Comms for ${recipient} has an empty or trivially short message body`)
      } else {
        ok(`Comms message for ${recipient} (${c.messageBody.length} chars)`)
      }
    }
  }

  return payload
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. DB Integrity
// ─────────────────────────────────────────────────────────────────────────────

function checkDbIntegrity(meetingId, db) {
  header('5. DB Integrity — referential consistency')

  const rdb = rawDb()

  try {
    // 5a. All task assignee_speaker_ids point to valid speaker rows
    const orphanTasks = rdb.prepare(`
      SELECT t.id, t.title, t.assignee_speaker_id
      FROM tasks t
      WHERE t.meeting_id = ?
        AND t.assignee_speaker_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM speakers s WHERE s.id = t.assignee_speaker_id)
    `).all(meetingId)

    if (orphanTasks.length > 0) {
      for (const t of orphanTasks) {
        fail(`Task "${t.title?.slice(0,50)}" (${t.id}) has dangling assignee_speaker_id=${t.assignee_speaker_id}`)
      }
    } else {
      ok('All task assignee_speaker_ids reference valid speaker rows')
    }

    // 5b. All utterances have valid speaker_id references
    const orphanUtterances = rdb.prepare(`
      SELECT u.id, u.speaker_id, substr(u.text,1,40) AS snippet
      FROM utterances u
      WHERE u.meeting_id = ?
        AND NOT EXISTS (SELECT 1 FROM speakers s WHERE s.id = u.speaker_id)
    `).all(meetingId)

    if (orphanUtterances.length > 0) {
      for (const u of orphanUtterances) {
        fail(`Utterance "${u.snippet}" (${u.id}) has dangling speaker_id=${u.speaker_id}`)
      }
    } else {
      ok('All utterance speaker_ids reference valid speaker rows')
    }

    // 5c. Comms rows exist for each unique confirmed-task assignee (excluding self)
    const confirmedAssignees = rdb.prepare(`
      SELECT DISTINCT t.assignee_speaker_id
      FROM tasks t
      JOIN speakers s ON s.id = t.assignee_speaker_id
      WHERE t.meeting_id = ?
        AND t.status = 'confirmed'
        AND s.is_self = 0
        AND s.name IS NOT NULL
    `).all(meetingId).map(r => r.assignee_speaker_id)

    if (confirmedAssignees.length === 0) {
      info('  No confirmed tasks with named non-self assignees — comms coverage check skipped')
    } else {
      for (const spId of confirmedAssignees) {
        const hasComm = rdb.prepare(`
          SELECT 1 FROM comms WHERE meeting_id = ? AND recipient_speaker_id = ? LIMIT 1
        `).get(meetingId, spId)

        const spName = rdb.prepare(`SELECT name FROM speakers WHERE id = ?`).get(spId)?.name ?? spId

        if (!hasComm) {
          fail(`No comms row for confirmed-task assignee "${spName}" (${spId})`)
        } else {
          ok(`Comms row exists for "${spName}"`)
        }
      }
    }

    // 5d. meeting.summary is populated
    const meetingRow = rdb.prepare(`SELECT summary, confirmed_at FROM meetings WHERE id = ?`).get(meetingId)
    if (!meetingRow?.summary) {
      warn('meeting.summary is NULL — LLM extraction summary step did not complete')
    } else {
      ok(`meeting.summary is populated (${meetingRow.summary.length} chars)`)
    }

    // 5e. meeting.confirmed_at is still null (not yet confirmed)
    if (meetingRow?.confirmed_at !== null && meetingRow?.confirmed_at !== undefined) {
      warn(`meeting.confirmed_at is set (${new Date(meetingRow.confirmed_at).toLocaleString()}) — meeting is already confirmed`)
      info('  This is only expected if "Confirm & send" was clicked during a previous test run.')
    } else {
      ok('meeting.confirmed_at is null (meeting in draft — not yet confirmed)')
    }

    // 5f. Decisions table
    const decisionCount = rdb.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE meeting_id = ?`).get(meetingId).n
    if (decisionCount === 0) {
      warn('No decision rows for this meeting — extraction may not have run or found no decisions')
    } else {
      ok(`${decisionCount} decision row(s) in DB`)
    }

    // 5g. No duplicate utterances (same speaker + start_ms)
    const dupeUtterances = rdb.prepare(`
      SELECT speaker_id, start_ms, COUNT(*) AS n
      FROM utterances
      WHERE meeting_id = ?
      GROUP BY speaker_id, start_ms
      HAVING n > 1
    `).all(meetingId)

    if (dupeUtterances.length > 0) {
      for (const d of dupeUtterances) {
        fail(`Duplicate utterance: speaker_id=${d.speaker_id} start_ms=${d.start_ms} appears ${d.n} times`)
      }
    } else {
      ok('No duplicate utterances (speaker + timestamp uniqueness)')
    }

    // 5h. No comms already sent (sent_at should be null at this stage)
    const sentComms = rdb.prepare(`
      SELECT recipient_speaker_id FROM comms WHERE meeting_id = ? AND sent_at IS NOT NULL
    `).all(meetingId)
    if (sentComms.length > 0) {
      warn(`${sentComms.length} comms row(s) already marked sent — "Confirm & send" may have been clicked`)
    } else {
      ok('No comms dispatched yet (sent_at = null on all rows)')
    }

  } finally {
    rdb.close()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║           Cornflake — Full Pipeline Check                   ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')

  initDatabase()
  const db = getDb()

  // ── Find target meeting ───────────────────────────────────────────────────
  let meetingId = meetingIdArg

  if (!meetingId) {
    const rdb = rawDb()
    const row = rdb.prepare(`
      SELECT id, title, start_ms FROM meetings ORDER BY start_ms DESC LIMIT 1
    `).get()
    rdb.close()

    if (!row) {
      fail('No meetings in DB — record a meeting first')
      process.exit(1)
    }
    meetingId = row.id
  }

  const meeting = db.getMeetingById(meetingId)
  if (!meeting) {
    fail(`Meeting not found: ${meetingId}`)
    process.exit(1)
  }

  console.log(`\n  Target meeting: "${meeting.title}"`)
  console.log(`  ID:    ${meeting.id}`)
  console.log(`  Start: ${new Date(meeting.startMs).toLocaleString()}`)
  console.log(`  End:   ${meeting.endMs ? new Date(meeting.endMs).toLocaleString() : 'still recording'}`)

  // ── Run all checks ────────────────────────────────────────────────────────
  checkAudio(meetingId, meeting.startMs)

  const { utterances, speakers } = checkTranscription(meetingId, db)

  checkSpeakerInference(meetingId, speakers, db)

  checkLlmExtraction(meetingId, speakers, db)

  checkDbIntegrity(meetingId, db)

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(62)}`)
  console.log(`  ✓ ${PASS} passed   ⚠ ${WARN} warnings   ✗ ${FAIL} failed`)

  if (issues.length > 0) {
    console.log('\n  Issues flagged:')
    for (const i of issues) {
      const sym = i.level === 'fail' ? '✗' : '⚠'
      console.log(`    ${sym}  ${i.msg}`)
    }
  }

  if (FAIL > 0) {
    console.log('\n  Pipeline has FAILURES — see ✗ lines above')
    console.log(`${'═'.repeat(62)}\n`)
    process.exit(1)
  } else if (WARN > 0) {
    console.log('\n  Pipeline passed with warnings — see ⚠ lines above')
    console.log(`${'═'.repeat(62)}\n`)
    process.exit(0)
  } else {
    console.log('\n  Pipeline is fully clean ✓')
    console.log(`${'═'.repeat(62)}\n`)
    process.exit(0)
  }
}

main().catch(err => {
  console.error('\n[pipeline-check] Fatal:', err.message || err)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
