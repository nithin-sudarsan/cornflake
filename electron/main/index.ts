import dotenv from 'dotenv'
import path from 'path'
import os from 'os'

import { app, BrowserWindow, Tray, Menu, nativeImage, dialog } from 'electron'

// Load .env before any module reads process.env. In dev it lives at the project
// root; in packaged builds it's a stripped-down file shipped via extraResources
// (only BACKEND_URL, WORKOS_CLIENT_ID, WORKOS_CALLBACK_PORT — see
// scripts/build-prod-env.js).
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '..', '..', '.env')
dotenv.config({ path: envPath })
console.log('[boot] loaded env from', envPath,
  '— WORKOS_CLIENT_ID present:', !!process.env.WORKOS_CLIENT_ID,
  '| BACKEND_URL:', process.env.BACKEND_URL ?? '(default)')

// Set the app name BEFORE anything else so the macOS menu bar (App menu, About,
// Quit, etc.) shows "Cornflake" instead of "Electron". Must happen before
// app.whenReady() — Electron caches the name early.
app.setName('Cornflake')

import { registerIpcHandlers } from './ipc'
import { initDatabase, closeDatabase } from './modules/database'
import { primeFromKeychain } from './modules/auth'
import {
  startManualRecording,
  startCalendarWatcher,
  stopCalendarWatcher,
  getCachedNextEvent,
  setOnEventsUpdated,
  broadcastAuthStatus,
  resendCachedEventsToRenderer,
  sendDisplayEventsToRenderer,
} from './modules/calendar-watcher'
import { handleCallback, stopCallbackServer } from './modules/auth'
import { MAIN_CHANNELS } from './ipc/types'

// ---------------------------------------------------------------------------
// Single-instance lock — prevents a second Electron process from being
// spawned when macOS/Windows routes the cornflake:// deep link.
// The first instance handles everything; the second quits immediately.
// ---------------------------------------------------------------------------

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  console.log('[auth] Second instance detected — quitting so first instance handles deep link')
  app.quit()
}

