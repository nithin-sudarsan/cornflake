declare module '*.css' {
  const content: Record<string, string>
  export default content
}

// Image assets bundled via webpack's asset/inline — resolve to a data URL string.
declare module '*.png' { const url: string; export default url }
declare module '*.jpg' { const url: string; export default url }
declare module '*.jpeg' { const url: string; export default url }
declare module '*.gif' { const url: string; export default url }
declare module '*.svg' { const url: string; export default url }

// Typed shape of window.electronAPI exposed by the preload script via contextBridge.
interface ElectronAPI {
  // Auth
  initiateLogin: () => Promise<null>
  getSession: () => Promise<{ id: string; email: string; name: string | null; avatarUrl: string | null } | null>
  logoutAuth: () => Promise<null>

  // Renderer → Main (invoke)
  rendererReady: () => Promise<null>
  ackProcessingComplete: () => void
  startManual: (opts?: { calendarEventId?: string }) => Promise<
    | { ok: true;  meetingId: string; title: string }
    | { ok: false; code: 'mic_denied' | 'audio_denied' | 'capture_failed'; message: string }
    | null
  >
  stopRecording: () => Promise<unknown>
  discardRecording: () => Promise<unknown>
  updateTitle: (payload: { meetingId: string; title: string }) => Promise<unknown>
  confirmTasks: (payload: unknown) => Promise<unknown>
  sendComms: (payload: unknown) => Promise<unknown>
  labelSpeakers: (payload: unknown) => Promise<unknown>
  confirmSpeaker: (payload: unknown) => Promise<unknown>
  resolveSpeaker: (payload: unknown) => Promise<unknown>
  updateProfiles: (payload: unknown) => Promise<unknown>
  connectCalendar: () => Promise<{ connected: boolean }>
  getCalendarStatus: () => Promise<{ isConnected: boolean }>
  getCalendarEvents: () => Promise<Array<{ id: string; title: string; startMs: number; endMs: number; meetingLink?: string; attendees: Array<{ name: string; email: string }> }>>
  getCalendarProfile: () => Promise<{ name: string | null; email: string | null }>
  disconnectCalendar: () => Promise<{ success: boolean }>
  createStandaloneTask: (payload: { title: string; listName: string }) => Promise<{ id: string; title: string; listName: string; status: string }>
  getTasksByList: (listName: string) => Promise<Array<{ id: string; title: string; listName: string; priority: string; deadlineText: string | null; deadlineMs: number | null }>>
  dismissTask: (taskId: string) => Promise<void>
  getAllLists: () => Promise<Array<{ id: string; name: string; createdAt: number }>>
  createList: (name: string) => Promise<{ id: string; name: string; createdAt: number }>
  deleteList: (listId: string) => Promise<void>
  completeTask: (payload: { taskId: string; originList: string }) => Promise<void>
  getPastMeetings: () => Promise<Array<{ id: string; title: string; startMs: number; endMs: number | null; confirmedAt: number; summaryPreview: string | null; pendingTaskCount: number }>>
  getTrashedMeetings: () => Promise<Array<{ id: string; title: string; startMs: number; endMs: number | null; confirmedAt: number; summaryPreview: string | null; pendingTaskCount: number }>>
  updateTaskTitle: (payload: { taskId: string; title: string }) => Promise<void>
  reorderTasks: (orderedIds: string[]) => Promise<void>
  getMeetingDetail: (meetingId: string) => Promise<{
    id: string; title: string; startMs: number; endMs: number | null; summary: string | null;
    decisions: Array<{ text: string }>;
    pendingTasks: Array<{
      id: string; title: string; assigneeSpeakerId: string | null; assigneeName: string | null;
      isSelfAssigned: boolean; deadlineText: string | null; deadlineMs: number | null;
      transcriptQuote: string | null; extractionConfidence: string | null; note: string | null;
    }>;
    hasExtractedTasks: boolean;
    hasDismissedTasks: boolean;
    speakers: Array<{ id: string; name: string | null; isSelf: boolean; confidence: string | null; deepgramId: string | null }>;
    utterances: Array<{ id: string; text: string; startMs: number; speakerName: string | null }>;
  } | null>
  softDeleteMeeting: (meetingId: string) => Promise<void>
  undeleteMeeting: (meetingId: string) => Promise<void>
  hardDeleteMeeting: (meetingId: string) => Promise<void>
  restoreDismissedTasks: (meetingId: string) => Promise<void>
  restoreTask: (taskId: string) => Promise<void>
  hardDeleteTask: (taskId: string) => Promise<void>
  getTaskById: (taskId: string) => Promise<{
    id: string; title: string; deadlineMs: number | null; deadlineText: string | null;
    priority: string; note: string | null; listName: string;
    meetingId: string | null; meetingTitle: string | null; status: string;
  } | null>
  updateTask: (payload: { taskId: string; title?: string; deadlineText?: string | null; deadlineMs?: number | null; assigneeSpeakerId?: string | null; note?: string | null }) => Promise<void>
  approveDismissTasks: (payload: { approvedIds: string[]; dismissedIds: string[] }) => Promise<void>
  approveWithLists: (payload: { approvals: { id: string; listName: string }[]; dismissedIds: string[] }) => Promise<void>
  openMicSettings: () => Promise<null>
  openScreenSettings: () => Promise<null>
  relaunchApp: () => Promise<null>
  checkForUpdates: () => Promise<null>
  installUpdate: () => Promise<null>

  // Main → Renderer (event subscriptions)
  onMeetingUpcoming: (cb: (payload: unknown) => void) => void
  onCalendarEventsUpdated: (cb: (payload: unknown) => void) => void
  onRecordingStarted: (cb: (payload: unknown) => void) => void
  onSpeakerAdded: (cb: (payload: unknown) => void) => void
  onProcessingComplete:  (cb: (payload: unknown) => void) => void
  onCommsSent: (cb: (payload: unknown) => void) => void
  onAuthStatus: (cb: (payload: unknown) => void) => void
  onAuthLogin: (cb: (payload: unknown) => void) => void
  onAuthLogout: (cb: (payload: unknown) => void) => void
  onSyncPullStart: (cb: () => void) => void
  onSyncPullComplete: (cb: (payload: unknown) => void) => void
  onSyncDataUpdated: (cb: () => void) => void
  onUpdateAvailable: (cb: (payload: unknown) => void) => void
  onUpdateDownloaded: (cb: (payload: unknown) => void) => void
  onTrayRequestStart: (cb: () => void) => void
  onTrayRequestStop: (cb: () => void) => void
  onTrayRequestDiscard: (cb: () => void) => void
  removeAllListeners: (channel: string) => void
}

interface Window {
  electronAPI: ElectronAPI
}
