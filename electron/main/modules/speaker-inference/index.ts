// Module 6 — Speaker Inference
// Maps anonymous Deepgram speaker IDs to real names using:
//   Stage 1 — Transcript context heuristics (self-intro, direct address)
//   Stage 2 — Unresolved speakers labelled "Speaker 1/2/…"; meeting flagged
//
// Cross-meeting voice recognition (resemblyzer voice-profile embeddings)
// was removed for the beta. Stage 1 + Stage 2 still identify speakers within
// a single meeting via transcript heuristics; unmatched speakers fall through
// to "Speaker N" labels and can be resolved manually by the user.
//
// `updateVoiceProfiles` is preserved as a no-op so existing IPC handlers and
// renderer call sites (SpeakerLabeller's confirm/resolve flow) keep their
// contract without writing any embeddings.

import { getDb } from '../database'
import type { TranscriptUtterance } from '../transcription'
import type { Confidence } from '../database/types'

// ---------------------------------------------------------------------------
// Transcript context inference patterns
// ---------------------------------------------------------------------------

// No `i` flag — [A-Z] must be a literal uppercase letter so "I'm gonna" (lowercase g)
// never captures "gonna" as a name. Intro phrase handles both "My" and "my" explicitly.
const SELF_INTRO_RE  = /\b(?:I'm|I am|[Mm]y name is)\s+([A-Z][a-zA-Z]+)\b/
const DIRECT_ADDR_RE = /^([A-Z][a-z]{1,})[,.\s]/

// All stored lowercase — compared via .toLowerCase() so casing in transcript doesn't matter.
const FILLER_WORDS_LOWER = new Set([
  // discourse markers and fillers
  'so', 'well', 'ok', 'okay', 'right', 'sure', 'yeah', 'yes', 'no', 'oh',
  'ah', 'um', 'uh', 'hi', 'hello', 'hey', 'thanks', 'thank', 'and', 'but',
  'also', 'actually', 'great', 'good', 'nice', 'cool', 'alright', 'anyway',
  'basically', 'honestly', 'literally', 'look', 'listen',
  // contractions-turned-words that appear after "I'm"
  'gonna', 'gotta', 'wanna',
  // articles, pronouns, prepositions, conjunctions
  'the', 'this', 'that', 'we', 'it', 'its', 'just', 'let', 'now', 'as',
  'if', 'when', 'what', 'how', 'why', 'who', 'where', 'which', 'all',
  'any', 'my', 'our', 'your', 'their', 'or', 'not', 'from', 'for', 'with',
  // auxiliary and question-starting verbs — common at sentence start, never names
  'is', 'are', 'was', 'were', 'have', 'has', 'had', 'do', 'does', 'did',
  'can', 'could', 'will', 'would', 'should', 'may', 'might', 'must', 'shall',
])

function isValidName(candidate: string): boolean {
  return (
    candidate.length >= 2 &&
    /^[A-Z]/.test(candidate) &&
    !/\s/.test(candidate) &&
    !FILLER_WORDS_LOWER.has(candidate.toLowerCase())
  )
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UnresolvedSpeaker {
  id:         string   // DB UUID
  deepgramId: string   // e.g. "0"
  label:      string   // "Speaker 1", "Speaker 2" …
}

export interface SpeakerInferenceResult {
  unresolvedSpeakers:      UnresolvedSpeaker[]
  requiresManualLabelling: boolean
}

// ---------------------------------------------------------------------------
// inferSpeakers — main entry point (called after transcription completes)
// ---------------------------------------------------------------------------

export async function inferSpeakers(
  transcript:       TranscriptUtterance[],
  meetingId:        string,
  _systemAudioPath: string,  // signature preserved; unused (no voice-profile lookup)
): Promise<SpeakerInferenceResult> {
  const db = getDb()
  const speakers = db.getSpeakersByMeeting(meetingId)
  const remotes  = speakers.filter(s => !s.isSelf && s.name === null)

  if (remotes.length === 0) {
    db.setMeetingRequiresLabelling(meetingId, false)
    return { unresolvedSpeakers: [], requiresManualLabelling: false }
  }

  // deepgramId → speaker DB row
  const byDgId = new Map(remotes.map(s => [s.deepgramId!, s]))

  // Accumulate assignments here before writing to DB
  const resolved = new Map<string, { name: string; confidence: Confidence }>()

  // ---------------------------------------------------------------------------
  // Stage 1 — Transcript context inference (heuristics)
  // ---------------------------------------------------------------------------

  // Operate on remote utterances only, in chronological order
  const remoteUtt = transcript.filter(u => u.speakerId !== 'you')

  for (let i = 0; i < remoteUtt.length; i++) {
    const u    = remoteUtt[i]
    const dgId = u.speakerId.replace('deepgram_', '')
    if (!byDgId.has(dgId) || resolved.has(dgId)) continue

    // 1a. Self-introduction: "I'm Sarah", "My name is John"
    const selfM = u.text.match(SELF_INTRO_RE)
    if (selfM && isValidName(selfM[1])) {
      resolved.set(dgId, { name: selfM[1], confidence: 'high' })
      console.log(`[speaker-inference] Self-intro: deepgram_${dgId} → ${selfM[1]}`)
      continue
    }

    // 1b. Direct address at utterance start → previous speaker is the named person
    // e.g. "Sarah, let me add to that" implies the previous speaker is Sarah
    if (i > 0) {
      const prevDgId = remoteUtt[i - 1].speakerId.replace('deepgram_', '')
      if (byDgId.has(prevDgId) && !resolved.has(prevDgId)) {
        const addrM = u.text.match(DIRECT_ADDR_RE)
        if (addrM && isValidName(addrM[1])) {
          resolved.set(prevDgId, { name: addrM[1], confidence: 'medium' })
          console.log(`[speaker-inference] Direct address: deepgram_${prevDgId} → ${addrM[1]}`)
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 2 — DB updates + "Speaker N" labelling of leftovers
  // ---------------------------------------------------------------------------

  for (const [dgId, { name, confidence }] of resolved) {
    const sp = byDgId.get(dgId)
    if (sp) db.resolveSpeaker(sp.id, name, confidence)
  }

  const stillUnresolved = remotes.filter(s => !resolved.has(s.deepgramId!))
  const requiresManualLabelling = stillUnresolved.length > 0
  db.setMeetingRequiresLabelling(meetingId, requiresManualLabelling)

  // Sort by numeric deepgram_id so numbers are stable: "0"→1, "1"→2 …
  const sorted = [...stillUnresolved].sort((a, b) => parseInt(a.deepgramId!) - parseInt(b.deepgramId!))
  const unresolvedSpeakers: UnresolvedSpeaker[] = sorted.map((sp, idx) => ({
    id:         sp.id,
    deepgramId: sp.deepgramId!,
    label:      `Speaker ${idx + 1}`,
  }))

  console.log(
    `[speaker-inference] ${resolved.size}/${remotes.length} resolved.` +
    (unresolvedSpeakers.length ? ` Unresolved: ${unresolvedSpeakers.map(s => s.label).join(', ')}` : '')
  )

  return { unresolvedSpeakers, requiresManualLabelling }
}

// ---------------------------------------------------------------------------
// updateVoiceProfiles — no-op stub (cross-meeting voice recognition removed)
// ---------------------------------------------------------------------------

export async function updateVoiceProfiles(
  _corrections:    Array<{ speakerId: string; name: string; email?: string }>,
  _meetingId:      string,
  _systemAudioPath: string,
): Promise<void> {
  // Intentionally empty. Renderer/IPC callers (SPEAKERS_CONFIRM, SPEAKERS_RESOLVE,
  // PROFILES_UPDATE) still call this; the function preserves its signature so
  // existing call sites compile and run without modification.
}
