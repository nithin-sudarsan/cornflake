import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  useGetMeetingDetail,
  useUpdateTask,
  useUpdateTitle,
  useApproveDismissTasks,
  useApproveWithLists,
  useRestoreDismissedTasks,
  useGetAllLists,
  type MeetingDetailData,
  type TaskForApproval,
} from '../../hooks/useIPC'

interface MeetingDetailProps {
  meetingId: string
  onBack: () => void
  onTasksApproved?: () => void  // notifies parent to refresh reminders
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }) + ' · ' + new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// "Meeting, HH:MM" fallback used when meeting.title is null/empty.
function formatFallbackTitle(ms: number): string {
  const hhmm = new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  return `Meeting, ${hhmm}`
}

function formatDuration(startMs: number, endMs: number | null): string {
  if (!endMs) return ''
  const mins = Math.round((endMs - startMs) / 60000)
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function formatUtteranceTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const sec = (s % 60).toString().padStart(2, '0')
  return `${m}:${sec}`
}

function nextWeekday(dayOfWeek: number): Date {
  const d = new Date()
  d.setHours(9, 0, 0, 0)
  const diff = (dayOfWeek - d.getDay() + 7) % 7 || 7
  d.setDate(d.getDate() + diff)
  return d
}

// ---------------------------------------------------------------------------
// Inline bold renderer
// ---------------------------------------------------------------------------

function renderInline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{part.slice(2, -2)}</strong>
    }
    return part
  })
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

interface ParsedBlock { type: 'h1' | 'h3' | 'list' | 'paragraph'; content: string; items?: { text: string; depth: number }[] }

function parseMarkdown(md: string): ParsedBlock[] {
  const lines = md.split('\n')
  const blocks: ParsedBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('# '))   { blocks.push({ type: 'h1', content: line.slice(2).trim() }); i++; continue }
    if (line.startsWith('### ')) { blocks.push({ type: 'h3', content: line.slice(4).trim() }); i++; continue }
    if (/^( {2})?- /.test(line)) {
      const items: { text: string; depth: number }[] = []
      while (i < lines.length && /^( {2})?- /.test(lines[i])) {
        items.push({ text: lines[i].replace(/^ {0,2}- /, '').trim(), depth: lines[i].startsWith('  - ') ? 1 : 0 })
        i++
      }
      blocks.push({ type: 'list', content: '', items }); continue
    }
    const trimmed = line.trim()
    if (trimmed) blocks.push({ type: 'paragraph', content: trimmed })
    i++
  }
  return blocks
}

