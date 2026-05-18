# Cornflake — Data Model

## Purpose

This document defines the SQLite schema in full, with example rows, edge cases, and the query patterns used by each module. No module accesses the DB directly except the database layer (`electron/main/modules/database/`). All other modules call typed query helpers defined here.

---

## Schema

### `meetings`

One row per recorded meeting.

```sql
CREATE TABLE meetings (
  id                       TEXT PRIMARY KEY,   -- uuid v4
  title                    TEXT NOT NULL,
  start_ms                 INTEGER NOT NULL,   -- unix ms
  end_ms                   INTEGER,            -- null while recording is active
  calendar_event_id        TEXT,               -- null for in-person / manual starts
  requires_manual_labelling INTEGER NOT NULL DEFAULT 0,  -- 1 if any speaker unresolved post-inference
  summary                  TEXT,               -- LLM-generated, null until extraction complete
  confirmed_at             INTEGER,            -- null until user hits "Confirm & send"
  created_at               INTEGER NOT NULL
);
```

**Example rows:**

| id | title | start_ms | end_ms | calendar_event_id | requires_manual_labelling | confirmed_at |
|---|---|---|---|---|---|---|
| `m_01` | Weekly product sync | 1747130460000 | 1747133280000 | `gcal_abc123` | 0 | 1747133350000 |
| `m_02` | In-person standup | 1747216800000 | 1747218000000 | null | 1 | null |

**Notes:**
- `end_ms` is null while recording is active. Set on "Stop and review".
- `calendar_event_id = null` means the meeting was started manually — no attendee list, title defaults to "Meeting, HH:MM".
- `requires_manual_labelling = 1` triggers the speaker labelling interstitial before the review screen renders.
- `confirmed_at` being null means the meeting is in draft — nothing has been dispatched.

---

### `speakers`

One row per identified speaker per meeting. "You" always gets a row with `is_self = 1`.

```sql
CREATE TABLE speakers (
  id                TEXT PRIMARY KEY,           -- uuid v4
  meeting_id        TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  deepgram_id       TEXT,                       -- e.g. "0", "1" — null for self
  name              TEXT,                       -- null if unresolved after inference
  email             TEXT,                       -- null until pulled from calendar or entered manually
  is_self           INTEGER NOT NULL DEFAULT 0,
  confidence        TEXT,                       -- 'high' | 'medium' | 'low' | 'manual' | null for self
  has_cornflake     INTEGER NOT NULL DEFAULT 0, -- updated at comms dispatch time
  created_at        INTEGER NOT NULL
);
```

**Example rows:**

| id | meeting_id | deepgram_id | name | email | is_self | confidence |
|---|---|---|---|---|---|---|
| `sp_01` | `m_01` | null | You | nithin@basegraph.co | 1 | null |
| `sp_02` | `m_01` | `0` | Sarah | sarah@acme.com | 0 | `high` |
| `sp_03` | `m_01` | `1` | John | null | 0 | `medium` |
| `sp_04` | `m_02` | `0` | null | null | 0 | null |

**Notes:**
- `sp_04` is an unresolved speaker — `name` is null, `confidence` is null. This triggers `requires_manual_labelling = 1` on the meeting.
- `email` is populated from the calendar invite attendees list where available. If not found, it stays null until the user enters it manually in the Comms tab.
- `confidence` values: `high` = voice profile match or self-introduction; `medium` = direct address inference; `low` = elimination; `manual` = user labelled.

---

### `utterances`

Every diarised segment from the transcript. Used to render the full transcript view and to surface transcript quotes on task cards.

```sql
CREATE TABLE utterances (
  id           TEXT PRIMARY KEY,          -- uuid v4
  meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker_id   TEXT NOT NULL REFERENCES speakers(id),
  text         TEXT NOT NULL,
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
```

**Example rows:**

| id | meeting_id | speaker_id | text | start_ms | end_ms |
|---|---|---|---|---|---|
| `u_01` | `m_01` | `sp_01` | "Let's push the payments feature to Q4." | 1747130520000 | 1747130528000 |
| `u_02` | `m_01` | `sp_02` | "Sarah can you review the Q3 roadmap doc before our next sync?" | 1747130530000 | 1747130537000 |
| `u_03` | `m_01` | `sp_03` | "I'll get sign-off from legal on the contract by Friday." | 1747130540000 | 1747130547000 |

