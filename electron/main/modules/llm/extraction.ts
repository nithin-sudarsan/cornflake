// Module 5 — LLM Extraction (via backend API)
// Runs extraction (tasks, decisions, summary) through the Cornflake backend.
// LLM speaker inference is also attempted via the backend response.
// Comms copy is generated with a template (no direct LLM call needed).

import { getDb } from '../database/index.js'
import { apiPost } from '../api-client/index.js'
import type { LLMProvider } from './provider.js'
import type {
  ReviewPayload, Comm, NewTask, NewComm, Speaker, Utterance,
  Queries,
} from '../database/index.js'
import type { TranscriptUtterance } from '../transcription/index.js'

// ---------------------------------------------------------------------------
// Internal LLM response shapes (used for speaker inference fallback)
// ---------------------------------------------------------------------------

interface RawTask {
  title:          string
  assigneeName:   string | null
  deadlineText:   string | null
  deadlineIso:    string | null
  confidence:     'high' | 'medium' | 'low'
  transcriptQuote: string
}

interface SpeakerInferenceRaw {
  speakers: Array<{
    deepgramId: string
    inferredName: string | null
    confidence: 'high' | 'medium' | 'low'
    reasoning: string
  }>
}

// ---------------------------------------------------------------------------
// 0. LLM speaker inference (kept for speaker-inference module compatibility)
// Now attempts via backend extract call; falls back gracefully on failure.
// ---------------------------------------------------------------------------

export interface LLMSpeakerResult {
  deepgramId: string
  inferredName: string | null
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
}

export async function inferSpeakersWithLLM(
  transcript: TranscriptUtterance[],
  unresolvedDeepgramIds: string[],
  opts?: { provider?: LLMProvider },
): Promise<LLMSpeakerResult[]> {
  if (unresolvedDeepgramIds.length === 0) return []

  try {
    const excerpted = transcript.slice(0, 80).map(u => ({
      speakerId: u.speakerId,
      text: u.text,
      startMs: u.startMs,
      endMs: u.endMs,
    }))

    const result = await apiPost('/api/extract', {
      transcript:    excerpted,
      meetingTitle:  'speaker inference',
      speakers:      unresolvedDeepgramIds.map(id => ({ id, name: null, isSelf: false })),
      mode:          'speaker_inference_only',
    })

    const speakerInference = result?.speakerInference
    if (!Array.isArray(speakerInference)) return []

    return speakerInference.filter((s: any) => typeof s.deepgramId === 'string')
  } catch (err) {
    console.warn('[llm-extraction] LLM speaker inference via backend failed:', (err as Error).message)
    return []
  }
}

// ---------------------------------------------------------------------------
// Email → company inference. We use the email domain as a cheap proxy for
// "what company does this person represent" — good enough for the LLM to use
// as context ("X from Acme said …"). Free-mail providers don't carry that
// signal, so we skip them and return null instead.
// ---------------------------------------------------------------------------

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'aol.com', 'gmx.com', 'gmx.de', 'fastmail.com',
])

function companyFromEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain || FREE_EMAIL_DOMAINS.has(domain)) return null
  // basegraph.co → "Basegraph". Good enough as a rough display label.
  const base = domain.split('.')[0]
  if (!base) return null
  return base.charAt(0).toUpperCase() + base.slice(1)
}

// ---------------------------------------------------------------------------
// Transcript formatting (used when building the payload for /api/extract)
// ---------------------------------------------------------------------------

function msToTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function buildTranscriptArray(utterances: Utterance[], speakers: Speaker[]): Array<{ speakerId: string; text: string; startMs: number; endMs: number }> {
  const remotes = speakers.filter(s => !s.isSelf && s.deepgramId !== null)
    .sort((a, b) => parseInt(a.deepgramId!) - parseInt(b.deepgramId!))
  const unresolvedIndex = new Map(remotes.filter(s => !s.name).map((s, i) => [s.id, i + 1]))

  const nameMap = new Map(
    speakers.map(s => {
      if (s.isSelf || s.deepgramId === null) return [s.id, 'You']
      if (s.name) return [s.id, s.name]
      const n = unresolvedIndex.get(s.id) ?? 1
      return [s.id, `Speaker ${n}`]
    })
  )

  return utterances.map(u => ({
    speakerId: nameMap.get(u.speakerId) ?? 'Unknown',
    text: u.text,
    startMs: u.startMs,
    endMs: u.endMs,
  }))
}

