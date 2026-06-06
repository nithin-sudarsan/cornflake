import React, { useState, useEffect, useRef } from 'react'
import type { TaskForApproval } from '../../hooks/useIPC'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface EmailDraft {
  toName: string
  toEmail: string
  subject: string
  body: string
}

interface CalendarDraft {
  title: string
  dateIso: string
  time: string
  durationMin: number
  description: string
}

interface CodeDraft {
  contextMd:        string
  claudeProjectDir: string | null
}

interface ActionChatModalProps {
  task: TaskForApproval
  meetingId: string
  onClose: () => void
}

const api = (window as any).electronAPI

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

const ACTION_META = {
  EMAIL:       { label: '✉ Email',    color: '#60a5fa', bg: 'rgba(59,130,246,0.15)',  btn: '#3b82f6' },
  CALENDAR:    { label: '📅 Calendar', color: '#34d399', bg: 'rgba(16,185,129,0.15)', btn: '#059669' },
  CLAUDE_CODE: { label: '⌨ Code',     color: '#c084fc', bg: 'rgba(168,85,247,0.15)', btn: '#7c3aed' },
  REMINDER:    { label: '🔔 Reminder', color: '#fbbf24', bg: 'rgba(251,191,36,0.15)', btn: '#d97706' },
} as const

