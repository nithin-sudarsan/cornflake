// Action Router — executes actions when the user taps "Do it" on a task.
// Action type classification is done by the LLM at extraction time (cornflake-api).

import { Notification, shell } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import { writeFile } from 'fs/promises'
import type { Task, ActionType } from '../database/types.js'
import { recordActionOutcome } from './mubit-client.js'

const execAsync = promisify(exec)

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
    task.actionType === 'CALENDAR'    ? '📅 Calendar' :
    task.actionType === 'REMINDER'    ? '🔔 Reminder' : ''

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
    case 'REMINDER':    return  // no automated action — user handles manually
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
