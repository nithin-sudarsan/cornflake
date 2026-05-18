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

import { BrowserWindow, app } from 'electron'
import { autoUpdater, UpdateInfo } from 'electron-updater'
import { MAIN_CHANNELS } from '../../ipc/types'

const RECHECK_MS = 4 * 60 * 60 * 1000  // 4 hours

let _mainWindow: BrowserWindow | null = null
let _checkTimer: ReturnType<typeof setInterval> | null = null
let _downloadedInfo: UpdateInfo | null = null

export function initUpdater(mainWindow: BrowserWindow): void {
  if (!app.isPackaged) {
    console.log('[updater] skipped — running in dev (app.isPackaged=false)')
    return
  }

  _mainWindow = mainWindow

  // electron-updater logging — we already have console; nothing fancy required.
  autoUpdater.autoDownload          = true   // background download on detection
  autoUpdater.autoInstallOnAppQuit  = false  // we install via explicit user action
  autoUpdater.allowDowngrade        = false
  autoUpdater.allowPrerelease       = false

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for updates...')
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.log('[updater] update available:', info.version)
    sendToRenderer(MAIN_CHANNELS.UPDATE_AVAILABLE, {
      version: info.version,
      releaseDate: info.releaseDate,
    })
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    console.log('[updater] up-to-date (current:', app.getVersion(), '/ remote:', info.version, ')')
  })

  autoUpdater.on('download-progress', (progress) => {
    // Quiet — the user doesn't see download progress in this UX. Log only.
    console.log(`[updater] downloading: ${progress.percent.toFixed(1)}% @ ${(progress.bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s`)
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    console.log('[updater] update downloaded:', info.version)
    _downloadedInfo = info
    sendToRenderer(MAIN_CHANNELS.UPDATE_DOWNLOADED, {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseName: info.releaseName,
      releaseNotes: info.releaseNotes,
    })
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

/** Quit and install the previously downloaded update. */
export function quitAndInstall(): void {
  if (!_downloadedInfo) {
    console.warn('[updater] quitAndInstall called but no update is downloaded')
    return
  }
  console.log('[updater] quitAndInstall →', _downloadedInfo.version)
  // isSilent=false (show install UI), isForceRunAfter=true (relaunch after).
  autoUpdater.quitAndInstall(false, true)
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
