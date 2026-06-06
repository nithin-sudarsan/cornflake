// Mubit memory integration for Cornflake — uses @mubit-ai/sdk.
//
// Three agents (agent_id is a per-call label, no registration needed):
//   "action-router"    — which action types this user approves / dismisses
//   "calendar-router"  — scheduling patterns (time of day, duration, outcomes)
//   "contact-resolver" — persistent name → email mappings
//
// All functions are no-ops when MUBIT_API_KEY is missing or the SDK call fails.
// The client is created (or re-created) when setMubitUser() is called so that
// each user gets an isolated run_id — preventing cross-user memory bleed.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any = null
let _userId: string | null = null
const _contactCache = new Map<string, string>()

export async function initMubit(): Promise<void> {
  if (!process.env.MUBIT_API_KEY) {
    console.warn('[mubit] MUBIT_API_KEY not set — memory will not be recorded')
    return
  }
  // Pre-warm the dynamic import so the first setMubitUser() call is fast.
  try {
    await import('@mubit-ai/sdk')
  } catch {
    // Non-fatal — setMubitUser will also try.
  }
}

export async function setMubitUser(userId: string): Promise<void> {
  _userId = userId
  const apiKey = process.env.MUBIT_API_KEY
  if (!apiKey) return
  try {
    const { Client: MubitClient } = await import('@mubit-ai/sdk')
    _client = new MubitClient({
      api_key: apiKey,
      run_id:  `cornflake-${userId}`,
      ...(process.env.MUBIT_API_URL ? { endpoint: process.env.MUBIT_API_URL } : {}),
    })
    console.log('[mubit] client ready — run: cornflake-' + userId)
  } catch (err) {
    console.warn('[mubit] client init failed:', (err as Error).message)
    _client = null
  }
}

// Spread helper — adds user_id only when a user is known
function withUser(): Record<string, string> {
  return _userId ? { user_id: _userId } : {}
}

// ---------------------------------------------------------------------------
// Action router
// ---------------------------------------------------------------------------

