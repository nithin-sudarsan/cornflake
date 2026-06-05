# Cornflake — Specification

## 1. Purpose

Cornflake is a macOS desktop application that records work meetings, transcribes them, and uses an LLM to extract structured notes, action items, and decisions. It then dispatches follow-up comms to other attendees and tracks tasks the user has committed to. Over time it builds a long-lived markdown profile of the user that personalises future extractions.

The app is single-player in v1: every action item the LLM extracts is treated as belonging to the signed-in user, regardless of who in the meeting spoke it.

## 2. Topology

Two repos, sibling directories:

- `cornflake/` — Electron desktop app (TypeScript, React, Tailwind v4, SQLite via better-sqlite3, native macOS audio addon)
- `cornflake-api/` — Express backend on Railway, talks to Supabase, Deepgram, Anthropic, SendGrid

Auth is WorkOS SSO (Google as the upstream provider). Sealed sessions live in the macOS Keychain; Google OAuth tokens are returned by the WorkOS callback and stored alongside.

Local SQLite is the source of truth for the running app; Supabase is the durable mirror that survives reinstalls and supports the cross-device story. A custom sync layer pushes local writes and pulls cloud rows in FK-dependency order.

## 3. Module pipeline (recording → review)

1. **Recording trigger** — manual button in the menu-bar UI, or auto-triggered by the calendar watcher when a meeting is 1–5 minutes away. Creates a `meetings` row and a self-speaker row.
2. **Audio capture** — Obj-C++ N-API addon (`swift/CornflakeCapture/CornflakeCapture.mm`) using ScreenCaptureKit (system audio) + AVAudioEngine (mic). Writes two 16 kHz mono WAV files to `NSTemporaryDirectory()`.
3. **Transcription** — POST mic + system WAVs as multipart to `/api/transcribe`; backend calls Deepgram (mic: `nova-2` no diarize; system: `nova-2 + diarize + utterances`). Returns `TranscriptUtterance[]`.
4. **Speaker inference** — three-stage in `electron/main/modules/speaker-inference`:
   - Voice profile lookup against stored embeddings (resemblyzer via Python sidecar).
   - Heuristics: self-intro regex, direct-address-at-utterance-start.
   - LLM fallback via `/api/extract` with `mode: 'speaker_inference_only'`.
   Unresolved speakers are labelled `Speaker 1/2/…` and surfaced as inline "Who is this?" nudges in the UI; the meeting is **never** blocked on manual labelling.
5. **LLM extraction** — POST utterances + speakers + user profile context to `/api/extract`. Backend runs four prompts in parallel:
   - `extractTasks` — action items (title, deadlineText, confidence, evidence)
   - `extractDecisions` — decisions made
   - `generateNotesAndTitle` — structured markdown notes + a descriptive title
   - `inferSpeakers` — Deepgram-id → known-name mapping
   Then sequentially:
   - `updateUserProfile` — merges durable facts from this meeting into the user's markdown profile, upserts to Supabase, returns it on the response.
6. **Review screen** — `MeetingDetail` renders notes, pending action items, participants. User approves/dismisses tasks and assigns them to lists.
7. **Comms draft** — after `tasks:confirm`, the app calls `POST /api/comms/draft` with meeting transcript context and confirmed tasks. The LLM writes one editable email per assignee into `comms` (`sent_at` null). **No email is sent at this stage.**
8. **Comms approval & send** — user reviews drafts in the Comms tab (edit copy, fix emails, toggle recipients), then explicitly triggers `comms:send`. Only then does the backend call SendGrid or deliver push notifications.

## 4. Data model (local SQLite)

Schema is versioned via `_meta.schema_version` and applied by `electron/main/modules/database/migrate.ts` from numbered `.sql` files. Current head: **14**.

Tables (with the columns that matter):

