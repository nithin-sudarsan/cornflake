import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Write-through sync hook — registered by the sync module at startup.
// Called after every local write so the sync queue can mirror to Supabase.
// ---------------------------------------------------------------------------

let _onWrite: ((table: string, record: Record<string, unknown>) => void) | null = null
let _onDelete: ((table: string, recordId: string) => void) | null = null

export function registerWriteHook(
  fn: (table: string, record: Record<string, unknown>) => void
): void {
  _onWrite = fn
}

export function registerDeleteHook(
  fn: (table: string, recordId: string) => void
): void {
  _onDelete = fn
}

import type {
  Meeting, Speaker, Utterance, Task, Decision, Comm,
  ReviewPayload, NewTask, NewComm, Confidence, TaskStatus, TaskPriority, DeliveryChannel, ListRecord,
  PastMeeting, MeetingDetailData, TaskDetail,
} from './types'

// ---------------------------------------------------------------------------
// Row → domain type mappers
// ---------------------------------------------------------------------------

interface MeetingRow {
  id: string; title: string; start_ms: number; end_ms: number | null
  calendar_event_id: string | null; requires_manual_labelling: number
  summary: string | null; confirmed_at: number | null; created_at: number
  deleted_at: number | null
}

interface SpeakerRow {
  id: string; meeting_id: string; deepgram_id: string | null; name: string | null
  email: string | null; is_self: number; confidence: string | null
  has_cornflake: number; created_at: number
}

interface UtteranceRow {
  id: string; meeting_id: string; speaker_id: string; text: string
  start_ms: number; end_ms: number; created_at: number
}

interface TaskRow {
  id: string; meeting_id: string | null; assignee_speaker_id: string | null; title: string
  deadline_text: string | null; deadline_ms: number | null
  remind_offset_ms: number | null; remind_at_ms: number | null
  transcript_quote: string | null; extraction_confidence: string | null
  status: string; note: string | null; list_name: string; origin_list: string | null
  completed_at: number | null; created_at: number; updated_at: number
  sort_order: number | null
  priority: string
  meeting_title?: string | null  // populated by JOIN in list queries
}

interface ListRow {
  id: string; name: string; created_at: number
}

interface DecisionRow {
  id: string; meeting_id: string; text: string
  transcript_quote: string | null
  decided_by_speaker_id: string | null
  extraction_confidence: string | null
  parent_decision_id: string | null
  created_at: number
  updated_at: number
}

interface CommRow {
  id: string; meeting_id: string; recipient_speaker_id: string; message_body: string
  delivery_channel: string; recipient_email: string | null; has_cornflake: number
  include_install_invite: number; send: number; sent_at: number | null
  send_error: string | null; created_at: number; updated_at: number
}

function mapMeeting(r: MeetingRow): Meeting {
  return {
    id: r.id, title: r.title, startMs: r.start_ms, endMs: r.end_ms,
    calendarEventId: r.calendar_event_id,
    requiresManualLabelling: r.requires_manual_labelling === 1,
    summary: r.summary, confirmedAt: r.confirmed_at, createdAt: r.created_at,
  }
}

function mapSpeaker(r: SpeakerRow): Speaker {
  return {
    id: r.id, meetingId: r.meeting_id, deepgramId: r.deepgram_id,
    name: r.name, email: r.email, isSelf: r.is_self === 1,
    confidence: r.confidence as Confidence | null,
    hasCornflake: r.has_cornflake === 1, createdAt: r.created_at,
  }
}

function mapUtterance(r: UtteranceRow): Utterance {
  return {
    id: r.id, meetingId: r.meeting_id, speakerId: r.speaker_id,
    text: r.text, startMs: r.start_ms, endMs: r.end_ms, createdAt: r.created_at,
  }
}

