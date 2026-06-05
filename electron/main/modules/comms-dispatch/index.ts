// Module 7 — Comms Dispatch
// Sends task notifications to participants via the Cornflake backend (SendGrid / push).
//
// Approval gate: this module runs ONLY from the COMMS_SEND IPC handler after the user
// reviews LLM-drafted messages in the Comms tab and clicks send. Drafting happens in
// generateCommsForMeeting (Module 5); nothing is dispatched at transcript or task-confirm time.

import { apiPost } from '../api-client/index.js'
import { getDb } from '../database/index.js'

export interface CommsSendResult {
  sent:   string[]   // comm IDs that were dispatched
  failed: string[]   // comm IDs that failed
}

export async function sendComms(meetingId: string): Promise<CommsSendResult> {
  const db = getDb()

  const comms    = db.getCommsByMeeting(meetingId).filter(c => c.send && !c.sentAt)
  const speakers = db.getSpeakersByMeeting(meetingId)
  const meeting  = db.getMeetingById(meetingId)

  if (comms.length === 0 || !meeting) return { sent: [], failed: [] }

  // Build recipient list for the backend
  const recipients = comms.flatMap(c => {
    const speaker = speakers.find(s => s.id === c.recipientSpeakerId)
    const email   = c.recipientEmail ?? speaker?.email ?? null
    const name    = speaker?.name ?? null

    if (!email || !name) {
      console.warn(`[comms-dispatch] Skipping comm ${c.id} — missing email or name`)
      return []
    }

    const tasks = db.getTasksBySpeaker(meetingId, c.recipientSpeakerId)
      .filter(t => t.status === 'confirmed')
      .map(t => ({ title: t.title, deadlineText: t.deadlineText }))

    return [{
      commId:              c.id,
      email,
      name,
      messageBody:         c.messageBody,
      tasks,
      meetingTitle:        meeting.title,
      includeInstallInvite: c.includeInstallInvite,
    }]
  })

  if (recipients.length === 0) return { sent: [], failed: [] }

  try {
    await apiPost('/api/comms/send', { recipients })

    // Optimistically mark all as sent (backend uses allSettled internally)
    for (const r of recipients) db.markCommSent(r.commId)

    console.log(`[comms-dispatch] Sent ${recipients.length} notification(s) for meeting ${meetingId}`)
    return { sent: recipients.map(r => r.commId), failed: [] }
  } catch (err) {
    const error = (err as Error).message
    for (const r of recipients) db.markCommFailed(r.commId, error)
    console.error('[comms-dispatch] Send failed:', error)
    return { sent: [], failed: recipients.map(r => r.commId) }
  }
}