export async function recordActionOutcome(
  taskId: string,
  taskTitle: string,
  actionType: string,
  outcome: 'approved' | 'dismissed',
): Promise<void> {
  if (!_client) return
  try {
    await _client.remember({
      agent_id: 'action-router',
      content:  `User ${outcome} task "${taskTitle}" with action type ${actionType}`,
      metadata: { taskId, taskTitle, actionType, outcome, timestamp: Date.now() },
      ...withUser(),
    })
    console.log(`[mubit] recorded outcome: ${outcome} for "${taskTitle}" (${actionType})`)
  } catch (err) {
    console.warn('[mubit] Failed to record action outcome:', (err as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Calendar router
// ---------------------------------------------------------------------------

export interface CalendarBlockRecord {
  taskTitle:    string
  actionType:   string
  dateIso:      string   // 'YYYY-MM-DD'
  time:         string   // 'HH:MM'
  hourOfDay:    number   // 0–23
  dayOfWeek:    number   // 0=Sun … 6=Sat
  durationMin:  number
  outcome:      'confirmed' | 'changed' | 'dismissed'
  suggestedHour?: number
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export async function recordCalendarBlock(rec: CalendarBlockRecord): Promise<void> {
  if (!_client) return
  try {
    const dayName = DAY_NAMES[rec.dayOfWeek] ?? 'Unknown'
    const content = rec.outcome === 'confirmed'
      ? `User confirmed a calendar block for "${rec.taskTitle}" at ${rec.time} on ${dayName} for ${rec.durationMin} minutes`
      : rec.outcome === 'changed'
      ? `User changed the suggested ${rec.suggestedHour}:00 time slot and confirmed "${rec.taskTitle}" at ${rec.time} on ${dayName} for ${rec.durationMin} minutes`
      : `User dismissed a calendar block suggestion for "${rec.taskTitle}" (${rec.actionType})`
    await _client.remember({
      agent_id: 'calendar-router',
      content,
      metadata: { ...rec, timestamp: Date.now() },
      ...withUser(),
    })
    console.log(`[mubit/calendar-router] recorded: ${rec.outcome} for "${rec.taskTitle}" at ${rec.time}`)
  } catch (err) {
    console.warn('[mubit] Failed to record calendar block:', (err as Error).message)
  }
}

export interface CalendarPreference {
  suggestHour?:  number
  alwaysAsk?:    boolean
  skipCalendar?: boolean
}

export async function recallCalendarPreference(
  taskTitle: string,
  actionType: string,
): Promise<CalendarPreference | null> {
  if (!_client) return null
  try {
    const result = await _client.recall({
      agent_id: 'calendar-router',
      query:    `Based on past behaviour, what time of day should a calendar block be scheduled for "${taskTitle}" (${actionType})? Does the user always change the suggested time, or always skip calendar blocks for this type?`,
      schema:   JSON.stringify({
        type: 'object',
        properties: {
          suggestHour:  { type: 'number',  description: 'Preferred hour (0-23), omit if no clear pattern' },
          alwaysAsk:    { type: 'boolean', description: 'True if user consistently changes the suggested time' },
          skipCalendar: { type: 'boolean', description: 'True if user consistently dismisses calendar for this type' },
        },
      }),
      ...withUser(),
    }) as CalendarPreference | null
    return result ?? null
  } catch (err) {
    console.warn('[mubit] Failed to recall calendar preference:', (err as Error).message)
    return null
  }
}

export interface HistoricalCalendarEvent {
  title:        string
  hourOfDay:    number
  dayOfWeek:    number
  durationMin:  number
  hasAttendees: boolean
  rsvpStatus:   string
  timestamp:    number
}

export async function recordHistoricalCalendarEvent(evt: HistoricalCalendarEvent): Promise<void> {
  if (!_client) return
  try {
    const dayName = DAY_NAMES[evt.dayOfWeek] ?? 'Unknown'
    const kind    = evt.hasAttendees ? 'meeting' : 'solo block'
    const content = `Historical calendar event: "${evt.title}" — ${kind} at ${evt.hourOfDay}:00 on ${dayName} for ${evt.durationMin}min (RSVP: ${evt.rsvpStatus})`
    await _client.remember({
      agent_id: 'calendar-router',
      content,
      metadata: { ...evt } as Record<string, unknown>,
      ...withUser(),
    })
  } catch {
    // Suppress per-event errors during bulk historical seeding
  }
}

// ---------------------------------------------------------------------------
// Contact resolver
// ---------------------------------------------------------------------------

export async function recordContactMapping(name: string, email: string): Promise<void> {
  _contactCache.set(name.trim().toLowerCase(), email.trim())
  if (!_client) return
  try {
    await _client.remember({
      agent_id:   'contact-resolver',
      content:    `${name.trim()} can be reached at ${email.trim().toLowerCase()}`,
      metadata:   { name: name.trim(), email: email.trim().toLowerCase(), timestamp: Date.now() },
      upsert_key: `contact:${_userId ?? 'anon'}:${name.trim().toLowerCase()}`,
      ...withUser(),
    })
    console.log(`[mubit/contact-resolver] recorded: "${name}" → ${email}`)
  } catch (err) {
    console.warn('[mubit] Failed to record contact mapping:', (err as Error).message)
  }
}

export async function recallContact(name: string): Promise<string | null> {
  const cached = _contactCache.get(name.trim().toLowerCase())
  if (cached) return cached
  if (!_client) return null
  try {
    const result = await _client.recall({
      agent_id: 'contact-resolver',
      query:    `What is the email address for ${name.trim()}?`,
      limit: 1,
      ...withUser(),
    }) as { final_answer?: string; email?: string } | string | null
    console.log(`[mubit/contact-resolver] recall "${name}" →`, JSON.stringify(result))
    if (!result) return null
    const raw = typeof result === 'string'
      ? result
      : (result.final_answer ?? result.email ?? '')
    const match = raw.match(/[\w.+%-]+@[\w.-]+\.[a-z]{2,}/i)
    return match ? match[0] : null
  } catch (err) {
    console.warn('[mubit] Failed to recall contact:', (err as Error).message)
    return null
  }
}
