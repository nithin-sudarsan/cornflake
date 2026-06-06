// Action Router — classifies extracted tasks into EMAIL | CLAUDE_CODE | CALENDAR
// and executes the corresponding action when the user taps "Do it" on a notification.
//
// Classification uses keyword patterns. Mubit wraps the outcomes so the router
// learns over time which action types this team approves for which task patterns.

import { Notification, shell } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import { writeFile } from 'fs/promises'
import type { Task, ActionType } from '../database/types.js'
import { recordActionOutcome } from './mubit-client.js'

const execAsync = promisify(exec)

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

const CALENDAR_PATTERNS: RegExp[] = [
  /\b(schedule|book|set[\s-]?up|arrange|organise|organize)\b.*\b(meeting|call|sync|session|demo|review|standup|stand[\s-]?up)\b/i,
  /\b(meeting|call|sync|session|demo|review)\b.*\b(schedule|book|set[\s-]?up)\b/i,
  /\bfollow[\s-]?up\b.*\b(meeting|call|sync)\b/i,
  /\b(block|reserve)\b.*\b(time|slot|calendar)\b/i,
  /\b(reschedule|rescheduling)\b/i,
  /\bcalendar\b.*\b(invite|event|block)\b/i,
  /\b(set\s+a?\s*time|find\s+a?\s*time)\b/i,
]

const EMAIL_PATTERNS: RegExp[] = [
  /\bsend\b.*\b(email|e-mail|mail|message|follow[\s-]?up|note|update)\b/i,
  /\b(email|mail|message|follow[\s-]?up)\b.*\bto\b/i,
  /\bwrite\b.*\b(email|e-mail|mail|message)\b/i,
  /\breach[\s-]?out\b/i,
  /\bfollow[\s-]?up\b.*\b(with|on|to)\b/i,
  /\b(notify|inform|update|ping|loop[\s-]?in)\b.*\b(team|client|partner|stakeholder|vendor)\b/i,
  /\bsend\b.*\b[A-Z][a-z]+\b/,   // "send X to James", "send James the …"
  /\b(draft|compose)\b.*\b(email|e-mail|message)\b/i,
  /\bcc\b|\bbcc\b/i,
]

const CLAUDE_CODE_PATTERNS: RegExp[] = [
  /\b(implement|build|code|develop|write|create)\b.*\b(feature|function|module|api|service|component|endpoint|page|screen)\b/i,
  /\b(implement|build|develop)\b/i,
  /\b(fix|debug|resolve|patch)\b.*\b(bug|error|issue|crash|problem|regression)\b/i,
  /\b(refactor|clean[\s-]?up|rewrite)\b/i,
  /\b(deploy|release|ship|push|merge)\b.*\b(code|feature|update|version|branch|pr|pull\s+request)\b/i,
  /\bpull\s+request\b|\bcode\s+review\b|\bpr\s+review\b/i,
  /\b(write|add)\b.*\b(test|spec|unit\s+test|integration\s+test)\b/i,
  /\b(update|change|modify|edit)\b.*\b(code|function|class|schema|migration|config)\b/i,
  /\badd\b.*\b(auth|authentication|authorization|logging|tracking|analytics)\b/i,
]

export function classifyTaskAction(taskTitle: string): ActionType {
  for (const pattern of CALENDAR_PATTERNS) {
    if (pattern.test(taskTitle)) return 'CALENDAR'
  }
  for (const pattern of EMAIL_PATTERNS) {
    if (pattern.test(taskTitle)) return 'EMAIL'
  }
  for (const pattern of CLAUDE_CODE_PATTERNS) {
    if (pattern.test(taskTitle)) return 'CLAUDE_CODE'
  }
  // Default: EMAIL — most meeting follow-ups are communication-oriented.
  return 'EMAIL'
}

// ---------------------------------------------------------------------------
// Notification surface — one notification per task after a meeting ends
// ---------------------------------------------------------------------------

export function showTaskNotifications(tasks: Task[], meetingTitle: string): void {
  const actionable = tasks.filter(t => t.actionType != null)
  if (actionable.length === 0) return

  for (const task of actionable) {
    _showNotificationForTask(task, meetingTitle)
  }
}

