# Cornflake — Architecture Document

## Purpose

This document defines the technical architecture for the Cornflake MVP. It is the primary reference for all implementation work and the context document to load at the start of each Claude Code session.

---

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Desktop shell | Electron (TypeScript) | Cross-platform, faster to build than native, sufficient for Mac-first MVP |
| UI framework | React + Tailwind (inside Electron) | Component model maps well to the review screen's tabbed UI |
| Local database | SQLite via `better-sqlite3` | Meetings, tasks, speakers, voice profiles — all local, no server |
| Audio capture | ScreenCaptureKit via Swift bridge (native Node addon) + standard mic capture | Built into macOS 13+, no user setup, clean separation of system audio and mic |
| Transcription + diarisation | Deepgram API (Nova-2 model with diarisation enabled) | Bundles transcription and speaker segmentation in one API call; avoids running pyannote locally |
| Local processing sidecar | Python 3.11 (spawned as a child process from Electron main) | Voice embedding storage and similarity matching for speaker profile learning |
| LLM extraction | Swappable provider abstraction (see LLM layer below) — default: Claude Sonnet 4.6 | Task extraction, decision extraction, meeting summary, comms copy generation |
| Calendar integration | Google Calendar API (OAuth 2.0, read-only scope for v1) | Optional — enhances with pre-meeting notifications and attendee list; app fully functional without it |
| Comms dispatch | SendGrid API (Cornflake-hosted key) + macOS push notifications | No user SMTP setup; SendGrid handles deliverability |
| IPC | Electron `ipcMain` / `ipcRenderer` | Main process (audio, DB, APIs) ↔ renderer process (React UI) |

---

## System Components

```
┌─────────────────────────────────────────────────────────┐
│                     Electron Main Process                │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Audio       │  │ Calendar     │  │ DB Layer      │  │
│  │ Capture     │  │ Watcher      │  │ (SQLite)      │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                │                  │           │
│  ┌──────▼──────────────────────┐            │           │
│  │     Pipeline Orchestrator   │◄───────────┘           │
│  └──────┬──────────────────────┘                        │
│         │                                               │
│  ┌──────▼──────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Deepgram    │  │ LLM Layer    │  │ Speaker       │  │
│  │ Client      │  │ (swappable)  │  │ Inference     │  │
│  └─────────────┘  └──────────────┘  └───────┬───────┘  │
│                                             │           │
│                                    ┌────────▼────────┐  │
│                                    │ Python Sidecar  │  │
│                                    │ (voice embeds)  │  │
│                                    └─────────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │              IPC Bridge                          │   │
│  └──────────────────────┬───────────────────────────┘   │
└─────────────────────────┼───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│                  Electron Renderer Process               │
│                  (React + Tailwind)                      │
│                                                         │
│   Menu bar UI   │   Review Screen   │   Task Detail     │
└─────────────────────────────────────────────────────────┘
```

---

## Module Breakdown

The codebase is split into 7 independently buildable modules. Each Claude Code session should target one module at a time.

### Module 1 — Audio Capture
**Responsibility:** Capture mic and system audio as two separate raw audio streams.

- System audio captured via ScreenCaptureKit (macOS 13+) through a Swift bridge exposed to Electron as a native Node addon (`.node` built with `node-gyp`)
- Mic captured via standard Web Audio API / Node audio
- Both streams output as 16kHz mono PCM buffers
- Streams held in memory during recording; written to temp files on "Stop and review"
- Swift bridge responsibilities: request screen recording permission, start/stop SCStream, pipe raw PCM audio buffers back to the Node layer via a callback
- Minimum macOS version: 13.0 (Ventura). App should gate on this at launch and show a clear error on older versions.
- Exposes: `startCapture()`, `stopCapture()` → `{ micPath: string, systemAudioPath: string }`

---

### Module 2 — Recording Trigger + Calendar Watcher
**Responsibility:** Provide two ways to start a recording — manual quick-start (always available) and calendar-triggered (optional, requires Google Calendar connection).