// ---------------------------------------------------------------------------
// Speaker name → DB ID matching
// ---------------------------------------------------------------------------

function matchSpeakerByName(name: string | null, speakers: Speaker[]): string | null {
  if (!name) return null
  const lower = name.toLowerCase()
  const exact = speakers.find(s => s.name?.toLowerCase() === lower)
  if (exact) return exact.id
  const partial = speakers.find(s =>
    s.name?.toLowerCase().startsWith(lower) || lower.startsWith(s.name?.toLowerCase() ?? '___')
  )
  return partial?.id ?? null
}

// ---------------------------------------------------------------------------
// Comms copy — template-based (LLM API keys removed from Electron)
// ---------------------------------------------------------------------------

function buildCommsMessage(
  recipientName: string,
  meetingTitle: string,
  tasks: Array<{ title: string; deadlineText: string | null }>,
): string {
  const taskLines = tasks
    .map((t, i) => `${i + 1}. ${t.title}${t.deadlineText ? ` (by ${t.deadlineText})` : ''}`)
    .join('\n')

  return `${recipientName}, following up from "${meetingTitle}" — here are your action items:\n\n${taskLines}\n\nTracked by Cornflake.`
}

// ---------------------------------------------------------------------------
// Public: runExtractionPipeline
// Calls backend /api/extract, writes results to DB, returns ReviewPayload.
// ---------------------------------------------------------------------------