function MarkdownNotes({ markdown }: { markdown: string }) {
  const blocks = parseMarkdown(markdown)
  return (
    <div>
      {blocks.map((block, bi) => {
        if (block.type === 'h1') return (
          <h1 key={bi} style={{ fontSize: 22, fontWeight: 600, color: 'var(--color-white)', margin: '0 0 6px', lineHeight: 1.3 }}>
            {block.content}
          </h1>
        )
        if (block.type === 'h3') return (
          <h3 key={bi} style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '24px 0 8px' }}>
            {block.content}
          </h3>
        )
        if (block.type === 'list') {
          const grouped: { text: string; subs: string[] }[] = []
          for (const item of block.items ?? []) {
            if (item.depth === 0) grouped.push({ text: item.text, subs: [] })
            else if (grouped.length > 0) grouped[grouped.length - 1].subs.push(item.text)
          }
          return (
            <ul key={bi} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {grouped.map((item, ii) => (
                <li key={ii} style={{ marginBottom: item.subs.length > 0 ? 6 : 4 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--color-text-muted)', flexShrink: 0, marginTop: 3, fontSize: 12 }}>–</span>
                    <span style={{ fontSize: 14, color: 'var(--color-text-primary)', lineHeight: 1.55 }}>{renderInline(item.text)}</span>
                  </div>
                  {item.subs.length > 0 && (
                    <ul style={{ listStyle: 'none', margin: '4px 0 0 20px', padding: 0 }}>
                      {item.subs.map((sub, si) => (
                        <li key={si} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 3 }}>
                          <span style={{ color: 'var(--color-text-muted)', flexShrink: 0, marginTop: 3, fontSize: 10 }}>·</span>
                          <span style={{ fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.55 }}>{renderInline(sub)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )
        }
        if (block.type === 'paragraph') return (
          <p key={bi} style={{ fontSize: 14, color: 'var(--color-text-primary)', lineHeight: 1.6, margin: '8px 0' }}>
            {renderInline(block.content)}
          </p>
        )
        return null
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Editable title — Notion-style click-to-edit
// ---------------------------------------------------------------------------

// Shared style so the heading and the input look identical — the transition
// between view and edit modes should feel like clicking on text, not opening
// a form field.
const TITLE_STYLE: React.CSSProperties = {
  fontSize:    22,
  fontWeight:  600,
  color:       'var(--color-white)',
  margin:      '0 0 6px',
  lineHeight:  1.3,
  fontFamily:  'inherit',
}

interface EditableTitleProps {
  title:         string
  editing:       boolean
  draft:         string
  inputRef:      React.RefObject<HTMLInputElement | null>
  onStartEdit:   () => void
  onDraftChange: (value: string) => void
  onSave:        () => void
  onCancel:      () => void
}

function EditableTitle({
  title, editing, draft, inputRef,
  onStartEdit, onDraftChange, onSave, onCancel,
}: EditableTitleProps) {
  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={e => onDraftChange(e.target.value)}
        onBlur={onSave}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSave()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        style={{
          ...TITLE_STYLE,
          width:           '100%',
          display:         'block',
          background:      'transparent',
          border:          'none',
          outline:         'none',
          padding:         0,
          boxSizing:       'border-box',
        }}
      />
    )
  }

  return (
    <h1
      style={{ ...TITLE_STYLE, cursor: 'text' }}
      onClick={onStartEdit}
      title="Click to edit"
    >
      {title}
    </h1>
  )
}

// ---------------------------------------------------------------------------
// Inline task edit panel (Screen 3 — simplified)
// ---------------------------------------------------------------------------

interface TaskEditPanelProps {
  task: TaskForApproval
  onSave: (updates: { title: string; deadlineText: string | null; deadlineMs: number | null }) => void
  onCancel: () => void
}

function TaskEditPanel({ task, onSave, onCancel }: TaskEditPanelProps) {
  const [title, setTitle]           = useState(task.title)
  const [deadlineText, setDeadlineText] = useState(task.deadlineText ?? '')
  const [deadlineMs, setDeadlineMs]   = useState<number | null>(task.deadlineMs)

  function applyQuickPick(label: string, ms: number | null, text: string | null) {
    setDeadlineMs(ms)
    setDeadlineText(text ?? '')
  }

  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0)
  const friday   = nextWeekday(5)

  return (
    <div style={{
      marginTop: 8, padding: '14px 14px 12px',
      backgroundColor: 'var(--color-bg-deep)',
      borderRadius: 8, border: '1px solid var(--color-divider)',
    }}>
      {/* Transcript quote */}
      {task.transcriptQuote && (
        <p style={{
          fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5,
          margin: '0 0 12px', fontStyle: 'italic',
          borderLeft: '2px solid var(--color-divider)', paddingLeft: 8,
        }}>
          "{task.transcriptQuote}"
        </p>
      )}

      {/* Title */}
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
        Task
      </label>
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        style={{
          width: '100%', fontSize: 14, color: 'var(--color-text-primary)',
          backgroundColor: 'var(--color-bg-surface)', border: '1px solid var(--color-divider)',
          borderRadius: 6, padding: '7px 10px', outline: 'none',
          fontFamily: 'inherit', marginBottom: 12, boxSizing: 'border-box',
        }}
      />

      {/* Assignee picker removed — v1 is single-player, all tasks are implicitly the user's. */}

      {/* Deadline */}
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
        Deadline
      </label>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        {[
          { label: 'Tomorrow', ms: tomorrow.getTime(), text: 'Tomorrow' },
          { label: 'This Friday', ms: friday.getTime(), text: 'This Friday' },
          { label: 'No deadline', ms: null, text: null },
        ].map(q => (
          <button
            key={q.label}
            onClick={() => applyQuickPick(q.label, q.ms, q.text)}
            style={{
              fontSize: 11, color: 'var(--color-text-muted)',
              backgroundColor: 'var(--color-bg-surface)',
              border: '1px solid var(--color-divider)', borderRadius: 6,
              padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {q.label}
          </button>
        ))}
      </div>
      <input
        value={deadlineText}
        onChange={e => { setDeadlineText(e.target.value); setDeadlineMs(null) }}
        placeholder="Or type a deadline…"
        style={{
          width: '100%', fontSize: 13, color: 'var(--color-text-primary)',
          backgroundColor: 'var(--color-bg-surface)', border: '1px solid var(--color-divider)',
          borderRadius: 6, padding: '6px 10px', outline: 'none',
          fontFamily: 'inherit', marginBottom: 14, boxSizing: 'border-box',
        }}
      />

      {/* Footer */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          style={{
            fontSize: 13, color: 'var(--color-text-muted)',
            background: 'none', border: '1px solid var(--color-divider)',
            borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          Cancel
        </button>
        <button
          onClick={() => onSave({ title: title.trim() || task.title, deadlineText: deadlineText.trim() || null, deadlineMs })}
          style={{
            fontSize: 13, fontWeight: 600, color: 'var(--color-white)',
            backgroundColor: 'var(--color-text-muted)', border: 'none',
            borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          Save
        </button>
      </div>
    </div>
  )
}
// ---------------------------------------------------------------------------
// Action items section
// ---------------------------------------------------------------------------

const EXIT_DURATION_MS = 280

interface ActionItemsSectionProps {
  tasks: TaskForApproval[]
  speakers: { id: string; name: string | null; isSelf: boolean }[]
  onApproved: (approvedIds: string[], dismissedIds: string[]) => void
  onAnyChange?: () => void
}

function ActionItemsSection({ tasks: initialTasks, speakers, onApproved, onAnyChange }: ActionItemsSectionProps) {
  const [tasks, setTasks]             = useState<TaskForApproval[]>(initialTasks)
  const [checked, setChecked]         = useState<Set<string>>(new Set())
  const [dismissed, setDismissed]     = useState<Set<string>>(new Set())
  const [dismissing, setDismissing]   = useState<Set<string>>(new Set())
  const [exiting, setExiting]         = useState<Set<string>>(new Set())
  const [editingId, setEditingId]     = useState<string | null>(null)
  // Per-task target list (defaults to 'Reminders')
  const [taskLists, setTaskLists]     = useState<Map<string, string>>(new Map())
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null)
  const [availableLists, setAvailableLists] = useState<string[]>(['Reminders'])

  const updateTask       = useUpdateTask()
  const approveDismiss   = useApproveDismissTasks()
  const approveWithLists = useApproveWithLists()
  const getAllLists       = useGetAllLists()

  // Load sidebar lists once on mount
  useEffect(() => {
    getAllLists().then(lists => {
      setAvailableLists(['Reminders', ...lists.map(l => l.name)])
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const visibleTasks = tasks.filter(t => !dismissed.has(t.id))

  // Active (not dismissed, not animating out) IDs — used for select-all and counts
  const activeIds    = visibleTasks.filter(t => !exiting.has(t.id)).map(t => t.id)
  const activeChecked = [...checked].filter(id => !dismissed.has(id) && !exiting.has(id))
  const allSelected  = activeIds.length > 0 && activeIds.every(id => checked.has(id))
  const someChecked  = activeChecked.length > 0

  function toggleCheck(id: string) {
    setChecked(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  function toggleSelectAll() {
    if (allSelected) {
      setChecked(new Set())
    } else {
      setChecked(new Set(activeIds))
    }
  }

  function getTaskList(id: string) { return taskLists.get(id) ?? 'Reminders' }

  function handleDismiss(id: string) {
    approveDismiss([], [id]).catch(() => {})
    onAnyChange?.()
    setDismissing(prev => new Set(prev).add(id))
    setTimeout(() => {
      setDismissed(prev => new Set(prev).add(id))
      setDismissing(prev => { const n = new Set(prev); n.delete(id); return n })
      setChecked(prev => { const n = new Set(prev); n.delete(id); return n })
    }, 350)
  }

  function handleApprove(ids: string[]) {
    const toApprove = ids.filter(id => !dismissed.has(id) && !exiting.has(id))
    if (toApprove.length === 0) return

    const approvals = toApprove.map(id => ({ id, listName: getTaskList(id) }))
    approveWithLists(approvals, []).catch(() => {})
    onAnyChange?.()

    setExiting(prev => { const n = new Set(prev); toApprove.forEach(id => n.add(id)); return n })
    setChecked(prev => { const n = new Set(prev); toApprove.forEach(id => n.delete(id)); return n })

    setTimeout(() => {
      setTasks(prev => prev.filter(t => !toApprove.includes(t.id)))
      setExiting(prev => { const n = new Set(prev); toApprove.forEach(id => n.delete(id)); return n })
      onApproved(toApprove, [])
    }, EXIT_DURATION_MS)
  }

  function handleBulkDismiss(ids: string[]) {
    const toDismiss = ids.filter(id => !dismissed.has(id) && !exiting.has(id))
    if (toDismiss.length === 0) return
    // Persist all at once
    approveWithLists([], toDismiss).catch(() => {})
    onAnyChange?.()
    // Animate each row out individually
    toDismiss.forEach(id => {
      setDismissing(prev => new Set(prev).add(id))
      setTimeout(() => {
        setDismissed(prev => new Set(prev).add(id))
        setDismissing(prev => { const n = new Set(prev); n.delete(id); return n })
        setChecked(prev => { const n = new Set(prev); n.delete(id); return n })
      }, 350)
    })
  }

  async function handleEditSave(taskId: string, updates: { title: string; deadlineText: string | null; deadlineMs: number | null }) {
    await updateTask({ taskId, ...updates })
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...updates } : t))
    setEditingId(null)
  }

  if (visibleTasks.length === 0 && exiting.size === 0) return null

  const sectionHeaderStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.08em',
  }

  const pillStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 3,
    fontSize: 11, color: 'var(--color-text-muted)',
    backgroundColor: 'var(--color-bg-surface)',
    border: '1px solid var(--color-divider)',
    borderRadius: 4, padding: '2px 7px',
    cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap', userSelect: 'none',
  }

  return (
    <div>
      {/* Overlay to close dropdown on outside click */}
      {openDropdownId && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 98 }}
          onClick={() => setOpenDropdownId(null)}
        />
      )}

      {/* Header: section label + Select all toggle */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={sectionHeaderStyle}>Action items</span>
        <button
          onClick={toggleSelectAll}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            background: 'none', border: 'none', cursor: 'pointer',
            padding: 0, fontFamily: 'inherit',
            fontSize: 12, color: 'var(--color-text-muted)',
          }}
        >
          <span style={{
            width: 14, height: 14, borderRadius: 3, flexShrink: 0,
            border: `1.5px solid var(--color-text-muted)`,
            backgroundColor: allSelected ? 'var(--color-text-muted)' : 'transparent',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background-color 0.1s',
          }}>
            {allSelected && (
              <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                <path d="M1 3.5L3 5.5L8 1" stroke="white" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </span>
          Select all
        </button>
      </div>

      {/* Task cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visibleTasks.map(task => {
          const isChecked    = checked.has(task.id)
          const isDismissing = dismissing.has(task.id)
          const isExiting    = exiting.has(task.id)
          const isEditing    = editingId === task.id
          const taskList     = getTaskList(task.id)
          const isDropOpen   = openDropdownId === task.id

          return (
            <div
              key={task.id}
              style={{
                opacity: isExiting ? 0 : 1,
                transform: isExiting ? 'translateY(-6px)' : 'none',
                transition: isExiting
                  ? `opacity ${EXIT_DURATION_MS}ms ease, transform ${EXIT_DURATION_MS}ms ease`
                  : 'none',
                overflow: 'visible',
              }}
            >
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '10px 12px',
                backgroundColor: 'var(--color-bg-deep)',
                borderRadius: 8,
                border: '1px solid var(--color-divider)',
                opacity: isDismissing ? 0.4 : 1,
                transition: 'opacity 0.3s ease',
              }}>
                {/* Checkbox */}
                <button
                  onClick={() => toggleCheck(task.id)}
                  aria-label={isChecked ? 'Uncheck' : 'Check'}
                  style={{
                    flexShrink: 0, width: 18, height: 18, borderRadius: 4,
                    border: isChecked ? 'none' : '1.5px solid var(--color-text-muted)',
                    backgroundColor: isChecked ? 'var(--color-text-muted)' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', padding: 0, marginTop: 1,
                    transition: 'background-color 0.1s',
                  }}
                >
                  {isChecked && (
                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                      <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </button>

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{
                    margin: 0, fontSize: 14, color: 'var(--color-text-primary)',
                    lineHeight: 1.4,
                    textDecoration: isDismissing ? 'line-through' : 'none',
                  }}>
                    {task.title}
                  </p>

                  {/* Deadline only — assignee removed for v1 single-player mode */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
                    {task.deadlineText ? (
                      <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{task.deadlineText}</span>
                    ) : (
                      <span style={{ fontSize: 11, color: '#f59e0b' }}>No deadline</span>
                    )}
                  </div>

                  {/* List selector pill */}
                  <div style={{ marginTop: 6, position: 'relative', display: 'inline-block' }}>
                    <button
                      onClick={e => { e.stopPropagation(); setOpenDropdownId(isDropOpen ? null : task.id) }}
                      style={pillStyle}
                    >
                      {taskList}
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" style={{ opacity: 0.6 }}>
                        <path d="M2 3l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                    {isDropOpen && (
                      <div style={{
                        position: 'absolute',
                        top: 'calc(100% + 4px)', left: 0,
                        backgroundColor: 'var(--color-bg-surface)',
                        border: '1px solid var(--color-divider)',
                        borderRadius: 6, padding: '4px 0',
                        zIndex: 99, minWidth: 140,
                        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                      }}>
                        {availableLists.map(list => (
                          <button
                            key={list}
                            onClick={e => {
                              e.stopPropagation()
                              setTaskLists(prev => new Map(prev).set(task.id, list))
                              setOpenDropdownId(null)
                            }}
                            style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              width: '100%', padding: '7px 12px',
                              background: 'none', border: 'none', cursor: 'pointer',
                              fontSize: 13, fontFamily: 'inherit',
                              color: list === taskList ? 'var(--color-white)' : 'var(--color-text-muted)',
                              textAlign: 'left',
                            }}
                          >
                            {list}
                            {list === taskList && (
                              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                                <path d="M1 4L3.5 6.5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Edit + dismiss */}
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button
                    onClick={() => setEditingId(isEditing ? null : task.id)}
                    aria-label="Edit task"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--color-text-muted)', opacity: isEditing ? 1 : 0.6 }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M8.5 1.5L10.5 3.5L4 10H2V8L8.5 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDismiss(task.id)}
                    aria-label="Dismiss task"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--color-text-muted)', opacity: 0.6 }}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                    </svg>
                  </button>
                </div>
              </div>

              {isEditing && (
                <TaskEditPanel
                  task={task}
                  onSave={updates => handleEditSave(task.id, updates)}
                  onCancel={() => setEditingId(null)}
                />
              )}
            </div>
          )
        })}
      </div>

      {/* Bulk action bar — shown when at least one item is checked */}
      {someChecked && (
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button
            onClick={() => handleApprove(activeChecked)}
            style={{
              flex: 1, height: 36, borderRadius: 8, border: 'none',
              backgroundColor: '#059669', color: 'white',
              fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Approve ({activeChecked.length})
          </button>
          <button
            onClick={() => handleBulkDismiss(activeChecked)}
            style={{
              flex: 1, height: 36, borderRadius: 8,
              border: '1px solid rgba(248,113,113,0.35)',
              backgroundColor: 'transparent', color: '#f87171',
              fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Dismiss ({activeChecked.length})
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// MeetingDetail
// ---------------------------------------------------------------------------

export default function MeetingDetail({ meetingId, onBack, onTasksApproved }: MeetingDetailProps) {
  const [detail, setDetail]               = useState<MeetingDetailData | null>(null)
  const [loading, setLoading]             = useState(true)
  const [showTranscript, setShowTranscript] = useState(false)
  const [restoring, setRestoring]         = useState(false)
  const [editingTitle, setEditingTitle]   = useState(false)
  const [titleDraft, setTitleDraft]       = useState('')
  const titleInputRef                     = useRef<HTMLInputElement>(null)
  const getMeetingDetail       = useGetMeetingDetail()
  const restoreDismissedIPC    = useRestoreDismissedTasks()
  const updateTitleIPC         = useUpdateTitle()

  const loadDetail = useCallback(() => {
    getMeetingDetail(meetingId)
      .then(data => {
        console.log('[MeetingDetail] loadDetail received data:', {
          meetingId,
          pendingTasksCount:   data?.pendingTasks?.length ?? 0,
          hasExtractedTasks:   data?.hasExtractedTasks,
          hasDismissedTasks:   data?.hasDismissedTasks,
          decisionCount:       data?.decisions?.length ?? 0,
          utteranceCount:      data?.utterances?.length ?? 0,
          hasSummary:          !!data?.summary,
        })
        if (data?.pendingTasks?.length) {
          console.log('[MeetingDetail] first pending task:', JSON.stringify(data.pendingTasks[0]))
        } else {
          console.warn('[MeetingDetail] pendingTasks is empty — action items section will not render')
        }
        setDetail(data)
        setLoading(false)
      })
      .catch(err => { console.error('[MeetingDetail] loadDetail failed:', err); setLoading(false) })
  }, [meetingId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLoading(true)
    setShowTranscript(false)
    setEditingTitle(false)  // cancel any in-progress title edit when switching meetings
    loadDetail()
  }, [meetingId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus + select-all when title edit mode opens
  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [editingTitle])

  // -------------------------------------------------------------------------
  // Title edit handlers
  // -------------------------------------------------------------------------

  const startTitleEdit = useCallback(() => {
    if (!detail) return
    setTitleDraft(detail.title || '')
    setEditingTitle(true)
  }, [detail])

  const cancelTitleEdit = useCallback(() => {
    setEditingTitle(false)
  }, [])

  const saveTitle = useCallback(async () => {
    if (!detail) { setEditingTitle(false); return }
    const trimmed = titleDraft.trim()
    // Empty input or unchanged → revert without saving
    if (!trimmed || trimmed === detail.title) {
      setEditingTitle(false)
      return
    }
    // Update local SQLite (this fires _onWrite → syncModule.queueUpsert('meetings', row)
    // which pushes the change to Supabase on the next flush).
    try {
      await updateTitleIPC(meetingId, trimmed)
    } catch (err) {
      console.error('[MeetingDetail] title save failed:', err)
      setEditingTitle(false)
      return
    }
    // Reflect in the current view immediately
    setDetail(prev => prev ? { ...prev, title: trimmed } : prev)
    setEditingTitle(false)
    // Notify parent so the right-panel meeting card re-fetches and shows the new title.
    onTasksApproved?.()
  }, [detail, titleDraft, meetingId, updateTitleIPC, onTasksApproved])

  const handleTasksApproved = useCallback((_approvedIds: string[], _dismissedIds: string[]) => {
    onTasksApproved?.()
    loadDetail()
  }, [loadDetail, onTasksApproved])

  const handleRestoreDismissed = useCallback(async () => {
    setRestoring(true)
    try {
      await restoreDismissedIPC(meetingId)
      loadDetail()
    } finally {
      setRestoring(false)
    }
  }, [meetingId, restoreDismissedIPC, loadDetail])

  const isMarkdownNotes = detail?.summary?.trimStart().startsWith('#') ?? false

  const divider: React.CSSProperties = {
    height: 1, backgroundColor: 'var(--color-divider)', margin: '24px 0',
  }

  const sectionHeaderStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.08em', margin: '24px 0 10px',
  }

  return (
    <main style={{
      flex: 1, backgroundColor: 'var(--color-bg-surface)',
      overflowY: 'auto', padding: '20px 24px', position: 'relative',
      animation: 'meetingDetailFadeIn 0.25s ease',
    }}>
      {/* Titlebar drag region */}
      <div style={{ height: 28, marginTop: -20, marginLeft: -24, marginRight: -24, WebkitAppRegion: 'drag' } as React.CSSProperties} />

      {/* Back button */}
      <button
        onClick={onBack}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--color-text-muted)', fontSize: 13,
          padding: 0, marginBottom: 20, fontFamily: 'inherit',
        }}
      >
        <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
          <path d="M6 1L1 6L6 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back
      </button>

      {loading && <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading…</p>}
      {!loading && !detail && <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Meeting not found.</p>}

      {!loading && detail && (
        <>
          {/* ---- Editable title (always shown, both summary modes) ---- */}
          <EditableTitle
            title={detail.title || formatFallbackTitle(detail.startMs)}
            editing={editingTitle}
            draft={titleDraft}
            inputRef={titleInputRef}
            onStartEdit={startTitleEdit}
            onDraftChange={setTitleDraft}
            onSave={saveTitle}
            onCancel={cancelTitleEdit}
          />
          <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '0 0 4px' }}>
            {formatDateTime(detail.startMs)}
            {detail.endMs && <> · {formatDuration(detail.startMs, detail.endMs)}</>}
          </p>

          {/* ---- Meeting notes ---- */}
          {isMarkdownNotes ? (
            <MarkdownNotes markdown={detail.summary!} />
          ) : (
            <>
              {detail.summary && (
                <>
                  <div style={divider} />
                  <p style={sectionHeaderStyle}>Summary</p>
                  <p style={{ fontSize: 14, color: 'var(--color-text-primary)', lineHeight: 1.6, margin: 0 }}>{detail.summary}</p>
                </>
              )}
            </>
          )}

          {/* Participants section removed — Cornflake v1 is single-player.
              Speakers table is retained in the DB for transcript rendering. */}

          {/* ---- Action items ---- */}
          {detail.pendingTasks.length > 0 && (
            <>
              <div style={divider} />
              <ActionItemsSection
                tasks={detail.pendingTasks}
                speakers={detail.speakers}
                onApproved={handleTasksApproved}
                onAnyChange={onTasksApproved}
              />
            </>
          )}

          {detail.pendingTasks.length === 0 && detail.hasExtractedTasks && detail.hasDismissedTasks && (
            <>
              <div style={divider} />
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: '0 0 10px' }}>
                All action items resolved
              </p>
              <button
                onClick={handleRestoreDismissed}
                disabled={restoring}
                style={{
                  fontSize: 12, color: 'var(--color-text-muted)',
                  background: 'none', border: '1px solid var(--color-divider)',
                  borderRadius: 6, padding: '5px 12px', cursor: restoring ? 'default' : 'pointer',
                  fontFamily: 'inherit', opacity: restoring ? 0.6 : 1,
                }}
              >
                {restoring ? 'Restoring…' : 'Restore dismissed items'}
              </button>
            </>
          )}

          {/* ---- Transcript (collapsed) ---- */}
          {detail.utterances.length > 0 && (
            <>
              <div style={divider} />
              <button
                onClick={() => setShowTranscript(v => !v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: 0, fontFamily: 'inherit',
                  ...sectionHeaderStyle, margin: 0,
                }}
              >
                <svg
                  width="8" height="8" viewBox="0 0 8 8" fill="none"
                  style={{ transform: showTranscript ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
                >
                  <path d="M2 1L6 4L2 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Transcript
              </button>
              {showTranscript && (
                <div style={{ marginTop: 12 }}>
                  {detail.utterances.map(u => (
                    <div key={u.id} style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--color-divider)' }}>
                      <div style={{ flexShrink: 0, width: 72 }}>
                        <p style={{ margin: 0, fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {u.speakerName ?? 'Unknown'}
                        </p>
                        <p style={{ margin: '2px 0 0', fontSize: 10, color: 'var(--color-text-muted)', opacity: 0.7 }}>
                          {formatUtteranceTime(u.startMs)}
                        </p>
                      </div>
                      <p style={{ margin: 0, flex: 1, fontSize: 13, color: 'var(--color-text-primary)', lineHeight: 1.6 }}>
                        {u.text}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {!detail.summary && detail.pendingTasks.length === 0 && detail.utterances.length === 0 && (
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 24 }}>No notes available for this meeting.</p>
          )}
        </>
      )}

      <style>{`
        @keyframes meetingDetailFadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </main>
  )
}
