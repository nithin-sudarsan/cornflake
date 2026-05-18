// Verify:
// 1. window.electronAPI is defined in the renderer (all expected keys present)
// 2. startManual IPC + DB write works end-to-end
//
// Boots the full app stack (DB init + IPC handlers), then exercises from renderer side.
// Run: ./node_modules/.bin/electron --no-sandbox scripts/verify-preload.js

process.chdir('/Users/nithin/Documents/cornflake')
require('/Users/nithin/Documents/cornflake/node_modules/dotenv').config({ path: '/Users/nithin/Documents/cornflake/.env' })

const path = require('path')
const { app, BrowserWindow } = require('electron')
const Database = require('better-sqlite3')

const EXPECTED_API_KEYS = [
  'startManual', 'stopRecording', 'discardRecording', 'updateTitle',
  'confirmTasks', 'sendComms', 'labelSpeakers', 'updateProfiles', 'connectCalendar',
  'onMeetingUpcoming', 'onRecordingStarted', 'onSpeakerAdded',
  'onProcessingComplete', 'onCommsSent', 'removeAllListeners',
]

app.whenReady().then(async () => {
  // Full startup sequence matching electron/main/index.ts
  const { initDatabase } = require('/Users/nithin/Documents/cornflake/dist/main/modules/database/index.js')
  initDatabase()

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Register all IPC handlers just like the real app does
  const { registerIpcHandlers } = require('/Users/nithin/Documents/cornflake/dist/main/ipc/index.js')
  registerIpcHandlers(win)

  win.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'))

  win.webContents.once('did-finish-load', async () => {
    let passed = 0
    let failed = 0

    // --- Check 1: window.electronAPI keys ---
    const apiKeys = await win.webContents.executeJavaScript(
      'Object.keys(window.electronAPI || {})'
    ).catch(() => [])

    console.log('\n=== Check 1: window.electronAPI ===')
    const missing = EXPECTED_API_KEYS.filter(k => !apiKeys.includes(k))
    if (missing.length === 0) {
      console.log('✓ window.electronAPI defined with all', apiKeys.length, 'expected keys')
      passed++
    } else {
      console.error('✗ Missing keys:', missing.join(', '))
      failed++
    }

    // --- Check 2: startManual IPC creates DB row ---
    console.log('\n=== Check 2: startManual → DB row ===')

    const dbPath = path.join(app.getPath('userData'), 'cornflake.db')
    const rawDb = new Database(dbPath)
    const countBefore = rawDb.prepare('SELECT COUNT(*) as n FROM meetings').get()?.n ?? 0

    const result = await win.webContents.executeJavaScript(
      'window.electronAPI.startManual()'
    ).catch(err => { console.error('startManual failed:', err.message); return null })

    await new Promise(r => setTimeout(r, 300))

    const countAfter = rawDb.prepare('SELECT COUNT(*) as n FROM meetings').get()?.n ?? 0
    const latest = rawDb.prepare('SELECT * FROM meetings ORDER BY created_at DESC LIMIT 1').get()
    rawDb.close()

    if (countAfter > countBefore && latest) {
      console.log(`✓ Meeting row created (${countBefore} → ${countAfter})`)
      console.log('  id:', latest.id)
      console.log('  title:', latest.title)
      console.log('  start_ms:', latest.start_ms)
      passed++
    } else {
      console.error('✗ No new meeting row in DB')
      failed++
    }

    console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`)
    process.exit(failed > 0 ? 1 : 0)
  })

  setTimeout(() => {
    console.error('Timeout — page did not load within 10s')
    process.exit(1)
  }, 10000)
})
