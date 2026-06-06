import { getDb } from '../database/index.js'
import { LLM_MODEL } from '../../llm.config.js'
import { apiPost } from '../api-client/index.js'
import { getGoogleAccessToken, getGoogleRefreshToken, storeGoogleAccessToken } from '../auth/index.js'
import { recallCalendarPreference, recallContact } from '../action-router/mubit-client.js'
import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { execFile } from 'child_process'
import { writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Shared Google OAuth2 client (mirrors calendar-watcher pattern)
// ---------------------------------------------------------------------------

async function loadGoogleAuth(): Promise<OAuth2Client | null> {
  const accessToken = await getGoogleAccessToken()
  if (!accessToken) return null
  const auth = new google.auth.OAuth2()
  auth.setCredentials({ access_token: accessToken })
  return auth
}

async function refreshGoogleAuth(): Promise<OAuth2Client | null> {
  const refreshToken = await getGoogleRefreshToken()
  if (!refreshToken) return null
  const backend = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '')
  try {
    const res = await fetch(`${backend}/api/auth/google-refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) return null
    const { accessToken } = await res.json() as { accessToken?: string }
    if (!accessToken) return null
    await storeGoogleAccessToken(accessToken)
    const auth = new google.auth.OAuth2()
    auth.setCredentials({ access_token: accessToken })
    return auth
  } catch {
    return null
  }
}

// Retry once with refreshed token on 401
async function withGoogleAuth<T>(fn: (auth: OAuth2Client) => Promise<T>): Promise<T> {
  let auth = await loadGoogleAuth()
  if (!auth) throw new Error('Not signed in to Google. Please reconnect your Google account.')
  try {
    return await fn(auth)
  } catch (err: any) {
    const status = err?.response?.status ?? err?.status ?? err?.code
    if (status === 401 || status === 403) {
      auth = await refreshGoogleAuth()
      if (!auth) throw new Error('Google session expired. Please reconnect Google in settings.')
      return await fn(auth)
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// ~/.claude/projects helpers — identify repo and load conversation history
// ---------------------------------------------------------------------------

interface ClaudeProject {
  dirName:  string        // e.g. "-Users-dheer-Developer-hackathons-cornflake"
  repoPath: string | null // decoded absolute path (null if path no longer exists)
  label:    string        // last path segment, for display
}

export function listClaudeProjects(): ClaudeProject[] {
  const claudeDir = join(homedir(), '.claude', 'projects')
  if (!existsSync(claudeDir)) return []
  return readdirSync(claudeDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      // Claude encodes absolute paths by replacing every '/' with '-'
      // So -Users-foo-bar → /Users/foo/bar
      const candidate = d.name.replace(/-/g, '/')
      const repoPath  = existsSync(candidate) ? candidate : null
      const label     = repoPath
        ? (repoPath.split('/').at(-1) ?? d.name)
        : d.name
      return { dirName: d.name, repoPath, label }
    })
}

function getLatestJsonlPath(dirName: string): string | null {
  const dir = join(homedir(), '.claude', 'projects', dirName)
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
  if (!files.length) return null
  return join(
    dir,
    files.sort((a, b) =>
      statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs,
    )[0],
  )
}

// Read the first entry with a cwd field — that's the repo root Claude was running in.
function extractCwdFromJsonl(jsonlPath: string): string | null {
  const lines = readFileSync(jsonlPath, 'utf8').split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as { cwd?: string }
      if (typeof entry.cwd === 'string' && entry.cwd) return entry.cwd
    } catch { /* skip */ }
  }
  return null
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface EmailDraft {
  toName: string
  toEmail: string
  subject: string
  body: string
}

export interface CalendarDraft {
  title: string
  dateIso: string
  time: string
  durationMin: number
  description: string
}

export interface CodeDraft {
  contextMd:        string
  claudeProjectDir: string | null  // dir name inside ~/.claude/projects/
}

export interface ChatResponse {
  message: string
  emailDraft: EmailDraft | null
  calendarDraft: CalendarDraft | null
  codeDraft: CodeDraft | null
}

// ---------------------------------------------------------------------------
// AI chat
// ---------------------------------------------------------------------------

export async function chatForAction(
  taskTitle: string,
  actionType: 'EMAIL' | 'CALENDAR' | 'CLAUDE_CODE',
  meetingId: string,
  messages: ChatMessage[],
): Promise<ChatResponse> {
  const db = getDb()
  const detail = db.getMeetingDetail(meetingId)

  // Enrich speakers missing an email via Mubit contact-resolver before building the prompt
  const speakerContext = (
    await Promise.all(
      (detail?.speakers ?? []).map(async s => {
        const sp = s as { id: string; name: string | null; isSelf: boolean; email?: string }
        let email = sp.email ?? null
        if (!sp.isSelf && !email && sp.name) {
          email = await recallContact(sp.name).catch(() => null)
        }
        const emailPart = email ? ` <${email}>` : ''
        return `- ${sp.name ?? 'Unknown'}${emailPart} (${sp.isSelf ? 'you' : 'remote participant'})`
      }),
    )
  ).join('\n')

  const transcriptContext = (detail?.utterances ?? [])
    .slice(0, 40)
    .map(u => `${u.speakerName ?? 'Speaker'}: ${u.text}`)
    .join('\n')

  const today = new Date().toISOString().slice(0, 10)

  // For EMAIL actions: use LLM to extract person names from the task title, then recall emails from Mubit
  let knownRecipientEmail: string | null = null
  if (actionType === 'EMAIL') {
    try {
      const nameResult = await apiPost('/api/ai/messages', {
        model: LLM_MODEL.claude,
        max_tokens: 30,
        system: 'Extract the person\'s name from this email task. Reply with the name only, or "none" if no person is mentioned.',
        messages: [{ role: 'user', content: taskTitle }],
      }) as { content?: Array<{ type: string; text: string }> }
      const extractedName = nameResult.content?.find(b => b.type === 'text')?.text?.trim() ?? ''
      console.log(`[action-chat] extracted name from title "${taskTitle}" →`, JSON.stringify(extractedName))
      if (extractedName && extractedName.toLowerCase() !== 'none') {
        knownRecipientEmail = await recallContact(extractedName).catch(() => null)
        console.log(`[action-chat] knownRecipientEmail for "${extractedName}" →`, knownRecipientEmail)
      }
    } catch (err) {
      console.warn('[action-chat] name extraction failed:', (err as Error).message)
    }
  }

  const emailInstructions = `Help draft a professional follow-up email.
- Infer the recipient name from the task title and context.${knownRecipientEmail ? `\n- IMPORTANT: You MUST set to_email to exactly "${knownRecipientEmail}" in the JSON — this is the confirmed email for the recipient. Do not leave it blank.` : '\n- If email is unknown, set to_email to "" and note this in your message.'}
- Reference specific details from the meeting transcript.
- Keep the body concise (3-4 sentences). Sign off with the user's name if known.`

  const calendarPref = actionType === 'CALENDAR'
    ? await recallCalendarPreference(taskTitle, 'CALENDAR').catch(() => null)
    : null

  const calendarHint =
    calendarPref?.skipCalendar
      ? '\nNote: This user rarely confirms calendar blocks for this task type — mention in your message that they can skip if not needed.'
      : calendarPref?.alwaysAsk
      ? '\nIMPORTANT: This user always changes the suggested time. Do NOT commit to a specific time — in your message field ask what time works for them. Use "09:00" as a placeholder in time field only.'
      : calendarPref?.suggestHour !== undefined
      ? `\nThis user typically schedules this type of work at ${String(calendarPref.suggestHour).padStart(2, '0')}:00. Default to that time unless the transcript suggests otherwise.`
      : ''

  const calendarInstructions = `Help schedule a calendar event.
- Infer date from context ("Friday", "next week", deadlineText). Today is ${today}.
- If date/time is ambiguous make a reasonable guess and note it.
- Default duration is 30 minutes unless context suggests otherwise.${calendarHint}`

  const availableProjects = listClaudeProjects()
  const projectsListText  = availableProjects.length
    ? availableProjects.map(p => `  - ${p.dirName}${p.repoPath ? ` (→ ${p.repoPath})` : ''}`).join('\n')
    : '  (none found)'

  const codeInstructions = `Generate a rich context document (markdown) for Claude Code to use when implementing this task.
The context_md should include:
## Task
Clear description of what needs to be implemented.
## Meeting Context
Relevant decisions, constraints, and background from this meeting.
## Suggested Approach
Concrete implementation steps or architectural suggestions based on what was discussed.
## Notes
Any gotchas, dependencies, or open questions from the meeting.

AVAILABLE CODE PROJECTS (from ~/.claude/projects/):
${projectsListText}

DIRECTORY IDENTIFICATION RULES:
- If the meeting transcript, task title, or participant context clearly names a project or repo that matches one of the above, set claude_project_dir to its dirName.
- If you are NOT confident which project this task belongs to — because the project name is ambiguous, not mentioned, or matches multiple entries — set claude_project_dir to null AND in your message field briefly tell the user you are not sure which codebase to open. Do NOT list or enumerate candidate projects.
- Never guess. A wrong directory is worse than asking.`

  const responseFormat = actionType === 'EMAIL'
    ? `{"message":"...","email_draft":{"to_name":"...","to_email":"...","subject":"...","body":"..."},"calendar_draft":null,"code_draft":null}`
    : actionType === 'CALENDAR'
    ? `{"message":"...","email_draft":null,"calendar_draft":{"title":"...","date_iso":"YYYY-MM-DD","time":"HH:MM","duration_min":30,"description":"..."},"code_draft":null}`
    : `{"message":"...","email_draft":null,"calendar_draft":null,"code_draft":{"context_md":"# Task: ...\\n\\n## Meeting Context\\n...","claude_project_dir":"-Users-foo-bar-or-null"}}`

  const systemPrompt = `You are an action assistant embedded in Cornflake, a meeting intelligence app.

TASK: "${taskTitle}"
ACTION TYPE: ${actionType}
MEETING TITLE: ${detail?.title ?? 'Unknown meeting'}
TODAY: ${today}

PARTICIPANTS:
${speakerContext || '(no participants listed)'}

MEETING SUMMARY:
${detail?.summary ?? '(no summary available)'}

TRANSCRIPT EXCERPT:
${transcriptContext || '(no transcript available)'}

${actionType === 'EMAIL' ? emailInstructions : actionType === 'CALENDAR' ? calendarInstructions : codeInstructions}

RESPONSE FORMAT: Respond with valid JSON only — no markdown, no text outside JSON.
Example: ${responseFormat}`

  const apiMessages: ChatMessage[] = messages.length > 0
    ? messages
    : [{ role: 'user', content: `Help me action this task: "${taskTitle}"` }]

  const parsed = await apiPost('/api/ai/messages', {
    model: LLM_MODEL.claude,
    max_tokens: 1500,
    system: systemPrompt,
    messages: apiMessages,
  }) as {
    content?: Array<{ type: string; text: string }>
    error?: { message: string }
  }
  if (parsed.error) throw new Error(`Anthropic error: ${parsed.error.message}`)

  const text = parsed.content?.find(b => b.type === 'text')?.text ?? ''
  const jsonText = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()

  let data: {
    message: string
    email_draft: { to_name: string; to_email: string; subject: string; body: string } | null
    calendar_draft: { title: string; date_iso: string; time: string; duration_min: number; description: string } | null
    code_draft: { context_md: string; claude_project_dir?: string | null } | null
  }

  try {
    data = JSON.parse(jsonText)
  } catch {
    data = { message: text, email_draft: null, calendar_draft: null, code_draft: null }
  }

  return {
    message: data.message ?? '',
    emailDraft: data.email_draft
      ? { toName: data.email_draft.to_name, toEmail: data.email_draft.to_email, subject: data.email_draft.subject, body: data.email_draft.body }
      : null,
    calendarDraft: data.calendar_draft
      ? { title: data.calendar_draft.title, dateIso: data.calendar_draft.date_iso, time: data.calendar_draft.time, durationMin: data.calendar_draft.duration_min, description: data.calendar_draft.description }
      : null,
    codeDraft: data.code_draft
      ? (() => {
          const dirName = data.code_draft.claude_project_dir ?? null
          const project = dirName ? availableProjects.find(p => p.dirName === dirName) ?? null : null
          return {
            contextMd:        data.code_draft.context_md,
            claudeProjectDir: project?.dirName ?? null,
          }
        })()
      : null,
  }
}

// ---------------------------------------------------------------------------
// Gmail send (uses the signed-in Google account directly)
// ---------------------------------------------------------------------------

// Build a minimal RFC 2822 email and base64url-encode it for the Gmail API.
function buildMimeMessage(
  fromName: string, fromEmail: string,
  toName: string, toEmail: string,
  subject: string, body: string,
): string {
  const to = toName ? `"${toName}" <${toEmail}>` : toEmail
  const from = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail
  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    body,
  ].join('\r\n')
  // Gmail API requires base64url (no padding)
  return Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sendViaGmail(
  toName: string,
  toEmail: string,
  subject: string,
  body: string,
  fromName: string,
  fromEmail: string,
): Promise<void> {
  await withGoogleAuth(async auth => {
    const gmail = google.gmail({ version: 'v1', auth })
    const raw = buildMimeMessage(fromName, fromEmail, toName, toEmail, subject, body)
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
  })
}

// ---------------------------------------------------------------------------
// Google Calendar event insert
// ---------------------------------------------------------------------------

export async function addGoogleCalendarEvent(
  title: string,
  dateIso: string,
  time: string,
  durationMin: number,
  description: string,
): Promise<string> {
  const [year, month, day] = dateIso.split('-').map(Number)
  const [hour, minute] = (time || '10:00').split(':').map(Number)

  const start = new Date(year, month - 1, day, hour ?? 10, minute ?? 0)
  const end   = new Date(start.getTime() + (durationMin ?? 30) * 60_000)

  const eventLink = await withGoogleAuth(async auth => {
    const cal = google.calendar({ version: 'v3', auth })
    const res = await cal.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary:     title,
        description: description || undefined,
        start:       { dateTime: start.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        end:         { dateTime: end.toISOString(),   timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      },
    })
    return res.data.htmlLink ?? ''
  })

  return eventLink
}

// ---------------------------------------------------------------------------
// Claude Code launcher
// ---------------------------------------------------------------------------

export async function launchClaudeCode(
  contextMd:        string,
  claudeProjectDir: string | null = null,
): Promise<void> {
  // Resolve the working directory from the JSONL cwd field (most reliable source).
  let cwd: string | null = null
  if (claudeProjectDir) {
    const jsonlPath = getLatestJsonlPath(claudeProjectDir)
    if (jsonlPath) cwd = extractCwdFromJsonl(jsonlPath)
  }

  const contextPath = join(tmpdir(), 'cornflake-context.md')
  writeFileSync(contextPath, contextMd, 'utf8')

  // Write a launcher shell script so we avoid all AppleScript string-escaping issues.
  // The script cd's into the project root then passes the context file as claude's prompt.
  const cdLine     = cwd ? `cd '${cwd.replace(/'/g, "'\\''")}'` : ''
  const launchScript = [
    '#!/bin/bash',
    cdLine,
    `claude "$(cat '${contextPath}')"`,
  ].filter(Boolean).join('\n') + '\n'

  const launchPath = join(tmpdir(), 'cornflake-launch.sh')
  writeFileSync(launchPath, launchScript, { encoding: 'utf8', mode: 0o755 })

  const appleScript = `
tell application "Terminal"
  activate
  do script "bash '${launchPath}'"
end tell
`
  const appleScriptPath = join(tmpdir(), 'cornflake-terminal.scpt')
  writeFileSync(appleScriptPath, appleScript, 'utf8')
  await execFileAsync('osascript', [appleScriptPath])
}

// ---------------------------------------------------------------------------
// Action type classifier
// ---------------------------------------------------------------------------

export async function classifyActionType(
  taskTitle: string,
  transcriptQuote?: string | null,
): Promise<'EMAIL' | 'CALENDAR' | 'CLAUDE_CODE'> {
  const context = transcriptQuote ? `\nContext from meeting: "${transcriptQuote}"` : ''
  const classifyResult = await apiPost('/api/ai/messages', {
    model: LLM_MODEL.claude,
    max_tokens: 10,
    system: `Classify meeting action items. Reply with exactly one word.

EMAIL — send a message, follow up with someone, write an update, share info
CALENDAR — schedule time, block calendar, set a meeting, book something, set a reminder
CLAUDE_CODE — write code, fix a bug, implement a feature, open a PR, review code`,
    messages: [{ role: 'user', content: `Task: "${taskTitle}"${context}` }],
  }) as { content?: Array<{ type: string; text: string }> }

  const text = classifyResult.content?.find(b => b.type === 'text')?.text?.trim().toUpperCase() ?? ''

  if (text.includes('EMAIL'))       return 'EMAIL'
  if (text.includes('CLAUDE_CODE') || text.includes('CODE')) return 'CLAUDE_CODE'
  return 'CALENDAR'
}