**Notes:**
- Utterances are immutable after the pipeline writes them — never updated, only read.
- `transcript_quote` on tasks references the `text` of the utterance the LLM used for extraction. Stored as a copy on the task (not a foreign key) so it survives any future utterance cleanup.

---

### `tasks`

One row per extracted or manually added action item.

```sql
CREATE TABLE tasks (
  id                   TEXT PRIMARY KEY,        -- uuid v4
  meeting_id           TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  assignee_speaker_id  TEXT REFERENCES speakers(id),
  title                TEXT NOT NULL,
  deadline_text        TEXT,                    -- raw text from transcript e.g. "Friday", "by EOD"
  deadline_ms          INTEGER,                 -- resolved unix ms; null if not detected or "No deadline"
  remind_offset_ms     INTEGER NOT NULL DEFAULT -3600000,  -- default: 1 hour before (-3600000ms)
  transcript_quote     TEXT,                    -- source utterance text; null for manually added tasks
  extraction_confidence TEXT,                   -- 'high' | 'medium' | 'low'; null for manual
  status               TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'confirmed' | 'dismissed'
  note                 TEXT,                    -- optional context added by meeting host
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
```

**Example rows:**

| id | meeting_id | assignee_speaker_id | title | deadline_text | deadline_ms | status | extraction_confidence |
|---|---|---|---|---|---|---|---|
| `t_01` | `m_01` | `sp_01` | Send updated brief to the team | "Tomorrow, 5pm" | 1747213200000 | `confirmed` | `high` |
| `t_02` | `m_01` | `sp_02` | Review Q3 roadmap doc | null | null | `pending` | `medium` |
| `t_03` | `m_01` | `sp_03` | Get sign-off from legal on contract | "Friday" | 1747440000000 | `pending` | `high` |
| `t_04` | `m_01` | `sp_02` | Follow up on design mockups | null | null | `pending` | `low` |

**Notes:**
- `deadline_text` stores the raw string from the transcript. `deadline_ms` is the resolved timestamp after LLM date parsing. If the LLM cannot resolve a date, `deadline_ms` is null and the amber "No deadline detected" warning shows.
- `remind_offset_ms` is negative — it means "fire reminder N ms before the deadline." Default `-3600000` = 1 hour before. "On the day (9am)" is stored as a positive absolute time, not an offset — handle this as a special case: `remind_offset_ms = null` with a separate `remind_at_ms` column, or encode as a sentinel value. **Decision: add `remind_at_ms INTEGER` for absolute reminders; use `remind_offset_ms` for relative ones. Exactly one should be non-null.**
- `extraction_confidence` is separate from speaker assignment confidence. A task can be high-confidence in extraction but assigned to a low-confidence speaker.
- `status = 'dismissed'` means the user removed it from the review screen. Kept in DB for audit; never dispatched.

**Schema amendment — reminder timing:**

```sql
-- Add to tasks table
remind_at_ms         INTEGER,   -- absolute unix ms; used when user picks "On the day (9am)"
-- Constraint: exactly one of remind_offset_ms or remind_at_ms should be non-null post-confirmation
```

---

### `decisions`

Meeting-level decisions extracted by the LLM. Displayed in the right column of the review screen.

```sql
CREATE TABLE decisions (
  id          TEXT PRIMARY KEY,   -- uuid v4
  meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
```

**Example rows:**

| id | meeting_id | text |
|---|---|---|
| `d_01` | `m_01` | Payments feature moved to Q4 |
| `d_02` | `m_01` | Sarah owns roadmap doc going forward |

---

### `comms`

One row per outbound message — one per assignee per meeting (not per task). A single message to Sarah covers all her tasks from that meeting.

