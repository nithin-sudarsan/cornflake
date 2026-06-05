# Cornflake — Product Plan

## Overview

**Cornflake** is an AI-powered meeting accountability app for Mac and PC. It listens to any meeting (online or in-person), processes the conversation, and turns it into actionables — reminders, notes, and notifications to other participants. The name sits in the same breakfast/granola food namespace as Granola (the note-taking app it draws inspiration from), with the implicit contrast: Granola documents what was said; Cornflake makes sure it actually happens.

---

## Positioning

| | Granola | Cornflake |
|---|---|---|
| Core job | Remember what was said | Make sure it gets done |
| Output | Meeting notes | Actionables + reminders |
| Audience | Individual knowledge workers | Teams with shared commitments |
| Growth mechanic | Personal use | Viral — reminders sent to non-users prompt installs |

**Tagline idea:** "Granola remembers what was said. Cornflake makes sure it happens."

---

## How It Works (Core Flow)

1. **Meeting starts** — online (Zoom, Meet, Teams) or in-person
2. **Audio capture** — system audio + mic captured locally on Mac, invisible to other participants (same approach as Granola)
3. **Transcription + diarisation** — who said what, timestamped
4. **AI processing** — extracts tasks, decisions, and people mentioned
5. **Review screen** — user confirms, edits, or dismisses each item before anything is sent
6. **Outputs dispatched** — reminders set, notes saved, participants notified

The review screen is a non-negotiable trust layer. Nothing leaves the app without explicit user confirmation.

---

## MVP Scope

Three capabilities, no more, for v1.

### 1. Tasks (Reminders)
Inspired by iPhone Reminders — dead simple.

- AI extracts commitments and action items from the transcript
- Assigns an owner (speaker) and a deadline (if mentioned)
- Creates a reminder: title, time, done — no projects, priorities, or tags in v1
- Sends a push notification reminder to the owner at the right time
- Completion check-in optional stretch goal

**Design principle:** The AI does the complex extraction work. The UI should feel zero-friction.

---

### 2. Meeting Notes
- Auto-generated summary of the meeting with key points
- Decisions logged separately (not mixed into general notes)
- Editable by the user before any sharing happens
- Tied to the review screen — notes are reviewed at the same time as tasks and reminders

**Why editable matters:** Users will not trust AI-generated notes going to other people without a review window. The edit step also naturally drives app opens after every meeting.

---

### 3. Comms (Participant Notifications)
The growth engine of the app.

- Identifies participants (speakers in the transcript) and people mentioned by name
- After the host confirms tasks, the app **drafts** one email per assignee using meeting transcript context (not a fixed template)
- Host **reviews and edits** drafts in the Comms tab, fixes missing emails, and toggles who receives a message
- **Nothing is sent until the host explicitly approves** (Send button on the Comms tab)
- Message framing matters: should feel like a colleague sent it, not an automated notification. Example: *"John mentioned you'll send the brief by Friday — Cornflake is tracking it for him."*
- If the recipient doesn't have Cornflake installed, they receive an install invite alongside the reminder
- Every outbound notification to a non-user is a low-friction install prompt

**Privacy note:** Participants are notified only about items directly relevant to them — not the full transcript.

---

## Post-MVP Capabilities (Future Roadmap)

These were explored during planning but deliberately excluded from v1 to keep scope tight:

| Capability | Description |
|---|---|
| Scheduling (follow-up meetings) | AI detects follow-up meeting cues, pre-fills a calendar invite with attendees and title for one-tap Google Calendar booking |
| Task completion check-in | Follow up with owners before deadlines |
| Deadline calendar blocker | Auto-block focus time before a due date |
| Decision log search | Searchable history of all meeting decisions |
| Draft follow-up email | Auto-generate a recap email from notes |
| Jira / Linear integration | Push tasks directly to project management tools |
| CRM update | Update deal stages in Salesforce / HubSpot post-sales call |
| Slack / Notion push | Post notes or action items to team channels |
| Talk time analytics | Per-speaker breakdown across meetings |
| Recurring blocker detection | Surface patterns like "X blocks progress repeatedly" |
| Meeting health score | AI-rated meeting quality over time |
| Shared action board | Shared view of all open commitments from a meeting |

---

## Technical Constraints & Considerations

### Audio capture
- Must capture system audio + microphone locally on Mac (no bot joining the call)
- Works for any meeting tool (Zoom, Google Meet, Teams, in-person) because it captures at OS level
- Privacy-sensitive: local processing is a strong trust signal — be explicit about this to users

### Speaker diarisation
Identifying who said what is essential for correct task assignment. Cornflake uses a hybrid approach:

**Step 1 — Stream separation**
Mic input is always "You" — resolved immediately, no inference needed. System audio carries all remote speakers as a single mixed stream.

**Step 2 — Diarisation on system audio**
Standard diarisation (pyannote or similar) segments the system audio stream into Speaker A, Speaker B, Speaker C etc., timestamped but unnamed.