export async function runExtractionPipeline(
  meetingId: string,
  opts?: { db?: Queries; provider?: LLMProvider },
): Promise<ReviewPayload> {
  const db = opts?.db ?? getDb()

  const meeting = db.getMeetingById(meetingId)
  if (!meeting) throw new Error(`Meeting not found: ${meetingId}`)

  const speakers   = db.getSpeakersByMeeting(meetingId)
  const utterances = db.getUtterancesByMeeting(meetingId)

  if (utterances.length === 0) {
    console.warn(`[llm-extraction] No utterances for meeting ${meetingId} — skipping extraction`)
    return db.getMeetingReviewPayload(meetingId)
  }

  const transcriptArray = buildTranscriptArray(utterances, speakers)
  const participantNames = speakers.map(s => s.name ?? 'Unknown').filter(n => n !== 'Unknown')

  console.log(`[llm-extraction] Calling backend /api/extract for meeting "${meeting.title}" (${utterances.length} utterances)`)

  console.log(`[llm-extraction] Sending ${transcriptArray.length} utterances to /api/extract`)

  const result = await apiPost('/api/extract', {
    transcript:   transcriptArray,
    meetingTitle: meeting.title,
    speakers:     speakers.map(s => ({
      id:      s.id,
      name:    s.name,
      isSelf:  s.isSelf,
      email:   s.email ?? null,
      company: companyFromEmail(s.email),
    })),
  })

  // Log the full raw response so we can see exactly what the backend returned
  console.log('[llm-extraction] Raw backend response:', JSON.stringify(result).slice(0, 800))
  console.log('[llm-extraction] result.tasks type:', typeof result?.tasks, '| isArray:', Array.isArray(result?.tasks))

  const rawTasks:      RawTask[]       = result?.tasks     ?? []
  // Decisions: tolerate older shape (just { text }) and richer shape with
  // transcriptQuote / decidedBySpeakerId / confidence / parentIndex.
  interface RawDecision {
    text?: string
    transcriptQuote?: string | null
    decidedBySpeakerId?: string | null
    confidence?: string | null
    parentIndex?: number | null
  }
  const rawDecisions: RawDecision[] = (result?.decisions ?? [])
    .filter((d: unknown): d is RawDecision => {
      if (typeof d === 'object' && d !== null) return true
      return typeof d === 'string'   // tolerate "just a string" responses
    })
    .map((d: RawDecision | string): RawDecision =>
      typeof d === 'string' ? { text: d } : d
    )
    .filter((d: RawDecision) => typeof d.text === 'string' && d.text.trim().length > 0)
  const summaryText:   string          = result?.summary   ?? ''
  const extractedTitle: string         = (result?.title ?? '').trim()
  // result.speakerInference is intentionally ignored in v1 — single-player mode.

  console.log(`[llm-extraction] Backend title: "${extractedTitle || '(none)'}"`)
  console.log(`[llm-extraction] Parsed — tasks: ${rawTasks.length}, decisions: ${rawDecisions.length}, summary: ${summaryText.length} chars`)

  // Map extracted tasks → DB NewTask rows (with action type classification)
  const newTasks: NewTask[] = rawTasks.map(t => {
    let deadlineMs: number | null = null
    if (t.deadlineIso) {
      const parsed = Date.parse(t.deadlineIso + 'T09:00:00')
      if (!isNaN(parsed)) deadlineMs = parsed
    }

    const confidence = (['high', 'medium', 'low'] as const).includes(t.confidence as never)
      ? t.confidence as 'high' | 'medium' | 'low'
      : 'medium'

    const title = t.title.slice(0, 200)

    return {
      meetingId,
      // assigneeSpeakerId always null in v1 — tasks are implicitly the user's.
      // Column kept in DB so we can bring multi-player back in v2 without a migration.
      assigneeSpeakerId:    null,
      title,
      deadlineText:         t.deadlineText ?? null,
      deadlineMs,
      remindOffsetMs:       null,
      remindAtMs:           null,
      transcriptQuote:      t.transcriptQuote ?? null,
      extractionConfidence: confidence,
      actionType:           (t as any).action_type ?? null,
      note:                 null,
      listName:             'Reminders',
    }
  })

  if (newTasks.length > 0) {
    db.createTasks(newTasks)
    console.log(`[llm-extraction] Wrote ${newTasks.length} task(s) to DB with status='awaiting_approval'`)
    console.log('[llm-extraction] First DB task:', JSON.stringify({
      title:               newTasks[0].title,
      assigneeSpeakerId:   newTasks[0].assigneeSpeakerId,
      deadlineMs:          newTasks[0].deadlineMs,
      extractionConfidence: newTasks[0].extractionConfidence,
    }))
  } else {
    console.warn('[llm-extraction] No tasks written to DB — rawTasks was empty or mapping produced 0 rows')
  }
  if (rawDecisions.length > 0) {
    // Map backend deepgram speaker IDs ("0", "1") to local speaker row IDs so
    // the FK actually resolves. Backend uses the deepgram tag; DB references
    // speakers.id (the local row id). If a tag has no matching speaker (e.g.
    // unresolved deepgram id), we leave the field null.
    const speakersForMeeting = db.getSpeakersByMeeting(meetingId)
    const deepgramToSpeakerId = new Map<string, string>()
    for (const sp of speakersForMeeting) {
      if (sp.deepgramId != null) deepgramToSpeakerId.set(sp.deepgramId, sp.id)
    }

    db.createDecisions(rawDecisions.map(d => ({
      meetingId,
      text: d.text!.trim(),
      transcriptQuote: d.transcriptQuote ?? null,
      decidedBySpeakerId:
        d.decidedBySpeakerId != null
          ? (deepgramToSpeakerId.get(d.decidedBySpeakerId) ?? null)
          : null,
      extractionConfidence:
        d.confidence === 'high' || d.confidence === 'medium' || d.confidence === 'low'
          ? d.confidence
          : null,
      parentIndex: typeof d.parentIndex === 'number' ? d.parentIndex : null,
    })))
  }
  if (summaryText) {
    db.updateMeetingSummary(meetingId, summaryText)
  }

  // Apply the AI-generated title from the backend extraction.
  // Replaces the default "Meeting, HH:MM" set when recording started.
  if (extractedTitle && extractedTitle !== meeting.title) {
    db.updateMeetingTitle(meetingId, extractedTitle)
    console.log(`[llm-extraction] Updated meeting title: "${meeting.title}" → "${extractedTitle}"`)
  }

  // Mirror the backend's updated user profile into local SQLite. The backend
  // already wrote it to Supabase directly; this keeps local in sync without
  // waiting for the next pull, and the resulting write hook re-pushes (an
  // identical no-op upsert on Supabase).
  const updatedProfileMd: string | undefined = result?.updatedProfileMd
  if (updatedProfileMd) {
    const userId = db.getMetaValue('workos_user_id')
    if (userId) {
      db.upsertUserProfileMd(userId, updatedProfileMd)
      console.log(`[llm-extraction] User profile updated locally (${updatedProfileMd.length} chars)`)
    } else {
      console.warn('[llm-extraction] updatedProfileMd present but no workos_user_id in _meta — skipping local write')
    }
  }

  console.log(`[llm-extraction] Pipeline complete — tasks written: ${newTasks.length}, decisions: ${rawDecisions.length}`)

  return db.getMeetingReviewPayload(meetingId)
}

// ---------------------------------------------------------------------------
// Public: generateCommsForMeeting
// Uses template-based message generation (no direct LLM call).
// ---------------------------------------------------------------------------