function _showNotificationForTask(task: Task, meetingTitle: string): void {
  const actionLabel =
    task.actionType === 'EMAIL'       ? '📧 Email'    :
    task.actionType === 'CLAUDE_CODE' ? '💻 Code'     :
    task.actionType === 'CALENDAR'    ? '📅 Calendar' : ''

  const notif = new Notification({
    title: task.title,
    body: `${actionLabel} · from "${meetingTitle}"`,
    // macOS action buttons — fire the 'action' event when clicked
    actions: [
      { type: 'button', text: 'Do it' },
      { type: 'button', text: 'Dismiss' },
    ],
  })

  notif.on('action', (_, index) => {
    if (index === 0) {
      recordActionOutcome(task.id, task.title, task.actionType!, 'approved')
        .catch(err => console.warn('[action-router] mubit record failed:', err))
      executeAction(task).catch(err =>
        console.error('[action-router] executeAction failed:', err)
      )
    } else {
      recordActionOutcome(task.id, task.title, task.actionType!, 'dismissed')
        .catch(err => console.warn('[action-router] mubit record failed:', err))
    }
  })

  notif.show()
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

async function executeAction(task: Task): Promise<void> {
  switch (task.actionType) {
    case 'EMAIL':       return executeEmailAction(task)
    case 'CLAUDE_CODE': return executeClaudeCodeAction(task)
    case 'CALENDAR':    return executeCalendarAction(task)
  }
}

export async function executeTaskAction(taskId: string, taskTitle: string, actionType: ActionType): Promise<void> {
  await executeAction({ id: taskId, title: taskTitle, actionType } as Task)
  recordActionOutcome(taskId, taskTitle, actionType, 'approved')
}

// --- EMAIL ---

function _inferRecipientName(taskTitle: string): string {
  const m = taskTitle.match(/\bto\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/)
  return m ? m[1] : ''
}

async function executeEmailAction(task: Task): Promise<void> {
  const recipientName = _inferRecipientName(task.title)
  const subject = `Follow-up: ${task.title}`
  const greeting = recipientName ? `Hi ${recipientName},` : 'Hi,'
  const body = `${greeting}\n\n${task.title}\n\nBest,`

  const mailto =
    `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`

  await shell.openExternal(mailto).catch(err =>
    console.error('[action-router] mailto open failed:', err)
  )
}

// --- CLAUDE_CODE ---

async function executeClaudeCodeAction(task: Task): Promise<void> {
  const contextPath = '/tmp/cornflake-context.md'
  const lines = [
    '# Meeting Task Context',
    '',
    `**Task:** ${task.title}`,
  ]
  if (task.transcriptQuote) {
    lines.push('', '**Context from meeting:**', `> ${task.transcriptQuote}`)
  }
  if (task.deadlineText) {
    lines.push('', `**Deadline:** ${task.deadlineText}`)
  }
  lines.push('')

  await writeFile(contextPath, lines.join('\n'), 'utf8')

  // Write AppleScript to a temp file to avoid shell-escaping nightmares
  const scriptPath = '/tmp/cornflake-terminal.scpt'
  const script = [
    'tell application "Terminal"',
    '  activate',
    `  do script "claude " & quoted form of "${contextPath}"`,
    'end tell',
  ].join('\n')

  await writeFile(scriptPath, script, 'utf8')
  await execAsync(`osascript "${scriptPath}"`).catch(err =>
    console.error('[action-router] Terminal launch failed:', err)
  )
}

// --- CALENDAR ---

async function executeCalendarAction(task: Task): Promise<void> {
  // Escape double-quotes in the event title before embedding in AppleScript string
  const safeTitle = task.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const scriptPath = '/tmp/cornflake-calendar.scpt'
  const script = [
    'tell application "Calendar"',
    '  activate',
    '  set theDate to (current date) + (1 * days)',
    '  try',
    '    tell calendar 1',
    `      make new event at end with properties {summary:"${safeTitle}", start date:theDate, end date:theDate + 3600}`,
    '    end tell',
    '  end try',
    'end tell',
  ].join('\n')

  await writeFile(scriptPath, script, 'utf8')
  await execAsync(`osascript "${scriptPath}"`).catch(err => {
    console.error('[action-router] Calendar AppleScript failed:', err)
    // Fallback: just open Calendar.app so the user can create the event manually
    execAsync("open -a Calendar").catch(() => {})
  })
}
