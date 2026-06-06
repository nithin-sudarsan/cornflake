import { BrowserWindow, Notification, shell } from 'electron'
import { google, calendar_v3 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { getDb } from '../database'
import {
  getGoogleAccessToken,
  getGoogleRefreshToken,
  storeGoogleAccessToken,
  isAuthenticated,
} from '../auth'
import { MAIN_CHANNELS } from '../../ipc/types'
import type { CalendarEvent } from '../../ipc/types'
import { recordHistoricalCalendarEvent, recordContactMapping } from '../action-router/mubit-client.js'

export interface AuthStatus {
  isConnected: boolean
  name: string | null
  email: string | null
  picture: string | null
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _pollTimer: ReturnType<typeof setInterval> | null = null
let _mainWindow: BrowserWindow | null = null
// Event IDs we've already fired a notification for, reset each watcher session
const _notifiedEventIds = new Set<string>()
// Cache of events for next 10 days — updated on every display fetch
let _displayEventsCache: CalendarEvent[] = []
// Callback fired after _displayEventsCache is updated (used by index.ts for tray label)
let _onEventsUpdated: (() => void) | null = null

export function setOnEventsUpdated(cb: () => void): void {
  _onEventsUpdated = cb
}

// Returns the earliest upcoming event from the cache, or null if none.
export function getCachedNextEvent(): CalendarEvent | null {
  const now = Date.now()
  return _displayEventsCache.find(e => e.startMs > now) ?? null
}

// Returns the current cache of upcoming events. Used by the renderer on mount
// to catch events that were fetched before RightPanel mounted and could not
// be received via the CALENDAR_EVENTS_UPDATED push event.
export function getCachedDisplayEvents(): CalendarEvent[] {
  return _displayEventsCache
}

// ---------------------------------------------------------------------------
// Helpers: load stored credentials from Keychain (set by WorkOS SSO)
// ---------------------------------------------------------------------------

// Builds an OAuth2Client that holds only the access token. No client_id or
// client_secret on the client — token refresh is delegated to the backend
// (see refreshGoogleToken below) so the Google OAuth client secret stays
// server-side only.
async function loadAuthClient(): Promise<OAuth2Client | null> {
  const accessToken = await getGoogleAccessToken()
  if (!accessToken) {
    console.warn('[calendar] No Google access token in Keychain — watcher cannot start')
    return null
  }

  const oauth2Client = new google.auth.OAuth2()
  oauth2Client.setCredentials({ access_token: accessToken })
  return oauth2Client
}

// Refresh Google access token via the backend when a 401 is received from the
// Calendar API. The Google client secret never leaves the server.
async function refreshGoogleToken(): Promise<OAuth2Client | null> {
  const refreshToken = await getGoogleRefreshToken()
  if (!refreshToken) {
    console.warn('[calendar-watcher] No Google refresh token — cannot refresh')
    return null
  }

  const BACKEND = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '')

  try {
    const res = await fetch(`${BACKEND}/api/auth/google-refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })

    if (!res.ok) {
      console.error('[calendar-watcher] Backend google-refresh returned', res.status)
      return null
    }

    const { accessToken } = await res.json() as { accessToken?: string }
    if (!accessToken) {
      console.error('[calendar-watcher] Backend google-refresh response missing accessToken')
      return null
    }

    await storeGoogleAccessToken(accessToken)
    const oauth2Client = new google.auth.OAuth2()
    oauth2Client.setCredentials({ access_token: accessToken })
    return oauth2Client
  } catch (err) {
    console.error('[calendar-watcher] Google token refresh failed:', err)
    return null
  }
}

export async function isCalendarConnected(): Promise<boolean> {
  return isAuthenticated()
}

// ---------------------------------------------------------------------------
// Calendar polling
// ---------------------------------------------------------------------------

async function fetchUpcomingEvents(auth: OAuth2Client, windowMs = 5 * 60 * 1000): Promise<CalendarEvent[]> {
  const cal = google.calendar({ version: 'v3', auth })
  const now = new Date()
  const timeMax = new Date(now.getTime() + windowMs)

  const response = await cal.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 10,
  })

  const items = response.data.items ?? []
  return items
    .filter(event => event.start?.dateTime) // exclude all-day events
    .map(event => mapCalendarEvent(event))
}

function mapCalendarEvent(event: calendar_v3.Schema$Event): CalendarEvent {
  const startMs = new Date(event.start!.dateTime!).getTime()
  const endMs = event.end?.dateTime ? new Date(event.end.dateTime).getTime() : startMs + 3600000

  const attendees = (event.attendees ?? [])
    .filter(a => a.email && !a.self)
    .map(a => ({ name: a.displayName ?? a.email!, email: a.email! }))

  const meetingLink = extractMeetingLink(event)

  return {
    id: event.id ?? '',
    title: event.summary ?? 'Untitled meeting',
    startMs,
    endMs,
    meetingLink,
    attendees,
  }
}

function extractMeetingLink(event: calendar_v3.Schema$Event): string | undefined {
  // Google Meet link is in conferenceData
  const entryPoints = event.conferenceData?.entryPoints ?? []
  const videoEntry = entryPoints.find(ep => ep.entryPointType === 'video')
  if (videoEntry?.uri) return videoEntry.uri

  // Fall back: scan description for common meeting URLs
  const desc = event.description ?? ''
  const urlMatch = desc.match(/https:\/\/(meet\.google\.com|zoom\.us|teams\.microsoft\.com|app\.zoom\.us)[^\s"<]*/i)
  return urlMatch?.[0]
}

function fireUpcomingNotification(event: CalendarEvent): void {
  const minutesUntil = Math.round((event.startMs - Date.now()) / 60000)
  const when = minutesUntil <= 1 ? 'starting now' : `in ${minutesUntil} minute${minutesUntil !== 1 ? 's' : ''}`

  const notification = new Notification({
    title: event.title,
    body: `${when} — tap to join and start listening`,
    actions: [
      { type: 'button', text: 'Join & start listening' },
      { type: 'button', text: 'Skip' },
    ],
    closeButtonText: 'Skip',
  })

  notification.on('click', () => {
    if (event.meetingLink) shell.openExternal(event.meetingLink)
    startCalendarTriggeredRecording(event)
  })

  notification.on('action', (_e, index) => {
    if (index === 0) {
      if (event.meetingLink) shell.openExternal(event.meetingLink)
      startCalendarTriggeredRecording(event)
    }
    // index 1 = Skip — do nothing
  })

  notification.show()
}

function startCalendarTriggeredRecording(event: CalendarEvent): void {
  const db = getDb()
  const meeting = db.createMeeting(event.title, event.id)

  // Create self speaker
  db.createSelfSpeaker(meeting.id)

  // Pre-populate speakers from calendar attendees
  if (event.attendees.length > 0) {
    // Store attendee emails — speaker names/emails will be used during inference
    // We create placeholder speaker rows for each attendee (name + email known, deepgramId TBD)
    for (const attendee of event.attendees) {
      const ts = Date.now()
      // We can't use createSpeakers() here since that only takes deepgramIds.
      // Instead call a raw insert. The DB module owns all writes, so we use
      // a dedicated helper if available, otherwise call resolveSpeaker after create.
      // For now: create an unresolved speaker row and resolve it immediately with the
      // attendee name (high confidence from calendar data).
      const speakers = db.createSpeakers(meeting.id, [`calendar_${attendee.email}`])
      if (speakers[0]) {
        db.resolveSpeaker(speakers[0].id, attendee.name || attendee.email, 'high')
        db.updateSpeakerEmail(speakers[0].id, attendee.email)
      }
    }
  }

  _mainWindow?.webContents.send(MAIN_CHANNELS.RECORDING_STARTED, {
    meetingId: meeting.id,
    title: meeting.title,
  })

  // Also push updated upcoming events list to renderer
  if (_mainWindow) {
    _mainWindow.webContents.send(MAIN_CHANNELS.MEETING_UPCOMING, event)
  }
}

async function poll(): Promise<void> {
  let auth = await loadAuthClient()
  if (!auth) return

  try {
    // Notification window: fire system alerts for events 1–5 min away
    const notifyEvents = await fetchUpcomingEvents(auth, 5 * 60 * 1000)
    for (const event of notifyEvents) {
      if (_notifiedEventIds.has(event.id)) continue
      const msUntil = event.startMs - Date.now()
      if (msUntil > 0 && msUntil <= 5 * 60 * 1000) {
        _notifiedEventIds.add(event.id)
        fireUpcomingNotification(event)
      }
    }
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status
    const message = (err as { message?: string })?.message ?? String(err)
    if (status === 401) {
      console.warn(`[calendar] Google API error: 401 — access token expired, attempting refresh`)
      auth = await refreshGoogleToken()
      if (!auth) {
        console.error('[calendar] Token refresh failed (no refresh token or refresh rejected). User needs to reconnect Google Calendar — sign out and sign back in.')
      }
    } else {
      console.error(`[calendar] Google API error: ${status ?? '?'} ${message}`)
    }
  }

  // Refresh display list on every tick so new/changed/cancelled events are
  // reflected in the renderer without requiring an app restart.
  if (_mainWindow) {
    await sendDisplayEventsToRenderer(_mainWindow)
  }
}

// Fetches events for the next 10 days, updates the cache, and pushes the full
// sorted list to the renderer via CALENDAR_EVENTS_UPDATED.
export async function sendDisplayEventsToRenderer(win: BrowserWindow): Promise<void> {
  let auth = await loadAuthClient()
  if (!auth) return

  try {
    const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000
    const events = await fetchUpcomingEvents(auth, TEN_DAYS_MS)
    _displayEventsCache = events
    win.webContents.send(MAIN_CHANNELS.CALENDAR_EVENTS_UPDATED, events)
    _onEventsUpdated?.()
    console.log(`[calendar-watcher] sent ${events.length} display event(s) to renderer`)
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status === 401) {
      auth = await refreshGoogleToken()
      if (auth) {
        try {
          const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000
          const events = await fetchUpcomingEvents(auth, TEN_DAYS_MS)
          _displayEventsCache = events
          win.webContents.send(MAIN_CHANNELS.CALENDAR_EVENTS_UPDATED, events)
          _onEventsUpdated?.()
        } catch (retryErr) {
          console.error('[calendar-watcher] sendDisplayEventsToRenderer retry error:', retryErr)
        }
      }
    } else {
      const message = (err as { message?: string })?.message ?? String(err)
      console.error(`[calendar] Google API error in display fetch: ${status ?? '?'} ${message}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Public: auth status broadcast
// Reads from Keychain (set by WorkOS SSO) and cached DB profile.
// Sends the result to the renderer via the AUTH_STATUS push channel.
// Call this on did-finish-load, after login, and after sign-out.
// ---------------------------------------------------------------------------

export async function broadcastAuthStatus(win: BrowserWindow): Promise<void> {
  const connected = await isCalendarConnected()
  if (!connected) {
    win.webContents.send(MAIN_CHANNELS.AUTH_STATUS, { isConnected: false, name: null, email: null, picture: null })
    return
  }

  // Return cached profile from DB (populated by WorkOS SSO flow)
  const cached = getDb().getUserProfile()
  win.webContents.send(MAIN_CHANNELS.AUTH_STATUS, {
    isConnected: true,
    name:    cached?.name    ?? null,
    email:   cached?.email   ?? null,
    picture: cached?.picture ?? null,
  })
}

// Re-sends the cached display events to the renderer. Called on did-finish-load
// because the initial calendar watcher push fires before the renderer is ready.
export function resendCachedEventsToRenderer(win: BrowserWindow): void {
  win.webContents.send(MAIN_CHANNELS.CALENDAR_EVENTS_UPDATED, _displayEventsCache)
}

// ---------------------------------------------------------------------------
// Public: start / stop watcher
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Historical calendar memory seeding (one-time, on first launch after Mubit init)
// ---------------------------------------------------------------------------

export async function seedHistoricalCalendarMemory(): Promise<void> {
  const db = getDb()
  if (db.getMetaValue('mubit_calendar_history_seeded')) return

  const auth = await loadAuthClient()
  if (!auth) return

  const cal  = google.calendar({ version: 'v3', auth })
  const now  = new Date()
  const year = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

  let pageToken: string | undefined
  let totalSeeded = 0

  try {
    do {
      const res = await cal.events.list({
        calendarId:   'primary',
        timeMin:      year.toISOString(),
        timeMax:      now.toISOString(),
        singleEvents: true,
        orderBy:      'startTime',
        maxResults:   250,
        pageToken,
      })

      const items = res.data.items ?? []
      for (const event of items) {
        if (!event.start?.dateTime) continue  // skip all-day events

        const start       = new Date(event.start.dateTime)
        const end         = event.end?.dateTime ? new Date(event.end.dateTime) : new Date(start.getTime() + 3600000)
        const durationMin = Math.round((end.getTime() - start.getTime()) / 60000)

        const selfEntry   = (event.attendees ?? []).find(a => a.self)
        const rsvpStatus  = selfEntry?.responseStatus ?? 'accepted'
        const hasAttendees = (event.attendees ?? []).filter(a => !a.self).length > 0

        await recordHistoricalCalendarEvent({
          title:        event.summary ?? '',
          hourOfDay:    start.getHours(),
          dayOfWeek:    start.getDay(),
          durationMin,
          hasAttendees,
          rsvpStatus,
          timestamp:    start.getTime(),
        })

        // Seed contact mappings from attendees
        for (const attendee of event.attendees ?? []) {
          if (!attendee.self && attendee.email && attendee.displayName) {
            await recordContactMapping(attendee.displayName, attendee.email)
          }
        }

        totalSeeded++
      }

      pageToken = res.data.nextPageToken ?? undefined
    } while (pageToken)

    db.setMetaValue('mubit_calendar_history_seeded', '1')
    console.log(`[mubit] seeded ${totalSeeded} historical calendar events`)
  } catch (err) {
    console.warn('[mubit] Historical calendar seeding failed:', (err as Error).message)
    // Do NOT set the flag — will retry on next launch
  }
}

export function startCalendarWatcher(mainWindow: BrowserWindow): void {
  _mainWindow = mainWindow
  if (_pollTimer) return // already running — log nothing, this is the no-op path

  console.log('[calendar] Starting watcher (60s poll interval)')

  // Run notification poll immediately, then every 60s.
  // Also push display events so the idle dropdown is populated on startup.
  poll()
  sendDisplayEventsToRenderer(mainWindow)
  _pollTimer = setInterval(poll, 60 * 1000)

  // One-time historical seeding: runs in background, never blocks the watcher
  seedHistoricalCalendarMemory().catch(err =>
    console.warn('[mubit] seedHistoricalCalendarMemory failed:', (err as Error).message)
  )
}

export function stopCalendarWatcher(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
  _notifiedEventIds.clear()
}

// Stop the watcher and clear the display cache.
// Token clearing is now handled by the auth module (logout).
export function disconnectCalendar(): void {
  stopCalendarWatcher()
  _displayEventsCache = []
}

// Trigger an immediate notification poll (called after OAuth completes so the
// renderer doesn't have to wait up to 60s for the next scheduled tick).
export function triggerPoll(): void {
  poll()
}

// ---------------------------------------------------------------------------
// Public: manual quick-start
// Creates the meeting record + self speaker. Does NOT start audio (Module 4).
// Returns the payload sent to the renderer.
// ---------------------------------------------------------------------------

export function startManualRecording(
  opts?: { calendarEventId?: string },
): { meetingId: string; title: string } {
  const db = getDb()

  // If the caller named a specific calendar event (e.g. the user clicked it in
  // the Upcoming list), and we have that event cached, hydrate the meeting
  // from it — same as the notification-triggered path. This is what brings
  // attendee names + emails into the speakers table so the extraction prompt
  // can use them as authoritative context.
  if (opts?.calendarEventId) {
    const event = _displayEventsCache.find(e => e.id === opts.calendarEventId)
    if (event) {
      const meeting = db.createMeeting(event.title, event.id)
      db.createSelfSpeaker(meeting.id)

      for (const attendee of event.attendees) {
        const speakers = db.createSpeakers(meeting.id, [`calendar_${attendee.email}`])
        if (speakers[0]) {
          db.resolveSpeaker(speakers[0].id, attendee.name || attendee.email, 'high')
          db.updateSpeakerEmail(speakers[0].id, attendee.email)
        }
      }
      console.log(`[recording] manual start hydrated from calendar event "${event.title}" with ${event.attendees.length} attendee(s)`)
      return { meetingId: meeting.id, title: meeting.title }
    }
    console.warn(`[recording] manual start: calendar event ${opts.calendarEventId} not in cache — falling back to generic title`)
  }

  const now = new Date()
  const hh = now.getHours().toString().padStart(2, '0')
  const mm = now.getMinutes().toString().padStart(2, '0')
  const title = `Meeting, ${hh}:${mm}`

  const meeting = db.createMeeting(title)
  db.createSelfSpeaker(meeting.id)

  return { meetingId: meeting.id, title: meeting.title }
}
