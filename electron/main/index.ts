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

import { registerIpcHandlers, registerTrayHooks } from './ipc'
import { initDatabase, closeDatabase } from './modules/database'
import { primeFromKeychain } from './modules/auth'
import { initUpdater, stopUpdater } from './modules/updater'
import {
  startCalendarWatcher,
  stopCalendarWatcher,
  getCachedNextEvent,
  setOnEventsUpdated,
  broadcastAuthStatus,
  resendCachedEventsToRenderer,
  sendDisplayEventsToRenderer,
  triggerPoll,
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
  // Darwin kernel version → macOS:
  //   Darwin 22.x = macOS 13 (Ventura)
  //   Darwin 23.x = macOS 14 (Sonoma) — 23.0=14.0, 23.2=14.2, 23.4=14.4 …
  //   Darwin 24.x = macOS 15 (Sequoia)
  // We require macOS 14.2 because CoreAudio Process Tap (AudioHardwareCreateProcessTap)
  // was introduced in 14.2.
  const release = os.release()
  const parts   = release.split('.')
  const major   = parseInt(parts[0] ?? '0', 10)
  const minor   = parseInt(parts[1] ?? '0', 10)
  const tooOld  = major < 23 || (major === 23 && minor < 2)
  if (tooOld) {
    dialog.showErrorBox(
      'Cornflake requires macOS 14.2 or later',
      'Cornflake captures system audio with CoreAudio Process Tap, which is only available on macOS 14.2 (Sonoma) and later.\n\nPlease upgrade macOS to use Cornflake.'
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

// Tray state — kept in sync with the renderer via setTrayAuthState /
// setTrayRecordingState. The tray menu is rebuilt whenever either changes.
let _trayAuthenticated = false
let _trayRecording: { meetingId: string; title: string } | null = null

function buildIdleMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: _trayAuthenticated ? '▶  Start listening' : '▶  Start listening (sign in first)',
      enabled: _trayAuthenticated,
      click: () => {
        if (!mainWindow) return
        // Delegate to the renderer so we go through the canonical start flow
        // (permission gating, audio capture, error UI). The renderer's handler
        // is identical to clicking the right-panel button.
        mainWindow.show()
        mainWindow.webContents.send(MAIN_CHANNELS.TRAY_REQUEST_START)
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
        if (!mainWindow) return
        mainWindow.show()
        mainWindow.webContents.send(MAIN_CHANNELS.TRAY_REQUEST_STOP)
      },
    },
    {
      label: 'Discard recording',
      click: () => {
        if (!mainWindow) return
        mainWindow.webContents.send(MAIN_CHANNELS.TRAY_REQUEST_DISCARD)
      },
    },
    { type: 'separator' },
    { label: 'Open Cornflake', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ])
}

function rebuildTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(_trayRecording ? buildRecordingMenu(_trayRecording) : buildIdleMenu())
}

export function setTrayAuthState(authed: boolean): void {
  if (_trayAuthenticated === authed) return
  _trayAuthenticated = authed
  // Logging out mid-recording would leave a stale recording menu — clear it.
  if (!authed) _trayRecording = null
  rebuildTrayMenu()
}

export function setTrayRecordingState(payload: { meetingId: string; title: string } | null): void {
  _trayRecording = payload
  rebuildTrayMenu()
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
    // macOS-only: enable NSVisualEffectView behind the window so the sidebar
    // can render a translucent "glassy" background. The renderer's body bg is
    // transparent; the main + right panels remain opaque (their own bg covers
    // the vibrancy in those regions); the sidebar uses a low-alpha tint so the
    // blur shows through. `visualEffectState: 'active'` keeps the blur visible
    // even when the window is not focused.
    ...(process.platform === 'darwin'
      ? {
          vibrancy: 'hud' as const,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000',
        }
      : {}),
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

  // Refresh calendar events whenever the window regains focus. The 60s poll
  // means a freshly-created Google Calendar event can take up to a minute to
  // appear; this fires an immediate poll when the user switches back to the
  // app (e.g. after creating the event in their browser).
  mainWindow.on('focus', () => {
    triggerPoll()
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
    registerTrayHooks({
      setAuth:      setTrayAuthState,
      setRecording: setTrayRecordingState,
    })

    // Auto-updater (no-op in dev; checks GitHub Releases in packaged builds).
    initUpdater(mainWindow)

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
  stopUpdater()
  closeDatabase()
})

// Keep app alive even when the window is closed — it lives in the menu bar.
app.on('window-all-closed', () => {
  // Do NOT quit; tray keeps the app alive.
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})