**Manual quick-start (no calendar required)**
- Menu bar idle state exposes a "Start listening" action
- Clicking creates a new meeting record with title `"Meeting, HH:MM"` and starts audio capture immediately
- Title is editable inline in the active recording dropdown
- No attendee list — speaker inference relies on voice profiles and transcript context only

**Calendar watcher (optional)**
- Only active if user has completed Google OAuth
- OAuth 2.0 with Google (scope: `calendar.readonly`)
- Tokens stored in SQLite (encrypted at rest)
- Polls every 60 seconds for events starting within the next 5 minutes
- On match: fires a macOS toast notification with "Join meeting & start listening" CTA
- On start: pre-fills meeting title from calendar event title; extracts attendee list and stores against the meeting record for use by speaker inference
- "Connect Google Calendar" prompt shown in the idle menu bar dropdown if not yet connected — skippable

**State machine: `calendar` field on meeting record**
- `calendar_event_id = null` → manual start; no attendee list available
- `calendar_event_id = <id>` → calendar-triggered; attendee list stored in `speakers` table on meeting creation

Exposes: `startManual()`, `startWatcher()`, `stopWatcher()`, event emitter: `onUpcomingMeeting(event)`

---

### Module 3 — Transcription + Diarisation Pipeline
**Responsibility:** Send audio to Deepgram, receive a timestamped, diarised transcript.

- Sends the system audio stream to Deepgram Nova-2 with `diarize=true`
- Mic stream sent separately and tagged as speaker "You" throughout
- Deepgram returns: `{ words: [{ word, start, end, speaker, confidence }] }`
- Segments stitched into utterances: consecutive words from the same speaker ID grouped together
- Utterances merged with mic stream (mic segments always assigned to "You")
- Output: `Transcript` — array of `{ speakerId: string, text: string, startMs: number, endMs: number }`
- Speaker IDs at this stage are `"you"` or `"deepgram_0"`, `"deepgram_1"` etc. — unnamed

**Privacy disclosure:** A clear in-app notice before first use stating that audio is sent to Deepgram for transcription and not retained beyond the session. Link to Deepgram's data retention policy.

---

### Module 4 — Speaker Inference
**Responsibility:** Map anonymous Deepgram speaker IDs to real names using transcript context and voice profiles.

This module runs after Module 3 and before Module 5.

**Step 1 — Voice profile lookup**
For each Deepgram speaker ID, extract a short audio segment and call the Python sidecar to compare against stored voice embeddings. If similarity exceeds threshold (0.85 cosine similarity), assign the stored name directly. Skip remaining steps for matched speakers.

**Step 2 — Transcript context inference**
For unmatched speakers, run inference passes in order:
1. Self-introduction pattern: `"(I'm|I am|my name is) {name}"` → assign name to that speaker ID
2. Direct address pattern: `"{name}[,] ..."` at utterance start → assign name to the *previous* speaker ID
3. Elimination: only applicable if calendar attendee list is available AND (attendee count - 1) == unmatched speaker count — resolve by elimination. Skipped entirely for manual-start meetings with no attendee list.

Each assignment gets a confidence level: `high` (voice match or self-intro), `medium` (direct address), `low` (elimination).

**Step 3 — Unresolved speakers**
Any speaker ID still unresolved after both steps keeps label `"Speaker A/B/C"`. A flag is set on the meeting record: `requiresManualLabelling: true`. The review screen renders a pre-interstitial prompting the user to label unresolved speakers before proceeding.

**Step 4 — Profile update**
After user confirms or corrects assignments in the review screen, call the Python sidecar to store/update voice embeddings for confirmed speakers.

**Python sidecar:** Uses `resemblyzer` (speaker encoder based on GE2E) for embedding extraction and cosine similarity. Embeddings stored in SQLite as BLOB. Sidecar exposes a simple JSON-over-stdin/stdout RPC interface.