- `_meta(key, value)` — version + cached profile
- `users(id PK, email, name, avatar_url, …)` — WorkOS user_id is the PK
- `user_profiles(id PK, user_id UNIQUE FK, profile_md, updated_at)` — long-lived per-user markdown
- `meetings(id, title, start_ms, end_ms, summary, requires_manual_labelling, deleted_at, user_id, …)`
- `speakers(id, meeting_id, deepgram_id, name, email, is_self, confidence, has_cornflake, user_id, …)`
- `utterances(id, meeting_id, speaker_id, text, start_ms, end_ms, …)`
- `tasks(id, meeting_id, assignee_speaker_id, title, deadline_text, deadline_ms, status, list_name, origin_list, priority, sort_order, completed_at, user_id, …)`
- `decisions(id, meeting_id, text, …)`
- `comms(id, meeting_id, recipient_speaker_id, message_body, delivery_channel, send, sent_at, …)`
- `voice_profiles(id, name, email, embedding BLOB, sample_count, user_id, …)` — resemblyzer embedding as raw Float32 bytes
- `lists(id, name, created_at, user_id)` — user-created task lists
- `oauth_tokens(provider PK, tokens, …)` — legacy, retained for migration; live tokens are in Keychain
- `sync_queue` — pending changes when offline

All user-owned tables carry `user_id` (added in migration 012). The `users` table uses `id` as the WorkOS ID directly.

## 5. Sync layer

`electron/main/modules/sync/index.ts` is a single `SyncModule` singleton. Behaviour:

- **Write-through hooks**: every local query helper that mutates state calls `_onWrite(table, row)` or `_onDelete(table, id)`. Sync registers these hooks at startup so every write queues a `PendingChange`.
- **Push**: `flushQueue()` POSTs the queue to `/api/sync/push`. The backend stamps `user_id` on every record (except `users`, which uses `id`) and upserts via Supabase service-role key. Failures retry up to 3× then drop.
- **Pull**: `pullFromCloud()` GETs `/api/sync/pull` and upserts rows into local SQLite in `PULL_TABLE_ORDER` (parents before children). Conflict resolution: skip if local `updated_at > cloud updated_at`. Identical-content writes are detected and don't emit `sync:dataUpdated` to the renderer.
- **Idempotency**: `init(userId)` is guarded so `renderer:ready` (which fires on every Cmd+R) and post-login both call it safely.
- **Periodic pull**: every 60 s while logged in.
- **Logout**: `wipeUserData()` deletes every user-owned row from local SQLite so the next user can't see them.

Table order (both push and pull):
`users, user_profiles, lists, meetings, speakers, utterances, tasks, decisions, comms, voice_profiles`.

The Supabase user_profiles row uses `id = user_id` so upsert with `onConflict: 'id'` works deterministically.

## 6. LLM personalisation

After every meeting, `updateUserProfile()` on the backend merges new durable facts from the transcript into a per-user markdown document (`user_profiles.profile_md`) and returns the updated version. The next meeting's extraction reads this profile back and prepends it to the user message of `extractTasks` and `generateNotesAndTitle` (not `extractDecisions` or `inferSpeakers` — those are structural and don't benefit from personalisation).

The profile is seeded on first login from the WorkOS `name`/`email` and grows section by section:

- `## About me` — name, role, company, location
- `## My work` — current projects, goals
- `## People I work with` — recurring names and their relation to the user
- `## Ongoing projects` — named initiatives, products, deals
- `## Recurring themes` — repeating problems, priorities

The backend writes the updated profile to Supabase directly (service-role key) and also returns it on the `/api/extract` response so the Electron client can mirror it into local SQLite immediately. The local mirror queues a redundant sync push, which is a no-op upsert on Supabase.

## 7. Backend endpoints (`cornflake-api`)

All `/api/*` routes except `/api/auth/*` require a Bearer token (WorkOS sealed session JWT). The `authMiddleware` decodes the JWT, checks `exp`, and verifies the user exists via `workos.userManagement.getUser(sub)`. The resolved `{ id, email }` is attached to `req.user`.

- `POST /api/auth/exchange` — exchange WorkOS code for sealed session + Google tokens
- `GET  /api/auth/me` — validates current sealed session, returns user
- `POST /api/auth/refresh` — refresh sealed session via WorkOS refresh token
- `POST /api/transcribe` — multipart (mic + system audio) → utterances
- `POST /api/extract` — utterances + speakers → tasks, decisions, summary, title, speaker inference, updated profile
- `GET  /api/sync/pull` — all rows for the current user, table-ordered
- `POST /api/sync/push` — apply a batch of upserts/deletes
- `POST /api/comms/draft` — meeting context + confirmed tasks per recipient → LLM-drafted email bodies (no send)
- `POST /api/comms/send` — fan out SendGrid + push delivery after user approval in the Comms tab
- `POST /api/voice-profiles/*` — voice embedding bookkeeping (called from the sidecar/inference layer)

