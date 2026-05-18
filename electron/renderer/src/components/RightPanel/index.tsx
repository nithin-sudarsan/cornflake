import React, { useState, useCallback, useEffect, useRef } from 'react'
import {
  useStartManual,
  useStopRecording,
  useDiscardRecording,
  useUpdateTitle,
  useOnRecordingStarted,
  useOnCalendarEventsUpdated,
  useOnSpeakerAdded,
  useOnAuthStatus,
  useGetPastMeetings,
  useGetTrashedMeetings,
  useSoftDeleteMeeting,
  useUndeleteMeeting,
  useHardDeleteMeeting,
  type RecordingStartedPayload,
  type CalendarEvent,
  type SpeakerAddedPayload,
  type AuthStatusPayload,
  type PastMeeting,
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

// For upcoming events (future): Today / Tomorrow / Day DD Mon
function upcomingDateLabel(ms: number): string {
  const now = new Date()
  const todayKey    = dayKey(now.getTime())
  const tomorrowKey = dayKey(now.getTime() + 86400000)
  const key         = dayKey(ms)
  if (key === todayKey)    return 'Today'
  if (key === tomorrowKey) return 'Tomorrow'
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

// For past meetings (past): Today / Yesterday / Day DD Mon
function pastDateLabel(ms: number): string {
  const now = new Date()
  const todayKey     = dayKey(now.getTime())
  const yesterdayKey = dayKey(now.getTime() - 86400000)
  const key          = dayKey(ms)
  if (key === todayKey)     return 'Today'
  if (key === yesterdayKey) return 'Yesterday'
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

interface EventGroup { label: string; events: CalendarEvent[] }
interface MeetingGroup { label: string; meetings: PastMeeting[] }

function groupByDate(events: CalendarEvent[]): EventGroup[] {
  const map = new Map<string, EventGroup>()
  for (const ev of events) {
    const label = upcomingDateLabel(ev.startMs)
    if (!map.has(label)) map.set(label, { label, events: [] })
    map.get(label)!.events.push(ev)
  }
  return [...map.values()]
}

function groupMeetingsByDate(meetings: PastMeeting[]): MeetingGroup[] {
  const map = new Map<string, MeetingGroup>()
  for (const m of meetings) {
    const label = pastDateLabel(m.startMs)
    if (!map.has(label)) map.set(label, { label, meetings: [] })
    map.get(label)!.meetings.push(m)
  }
  return [...map.values()]
}

function isStartEligible(event: CalendarEvent): boolean {
  return event.startMs - Date.now() <= 10 * 60 * 1000
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ---------------------------------------------------------------------------
// Elapsed timer
// ---------------------------------------------------------------------------

function useElapsedTimer(startMs: number | null): string {
  const [elapsed, setElapsed] = useState('0:00')
  useEffect(() => {
    if (startMs === null) { setElapsed('0:00'); return }
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
// RightPanel
// ---------------------------------------------------------------------------

type AppState = 'idle' | 'recording'
interface ActiveMeeting { meetingId: string; title: string; startMs: number }

interface RightPanelProps {
  onMeetingSelect: (meetingId: string) => void
  onCurrentMeetingDeleted?: () => void  // called when the currently-viewed meeting is deleted
  onRecordingStopped?: () => void
  notesRefreshKey?: number
  selectedMeetingId?: string | null     // tells RightPanel which meeting is open in main panel
}

function formatMeetingDate(startMs: number): string {
  return new Date(startMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatDuration(startMs: number, endMs: number | null): string {
  if (!endMs) return ''
  const mins = Math.round((endMs - startMs) / 60000)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export default function RightPanel({ onMeetingSelect, onCurrentMeetingDeleted, onRecordingStopped, notesRefreshKey = 0, selectedMeetingId: activeMeetingId }: RightPanelProps) {
  const [appState, setAppState]           = useState<AppState>('idle')
  const [activeMeeting, setActiveMeeting] = useState<ActiveMeeting | null>(null)
  const [upcomingEvents, setUpcomingEvents] = useState<CalendarEvent[]>([])
  const [detectedSpeakers, setDetectedSpeakers] = useState<SpeakerAddedPayload[]>([])
  const [isConnected, setIsConnected]     = useState(false)
  const [isStarting, setIsStarting]       = useState(false)
  const [startError, setStartError]       = useState<{ code: 'mic_denied' | 'screen_denied' | 'needs_restart' | 'capture_failed'; message: string } | null>(null)
  const [editingTitle, setEditingTitle]   = useState(false)
  const [titleDraft, setTitleDraft]       = useState('')
  const [pastMeetings, setPastMeetings]     = useState<PastMeeting[]>([])
  const [trashedMeetings, setTrashedMeetings] = useState<PastMeeting[]>([])
  const [rightPanelTab, setRightPanelTab]   = useState<'upcoming' | 'notes'>('upcoming')
  const [hoveredMeetingId, setHoveredMeetingId] = useState<string | null>(null)
  const [hoveredTrashId, setHoveredTrashId] = useState<string | null>(null)
  const [restoringId, setRestoringId]       = useState<string | null>(null)
  const [trashExpanded, setTrashExpanded]   = useState<boolean>(() => {
    try { return localStorage.getItem('cornflake-trash-expanded') === 'true' } catch { return false }
  })
  const titleInputRef = useRef<HTMLInputElement>(null)

  const elapsed = useElapsedTimer(activeMeeting?.startMs ?? null)

  const startManual      = useStartManual()
  const stopRecording    = useStopRecording()
  const discardRecording = useDiscardRecording()
  const updateTitle      = useUpdateTitle()
  const getPastMeetings      = useGetPastMeetings()
  const getTrashedMeetings   = useGetTrashedMeetings()
  const softDeleteMeetingIPC = useSoftDeleteMeeting()
  const undeleteMeetingIPC   = useUndeleteMeeting()
  const hardDeleteMeetingIPC = useHardDeleteMeeting()

  // Proactively fetch calendar state on mount. Covers the race where the watcher
  // pushed auth:status / CALENDAR_EVENTS_UPDATED before RightPanel mounted
  // (e.g. during SyncLoadingScreen → main UI swap). The watcher caches events
  // in main, and we pull both connection status and cached events here.
  useEffect(() => {
    window.electronAPI.getCalendarStatus()
      .then(({ isConnected: connected }) => setIsConnected(connected))
      .catch(() => {})
    window.electronAPI.getCalendarEvents()
      .then(events => { if (events.length > 0) setUpcomingEvents(events as CalendarEvent[]) })
      .catch(() => {})
  }, [])

  // Load both active and trashed meetings on mount and on refresh
  useEffect(() => {
    getPastMeetings().then(setPastMeetings).catch(() => {})
    getTrashedMeetings().then(setTrashedMeetings).catch(() => {})
  }, [notesRefreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Track connected state via auth:status push events (fired on load, connect, disconnect)
  const handleAuthStatus = useCallback((status: AuthStatusPayload) => {
    setIsConnected(status.isConnected)
    if (!status.isConnected) setUpcomingEvents([])
  }, [])
  useOnAuthStatus(handleAuthStatus)

  const handleRecordingStarted = useCallback((payload: RecordingStartedPayload) => {
    setActiveMeeting({ meetingId: payload.meetingId, title: payload.title, startMs: Date.now() })
    setDetectedSpeakers([])
    setAppState('recording')
  }, [])

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

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  async function handleStartListening() {
    setIsStarting(true)
    setStartError(null)
    try {
      const result = await startManual()
      if (result && result.ok === false) {
        // Inline error — no modal. The button area shows the message and a
        // deep-link to the relevant System Settings pane.
        if (result.code === 'mic_denied' || result.code === 'screen_denied' || result.code === 'needs_restart' || result.code === 'capture_failed') {
          setStartError({ code: result.code, message: result.message })
        }
      }
    } finally {
      setIsStarting(false)
    }
  }

  async function handleStop() {
    onRecordingStopped?.()       // show loading screen immediately in main panel
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

  function startEditingTitle() {
    if (!activeMeeting) return
    setTitleDraft(activeMeeting.title)
    setEditingTitle(true)
    setTimeout(() => titleInputRef.current?.select(), 0)
  }

  async function commitTitleEdit() {
    if (!activeMeeting || !titleDraft.trim()) { setEditingTitle(false); return }
    const newTitle = titleDraft.trim()
    setActiveMeeting(prev => prev ? { ...prev, title: newTitle } : null)
    setEditingTitle(false)
    await updateTitle(activeMeeting.meetingId, newTitle)
  }

  function handleTitleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter')  commitTitleEdit()
    if (e.key === 'Escape') setEditingTitle(false)
  }

  // -------------------------------------------------------------------------
  // Meeting Trash: soft delete → trash, restore, permanent delete
  // -------------------------------------------------------------------------

  function handleDeleteMeeting(meeting: PastMeeting) {
    softDeleteMeetingIPC(meeting.id).catch(() => {})
    setPastMeetings(prev => prev.filter(m => m.id !== meeting.id))
    setTrashedMeetings(prev => [meeting, ...prev])
    if (activeMeetingId === meeting.id) onCurrentMeetingDeleted?.()
  }

  async function handleRestoreMeeting(meeting: PastMeeting) {
    setRestoringId(meeting.id)
    // Await so deleted_at = NULL is committed before navigation opens the detail
    await undeleteMeetingIPC(meeting.id).catch(() => {})
    setTrashedMeetings(prev => prev.filter(m => m.id !== meeting.id))
    setPastMeetings(prev => {
      const next = [...prev, meeting]
      next.sort((a, b) => b.startMs - a.startMs)
      return next
    })
    setRestoringId(null)
    onMeetingSelect(meeting.id)
  }

  async function handlePermanentDelete(meeting: PastMeeting) {
    if (!window.confirm(`Permanently delete "${meeting.title}" and all its data? This cannot be undone.`)) return
    await hardDeleteMeetingIPC(meeting.id).catch(() => {})
    setTrashedMeetings(prev => prev.filter(m => m.id !== meeting.id))
  }

  function toggleTrash() {
    setTrashExpanded(prev => {
      const next = !prev
      try { localStorage.setItem('cornflake-trash-expanded', String(next)) } catch {}
      return next
    })
  }

  // -------------------------------------------------------------------------
  // Styles
  // -------------------------------------------------------------------------

  const panelStyle: React.CSSProperties = {
    width: 290,
    minWidth: 290,
    backgroundColor: 'var(--color-bg-surface)',
    borderLeft: '1px solid var(--color-divider)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',   // children manage their own scroll/padding
  }

  const btnPrimaryStyle: React.CSSProperties = {
    width: '100%',
    height: 44,
    borderRadius: 10,
    border: '1px solid var(--color-divider)',
    backgroundColor: 'var(--color-bg-deep)',
    color: 'var(--color-white)',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    transition: 'background-color 0.15s',
  }

  const dividerStyle: React.CSSProperties = {
    height: 1,
    backgroundColor: 'var(--color-divider)',
    margin: '16px 0',
  }

  const sectionHeaderStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--color-text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginTop: 16,
    marginBottom: 8,
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const showTrash = rightPanelTab === 'notes' && trashedMeetings.length > 0

  return (
    <aside style={panelStyle}>
      {/* ---- Fixed top section (non-scrolling) ---- */}
      <div style={{ padding: '0 16px', flexShrink: 0 }}>
        {/* Titlebar drag region */}
        <div style={{ height: 28, margin: '0 -16px 0', WebkitAppRegion: 'drag' } as React.CSSProperties} />

      {/* ---- Start listening / active recording ---- */}
      {appState === 'idle' ? (
        <>
          <button style={btnPrimaryStyle} onClick={handleStartListening} disabled={isStarting}>
            {isStarting ? 'Starting…' : 'Start listening'}
          </button>
          {startError && (
            <div style={{
              marginTop:       10,
              padding:         '10px 12px',
              backgroundColor: 'rgba(248, 113, 113, 0.08)',
              border:          '1px solid rgba(248, 113, 113, 0.35)',
              borderRadius:    6,
              fontSize:        12,
              color:           'var(--color-text-primary)',
              lineHeight:      1.4,
            }}>
              <div style={{ marginBottom: startError.code === 'capture_failed' ? 0 : 8 }}>{startError.message}</div>
              {startError.code !== 'capture_failed' && (
                <button
                  onClick={() => {
                    if      (startError.code === 'mic_denied')    window.electronAPI.openMicSettings()
                    else if (startError.code === 'needs_restart') window.electronAPI.relaunchApp()
                    else                                          window.electronAPI.openScreenSettings()
                  }}
                  style={{
                    background:   'transparent',
                    border:       '1px solid rgba(255,255,255,0.25)',
                    color:        'var(--color-text-primary)',
                    borderRadius: 4,
                    padding:      '4px 10px',
                    fontSize:     11,
                    fontWeight:   600,
                    cursor:       'pointer',
                    fontFamily:   'inherit',
                  }}
                >
                  {startError.code === 'needs_restart' ? 'Quit and Relaunch' : 'Open System Settings'}
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <div>
          {/* Active recording indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ position: 'relative', width: 10, height: 10, display: 'inline-flex' }}>
              <span
                style={{
                  position: 'absolute', inset: 0, borderRadius: '50%',
                  backgroundColor: '#22c55e', opacity: 0.75,
                  animation: 'ping 1s cubic-bezier(0,0,0.2,1) infinite',
                }}
              />
              <span style={{ position: 'relative', width: 10, height: 10, borderRadius: '50%', backgroundColor: '#22c55e' }} />
            </span>
            <span style={{ fontSize: 13, color: 'var(--color-text-primary)', flex: 1, fontWeight: 600 }}>Recording</span>
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>{elapsed}</span>
          </div>

          {/* Editable meeting title */}
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={commitTitleEdit}
              onKeyDown={handleTitleKeyDown}
              autoFocus
              style={{
                width: '100%', fontSize: 13, color: 'var(--color-text-primary)',
                backgroundColor: 'transparent', border: 'none',
                borderBottom: '1px solid var(--color-text-muted)',
                outline: 'none', paddingBottom: 2, marginBottom: 12, fontFamily: 'inherit',
              }}
            />
          ) : (
            <button
              onClick={startEditingTitle}
              title="Click to rename"
              style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
                color: 'var(--color-text-primary)', background: 'none', border: 'none',
                cursor: 'pointer', padding: 0, marginBottom: 12, fontFamily: 'inherit',
                width: '100%', textAlign: 'left',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {activeMeeting?.title}
              </span>
              <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>✏</span>
            </button>
          )}

          {/* Detected speakers */}
          {detectedSpeakers.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ ...sectionHeaderStyle, marginTop: 0 }}>Speakers</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {detectedSpeakers.map(s => (
                  <span
                    key={s.speakerId}
                    style={{
                      fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)',
                      backgroundColor: 'var(--color-bg-deep)',
                      border: '1px solid var(--color-divider)',
                      borderRadius: 99, padding: '2px 8px',
                    }}
                  >
                    {s.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          <button style={btnPrimaryStyle} onClick={handleStop}>Stop and review</button>
          <button
            onClick={handleDiscard}
            style={{
              width: '100%', background: 'none', border: 'none', fontSize: 12,
              color: '#f87171', cursor: 'pointer', padding: '8px 0 0', fontFamily: 'inherit',
            }}
          >
            Discard recording
          </button>
        </div>
      )}

      {/* ---- Divider ---- */}
      <div style={dividerStyle} />

      {/* ---- Upcoming / Notes segmented toggle ---- */}
      <div style={{
        display: 'flex',
        backgroundColor: 'var(--color-bg-deep)',
        borderRadius: 8,
        padding: 2,
        marginBottom: 16,
        border: '1px solid var(--color-divider)',
      }}>
        {(['upcoming', 'notes'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setRightPanelTab(tab)}
            style={{
              flex: 1,
              height: 28,
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: rightPanelTab === tab ? 600 : 400,
              backgroundColor: rightPanelTab === tab ? 'var(--color-white)' : 'transparent',
              color: rightPanelTab === tab ? '#151515' : 'var(--color-text-muted)',
              transition: 'background-color 0.15s, color 0.15s',
            }}
          >
            {tab === 'upcoming' ? 'Upcoming' : 'Notes'}
          </button>
        ))}
      </div>
      </div>{/* end fixed top section */}

      {/* ---- Scrollable tab content ---- */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '0 16px' }}>
      {rightPanelTab === 'upcoming' ? (
        /* ---- Calendar events or empty state ---- */
        !isConnected ? (
          <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0, lineHeight: 1.6 }}>
            Connect Google Calendar to see upcoming meetings
          </p>
        ) : upcomingEvents.length > 0 ? (
          <div>
            {groupByDate(upcomingEvents).map(({ label, events }, groupIdx) => (
              <div key={label}>
                {groupIdx > 0 && <div style={dividerStyle} />}
                <p style={sectionHeaderStyle}>{label}</p>
                {events.map(event => {
                  const eligible = isStartEligible(event)
                  const attendeeLabel =
                    event.attendees.length === 0
                      ? 'No attendees'
                      : `${event.attendees.length} attendee${event.attendees.length !== 1 ? 's' : ''}`
                  return (
                    <button
                      key={event.id}
                      onClick={eligible ? handleStartListening : undefined}
                      disabled={!eligible}
                      title={eligible ? undefined : 'Available to start within 10 minutes of the event'}
                      style={{
                        display: 'block', width: '100%', padding: '4px 0',
                        background: 'none', border: 'none',
                        cursor: eligible ? 'pointer' : 'default',
                        textAlign: 'left', opacity: eligible ? 1 : 0.4,
                        marginBottom: 12, fontFamily: 'inherit',
                      }}
                    >
                      <p style={{
                        margin: 0, fontSize: 14, fontWeight: 600,
                        color: 'var(--color-text-primary)', lineHeight: 1.3,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {event.title}
                      </p>
                      <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--color-text-muted)' }}>
                        {formatTime(event.startMs)} · {attendeeLabel}
                      </p>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>
            No upcoming events
          </p>
        )
      ) : (
        /* ---- Notes tab: past meetings grouped by date + trash ---- */
        <div>
          {pastMeetings.length > 0 ? (
            <div>
              {groupMeetingsByDate(pastMeetings).map(({ label, meetings: grpMeetings }, groupIdx) => (
                <div key={label}>
                  {groupIdx > 0 && <div style={{ ...dividerStyle, margin: '8px 0' }} />}
                  <p style={sectionHeaderStyle}>{label}</p>
                  {grpMeetings.map(meeting => {
                    const isHovered  = hoveredMeetingId === meeting.id
                    const isSelected = activeMeetingId === meeting.id
                    const duration   = formatDuration(meeting.startMs, meeting.endMs)
                    const meta       = duration ? `${duration}` : ''
                    return (
                      <div
                        key={meeting.id}
                        style={{ position: 'relative' }}
                        onMouseEnter={() => setHoveredMeetingId(meeting.id)}
                        onMouseLeave={() => setHoveredMeetingId(null)}
                      >
                        <button
                          onClick={() => onMeetingSelect(meeting.id)}
                          style={{
                            display: 'block', width: '100%',
                            padding: '7px 28px 7px 8px',
                            background: isSelected
                              ? 'var(--color-bg-deep)'
                              : isHovered
                                ? 'rgba(255,255,255,0.04)'
                                : 'none',
                            border: 'none', borderRadius: 6,
                            cursor: 'pointer', textAlign: 'left',
                            marginBottom: 1, fontFamily: 'inherit',
                            transition: 'background-color 0.1s',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <p style={{
                              margin: 0, fontSize: 13, fontWeight: 600,
                              color: 'var(--color-text-primary)', lineHeight: 1.3,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                            }}>
                              {meeting.title}
                            </p>
                            {meeting.pendingTaskCount > 0 && (
                              <span style={{
                                flexShrink: 0, fontSize: 10, fontWeight: 600,
                                color: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.12)',
                                borderRadius: 99, padding: '1px 6px', lineHeight: 1.6,
                              }}>
                                {meeting.pendingTaskCount}
                              </span>
                            )}
                          </div>
                          {meta && (
                            <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--color-text-muted)' }}>
                              {meta}
                            </p>
                          )}
                          {meeting.summaryPreview && (
                            <p style={{
                              margin: '3px 0 0', fontSize: 12,
                              color: 'var(--color-text-muted)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              opacity: 0.8,
                            }}>
                              {meeting.summaryPreview}
                            </p>
                          )}
                        </button>
                        {isHovered && (
                          <button
                            onClick={e => { e.stopPropagation(); handleDeleteMeeting(meeting) }}
                            aria-label="Move to trash"
                            style={{
                              position: 'absolute', right: 4, top: '50%',
                              transform: 'translateY(-50%)',
                              background: 'none', border: 'none', cursor: 'pointer',
                              padding: '4px', display: 'flex', alignItems: 'center',
                            }}
                          >
                            <svg width="13" height="14" viewBox="0 0 13 14" fill="none">
                              <path d="M1 3.5h11M4.5 3.5V2.5h4v1M2 3.5l.8 8.75A1 1 0 003.8 13h5.4a1 1 0 001-.75L11 3.5"
                                stroke="#f87171" strokeWidth="1.2" strokeLinecap="round" />
                            </svg>
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>
              No past meetings yet
            </p>
          )}

        </div>
      )}
      </div>{/* end scrollable tab content */}

      {/* ---- Sticky Trash section — only on Notes tab, only when non-empty ---- */}
      {showTrash && (
        <div style={{
          flexShrink: 0,
          borderTop: '1px solid var(--color-divider)',
          padding: '8px 16px 12px',
          backgroundColor: 'var(--color-bg-surface)',
        }}>
          {/* Collapsible header */}
          <button
            onClick={toggleTrash}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              width: '100%', background: 'none', border: 'none', cursor: 'pointer',
              padding: '4px 0', fontFamily: 'inherit',
            }}
          >
            <span style={{
              fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)',
              textTransform: 'uppercase', letterSpacing: '0.08em',
            }}>
              Trash{!trashExpanded && ` (${trashedMeetings.length})`}
            </span>
            <svg
              width="10" height="10" viewBox="0 0 10 10" fill="none"
              style={{
                color: 'var(--color-text-muted)',
                transform: trashExpanded ? 'rotate(90deg)' : 'none',
                transition: 'transform 0.15s',
              }}
            >
              <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>

          {/* Expanded rows */}
          {trashExpanded && (
            <div style={{ marginTop: 4, maxHeight: 200, overflowY: 'auto' }}>
              {trashedMeetings.map(meeting => {
                const isHovered   = hoveredTrashId === meeting.id
                const isRestoring = restoringId === meeting.id
                const duration    = formatDuration(meeting.startMs, meeting.endMs)
                return (
                  <div
                    key={meeting.id}
                    style={{ position: 'relative', opacity: isRestoring ? 0.4 : 0.6, transition: 'opacity 0.15s' }}
                    onMouseEnter={() => setHoveredTrashId(meeting.id)}
                    onMouseLeave={() => setHoveredTrashId(null)}
                  >
                    <div style={{
                      padding: '6px 52px 6px 4px', borderRadius: 6,
                      backgroundColor: isHovered ? 'rgba(255,255,255,0.03)' : 'transparent',
                      transition: 'background-color 0.1s',
                    }}>
                      <p style={{
                        margin: 0, fontSize: 12, fontWeight: 600,
                        color: 'var(--color-text-muted)', lineHeight: 1.3,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {meeting.title}
                      </p>
                      {duration && (
                        <p style={{ margin: '1px 0 0', fontSize: 11, color: 'var(--color-text-muted)', opacity: 0.7 }}>
                          {duration}
                        </p>
                      )}
                    </div>
                    {isHovered && !isRestoring && (
                      <div style={{
                        position: 'absolute', right: 2, top: '50%',
                        transform: 'translateY(-50%)',
                        display: 'flex', gap: 0, alignItems: 'center',
                      }}>
                        <button
                          onClick={e => { e.stopPropagation(); handleRestoreMeeting(meeting) }}
                          aria-label="Restore meeting" title="Restore"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center', color: 'var(--color-text-muted)' }}
                        >
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M2.5 7a4.5 4.5 0 1 0 1.1-2.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                            <path d="M2 3.5v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); handlePermanentDelete(meeting) }}
                          aria-label="Permanently delete" title="Delete permanently"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center' }}
                        >
                          <svg width="13" height="14" viewBox="0 0 13 14" fill="none">
                            <path d="M1 3.5h11M4.5 3.5V2.5h4v1M2 3.5l.8 8.75A1 1 0 003.8 13h5.4a1 1 0 001-.75L11 3.5"
                              stroke="#f87171" strokeWidth="1.2" strokeLinecap="round" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes ping {
          75%, 100% { transform: scale(2); opacity: 0; }
        }
      `}</style>
    </aside>
  )
}