Exposes: `inferSpeakers(transcript, meetingId)` → `SpeakerMap`, `updateProfiles(corrections, meetingId)`

---

### Module 5 — LLM Extraction
**Responsibility:** Extract tasks, decisions, and meeting summary from the named transcript.

**LLM Provider Abstraction**

All LLM calls go through a provider interface. Switching providers requires only a config change.

```typescript
interface LLMProvider {
  complete(prompt: string, systemPrompt: string): Promise<string>
}

// Implementations
class ClaudeProvider implements LLMProvider { ... }   // default
class OpenAIProvider implements LLMProvider { ... }
class GrokProvider implements LLMProvider { ... }
```

Config in `llm.config.ts`:
```typescript
export const LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'claude'
export const LLM_MODEL = {
  claude: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  grok: 'grok-3'
}
```

**Extraction calls (run in parallel, post-meeting):**

1. **Task extraction** — prompt: given transcript, extract all commitments and action items as JSON. Schema: `{ tasks: [{ title, assigneeName, deadlineText, confidence, transcriptQuote }] }`
2. **Decision extraction** — prompt: extract decisions made in the meeting. Schema: `{ decisions: [{ text }] }`
3. **Summary generation** — prompt: write a 3-5 sentence summary of the meeting.

Comms copy is **not** generated during initial extraction. It runs later in the comms protocol (see below).

All prompts request JSON-only responses. Responses validated against schema before use; malformed responses trigger a retry (max 2).

**Comms draft call (after user confirms tasks, before any send):**

4. **Comms draft generation** — `POST /api/comms/draft` on the backend. For each assignee with confirmed tasks, the LLM receives:
   - Meeting title and summary
   - That recipient's confirmed tasks (title, deadline, transcript quote, host note)
   - A transcript excerpt where they were addressed or the commitment was discussed
   - Output: one human-feeling email body per recipient, stored in `comms.message_body` as an editable draft

Nothing is sent at this stage.

---

### Module 6 — Database Layer
**Responsibility:** All reads and writes to SQLite. No other module accesses the DB directly.

**Schema:**

```sql
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  title TEXT,
  start_ms INTEGER,
  end_ms INTEGER,
  calendar_event_id TEXT,
  requires_manual_labelling INTEGER DEFAULT 0,
  confirmed_at INTEGER,         -- null until user hits Confirm & send
  created_at INTEGER
);

CREATE TABLE speakers (
  id TEXT PRIMARY KEY,
  meeting_id TEXT REFERENCES meetings(id),
  deepgram_id TEXT,             -- e.g. "deepgram_0"
  name TEXT,                    -- null if unresolved
  is_self INTEGER DEFAULT 0,
  confidence TEXT,              -- 'high' | 'medium' | 'low' | 'manual'
  voice_embedding BLOB          -- stored after first confirmation
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  meeting_id TEXT REFERENCES meetings(id),
  title TEXT,
  assignee_speaker_id TEXT REFERENCES speakers(id),
  deadline_text TEXT,           -- raw text from transcript e.g. "Friday"
  deadline_ms INTEGER,          -- resolved timestamp, null if not detected
  remind_offset_ms INTEGER,     -- ms before deadline to remind
  transcript_quote TEXT,
  confidence TEXT,              -- 'high' | 'medium' | 'low'
  status TEXT DEFAULT 'pending',-- 'pending' | 'confirmed' | 'dismissed'
  note TEXT,
  created_at INTEGER
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT REFERENCES meetings(id),
  text TEXT
);

CREATE TABLE comms (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  recipient_speaker_id TEXT REFERENCES speakers(id),
  message_body TEXT,
  delivery_channel TEXT,        -- 'push' | 'email' | 'both'
  recipient_email TEXT,
  has_cornflake INTEGER DEFAULT 0,
  sent_at INTEGER               -- null until dispatched
);

CREATE TABLE voice_profiles (
  id TEXT PRIMARY KEY,
  speaker_name TEXT UNIQUE,
  embedding BLOB,
  updated_at INTEGER
);
```

