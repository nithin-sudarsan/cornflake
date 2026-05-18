// Auto-updater wiring around electron-updater + GitHub Releases.
//
// Flow:
//   1. App starts → wait until window is ready → check for updates
//   2. If a newer version is found → download silently in the background
//   3. When download completes → push UPDATE_DOWNLOADED to renderer with
//      the new version string. The renderer shows a "Restart to update"
//      prompt; clicking it calls UPDATE_INSTALL which quits + relaunches.
//   4. Every 4 hours we re-check while the app is running.
//
// Server: GitHub Releases on the repo configured in package.json `build.publish`.

import { BrowserWindow, app, shell } from 'electron'
import { autoUpdater, UpdateInfo } from 'electron-updater'
import { MAIN_CHANNELS } from '../../ipc/types'

const RECHECK_MS = 4 * 60 * 60 * 1000  // 4 hours
// Ad-hoc signed builds can't use Squirrel.Mac's in-place install — ShipIt
// rejects the swap on signature mismatch. Until we have a Developer ID
// certificate, we surface available updates and send users to the GitHub
// release page to download the new DMG manually.
const RELEASE_URL_BASE = 'https://github.com/nithin-sudarsan/cornflake/releases/tag/v'

let _mainWindow: BrowserWindow | null = null
let _checkTimer: ReturnType<typeof setInterval> | null = null
let _availableVersion: string | null = null

export function initUpdater(mainWindow: BrowserWindow): void {
  if (!app.isPackaged) {
    console.log('[updater] skipped — running in dev (app.isPackaged=false)')
    return
  }

  _mainWindow = mainWindow

  // Manual-update UX: never auto-download. We only check version and tell
  // the renderer when a newer release exists — the user clicks through to
  // GitHub and grabs the DMG themselves.
  autoUpdater.autoDownload          = false
  autoUpdater.autoInstallOnAppQuit  = false
  autoUpdater.allowDowngrade        = false
  autoUpdater.allowPrerelease       = false

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for updates...')
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.log('[updater] update available:', info.version)
    _availableVersion = info.version
    sendToRenderer(MAIN_CHANNELS.UPDATE_AVAILABLE, {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseUrl: RELEASE_URL_BASE + info.version,
    })
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    console.log('[updater] up-to-date (current:', app.getVersion(), '/ remote:', info.version, ')')
  })

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err.message)
    // Don't bother the user — silent failure is fine here. Logged for debugging.
  })

  // First check ~10s after startup so we don't compete with the app's own
  // initialisation (sync pull, calendar fetch).
  setTimeout(() => checkForUpdates('startup'), 10_000)

  // Periodic re-check while the app is running.
  _checkTimer = setInterval(() => checkForUpdates('periodic'), RECHECK_MS)
}

export function checkForUpdates(reason: 'startup' | 'periodic' | 'manual' = 'manual'): void {
  if (!app.isPackaged) return
  console.log(`[updater] check (${reason})`)
  autoUpdater.checkForUpdates().catch(err => {
    console.error('[updater] check failed:', err.message)
  })
}

/** Open the GitHub release page for the latest available version in the browser. */
export function openReleasePage(): void {
  if (!_availableVersion) {
    console.warn('[updater] openReleasePage called but no update is available')
    return
  }
  const url = RELEASE_URL_BASE + _availableVersion
  console.log('[updater] opening release page:', url)
  shell.openExternal(url).catch(err => {
    console.error('[updater] openExternal failed:', err)
  })
}

export function stopUpdater(): void {
  if (_checkTimer) {
    clearInterval(_checkTimer)
    _checkTimer = null
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (_mainWindow && !_mainWindow.isDestroyed()) {
    _mainWindow.webContents.send(channel, payload)
  }
}
