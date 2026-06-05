import React, { useState, useCallback, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import MainContent from './components/MainContent'
import MeetingDetail from './components/MeetingDetail'
import ReminderDetail from './components/ReminderDetail'
import DecisionsGraph from './components/DecisionsGraph'
import DecisionDetail from './components/DecisionDetail'
import { DECISIONS_VIEW } from './components/Sidebar'
import ProcessingScreen from './components/ProcessingScreen'
import RightPanel from './components/RightPanel'
import DeepgramPrivacyModal from './components/DeepgramPrivacyModal'
import UpdatePrompt from './components/UpdatePrompt'
import LoginScreen from './components/LoginScreen'
import SyncLoadingScreen from './components/SyncLoadingScreen'
import type { ListRecord, ProcessingCompletePayload } from './hooks/useIPC'
import { useOnProcessingComplete } from './hooks/useIPC'

type MainView  = 'list' | 'processing' | 'meeting-detail' | 'reminder-detail' | 'decisions-graph' | 'decision-detail'
type AuthState = 'loading' | 'unauthenticated' | 'authenticated'
type SyncState = 'idle' | 'pulling' | 'ready'

// How long to wait before showing the loading screen (fast pulls stay invisible).
const LOADING_SCREEN_DELAY_MS = 300
// Failsafe: never block the UI for longer than this even if pull never completes.
const PULL_TIMEOUT_MS         = 10_000

interface UserProfile {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
}

export default function App() {
  const [authState, setAuthState]     = useState<AuthState>('loading')
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
  const [activeList, setActiveList]     = useState('Reminders')
  const [customLists, setCustomLists]   = useState<ListRecord[]>([])
  const [mainView, setMainView]         = useState<MainView>('list')
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId]       = useState<string | null>(null)
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null)
  const [notesRefreshKey, setNotesRefreshKey] = useState(0)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('cornflake-sidebar-collapsed') === 'true' } catch { return false }
  })

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem('cornflake-sidebar-collapsed', String(next)) } catch {}
      return next
    })
  }, [])

  // Sync gating — the UI does not render real content until the first
  // pullFromCloud() resolves (or the 10s timeout fires).
  const [syncState, setSyncState]       = useState<SyncState>('idle')
  const [showLoadingScreen, setShowLoadingScreen] = useState(false)

  // Bumped every time main emits sync:dataUpdated — passed down to data-fetching
  // components so they re-query local SQLite without requiring a Cmd+R.
  const [dataVersion, setDataVersion]   = useState(0)

  // -------------------------------------------------------------------------
  // Sync event subscriptions — REGISTER BEFORE rendererReady() is invoked so
  // we never miss the pullStart/pullComplete events fired by main.
  // -------------------------------------------------------------------------
  useEffect(() => {
    window.electronAPI.onSyncPullStart(() => {
      // Only show the loading screen for the INITIAL pull. After we've reached
      // 'ready' once, periodic pulls happen silently in the background — going
      // back to 'pulling' would unmount and remount the main UI, causing a flash.
      setSyncState(prev => prev === 'ready' ? 'ready' : 'pulling')
    })
    window.electronAPI.onSyncPullComplete((_payload: unknown) => {
      // pullComplete always fires (after every pull, success or failure).
      // It only matters for the very first pull, when it unblocks the UI.
      setSyncState('ready')
      // NOTE: pullComplete does NOT bump dataVersion. Only sync:dataUpdated does.
      // That event only fires when the pull actually changed at least one row,
      // so idle periodic pulls produce no re-renders.
    })
    window.electronAPI.onSyncDataUpdated(() => {
      console.log('[App] sync:dataUpdated — bumping dataVersion')
      setDataVersion(v => v + 1)
    })
    return () => {
      window.electronAPI.removeAllListeners('sync:pullStart')
      window.electronAPI.removeAllListeners('sync:pullComplete')
      window.electronAPI.removeAllListeners('sync:dataUpdated')
    }
  }, [])

  // When the user becomes authenticated, optimistically enter the 'pulling'
  // state so the main UI doesn't flash with empty local SQLite data before
  // the pull lands.
  useEffect(() => {
    if (authState === 'authenticated' && syncState === 'idle') {
      setSyncState('pulling')
    }
  }, [authState, syncState])

  // Delay showing the loading screen by 300ms — fast pulls (<300ms) never
  // flash a spinner. After 300ms of pulling, show the screen.
  useEffect(() => {
    if (syncState !== 'pulling') {
      setShowLoadingScreen(false)
      return
    }
    const t = setTimeout(() => setShowLoadingScreen(true), LOADING_SCREEN_DELAY_MS)
    return () => clearTimeout(t)
  }, [syncState])

  // 10s failsafe — never block the UI forever if pullComplete never fires.
  useEffect(() => {
    if (syncState !== 'pulling') return
    const t = setTimeout(() => {
      console.warn('[App] pull timeout reached, rendering UI with whatever local data exists')
      setSyncState('ready')
    }, PULL_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [syncState])

  // Pull: check session on mount. Also extracts the profile so Sidebar can
  // render the user's name/avatar immediately without waiting for auth:status.
  useEffect(() => {
    window.electronAPI.getSession()
      .then((session: unknown) => {
        const profile = session as UserProfile | null
        setUserProfile(profile)
        setAuthState(profile ? 'authenticated' : 'unauthenticated')
      })
      .catch(() => setAuthState('unauthenticated'))
  }, [])

  // Push: main sends auth:login on OAuth completion and on renderer:ready when
  // a session exists. Stores the full profile so Sidebar renders immediately.
  // No rendererReady() call here — renderer:ready pushes auth:login, so calling
  // rendererReady() in response would create an infinite loop.
  useEffect(() => {
    window.electronAPI.onAuthLogin((payload: unknown) => {
      const profile = payload as UserProfile | null
      setUserProfile(profile)
      setAuthState('authenticated')
    })
    return () => window.electronAPI.removeAllListeners('auth:login')
  }, [])

  // Listen for auth:logout — fired by main after logout completes.
  useEffect(() => {
    window.electronAPI.onAuthLogout(() => {
      setUserProfile(null)
      setAuthState('unauthenticated')
    })
    return () => window.electronAPI.removeAllListeners('auth:logout')
  }, [])

  // On every mount (Cmd+R): signal main to restore session + push calendar events.
  useEffect(() => {
    window.electronAPI.rendererReady().catch(() => {})
  }, [])

  // After authState transitions to 'authenticated' (fresh login or session restore),
  // call rendererReady() again so that newly-mounted child components receive
  // auth:status and calendar:eventsUpdated.
  // Note: rendererReady must NEVER be tied to syncState changes — pull completion
  // triggers syncState=ready, and calling rendererReady() there would re-trigger
  // a pull, which would set syncState=pulling→ready, which would call rendererReady
  // again, in an infinite loop.
  useEffect(() => {
    if (authState === 'authenticated') {
      window.electronAPI.rendererReady().catch(() => {})
    }
  }, [authState])

  // ---------------------------------------------------------------------------
  // processing:complete — fired by main process after transcription + inference
  // Speaker identification is now fully automatic (LLM inference + heuristics).
  // Unresolved speakers are labelled "Speaker N" and resolved inline in the UI.
  // ---------------------------------------------------------------------------

  const handleProcessingComplete = useCallback((payload: ProcessingCompletePayload) => {
    console.log('[Renderer] processing:complete received', payload)
    // Ack immediately so the main-process polling loop stops re-sending
    window.electronAPI.ackProcessingComplete()
    // Navigate to meeting-detail regardless of pipeline errors — the meeting row
    // exists in the DB and partial data (transcript, partial notes) is still useful.
    if (payload.meetingId) {
      setSelectedMeetingId(payload.meetingId)
      setMainView('meeting-detail')
      setNotesRefreshKey(k => k + 1)
      // Bump dataVersion so MainContent (task lists) and DecisionsGraph re-fetch
      // from local SQLite immediately — extraction already wrote there before
      // sending this event.
      setDataVersion(v => v + 1)
    }
    if (payload.error) {
      console.error('[App] Pipeline error:', payload.error)
    }
  }, [])

  useOnProcessingComplete(handleProcessingComplete)

  // ---------------------------------------------------------------------------
  // Other navigation handlers
  // ---------------------------------------------------------------------------

  // Sidebar list selection is global navigation. The DECISIONS_VIEW sentinel
  // routes to the standalone DecisionsList view; everything else is a tasks
  // list and goes to MainContent.
  const handleListSelect = useCallback((name: string) => {
    setActiveList(name)
    setSelectedMeetingId(null)
    setSelectedTaskId(null)
    setSelectedDecisionId(null)
    setMainView(name === DECISIONS_VIEW ? 'decisions-graph' : 'list')
  }, [])

  const handleDecisionSelect = useCallback((id: string) => {
    setSelectedDecisionId(id)
    setMainView('decision-detail')
  }, [])

  const handleDecisionDeleted = useCallback(() => {
    setSelectedDecisionId(null)
    setMainView('decisions-graph')
  }, [])

  const handleListCreated = useCallback((list: ListRecord) => {
    setCustomLists(prev => [...prev, list])
    handleListSelect(list.name)
  }, [handleListSelect])

  const handleListDeleted = useCallback((listId: string) => {
    setCustomLists(prev => prev.filter(l => l.id !== listId))
  }, [])

  // Called by RightPanel when "Stop and review" is clicked — show loading screen immediately
  const handleRecordingStopped = useCallback(() => {
    setMainView('processing')
  }, [])

  const handleTaskSelect = useCallback((taskId: string) => {
    setSelectedTaskId(taskId)
    setMainView('reminder-detail')
  }, [])

  const handleTaskDelete = useCallback((taskId: string) => {
    void taskId  // task already dismissed by ReminderDetail
    setMainView('list')
    setSelectedTaskId(null)
  }, [])

  const handleMeetingSelect = useCallback((meetingId: string) => {
    setSelectedMeetingId(meetingId)
    setMainView('meeting-detail')
  }, [])

  const handleBackToList = useCallback(() => {
    // Coming from a decision detail or from MeetingDetail-while-on-decisions
    // should return to the decisions list, not the tasks list.
    setSelectedMeetingId(null)
    setSelectedTaskId(null)
    setSelectedDecisionId(null)
    setMainView(activeList === DECISIONS_VIEW ? 'decisions-graph' : 'list')
  }, [activeList])

  // Show nothing while we check the session (avoids a flash of login screen)
  if (authState === 'loading') {
    return (
      <div style={{
        width: '100vw', height: '100vh',
        backgroundColor: 'var(--color-bg-deep)',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties} />
    )
  }

  if (authState === 'unauthenticated') {
    return <LoginScreen />
  }

  // Authenticated but the initial pull hasn't finished. Hold the main UI back
  // so it doesn't render with empty local SQLite. If the pull is fast (<300ms),
  // we render a blank background; if it takes longer, swap in the loading screen.
  if (syncState === 'pulling') {
    return showLoadingScreen
      ? <SyncLoadingScreen />
      : <div style={{
          width: '100vw', height: '100vh',
          backgroundColor: 'var(--color-bg-deep)',
          WebkitAppRegion: 'drag',
        } as React.CSSProperties} />
  }

  return (
    <>
      <DeepgramPrivacyModal />
      <UpdatePrompt />

      <div
        style={{
          display: 'flex',
          height: '100vh',
          overflow: 'hidden',
          // Transparent so the window vibrancy shows through behind the
          // sidebar. MainContent + RightPanel each paint their own opaque
          // background, so the vibrancy only shows in the sidebar region.
          backgroundColor: 'transparent',
        }}
      >
        <Sidebar
          activeList={activeList}
          customLists={customLists}
          onListSelect={handleListSelect}
          onListCreated={handleListCreated}
          onCustomListsLoaded={setCustomLists}
          onListDeleted={handleListDeleted}
          userProfile={userProfile}
          dataVersion={dataVersion}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleSidebar}
        />


        {mainView === 'list' && (
          <MainContent
            activeList={activeList}
            onMeetingSelect={handleMeetingSelect}
            onTaskSelect={handleTaskSelect}
            dataVersion={dataVersion}
          />
        )}
        {mainView === 'processing' && <ProcessingScreen />}
        {mainView === 'reminder-detail' && (
          <ReminderDetail
            key={selectedTaskId}
            taskId={selectedTaskId!}
            onBack={handleBackToList}
            onDelete={handleTaskDelete}
            onMeetingSelect={handleMeetingSelect}
          />
        )}
        {mainView === 'meeting-detail' && (
          <MeetingDetail
            key={selectedMeetingId}
            meetingId={selectedMeetingId!}
            onBack={handleBackToList}
            onTasksApproved={() => setNotesRefreshKey(k => k + 1)}
            onDecisionSelect={handleDecisionSelect}
            dataVersion={dataVersion}
          />
        )}
        {mainView === 'decisions-graph' && (
          <DecisionsGraph
            onDecisionSelect={handleDecisionSelect}
            onBack={() => handleListSelect('Reminders')}
            dataVersion={dataVersion}
          />
        )}
        {mainView === 'decision-detail' && (
          <DecisionDetail
            key={selectedDecisionId}
            decisionId={selectedDecisionId!}
            onBack={handleBackToList}
            onDelete={handleDecisionDeleted}
            onMeetingSelect={handleMeetingSelect}
            onDecisionSelect={handleDecisionSelect}
          />
        )}

        <RightPanel
          onMeetingSelect={handleMeetingSelect}
          onCurrentMeetingDeleted={handleBackToList}
          onRecordingStopped={handleRecordingStopped}
          notesRefreshKey={notesRefreshKey + dataVersion}
          selectedMeetingId={selectedMeetingId}
        />
      </div>
    </>
  )
}