## 8. Auth + Keychain layout

WorkOS SSO is the only auth path; the legacy direct-Google flow has been removed. Tokens live in macOS Keychain under service `cornflake`:

- `workos_access_token` — sealed session JWT used as the bearer for `/api/*`
- `workos_refresh_token`
- `google_access_token` — read by the calendar watcher
- `google_refresh_token`

The renderer never sees these. The main process reads them through the `auth` module and surfaces `UserProfile { id, email, name, avatarUrl }` over IPC.

On any `/api/*` 401, the api-client triggers a registered refresh handler (`setRefreshHandler` in `ipc/index.ts`) which calls `refreshSession()` and re-inits sync. If refresh fails the user is force-logged-out.

## 9. IPC + renderer wiring

All channel names live in `electron/main/ipc/types.ts` as const objects — single source of truth. Preload at `electron/main/preload.ts` exposes them as `window.electronAPI` via contextBridge. The renderer is React + Tailwind v4 (`@import "tailwindcss"` in CSS, `@tailwindcss/postcss` in postcss config — no `tailwind.config.js`).

Key flows:

- `renderer:ready` (handle): runs on every renderer mount including Cmd+R. Resolves session, re-inits sync, pulls from cloud, starts the calendar watcher, resends cached calendar events. Idempotent.
- `recording:startManual` / `recording:stop` / `recording:discard`: drive the audio capture addon and chain the post-capture pipeline.
- `processing:complete` (event from main): fired once the full pipeline finishes, even when partial errors occur. Renderer must `processing:ack` within 2 s or main logs a warning.
- `speakers:label` / `speakers:confirm` / `speakers:resolve`: handle manual speaker correction without blocking the meeting view.

## 10. Build + run

- `npm start` in `cornflake/` — runs `build:main` (tsc → `dist/main/`), `build:renderer` (webpack → `dist/renderer/`), then `electron .`
- `npm run build:capture` in `cornflake/` (run from `swift/`) — rebuilds the audio capture addon against the current Electron headers
- `npm run rebuild:native` in `cornflake/` — rebuilds better-sqlite3 only
- `cornflake-api/` deploys automatically to Railway from `main`
- Required env vars in `cornflake-api/.env`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `SENDGRID_API_KEY`, `LLM_PROVIDER` (claude|openai|grok)
- Required env vars in `cornflake/.env`: `BACKEND_URL`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_CALLBACK_PORT` (default 52069)

## 11. Platform notes

- macOS 13+ required (gated by `assertMinMacOSVersion` in `electron/main/index.ts` — Darwin kernel ≥ 22).
- System audio capture needs Screen Recording permission (TCC). Fails gracefully with an error string if denied.
- The Obj-C++ addon stores its SCStream handler in a global `__strong` so ARC doesn't release it after the start callback returns.
- A no-op video output must be registered alongside the audio output, otherwise SCStream audio callbacks never fire.
- TypeScript 6 requires `module: "Node16"` + `moduleResolution: "node16"` for the main process tsconfig.
- The Python sidecar redirects resemblyzer's startup banner to stderr via `sys.stdout = sys.stderr` during import so the JSON-RPC protocol on stdout stays clean.

## 12. Module build status

1. Electron scaffold + IPC skeleton ✅
2. Database layer (schema, migrations, typed queries) ✅
3. Recording trigger + Calendar watcher ✅
4. Audio capture (Obj-C++ N-API addon) ✅
5. Deepgram transcription pipeline ✅
6. Speaker inference (Python sidecar + heuristics + LLM fallback) ✅
7. LLM extraction (notes, tasks, decisions, title, user profile) ✅
8. Review screen UI ✅ (MeetingDetail with action items + participants section)
9. Comms draft + approval-gated dispatch — LLM drafts from context; SendGrid only after user sends from Comms tab
10. End-to-end wiring — auth, sync, profile personalisation all integrated
