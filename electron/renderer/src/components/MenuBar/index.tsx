import React, { useState, useCallback, useEffect, useRef } from 'react'
import {
  useStartManual,
  useStopRecording,
  useDiscardRecording,
  useUpdateTitle,
  useConnectCalendar,
  useGetCalendarStatus,
  useOnRecordingStarted,
  useOnCalendarEventsUpdated,
  useOnSpeakerAdded,
  type RecordingStartedPayload,
  type CalendarEvent,
  type SpeakerAddedPayload,
} from '../../hooks/useIPC'

// ---------------------------------------------------------------------------
// Date grouping helpers
// ---------------------------------------------------------------------------

const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] as const
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dateGroupLabel(ms: number): string {
  const now = new Date()
  const todayKey     = dayKey(now.getTime())
  const tomorrowKey  = dayKey(now.getTime() + 86400000)
  const key          = dayKey(ms)
  if (key === todayKey)    return 'Today'
  if (key === tomorrowKey) return 'Tomorrow'
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

interface EventGroup { label: string; events: CalendarEvent[] }

function groupByDate(events: CalendarEvent[]): EventGroup[] {
  const map = new Map<string, EventGroup>()
  for (const ev of events) {
    const label = dateGroupLabel(ev.startMs)
    if (!map.has(label)) map.set(label, { label, events: [] })
    map.get(label)!.events.push(ev)
  }
  return [...map.values()]
}

// An event is tap-to-start eligible within 10 minutes of its start time
// (or if it has already started, so ongoing meetings are always clickable).
function isStartEligible(event: CalendarEvent): boolean {
  return event.startMs - Date.now() <= 10 * 60 * 1000
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppState = 'idle' | 'recording'

interface ActiveMeeting {
  meetingId: string
  title: string
  startMs: number
}

// ---------------------------------------------------------------------------
// Elapsed timer
// ---------------------------------------------------------------------------

function useElapsedTimer(startMs: number | null): string {
  const [elapsed, setElapsed] = useState('0:00')

  useEffect(() => {
    if (startMs === null) {
      setElapsed('0:00')
      return
    }
    const tick = () => {
      const secs = Math.floor((Date.now() - startMs) / 1000)
      const m = Math.floor(secs / 60)
      const s = (secs % 60).toString().padStart(2, '0')
      setElapsed(`${m}:${s}`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [startMs])

  return elapsed
}

// ---------------------------------------------------------------------------
// MenuBar component
// ---------------------------------------------------------------------------

export default function MenuBar() {
  const [appState, setAppState] = useState<AppState>('idle')
  const [activeMeeting, setActiveMeeting] = useState<ActiveMeeting | null>(null)
  const [upcomingEvents, setUpcomingEvents] = useState<CalendarEvent[]>([])
  const [detectedSpeakers, setDetectedSpeakers] = useState<SpeakerAddedPayload[]>([])
  const [calendarConnected, setCalendarConnected] = useState(false)
  const [isConnectingCalendar, setIsConnectingCalendar] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  const elapsed = useElapsedTimer(activeMeeting?.startMs ?? null)

  const startManual = useStartManual()
  const stopRecording = useStopRecording()
  const discardRecording = useDiscardRecording()
  const updateTitle = useUpdateTitle()
  const connectCalendar = useConnectCalendar()
  const getCalendarStatus = useGetCalendarStatus()

  // Check whether calendar is already connected on mount
  useEffect(() => {
    getCalendarStatus().then(({ isConnected }) => {
      setCalendarConnected(isConnected)
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // IPC events from main process
  const handleRecordingStarted = useCallback((payload: RecordingStartedPayload) => {
    setActiveMeeting({ meetingId: payload.meetingId, title: payload.title, startMs: Date.now() })
    setDetectedSpeakers([])
    setAppState('recording')
  }, [])

  // Replace the full event list on each update — avoids stale/duplicate events
  const handleCalendarEventsUpdated = useCallback((events: CalendarEvent[]) => {
    setUpcomingEvents(events)
  }, [])

  const handleSpeakerAdded = useCallback((payload: SpeakerAddedPayload) => {
    setDetectedSpeakers(prev => {
      const exists = prev.some(s => s.speakerId === payload.speakerId)
      return exists ? prev : [...prev, payload]
    })
  }, [])

  useOnRecordingStarted(handleRecordingStarted)
  useOnCalendarEventsUpdated(handleCalendarEventsUpdated)
  useOnSpeakerAdded(handleSpeakerAdded)

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  async function handleStartListening() {
    setIsStarting(true)
    try {
      const result = await startManual()
      if (result && result.ok === false) {
        // Permission/capture errors surface inline in the main app's RightPanel.
        // From the menu-bar entry we just log; the user will see the message
        // when they open the main window.
        console.warn('[MenuBar] startManual refused:', result.code, result.message)
      }
    } finally {
      setIsStarting(false)
    }
  }

  async function handleStop() {
    await stopRecording()
    setAppState('idle')
    setActiveMeeting(null)
  }

  async function handleDiscard() {
    if (!window.confirm('Discard this recording? This cannot be undone.')) return
    await discardRecording()
    setAppState('idle')
    setActiveMeeting(null)
    setDetectedSpeakers([])
  }

  async function handleConnectCalendar() {
    setIsConnectingCalendar(true)
    try {
      await connectCalendar()
      setCalendarConnected(true)
    } catch (err) {
      console.error('Calendar connect failed:', err)
    } finally {
      setIsConnectingCalendar(false)
    }
  }

  function startEditingTitle() {
    if (!activeMeeting) return
    setTitleDraft(activeMeeting.title)
    setEditingTitle(true)
    setTimeout(() => titleInputRef.current?.select(), 0)
  }

  async function commitTitleEdit() {
    if (!activeMeeting || !titleDraft.trim()) {
      setEditingTitle(false)
      return
    }
    const newTitle = titleDraft.trim()
    setActiveMeeting(prev => prev ? { ...prev, title: newTitle } : null)
    setEditingTitle(false)
    await updateTitle(activeMeeting.meetingId, newTitle)
  }

  function handleTitleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') commitTitleEdit()
    if (e.key === 'Escape') setEditingTitle(false)
  }

  // ---------------------------------------------------------------------------
  // Render: idle state
  // ---------------------------------------------------------------------------

  if (appState === 'idle') {
    return (
      <div className="min-h-screen bg-amber-50 flex items-start justify-center pt-12">
        <div className="w-80 bg-white rounded-2xl shadow-xl border border-amber-100 overflow-hidden">
          {/* Header */}
          <div className="px-5 py-4 border-b border-amber-100 flex items-center gap-2">
            <span className="text-amber-600 font-bold tracking-tight text-lg">cornflake</span>
          </div>

          {/* Start listening */}
          <div className="px-5 py-4">
            <button
              onClick={handleStartListening}
              disabled={isStarting}
              className="w-full bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
            >
              {isStarting ? 'Starting…' : '▶  Start listening'}
            </button>
          </div>

          {/* Upcoming meetings — grouped by date */}
          {upcomingEvents.length > 0 && (
            <div className="border-t border-amber-100">
              {groupByDate(upcomingEvents).map(({ label, events }) => (
                <div key={label}>
                  <p className="px-5 pt-3 pb-1 text-xs font-semibold text-gray-400 uppercase tracking-wide">
                    {label}
                  </p>
                  <ul>
                    {events.map(event => {
                      const eligible = isStartEligible(event)
                      return (
                        <li key={event.id}>
                          <button
                            onClick={eligible ? handleStartListening : undefined}
                            disabled={!eligible}
                            title={eligible ? undefined : 'Available to start within 10 minutes of the event'}
                            className={`w-full text-left px-5 py-2.5 transition-colors ${
                              eligible
                                ? 'hover:bg-amber-50 cursor-pointer'
                                : 'opacity-40 cursor-default'
                            }`}
                          >
                            <p className="text-sm font-medium text-gray-800 truncate">{event.title}</p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {new Date(event.startMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              {event.attendees.length > 0 && (
                                <> · {event.attendees.length} attendee{event.attendees.length !== 1 ? 's' : ''}</>
                              )}
                            </p>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {/* Calendar connect — hidden once connected */}
          {!calendarConnected && (
            <div className="px-5 py-4 border-t border-amber-100">
              <button
                onClick={handleConnectCalendar}
                disabled={isConnectingCalendar}
                className="w-full text-left text-xs text-gray-400 hover:text-amber-600 transition-colors py-1"
              >
                {isConnectingCalendar ? 'Connecting…' : '+ Connect Google Calendar'}
              </button>
            </div>
          )}
          {/* Connected indicator — replaces the connect prompt */}
          {calendarConnected && upcomingEvents.length === 0 && (
            <div className="px-5 py-4 border-t border-amber-100">
              <p className="text-xs text-gray-400">Google Calendar connected · no upcoming events</p>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Render: active recording state
  // ---------------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-amber-50 flex items-start justify-center pt-12">
      <div className="w-80 bg-white rounded-2xl shadow-xl border border-amber-100 overflow-hidden">
        {/* Header with live indicator */}
        <div className="px-5 py-4 border-b border-amber-100 flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
          </span>
          <span className="text-amber-600 font-bold tracking-tight text-lg">cornflake</span>
          <span className="ml-auto text-xs text-gray-400 tabular-nums">{elapsed}</span>
        </div>

        {/* Meeting title — inline editable */}
        <div className="px-5 py-4 border-b border-amber-100">
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={commitTitleEdit}
              onKeyDown={handleTitleKeyDown}
              className="w-full text-sm font-medium text-gray-800 border-b border-amber-300 outline-none bg-transparent pb-0.5"
              autoFocus
            />
          ) : (
            <button
              onClick={startEditingTitle}
              className="w-full text-left text-sm font-medium text-gray-800 hover:text-amber-600 transition-colors truncate flex items-center gap-1.5"
              title="Click to rename"
            >
              {activeMeeting?.title}
              <span className="text-gray-300 text-xs">✏</span>
            </button>
          )}
        </div>

        {/* Detected speakers */}
        {detectedSpeakers.length > 0 && (
          <div className="px-5 py-3 border-b border-amber-100">
            <p className="text-xs text-gray-400 mb-2 font-medium">Speakers detected</p>
            <div className="flex flex-wrap gap-1.5">
              {detectedSpeakers.map(s => (
                <span
                  key={s.speakerId}
                  className="inline-block bg-amber-100 text-amber-800 text-xs font-medium px-2 py-0.5 rounded-full"
                >
                  {s.label}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="px-5 py-4 space-y-2">
          <button
            onClick={handleStop}
            className="w-full bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
          >
            Stop and review
          </button>
          <button
            onClick={handleDiscard}
            className="w-full text-xs text-red-400 hover:text-red-600 transition-colors py-1"
          >
            Discard recording
          </button>
        </div>
      </div>
    </div>
  )
}