export async function generateCommsForMeeting(
  meetingId: string,
  opts?: { db?: Queries; provider?: LLMProvider },
): Promise<Comm[]> {
  const db = opts?.db ?? getDb()

  const meeting  = db.getMeetingById(meetingId)
  if (!meeting) throw new Error(`Meeting not found: ${meetingId}`)

  const speakers = db.getSpeakersByMeeting(meetingId)
  const assignees = speakers.filter(s => !s.isSelf && s.name !== null)

  if (assignees.length === 0) {
    console.log('[llm-extraction] No named assignees — skipping comms generation')
    return []
  }

  db.regenerateCommsForMeeting(meetingId)

  const newComms: NewComm[] = []

  for (const assignee of assignees) {
    const tasks = db.getTasksBySpeaker(meetingId, assignee.id)
      .filter(t => t.status === 'confirmed')

    if (tasks.length === 0) continue

    const taskSummaries = tasks.map(t => ({ title: t.title, deadlineText: t.deadlineText }))

    const message = buildCommsMessage(assignee.name!, meeting.title, taskSummaries)

    newComms.push({
      meetingId,
      recipientSpeakerId:   assignee.id,
      messageBody:          message,
      deliveryChannel:      assignee.hasCornflake ? 'push' : 'email',
      recipientEmail:       assignee.email,
      hasCornflake:         assignee.hasCornflake,
      includeInstallInvite: !assignee.hasCornflake,
    })
  }

  if (newComms.length > 0) {
    const inserted = db.createComms(newComms)
    console.log(`[llm-extraction] Created ${inserted.length} comms record(s)`)
    return inserted
  }

  return []
}

// ---------------------------------------------------------------------------
// Public: regenerateTasksForMeeting
// Re-runs task extraction for a meeting via the backend, excluding dismissed.
// ---------------------------------------------------------------------------

export async function regenerateTasksForMeeting(
  meetingId: string,
  opts?: { db?: Queries; provider?: LLMProvider },
): Promise<void> {
  const db = opts?.db ?? getDb()

  const meeting = db.getMeetingById(meetingId)
  if (!meeting) throw new Error(`Meeting not found: ${meetingId}`)

  const speakers   = db.getSpeakersByMeeting(meetingId)
  const utterances = db.getUtterancesByMeeting(meetingId)

  if (utterances.length === 0) {
    console.warn(`[llm-extraction] No utterances for meeting ${meetingId} — skipping regeneration`)
    return
  }

  const transcriptArray  = buildTranscriptArray(utterances, speakers)
  const dismissedQuotes  = new Set(db.getDismissedTaskQuotes(meetingId))

  console.log(`[llm-extraction] Regenerating tasks for meeting "${meeting.title}"`)

  const result   = await apiPost('/api/extract', {
    transcript:   transcriptArray,
    meetingTitle: meeting.title,
    speakers:     speakers.map(s => ({
      id:      s.id,
      name:    s.name,
      isSelf:  s.isSelf,
      email:   s.email ?? null,
      company: companyFromEmail(s.email),
    })),
  })

  const rawTasks: RawTask[] = (result?.tasks ?? [])
    .filter((t: RawTask) => !dismissedQuotes.has(t.transcriptQuote ?? ''))

  db.deletePendingTasksForMeeting(meetingId)

  const newTasks: NewTask[] = rawTasks.map(t => {
    let deadlineMs: number | null = null
    if (t.deadlineIso) {
      const parsed = Date.parse(t.deadlineIso + 'T09:00:00')
      if (!isNaN(parsed)) deadlineMs = parsed
    }
    const confidence = (['high', 'medium', 'low'] as const).includes(t.confidence as never)
      ? t.confidence as 'high' | 'medium' | 'low'
      : 'medium'
    const title = t.title.slice(0, 200)
    return {
      meetingId,
      assigneeSpeakerId:    null,   // v1 single-player — no assignee
      title,
      deadlineText:         t.deadlineText ?? null,
      deadlineMs,
      remindOffsetMs:       null,
      remindAtMs:           null,
      transcriptQuote:      t.transcriptQuote ?? null,
      extractionConfidence: confidence,
      actionType:           (t as any).action_type ?? null,
      note:                 null,
      listName:             'Reminders',
    }
  })

  if (newTasks.length > 0) db.createTasks(newTasks)
  console.log(`[llm-extraction] Regenerated ${newTasks.length} task(s) for meeting ${meetingId}`)
}