---

### Module 7 — Comms Dispatch
**Responsibility:** Send task notification emails **only after explicit user approval**.

**Comms protocol (draft → review → approve → send):**

| Phase | Trigger | What happens | Outbound email? |
|---|---|---|---|
| 1. Extract | Recording stops | Tasks, decisions, summary written to DB | No |
| 2. Task review | User approves/dismisses tasks in review UI | `tasks:confirm` IPC | No |
| 3. Draft | Immediately after task confirm | `POST /api/comms/draft` uses transcript context to write one editable message per assignee into `comms` (`sent_at` null) | No |
| 4. Comms review | User opens Comms tab | Edit message bodies; enter/fix recipient emails; toggle send per person | No |
| 5. Approve & send | User clicks "Send" | `comms:send` IPC → `POST /api/comms/send` (SendGrid / push) | **Yes** |

Rules:
- Transcript completion never triggers email.
- Task confirmation drafts comms but does not dispatch them.
- `comms:send` is the only code path that calls SendGrid.
- User-edited `message_body` is what gets sent (draft is not regenerated at send time unless tasks change).

Implementation details:
- For app users (push): macOS `Notification` API via Electron
- For non-app users (email): SendGrid API using a Cornflake-hosted key — no SMTP setup required from the user
- Each email includes assigned tasks, meeting context, deadlines when known, and an optional "Install Cornflake" CTA
- Marks `comms.sent_at` on success; surfaces failures in a post-send status screen
- SendGrid API key lives on the backend only (not user-configurable). Rotate via deploy if compromised.

---

## Data Flow — End to End

```
Two entry points — both lead to the same pipeline:

PATH A: Manual start
User clicks "Start listening" in menu bar idle dropdown
        │
        ▼
Meeting created with default title; audio capture starts (Module 1)

PATH B: Calendar-triggered start (requires Google Calendar connected)
Calendar event detected (Module 2)
        │
        ▼
Pre-meeting toast notification fires 1 min before event
        │
        ▼
User clicks "Join meeting & start listening"
        │
        ▼
Meeting created with calendar title + attendee list; audio capture starts (Module 1)

--- Both paths converge here ---

        ▼
User clicks "Stop and review" in active recording dropdown
        │
        ▼
Audio streams written to temp files
        │
        ├──► Deepgram API call — transcription + diarisation (Module 3)
        │
        ▼
Raw transcript with anonymous speaker IDs
        │
        ▼
Speaker inference — voice profiles + context heuristics (Module 4)
  (elimination step skipped if no calendar attendee list available)
        │
        ├── All resolved → proceed to LLM extraction
        └── Unresolved speakers → show labelling interstitial → user labels → proceed
        │
        ▼
Named transcript
        │
        ├──► Task extraction (Module 5, parallel)
        ├──► Decision extraction (Module 5, parallel)
        ├──► Summary generation (Module 5, parallel)
        │
        ▼
Review screen rendered (React UI, Module 6 reads)
        │
        ▼
User reviews tasks — approves, dismisses, assigns to participants
        │
        ▼
tasks:confirm IPC — confirmed tasks saved; comms drafts generated (Module 5)
  LLM drafts one email per assignee from transcript context (/api/comms/draft)
  Drafts stored in comms table (sent_at = null) — nothing sent yet
        │
        ▼
User opens Comms tab — reviews/edits drafts, enters missing emails
        │
        ▼
User clicks "Send" — comms:send IPC (explicit approval)
        │
        ├──► SendGrid / push dispatch (Module 7) — only path that sends email
        ├──► comms.sent_at updated; sync to Supabase
        ├──► Voice profiles updated (Module 4 / Python sidecar)
        └──► Temp audio files deleted
```

---

## IPC Contract

All communication between main and renderer goes through named IPC channels. No direct DB access from renderer.

