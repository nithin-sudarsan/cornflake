// Module 3 — Transcription + Diarisation Pipeline
// Sends audio files to the Cornflake backend, which proxies to Deepgram.
// Merges mic and system-audio utterances, writes speaker + utterance rows to DB.

import fs from 'fs'
import { apiPostForm } from '../api-client/index.js'
import type { AudioPaths } from '../audio-capture/index.js'
import { getDb } from '../database/index.js'

// ---------------------------------------------------------------------------
// Public output type
// ---------------------------------------------------------------------------

export interface TranscriptUtterance {
  speakerId: string  // "you" | "deepgram_0" | "deepgram_1" etc. — unnamed at this stage
  text: string
  startMs: number
  endMs: number
}

// ---------------------------------------------------------------------------
// Backend response type (what the /api/transcribe endpoint returns)
// ---------------------------------------------------------------------------

interface BackendUtterance {
  speakerId: string         // "you" | "deepgram_N"
  transcript?: string       // backend field name from Deepgram
  text?: string             // normalised field name
  start?: number            // seconds (Deepgram raw)
  end?: number              // seconds (Deepgram raw)
  startMs?: number          // ms (if backend normalised)
  endMs?: number            // ms (if backend normalised)
  speaker?: number          // numeric speaker ID from Deepgram
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runTranscriptionPipeline(
  paths: AudioPaths,
  meetingId: string
): Promise<TranscriptUtterance[]> {
  const db = getDb()

  // Read both audio files
  const [micBuf, sysBuf] = await Promise.all([
    fs.promises.readFile(paths.micPath),
    fs.promises.readFile(paths.systemAudioPath),
  ])

  console.log(`[transcription] Sending audio to backend — mic: ${micBuf.length} bytes, sys: ${sysBuf.length} bytes`)

  // Build multipart FormData (Node 20+ has native FormData + Blob)
  const formData = new FormData()
  formData.append('micAudio',    new Blob([micBuf], { type: 'audio/wav' }), 'mic.wav')
  formData.append('systemAudio', new Blob([sysBuf], { type: 'audio/wav' }), 'system.wav')

  const { transcript: raw } = await apiPostForm('/api/transcribe', formData) as { transcript: BackendUtterance[] }

  // Normalise to TranscriptUtterance — backend may return different field names
  const merged: TranscriptUtterance[] = (raw ?? [])
    .map(u => {
      const speakerId = u.speakerId ?? (u.speaker !== undefined ? `deepgram_${u.speaker}` : 'you')
      const text = (u.text ?? u.transcript ?? '').trim()
      const startMs = u.startMs ?? Math.round((u.start ?? 0) * 1000)
      const endMs   = u.endMs   ?? Math.round((u.end   ?? 0) * 1000)
      return { speakerId, text, startMs, endMs }
    })
    .filter(u => u.text)
    .sort((a, b) => a.startMs - b.startMs)

  console.log(`[transcription] Backend returned ${merged.length} utterance(s)`)

  // -------------------------------------------------------------------------
  // Write speakers + utterances to DB (identical logic to before)
  // -------------------------------------------------------------------------

  const existingSpeakers = db.getSpeakersByMeeting(meetingId)
  const selfSpeaker = existingSpeakers.find(s => s.isSelf)

  const sysUtterances = merged.filter(u => u.speakerId !== 'you')
  const deepgramNumbers = [...new Set(sysUtterances.map(u => u.speakerId.replace('deepgram_', '')))]

  const remoteSpeakers = deepgramNumbers.length > 0
    ? db.createSpeakers(meetingId, deepgramNumbers)
    : []

  const speakerIdMap = new Map<string, string>()
  if (selfSpeaker) speakerIdMap.set('you', selfSpeaker.id)
  for (const sp of remoteSpeakers) {
    speakerIdMap.set(`deepgram_${sp.deepgramId}`, sp.id)
  }

  const utteranceRows = merged
    .filter(u => speakerIdMap.has(u.speakerId) && u.text)
    .map(u => ({
      meetingId,
      speakerId: speakerIdMap.get(u.speakerId)!,
      text: u.text,
      startMs: u.startMs,
      endMs: u.endMs,
    }))

  if (utteranceRows.length > 0) db.createUtterances(utteranceRows)

  console.log(`[transcription] Wrote ${utteranceRows.length} utterance(s) to DB for meeting ${meetingId}`)
  for (const u of merged) {
    console.log(`  [${u.speakerId}] ${u.startMs}ms–${u.endMs}ms: ${u.text}`)
  }

  return merged
}
