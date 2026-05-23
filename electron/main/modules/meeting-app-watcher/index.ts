import { BrowserWindow, Notification } from 'electron'
import { execFile } from 'child_process'
import { MAIN_CHANNELS } from '../../ipc/types'
import { isAuthenticated } from '../auth'

// ---------------------------------------------------------------------------
// Meeting-app watcher
//
// Polls the running process list and fires a "start listening?" notification
// when a known video-conferencing app appears that wasn't running on the
// previous tick. macOS-only.
//
// Distinct from the calendar-watcher: this catches meetings that aren't on
// the user's Google Calendar (ad-hoc Zooms, WhatsApp calls, FaceTime, etc.).
// ---------------------------------------------------------------------------

// Process names we treat as meeting apps. Match against the `comm` (basename)
// column from `ps`, which is what macOS reports for the executable. Slack is
// intentionally excluded — it's always-running for most users, so process
// presence is not a meeting signal.
const MEETING_APP_PROCESSES: ReadonlyArray<{ proc: string; label: string }> = [
  { proc: 'zoom.us',         label: 'Zoom' },
  { proc: 'Microsoft Teams', label: 'Microsoft Teams' },
  { proc: 'Teams',           label: 'Microsoft Teams' },
  { proc: 'Webex',           label: 'Webex' },
  { proc: 'WhatsApp',        label: 'WhatsApp' },
  { proc: 'FaceTime',        label: 'FaceTime' },
  { proc: 'Discord',         label: 'Discord' },
]

const POLL_INTERVAL_MS = 15 * 1000
// After the user dismisses (or we auto-skip due to recording), don't re-notify
// for the same app until this cooldown elapses — keeps a flickering app from
// spamming.
const RENOTIFY_COOLDOWN_MS = 10 * 60 * 1000

let _pollTimer: ReturnType<typeof setInterval> | null = null
let _mainWindow: BrowserWindow | null = null
// Labels we saw on the previous tick (used to detect newly-launched apps).
let _previouslySeen = new Set<string>()
// label → timestamp of last notification fired. Prevents re-notifying within
// the cooldown window even if the app quits and relaunches.
const _lastNotifiedAt = new Map<string, number>()
// Set by the main process when a recording is active. We skip notifications
// while recording — the user is already capturing audio.
let _recordingActive = false

export function setMeetingAppWatcherRecordingState(active: boolean): void {
  _recordingActive = active
}

function listRunningProcesses(): Promise<string[]> {
  return new Promise(resolve => {
    // `-axo comm=` prints just the basename of every process's executable,
    // one per line, with no header.
    execFile('ps', ['-axo', 'comm='], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        console.error('[meeting-app-watcher] ps failed:', err.message)
        resolve([])
        return
      }
      resolve(stdout.split('\n').map(l => l.trim()).filter(Boolean))
    })
  })
}

function detectMeetingApps(procNames: string[]): Set<string> {
  // ps -axo comm= returns full paths like "/Applications/zoom.us.app/Contents/MacOS/zoom.us".
  // Match by basename suffix so we don't accidentally match unrelated paths.
  const seen = new Set<string>()
  for (const entry of MEETING_APP_PROCESSES) {
    const needle = '/' + entry.proc
    if (procNames.some(p => p === entry.proc || p.endsWith(needle))) {
      seen.add(entry.label)
    }
  }
  return seen
}

function fireMeetingAppNotification(label: string): void {
  const notification = new Notification({
    title: `${label} is running`,
    body: 'Start listening with Cornflake?',
    actions: [
      { type: 'button', text: 'Start listening' },
      { type: 'button', text: 'Skip' },
    ],
    closeButtonText: 'Skip',
  })

  const start = () => {
    if (!_mainWindow) return
    _mainWindow.show()
    // Reuse the tray's start path so we go through the renderer's canonical
    // start flow (permission gating, audio capture, error UI).
    _mainWindow.webContents.send(MAIN_CHANNELS.TRAY_REQUEST_START)
  }

  notification.on('click', start)
  notification.on('action', (_e, index) => {
    if (index === 0) start()
  })

  notification.show()
}

async function poll(): Promise<void> {
  // Only notify signed-in users — the start flow needs the backend and a
  // notification leading to a sign-in wall would be annoying.
  if (!(await isAuthenticated())) {
    _previouslySeen = new Set()
    return
  }

  const procs = await listRunningProcesses()
  const currentlyRunning = detectMeetingApps(procs)

  // Fire only for apps that appeared *this tick* — i.e. weren't running last
  // tick. This catches launches without spamming when the app stays open.
  const now = Date.now()
  for (const label of currentlyRunning) {
    if (_previouslySeen.has(label)) continue
    const lastFired = _lastNotifiedAt.get(label) ?? 0
    if (now - lastFired < RENOTIFY_COOLDOWN_MS) continue
    _lastNotifiedAt.set(label, now)
    if (_recordingActive) continue
    fireMeetingAppNotification(label)
  }

  _previouslySeen = currentlyRunning
}

export function startMeetingAppWatcher(mainWindow: BrowserWindow): void {
  if (process.platform !== 'darwin') return
  _mainWindow = mainWindow
  if (_pollTimer) return

  console.log('[meeting-app-watcher] starting (15s poll)')

  // Seed _previouslySeen with whatever's already running at boot so we don't
  // immediately fire notifications for meeting apps the user already had open.
  void listRunningProcesses().then(procs => {
    _previouslySeen = detectMeetingApps(procs)
  })

  _pollTimer = setInterval(() => { void poll() }, POLL_INTERVAL_MS)
}

export function stopMeetingAppWatcher(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
  _previouslySeen = new Set()
  _lastNotifiedAt.clear()
}