```sql
CREATE TABLE comms (
  id                    TEXT PRIMARY KEY,       -- uuid v4
  meeting_id            TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  recipient_speaker_id  TEXT NOT NULL REFERENCES speakers(id),
  message_body          TEXT NOT NULL,          -- LLM-generated, editable before send
  delivery_channel      TEXT NOT NULL DEFAULT 'push',  -- 'push' | 'email' | 'both'
  recipient_email       TEXT,                   -- null if push-only recipient
  has_cornflake         INTEGER NOT NULL DEFAULT 0,
  include_install_invite INTEGER NOT NULL DEFAULT 0,  -- 1 if recipient has no Cornflake
  send                  INTEGER NOT NULL DEFAULT 1,   -- 0 if user unchecked "Send" for this recipient
  sent_at               INTEGER,                -- null until dispatched
  send_error            TEXT,                   -- null on success; error message on failure
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
```

**Example rows:**

| id | meeting_id | recipient_speaker_id | delivery_channel | has_cornflake | include_install_invite | send | sent_at |
|---|---|---|---|---|---|---|---|
| `c_01` | `m_01` | `sp_02` | `push` | 1 | 0 | 1 | 1747133360000 |
| `c_02` | `m_01` | `sp_03` | `email` | 0 | 1 | 1 | null |

**Notes:**
- `message_body` is generated once by the LLM and then editable by the user before dispatch. The edited version is what gets stored and sent.
- `send = 0` means the user unchecked this recipient. Row kept in DB but never dispatched.
- `send_error` is populated if SendGrid or push notification fails. The post-send status screen reads this to surface failures.
- `include_install_invite = 1` appends the Cornflake install CTA to the email body at send time.

---

### `voice_profiles`

Persistent speaker voice embeddings, keyed by name. Shared across meetings — not meeting-scoped.

```sql
CREATE TABLE voice_profiles (
  id           TEXT PRIMARY KEY,   -- uuid v4
  name         TEXT NOT NULL UNIQUE,
  email        TEXT,               -- stored if known, used to pre-fill speaker email in future meetings
  embedding    BLOB NOT NULL,      -- float32 array serialised to bytes (256-dim resemblyzer embedding)
  sample_count INTEGER NOT NULL DEFAULT 1,  -- number of confirmed samples this embedding is built from
  updated_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
```

**Example rows:**

| id | name | email | sample_count | updated_at |
|---|---|---|---|---|
| `vp_01` | Sarah | sarah@acme.com | 4 | 1747133360000 |
| `vp_02` | John | null | 1 | 1747133360000 |

**Notes:**
- `embedding` is written by the Python sidecar after the user confirms a speaker assignment. On subsequent meetings, the sidecar compares new audio segments against stored embeddings using cosine similarity.
- `sample_count` tracks how many confirmed meetings have contributed to this embedding. The sidecar averages embeddings across samples — recognition accuracy improves over time.
- `email` here is the canonical email for this person. When a new meeting is processed and Sarah is identified, her email is pre-filled from `voice_profiles` if not already in the calendar invite.

---

## Typed Query Helpers

These are the queries each module needs. All implemented in `electron/main/modules/database/queries.ts`.

### Meeting queries

```typescript
// Create a new meeting record when recording starts
createMeeting(title: string, calendarEventId?: string): Meeting

// Set end time when user stops recording
finalizeMeeting(meetingId: string, endMs: number): void

// Update meeting title (user edits inline during or after recording)
updateMeetingTitle(meetingId: string, title: string): void

// Mark meeting as confirmed (post "Confirm & send")
confirmMeeting(meetingId: string): void

// Fetch full meeting with all related data for the review screen
getMeetingReviewPayload(meetingId: string): ReviewPayload
// Returns: meeting + speakers + utterances + tasks + decisions + comms
```

### Speaker queries

```typescript
// Insert speakers after diarisation — one row per deepgram speaker ID + one for self
createSpeakers(meetingId: string, deepgramIds: string[]): Speaker[]

// Update speaker name and confidence after inference
resolveSpeaker(speakerId: string, name: string, confidence: Confidence): void

// Bulk update after user completes manual labelling interstitial
bulkResolveSpeakers(resolutions: { speakerId: string, name: string, email?: string }[]): void

// Fetch all speakers for a meeting
getSpeakersByMeeting(meetingId: string): Speaker[]
```