**Step 3 — Name inference from transcript context**
A lightweight pass over the transcript looks for:
- Direct address: "Thanks John, as you were saying..." → the preceding speaker segment is likely John
- Self-introduction: "Hi, I'm Sarah from..." → that segment is Sarah
- Elimination: if the calendar invite lists 3 remote attendees and diarisation finds 3 remote speakers, the third unmatched speaker is resolved by elimination
- Calendar attendee list used as a candidate set throughout

Each inferred assignment gets a confidence score. High-confidence inferences (direct address, self-intro) are treated as resolved. Low-confidence inferences (elimination, proximity heuristics) are flagged visibly in the review screen.

**Step 4 — User correction**
Low-confidence speaker assignments surface with an amber indicator on the task card and in Screen 3's "Assigned to" field. User can reassign with one tap before confirming. If no name could be inferred at all, the label stays as "Speaker A/B/C" and the user is prompted to label before proceeding — a "We couldn't identify some speakers" interstitial before the review screen, not a silent failure with wrong names on tasks.

**Step 5 — Voice profile learning**
Once the user confirms or corrects an assignment, that speaker's voice embedding is stored. On future meetings with the same person, inference is skipped entirely — they're identified directly.

### Confidence + review
- AI will sometimes misinterpret commitments — the review screen exists precisely for this
- Consider a confidence score on extracted items (show lower-confidence items differently in the UI)

### Google Calendar integration
- Required for pre-meeting detection (calendar read to trigger the "1 min before" notification)
- OAuth scope: calendar read only for v1
- Calendar write (for scheduling follow-up meetings) is post-MVP

### Comms / participant notifications
- Participants who don't have the app need a graceful invite experience
- The notification copy is critical — it must feel human, not automated
- Consider: SMS or email for non-app users, push notification for app users