export default function ActionChatModal({ task, meetingId, onClose }: ActionChatModalProps) {
  const [messages, setMessages]         = useState<ChatMessage[]>([])
  const [emailDraft, setEmailDraft]     = useState<EmailDraft | null>(null)
  const [calDraft, setCalDraft]         = useState<CalendarDraft | null>(null)
  const [codeDraft, setCodeDraft]       = useState<CodeDraft | null>(null)
  const [inputText, setInputText]       = useState('')
  const [loading, setLoading]           = useState(false)
  const [acting, setActing]             = useState(false)
  const [done, setDone]                 = useState<string | null>(null)
  const [error, setError]               = useState<string | null>(null)
  const [copied, setCopied]             = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const actionType = task.actionType as keyof typeof ACTION_META
  const meta = ACTION_META[actionType] ?? ACTION_META.EMAIL

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, loading])
  useEffect(() => { void callAI([]) }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  async function callAI(msgs: ChatMessage[]) {
    setLoading(true)
    setError(null)
    try {
      const res = await api.actionChat({
        taskTitle: task.title,
        actionType: task.actionType,
        meetingId,
        messages: msgs,
      }) as { message: string; emailDraft: EmailDraft | null; calendarDraft: CalendarDraft | null; codeDraft: CodeDraft | null }

      setMessages(prev => [...prev, { role: 'assistant', content: res.message }])
      if (res.emailDraft)    setEmailDraft(res.emailDraft)
      if (res.calendarDraft) setCalDraft(res.calendarDraft)
      if (res.codeDraft)     setCodeDraft(res.codeDraft)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function handleSend() {
    const text = inputText.trim()
    if (!text || loading) return
    setInputText('')
    const newMsgs = [...messages, { role: 'user' as const, content: text }]
    setMessages(newMsgs)
    await callAI(newMsgs)
  }

  async function handleEmailAction() {
    if (!emailDraft) return
    setActing(true)
    setError(null)
    try {
      const result = await api.sendEmail({
        toName: emailDraft.toName,
        toEmail: emailDraft.toEmail,
        subject: emailDraft.subject,
        body: emailDraft.body,
      }) as { success: boolean; method: 'gmail' | 'mailto' }
      setDone(
        result?.method === 'mailto'
          ? 'Draft opened in Mail — enable Gmail API at console.developers.google.com to send directly next time'
          : `Email sent to ${emailDraft.toName || emailDraft.toEmail} via Gmail`
      )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setActing(false)
    }
  }

  async function handleCalendarAction() {
    if (!calDraft) return
    setActing(true)
    setError(null)
    try {
      const result = await api.addCalendarEvent({
        title: calDraft.title,
        dateIso: calDraft.dateIso,
        time: calDraft.time,
        durationMin: calDraft.durationMin,
        description: calDraft.description,
      }) as { success: boolean; link?: string }
      setDone(`"${calDraft.title}" added to Google Calendar`)
      if (result?.link) {
        setTimeout(() => (window as any).electronAPI?.openExternal(result.link), 800)
      }
    } catch (err) {
      setError(`Failed to add event: ${(err as Error).message}`)
    } finally {
      setActing(false)
    }
  }

  async function handleCodeAction() {
    if (!codeDraft) return
    setActing(true)
    setError(null)
    try {
      await api.launchClaude({
        contextMd:        codeDraft.contextMd,
        claudeProjectDir: codeDraft.claudeProjectDir,
      })
      setDone(`Terminal opened with Claude Code${codeDraft.claudeProjectDir ? ` in ${codeDraft.claudeProjectDir.split('-').at(-1)}` : ''}`)
    } catch (err) {
      setError(`Failed to launch: ${(err as Error).message}`)
    } finally {
      setActing(false)
    }
  }

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        backgroundColor: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div style={{
        width: 540, maxHeight: '82vh',
        backgroundColor: 'var(--color-bg-surface)',
        borderRadius: 12,
        border: '1px solid var(--color-divider)',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 16px 12px',
          borderBottom: '1px solid var(--color-divider)',
          flexShrink: 0,
        }}>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
            padding: '2px 7px', borderRadius: 4,
            backgroundColor: meta.bg, color: meta.color,
          }}>
            {meta.label}
          </span>
          <span style={{ flex: 1, fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.title}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--color-text-muted)', fontSize: 18, lineHeight: 1 }}>
            ×
          </button>
        </div>

        {/* Chat */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 80 }}>
          {messages.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '85%', padding: '8px 12px',
                borderRadius: m.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                backgroundColor: m.role === 'user' ? '#3b82f6' : 'var(--color-bg-deep)',
                color: m.role === 'user' ? '#fff' : 'var(--color-text-primary)',
                fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap',
              }}>
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div style={{ padding: '8px 14px', borderRadius: '12px 12px 12px 2px', backgroundColor: 'var(--color-bg-deep)', color: 'var(--color-text-muted)', fontSize: 13 }}>
                Thinking…
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* --- EMAIL draft --- */}
        {actionType === 'EMAIL' && emailDraft && !done && (
          <div style={{ borderTop: '1px solid var(--color-divider)', padding: '12px 16px', backgroundColor: 'var(--color-bg-deep)', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
            <div style={sectionLabel}>Draft</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={fieldLabel}>To</span>
              <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                <input value={emailDraft.toName} onChange={e => setEmailDraft(d => d ? { ...d, toName: e.target.value } : d)} placeholder="Name" style={inputSt} />
                <input value={emailDraft.toEmail} onChange={e => setEmailDraft(d => d ? { ...d, toEmail: e.target.value } : d)} placeholder="email@example.com" style={{ ...inputSt, flex: 1.5 }} />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={fieldLabel}>Subject</span>
              <input value={emailDraft.subject} onChange={e => setEmailDraft(d => d ? { ...d, subject: e.target.value } : d)} style={{ ...inputSt, flex: 1 }} />
            </div>
            <textarea value={emailDraft.body} onChange={e => setEmailDraft(d => d ? { ...d, body: e.target.value } : d)} rows={5} style={{ ...inputSt, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
          </div>
        )}

        {/* --- CALENDAR draft --- */}
        {actionType === 'CALENDAR' && calDraft && !done && (
          <div style={{ borderTop: '1px solid var(--color-divider)', padding: '12px 16px', backgroundColor: 'var(--color-bg-deep)', flexShrink: 0 }}>
            <div style={{ ...sectionLabel, marginBottom: 10 }}>Event</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...fieldLabel, width: 60 }}>Title</span>
                <input value={calDraft.title} onChange={e => setCalDraft(d => d ? { ...d, title: e.target.value } : d)} style={{ ...inputSt, flex: 1 }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...fieldLabel, width: 60 }}>Date</span>
                <input type="date" value={calDraft.dateIso} onChange={e => setCalDraft(d => d ? { ...d, dateIso: e.target.value } : d)} style={{ ...inputSt, flex: 1 }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...fieldLabel, width: 60 }}>Time</span>
                <input type="time" value={calDraft.time} onChange={e => setCalDraft(d => d ? { ...d, time: e.target.value } : d)} style={{ ...inputSt, width: 110 }} />
                <span style={fieldLabel}>for</span>
                <input type="number" value={calDraft.durationMin} onChange={e => setCalDraft(d => d ? { ...d, durationMin: parseInt(e.target.value) || 30 } : d)} style={{ ...inputSt, width: 58 }} min={5} max={480} step={5} />
                <span style={fieldLabel}>min</span>
              </div>
            </div>
          </div>
        )}

        {/* --- CLAUDE_CODE draft --- */}
        {actionType === 'CLAUDE_CODE' && codeDraft && !done && (
          <div style={{ borderTop: '1px solid var(--color-divider)', padding: '12px 16px', backgroundColor: 'var(--color-bg-deep)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={sectionLabel}>Context for Claude Code</div>
              {codeDraft.claudeProjectDir && (
                <span style={{
                  fontSize: 10, fontWeight: 600,
                  padding: '2px 7px', borderRadius: 4,
                  backgroundColor: 'rgba(168,85,247,0.15)', color: '#c084fc',
                  fontFamily: 'ui-monospace, monospace',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220,
                }}>
                  {codeDraft.claudeProjectDir.split('-').at(-1)}
                </span>
              )}
            </div>
            <textarea
              value={codeDraft.contextMd}
              onChange={e => setCodeDraft(d => d ? { ...d, contextMd: e.target.value } : d)}
              rows={8}
              style={{
                ...inputSt,
                width: '100%', boxSizing: 'border-box',
                resize: 'vertical', fontFamily: 'ui-monospace, monospace',
                fontSize: 11, lineHeight: 1.5,
              }}
            />
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 5 }}>
              {codeDraft.claudeProjectDir
                ? `Will be passed as prompt · opens in ${codeDraft.claudeProjectDir.split('-').at(-1)}`
                : "Couldn't identify which project this belongs to — copy the prompt and paste it into your Claude Code instance"}
            </div>
          </div>
        )}

        {/* Done */}
        {done && (
          <div style={{ borderTop: '1px solid var(--color-divider)', padding: '14px 16px', backgroundColor: 'rgba(16,185,129,0.1)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 16 }}>✅</span>
            <span style={{ fontSize: 13, color: '#34d399', flex: 1 }}>{done}</span>
            <button onClick={onClose} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', backgroundColor: 'rgba(52,211,153,0.2)', color: '#34d399', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              Close
            </button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ padding: '8px 16px', backgroundColor: 'rgba(239,68,68,0.08)', flexShrink: 0 }}>
            <span style={{ fontSize: 12, color: '#f87171' }}>{error}</span>
          </div>
        )}

        {/* Input + action button */}
        {!done && (
          <div style={{ borderTop: '1px solid var(--color-divider)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
                placeholder="Adjust the draft, ask a question…"
                disabled={loading}
                style={{
                  flex: 1, padding: '7px 10px', borderRadius: 6,
                  border: '1px solid var(--color-divider)',
                  backgroundColor: 'var(--color-bg-deep)',
                  color: 'var(--color-text-primary)',
                  fontSize: 13, fontFamily: 'inherit', outline: 'none',
                  opacity: loading ? 0.5 : 1,
                }}
              />
              <button
                onClick={handleSend}
                disabled={!inputText.trim() || loading}
                style={{ padding: '7px 12px', borderRadius: 6, border: '1px solid var(--color-divider)', backgroundColor: 'transparent', color: 'var(--color-text-muted)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', opacity: !inputText.trim() || loading ? 0.4 : 1 }}
              >
                Send
              </button>
            </div>

            {actionType === 'EMAIL' && emailDraft && (
              <button
                onClick={handleEmailAction}
                disabled={acting}
                style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: 'none', backgroundColor: meta.btn, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: acting ? 0.6 : 1 }}
              >
                {acting ? 'Sending via Gmail…' : emailDraft.toEmail ? `Send via Gmail to ${emailDraft.toName || emailDraft.toEmail}` : 'Fill in recipient email above'}
              </button>
            )}

            {actionType === 'CALENDAR' && calDraft && (
              <button
                onClick={handleCalendarAction}
                disabled={acting || !calDraft.dateIso}
                style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: 'none', backgroundColor: meta.btn, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: acting ? 0.6 : 1 }}
              >
                {acting ? 'Adding to Calendar…' : `Add to Calendar${calDraft.dateIso ? ` — ${fmtDate(calDraft.dateIso)}` : ''}`}
              </button>
            )}

            {actionType === 'CLAUDE_CODE' && codeDraft && (
              codeDraft.claudeProjectDir ? (
                <button
                  onClick={handleCodeAction}
                  disabled={acting}
                  style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: 'none', backgroundColor: meta.btn, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: acting ? 0.6 : 1 }}
                >
                  {acting ? 'Launching…' : 'Launch Claude Code'}
                </button>
              ) : (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(codeDraft.contextMd).then(() => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    })
                  }}
                  style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: 'none', backgroundColor: meta.btn, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  {copied ? 'Copied!' : 'Copy prompt'}
                </button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const inputSt: React.CSSProperties = {
  flex: 1, padding: '5px 8px', borderRadius: 5,
  border: '1px solid var(--color-divider)',
  backgroundColor: 'var(--color-bg-surface)',
  color: 'var(--color-text-primary)',
  fontSize: 12, fontFamily: 'inherit', outline: 'none', minWidth: 0,
}

const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.07em',
  textTransform: 'uppercase', color: 'var(--color-text-muted)',
}

const fieldLabel: React.CSSProperties = {
  fontSize: 11, color: 'var(--color-text-muted)', width: 50, flexShrink: 0,
}
