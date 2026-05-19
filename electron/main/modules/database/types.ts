export type Confidence = 'high' | 'medium' | 'low' | 'manual'
export type TaskStatus   = 'awaiting_approval' | 'pending' | 'confirmed' | 'dismissed'
export type TaskPriority = 'normal' | 'high' | 'urgent'
export type DeliveryChannel = 'push' | 'email' | 'both'

export interface Meeting {
  id: string
  title: string
  startMs: number
  endMs: number | null
  calendarEventId: string | null
  requiresManualLabelling: boolean
  summary: string | null
  confirmedAt: number | null
  createdAt: number
}

export interface Speaker {
  id: string
  meetingId: string
  deepgramId: string | null
  name: string | null
  email: string | null
  isSelf: boolean
  confidence: Confidence | null
  hasCornflake: boolean
  createdAt: number
}

export interface Utterance {
  id: string
  meetingId: string
  speakerId: string
  text: string
  startMs: number
  endMs: number
  createdAt: number
}

export interface Task {
  id: string
  meetingId: string | null
  meetingTitle: string | null     // joined from meetings table, only populated by list queries
  assigneeSpeakerId: string | null
  title: string
  deadlineText: string | null
  deadlineMs: number | null
  remindOffsetMs: number | null
  remindAtMs: number | null
  transcriptQuote: string | null
  extractionConfidence: Confidence | null
  status: TaskStatus
  note: string | null
  listName: string
  originList: string | null
  sortOrder: number | null
  priority: TaskPriority
  completedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface TaskForApproval {
  id: string
  title: string
  assigneeSpeakerId: string | null
  assigneeName: string | null
  isSelfAssigned: boolean
  deadlineText: string | null
  deadlineMs: number | null
  transcriptQuote: string | null
  extractionConfidence: Confidence | null
  note: string | null
}

export interface ListRecord {
  id: string
  name: string
  createdAt: number
}

export interface PastMeeting {
  id: string
  title: string
  startMs: number
  endMs: number | null
  confirmedAt: number
  summaryPreview: string | null
  pendingTaskCount: number
  /** Non-self speaker names with a known label, deduped. */
  participants: string[]
}

export interface TaskDetail {
  id: string
  title: string
  deadlineMs: number | null
  deadlineText: string | null
  priority: TaskPriority
  note: string | null
  listName: string
  meetingId: string | null
  meetingTitle: string | null   // null if no meeting or meeting is deleted
  status: TaskStatus
}

export interface MeetingDetailData {
  id: string
  title: string
  startMs: number
  endMs: number | null
  summary: string | null
  decisions: { text: string }[]
  pendingTasks: TaskForApproval[]
  hasExtractedTasks: boolean    // true if any tasks (any status) exist for this meeting
  hasDismissedTasks: boolean    // true if dismissed tasks exist (restore button shown)
  speakers: { id: string; name: string | null; isSelf: boolean }[]
  utterances: { id: string; text: string; startMs: number; speakerName: string | null }[]
}

export interface Decision {
  id: string
  meetingId: string
  text: string
  createdAt: number
}

export interface Comm {
  id: string
  meetingId: string
  recipientSpeakerId: string
  messageBody: string
  deliveryChannel: DeliveryChannel
  recipientEmail: string | null
  hasCornflake: boolean
  includeInstallInvite: boolean
  send: boolean
  sentAt: number | null
  sendError: string | null
  createdAt: number
  updatedAt: number
}

export interface VoiceProfile {
  id: string
  name: string
  email: string | null
  embedding: Buffer
  sampleCount: number
  updatedAt: number
  createdAt: number
}

export interface ReviewPayload {
  meeting: Meeting
  speakers: Speaker[]
  tasks: Task[]
  decisions: Decision[]
  comms: Comm[]
}

// Input shapes for create helpers (no id/timestamps — generated internally)

export interface NewTask {
  meetingId: string | null
  assigneeSpeakerId: string | null
  title: string
  deadlineText: string | null
  deadlineMs: number | null
  remindOffsetMs?: number | null
  remindAtMs?: number | null
  transcriptQuote: string | null
  extractionConfidence: Confidence | null
  note?: string | null
  listName?: string
}

export interface NewComm {
  meetingId: string
  recipientSpeakerId: string
  messageBody: string
  deliveryChannel: DeliveryChannel
  recipientEmail: string | null
  hasCornflake: boolean
  includeInstallInvite: boolean
}