### Task queries

```typescript
// Bulk insert tasks after LLM extraction
createTasks(tasks: NewTask[]): Task[]

// Update a task after user edits in Screen 3
updateTask(taskId: string, updates: Partial<Task>): Task

// Confirm a task (ticked circle in review screen)
confirmTask(taskId: string): void

// Dismiss a task
dismissTask(taskId: string): void

// Fetch all pending + confirmed tasks for review screen
getTasksByMeeting(meetingId: string): Task[]

// Fetch tasks assigned to a speaker (used for comms generation)
getTasksBySpeaker(meetingId: string, speakerId: string): Task[]
```

### Comms queries

```typescript
// Bulk insert comms records after LLM copy generation
createComms(comms: NewComm[]): Comm[]

// Update message body after user edits in Comms tab
updateCommMessage(commId: string, messageBody: string): void

// Toggle send flag
setCommSend(commId: string, send: boolean): void

// Mark as sent
markCommSent(commId: string): void

// Mark as failed
markCommFailed(commId: string, error: string): void

// Fetch all comms for a meeting
getCommsByMeeting(meetingId: string): Comm[]
```

### Voice profile queries

```typescript
// Fetch all embeddings (passed to Python sidecar at inference time)
getAllVoiceProfiles(): VoiceProfile[]

// Upsert after user confirms a speaker — Python sidecar computes updated embedding
upsertVoiceProfile(name: string, email: string | null, embedding: Buffer): void
```

---

## Key Joins

### Review screen payload

The review screen needs everything in one shot. This is the primary read query — called once after processing completes.

```sql
SELECT
  m.*,
  json_group_array(DISTINCT json_object(
    'id', s.id, 'name', s.name, 'email', s.email,
    'is_self', s.is_self, 'confidence', s.confidence, 'has_cornflake', s.has_cornflake
  )) AS speakers,
  json_group_array(DISTINCT json_object(
    'id', t.id, 'title', t.title, 'assignee_speaker_id', t.assignee_speaker_id,
    'deadline_text', t.deadline_text, 'deadline_ms', t.deadline_ms,
    'transcript_quote', t.transcript_quote, 'extraction_confidence', t.extraction_confidence,
    'status', t.status, 'note', t.note
  )) AS tasks,
  json_group_array(DISTINCT json_object(
    'id', d.id, 'text', d.text
  )) AS decisions,
  json_group_array(DISTINCT json_object(
    'id', c.id, 'recipient_speaker_id', c.recipient_speaker_id,
    'message_body', c.message_body, 'delivery_channel', c.delivery_channel,
    'has_cornflake', c.has_cornflake, 'include_install_invite', c.include_install_invite,
    'send', c.send
  )) AS comms
FROM meetings m
LEFT JOIN speakers s ON s.meeting_id = m.id
LEFT JOIN tasks t ON t.meeting_id = m.id
LEFT JOIN decisions d ON d.meeting_id = m.id
LEFT JOIN comms c ON c.meeting_id = m.id
WHERE m.id = ?
GROUP BY m.id;
```

### Comms dispatch query

Fetch everything needed to send notifications — run at "Confirm & send".

```sql
SELECT
  c.*,
  s.name AS recipient_name,
  s.email AS recipient_email,
  s.has_cornflake,
  json_group_array(json_object(
    'title', t.title,
    'deadline_text', t.deadline_text
  )) AS tasks
FROM comms c
JOIN speakers s ON s.id = c.recipient_speaker_id
JOIN tasks t ON t.assignee_speaker_id = s.id AND t.meeting_id = c.meeting_id AND t.status = 'confirmed'
WHERE c.meeting_id = ?
  AND c.send = 1
  AND c.sent_at IS NULL
GROUP BY c.id;
```

---

## Edge Cases

**Manual-start meeting with no calendar event**
- `calendar_event_id` is null on the meeting row
- No attendee list available — elimination inference step is skipped entirely
- Only voice profile matching and transcript context patterns (self-intro, direct address) are used
- Higher chance of unresolved speakers — `requires_manual_labelling = 1` is the common case for first-time meetings with new participants
- Speaker emails must be entered manually in the Comms tab before dispatch

