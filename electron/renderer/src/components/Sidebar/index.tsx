import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  useGetAllLists,
  useCreateList,
  useDeleteList,
  type ListRecord,
} from '../../hooks/useIPC'

// ---------------------------------------------------------------------------
// List definitions
// ---------------------------------------------------------------------------

// Only Reminders is a truly permanent default — never shown with a delete icon.
const REMINDERS_LIST = { name: 'Reminders', iconBg: '#1A5CE6', iconChar: 'R' }

// Completed is permanent and always last.
const COMPLETED_LIST = {
  name: 'Completed',
  iconBg: '#30D158',
  iconContent: (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
      <path d="M1 4L4 7.5L10 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
}

// Preserve branded icons for the three lists that live in DB but have known names.
const SPECIAL_ICONS: Record<string, string> = {
  'To-do List':    '#3A3A3A',
  'High Priority': '#1A5CE6',
  'Flagged':       '#C45E1A',
}

function listIconBg(name: string): string {
  return SPECIAL_ICONS[name] ?? '#555'
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface UserProfile {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
}

interface SidebarProps {
  activeList: string
  customLists: ListRecord[]
  onListSelect: (name: string) => void
  onListCreated: (list: ListRecord) => void
  onCustomListsLoaded: (lists: ListRecord[]) => void
  onListDeleted: (listId: string) => void
  userProfile?: UserProfile | null
  /** Incremented on sync:dataUpdated; re-fetches lists from local SQLite when it changes. */
  dataVersion?: number
  collapsed?: boolean
  onToggleCollapsed?: () => void
}

// ---------------------------------------------------------------------------
// Trash SVG
// ---------------------------------------------------------------------------

function TrashIcon() {
  return (
    <svg width="12" height="13" viewBox="0 0 12 13" fill="none">
      <path
        d="M1 3h10M4 3V2h4v1M2 3l.75 8.25A1 1 0 003.75 12h4.5a1 1 0 001-.75L10 3"
        stroke="#f87171" strokeWidth="1.2" strokeLinecap="round"
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Sidebar component
// ---------------------------------------------------------------------------

export default function Sidebar({
  activeList,
  customLists,
  onListSelect,
  onListCreated,
  onCustomListsLoaded,
  onListDeleted,
  userProfile = null,
  dataVersion = 0,
  collapsed = false,
  onToggleCollapsed,
}: SidebarProps) {
  const [pictureError, setPictureError] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [showPopover, setShowPopover] = useState(false)
  const [isAddingList, setIsAddingList] = useState(false)
  const [newListName, setNewListName] = useState('')
  const [hoveredListId, setHoveredListId] = useState<string | null>(null)
  const popoverRef      = useRef<HTMLDivElement>(null)
  const newListInputRef = useRef<HTMLInputElement>(null)

  const getAllLists    = useGetAllLists()
  const createListIPC = useCreateList()
  const deleteListIPC = useDeleteList()

  // Reset picture error when profile changes (new user or updated avatar)
  useEffect(() => {
    setPictureError(false)
  }, [userProfile?.avatarUrl])

  // Close popover when user logs out
  useEffect(() => {
    if (!userProfile) setShowPopover(false)
  }, [userProfile])

  // Re-fetch lists from local SQLite on mount AND whenever the sync layer
  // signals that data has changed (via dataVersion bump from App.tsx).
  useEffect(() => {
    getAllLists().then(onCustomListsLoaded).catch(() => {})
  }, [dataVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!showPopover) return
    function handle(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowPopover(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [showPopover])

  useEffect(() => {
    if (isAddingList) setTimeout(() => newListInputRef.current?.focus(), 0)
  }, [isAddingList])

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  async function handleSignIn() {
    setIsConnecting(true)
    try { await window.electronAPI.initiateLogin() }
    catch (err) { console.error('Login failed:', err) }
    finally { setIsConnecting(false) }
  }

  async function handleSignOut() {
    setShowPopover(false)
    await window.electronAPI.logoutAuth()
  }

  async function handleCreateList() {
    const name = newListName.trim()
    setIsAddingList(false)
    setNewListName('')
    if (!name) return
    try {
      const list = await createListIPC(name)
      onListCreated(list)
    } catch (err) {
      console.error('createList failed:', err)
    }
  }

  function handleNewListKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter')  handleCreateList()
    if (e.key === 'Escape') { setIsAddingList(false); setNewListName('') }
  }

  async function handleDeleteList(e: React.MouseEvent, list: ListRecord) {
    e.stopPropagation()
    if (!window.confirm(`Delete "${list.name}"?\nThis will also delete all tasks in this list.`)) return
    try {
      await deleteListIPC(list.id)
      onListDeleted(list.id)
      if (activeList === list.name) onListSelect('Reminders')
    } catch (err) {
      console.error('deleteList failed:', err)
    }
  }

  // -------------------------------------------------------------------------
  // Shared styles
  // -------------------------------------------------------------------------

  const rowStyle = (isActive: boolean): React.CSSProperties => collapsed
    ? {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 32, height: 32,
        margin: '2px auto',
        borderRadius: 6,
        cursor: 'pointer',
        color: isActive ? 'var(--color-white)' : 'var(--color-text-muted)',
        backgroundColor: isActive ? 'rgba(255,255,255,0.08)' : 'transparent',
      }
    : {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: 'calc(100% - 16px)',
        padding: '6px 8px',
        margin: '0 8px',
        borderRadius: 6,
        cursor: 'pointer',
        color: isActive ? 'var(--color-white)' : 'var(--color-text-muted)',
        fontSize: 13,
        fontWeight: isActive ? 600 : 400,
      }

  const iconStyle = (bg: string): React.CSSProperties => ({
    width: 20, height: 20, borderRadius: 5,
    backgroundColor: bg, color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 11, fontWeight: 700, flexShrink: 0,
  })

  // -------------------------------------------------------------------------
  // Row renderers — all use <div> to avoid nested-button violations
  // -------------------------------------------------------------------------

  /** Permanent list row — no delete icon ever. */
  function renderPermanentRow(name: string, iconBg: string, iconContent: React.ReactNode) {
    return (
      <div
        key={name}
        onClick={() => onListSelect(name)}
        title={collapsed ? name : undefined}
        style={rowStyle(activeList === name)}
      >
        <span style={iconStyle(iconBg)}>{iconContent}</span>
        {!collapsed && (
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </span>
        )}
      </div>
    )
  }

  /** Deletable list row — shows trash on hover (expanded only). */
  function renderDeletableRow(list: ListRecord) {
    const isHovered = hoveredListId === list.id
    const bg        = listIconBg(list.name)
    const char      = list.name.charAt(0).toUpperCase()

    return (
      <div
        key={list.id}
        onMouseEnter={() => setHoveredListId(list.id)}
        onMouseLeave={() => setHoveredListId(null)}
        onClick={() => onListSelect(list.name)}
        title={collapsed ? list.name : undefined}
        style={rowStyle(activeList === list.name)}
      >
        <span style={iconStyle(bg)}>{char}</span>
        {!collapsed && (
          <>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {list.name}
            </span>
            {isHovered && (
              <button
                onClick={e => handleDeleteList(e, list)}
                title={`Delete ${list.name}`}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: '0 2px', display: 'flex', alignItems: 'center', flexShrink: 0,
                }}
              >
                <TrashIcon />
              </button>
            )}
          </>
        )}
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <aside
      style={{
        width:    collapsed ? 44 : 200,
        minWidth: collapsed ? 44 : 200,
        // Transparent so the macOS NSVisualEffectView (vibrancy: 'sidebar') is
        // the only thing painting the sidebar background — that's what gives
        // the frosted-glass look. A tint here would just darken it back to
        // looking solid.
        backgroundColor: 'transparent',
        display: 'flex', flexDirection: 'column',
        padding: '12px 0 0',
        userSelect: 'none',
        WebkitAppRegion: 'drag',
        position: 'relative',
        overflow: 'hidden',
        transition: 'width 200ms ease, min-width 200ms ease',
      } as React.CSSProperties}
    >
      <div style={{ height: 28 }} />

      {/* Header — expanded: "Lists" + collapse toggle + "+". Collapsed: toggle only, centered. */}
      <div
        style={{
          display: 'flex', alignItems: 'center',
          padding: collapsed ? '0 6px' : '0 16px',
          marginBottom: 8,
          justifyContent: collapsed ? 'center' : 'flex-start',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        {!collapsed && (
          <p style={{ flex: 1, margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--color-white)' }}>
            Lists
          </p>
        )}
        {onToggleCollapsed && (
          <button
            onClick={onToggleCollapsed}
            title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
            aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
            style={{
              background: collapsed ? 'rgba(255,255,255,0.06)' : 'none',
              border: collapsed ? '1px solid rgba(255,255,255,0.08)' : 'none',
              borderRadius: 6,
              cursor: 'pointer',
              color: 'var(--color-text-muted)',
              padding: collapsed ? 0 : '2px 6px 0 0',
              width: collapsed ? 32 : 'auto',
              height: collapsed ? 28 : 'auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'inherit',
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text-primary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-text-muted)')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="5.5" y1="2.5" x2="5.5" y2="11.5" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
          </button>
        )}
        {!collapsed && (
          <button
            onClick={() => setIsAddingList(true)}
            title="New list"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--color-text-muted)', fontSize: 16, lineHeight: 1,
              padding: '0 0 0 4px', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center',
            }}
          >
            +
          </button>
        )}
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {/* Reminders — permanent, never deletable */}
        {renderPermanentRow(REMINDERS_LIST.name, REMINDERS_LIST.iconBg, REMINDERS_LIST.iconChar)}

        {/* DB-managed lists (includes seeded sample lists + user-created) — all deletable */}
        {customLists.map(renderDeletableRow)}

        {/* Inline new-list input */}
        {isAddingList && !collapsed && (
          <div style={{ padding: '4px 8px 4px 16px' }}>
            <input
              ref={newListInputRef}
              value={newListName}
              onChange={e => setNewListName(e.target.value)}
              onKeyDown={handleNewListKeyDown}
              onBlur={handleCreateList}
              placeholder="List name"
              style={{
                width: '100%', fontSize: 13, color: 'var(--color-text-primary)',
                backgroundColor: 'var(--color-bg-surface)',
                border: '1px solid var(--color-divider)',
                borderRadius: 4, padding: '4px 6px',
                outline: 'none', fontFamily: 'inherit',
              }}
            />
          </div>
        )}

        {/* Divider + Completed — permanent, always last, never deletable */}
        <div style={{ height: 1, backgroundColor: 'var(--color-divider)', margin: '8px 8px' }} />
        {renderPermanentRow(COMPLETED_LIST.name, COMPLETED_LIST.iconBg, COMPLETED_LIST.iconContent)}
      </nav>

      {/* Profile section */}
      <div
        style={{
          padding: collapsed ? '12px 0 16px' : '12px 16px 16px',
          WebkitAppRegion: 'no-drag',
          position: 'relative',
        } as React.CSSProperties}
      >
        {userProfile ? (
          <>
            <button
              onClick={() => setShowPopover(v => !v)}
              title={collapsed ? (userProfile.name ?? userProfile.email) : undefined}
              style={{
                display: 'flex', alignItems: 'center',
                justifyContent: collapsed ? 'center' : 'flex-start',
                gap: collapsed ? 0 : 8,
                background: 'none', border: 'none', cursor: 'pointer',
                padding: 0, width: '100%', fontFamily: 'inherit',
              }}
            >
              {userProfile.avatarUrl && !pictureError ? (
                <img
                  src={userProfile.avatarUrl}
                  alt={userProfile.name ?? 'Profile'}
                  onError={() => setPictureError(true)}
                  style={{
                    width: 24, height: 24, borderRadius: 6,
                    flexShrink: 0, objectFit: 'cover',
                    border: '1px solid var(--color-divider)',
                  }}
                />
              ) : (
                <span style={{
                  width: 24, height: 24, borderRadius: 6,
                  backgroundColor: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-divider)',
                  flexShrink: 0, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 11, fontWeight: 700,
                  color: 'var(--color-text-muted)',
                }}>
                  {(userProfile.name ?? userProfile.email ?? 'U').charAt(0).toUpperCase()}
                </span>
              )}
              {!collapsed && (
                <span style={{
                  fontSize: 13, color: 'var(--color-text-primary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  flex: 1, textAlign: 'left',
                }}>
                  {userProfile.name ?? userProfile.email}
                </span>
              )}
            </button>

            {showPopover && (
              <div
                ref={popoverRef}
                style={{
                  position: 'absolute',
                  bottom: collapsed ? 0 : 'calc(100% + 4px)',
                  left: collapsed ? 'calc(100% + 4px)' : 12,
                  right: collapsed ? 'auto' : 12,
                  width: collapsed ? 200 : 'auto',
                  backgroundColor: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-divider)',
                  borderRadius: 10, padding: 12,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.5)', zIndex: 100,
                }}
              >
                <p style={{ margin: '0 0 2px', fontSize: 13, fontWeight: 600, color: 'var(--color-white)' }}>
                  {userProfile.name ?? userProfile.email}
                </p>
                <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--color-text-muted)', wordBreak: 'break-all' }}>
                  {userProfile.email}
                </p>
                <div style={{ height: 1, backgroundColor: 'var(--color-divider)', margin: '8px 0' }} />
                <button
                  onClick={handleSignOut}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: '#f87171', fontSize: 12, padding: 0,
                    fontFamily: 'inherit', width: '100%', textAlign: 'left',
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </>
        ) : (
          <button
            onClick={handleSignIn}
            disabled={isConnecting}
            title={collapsed ? (isConnecting ? 'Signing in…' : 'Sign in with Google') : undefined}
            style={{
              display: 'flex', alignItems: 'center',
              justifyContent: collapsed ? 'center' : 'flex-start',
              gap: collapsed ? 0 : 8,
              background: 'none', border: 'none',
              cursor: isConnecting ? 'default' : 'pointer',
              padding: 0, width: '100%', fontFamily: 'inherit',
              opacity: isConnecting ? 0.6 : 1,
            }}
          >
            <span style={{
              width: 24, height: 24, borderRadius: 6,
              backgroundColor: 'var(--color-bg-surface)',
              border: '1px solid var(--color-divider)',
              flexShrink: 0, display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: 12, color: 'var(--color-text-muted)',
            }}>
              G
            </span>
            {!collapsed && (
              <span style={{
                fontSize: 13, color: 'var(--color-text-muted)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                flex: 1, textAlign: 'left',
              }}>
                {isConnecting ? 'Signing in…' : 'Sign in with Google'}
              </span>
            )}
          </button>
        )}
      </div>
    </aside>
  )
}