// Windows: deep-link URL arrives as an argv entry on the second instance.
// macOS: open-url event handles it on the first instance (below).
// This covers both platforms.
app.on('second-instance', (_event, argv) => {
  const deepLink = argv.find((a: string) => a.startsWith('cornflake://'))
  if (deepLink) {
    console.log('[auth] second-instance cornflake:// deep link:', deepLink)
    if (mainWindow) handleFallbackDeepLink(deepLink)
    else _pendingDeepLinkUrl = deepLink
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

// ---------------------------------------------------------------------------
// Single-instance + custom scheme: cornflake:// is kept as a FALLBACK.
//
// Primary login flow: localhost callback server in auth/deep-link-handler.ts
// sends a proper HTTP success response to the browser, then calls handleCallback.
//
// Fallback (cornflake://): fires if the user still has the old scheme registered
// in WorkOS, or if the localhost server fails to start.
// ---------------------------------------------------------------------------

app.setAsDefaultProtocolClient('cornflake')

// Queue deep links that arrive before mainWindow is created.
let _pendingDeepLinkUrl: string | null = null

app.on('open-url', (event, url) => {
  event.preventDefault()
  console.log('[auth] open-url (cornflake:// fallback) fired:', url)
  if (mainWindow) {
    handleFallbackDeepLink(url)
  } else {
    _pendingDeepLinkUrl = url
  }
})

function handleFallbackDeepLink(url: string): void {
  try {
    const code = new URL(url).searchParams.get('code')
    if (!code || !mainWindow) return
    handleCallback(code, mainWindow)
      .then(async profile => {
        console.log('[auth] fallback deep link: signed in as', profile.email)
        await broadcastAuthStatus(mainWindow!)
        // Calendar watcher start moved to renderer:ready handler — see ipc/index.ts.
        // The deep link flow triggers AUTH_LOGIN → authState transition → rendererReady
        // → watcher start, so we don't start it here.
        mainWindow!.show()
      })
      .catch(err => console.error('[auth] fallback deep link handleCallback error:', err))
  } catch (err) {
    console.error('[auth] handleFallbackDeepLink error:', err)
  }
}

// ---------------------------------------------------------------------------
// macOS version gate — ScreenCaptureKit requires macOS 13.0+
// ---------------------------------------------------------------------------

function assertMinMacOSVersion(): void {
  const release = os.release() // Darwin kernel version e.g. "22.0.0" for macOS 13
  const major = parseInt(release.split('.')[0] ?? '0', 10)
  // Darwin 22 = macOS 13 (Ventura). Darwin 21 = macOS 12 (Monterey).
  if (major < 22) {
    dialog.showErrorBox(
      'Cornflake requires macOS 13 or later',
      'Audio capture uses ScreenCaptureKit which is only available on macOS 13 (Ventura) and later.\n\nPlease upgrade macOS to use Cornflake.'
    )
    app.quit()
  }
}

// ---------------------------------------------------------------------------
// Brand assets — in dev they sit at <project>/assets; in packaged builds they
// are copied to <app>/Contents/Resources/assets via electron-builder.extraResources.
const ASSETS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, '..', '..', 'assets')
const APP_ICON_PATH  = path.join(ASSETS_DIR, 'cornflake.icns')
const TRAY_ICON_PATH = path.join(ASSETS_DIR, 'tray-logo.png')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let _trayLabelTimer: ReturnType<typeof setInterval> | null = null

// ---------------------------------------------------------------------------
// Tray label — next event name + relative time (e.g. "standup · in 45m")
// ---------------------------------------------------------------------------

function formatRelativeTime(ms: number): string {
  if (ms < 60 * 1000) return 'now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `in ${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 24) return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`
  return `in ${Math.floor(h / 24)}d`
}

function updateTrayLabel(): void {
  if (!tray) return
  const next = getCachedNextEvent()
  if (!next) {
    tray.setTitle('cornflake')
    return
  }
  const msUntil = next.startMs - Date.now()
  if (msUntil < 0) {
    tray.setTitle('cornflake')
    return
  }
  const name = next.title.length > 6 ? next.title.slice(0, 6) + '...' : next.title
  tray.setTitle(`${name} · ${formatRelativeTime(msUntil)}`)
}

// ---------------------------------------------------------------------------
// Tray menu helpers
// ---------------------------------------------------------------------------

function buildIdleMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: '▶  Start listening',
      click: () => {
        if (!mainWindow) return
        const payload = startManualRecording()
        mainWindow.webContents.send(MAIN_CHANNELS.RECORDING_STARTED, payload)
        tray?.setContextMenu(buildRecordingMenu(payload))
        mainWindow.show()
      },
    },
    { type: 'separator' },
    { label: 'Open Cornflake', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ])
}

