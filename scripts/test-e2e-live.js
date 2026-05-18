/**
 * test-e2e-live.js — end-to-end Module 6 test with real audio capture.
 *
 * Drives the full pipeline without the GUI:
 *   startCapture() → play synthesized speech → stopCapture()
 *   → runTranscriptionPipeline() → inferSpeakers() → inspect DB
 *
 * Audio is produced via macOS `say` (system TTS) with two distinct voices
 * so ScreenCaptureKit + Deepgram diarization can separate them.
 *
 * Usage:
 *   electron --no-sandbox scripts/test-e2e-live.js
 *
 * Requirements: DEEPGRAM_API_KEY in .env, Screen Recording permission granted.
 */

const path    = require('path')
const fs      = require('fs')
const cp      = require('child_process')

const PROJECT_ROOT = path.resolve(__dirname, '..')
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') })

const { app } = require('electron')
app.setName('cornflake')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function playLine(voice, text) {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn('say', ['-v', voice, text])
    proc.on('exit', code => (code === 0 ? resolve() : reject(new Error(`say exited ${code}`))))
    proc.on('error', reject)
  })
}

let PASS = 0, FAIL = 0
function ok(cond, msg) {
  if (cond) { console.log(`  ✓  ${msg}`); PASS++ }
  else       { console.error(`  ✗  FAIL: ${msg}`); FAIL++ }
}
function note(msg) { console.log(`     ${msg}`) }
function section(title) { console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`) }

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  const { initDatabase, closeDatabase, getDb } = require(path.join(PROJECT_ROOT, 'dist/main/modules/database'))
  const { startCapture, stopCapture }           = require(path.join(PROJECT_ROOT, 'dist/main/modules/audio-capture'))
  const { runTranscriptionPipeline }            = require(path.join(PROJECT_ROOT, 'dist/main/modules/transcription'))
  const { inferSpeakers }                       = require(path.join(PROJECT_ROOT, 'dist/main/modules/speaker-inference'))
  const { stopSidecar }                         = require(path.join(PROJECT_ROOT, 'dist/main/sidecar/spawn'))

  initDatabase()
  const db = getDb()

  // ── 1. Create meeting record ──────────────────────────────────────────────

  section('1. Creating meeting + starting capture')

  const meeting = db.createMeeting('Live Audio E2E Test')
  db.createSelfSpeaker(meeting.id)
  note(`Meeting id: ${meeting.id}`)

  note('Starting audio capture (SCStream + AVAudioEngine)…')
  await startCapture().catch(err => {
    console.error('startCapture() failed:', err.message)
    console.error('Ensure Screen Recording permission is granted for this Electron binary.')
    process.exit(1)
  })
  note('Capture started. Waiting 1s before playing audio…')
  await sleep(1000)

  // ── 2. Play multi-speaker synthesized audio ───────────────────────────────

  section('2. Playing synthesised speech (two voices, ~50s)')

  // We use two clearly distinct macOS voices.
  // Self-introduction patterns in the script ensure the inference triggers.
  const VOICE_A = 'Samantha'  // default high-quality female voice
  const VOICE_B = 'Daniel'    // British English male voice (clearly different pitch)

  const lines = [
    // Samantha introduces herself → self-intro pattern fires (high confidence)
    [VOICE_A, "Hi everyone, welcome to today's product review. My name is Samantha and I'm the product lead here."],
    // Daniel introduces himself → self-intro pattern fires (high confidence)
    [VOICE_B, "Thanks Samantha. I'm Daniel from the engineering team and I'll be covering the technical updates today."],
    // Samantha addresses Daniel by name → direct-address confirms (already resolved)
    [VOICE_A, "Daniel, could you start by walking us through the architecture changes from last quarter?"],
    // Daniel responds
    [VOICE_B, "Sure. We made three major improvements to the data pipeline. Throughput is up forty percent."],
    // Samantha summarises
    [VOICE_A, "That's impressive. What was the biggest technical challenge you faced?"],
    // Daniel answers
    [VOICE_B, "The main challenge was memory management during peak load. We rewrote the ingestion layer."],
    // Samantha wraps up
    [VOICE_A, "Excellent. Let's open it up for questions. Does anyone have anything for Daniel or me?"],
    // Daniel adds context
    [VOICE_B, "I'd also add that we improved test coverage significantly. Now at ninety two percent."],
  ]

  for (const [voice, text] of lines) {
    note(`[${voice}]: "${text.slice(0, 60)}…"`)
    await playLine(voice, text)
    await sleep(400)
  }

  note('Audio playback complete.')
  await sleep(1000)  // let the last words flush to the capture buffer

  // ── 3. Stop capture → transcription → inference ───────────────────────────

  section('3. Stopping capture and running pipeline')

  note('Stopping capture…')
  let paths
  try {
    paths = await stopCapture()
  } catch (err) {
    console.error('stopCapture() failed:', err.message)
    process.exit(1)
  }

  db.finalizeMeeting(meeting.id, Date.now())

  const micSize = fs.statSync(paths.micPath).size
  const sysSize = fs.statSync(paths.systemAudioPath).size
  note(`mic WAV:  ${paths.micPath.split('/').pop()}  (${(micSize/1024).toFixed(0)} KB)`)
  note(`sys WAV:  ${paths.systemAudioPath.split('/').pop()}  (${(sysSize/1024).toFixed(0)} KB)`)

  ok(sysSize > 50_000, `System audio captured: ${(sysSize/1024).toFixed(0)} KB (> 50 KB)`)

  // Transcription
  note('\nSending to Deepgram (transcription + diarisation)…')
  let transcript
  try {
    transcript = await runTranscriptionPipeline(paths, meeting.id)
  } catch (err) {
    console.error('Transcription pipeline failed:', err.message)
    process.exit(1)
  }

  const remote = transcript.filter(u => u.speakerId !== 'you')
  const self_  = transcript.filter(u => u.speakerId === 'you')
  note(`Transcript: ${transcript.length} utterances total (${remote.length} remote, ${self_.length} mic)`)

  ok(transcript.length > 0,  `Deepgram returned ${transcript.length} utterance(s)`)
  ok(remote.length > 0,      `At least 1 system-audio utterance (got ${remote.length})`)

  if (remote.length > 0) {
    const diarIds = [...new Set(remote.map(u => u.speakerId))]
    note(`Deepgram speaker IDs detected: ${diarIds.join(', ')}`)
    ok(diarIds.length >= 2, `At least 2 distinct remote speakers diarised (got ${diarIds.length})`)
  }

  // Speaker inference
  note('\nRunning speaker inference…')
  const result = await inferSpeakers(transcript, meeting.id, paths.systemAudioPath)

  // ── 4. DB inspection ──────────────────────────────────────────────────────

  section('4. DB inspection — speaker rows')

  const speakers   = db.getSpeakersByMeeting(meeting.id)
  const utterances = db.getUtterancesByMeeting(meeting.id)

  console.log('\n  Speaker rows:')
  speakers.forEach(s => {
    const label = s.isSelf ? '(self)' : `deepgram_${s.deepgramId}`
    console.log(`    [${label}]  name=${s.name ?? 'null'}  confidence=${s.confidence ?? 'null'}`)
  })

  const remoteSpeakers = speakers.filter(s => !s.isSelf)
  const resolved       = remoteSpeakers.filter(s => s.name !== null)

  note(`\n  Remote speakers:  ${remoteSpeakers.length} total,  ${resolved.length} resolved`)
  note(`  Unresolved:       ${result.unresolvedSpeakers.length}`)
  if (result.unresolvedSpeakers.length > 0) {
    result.unresolvedSpeakers.forEach(s => note(`    ${s.label}  id=${s.id}`))
  }

  const meetingRow = db.getMeetingById(meeting.id)
  note(`  requires_manual_labelling: ${meetingRow.requiresManualLabelling}`)

  // Utterance → speaker linkage
  section('5. Utterance → speaker linkage check')

  const spMap = new Map(speakers.map(s => [s.id, s]))
  console.log('\n  Utterances (chronological):')
  for (const u of utterances.slice(0, 12)) {
    const sp   = spMap.get(u.speakerId)
    const who  = sp?.isSelf ? 'You' : (sp?.name ?? sp?.deepgramId ?? '?')
    const conf = sp?.confidence ?? (sp?.isSelf ? 'self' : 'unresolved')
    console.log(`    [${who}/${conf}] ${u.startMs}ms: "${u.text.slice(0, 70)}…"`)
  }
  if (utterances.length > 12) note(`    … and ${utterances.length - 12} more`)

  // All utterance speaker_ids must point to a valid speaker row in this meeting
  const validSpeakerIds = new Set(speakers.map(s => s.id))
  const badLinks = utterances.filter(u => !validSpeakerIds.has(u.speakerId))
  ok(badLinks.length === 0, `All ${utterances.length} utterances have valid speaker_id references`)

  // Each remote utterance speaker_id points to a remote speaker row
  const remoteUtterances = utterances.filter(u => {
    const sp = spMap.get(u.speakerId)
    return sp && !sp.isSelf
  })
  ok(remoteUtterances.length > 0, `At least 1 utterance linked to a remote speaker (got ${remoteUtterances.length})`)

  // ── 5. Inference quality assertions ───────────────────────────────────────

  section('6. Inference assertions')

  // We should have detected at least 2 remote speakers
  ok(remoteSpeakers.length >= 2, `≥2 remote speaker rows in DB (got ${remoteSpeakers.length})`)

  // At least one speaker should have been resolved by context inference
  // (Samantha and Daniel both introduce themselves — high confidence expected)
  const highConf = resolved.filter(s => s.confidence === 'high')
  ok(highConf.length >= 1, `At least 1 speaker resolved with high confidence (got ${highConf.length})`)

  if (resolved.length > 0) {
    note(`Resolved speakers:`)
    resolved.forEach(s => note(`  deepgram_${s.deepgramId} → ${s.name} (${s.confidence})`))
  }

  // Check for Samantha and Daniel specifically (if diarisation separated them)
  const samanthaRow = resolved.find(s => s.name === 'Samantha')
  const danielRow   = resolved.find(s => s.name === 'Daniel')

  if (samanthaRow) {
    ok(samanthaRow.confidence === 'high', `Samantha resolved with high confidence (self-intro)`)
  } else {
    note('⚠  "Samantha" not found in resolved speakers — diarisation may have split her utterances')
  }

  if (danielRow) {
    ok(danielRow.confidence === 'high', `Daniel resolved with high confidence (self-intro)`)
  } else {
    note('⚠  "Daniel" not found in resolved speakers — diarisation may have split his utterances')
  }

  // If requires_manual_labelling is true, the SpeakerLabeller should appear in the real app
  if (meetingRow.requiresManualLabelling) {
    note('requires_manual_labelling = true — SpeakerLabeller interstitial would appear in app')
  } else {
    ok(!meetingRow.requiresManualLabelling, 'requires_manual_labelling = false (all resolved)')
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  section('Summary')

  stopSidecar()
  closeDatabase()

  // Remove temp audio files
  fs.unlink(paths.micPath, () => {})
  fs.unlink(paths.systemAudioPath, () => {})
  note('Temp audio files deleted.')

  console.log(`\n  ${'═'.repeat(54)}`)
  console.log(`  TOTAL: ${PASS} passed  /  ${FAIL} failed`)

  if (FAIL > 0) {
    console.error('\n  ⚠  Some assertions FAILED — see ✗ lines above')
    process.exit(1)
  } else {
    console.log('\n  ✓  All assertions passed — Module 6 end-to-end verified')
    process.exit(0)
  }
})
