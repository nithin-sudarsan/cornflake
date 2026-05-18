# Cornflake — Beta Distribution Checklist

> Paste this into Claude Code and work through each section in order.
> Scoped for a direct-download beta with known testers — not App Store submission.

---

## 1. Fix the Sync Bug (Current Blocker)

The push route fails with a FK violation because the `users` row doesn't exist in Supabase before dependent tables try to reference it.

- [ ] In `/cornflake-api/src/routes/sync.ts`: when upserting to the `users` table, do NOT add a `user_id` field — `users` uses `id` (WorkOS ID) as its PK directly
- [ ] Ensure the push handler processes records in `PULL_TABLE_ORDER`: `users → user_profiles → lists → meetings → speakers → utterances → tasks → decisions → comms → voice_profiles`
- [ ] Verify: create a reminder in the app → row appears in Supabase `tasks` table
- [ ] Verify: sign out → sign back in → previous meetings and tasks restored from Supabase

---

## 2. No Secrets or Dev Paths in the Build

- [ ] Search for hardcoded secrets across both repos:
  ```
  grep -r "sk-ant\|SG\.\|eyJ\|DEEPGRAM\|supabase\.co\|sk-" \
    --include="*.ts" --include="*.js" --include="*.py" .
  ```
- [ ] Confirm `cornflake/.env` is in `.gitignore` and not tracked
- [ ] Confirm the Electron build only bundles `BACKEND_URL`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_CALLBACK_PORT` — no Supabase, Deepgram, Anthropic, or SendGrid keys
- [ ] Search for absolute local paths that will break on any other machine:
  ```
  grep -r "/Users/" --include="*.ts" --include="*.js" --include="*.py" .
  ```
- [ ] Confirm the Python sidecar is launched using `process.resourcesPath` at runtime, not a hardcoded dev path
- [ ] Confirm SQLite DB path uses `app.getPath('userData')`, not a hardcoded path
- [ ] Confirm WAV files are written to `NSTemporaryDirectory()` at runtime (as per spec), not a dev-time absolute path

---

## 3. Python Sidecar Bundled Correctly

This is the most common reason Electron apps with sidecars silently break on testers' machines.

- [ ] `resemblyzer` and all its dependencies are either frozen with PyInstaller into a self-contained binary, or installed into a bundled virtualenv inside the app package — testers will NOT have Python or resemblyzer installed
- [ ] `electron-builder` config has `extraResources` or `asarUnpack` covering the `python/` directory (and the frozen binary if using PyInstaller)
- [ ] Confirm `sidecar.py` sets `sys.stdout = sys.stderr` before importing resemblyzer so the JSON-RPC protocol on stdout stays clean — verify this is present
- [ ] Sidecar process is killed cleanly on app quit (`app.on('before-quit')`)
- [ ] If the sidecar fails to start or crashes, the app shows a graceful error in the UI — speaker inference falls back to `Speaker 1/2/…` labels rather than hanging

---

## 4. macOS Permissions

Beta testers will hit all three of these dialogs on first launch.

- [ ] `NSMicrophoneUsageDescription` exists in `Info.plist` with a clear user-facing string (e.g. "Cornflake needs microphone access to record your meetings.")
- [ ] `NSScreenCaptureUsageDescription` exists in `Info.plist` (required for ScreenCaptureKit system audio capture — this is the Screen Recording TCC permission)
- [ ] `NSCalendarsUsageDescription` exists in `Info.plist` if the calendar watcher triggers a system permission prompt
- [ ] Test on a fresh Mac user account: deny each permission one at a time and confirm the app:
  - Does not crash
  - Shows a clear in-app message explaining which permission is missing and how to enable it in System Settings
  - Degrades gracefully (e.g. no system audio if Screen Recording denied, no calendar if calendar denied)

---

## 5. Entitlements

- [ ] `entitlements.mac.plist` includes:
  - `com.apple.security.device.audio-input`
  - `com.apple.security.network.client`
  - `com.apple.security.cs.allow-unsigned-executable-memory` (likely needed for the Python sidecar)
  - `com.apple.security.cs.disable-library-validation` (likely needed for the Obj-C++ N-API addon)
- [ ] Hardened Runtime is enabled in `electron-builder` config (`hardened-runtime: true`)
- [ ] After building, run: `codesign --verify --deep --strict dist/Cornflake.app` — must pass with no errors

> **Note:** Full Apple notarisation is not required for beta testers receiving the app directly. Testers will need to right-click → Open on first launch to bypass Gatekeeper. Include this in your tester instructions.

---

## 6. Electron Security (Minimum for Beta)

- [ ] All `BrowserWindow` instances have `contextIsolation: true` and `nodeIntegration: false`
- [ ] Preload script uses `contextBridge.exposeInMainWorld` to expose `window.electronAPI` — confirm the renderer never receives a raw `ipcRenderer` reference
- [ ] Confirm all IPC channel names are sourced from `electron/main/ipc/types.ts` — no magic strings in renderer code
- [ ] `webSecurity` is not disabled in any `BrowserWindow`

---

## 7. Token Refresh & Auth Edge Cases

These will surface during beta.

- [ ] Investigate and fix the `refreshSession()` crash: `TypeError: Cannot read properties of undefined (reading 'email')` — the refresh handler in `ipc/index.ts` must not crash when the WorkOS response is malformed or expired; it should force-logout cleanly instead
- [ ] Confirm the 401 auto-retry flow works end-to-end: `/api/*` returns 401 → `setRefreshHandler` fires → session refreshed → original request retried
- [ ] Confirm `renderer:ready` is idempotent (per spec) — rapidly pressing Cmd+R must not cause duplicate sync inits, duplicate calendar watchers, or duplicate pull requests
- [ ] Test the Google refresh token path: subsequent logins return `hasGoogleRefresh: false` — confirm the calendar watcher handles an expired Google token gracefully (shows a "Reconnect calendar" nudge rather than silently failing)

---

## 8. Pipeline Error Handling

- [ ] `processing:complete` is fired from main even when partial errors occur (per spec) — verify this is implemented and not only fired on full success
- [ ] Renderer handles `processing:complete` with partial data (e.g. transcription succeeded but extraction failed) — shows whatever was extracted rather than a blank screen
- [ ] Renderer sends `processing:ack` within 2 s of receiving `processing:complete` — confirm this is wired up
- [ ] Deepgram or Anthropic API errors surface a visible message in the `MeetingDetail` UI — not just a `console.error` that testers will never see
- [ ] WAV files are deleted after transcription completes — including on error paths (confirm the cleanup runs in a `finally` block or equivalent, not just on success)

---

## 9. Build Configuration

- [ ] Run a clean production build (`npm start` with `NODE_ENV=production`) — no TypeScript errors, no missing module errors
- [ ] Confirm `tsconfig` for main process has `module: "Node16"` and `moduleResolution: "node16"` (required for TypeScript 6 per spec)
- [ ] `asar: true` in `electron-builder` config
- [ ] `files` array excludes: `phase2-docs/`, `.env`, `*.md`, `python/__pycache__/`, any test audio fixtures, raw `.wav` files
- [ ] `appId` is set (e.g. `app.cornflake.mac`) and `productName` is `Cornflake`
- [ ] App icon is a proper `.icns` file — not a `.png` placeholder
- [ ] `assertMinMacOSVersion` check in `electron/main/index.ts` is present and gates on Darwin kernel ≥ 22 (macOS 13)

---

## 10. Beta Smoke Test

Do this yourself on a **clean sign-in** (sign out first) before sending to anyone.

- [ ] App launches, `assertMinMacOSVersion` passes silently
- [ ] Sign-in screen appears → "Sign in with Google" → WorkOS callback on port 52069 completes → profile picture and name appear
- [ ] Google Calendar events load in the right panel (next 10 days)
- [ ] Start a manual recording → mic + system audio both capture → stop recording → transcription returns utterances → LLM extraction completes → `MeetingDetail` renders notes and action items
- [ ] Approve an action item → task appears in Reminders list with correct list assignment
- [ ] Task row appears in Supabase `tasks` table (check dashboard)
- [ ] User profile in `user_profiles` table is updated after extraction
- [ ] Sign out → `wipeUserData()` runs (no local rows remain for the user) → sign back in → data pulled from Supabase and restored
- [ ] Cmd+R during normal use → no duplicate watchers, no sync errors in console
- [ ] Quit mid-recording → relaunch → no stuck UI, no orphaned Python sidecar process (`ps aux | grep sidecar`)
- [ ] Mac sleeps during recording → wakes → app handles the interruption without crashing

---

## Tester Instructions (Send With the Build)

Include a short note covering:

1. **Install**: drag `Cornflake.app` to `/Applications`
2. **First launch**: right-click the app → Open → click Open in the Gatekeeper dialog (required because the app is not yet notarised)
3. **Permissions**: grant Microphone and Screen Recording when prompted — both are required for recording to work. If you accidentally deny either, go to System Settings → Privacy & Security to re-enable.
4. **Known issue**: the session expires after ~1 hour. If the app stops responding, sign out and sign back in.
5. **Feedback**: [your preferred channel — email / Slack / Notion form]