```typescript
// Main → Renderer
'meeting:upcoming'        payload: CalendarEvent
'recording:started'       payload: { meetingId: string, title: string }
'recording:speakerAdded'  payload: { speakerId: string, label: string }
'processing:complete'     payload: ReviewPayload
'comms:sent'              payload: { success: string[], failed: string[] }

// Renderer → Main
'recording:startManual'   payload: none                  -- quick-start, no calendar
'recording:stop'          payload: none
'recording:discard'       payload: none
'recording:updateTitle'   payload: { meetingId: string, title: string }
'tasks:confirm'           payload: { meetingId, confirmedTaskIds, dismissedTaskIds }  -- drafts comms; does NOT send
'comms:send'              payload: { meetingId }                                      -- approval gate; dispatches email
'speakers:label'          payload: SpeakerLabelMap
'profiles:update'         payload: SpeakerCorrections
'calendar:connect'        payload: none                  -- initiates OAuth flow
```

---

## Repository Structure

```
cornflake/
├── electron/
│   ├── main/
│   │   ├── index.ts                  # App entry, window management
│   │   ├── ipc/                      # IPC handlers (one file per channel group)
│   │   ├── modules/
│   │   │   ├── audio-capture/
│   │   │   ├── calendar-watcher/
│   │   │   ├── transcription/        # Deepgram client
│   │   │   ├── speaker-inference/
│   │   │   ├── llm/
│   │   │   │   ├── provider.ts       # LLMProvider interface
│   │   │   │   ├── claude.ts
│   │   │   │   ├── openai.ts
│   │   │   │   ├── grok.ts
│   │   │   │   └── index.ts          # Factory: reads LLM_PROVIDER env var
│   │   │   ├── database/
│   │   │   └── comms-dispatch/
│   │   └── sidecar/
│   │       └── spawn.ts              # Spawns and manages Python sidecar process
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── App.tsx
│           ├── components/
│           │   ├── MenuBar/
│           │   ├── ReviewScreen/
│           │   ├── TaskDetail/
│           │   ├── CommsTab/
│           │   └── SpeakerLabeller/  # Pre-review interstitial for unresolved speakers
│           └── hooks/                # useIPC, useMeeting, useTasks etc.
├── swift/
│   ├── CornflakeCapture/
│   │   ├── CornflakeCapture.swift    # SCStream setup, permission request, PCM callback
│   │   └── bridge.h                  # Obj-C bridging header for Node addon
│   └── binding.gyp                   # node-gyp build config for the native addon
├── python/
│   ├── sidecar.py                    # Entry point — JSON RPC over stdin/stdout
│   ├── voice_encoder.py              # resemblyzer wrapper
│   └── requirements.txt
├── llm.config.ts
├── .env.example
└── package.json
```

---

## Environment Variables

```
# LLM
LLM_PROVIDER=claude               # claude | openai | grok
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GROK_API_KEY=

# Deepgram
DEEPGRAM_API_KEY=

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Comms (Cornflake-hosted — not user-configurable)
SENDGRID_API_KEY=
SENDGRID_FROM_ADDRESS=hello@cornflake.app
```

---

## Build Order for MVP

Suggested sequence — each item is a bounded Claude Code session:

1. Electron scaffold + IPC skeleton (main + renderer wired, no logic)
2. Database layer — schema, migrations, typed query helpers
3. Calendar watcher — OAuth flow, polling, upcoming meeting event
4. Audio capture — Swift bridge + ScreenCaptureKit, dual stream capture, temp file output
5. Deepgram transcription pipeline — API client, utterance stitching
6. Speaker inference — Python sidecar, voice embedding RPC, context heuristics
7. LLM extraction — provider abstraction + all four extraction prompts
8. Review screen UI — React components, IPC hooks, task/comms tabs
9. Comms dispatch — email + push, post-send status
10. End-to-end wiring — connect all modules through the pipeline orchestrator

---

## Open Decisions

- **Deepgram data retention:** Confirm Deepgram's retention policy and reflect accurately in the in-app privacy disclosure. Do not guess.