function mapTask(r: TaskRow): Task {
  return {
    id: r.id, meetingId: r.meeting_id, meetingTitle: r.meeting_title ?? null,
    assigneeSpeakerId: r.assignee_speaker_id,
    title: r.title, deadlineText: r.deadline_text, deadlineMs: r.deadline_ms,
    remindOffsetMs: r.remind_offset_ms, remindAtMs: r.remind_at_ms,
    transcriptQuote: r.transcript_quote,
    extractionConfidence: r.extraction_confidence as Confidence | null,
    status: r.status as TaskStatus, note: r.note,
    listName: r.list_name ?? 'Reminders',
    originList: r.origin_list ?? null,
    sortOrder: r.sort_order ?? null,
    priority: (r.priority ?? 'normal') as TaskPriority,
    completedAt: r.completed_at ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

function mapList(r: ListRow): ListRecord {
  return { id: r.id, name: r.name, createdAt: r.created_at }
}

function mapDecision(r: DecisionRow): Decision {
  return {
    id: r.id, meetingId: r.meeting_id, text: r.text,
    transcriptQuote: r.transcript_quote,
    decidedBySpeakerId: r.decided_by_speaker_id,
    extractionConfidence: r.extraction_confidence as Decision['extractionConfidence'],
    parentDecisionId: r.parent_decision_id,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

function mapComm(r: CommRow): Comm {
  return {
    id: r.id, meetingId: r.meeting_id, recipientSpeakerId: r.recipient_speaker_id,
    messageBody: r.message_body, deliveryChannel: r.delivery_channel as DeliveryChannel,
    recipientEmail: r.recipient_email, hasCornflake: r.has_cornflake === 1,
    includeInstallInvite: r.include_install_invite === 1, send: r.send === 1,
    sentAt: r.sent_at, sendError: r.send_error,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Query factory — call with the open DB instance
// ---------------------------------------------------------------------------

export function buildQueries(db: Database.Database) {
  const now = () => Date.now()

  // -------------------------------------------------------------------------
  // Meeting queries
  // -------------------------------------------------------------------------

  function createMeeting(title: string, calendarEventId?: string): Meeting {
    const id = randomUUID()
    const ts = now()
    db.prepare(`
      INSERT INTO meetings (id, title, start_ms, calendar_event_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, title, ts, calendarEventId ?? null, ts)
    const row = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id) as MeetingRow
    _onWrite?.('meetings', row as unknown as Record<string, unknown>)
    return mapMeeting(row)
  }

  function finalizeMeeting(meetingId: string, endMs: number): void {
    db.prepare(`UPDATE meetings SET end_ms = ? WHERE id = ?`).run(endMs, meetingId)
    const row = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(meetingId)
    if (row) _onWrite?.('meetings', row as unknown as Record<string, unknown>)
  }

  function updateMeetingTitle(meetingId: string, title: string): void {
    db.prepare(`UPDATE meetings SET title = ? WHERE id = ?`).run(title, meetingId)
    const row = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(meetingId)
    if (row) _onWrite?.('meetings', row as unknown as Record<string, unknown>)
  }

  function confirmMeeting(meetingId: string): void {
    db.prepare(`UPDATE meetings SET confirmed_at = ? WHERE id = ?`).run(now(), meetingId)
    const row = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(meetingId)
    if (row) _onWrite?.('meetings', row as unknown as Record<string, unknown>)
  }

  function setMeetingRequiresLabelling(meetingId: string, requires: boolean): void {
    db.prepare(`UPDATE meetings SET requires_manual_labelling = ? WHERE id = ?`)
      .run(requires ? 1 : 0, meetingId)
    const row = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(meetingId)
    if (row) _onWrite?.('meetings', row as unknown as Record<string, unknown>)
  }

  function updateMeetingSummary(meetingId: string, summary: string): void {
    db.prepare(`UPDATE meetings SET summary = ? WHERE id = ?`).run(summary, meetingId)
    const row = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(meetingId)
    if (row) _onWrite?.('meetings', row as unknown as Record<string, unknown>)
  }

  function getMeetingById(meetingId: string): Meeting | null {
    const row = db.prepare(`SELECT * FROM meetings WHERE id = ? AND deleted_at IS NULL`).get(meetingId) as MeetingRow | undefined
    return row ? mapMeeting(row) : null
  }

  function getMeetingReviewPayload(meetingId: string): ReviewPayload {
    const meeting = getMeetingById(meetingId)
    if (!meeting) throw new Error(`Meeting not found: ${meetingId}`)
    const speakers = getSpeakersByMeeting(meetingId)
    const tasks = getTasksByMeeting(meetingId)
    const decisions = getDecisionsByMeeting(meetingId)
    const comms = getCommsByMeeting(meetingId)
    return { meeting, speakers, tasks, decisions, comms }
  }

  // -------------------------------------------------------------------------
  // Speaker queries
  // -------------------------------------------------------------------------

  function createSpeakers(meetingId: string, deepgramIds: string[]): Speaker[] {
    const ts = now()
    const rows: Speaker[] = []

    for (const dgId of deepgramIds) {
      const id = randomUUID()
      db.prepare(`
        INSERT INTO speakers (id, meeting_id, deepgram_id, is_self, created_at)
        VALUES (?, ?, ?, 0, ?)
      `).run(id, meetingId, dgId, ts)
      const row = db.prepare(`SELECT * FROM speakers WHERE id = ?`).get(id) as SpeakerRow
      _onWrite?.('speakers', row as unknown as Record<string, unknown>)
      rows.push(mapSpeaker(row))
    }
    return rows
  }

  function createSelfSpeaker(meetingId: string, email?: string): Speaker {
    const id = randomUUID()
    const ts = now()
    db.prepare(`
      INSERT INTO speakers (id, meeting_id, deepgram_id, name, email, is_self, confidence, created_at)
      VALUES (?, ?, NULL, 'You', ?, 1, NULL, ?)
    `).run(id, meetingId, email ?? null, ts)
    const row = db.prepare(`SELECT * FROM speakers WHERE id = ?`).get(id) as SpeakerRow
    _onWrite?.('speakers', row as unknown as Record<string, unknown>)
    return mapSpeaker(row)
  }

  function resolveSpeaker(speakerId: string, name: string, confidence: Confidence): void {
    db.prepare(`UPDATE speakers SET name = ?, confidence = ? WHERE id = ?`)
      .run(name, confidence, speakerId)
    const row = db.prepare(`SELECT * FROM speakers WHERE id = ?`).get(speakerId)
    if (row) _onWrite?.('speakers', row as unknown as Record<string, unknown>)
  }

  function bulkResolveSpeakers(
    resolutions: { speakerId: string; name: string; email?: string }[]
  ): void {
    const update = db.prepare(
      `UPDATE speakers SET name = ?, email = COALESCE(?, email), confidence = 'manual' WHERE id = ?`
    )
    const tx = db.transaction(() => {
      for (const r of resolutions) update.run(r.name, r.email ?? null, r.speakerId)
    })
    tx()
    // Fire sync hooks after transaction commits
    for (const r of resolutions) {
      const row = db.prepare(`SELECT * FROM speakers WHERE id = ?`).get(r.speakerId)
      if (row) _onWrite?.('speakers', row as unknown as Record<string, unknown>)
    }
  }

  function getSpeakersByMeeting(meetingId: string): Speaker[] {
    return (db.prepare(`SELECT * FROM speakers WHERE meeting_id = ? ORDER BY created_at`)
      .all(meetingId) as SpeakerRow[]).map(mapSpeaker)
  }

  function updateSpeakerEmail(speakerId: string, email: string): void {
    db.prepare(`UPDATE speakers SET email = ? WHERE id = ?`).run(email, speakerId)
    const row = db.prepare(`SELECT * FROM speakers WHERE id = ?`).get(speakerId)
    if (row) _onWrite?.('speakers', row as unknown as Record<string, unknown>)
  }

  function updateSpeakerHasCornflake(speakerId: string, has: boolean): void {
    db.prepare(`UPDATE speakers SET has_cornflake = ? WHERE id = ?`).run(has ? 1 : 0, speakerId)
    const row = db.prepare(`SELECT * FROM speakers WHERE id = ?`).get(speakerId)
    if (row) _onWrite?.('speakers', row as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Utterance queries
  // -------------------------------------------------------------------------

  function createUtterances(
    utterances: Array<{ meetingId: string; speakerId: string; text: string; startMs: number; endMs: number }>
  ): Utterance[] {
    const ts = now()
    const insert = db.prepare(`
      INSERT INTO utterances (id, meeting_id, speaker_id, text, start_ms, end_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const ids: string[] = []
    const tx = db.transaction(() => {
      for (const u of utterances) {
        const id = randomUUID()
        ids.push(id)
        insert.run(id, u.meetingId, u.speakerId, u.text, u.startMs, u.endMs, ts)
      }
    })
    tx()
    return ids.map(id => {
      const row = db.prepare(`SELECT * FROM utterances WHERE id = ?`).get(id) as UtteranceRow
      _onWrite?.('utterances', row as unknown as Record<string, unknown>)
      return mapUtterance(row)
    })
  }

  function getUtterancesByMeeting(meetingId: string): Utterance[] {
    return (db.prepare(`SELECT * FROM utterances WHERE meeting_id = ? ORDER BY start_ms`)
      .all(meetingId) as UtteranceRow[]).map(mapUtterance)
  }

  // -------------------------------------------------------------------------
  // Task queries
  // -------------------------------------------------------------------------

  function createTasks(tasks: NewTask[]): Task[] {
    const ts = now()
    const insert = db.prepare(`
      INSERT INTO tasks
        (id, meeting_id, assignee_speaker_id, title, deadline_text, deadline_ms,
         remind_offset_ms, remind_at_ms, transcript_quote, extraction_confidence,
         status, note, list_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?, ?, ?)
    `)
    const ids: string[] = []
    const tx = db.transaction(() => {
      for (const t of tasks) {
        const id = randomUUID()
        ids.push(id)
        insert.run(
          id, t.meetingId, t.assigneeSpeakerId, t.title,
          t.deadlineText, t.deadlineMs,
          t.remindOffsetMs ?? -3600000, t.remindAtMs ?? null,
          t.transcriptQuote, t.extractionConfidence,
          t.note ?? null, t.listName ?? 'Reminders', ts, ts
        )
      }
    })
    tx()
    return ids.map(id => {
      const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow
      _onWrite?.('tasks', row as unknown as Record<string, unknown>)
      return mapTask(row)
    })
  }

  function createStandaloneTask(title: string, listName: string): Task {
    const ts = now()
    const id = randomUUID()
    db.prepare(`
      INSERT INTO tasks
        (id, meeting_id, assignee_speaker_id, title, deadline_text, deadline_ms,
         remind_offset_ms, remind_at_ms, transcript_quote, extraction_confidence,
         status, note, list_name, origin_list, created_at, updated_at)
      VALUES (?, NULL, NULL, ?, NULL, NULL, -3600000, NULL, NULL, NULL, 'pending', NULL, ?, ?, ?, ?)
    `).run(id, title, listName, listName, ts, ts)
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow
    _onWrite?.('tasks', row as unknown as Record<string, unknown>)
    return mapTask(row)
  }

  function getTasksByList(listName: string): Task[] {
    return (db.prepare(`
      SELECT t.*, m.title AS meeting_title
      FROM tasks t
      LEFT JOIN meetings m ON m.id = t.meeting_id AND m.deleted_at IS NULL
      WHERE t.list_name = ?
        AND t.status IN ('pending', 'confirmed')
      ORDER BY COALESCE(t.sort_order, t.created_at) ASC
    `).all(listName) as TaskRow[]).map(mapTask)
  }

  // Persist a new ordering for a list. `orderedIds` is the full task ID list
  // in the desired order; each gets a new sort_order = its 1-based position.
  function reorderTasks(orderedIds: string[]): void {
    const update = db.prepare(`UPDATE tasks SET sort_order = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      orderedIds.forEach((id, idx) => update.run(idx + 1, id))
    })
    tx()
    for (const id of orderedIds) {
      const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id)
      if (row) _onWrite?.('tasks', row as unknown as Record<string, unknown>)
    }
  }

  function updateTask(taskId: string, updates: Partial<Omit<Task, 'id' | 'meetingId' | 'createdAt'>>): Task {
    const current = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as TaskRow
    if (!current) throw new Error(`Task not found: ${taskId}`)

    const merged = {
      assignee_speaker_id:   updates.assigneeSpeakerId          ?? current.assignee_speaker_id,
      title:                 updates.title                       ?? current.title,
      deadline_text:         'deadlineText'       in updates ? updates.deadlineText       : current.deadline_text,
      deadline_ms:           'deadlineMs'         in updates ? updates.deadlineMs         : current.deadline_ms,
      remind_offset_ms:      updates.remindOffsetMs              ?? current.remind_offset_ms,
      remind_at_ms:          updates.remindAtMs                  ?? current.remind_at_ms,
      transcript_quote:      updates.transcriptQuote             ?? current.transcript_quote,
      extraction_confidence: updates.extractionConfidence        ?? current.extraction_confidence,
      status:                updates.status                      ?? current.status,
      note:                  'note'               in updates ? updates.note               : current.note,
      priority:              updates.priority                    ?? current.priority ?? 'normal',
      updated_at:            Date.now(),
    }

    db.prepare(`
      UPDATE tasks SET
        assignee_speaker_id = ?, title = ?, deadline_text = ?, deadline_ms = ?,
        remind_offset_ms = ?, remind_at_ms = ?, transcript_quote = ?,
        extraction_confidence = ?, status = ?, note = ?, priority = ?, updated_at = ?
      WHERE id = ?
    `).run(
      merged.assignee_speaker_id, merged.title, merged.deadline_text, merged.deadline_ms,
      merged.remind_offset_ms, merged.remind_at_ms, merged.transcript_quote,
      merged.extraction_confidence, merged.status, merged.note, merged.priority, merged.updated_at,
      taskId
    )

    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as TaskRow
    _onWrite?.('tasks', row as unknown as Record<string, unknown>)
    return mapTask(row)
  }

  function confirmTask(taskId: string): void {
    db.prepare(`UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?`).run(now(), taskId)
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId)
    if (row) _onWrite?.('tasks', row as unknown as Record<string, unknown>)
  }

  // Approve a task into a specific list — sets list_name, origin_list, and status atomically.
  function approveTaskToList(taskId: string, listName: string): void {
    db.prepare(`
      UPDATE tasks SET status = 'pending', list_name = ?, origin_list = ?, updated_at = ?
      WHERE id = ?
    `).run(listName, listName, now(), taskId)
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId)
    if (row) _onWrite?.('tasks', row as unknown as Record<string, unknown>)
  }

  function dismissTask(taskId: string): void {
    db.prepare(`UPDATE tasks SET status = 'dismissed', updated_at = ? WHERE id = ?`).run(now(), taskId)
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId)
    if (row) _onWrite?.('tasks', row as unknown as Record<string, unknown>)
  }

  function getTasksByMeeting(meetingId: string): Task[] {
    return (db.prepare(
      `SELECT * FROM tasks WHERE meeting_id = ? AND status != 'dismissed' ORDER BY created_at`
    ).all(meetingId) as TaskRow[]).map(mapTask)
  }

  function getTasksBySpeaker(meetingId: string, speakerId: string): Task[] {
    return (db.prepare(
      `SELECT * FROM tasks WHERE meeting_id = ? AND assignee_speaker_id = ? AND status != 'dismissed' ORDER BY created_at`
    ).all(meetingId, speakerId) as TaskRow[]).map(mapTask)
  }

  // -------------------------------------------------------------------------
  // Decision queries
  // -------------------------------------------------------------------------

  // Input shape from the extraction pipeline. parentIndex is a positional
  // reference into the same input array (the LLM doesn't know our DB IDs);
  // we resolve it to a parent_decision_id during insert.
  interface NewDecisionInput {
    meetingId: string
    text: string
    transcriptQuote?: string | null
    decidedBySpeakerId?: string | null
    extractionConfidence?: 'high' | 'medium' | 'low' | null
    parentIndex?: number | null
  }

  function createDecisions(decisions: NewDecisionInput[]): Decision[] {
    const ts = now()
    const insert = db.prepare(`
      INSERT INTO decisions (
        id, meeting_id, text, transcript_quote, decided_by_speaker_id,
        extraction_confidence, parent_decision_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    // Pre-allocate IDs so parentIndex can be resolved to parent IDs before
    // the row is written (the parent FK must be set in the same INSERT).
    const ids = decisions.map(() => randomUUID())
    const tx = db.transaction(() => {
      decisions.forEach((d, i) => {
        const parentId =
          d.parentIndex != null && d.parentIndex >= 0 && d.parentIndex < i
            ? ids[d.parentIndex]
            : null
        insert.run(
          ids[i], d.meetingId, d.text,
          d.transcriptQuote ?? null,
          d.decidedBySpeakerId ?? null,
          d.extractionConfidence ?? null,
          parentId,
          ts, ts,
        )
      })
    })
    tx()
    return ids.map(id => {
      const row = db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as DecisionRow
      _onWrite?.('decisions', row as unknown as Record<string, unknown>)
      return mapDecision(row)
    })
  }

  function getDecisionsByMeeting(meetingId: string): Decision[] {
    return (db.prepare(`SELECT * FROM decisions WHERE meeting_id = ? ORDER BY created_at`)
      .all(meetingId) as DecisionRow[]).map(mapDecision)
  }

  // All decisions across all meetings, newest first. Used by the global
  // Decisions sidebar entry.
  function getAllDecisions(): Decision[] {
    return (db.prepare(`SELECT * FROM decisions ORDER BY created_at DESC`)
      .all() as DecisionRow[]).map(mapDecision)
  }

  function getDecisionById(id: string): Decision | null {
    const row = db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as DecisionRow | undefined
    return row ? mapDecision(row) : null
  }

  // Children of a decision — decisions that point back to this one as parent.
  // Used by the detail view's "Referenced by" section.
  function getChildDecisions(parentId: string): Decision[] {
    return (db.prepare(`SELECT * FROM decisions WHERE parent_decision_id = ? ORDER BY created_at`)
      .all(parentId) as DecisionRow[]).map(mapDecision)
  }

  function updateDecisionText(id: string, text: string): void {
    const ts = now()
    db.prepare(`UPDATE decisions SET text = ?, updated_at = ? WHERE id = ?`).run(text, ts, id)
    const row = db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id)
    if (row) _onWrite?.('decisions', row as Record<string, unknown>)
  }

  function deleteDecision(id: string): void {
    // Find children first so we can fire write hooks for them (their
    // parent_decision_id is about to change). Then null the children's
    // parent FK so we don't violate the FK constraint on delete.
    const childRows = db.prepare(`SELECT * FROM decisions WHERE parent_decision_id = ?`)
      .all(id) as DecisionRow[]
    const tx = db.transaction(() => {
      db.prepare(`UPDATE decisions SET parent_decision_id = NULL, updated_at = ? WHERE parent_decision_id = ?`)
        .run(now(), id)
      db.prepare(`DELETE FROM decisions WHERE id = ?`).run(id)
    })
    tx()
    for (const r of childRows) {
      const updated = db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(r.id) as DecisionRow | undefined
      if (updated) _onWrite?.('decisions', updated as unknown as Record<string, unknown>)
    }
    _onDelete?.('decisions', id)
  }

  // -------------------------------------------------------------------------
  // Comms queries
  // -------------------------------------------------------------------------

  function createComms(comms: NewComm[]): Comm[] {
    const ts = now()
    const insert = db.prepare(`
      INSERT INTO comms
        (id, meeting_id, recipient_speaker_id, message_body, delivery_channel,
         recipient_email, has_cornflake, include_install_invite, send, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `)
    const ids: string[] = []
    const tx = db.transaction(() => {
      for (const c of comms) {
        const id = randomUUID()
        ids.push(id)
        insert.run(
          id, c.meetingId, c.recipientSpeakerId, c.messageBody, c.deliveryChannel,
          c.recipientEmail, c.hasCornflake ? 1 : 0, c.includeInstallInvite ? 1 : 0, ts, ts
        )
      }
    })
    tx()
    return ids.map(id => {
      const row = db.prepare(`SELECT * FROM comms WHERE id = ?`).get(id) as CommRow
      _onWrite?.('comms', row as unknown as Record<string, unknown>)
      return mapComm(row)
    })
  }

  function updateCommMessage(commId: string, messageBody: string): void {
    db.prepare(`UPDATE comms SET message_body = ?, updated_at = ? WHERE id = ?`)
      .run(messageBody, now(), commId)
    const row = db.prepare(`SELECT * FROM comms WHERE id = ?`).get(commId)
    if (row) _onWrite?.('comms', row as unknown as Record<string, unknown>)
  }

  function setCommSend(commId: string, send: boolean): void {
    db.prepare(`UPDATE comms SET send = ?, updated_at = ? WHERE id = ?`)
      .run(send ? 1 : 0, now(), commId)
    const row = db.prepare(`SELECT * FROM comms WHERE id = ?`).get(commId)
    if (row) _onWrite?.('comms', row as unknown as Record<string, unknown>)
  }

  function setCommDeliveryChannel(commId: string, channel: DeliveryChannel): void {
    db.prepare(`UPDATE comms SET delivery_channel = ?, updated_at = ? WHERE id = ?`)
      .run(channel, now(), commId)
    const row = db.prepare(`SELECT * FROM comms WHERE id = ?`).get(commId)
    if (row) _onWrite?.('comms', row as unknown as Record<string, unknown>)
  }

  function updateCommRecipientEmail(commId: string, email: string | null): void {
    db.prepare(`UPDATE comms SET recipient_email = ?, updated_at = ? WHERE id = ?`)
      .run(email, now(), commId)
    const row = db.prepare(`SELECT * FROM comms WHERE id = ?`).get(commId)
    if (row) _onWrite?.('comms', row as unknown as Record<string, unknown>)
  }

  function markCommSent(commId: string): void {
    db.prepare(`UPDATE comms SET sent_at = ?, send_error = NULL, updated_at = ? WHERE id = ?`)
      .run(now(), now(), commId)
    const row = db.prepare(`SELECT * FROM comms WHERE id = ?`).get(commId)
    if (row) _onWrite?.('comms', row as unknown as Record<string, unknown>)
  }

  function markCommFailed(commId: string, error: string): void {
    db.prepare(`UPDATE comms SET send_error = ?, updated_at = ? WHERE id = ?`)
      .run(error, now(), commId)
    const row = db.prepare(`SELECT * FROM comms WHERE id = ?`).get(commId)
    if (row) _onWrite?.('comms', row as unknown as Record<string, unknown>)
  }

  function getCommsByMeeting(meetingId: string): Comm[] {
    return (db.prepare(`SELECT * FROM comms WHERE meeting_id = ? ORDER BY created_at`)
      .all(meetingId) as CommRow[]).map(mapComm)
  }

  // Drops and recreates all unsent comms rows based on current confirmed task assignments.
  // Called when user reassigns a task in Screen 3.
  function regenerateCommsForMeeting(meetingId: string): void {
    const ids = (db.prepare(`SELECT id FROM comms WHERE meeting_id = ? AND sent_at IS NULL`)
      .all(meetingId) as { id: string }[]).map(r => r.id)
    db.prepare(`DELETE FROM comms WHERE meeting_id = ? AND sent_at IS NULL`).run(meetingId)
    for (const id of ids) _onDelete?.('comms', id)
  }

  // Move a task to the Completed list, recording where it came from.
  function completeTask(taskId: string, originList: string): void {
    const ts = now()
    db.prepare(`
      UPDATE tasks SET list_name = 'Completed', origin_list = ?, status = 'confirmed',
                       completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(originList, ts, ts, taskId)
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId)
    if (row) _onWrite?.('tasks', row as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // List queries (custom user-created lists)
  // -------------------------------------------------------------------------

  function getAllLists(): ListRecord[] {
    return (db.prepare(`SELECT * FROM lists ORDER BY created_at`).all() as ListRow[]).map(mapList)
  }

  function createList(name: string): ListRecord {
    const id = randomUUID()
    const ts = now()
    db.prepare(`INSERT INTO lists (id, name, created_at) VALUES (?, ?, ?)`).run(id, name, ts)
    const row = db.prepare(`SELECT * FROM lists WHERE id = ?`).get(id) as ListRow
    _onWrite?.('lists', row as unknown as Record<string, unknown>)
    return mapList(row)
  }

  function deleteList(listId: string): void {
    const list = db.prepare(`SELECT * FROM lists WHERE id = ?`).get(listId) as ListRow | undefined
    if (!list) return
    // Capture task IDs BEFORE the delete so we can fire sync delete hooks after commit
    const taskIds = (db.prepare(`SELECT id FROM tasks WHERE list_name = ?`).all(list.name) as { id: string }[]).map(t => t.id)
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM tasks WHERE list_name = ?`).run(list.name)
      db.prepare(`DELETE FROM lists WHERE id = ?`).run(listId)
    })
    tx()
    for (const tid of taskIds) _onDelete?.('tasks', tid)
    _onDelete?.('lists', listId)
  }

  // -------------------------------------------------------------------------
  // Past meetings + detail view
  // -------------------------------------------------------------------------

  function softDeleteMeeting(meetingId: string): void {
    db.prepare(`UPDATE meetings SET deleted_at = ? WHERE id = ?`).run(now(), meetingId)
    const row = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(meetingId)
    if (row) _onWrite?.('meetings', row as unknown as Record<string, unknown>)
  }

  function undeleteMeeting(meetingId: string): void {
    db.prepare(`UPDATE meetings SET deleted_at = NULL WHERE id = ?`).run(meetingId)
    const row = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(meetingId)
    if (row) _onWrite?.('meetings', row as unknown as Record<string, unknown>)
  }

  function hardDeleteMeeting(meetingId: string): void {
    db.prepare(`DELETE FROM meetings WHERE id = ?`).run(meetingId)
    // Supabase FK cascade will clean up related rows on the cloud side.
    _onDelete?.('meetings', meetingId)
  }

  function getDismissedTaskQuotes(meetingId: string): string[] {
    return (db.prepare(
      `SELECT transcript_quote FROM tasks WHERE meeting_id = ? AND status = 'dismissed' AND transcript_quote IS NOT NULL`
    ).all(meetingId) as { transcript_quote: string }[]).map(r => r.transcript_quote)
  }

  function deletePendingTasksForMeeting(meetingId: string): void {
    const ids = (db.prepare(`SELECT id FROM tasks WHERE meeting_id = ? AND status = 'awaiting_approval'`)
      .all(meetingId) as { id: string }[]).map(r => r.id)
    db.prepare(`DELETE FROM tasks WHERE meeting_id = ? AND status = 'awaiting_approval'`).run(meetingId)
    for (const id of ids) _onDelete?.('tasks', id)
  }

  function restoreDismissedTasks(meetingId: string): void {
    const ids = (db.prepare(`SELECT id FROM tasks WHERE meeting_id = ? AND status = 'dismissed'`)
      .all(meetingId) as { id: string }[]).map(r => r.id)
    db.prepare(`UPDATE tasks SET status = 'awaiting_approval', updated_at = ? WHERE meeting_id = ? AND status = 'dismissed'`)
      .run(now(), meetingId)
    for (const id of ids) {
      const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id)
      if (row) _onWrite?.('tasks', row as unknown as Record<string, unknown>)
    }
  }

  function getTaskById(taskId: string): TaskDetail | null {
    const row = db.prepare(`
      SELECT t.*, m.title AS meeting_title
      FROM tasks t
      LEFT JOIN meetings m ON m.id = t.meeting_id AND m.deleted_at IS NULL
      WHERE t.id = ?
    `).get(taskId) as (TaskRow & { meeting_title?: string | null }) | undefined
    if (!row) return null
    return {
      id:           row.id,
      title:        row.title,
      deadlineMs:   row.deadline_ms,
      deadlineText: row.deadline_text,
      priority:     (row.priority ?? 'normal') as TaskPriority,
      note:         row.note,
      listName:     row.list_name ?? 'Reminders',
      meetingId:    row.meeting_id,
      meetingTitle: row.meeting_title ?? null,
      status:       row.status as TaskStatus,
    }
  }

  function restoreTask(taskId: string): void {
    db.prepare(`
      UPDATE tasks
      SET status = 'pending', list_name = COALESCE(origin_list, 'Reminders'),
          completed_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(now(), taskId)
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId)
    if (row) _onWrite?.('tasks', row as unknown as Record<string, unknown>)
  }

  function hardDeleteTask(taskId: string): void {
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId)
    _onDelete?.('tasks', taskId)
  }

  type PastMeetingRow = {
    id: string; title: string; start_ms: number; end_ms: number | null
    confirmed_at: number; summary: string | null; pending_task_count: number
    participant_names: string | null
  }

  function mapPastMeetingRow(r: PastMeetingRow): PastMeeting {
    return {
      id: r.id,
      title: r.title,
      startMs: r.start_ms,
      endMs: r.end_ms,
      confirmedAt: r.confirmed_at,
      summaryPreview: extractSummaryPreview(r.summary),
      pendingTaskCount: r.pending_task_count,
      // Non-self speakers with a known name, deduped + sorted by the subquery.
      participants: r.participant_names
        ? r.participant_names.split('|').filter(Boolean)
        : [],
    }
  }

  function getTrashedMeetings(): PastMeeting[] {
    return (db.prepare(`
      SELECT m.id, m.title, m.start_ms, m.end_ms, m.confirmed_at, m.summary,
             COUNT(t.id) AS pending_task_count,
             (SELECT GROUP_CONCAT(name, '|') FROM (
                SELECT DISTINCT s.name AS name
                FROM speakers s
                WHERE s.meeting_id = m.id AND s.is_self = 0 AND s.name IS NOT NULL
                ORDER BY s.name
              )) AS participant_names
      FROM meetings m
      LEFT JOIN tasks t ON t.meeting_id = m.id AND t.status = 'awaiting_approval'
      WHERE m.deleted_at IS NOT NULL
      GROUP BY m.id
      ORDER BY m.deleted_at DESC
      LIMIT 20
    `).all() as PastMeetingRow[]).map(mapPastMeetingRow)
  }

  function getPastMeetings(): PastMeeting[] {
    return (db.prepare(`
      SELECT m.id, m.title, m.start_ms, m.end_ms, m.confirmed_at, m.summary,
             COUNT(t.id) AS pending_task_count,
             (SELECT GROUP_CONCAT(name, '|') FROM (
                SELECT DISTINCT s.name AS name
                FROM speakers s
                WHERE s.meeting_id = m.id AND s.is_self = 0 AND s.name IS NOT NULL
                ORDER BY s.name
              )) AS participant_names
      FROM meetings m
      LEFT JOIN tasks t ON t.meeting_id = m.id AND t.status = 'awaiting_approval'
      WHERE m.end_ms IS NOT NULL AND m.summary IS NOT NULL AND m.deleted_at IS NULL
      GROUP BY m.id
      ORDER BY m.start_ms DESC
      LIMIT 20
    `).all() as PastMeetingRow[]).map(mapPastMeetingRow)
  }

  function extractSummaryPreview(summary: string | null): string | null {
    if (!summary) return null
    const lines = summary.split('\n')
    for (const line of lines) {
      const stripped = line.replace(/^- /, '').replace(/\*\*/g, '').trim()
      if (stripped && !stripped.startsWith('#') && !stripped.startsWith('###')) {
        return stripped.length > 80 ? stripped.slice(0, 80) + '…' : stripped
      }
    }
    return null
  }

  function getMeetingDetail(meetingId: string): MeetingDetailData | null {
    // Query by ID only — no deleted_at filter so restored meetings are immediately accessible
    const row = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(meetingId) as MeetingRow | undefined
    if (!row) return null
    const meeting = mapMeeting(row)
    const decisions  = getDecisionsByMeeting(meetingId)
    const utterances = getUtterancesByMeeting(meetingId)
    const speakers   = getSpeakersByMeeting(meetingId)
    // Build speaker display names — unresolved remote speakers labelled "Speaker N" (1-based)
    const remotesByOrder = speakers.filter(s => !s.isSelf && s.deepgramId !== null)
      .sort((a, b) => parseInt(a.deepgramId!) - parseInt(b.deepgramId!))
    const unresolvedIdx = new Map(remotesByOrder.filter(s => s.name === null).map((s, i) => [s.id, i + 1]))
    const speakerMap = new Map(speakers.map(s => {
      if (s.isSelf || s.deepgramId === null) return [s.id, s.name ?? 'You']
      if (s.name) return [s.id, s.name]
      return [s.id, `Speaker ${unresolvedIdx.get(s.id) ?? 1}`]
    }))

    // Log total task counts before querying awaiting_approval
    const allTasksCount = (db.prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE meeting_id = ?`).get(meetingId) as { cnt: number }).cnt
    const byStatus = db.prepare(`SELECT status, COUNT(*) as cnt FROM tasks WHERE meeting_id = ? GROUP BY status`).all(meetingId) as { status: string; cnt: number }[]
    console.log(`[getMeetingDetail] meeting ${meetingId} — total tasks in DB: ${allTasksCount}`)
    console.log(`[getMeetingDetail] tasks by status:`, byStatus.map(r => `${r.status}:${r.cnt}`).join(', ') || 'none')

    // Pending tasks for approval — joined with speaker name
    interface PendingTaskRow {
      id: string; title: string; assignee_speaker_id: string | null
      deadline_text: string | null; deadline_ms: number | null
      transcript_quote: string | null; extraction_confidence: string | null
      note: string | null
      assignee_name: string | null; is_self: number
    }
    const pendingTaskRows = db.prepare(`
      SELECT t.id, t.title, t.assignee_speaker_id, t.deadline_text, t.deadline_ms,
             t.transcript_quote, t.extraction_confidence, t.note,
             s.name AS assignee_name, s.is_self
      FROM tasks t
      LEFT JOIN speakers s ON s.id = t.assignee_speaker_id
      WHERE t.meeting_id = ? AND t.status = 'awaiting_approval'
      ORDER BY t.created_at
    `).all(meetingId) as PendingTaskRow[]

    const totalTaskCount = (db.prepare(
      `SELECT COUNT(*) as cnt FROM tasks WHERE meeting_id = ?`
    ).get(meetingId) as { cnt: number }).cnt

    const dismissedTaskCount = (db.prepare(
      `SELECT COUNT(*) as cnt FROM tasks WHERE meeting_id = ? AND status = 'dismissed'`
    ).get(meetingId) as { cnt: number }).cnt

    const commRows = getCommsByMeeting(meetingId)

    return {
      id:        meeting.id,
      title:     meeting.title,
      startMs:   meeting.startMs,
      endMs:     meeting.endMs,
      summary:   meeting.summary,
      decisions: decisions.map(d => ({
        id: d.id, text: d.text,
        confidence: d.extractionConfidence,
      })),
      hasExtractedTasks:  totalTaskCount > 0,
      hasDismissedTasks:  dismissedTaskCount > 0,
      pendingTasks: pendingTaskRows.map(r => ({
        id:                  r.id,
        title:               r.title,
        assigneeSpeakerId:   r.assignee_speaker_id,
        assigneeName:        r.assignee_name,
        isSelfAssigned:      r.is_self === 1,
        deadlineText:        r.deadline_text,
        deadlineMs:          r.deadline_ms,
        transcriptQuote:     r.transcript_quote,
        extractionConfidence: r.extraction_confidence as Confidence | null,
        note:                r.note,
      })),
      comms: commRows.map(c => {
        const sp = speakers.find(s => s.id === c.recipientSpeakerId)
        const remoteIdx = sp && !sp.isSelf && sp.name === null
          ? unresolvedIdx.get(sp.id)
          : null
        const recipientName = sp?.isSelf || sp?.deepgramId === null
          ? (sp?.name ?? 'You')
          : (sp?.name ?? (remoteIdx != null ? `Speaker ${remoteIdx}` : null))
        return {
          id:                   c.id,
          recipientSpeakerId:   c.recipientSpeakerId,
          recipientName,
          messageBody:          c.messageBody,
          deliveryChannel:      c.deliveryChannel,
          recipientEmail:       c.recipientEmail ?? sp?.email ?? null,
          hasCornflake:         c.hasCornflake,
          includeInstallInvite: c.includeInstallInvite,
          send:                 c.send,
          sentAt:               c.sentAt,
          sendError:            c.sendError,
        }
      }),
      speakers: speakers.map(s => ({ id: s.id, name: s.name, isSelf: s.isSelf, confidence: s.confidence, deepgramId: s.deepgramId })),
      utterances: utterances.map(u => ({
        id:          u.id,
        text:        u.text,
        startMs:     u.startMs,
        speakerName: speakerMap.get(u.speakerId) ?? null,
      })),
    }
  }

  // -------------------------------------------------------------------------
  // users table — canonical user record synced to Supabase
  // -------------------------------------------------------------------------

  function upsertUser(id: string, email: string, name: string | null, avatarUrl: string | null): void {
    const ts = now()
    db.prepare(`
      INSERT INTO users (id, email, name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email      = excluded.email,
        name       = excluded.name,
        avatar_url = excluded.avatar_url,
        updated_at = excluded.updated_at
    `).run(id, email, name, avatarUrl, ts, ts)
    const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id)
    if (row) _onWrite?.('users', row as unknown as Record<string, unknown>)
  }

  function getUserById(id: string): { id: string; email: string; name: string | null; avatar_url: string | null } | null {
    return (db.prepare(`SELECT id, email, name, avatar_url FROM users WHERE id = ?`).get(id) as any) ?? null
  }

  // -------------------------------------------------------------------------
  // User profile markdown — long-lived per-user markdown document that the
  // LLM extracts durable facts into after every meeting. Synced to Supabase
  // via the standard sync layer (table: user_profiles).
  //
  // Named *Md (not getUserProfile) because the legacy getUserProfile() above
  // returns the cached Google profile JSON from _meta — different concept.
  // -------------------------------------------------------------------------

  function getUserProfileMd(userId: string): string {
    const row = db.prepare(`SELECT profile_md FROM user_profiles WHERE user_id = ?`).get(userId) as { profile_md: string } | undefined
    return row?.profile_md ?? ''
  }

  function upsertUserProfileMd(userId: string, profileMd: string): void {
    const ts = now()
    // id is intentionally identical to user_id — user_id is UNIQUE and we want
    // a stable row id so Supabase upsert (onConflict: id) is deterministic.
    db.prepare(`
      INSERT INTO user_profiles (id, user_id, profile_md, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        profile_md = excluded.profile_md,
        updated_at = excluded.updated_at
    `).run(userId, userId, profileMd, ts)
    const row = db.prepare(`SELECT * FROM user_profiles WHERE user_id = ?`).get(userId)
    if (row) _onWrite?.('user_profiles', row as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // User profile (stored in _meta as JSON under key 'google_profile')
  // -------------------------------------------------------------------------

  function saveUserProfile(name: string, email: string, picture?: string | null): void {
    db.prepare(`
      INSERT INTO _meta (key, value) VALUES ('google_profile', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify({ name, email, picture: picture ?? null }))
  }

  function getUserProfile(): { name: string; email: string; picture: string | null } | null {
    const row = db.prepare(`SELECT value FROM _meta WHERE key = 'google_profile'`).get() as { value: string } | undefined
    if (!row) return null
    try {
      const parsed = JSON.parse(row.value)
      return { name: parsed.name, email: parsed.email, picture: parsed.picture ?? null }
    } catch { return null }
  }

  function deleteUserProfile(): void {
    db.prepare(`DELETE FROM _meta WHERE key = 'google_profile'`).run()
  }

  // -------------------------------------------------------------------------
  // OAuth token queries
  // -------------------------------------------------------------------------

  function saveOAuthTokens(provider: string, tokens: string): void {
    db.prepare(`
      INSERT INTO oauth_tokens (provider, tokens, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at
    `).run(provider, tokens, Date.now())
  }

  function getOAuthTokens(provider: string): string | null {
    const row = db.prepare(`SELECT tokens FROM oauth_tokens WHERE provider = ?`).get(provider) as { tokens: string } | undefined
    return row?.tokens ?? null
  }

  function deleteOAuthTokens(provider: string): void {
    db.prepare(`DELETE FROM oauth_tokens WHERE provider = ?`).run(provider)
  }

  // -------------------------------------------------------------------------
  // Generic _meta key-value helpers
  // -------------------------------------------------------------------------

  function getMetaValue(key: string): string | null {
    const row = db.prepare(`SELECT value FROM _meta WHERE key = ?`).get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  function setMetaValue(key: string, value: string): void {
    db.prepare(`
      INSERT INTO _meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value)
  }

  function deleteMetaValue(key: string): void {
    db.prepare(`DELETE FROM _meta WHERE key = ?`).run(key)
  }

  // -------------------------------------------------------------------------
  // Sync — upsert a record received from the cloud into local SQLite.
  // Skips if the local row is newer (updated_at comparison).
  // -------------------------------------------------------------------------

  // Tables accepted from the cloud. `users` and `lists` are also valid pull targets.
  const ALLOWED_SYNC_TABLES = new Set([
    'users', 'user_profiles', 'lists', 'meetings', 'speakers', 'utterances',
    'tasks', 'decisions', 'comms', 'voice_profiles',
  ])

  // Supabase returns timestamps as ISO 8601 strings (e.g. "2026-05-17T10:30:00Z").
  // SQLite stores them as unix-millisecond integers. Convert on the way in.
  function coerceCloudValue(val: unknown): unknown {
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
      const ms = Date.parse(val)
      return isNaN(ms) ? val : ms
    }
    // Postgres booleans arrive as true/false — SQLite stores as 1/0.
    if (val === true)  return 1
    if (val === false) return 0
    return val
  }

  // Wipe all user-owned data from local SQLite. Migrations table (_meta) and
  // oauth_tokens (legacy, may still hold migration data) are preserved.
  // Order matters: child tables first so FK constraints don't fail.
  function wipeUserData(): void {
    const wipeOrder = [
      'sync_queue',
      'comms',
      'decisions',
      'tasks',
      'utterances',
      'speakers',
      'meetings',
      'voice_profiles',
      'lists',
      'user_profiles',
      'users',
    ]
    const tx = db.transaction(() => {
      for (const table of wipeOrder) {
        try {
          db.prepare(`DELETE FROM ${table}`).run()
        } catch (err) {
          console.warn(`[db] wipeUserData: skipping ${table} —`, (err as Error).message)
        }
      }
      // Also clear the cached profile and workos user id from _meta
      db.prepare(`DELETE FROM _meta WHERE key IN ('google_profile', 'workos_user_id')`).run()
    })
    tx()
    console.log('[db] wipeUserData: cleared all user-owned rows from local SQLite')
  }

  // Returns true if the row was actually different from what was already in
  // local SQLite (and therefore the write changed data), false if the row was
  // identical or the upsert was skipped due to staleness. The sync module uses
  // this count to decide whether to emit sync:dataUpdated to the renderer.
  function upsertFromCloud(table: string, row: Record<string, unknown>): boolean {
    if (!ALLOWED_SYNC_TABLES.has(table)) return false

    // Coerce value types: ISO dates → unix ms, booleans → 0/1.
    const coerced: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      coerced[k] = coerceCloudValue(v)
    }

    // Conflict check: skip if local row has a newer updated_at.
    try {
      const existing = db.prepare(
        `SELECT updated_at FROM ${table} WHERE id = ?`
      ).get(coerced.id as string) as { updated_at?: number } | undefined

      if (
        existing &&
        existing.updated_at != null &&
        typeof coerced.updated_at === 'number' &&
        (existing.updated_at as number) > coerced.updated_at
      ) return false
    } catch {
      // Table has no updated_at column — fall through to the value-equality check.
    }

    // Filter to columns that actually exist in the local SQLite table.
    const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    const knownCols = new Set(tableInfo.map(c => c.name))
    const filtered  = Object.fromEntries(
      Object.entries(coerced).filter(([k]) => knownCols.has(k))
    )

    if (Object.keys(filtered).length === 0) return false

    // Change detection: read existing row, compare with new row field-by-field.
    // If every field in the new row already matches local, this upsert is a no-op
    // and we don't need to notify the UI to re-fetch.
    const existingRow = db.prepare(`SELECT * FROM ${table} WHERE id = ?`)
      .get(coerced.id as string) as Record<string, unknown> | undefined

    if (existingRow) {
      let allEqual = true
      for (const [k, v] of Object.entries(filtered)) {
        // Compare via != to coerce 0/1 ↔ false/true safely.
        // Buffer columns (voice_profiles.embedding) compare by reference; fine — we'd
        // rather re-emit than miss a real change for a binary column.
        if (existingRow[k] !== v && String(existingRow[k] ?? '') !== String(v ?? '')) {
          allEqual = false
          break
        }
      }
      if (allEqual) return false
    }

    const cols         = Object.keys(filtered).join(', ')
    const placeholders = Object.keys(filtered).map(() => '?').join(', ')
    const vals         = Object.values(filtered)

    db.prepare(`INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`).run(vals)
    return true
  }

  return {
    // meetings
    createMeeting,
    finalizeMeeting,
    updateMeetingTitle,
    confirmMeeting,
    setMeetingRequiresLabelling,
    updateMeetingSummary,
    getMeetingById,
    getMeetingReviewPayload,
    // speakers
    createSpeakers,
    createSelfSpeaker,
    resolveSpeaker,
    bulkResolveSpeakers,
    getSpeakersByMeeting,
    updateSpeakerEmail,
    updateSpeakerHasCornflake,
    // utterances
    createUtterances,
    getUtterancesByMeeting,
    // tasks
    createTasks,
    createStandaloneTask,
    updateTask,
    confirmTask,
    approveTaskToList,
    dismissTask,
    completeTask,
    getTasksByMeeting,
    getTasksBySpeaker,
    getTasksByList,
    getTaskById,
    reorderTasks,
    // lists
    getAllLists,
    createList,
    deleteList,
    // past meetings
    softDeleteMeeting,
    undeleteMeeting,
    hardDeleteMeeting,
    getDismissedTaskQuotes,
    deletePendingTasksForMeeting,
    restoreDismissedTasks,
    restoreTask,
    hardDeleteTask,
    getPastMeetings,
    getTrashedMeetings,
    getMeetingDetail,
    // users table
    upsertUser,
    getUserById,
    // user profile markdown
    getUserProfileMd,
    upsertUserProfileMd,
    // user profile
    saveUserProfile,
    getUserProfile,
    deleteUserProfile,
    // decisions
    createDecisions,
    getDecisionsByMeeting,
    getAllDecisions,
    getDecisionById,
    getChildDecisions,
    updateDecisionText,
    deleteDecision,
    // comms
    createComms,
    updateCommMessage,
    setCommSend,
    setCommDeliveryChannel,
    updateCommRecipientEmail,
    markCommSent,
    markCommFailed,
    getCommsByMeeting,
    regenerateCommsForMeeting,
    // oauth tokens
    saveOAuthTokens,
    getOAuthTokens,
    deleteOAuthTokens,
    // generic meta
    getMetaValue,
    setMetaValue,
    deleteMetaValue,
    // sync
    upsertFromCloud,
    wipeUserData,
  }
}

export type Queries = ReturnType<typeof buildQueries>