### Platform
- Mac-first (following Granola's approach)
- iOS companion app likely needed for receiving reminders on the go
- Android out of scope for v1

---

## Naming

**Cornflake** — chosen from the breakfast/health-food namespace that Granola occupies. Rationale:

- Same product family feel as Granola (both are cereal, both are familiar)
- Cornflakes are *processed* grain — the app *processes* conversations into structure
- Warm, friendly, memorable — appropriate for a productivity tool that nudges people
- Ownable as one word (`cornflake`) as a tech brand
- Potential short form: **Flake** for the logo / icon mark
- Colour palette: warm yellows, ambers, creamy whites — distinct from Granola's earthy greens
- Trademark note: Kellogg's owns "Corn Flakes" (two words) as a food brand; "Cornflake" as a single-word tech product should be clear, but verify before launch

---

## Key Design Principles

1. **Invisible during the meeting** — no bot joining, no interruption, no indicator to other participants
2. **Nothing sent without review** — the review screen is mandatory before any output is dispatched
3. **Human-feeling notifications** — outbound messages read like a colleague sent them, not an AI
4. **Zero-friction task UI** — the AI does the heavy lifting; the user interface stays simple
5. **Privacy first** — local audio processing, participants only notified about items relevant to them
6. **Growth through utility** — every reminder sent to a non-user is an organic install prompt

---

## Wireframes (Low-fi, Electron App)

Four screens designed. Platform: Electron (Mac/PC). Fidelity: low-fi, grayscale. Note: Schedule tab (Screen 5) is post-MVP and no longer in scope.

---

### Screen 1 — Menu bar indicator (three states)

![[Pasted image 20260513215725.png]]

The entry point. Cornflake lives in the Mac menu bar.

**State A: Idle (menu bar dropdown, no active recording)**
- Clicking the menu bar icon when no recording is active opens a dropdown with:
  - "Start listening" — begins recording immediately with a default title ("Meeting, [time]"), editable after
  - If Google Calendar is connected: upcoming meetings listed below as quick-start items
  - "Connect Google Calendar" link if not yet connected (optional, skippable)
- This is the zero-setup entry point — works on day one with no calendar integration

**State B: Pre-meeting notification (fires 1 min before a calendar event)**
- Only fires if Google Calendar is connected
- A toast notification appears in the top-right corner, below the menu bar
- Shows meeting name, time range, and "in 1 minute"
- Primary CTA: "Join meeting & start listening" — opens the meeting link AND starts Cornflake recording in one tap
- Secondary action: "Skip this meeting" — escape hatch, no recording starts

**State C: Active recording (menu bar dropdown)**
- Menu bar icon shows a green dot + "cornflake" label while listening
- Clicking opens a small dropdown panel showing:
  - Meeting name (editable inline) + elapsed timer
  - Speakers detected (live-updating pills as new voices are identified)
  - Three actions: "Stop and review" (primary), "Pause recording", "Discard recording" (red, destructive)
- "Stop and review" leads to Screen 2

**Design decisions:**
- Calendar integration is additive — the app is fully functional without it
- "Start listening" from the idle dropdown is the manual quick-start, equivalent to Granola's Quick Note
- Meeting title defaults to "Meeting, [time]" on manual start; user can rename inline during or after recording
- Green dot in menu bar is the only visual indicator while a meeting is active — intentionally subtle

---

### Screen 2 — Post-meeting review screen

![[Pasted image 20260513215804.png]]

The central hub of the app. A two-column Electron window that opens after "Stop and review".

**Left column — tabbed actions:**
- Two tabs: Tasks (default), Comms — each with a badge count
- Tasks tab shows extracted action items as a list of cards, each with:
  - Empty circle (pending) or ticked circle (confirmed)
  - Task title, assigned speaker, deadline
  - Amber "No deadline detected" warning where applicable
  - Edit pencil icon — opens Screen 3
- "+ Add task manually" link at the bottom of the list
- "Dismiss all" (bottom left) and "Confirm tasks" (bottom right) — saves task decisions and **drafts** comms messages (does not send email)

**Right column — meeting notes (always visible):**
- Persistent across both tabs — always in view for reference
- Sections: Summary (prose), Decisions (checkmark list), Participants (avatar pills)
- Edit pencil in header for inline editing
- "View full transcript" link at the bottom

**Key principle:** Nothing is dispatched until the host taps **Send** on the Comms tab. Confirming tasks only stages drafts; the left column is a review area for both tabs.

---

### Screen 3 — Task detail / edit

![[Pasted image 20260513215840.png]]

Opens from the edit pencil on any task card. A narrower modal-style panel.

**Components:**
- Back to review (top left) / Remove task (top right, red)
- Quoted transcript snippet — shows the exact sentence the AI used to extract this task. Builds trust, makes editing feel informed
- Task title — editable text input
- Assigned to — participant pills (all meeting speakers shown), tap to reassign
- Deadline — text input with calendar picker + quick-pick buttons: Tomorrow, This Friday, Next week, No deadline. Amber "Not detected" badge when AI found no deadline
- Remind — dropdown: On the day (9am), 1 day before, 2 days before, 1 hour before, At deadline time
- Note (optional) — free text for adding context to the recipient's notification
- Footer: Cancel / Save task

**Design decisions:**
- Showing the source transcript quote is non-negotiable — it's what separates trustworthy AI from a black box
- Quick-pick deadline buttons cover ~90% of real cases; full date picker is the edge case escape hatch
- The Note field is how the host adds human context to what the recipient receives

---

### Screen 4 — Comms tab (inside review screen)

![[Pasted image 20260513215939.png]]

Accessed via the Comms tab on Screen 2. Same two-column layout.

**Left column — participant notification cards:**
- Intro banner: "Drafts were generated from your meeting. Review and edit before sending."
- Drafts appear after **Confirm tasks** on the Tasks tab (`POST /api/comms/draft` on the backend)
- One card per participant who has tasks assigned, showing:
  - Avatar + name
  - App status: green "Has Cornflake" or amber "No Cornflake — will get invite"
  - Send checkbox (checked by default, can uncheck to skip a participant)
  - Message preview — shows exactly what the recipient will receive, with task and meeting name bolded. Reads like a colleague wrote it, not an automated system
  - "Edit message" link for copy tweaks
- For non-app users: an "Install Cornflake invite included" pill appears inside their message preview
- Delivery channel selector (global for the meeting): Push notification / Email / Both
- Footer: **Send** (primary) — explicit approval gate; calls `comms:send` and only then hits SendGrid / push

**Key principles:**
- Each participant only sees their own tasks — not the full list or other people's items
- Non-app users receive the reminder + an install invite — this is the passive growth mechanic
- Message preview is always visible before anything is sent — no surprises
- Delivery channel is a global setting per meeting (per-participant channel is a post-MVP consideration)

---

## Open Questions

Some resolved during wireframing, some still open:

**Resolved:**
- Comms delivery: Push notification for app users, email for non-app users, with a "Both" option. Per-meeting global setting, not per-participant.
- Review screen timing: Triggered when user clicks "Stop and review" from the menu bar dropdown — not automatic.
- Comms copy: Messages are **drafted by AI from transcript context** after task confirm, editable before sending. Each recipient only sees their own tasks. Send requires a separate explicit action on the Comms tab.
- **Calendar integration:** Optional, not required. App is fully functional without it. When connected (Google Calendar, OAuth read-only), unlocks: pre-meeting notifications 1 min before events, automatic meeting title, and attendee list as candidate set for speaker inference. When not connected, user starts recording manually via "Start listening" in the menu bar dropdown.
- **Auto-start recording:** No auto-start in either mode. Calendar-connected users get a notification prompt 1 min before; manual users click "Start listening" themselves.
- **Offline/in-person meetings:** Plain tasks based on the transcript. No participants or routing/assigning it to others automatically. Although user must be able to add email id of the person who the reminder/task should be routed to and then send it.
- **Confidence thresholds:** Show some of them with low confidence at the bottom.
- **Non-app participant contact details:** Either pull from calendar invite attendees or user must be able to add their email manually to later share.
- **Speaker identification:** Hybrid approach — mic/system audio split resolves "You" immediately; diarisation + transcript context inference (direct address, self-intro, elimination against calendar attendees) names remote speakers with confidence scoring; low-confidence assignments flagged amber for user correction in the review screen; voice embeddings stored after first correction so repeat speakers are identified automatically in future meetings. Degraded state: unresolved speakers labelled Speaker A/B/C with a pre-review prompt asking the user to label them manually.

**Still open:**