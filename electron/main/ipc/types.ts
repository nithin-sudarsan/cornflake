// All IPC channel names. Both main-side handlers and the preload bridge reference this file.

// Main → Renderer (push events, sent via webContents.send)
export const MAIN_CHANNELS = {
  MEETING_UPCOMING:        'meeting:upcoming',
  CALENDAR_EVENTS_UPDATED: 'calendar:eventsUpdated',
  RECORDING_STARTED:       'recording:started',
  RECORDING_SPEAKER_ADDED: 'recording:speakerAdded',
  PROCESSING_COMPLETE:     'processing:complete',
  COMMS_SENT:              'comms:sent',
  AUTH_STATUS:             'auth:status',
  AUTH_LOGIN:              'auth:login',
  AUTH_LOGOUT:             'auth:logout',
  SYNC_PULL_START:         'sync:pullStart',
  SYNC_PULL_COMPLETE:      'sync:pullComplete',
  SYNC_DATA_UPDATED:       'sync:dataUpdated',
  UPDATE_AVAILABLE:        'update:available',
  UPDATE_DOWNLOADED:       'update:downloaded',
  // Tray-initiated UI actions — main asks the renderer to run its own
  // start/stop/discard handlers so we keep a single code path.
  TRAY_REQUEST_START:      'tray:requestStart',
  TRAY_REQUEST_STOP:       'tray:requestStop',
  TRAY_REQUEST_DISCARD:    'tray:requestDiscard',
} as const

// Renderer → Main (invoked calls, handled via ipcMain.handle)
export const RENDERER_CHANNELS = {
  RENDERER_READY:          'renderer:ready',
  AUTH_INITIATE_LOGIN:     'auth:initiateLogin',
  AUTH_GET_SESSION:        'auth:getSession',
  AUTH_LOGOUT:             'auth:logout',
  PROCESSING_ACK:          'processing:ack',
  RECORDING_START_MANUAL:  'recording:startManual',
  RECORDING_STOP:          'recording:stop',
  RECORDING_DISCARD:       'recording:discard',
  RECORDING_UPDATE_TITLE:  'recording:updateTitle',
  TASKS_CONFIRM:           'tasks:confirm',
  COMMS_SEND:              'comms:send',
  COMMS_UPDATE_MESSAGE:    'comms:updateMessage',
  COMMS_UPDATE_RECIPIENT:  'comms:updateRecipient',
  COMMS_SET_CHANNEL:       'comms:setChannel',
  SPEAKERS_LABEL:          'speakers:label',
  SPEAKERS_CONFIRM:        'speakers:confirm',
  SPEAKERS_RESOLVE:        'speakers:resolve',
  PROFILES_UPDATE:         'profiles:update',
  CALENDAR_CONNECT:        'calendar:connect',
  CALENDAR_STATUS:         'calendar:status',
  CALENDAR_GET_EVENTS:     'calendar:getEvents',
  CALENDAR_GET_PROFILE:    'calendar:getProfile',
  CALENDAR_DISCONNECT:     'calendar:disconnect',
  TASKS_CREATE_STANDALONE: 'tasks:createStandalone',
  TASKS_GET_BY_LIST:       'tasks:getByList',
  TASK_DISMISS:            'task:dismiss',
  LISTS_GET_ALL:           'lists:getAll',
  LISTS_CREATE:            'lists:create',
  LISTS_DELETE:            'lists:delete',
  TASKS_COMPLETE:          'tasks:complete',
  MEETINGS_GET_PAST:           'meetings:getPast',
  MEETINGS_GET_TRASHED:        'meetings:getTrashed',
  MEETINGS_GET_DETAIL:         'meetings:getDetail',
  MEETINGS_SOFT_DELETE:        'meetings:softDelete',
  MEETINGS_UNDELETE:           'meetings:undelete',
  MEETINGS_HARD_DELETE:        'meetings:hardDelete',
  MEETINGS_RESTORE_DISMISSED:  'meetings:restoreDismissed',
  TASKS_RESTORE:               'tasks:restore',
  TASKS_HARD_DELETE:           'tasks:hardDelete',
  TASKS_GET_BY_ID:             'tasks:getById',
  TASKS_UPDATE_TITLE:          'tasks:updateTitle',
  TASKS_REORDER:               'tasks:reorder',
  TASKS_UPDATE:                'tasks:update',
  TASKS_APPROVE_DISMISS:       'tasks:approveDismiss',
  TASKS_APPROVE_WITH_LISTS:    'tasks:approveWithLists',
  PERMISSIONS_OPEN_MIC:        'permissions:openMicSettings',
  PERMISSIONS_OPEN_SCREEN:     'permissions:openScreenSettings',
  SHELL_OPEN_EXTERNAL:         'shell:openExternal',
  APP_RELAUNCH:                'app:relaunch',
  UPDATE_CHECK:                'update:check',
  UPDATE_INSTALL:              'update:install',
  DECISIONS_GET_ALL:           'decisions:getAll',
  DECISIONS_GET_BY_ID:         'decisions:getById',
  DECISIONS_UPDATE_TEXT:       'decisions:updateText',
  DECISIONS_DELETE:            'decisions:delete',
} as const

export type MainChannel = typeof MAIN_CHANNELS[keyof typeof MAIN_CHANNELS]
export type RendererChannel = typeof RENDERER_CHANNELS[keyof typeof RENDERER_CHANNELS]

// Payload types — stubs for now; filled in as modules are built
export interface CalendarEvent {
  id: string
  title: string
  startMs: number
  endMs: number
  meetingLink?: string
  attendees: Array<{ name: string; email: string }>
}

export interface RecordingStartedPayload {
  meetingId: string
  title: string
}

export interface SpeakerAddedPayload {
  speakerId: string
  label: string
}

// ReviewPayload, ConfirmedTasks, ConfirmedComms, SpeakerLabelMap, SpeakerCorrections
// are defined as stubs here and will be expanded in their respective modules.
export type ReviewPayload = Record<string, unknown>
export type ConfirmedTasks = Record<string, unknown>
export type ConfirmedComms = Record<string, unknown>
export type SpeakerLabelMap = Record<string, string>
export type SpeakerCorrections = Record<string, unknown>

export interface CommsSentPayload {
  success: string[]
  failed: string[]
}
