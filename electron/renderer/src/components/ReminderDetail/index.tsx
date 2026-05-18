import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useGetTaskById, useUpdateTask, useDismissTask, type TaskDetail, type TaskPriority } from '../../hooks/useIPC'

interface ReminderDetailProps {
  taskId: string
  onBack: () => void
  onDelete: (taskId: string) => void          // tells parent to remove from list + navigate back
  onMeetingSelect: (meetingId: string) => void
  onTitleChange?: (taskId: string, title: string) => void  // sync title back to list
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRIORITY_OPTIONS: { value: TaskPriority; label: string; color: string }[] = [
  { value: 'normal', label: 'Normal', color: 'var(--color-text-muted)' },
  { value: 'high',   label: 'High',   color: '#F59E0B' },
  { value: 'urgent', label: 'Urgent', color: '#FF3B30' },
]

function msToDateStr(ms: number | null): string {
  if (!ms) return ''
  return new Date(ms).toISOString().slice(0, 10)   // YYYY-MM-DD
}

function msToTimeStr(ms: number | null): string {
  if (!ms) return ''
  const d = new Date(ms)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  return `${hh}:${mm}`
}

function dateTimeToMs(dateStr: string, timeStr: string): number | null {
  if (!dateStr) return null
  const time = timeStr || '09:00'
  const parsed = Date.parse(`${dateStr}T${time}:00`)
  return isNaN(parsed) ? null : parsed
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      margin: '24px 0 8px',
      fontSize: 11, fontWeight: 600,
      color: 'var(--color-text-muted)',
      textTransform: 'uppercase', letterSpacing: '0.08em',
    }}>
      {children}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ReminderDetail({
  taskId, onBack, onDelete, onMeetingSelect, onTitleChange,
}: ReminderDetailProps) {
  const [task, setTask]             = useState<TaskDetail | null>(null)
  const [loading, setLoading]       = useState(true)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef               = useRef<HTMLInputElement>(null)

  const getTaskById  = useGetTaskById()
  const updateTaskIPC = useUpdateTask()
  const dismissTaskIPC = useDismissTask()

  useEffect(() => {
    setLoading(true)
    setEditingTitle(false)
    getTaskById(taskId)
      .then(d => { setTask(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [taskId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save helper — called on blur from each field
  const save = useCallback(async (updates: Parameters<typeof updateTaskIPC>[0]) => {
    if (!task) return
    // Optimistic update
    setTask(prev => prev ? { ...prev, ...Object.fromEntries(
      Object.entries(updates).filter(([k]) => k !== 'taskId')
    ) } : prev)
    await updateTaskIPC(updates).catch(() => {})
  }, [task, updateTaskIPC])

  // ----- Title editing -----

  function startTitleEdit() {
    if (!task) return
    setTitleDraft(task.title)
    setEditingTitle(true)
    setTimeout(() => titleInputRef.current?.select(), 0)
  }

  async function commitTitle() {
    const trimmed = titleDraft.trim()
    setEditingTitle(false)
    if (!trimmed || trimmed === task?.title) return
    await save({ taskId, title: trimmed })
    onTitleChange?.(taskId, trimmed)
  }

  function handleTitleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter')  { e.preventDefault(); commitTitle() }
    if (e.key === 'Escape') setEditingTitle(false)
  }

  // ----- Delete -----

  async function handleDelete() {
    await dismissTaskIPC(taskId)
    onDelete(taskId)
  }

  // ----- Date / time helpers -----

  const dateStr = msToDateStr(task?.deadlineMs ?? null)
  const timeStr = msToTimeStr(task?.deadlineMs ?? null)

  async function handleDateBlur(e: React.FocusEvent<HTMLInputElement>) {
    const newDate = e.target.value
    const newMs   = dateTimeToMs(newDate, timeStr)
    await save({ taskId, deadlineMs: newMs, deadlineText: newDate || null })
  }

  async function handleTimeBlur(e: React.FocusEvent<HTMLInputElement>) {
    const newTime = e.target.value
    const newMs   = dateTimeToMs(dateStr, newTime)
    await save({ taskId, deadlineMs: newMs })
  }

  // ----- Styles -----

  const inputStyle: React.CSSProperties = {
    backgroundColor: 'var(--color-bg-deep)',
    border: '1px solid var(--color-divider)',
    borderRadius: 8,
    color: 'var(--color-text-primary)',
    fontSize: 14,
    fontFamily: 'inherit',
    padding: '8px 12px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  }

  const divider: React.CSSProperties = {
    height: 1, backgroundColor: 'var(--color-divider)', margin: '24px 0',
  }

  return (
    <main style={{
      flex: 1,
      backgroundColor: 'var(--color-bg-surface)',
      overflowY: 'auto',
      padding: '20px 24px',
      position: 'relative',
    }}>
      {/* Titlebar drag region */}
      <div style={{
        height: 28, marginTop: -20, marginLeft: -24, marginRight: -24,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties} />

      {/* Back */}
      <button
        onClick={onBack}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--color-text-muted)', fontSize: 13,
          padding: 0, marginBottom: 24, fontFamily: 'inherit',
        }}
      >
        <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
          <path d="M6 1L1 6L6 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back
      </button>

      {loading && <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading…</p>}
      {!loading && !task && <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Not found.</p>}

      {!loading && task && (
        <>
          {/* ---- Title ---- */}
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={handleTitleKeyDown}
              autoFocus
              style={{
                fontSize: 22, fontWeight: 600, color: 'var(--color-white)',
                backgroundColor: 'transparent', border: 'none',
                borderBottom: '2px solid var(--color-text-muted)',
                outline: 'none', width: '100%', fontFamily: 'inherit',
                padding: '0 0 4px', marginBottom: 4,
              }}
            />
          ) : (
            <h1
              onClick={startTitleEdit}
              title="Click to edit"
              style={{
                fontSize: 22, fontWeight: 600, color: 'var(--color-white)',
                margin: '0 0 4px', cursor: 'text', lineHeight: 1.3,
                userSelect: 'none',
              }}
            >
              {task.title}
            </h1>
          )}
          <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>
            {task.listName}
          </p>

          <div style={divider} />

          {/* ---- Date & time ---- */}
          <SectionHeader>Date &amp; Time</SectionHeader>
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              type="date"
              defaultValue={dateStr}
              onBlur={handleDateBlur}
              style={{ ...inputStyle, flex: '0 0 auto', width: 160 }}
            />
            <input
              type="time"
              defaultValue={timeStr}
              onBlur={handleTimeBlur}
              disabled={!dateStr}
              style={{
                ...inputStyle,
                flex: '0 0 auto', width: 120,
                opacity: dateStr ? 1 : 0.4,
              }}
            />
          </div>

          {/* ---- Priority ---- */}
          <SectionHeader>Priority</SectionHeader>
          <div style={{
            display: 'flex', gap: 0,
            backgroundColor: 'var(--color-bg-deep)',
            border: '1px solid var(--color-divider)',
            borderRadius: 8, padding: 3,
            width: 'fit-content',
          }}>
            {PRIORITY_OPTIONS.map(opt => {
              const active = task.priority === opt.value
              return (
                <button
                  key={opt.value}
                  onClick={async () => {
                    setTask(prev => prev ? { ...prev, priority: opt.value } : prev)
                    await updateTaskIPC({ taskId, priority: opt.value })
                  }}
                  style={{
                    fontSize: 13, fontWeight: active ? 600 : 400,
                    color: active ? opt.color : 'var(--color-text-muted)',
                    backgroundColor: active ? 'var(--color-bg-surface)' : 'transparent',
                    border: 'none', borderRadius: 6,
                    padding: '5px 14px', cursor: 'pointer',
                    fontFamily: 'inherit',
                    transition: 'background-color 0.1s, color 0.1s',
                    boxShadow: active ? '0 1px 3px rgba(0,0,0,0.3)' : 'none',
                  }}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>

          {/* ---- Notes ---- */}
          <SectionHeader>Notes</SectionHeader>
          <textarea
            defaultValue={task.note ?? ''}
            placeholder="Add a note…"
            onBlur={e => save({ taskId, note: e.target.value || null })}
            rows={4}
            style={{
              ...inputStyle,
              resize: 'vertical',
              lineHeight: 1.6,
              minHeight: 88,
            }}
          />

          {/* ---- Meeting source ---- */}
          {task.meetingId && task.meetingTitle && (
            <>
              <SectionHeader>Meeting</SectionHeader>
              <button
                onClick={() => onMeetingSelect(task.meetingId!)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: 0, fontFamily: 'inherit',
                  color: 'var(--color-text-muted)', fontSize: 13,
                  textAlign: 'left',
                }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text-primary)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-text-muted)')}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M1 6h10M7 2l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {task.meetingTitle}
              </button>
            </>
          )}

          {/* ---- Attachments (post-MVP) ---- */}
          <SectionHeader>Attachments</SectionHeader>
          <button
            disabled
            style={{
              fontSize: 13, color: 'var(--color-text-muted)',
              backgroundColor: 'var(--color-bg-deep)',
              border: '1px dashed var(--color-divider)',
              borderRadius: 8, padding: '8px 16px',
              cursor: 'not-allowed', fontFamily: 'inherit',
              opacity: 0.5,
            }}
          >
            + Add image (coming soon)
          </button>

          {/* ---- Delete ---- */}
          <div style={{ marginTop: 40, paddingTop: 20, borderTop: '1px solid var(--color-divider)' }}>
            <button
              onClick={handleDelete}
              style={{
                fontSize: 13, color: '#f87171',
                background: 'none', border: '1px solid rgba(248,113,113,0.3)',
                borderRadius: 8, padding: '8px 16px',
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              Delete reminder
            </button>
          </div>
        </>
      )}
    </main>
  )
}