function buildRecordingMenu(payload: { meetingId: string; title: string }): Menu {
  return Menu.buildFromTemplate([
    { label: payload.title, enabled: false },
    { type: 'separator' },
    {
      label: 'Stop and review',
      click: () => {
        tray?.setContextMenu(buildIdleMenu())
        mainWindow?.show()
        // Module 4 will send the recording:stop IPC — from the tray we just
        // reset the menu. The renderer's "Stop and review" button is the
        // primary path; the tray entry is a convenience shortcut.
      },
    },
    {
      label: 'Discard recording',
      click: () => {
        tray?.setContextMenu(buildIdleMenu())
      },
    },
    { type: 'separator' },
    { label: 'Open Cornflake', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ])
}

function createTray(): void {
  // nativeImage.createFromPath auto-picks the @2x retina variant if it sits
  // next to the base file (Electron convention) — both assets/tray-logo.png
  // and assets/tray-logo@2x.png are present.
  const img = nativeImage.createFromPath(TRAY_ICON_PATH)
  // Logo is full-colour, not monochrome — don't mark as template image
  // (template would force macOS to render it in black/white only).

  tray = new Tray(img)
  tray.setToolTip('Cornflake')
  tray.setContextMenu(buildIdleMenu())

  // Left-click on the tray icon: pop up the menu (same as right-click on macOS)
  tray.on('click', () => tray?.popUpContextMenu())
}

// ---------------------------------------------------------------------------
// Browser window
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    title: 'Cornflake',
    icon: APP_ICON_PATH,
    resizable: true,
  })

  // In packaged builds, dist/ is inside app.asar at the app root; in dev it's a sibling of electron/.
  const rendererHtml = app.isPackaged
    ? path.join(__dirname, '..', 'renderer', 'index.html')
    : path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html')
  mainWindow.loadFile(rendererHtml)

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  assertMinMacOSVersion()
  initDatabase()

  // Prime the token cache from Keychain ONCE at cold start. Subsequent reads
  // (sign-in, Cmd+R, API calls, sync, calendar polls) all hit the in-memory
  // cache instead of triggering a TCC prompt per access.
  await primeFromKeychain().catch(err =>
    console.error('[boot] primeFromKeychain failed:', (err as Error).message)
  )

  // Set the macOS Dock icon. The .icns in package.json applies at build/launch
  // time; this call ensures the running-app Dock icon is also branded during
  // dev (npm start) where the launcher icon comes from Electron itself.
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(nativeImage.createFromPath(APP_ICON_PATH))
    } catch (err) {
      console.warn('[branding] failed to set dock icon:', (err as Error).message)
    }
  }

  createTray()
  createWindow()

  // Flush any deep link that arrived via open-url before createWindow() completed
  if (_pendingDeepLinkUrl && mainWindow) {
    console.log('[auth] flushing queued deep link after app ready:', _pendingDeepLinkUrl)
    const url = _pendingDeepLinkUrl
    _pendingDeepLinkUrl = null
    handleFallbackDeepLink(url)
  }

  if (mainWindow) {
    registerIpcHandlers(mainWindow)

    // Update tray label whenever the event cache refreshes
    setOnEventsUpdated(updateTrayLabel)

    // Calendar watcher start moved to the renderer:ready IPC handler.
    // This ensures the renderer is mounted and listening for CALENDAR_EVENTS_UPDATED
    // before the watcher's first fetch fires.

    // Also tick every 60s to keep relative time ("in 45m" → "in 44m") current
    updateTrayLabel()
    _trayLabelTimer = setInterval(updateTrayLabel, 60 * 1000)

    // On every renderer load (including Cmd+R reloads), push auth status and the
    // current event cache. Using `on` instead of `once` ensures auth is restored
    // after any renderer reload, not just the initial load.
    mainWindow.webContents.on('did-finish-load', () => {
      broadcastAuthStatus(mainWindow!).catch(err =>
        console.error('[auth] broadcastAuthStatus failed on load:', err)
      )
      resendCachedEventsToRenderer(mainWindow!)

      // Test mode: fire a fake PROCESSING_COMPLETE so the SpeakerLabeller renders.
      // Activated by CORNFLAKE_TEST_LABELLER=1 in the environment.
      if (process.env.CORNFLAKE_TEST_LABELLER === '1') {
        const db = initDatabase()
        const meeting = db.createMeeting('SpeakerLabeller UI Test Meeting')
        db.createSelfSpeaker(meeting.id)
        const [spA, spB] = db.createSpeakers(meeting.id, ['0', '1'])
        db.setMeetingRequiresLabelling(meeting.id, true)
        console.log(`[test-labeller] Created meeting ${meeting.id} with 2 unresolved speakers`)
        setTimeout(() => {
          mainWindow!.webContents.send(MAIN_CHANNELS.PROCESSING_COMPLETE, {
            meetingId:               meeting.id,
            requiresManualLabelling: true,
            unresolvedSpeakers: [
              { id: spA.id, deepgramId: '0', label: 'Speaker A' },
              { id: spB.id, deepgramId: '1', label: 'Speaker B' },
            ],
          })
          console.log('[test-labeller] Fired PROCESSING_COMPLETE — SpeakerLabeller should be visible')
        }, 2000)
      }
    })
  }
})

app.on('before-quit', () => {
  if (_trayLabelTimer) clearInterval(_trayLabelTimer)
  stopCallbackServer()
  stopCalendarWatcher()
  closeDatabase()
})

// Keep app alive even when the window is closed — it lives in the menu bar.
app.on('window-all-closed', () => {
  // Do NOT quit; tray keeps the app alive.
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})
