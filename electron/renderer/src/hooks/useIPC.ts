import { useEffect, useCallback } from 'react'

// Typed wrappers around window.electronAPI for use in React components.

export interface RecordingStartedPayload {
  meetingId: string
  title: string
}

export interface CalendarEvent {
  id: string
  title: string
  startMs: number
  endMs: number
  meetingLink?: string
  attendees: Array<{ name: string; email: string }>
}

export interface SpeakerAddedPayload {
  speakerId: string
  label: string
}

// ---------------------------------------------------------------------------
// Invoke helpers (renderer → main)
// ---------------------------------------------------------------------------

export type StartManualResult =
  | { ok: true;  meetingId: string; title: string }
  | { ok: false; code: 'mic_denied' | 'audio_denied' | 'capture_failed'; message: string }
  | null

export function useStartManual() {
  return useCallback(async (): Promise<StartManualResult> => {
    return window.electronAPI.startManual() as Promise<StartManualResult>
  }, [])
}

export function useStopRecording() {
  return useCallback(async () => {
    return window.electronAPI.stopRecording()
  }, [])
}

export function useDiscardRecording() {
  return useCallback(async () => {
    return window.electronAPI.discardRecording()
  }, [])
}

export function useUpdateTitle() {
  return useCallback(async (meetingId: string, title: string) => {
    return window.electronAPI.updateTitle({ meetingId, title })
  }, [])
}

export function useConnectCalendar() {
  return useCallback(async () => {
    return window.electronAPI.connectCalendar()
  }, [])
}

export function useGetCalendarStatus() {
  return useCallback(async (): Promise<{ isConnected: boolean }> => {
    return window.electronAPI.getCalendarStatus()
  }, [])
}

export function useGetCalendarProfile() {
  return useCallback(async (): Promise<{ name: string | null; email: string | null }> => {
    return window.electronAPI.getCalendarProfile()
  }, [])
}

export function useDisconnectCalendar() {
  return useCallback(async (): Promise<{ success: boolean }> => {
    return window.electronAPI.disconnectCalendar()
  }, [])
}

export type TaskPriority = 'normal' | 'high' | 'urgent'

export interface TaskSummary {
  id: string
  title: string
  listName: string
  meetingId: string | null
  meetingTitle: string | null
  originList: string | null
  priority: TaskPriority
  completedAt: number | null
  deadlineText: string | null
  deadlineMs: number | null
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
  meetingTitle: string | null
  status: string
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
  extractionConfidence: string | null
  note: string | null
}

export interface PastMeeting {
  id: string
  title: string
  startMs: number
  endMs: number | null
  confirmedAt: number
  summaryPreview: string | null
  pendingTaskCount: number
}

export interface MeetingDetailData {
  id: string
  title: string
  startMs: number
  endMs: number | null
  summary: string | null
  decisions: { text: string }[]
  pendingTasks: TaskForApproval[]
  hasExtractedTasks: boolean
  hasDismissedTasks: boolean
  speakers: {
    id: string
    name: string | null
    isSelf: boolean
    confidence: string | null
    deepgramId: string | null
  }[]
  utterances: { id: string; text: string; startMs: number; speakerName: string | null }[]
}

export interface ListRecord {
  id: string
  name: string
  createdAt: number
}

export function useCreateStandaloneTask() {
  return useCallback(async (title: string, listName: string): Promise<TaskSummary> => {
    return window.electronAPI.createStandaloneTask({ title, listName }) as unknown as Promise<TaskSummary>
  }, [])
}

export function useGetTasksByList() {
  return useCallback(async (listName: string): Promise<TaskSummary[]> => {
    return window.electronAPI.getTasksByList(listName) as Promise<TaskSummary[]>
  }, [])
}

export function useDismissTask() {
  return useCallback(async (taskId: string): Promise<void> => {
    return window.electronAPI.dismissTask(taskId)
  }, [])
}

export function useGetAllLists() {
  return useCallback(async (): Promise<ListRecord[]> => {
    return window.electronAPI.getAllLists()
  }, [])
}

export function useCreateList() {
  return useCallback(async (name: string): Promise<ListRecord> => {
    return window.electronAPI.createList(name)
  }, [])
}

export function useDeleteList() {
  return useCallback(async (listId: string): Promise<void> => {
    return window.electronAPI.deleteList(listId)
  }, [])
}

export function useCompleteTask() {
  return useCallback(async (taskId: string, originList: string): Promise<void> => {
    return window.electronAPI.completeTask({ taskId, originList })
  }, [])
}

export function useGetPastMeetings() {
  return useCallback(async (): Promise<PastMeeting[]> => {
    return window.electronAPI.getPastMeetings() as Promise<PastMeeting[]>
  }, [])
}

export function useGetTrashedMeetings() {
  return useCallback(async (): Promise<PastMeeting[]> => {
    return window.electronAPI.getTrashedMeetings() as Promise<PastMeeting[]>
  }, [])
}

export function useGetMeetingDetail() {
  return useCallback(async (meetingId: string): Promise<MeetingDetailData | null> => {
    return window.electronAPI.getMeetingDetail(meetingId) as Promise<MeetingDetailData | null>
  }, [])
}

export function useSoftDeleteMeeting() {
  return useCallback(async (meetingId: string): Promise<void> => {
    return window.electronAPI.softDeleteMeeting(meetingId)
  }, [])
}

export function useUndeleteMeeting() {
  return useCallback(async (meetingId: string): Promise<void> => {
    return window.electronAPI.undeleteMeeting(meetingId)
  }, [])
}

