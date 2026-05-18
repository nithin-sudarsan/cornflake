import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  useGetTasksByList,
  useCreateStandaloneTask,
  useDismissTask,
  useCompleteTask,
  useUpdateTaskTitle,
  useRestoreTask,
  useHardDeleteTask,
  useReorderTasks,
  type TaskSummary,
} from '../../hooks/useIPC'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TICK_DELAY_MS    = 600
const EXIT_DURATION_MS = 300
const SNACKBAR_MS      = 4000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDeadline(deadlineMs: number | null, deadlineText: string | null): string | null {
  if (deadlineMs) {
    return new Date(deadlineMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) +
      ', ' + new Date(deadlineMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return deadlineText ?? null
}

function formatCompletedAt(ms: number): string {
  const d = new Date(ms)
  const thisYear = new Date().getFullYear()
  return d.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short',
    year: d.getFullYear() === thisYear ? undefined : 'numeric',
  })
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingDelete {
  task: TaskSummary
  index: number
  timer: ReturnType<typeof setTimeout>
}

interface EditingTask {
  id: string
  originalTitle: string
}

interface MainContentProps {
  activeList: string
  onMeetingSelect?: (meetingId: string) => void
  onTaskSelect?: (taskId: string) => void
  /** Incremented on sync:dataUpdated; re-fetches tasks from local SQLite when it changes. */
  dataVersion?: number
}

// ---------------------------------------------------------------------------
// Trash SVG
// ---------------------------------------------------------------------------

function TrashIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size + 1} viewBox="0 0 13 14" fill="none">
      <path
        d="M1 3.5h11M4.5 3.5V2.5h4v1M2 3.5l.8 8.75A1 1 0 003.8 13h5.4a1 1 0 001-.75L11 3.5"
        stroke="#f87171" strokeWidth="1.2" strokeLinecap="round"
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MainContent({ activeList, onMeetingSelect, onTaskSelect, dataVersion = 0 }: MainContentProps) {
  const [tasks, setTasks]                 = useState<TaskSummary[]>([])
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set())
  const [exitingIds, setExitingIds]       = useState<Set<string>>(new Set())
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null)
  const [showAddTask, setShowAddTask]     = useState(false)
  const [newTaskTitle, setNewTaskTitle]   = useState('')
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [editingTask, setEditingTask]     = useState<EditingTask | null>(null)
  const [editTitle, setEditTitle]         = useState('')
  // Drag-to-reorder state (mouse-event based, not HTML5 DnD)
  const [drag, setDrag] = useState<{
    taskId: string
    fromIdx: number
    toIdx: number
    cloneTop: number    // fixed-position Y of the clone
    cloneLeft: number
    cloneWidth: number
    cloneHeight: number
  } | null>(null)
  const dragRef   = useRef<typeof drag>(null)   // mutable copy for event handlers
  const listRef   = useRef<HTMLUListElement>(null)
  const addInputRef  = useRef<HTMLInputElement>(null)
  // Tracks whether an edit is in progress synchronously (safe to read in click handlers).
  const isEditingRef = useRef(false)
  // Tracks whether Escape was pressed inside the edit input (suppresses onBlur save).
  const escapeRef    = useRef(false)
  // Set on mousedown so the subsequent click does not re-open the input after blur closes it.
  const suppressNextClickRef = useRef(false)

  const getTasksByList       = useGetTasksByList()
  const createStandaloneTask = useCreateStandaloneTask()
  const dismissTaskIPC       = useDismissTask()
  const completeTaskIPC      = useCompleteTask()
  const updateTaskTitleIPC   = useUpdateTaskTitle()
  const restoreTaskIPC       = useRestoreTask()
  const hardDeleteTaskIPC    = useHardDeleteTask()
  const reorderTasksIPC      = useReorderTasks()

  const isCompletedList = activeList === 'Completed'

  // Load tasks when active list changes
  useEffect(() => {
    if (pendingDelete) {
      clearTimeout(pendingDelete.timer)
      dismissTaskIPC(pendingDelete.task.id).catch(() => {})
      setPendingDelete(null)
    }
    // Cancel any in-progress edit without saving
    if (editingTask) {
      isEditingRef.current = false
      setEditingTask(null)
    }
    getTasksByList(activeList)
      .then(setTasks)
      .catch(err => console.error('getTasksByList failed:', err))
  }, [activeList, dataVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (showAddTask) setTimeout(() => addInputRef.current?.focus(), 0)
  }, [showAddTask])

  useEffect(() => {
    return () => { if (pendingDelete) clearTimeout(pendingDelete.timer) }
  }, [pendingDelete])

  // -------------------------------------------------------------------------
  // Task completion: tick → 600ms → exit animation → completeTask IPC
  // -------------------------------------------------------------------------

  const handleCheck = useCallback((taskId: string) => {
    if (completingIds.has(taskId) || exitingIds.has(taskId) || isCompletedList) return
    const origin = activeList
    setCompletingIds(prev => new Set(prev).add(taskId))
    setTimeout(() => {
      setCompletingIds(prev => { const s = new Set(prev); s.delete(taskId); return s })
      setExitingIds(prev => new Set(prev).add(taskId))
      setTimeout(() => {
        setExitingIds(prev => { const s = new Set(prev); s.delete(taskId); return s })
        setTasks(prev => prev.filter(t => t.id !== taskId))
        completeTaskIPC(taskId, origin).catch(err => console.error('completeTask failed:', err))
      }, EXIT_DURATION_MS)
    }, TICK_DELAY_MS)
  }, [completingIds, exitingIds, completeTaskIPC, activeList, isCompletedList])

  // -------------------------------------------------------------------------
  // Delete: immediate visual removal + 4s undo snackbar
  // -------------------------------------------------------------------------

  const handleDeleteTask = useCallback((taskId: string) => {
    if (pendingDelete) {
      clearTimeout(pendingDelete.timer)
      // Flush previous: hard delete if from Completed, dismiss otherwise
      const flushFn = isCompletedList ? hardDeleteTaskIPC : dismissTaskIPC
      flushFn(pendingDelete.task.id).catch(() => {})
    }
    const idx = tasks.findIndex(t => t.id === taskId)
    if (idx === -1) return
    const task = tasks[idx]
    setTasks(prev => prev.filter(t => t.id !== taskId))
    const deleteFn = isCompletedList ? hardDeleteTaskIPC : dismissTaskIPC
    const timer = setTimeout(() => {
      deleteFn(taskId).catch(err => console.error('deleteTask failed:', err))
      setPendingDelete(null)
    }, SNACKBAR_MS)
    setPendingDelete({ task, index: idx, timer })
  }, [tasks, pendingDelete, dismissTaskIPC, hardDeleteTaskIPC, isCompletedList])

  const handleRestoreTask = useCallback(async (task: TaskSummary) => {
    // Optimistically remove from Completed list
    setTasks(prev => prev.filter(t => t.id !== task.id))
    // Await the IPC so DB is updated before any subsequent list fetch
    await restoreTaskIPC(task.id).catch(err => console.error('restoreTask failed:', err))
    // If the user is already on the destination list (edge case), reload so the
    // task appears immediately without requiring a navigate-away-and-back
    const destination = task.originList ?? 'Reminders'
    if (destination === activeList) {
      getTasksByList(activeList).then(setTasks).catch(() => {})
    }
  }, [restoreTaskIPC, activeList, getTasksByList])

  // -------------------------------------------------------------------------
  // Drag-to-reorder (mouse-event based — full control over visuals in Electron)
  // -------------------------------------------------------------------------

  const startDrag = useCallback((
    e: React.MouseEvent,
    taskId: string,
    taskIdx: number,
  ) => {
    if (isCompletedList) return
    e.preventDefault()
    e.stopPropagation()

    const listEl = listRef.current
    if (!listEl) return
    const rows = Array.from(listEl.querySelectorAll('[data-drag-row]')) as HTMLElement[]
    const rowEl = rows[taskIdx]
    if (!rowEl) return

    const rect      = rowEl.getBoundingClientRect()
    const rowHeight = rect.height
    const startY    = e.clientY
    const n         = rows.length

    // Pre-compute original row midpoints once at drag start
    const rowMids = rows.map(r => {
      const rr = r.getBoundingClientRect()
      return rr.top + rr.height / 2
    })

    // dragRef.current stays null until the 5px threshold is crossed (Bug 1 fix)
    dragRef.current = null

    function onMouseMove(ev: MouseEvent) {
      const deltaY = ev.clientY - startY

      // Bug 1: only enter drag mode after cursor moves >= 5px
      if (!dragRef.current) {
        if (Math.abs(deltaY) < 5) return
        const initial = {
          taskId,
          fromIdx:     taskIdx,
          toIdx:       taskIdx,
          cloneTop:    rect.top,
          cloneLeft:   rect.left,
          cloneWidth:  rect.width,
          cloneHeight: rowHeight,
        }
        dragRef.current = initial
        setDrag(initial)
        return
      }

      // Bug 3: slot-counting using original midpoints — count how many non-ghost
      // rows have their midpoint ABOVE the cursor; that count is the new toIdx.
      let newTo = 0
      for (let i = 0; i < n; i++) {
        if (i === taskIdx) continue          // skip ghost row
        if (ev.clientY > rowMids[i]) newTo++ // cursor below this row's midpoint
      }
      newTo = Math.min(n - 1, newTo)

      const updated = {
        ...dragRef.current,
        toIdx:    newTo,
        cloneTop: rect.top + deltaY,
      }
      dragRef.current = updated
      setDrag(updated)
    }

    function onMouseUp() {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)

      // Bug 2: suppress the click event that fires after mouseup so the
      // empty-space click handler in <main> doesn't create a new reminder
      suppressNextClickRef.current = true

      const d = dragRef.current
      dragRef.current = null
      setDrag(null)

      if (d && d.fromIdx !== d.toIdx) {
        setTasks(prev => {
          const next = [...prev]
          const [moved] = next.splice(d.fromIdx, 1)
          next.splice(d.toIdx, 0, moved)
          reorderTasksIPC(next.map(t => t.id)).catch(() => {})
          return next
        })
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [isCompletedList, reorderTasksIPC])

  const handleUndo = useCallback(() => {
    if (!pendingDelete) return
    clearTimeout(pendingDelete.timer)
    setTasks(prev => {
      const next = [...prev]
      next.splice(Math.min(pendingDelete.index, next.length), 0, pendingDelete.task)
      return next
    })
    setPendingDelete(null)
  }, [pendingDelete])

  // -------------------------------------------------------------------------
  // Inline title editing
  // -------------------------------------------------------------------------

  function startEditing(taskId: string, currentTitle: string) {
    isEditingRef.current = true
    escapeRef.current    = false
    setEditingTask({ id: taskId, originalTitle: currentTitle })
    setEditTitle(currentTitle)
  }

  async function saveEdit() {
    if (!editingTask) return
    const trimmed = editTitle.trim()
    const original = editingTask.originalTitle
    isEditingRef.current = false
    setEditingTask(null)
    // Nothing to save: empty string or title unchanged
    if (!trimmed || trimmed === original) return
    // Optimistic update
    setTasks(prev => prev.map(t => t.id === editingTask.id ? { ...t, title: trimmed } : t))
    try {
      await updateTaskTitleIPC(editingTask.id, trimmed)
    } catch (err) {
      console.error('updateTaskTitle failed:', err)
      // Revert on failure
      setTasks(prev => prev.map(t => t.id === editingTask.id ? { ...t, title: original } : t))
    }
  }

  function cancelEdit() {
    isEditingRef.current = false
    setEditingTask(null)
  }

  function handleEditKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter')  { e.preventDefault(); saveEdit() }
    if (e.key === 'Escape') { escapeRef.current = true; cancelEdit() }
  }

  function handleEditBlur() {
    // Escape already called cancelEdit; don't also save
    if (escapeRef.current) { escapeRef.current = false; return }
    saveEdit()
  }

  // -------------------------------------------------------------------------
  // Click-to-create: any click that reaches <main> (i.e. not stopped by a
  // child) shows the add-task input — unless Completed list or already adding.
  //
  // The mousedown handler captures whether the add-input or a title-edit was
  // active at press time. If so, blur will close it, and we suppress the
  // subsequent click so the input doesn't immediately reappear.
  // -------------------------------------------------------------------------

  function handleMainMouseDown() {
    suppressNextClickRef.current = showAddTask || isEditingRef.current
  }

  function handleMainClick() {
    // Always consume the suppression flag so it never carries over to a later click.
    const suppress = suppressNextClickRef.current
    suppressNextClickRef.current = false
    if (isCompletedList || showAddTask || isEditingRef.current || suppress) return
    setShowAddTask(true)
  }

  // -------------------------------------------------------------------------
  // Add task via FAB / enter
  // -------------------------------------------------------------------------

  async function handleAddTask() {
    const title = newTaskTitle.trim()
    if (!title) { setShowAddTask(false); setNewTaskTitle(''); return }
    setShowAddTask(false)
    setNewTaskTitle('')
    try {
      const task = await createStandaloneTask(title, activeList)
      setTasks(prev => [task, ...prev])
    } catch (err) {
      console.error('createStandaloneTask failed:', err)
    }
  }

  function handleAddKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter')  handleAddTask()
    if (e.key === 'Escape') { setShowAddTask(false); setNewTaskTitle('') }
  }

  // -------------------------------------------------------------------------
  // Shared input style (creation + editing)
  // -------------------------------------------------------------------------

  const inlineInputStyle: React.CSSProperties = {
    flex: 1,
    fontSize: 14,
    color: 'var(--color-text-primary)',
    backgroundColor: 'transparent',
    border: 'none',
    outline: 'none',
    fontFamily: 'inherit',
    minWidth: 0,
    padding: 0,
    margin: 0,
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <main
      onClick={handleMainClick}
      onMouseDown={handleMainMouseDown}
      style={{
        flex: 1, backgroundColor: 'var(--color-bg-surface)',
        overflowY: 'auto', padding: '20px 24px', position: 'relative',
        cursor: drag ? 'grabbing' : 'default',
        userSelect: drag ? 'none' : 'auto',
      }}
    >
      {/* Titlebar drag region — stops click propagation to main */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          height: 28, marginTop: -20, marginLeft: -24, marginRight: -24,
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
      />

      {/* Section title — stops propagation so clicking it doesn't create a task */}
      <h1
        onClick={e => e.stopPropagation()}
        style={{ fontSize: 22, fontWeight: 600, color: 'var(--color-white)', marginBottom: 20, marginTop: 0, cursor: 'default' }}
      >
        {activeList}
      </h1>

      {/* Inline add-task input */}
      {showAddTask && (
        <div
          onClick={e => e.stopPropagation()}
          style={{ display: 'flex', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--color-divider)' }}
        >
          <span style={{ width: 20, height: 20, borderRadius: '50%', border: '1.5px solid var(--color-text-muted)', marginRight: 12, flexShrink: 0 }} />
          <input
            ref={addInputRef}
            value={newTaskTitle}
            onChange={e => setNewTaskTitle(e.target.value)}
            onKeyDown={handleAddKeyDown}
            onBlur={handleAddTask}
            placeholder="New reminder…"
            style={inlineInputStyle}
          />
        </div>
      )}

      {/* Task list */}
      <ul ref={listRef} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {tasks.map((task, taskIdx) => {
          const isCompleting    = completingIds.has(task.id)
          const isExiting       = exitingIds.has(task.id)
          const isRowHovered    = hoveredTaskId === task.id
          const isThisEditing   = editingTask?.id === task.id
          const meta            = formatDeadline(task.deadlineMs, task.deadlineText)
          const showDragHandle  = !isCompletedList

          // Drag visuals
          const isGhost = drag?.taskId === task.id
          const dragShift = (() => {
            if (!drag || isGhost) return 0
            const { fromIdx, toIdx, cloneHeight } = drag
            if (fromIdx < toIdx && taskIdx > fromIdx && taskIdx <= toIdx) return -cloneHeight
            if (fromIdx > toIdx && taskIdx >= toIdx && taskIdx < fromIdx) return cloneHeight
            return 0
          })()
          const isDropTarget =
            drag &&
            !isGhost &&
            ((drag.fromIdx < drag.toIdx && taskIdx === drag.toIdx) ||
             (drag.fromIdx > drag.toIdx && taskIdx === drag.toIdx))

          return (
            <li
              key={task.id}
              data-drag-row
              onMouseEnter={() => setHoveredTaskId(task.id)}
              onMouseLeave={() => setHoveredTaskId(null)}
              onClick={() => {
                // Single click on row body → open detail view
                if (onTaskSelect && !isCompleting && !isExiting && !isThisEditing && !drag) {
                  onTaskSelect(task.id)
                }
              }}
              style={{
                display: 'flex', alignItems: 'center',
                padding: '10px 0',
                borderBottom: '1px solid var(--color-divider)',
                borderTop: isDropTarget && drag!.fromIdx > drag!.toIdx
                  ? '2px solid var(--color-text-muted)'
                  : 'none',
                opacity: isExiting ? 0 : isGhost ? 0.35 : 1,
                transform: isExiting
                  ? 'translateY(-6px)'
                  : dragShift !== 0
                    ? `translateY(${dragShift}px)`
                    : 'translateY(0)',
                transition: isExiting
                  ? `opacity ${EXIT_DURATION_MS}ms ease, transform ${EXIT_DURATION_MS}ms ease`
                  : drag
                    ? 'transform 150ms ease'
                    : 'none',
                overflow: 'hidden',
                boxShadow: isDropTarget && drag!.fromIdx < drag!.toIdx
                  ? 'inset 0 -2px 0 var(--color-text-muted)'
                  : 'none',
              }}
            >
              {/* Drag handle — active lists only, not Completed */}
              {showDragHandle && (
                <span
                  title="Drag to reorder"
                  onMouseDown={!isThisEditing ? e => startDrag(e, task.id, taskIdx) : undefined}
                  style={{
                    flexShrink: 0, marginRight: 8, width: 14,
                    display: 'flex', flexDirection: 'column', gap: 3,
                    alignItems: 'center', justifyContent: 'center',
                    cursor: isGhost ? 'grabbing' : 'grab',
                    // Space always reserved; visible only on hover or while dragging this row
                    opacity: isRowHovered || isGhost ? 0.4 : 0,
                    transition: 'opacity 0.1s',
                    paddingTop: 1,
                  }}
                >
                  <span style={{ display: 'block', width: 12, height: 1.5, borderRadius: 1, backgroundColor: 'var(--color-text-muted)' }} />
                  <span style={{ display: 'block', width: 12, height: 1.5, borderRadius: 1, backgroundColor: 'var(--color-text-muted)' }} />
                  <span style={{ display: 'block', width: 12, height: 1.5, borderRadius: 1, backgroundColor: 'var(--color-text-muted)' }} />
                </span>
              )}

              {/* Left control */}
              {isCompletedList ? (
                /* Static filled checkmark — non-interactive */
                <div style={{
                  width: 20, height: 20, borderRadius: '50%',
                  backgroundColor: 'var(--color-text-muted)',
                  marginRight: 12, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
                    <path d="M1 4L4 7.5L10 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              ) : (
                <button
                  onClick={e => { e.stopPropagation(); handleCheck(task.id) }}
                  aria-label={isCompleting ? 'Completed' : 'Mark complete'}
                  style={{
                    width: 20, height: 20, borderRadius: '50%',
                    border: isCompleting ? 'none' : '1.5px solid var(--color-text-muted)',
                    backgroundColor: isCompleting ? 'var(--color-text-muted)' : 'transparent',
                    marginRight: 12, flexShrink: 0, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: 0, transition: 'background-color 150ms, border-color 150ms',
                  }}
                >
                  {isCompleting && (
                    <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
                      <path d="M1 4L4 7.5L10 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </button>
              )}

              {/* Title + meta + origin tag */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  {isThisEditing ? (
                    /* Inline edit input */
                    <input
                      autoFocus
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      onKeyDown={handleEditKeyDown}
                      onBlur={handleEditBlur}
                      onClick={e => e.stopPropagation()}
                      style={inlineInputStyle}
                    />
                  ) : (
                    /* Single click on title → inline edit (stopPropagation keeps row from opening detail) */
                    <p
                      onClick={e => {
                        e.stopPropagation()
                        if (!isCompletedList && !isCompleting && !isExiting) {
                          startEditing(task.id, task.title)
                        }
                      }}
                      style={{
                        margin: 0, fontSize: 14, minWidth: 0,
                        color: isCompleting ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        cursor: isCompletedList ? 'default' : 'text',
                      }}
                    >
                      {task.title}
                    </p>
                  )}
                  {/* Priority pill — High or Urgent only */}
                  {task.priority === 'high' && (
                    <span style={{
                      flexShrink: 0,
                      fontSize: 11, fontWeight: 600,
                      color: '#000000',
                      backgroundColor: '#F59E0B',
                      borderRadius: 4, padding: '2px 6px',
                      whiteSpace: 'nowrap',
                    }}>!</span>
                  )}
                  {task.priority === 'urgent' && (
                    <span style={{
                      flexShrink: 0,
                      fontSize: 11, fontWeight: 600,
                      color: '#FFFFFF',
                      backgroundColor: '#FF3B30',
                      borderRadius: 4, padding: '2px 6px',
                      whiteSpace: 'nowrap',
                    }}>!!!</span>
                  )}
                  {isCompletedList && task.originList && (
                    <span style={{
                      fontSize: 11, fontWeight: 500,
                      color: 'var(--color-text-muted)',
                      backgroundColor: 'var(--color-bg-deep)',
                      borderRadius: 4, padding: '1px 6px',
                      whiteSpace: 'nowrap', flexShrink: 0,
                    }}>
                      {task.originList}
                    </span>
                  )}
                </div>
                {/* Meeting tag — shown when task came from a meeting; clickable */}
                {task.meetingTitle && task.meetingId && !isCompletedList && (
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      onMeetingSelect?.(task.meetingId!)
                    }}
                    style={{
                      display: 'block', background: 'none', border: 'none',
                      padding: 0, cursor: onMeetingSelect ? 'pointer' : 'default',
                      textAlign: 'left', fontFamily: 'inherit',
                      margin: '2px 0 0', fontSize: 11,
                      color: 'var(--color-text-muted)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      maxWidth: '100%',
                    }}
                    onMouseEnter={e => { if (onMeetingSelect) (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-primary)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-muted)' }}
                  >
                    · {task.meetingTitle}
                  </button>
                )}
                {meta && (
                  <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--color-text-muted)' }}>
                    {meta}
                  </p>
                )}
              </div>

              {/* Right side */}
              {isCompletedList ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 10, flexShrink: 0 }}>
                  {isRowHovered && (
                    <>
                      {/* Restore to origin list */}
                      <button
                        onClick={e => { e.stopPropagation(); handleRestoreTask(task) }}
                        aria-label="Restore task"
                        title="Restore"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center', color: 'var(--color-text-muted)' }}
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <path d="M2.5 7a4.5 4.5 0 1 0 1.1-2.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                          <path d="M2 3.5v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </button>
                      {/* Permanent delete */}
                      <button
                        onClick={e => { e.stopPropagation(); handleDeleteTask(task.id) }}
                        aria-label="Delete task permanently"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center', flexShrink: 0 }}
                      >
                        <TrashIcon />
                      </button>
                    </>
                  )}
                  {task.completedAt && (
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                      {formatCompletedAt(task.completedAt)}
                    </span>
                  )}
                </div>
              ) : (
                isRowHovered && !isCompleting && !isExiting && !isThisEditing && (
                  <button
                    onClick={e => { e.stopPropagation(); handleDeleteTask(task.id) }}
                    aria-label="Delete reminder"
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      padding: '0 4px', display: 'flex', alignItems: 'center',
                      flexShrink: 0, marginLeft: 8,
                    }}
                  >
                    <TrashIcon />
                  </button>
                )
              )}
            </li>
          )
        })}
      </ul>

      {/* Empty state */}
      {tasks.length === 0 && !showAddTask && (
        <p
          onClick={e => e.stopPropagation()}
          style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 24, textAlign: 'center', cursor: 'default' }}
        >
          {isCompletedList ? 'No completed tasks yet' : `No reminders in ${activeList}`}
        </p>
      )}

      {/* FAB — hidden for Completed list */}
      {!isCompletedList && (
        <button
          aria-label="Add reminder"
          onClick={e => { e.stopPropagation(); setShowAddTask(true) }}
          style={{
            position: 'fixed', bottom: 28, right: 316,
            width: 44, height: 44, borderRadius: '50%',
            backgroundColor: 'var(--color-text-muted)',
            border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M9 3V15M3 9H15" stroke="white" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </button>
      )}

      {/* Undo snackbar */}
      {pendingDelete && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed', bottom: 28, left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: '#1f2937',
            border: '1px solid var(--color-divider)',
            borderRadius: 8, padding: '10px 16px',
            display: 'flex', alignItems: 'center', gap: 16,
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            zIndex: 50, fontSize: 13, color: 'var(--color-text-primary)',
            whiteSpace: 'nowrap',
          }}
        >
          <span>Task deleted</span>
          <button
            onClick={handleUndo}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--color-white)', fontSize: 13, fontWeight: 600,
              padding: 0, fontFamily: 'inherit',
            }}
          >
            Undo
          </button>
        </div>
      )}

      {/* Drag clone — follows the cursor, fully opaque, slightly elevated */}
      {drag && (() => {
        const draggedTask = tasks.find(t => t.id === drag.taskId)
        if (!draggedTask) return null
        return (
          <div
            style={{
              position: 'fixed',
              top: drag.cloneTop,
              left: drag.cloneLeft,
              width: drag.cloneWidth,
              height: drag.cloneHeight,
              backgroundColor: 'var(--color-bg-deep)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              borderRadius: 4,
              zIndex: 9999,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              padding: '0 0',
              cursor: 'grabbing',
              opacity: 1,
            }}
          >
            {/* Handle */}
            <span style={{
              flexShrink: 0, marginLeft: 0, marginRight: 8, width: 14,
              display: 'flex', flexDirection: 'column', gap: 3,
              alignItems: 'center', justifyContent: 'center',
              opacity: 0.4, paddingTop: 1,
            }}>
              <span style={{ display: 'block', width: 12, height: 1.5, borderRadius: 1, backgroundColor: 'var(--color-text-muted)' }} />
              <span style={{ display: 'block', width: 12, height: 1.5, borderRadius: 1, backgroundColor: 'var(--color-text-muted)' }} />
              <span style={{ display: 'block', width: 12, height: 1.5, borderRadius: 1, backgroundColor: 'var(--color-text-muted)' }} />
            </span>
            {/* Circle placeholder */}
            <span style={{
              width: 20, height: 20, borderRadius: '50%',
              border: '1.5px solid var(--color-text-muted)',
              flexShrink: 0, marginRight: 12,
              display: 'inline-block',
            }} />
            {/* Title */}
            <span style={{
              fontSize: 14, color: 'var(--color-text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              flex: 1, minWidth: 0,
            }}>
              {draggedTask.title}
            </span>
          </div>
        )
      })()}
    </main>
  )
}