**Speaker with no tasks**
- Speaker row exists; no task rows reference their `id`
- No comms row is created for them — they receive nothing
- They still appear in the Participants section of meeting notes (right column)

**Task with no assignee**
- `assignee_speaker_id` is null — happens if LLM extracts a task but cannot infer ownership
- Rendered in the review screen with "Unassigned" and an amber warning
- User must assign before confirming — "Confirm & send" blocked if any confirmed task has null assignee

**Comms send failure**
- `sent_at` remains null; `send_error` is populated
- Post-send status screen shows the failed recipient with a "Retry" option
- Retry re-reads the comms row and re-attempts dispatch — does not create a new row

**Same person in multiple meetings**
- `voice_profiles` is shared across meetings; `speakers` is per-meeting
- On a new meeting, a new `speakers` row is created. After inference resolves the name, their `voice_profiles.email` pre-fills the speaker's email on the new row.
- `sample_count` on the voice profile increments each time they are confirmed — embedding improves over time

**User edits a task assignee in Screen 3**
- `tasks.assignee_speaker_id` is updated
- The comms row for the original assignee may need to be regenerated — if the task was the only task for that speaker, their comms row should be removed
- If the new assignee already has a comms row (they have other tasks), the message body is regenerated via LLM to include the newly assigned task
- **Query helper needed:** `regenerateCommsForMeeting(meetingId)` — drops and recreates all unsent comms rows based on current confirmed task assignments

---

## TypeScript Types

```typescript
type Confidence = 'high' | 'medium' | 'low' | 'manual'
type TaskStatus = 'pending' | 'confirmed' | 'dismissed'
type DeliveryChannel = 'push' | 'email' | 'both'

interface Meeting {
  id: string
  title: string
  startMs: number
  endMs: number | null
  calendarEventId: string | null
  requiresManualLabelling: boolean
  summary: string | null
  confirmedAt: number | null
  createdAt: number
}

interface Speaker {
  id: string
  meetingId: string
  deepgramId: string | null
  name: string | null
  email: string | null
  isSelf: boolean
  confidence: Confidence | null
  hasCornflake: boolean
  createdAt: number
}

interface Utterance {
  id: string
  meetingId: string
  speakerId: string
  text: string
  startMs: number
  endMs: number
  createdAt: number
}

interface Task {
  id: string
  meetingId: string
  assigneeSpeakerId: string | null
  title: string
  deadlineText: string | null
  deadlineMs: number | null
  remindOffsetMs: number | null
  remindAtMs: number | null
  transcriptQuote: string | null
  extractionConfidence: Confidence | null
  status: TaskStatus
  note: string | null
  createdAt: number
  updatedAt: number
}

interface Decision {
  id: string
  meetingId: string
  text: string
  createdAt: number
}

interface Comm {
  id: string
  meetingId: string
  recipientSpeakerId: string
  messageBody: string
  deliveryChannel: DeliveryChannel
  recipientEmail: string | null
  hasCornflake: boolean
  includeInstallInvite: boolean
  send: boolean
  sentAt: number | null
  sendError: string | null
  createdAt: number
  updatedAt: number
}

interface VoiceProfile {
  id: string
  name: string
  email: string | null
  embedding: Buffer
  sampleCount: number
  updatedAt: number
  createdAt: number
}

// Composite type returned by getMeetingReviewPayload
interface ReviewPayload {
  meeting: Meeting
  speakers: Speaker[]
  tasks: Task[]
  decisions: Decision[]
  comms: Comm[]
}
```

---

## Migration Strategy

Migrations live in `electron/main/modules/database/migrations/`. Each migration is a numbered SQL file: `001_initial_schema.sql`, `002_add_remind_at_ms.sql` etc.

On app start, the database layer runs pending migrations in order. Schema version tracked in a `_meta` table:

```sql
CREATE TABLE _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO _meta VALUES ('schema_version', '0');
```

Never modify an existing migration file. Always add a new one.