export function useHardDeleteMeeting() {
  return useCallback(async (meetingId: string): Promise<void> => {
    return window.electronAPI.hardDeleteMeeting(meetingId)
  }, [])
}

export function useRestoreDismissedTasks() {
  return useCallback(async (meetingId: string): Promise<void> => {
    return window.electronAPI.restoreDismissedTasks(meetingId)
  }, [])
}

export function useRestoreTask() {
  return useCallback(async (taskId: string): Promise<void> => {
    return window.electronAPI.restoreTask(taskId)
  }, [])
}

export function useHardDeleteTask() {
  return useCallback(async (taskId: string): Promise<void> => {
    return window.electronAPI.hardDeleteTask(taskId)
  }, [])
}

export function useGetTaskById() {
  return useCallback(async (taskId: string): Promise<TaskDetail | null> => {
    return window.electronAPI.getTaskById(taskId) as Promise<TaskDetail | null>
  }, [])
}

export function useUpdateTask() {
  return useCallback(async (payload: {
    taskId: string
    title?: string
    deadlineText?: string | null
    deadlineMs?: number | null
    assigneeSpeakerId?: string | null
    note?: string | null
    priority?: TaskPriority
  }): Promise<void> => {
    return window.electronAPI.updateTask(payload)
  }, [])
}

export function useApproveDismissTasks() {
  return useCallback(async (approvedIds: string[], dismissedIds: string[]): Promise<void> => {
    return window.electronAPI.approveDismissTasks({ approvedIds, dismissedIds })
  }, [])
}

export function useApproveWithLists() {
  return useCallback(async (
    approvals: { id: string; listName: string }[],
    dismissedIds: string[],
  ): Promise<void> => {
    return window.electronAPI.approveWithLists({ approvals, dismissedIds })
  }, [])
}

export function useUpdateTaskTitle() {
  return useCallback(async (taskId: string, title: string): Promise<void> => {
    return window.electronAPI.updateTaskTitle({ taskId, title })
  }, [])
}

export function useReorderTasks() {
  return useCallback(async (orderedIds: string[]): Promise<void> => {
    return window.electronAPI.reorderTasks(orderedIds)
  }, [])
}

export interface SpeakerResolution {
  speakerId: string
  name:      string
  email?:    string
}

export function useLabelSpeakers() {
  return useCallback(async (
    meetingId:   string,
    resolutions: SpeakerResolution[]
  ): Promise<void> => {
    await window.electronAPI.labelSpeakers({ meetingId, resolutions })
  }, [])
}

export function useConfirmSpeaker() {
  return useCallback(async (meetingId: string, speakerId: string): Promise<void> => {
    await window.electronAPI.confirmSpeaker({ meetingId, speakerId })
  }, [])
}

export function useResolveSpeaker() {
  return useCallback(async (
    meetingId: string,
    speakerId: string,
    name: string,
    email?: string,
  ): Promise<void> => {
    await window.electronAPI.resolveSpeaker({ meetingId, speakerId, name, email })
  }, [])
}

export function useUpdateProfiles() {
  return useCallback(async (
    meetingId:   string,
    corrections: SpeakerResolution[]
  ): Promise<void> => {
    await window.electronAPI.updateProfiles({ meetingId, corrections })
  }, [])
}

// ---------------------------------------------------------------------------
// Event subscription helpers (main → renderer)
// ---------------------------------------------------------------------------

export function useOnRecordingStarted(cb: (payload: RecordingStartedPayload) => void) {
  useEffect(() => {
    window.electronAPI.onRecordingStarted(cb as (p: unknown) => void)
    return () => window.electronAPI.removeAllListeners('recording:started')
  }, [cb])
}

export function useOnMeetingUpcoming(cb: (event: CalendarEvent) => void) {
  useEffect(() => {
    window.electronAPI.onMeetingUpcoming(cb as (p: unknown) => void)
    return () => window.electronAPI.removeAllListeners('meeting:upcoming')
  }, [cb])
}

export function useOnCalendarEventsUpdated(cb: (events: CalendarEvent[]) => void) {
  useEffect(() => {
    window.electronAPI.onCalendarEventsUpdated(cb as (p: unknown) => void)
    return () => window.electronAPI.removeAllListeners('calendar:eventsUpdated')
  }, [cb])
}

export function useOnSpeakerAdded(cb: (payload: SpeakerAddedPayload) => void) {
  useEffect(() => {
    window.electronAPI.onSpeakerAdded(cb as (p: unknown) => void)
    return () => window.electronAPI.removeAllListeners('recording:speakerAdded')
  }, [cb])
}

export interface AuthStatusPayload {
  isConnected: boolean
  name: string | null
  email: string | null
  picture: string | null
}

export function useOnAuthStatus(cb: (status: AuthStatusPayload) => void) {
  useEffect(() => {
    window.electronAPI.onAuthStatus(cb as (p: unknown) => void)
    return () => window.electronAPI.removeAllListeners('auth:status')
  }, [cb])
}

export interface UnresolvedSpeaker {
  id:         string
  deepgramId: string
  label:      string  // "Speaker A", "Speaker B" …
}

export interface ProcessingCompletePayload {
  meetingId:               string
  requiresManualLabelling: boolean
  unresolvedSpeakers:      UnresolvedSpeaker[]
  error?:                  string
}

export function useOnProcessingComplete(cb: (payload: ProcessingCompletePayload) => void) {
  useEffect(() => {
    window.electronAPI.onProcessingComplete(cb as (p: unknown) => void)
    return () => window.electronAPI.removeAllListeners('processing:complete')
  }, [cb])
}
