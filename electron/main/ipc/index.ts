import { app, ipcMain, BrowserWindow, shell } from 'electron'
import { RENDERER_CHANNELS, MAIN_CHANNELS } from './types'
import { getDb } from '../modules/database'
import {
  startManualRecording,
  isCalendarConnected,
  startCalendarWatcher,
  sendDisplayEventsToRenderer,
  resendCachedEventsToRenderer,
  triggerPoll,
  disconnectCalendar,
  broadcastAuthStatus,
  getCachedDisplayEvents,
} from '../modules/calendar-watcher'
import {
  initiateLogin,
  getSession,
  logout,
  refreshSession,
  clearTokens,
  stopCallbackServer,
} from '../modules/auth'
import { startCapture, stopCapture } from '../modules/audio-capture'
import {
  ensureMicAccess,
  openMicSettings,
  openScreenSettings,
} from '../modules/permissions'
import { checkForUpdates, openReleasePage } from '../modules/updater'
import { runTranscriptionPipeline } from '../modules/transcription'
import { inferSpeakers, updateVoiceProfiles } from '../modules/speaker-inference'
import { runExtractionPipeline, generateCommsForMeeting } from '../modules/llm/extraction'
import { showTaskNotifications, executeTaskAction } from '../modules/action-router'
import { recordCalendarBlock, recordContactMapping, setMubitUser } from '../modules/action-router/mubit-client.js'
import { chatForAction, sendViaGmail, addGoogleCalendarEvent, launchClaudeCode, listClaudeProjects, classifyActionType } from '../modules/action-chat/index.js'
import { sendComms } from '../modules/comms-dispatch'
import { syncModule } from '../modules/sync'
import { setRefreshHandler, apiGet, apiPost } from '../modules/api-client'

// Each handler is replaced with real implementations as modules are built.

// Tracks the meeting ID for the currently active recording session
let _activeMeetingId:     string | null = null
// System audio path kept after stop so PROFILES_UPDATE can reference it
let _lastSystemAudioPath: string | null = null
// Ack timeout handle — cleared when the renderer acknowledges processing:complete
let _ackTimeout: ReturnType<typeof setTimeout> | null = null
// In-memory session for the current app launch. Set on the first successful
// renderer:ready (or after handleCallback), reused on every Cmd+R so we don't
// re-query Keychain or re-trigger sync.init / pullFromCloud each time.
let _activeSession: { id: string; email: string; name: string | null; avatarUrl: string | null } | null = null
let _bootSyncStarted = false

// Tray hooks — wired by main/index.ts after registerIpcHandlers. We can't
// import them directly without creating a static circular dependency.
let _setTrayAuth:      (authed: boolean) => void                                       = () => {}
let _setTrayRecording: (payload: { meetingId: string; title: string } | null) => void = () => {}

export function registerTrayHooks(hooks: {
  setAuth:      (authed: boolean) => void
  setRecording: (payload: { meetingId: string; title: string } | null) => void
}): void {
  _setTrayAuth      = hooks.setAuth
  _setTrayRecording = hooks.setRecording
  // Apply current state immediately so the tray reflects whatever auth/recording
  // state was already established by the time tray hooks are wired.
  _setTrayAuth(_activeSession !== null)
}

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // Wire the sync module so it can emit IPC events to the renderer
  syncModule.setMainWindow(mainWindow)

  // ---------------------------------------------------------------------------
  // Token refresh handler — called by api-client on any 401 response.
  // Attempts silent token refresh; forces logout if refresh fails.
  // ---------------------------------------------------------------------------

  setRefreshHandler(async (): Promise<boolean> => {
    console.log('[ipc] refresh handler: attempting silent token refresh...')
    const profile = await refreshSession()

    if (profile) {
      console.log('[ipc] refresh handler: token refreshed for', profile.email)
      // Re-init sync so the new user ID is picked up
      syncModule.init(profile.id, {
        email:     profile.email,
        name:      profile.name,
        avatarUrl: profile.avatarUrl,
      })
      return true
    }

    // Refresh failed — session is truly dead, force logout
    console.warn('[ipc] refresh handler: refresh failed, forcing logout')
    await clearTokens()
    getDb().deleteUserProfile()
    getDb().deleteMetaValue('workos_user_id')
    _activeSession = null
    _bootSyncStarted = false
    _setTrayAuth(false)
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(MAIN_CHANNELS.AUTH_LOGOUT)
    }
    return false
  })

  // ---------------------------------------------------------------------------
  // renderer:ready — sent by the renderer on every mount (including Cmd+R reloads)
  // Responds with the current auth state so the renderer always has fresh data.
  // ---------------------------------------------------------------------------

  ipcMain.handle(RENDERER_CHANNELS.RENDERER_READY, async () => {
    // Reuse the in-memory session if we already restored it on this launch.
    // This makes Cmd+R a pure UI re-mount: no Keychain reads, no sync re-init,
    // no calendar restart. Only the first renderer:ready (cold start or after
    // a fresh sign-in) actually hits getSession() / starts the watcher.
    let session = _activeSession
    if (!session) {
      session = await getSession().catch(() => null)
      if (session) _activeSession = session
    }

    console.log('[ipc] renderer:ready —',
      session ? `session=${session.email} (cached=${session === _activeSession})` : 'no session')

    _setTrayAuth(session !== null)

    if (session) {
      mainWindow.webContents.send(MAIN_CHANNELS.AUTH_LOGIN, session)

      // Sync + calendar startup runs exactly once per app launch. Cmd+R reloads
      // get the AUTH_LOGIN push and the cached calendar events below, but skip
      // the heavy re-init / re-pull.
      if (!_bootSyncStarted && session.id) {
        _bootSyncStarted = true
        syncModule.init(session.id, {
          email:     session.email,
          name:      session.name,
          avatarUrl: session.avatarUrl,
        })
        syncModule.pullFromCloud()
          .then(() => syncModule.startPeriodicPull())
          .catch(err => console.warn('[sync] renderer:ready pull failed:', (err as Error).message))

        startCalendarWatcher(mainWindow)
      }
    }

    await broadcastAuthStatus(mainWindow).catch(err =>
      console.error('[ipc] broadcastAuthStatus failed on renderer:ready:', err)
    )
    resendCachedEventsToRenderer(mainWindow)
    return null
  })

  // Renderer sends this immediately on receiving processing:complete.
  ipcMain.on(RENDERER_CHANNELS.PROCESSING_ACK, () => {
    if (_ackTimeout !== null) {
      clearTimeout(_ackTimeout)
      _ackTimeout = null
    }
  })

  // ---------------------------------------------------------------------------
  // Module 3 — Recording trigger (manual quick-start)
  // ---------------------------------------------------------------------------

  ipcMain.handle(RENDERER_CHANNELS.RECORDING_START_MANUAL, async (_e, opts?: { calendarEventId?: string }) => {
    // 1. Gate on Microphone permission only. If 'not-determined', this fires
    //    the macOS system prompt and waits for the user's answer. If still not
    //    granted afterwards, abort BEFORE starting the audio addon — the
    //    renderer surfaces an inline message with a deep-link to Settings.
    const micStatus = await ensureMicAccess()
    if (micStatus !== 'granted') {
      console.warn('[recording] aborting startManual — mic permission:', micStatus)
      return {
        ok: false,
        code: 'mic_denied',
        message: 'Microphone access is required to record meetings. Enable it in System Settings → Privacy & Security → Microphone.',
      }
    }

    // 2. Start audio capture. The CoreAudio Process Tap inside the addon will
    //    raise the System Audio Recording prompt the first time it's invoked
    //    (kTCCServiceAudioCapture). If the user declines or the tap fails for
    //    any other reason, surface the addon's error verbatim.
    try {
      await startCapture()
    } catch (err) {
      const raw = (err as Error).message || ''
      console.error('[recording] startCapture failed:', raw)

      // Addon prefixes: AUDIO_TAP_CREATE_FAILED:<status>, AUDIO_AGGREGATE_CREATE_FAILED:<status>,
      // AUDIO_TAP_UID_FAILED, AUDIO_SET_DEVICE_FAILED:<status>, AUDIO_ENGINE_FAILED:<msg>.
      // A TCC denial from AudioHardwareCreateProcessTap typically returns
      // kAudio_NotPermittedError (1852797029) → AUDIO_TAP_CREATE_FAILED:1852797029.
      if (raw.startsWith('AUDIO_TAP_CREATE_FAILED:1852797029') ||
          raw.startsWith('AUDIO_TAP_CREATE_FAILED:-1')) {
        return {
          ok: false,
          code: 'audio_denied',
          message: 'System Audio Recording access is required. Enable Cornflake in System Settings → Privacy & Security → System Audio Recording Only, then try again.',
        }
      }

      return {
        ok: false,
        code: 'capture_failed',
        message: `Could not start recording: ${raw}`,
      }
    }

    const payload = startManualRecording({ calendarEventId: opts?.calendarEventId })
    _activeMeetingId = payload.meetingId
    mainWindow.webContents.send(MAIN_CHANNELS.RECORDING_STARTED, payload)
    _setTrayRecording(payload)
    return { ok: true, ...payload }
  })

  // ---------------------------------------------------------------------------
  // Permissions — deep links only. There is no permissions:check IPC; the
  // renderer never pre-checks state. Errors are inline at the click site.
  // ---------------------------------------------------------------------------

  ipcMain.handle(RENDERER_CHANNELS.PERMISSIONS_OPEN_MIC, async () => {
    openMicSettings()
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.PERMISSIONS_OPEN_SCREEN, async () => {
    openScreenSettings()
    return null
  })

  // Open an arbitrary URL in the user's default browser. Only http(s) is
  // accepted — anything else (file://, custom schemes) is rejected so a stray
  // meetingLink can't be used to launch local apps.
  ipcMain.handle(RENDERER_CHANNELS.SHELL_OPEN_EXTERNAL, async (_e, url: string) => {
    if (typeof url !== 'string') return null
    if (!/^https?:\/\//i.test(url)) return null
    shell.openExternal(url).catch(err => {
      console.error('[ipc] shell.openExternal failed:', err)
    })
    return null
  })

  // Quit + relaunch — used by the inline "needs_restart" error to pick up a
  // freshly-granted Screen Recording TCC entry.
  ipcMain.handle(RENDERER_CHANNELS.APP_RELAUNCH, async () => {
    app.relaunch()
    app.quit()
    return null
  })

  // ---------------------------------------------------------------------------
  // Auto-update — check on demand and install when the user accepts
  // ---------------------------------------------------------------------------

  ipcMain.handle(RENDERER_CHANNELS.UPDATE_CHECK, async () => {
    checkForUpdates('manual')
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.UPDATE_INSTALL, async () => {
    openReleasePage()
    return null
  })

  // ---------------------------------------------------------------------------
  // Decisions — global list + detail + edit + delete.
  // Sidebar Decisions entry reads getAll; the detail view reads getById and
  // the inline lineage section's children come from the same get-all set so
  // we don't need a dedicated children endpoint here.
  // ---------------------------------------------------------------------------

  ipcMain.handle(RENDERER_CHANNELS.DECISIONS_GET_ALL, async () => {
    return getDb().getAllDecisions()
  })

  ipcMain.handle(RENDERER_CHANNELS.DECISIONS_GET_BY_ID, async (_e, id: string) => {
    const db = getDb()
    const decision = db.getDecisionById(id)
    if (!decision) return null
    // Hydrate everything the detail view needs in one round-trip: meeting
    // title (for the "from" link), speaker name (for "decided by"), parent
    // decision (for "stems from"), and children (for "referenced by").
    const meeting = db.getMeetingById(decision.meetingId)
    const speakers = db.getSpeakersByMeeting(decision.meetingId)
    const speaker  = decision.decidedBySpeakerId
      ? speakers.find(s => s.id === decision.decidedBySpeakerId) ?? null
      : null
    const parent   = decision.parentDecisionId
      ? db.getDecisionById(decision.parentDecisionId)
      : null
    const children = db.getChildDecisions(decision.id)
    return {
      decision,
      meetingTitle: meeting?.title ?? null,
      speakerName:  speaker?.name ?? null,
      parent,
      children,
    }
  })

  ipcMain.handle(RENDERER_CHANNELS.DECISIONS_UPDATE_TEXT, async (_e, payload: { id: string; text: string }) => {
    const text = (payload?.text ?? '').trim()
    if (!payload?.id || !text) return null
    getDb().updateDecisionText(payload.id, text)
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.DECISIONS_DELETE, async (_e, id: string) => {
    if (!id) return null
    getDb().deleteDecision(id)
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.ACTION_EXECUTE, async (_e, payload: { taskId: string; taskTitle: string; actionType: string }) => {
    await executeTaskAction(payload.taskId, payload.taskTitle, payload.actionType as import('../modules/database').ActionType)
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.ACTION_CHAT, async (_e, payload: {
    taskTitle: string
    actionType: 'EMAIL' | 'CALENDAR' | 'CLAUDE_CODE'
    meetingId: string
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  }) => {
    return chatForAction(payload.taskTitle, payload.actionType, payload.meetingId, payload.messages)
  })

  ipcMain.handle(RENDERER_CHANNELS.ACTION_SEND_EMAIL, async (_e, payload: {
    toName: string; toEmail: string; subject: string; body: string
  }) => {
    const session   = _activeSession
    const fromName  = session?.name ?? session?.email ?? 'Cornflake User'
    const fromEmail = session?.email ?? ''
    if (payload.toName && payload.toEmail) {
      recordContactMapping(payload.toName, payload.toEmail).catch(() => {})
    }
    try {
      await sendViaGmail(payload.toName, payload.toEmail, payload.subject, payload.body, fromName, fromEmail)
      return { success: true, method: 'gmail' }
    } catch (err) {
      const msg = (err as Error).message ?? ''
      // Gmail API not enabled or scope not yet granted → fall back to mailto
      const isApiDisabled = msg.includes('has not been used') || msg.includes('disabled') || msg.includes('accessNotConfigured')
      const isScopeError  = msg.includes('insufficient') || msg.includes('scope') || msg.includes('403')
      if (isApiDisabled || isScopeError) {
        console.warn('[action:sendEmail] Gmail API unavailable, falling back to mailto:', msg)
        const to      = payload.toEmail ? encodeURIComponent(payload.toEmail) : ''
        const subject = encodeURIComponent(payload.subject)
        const body    = encodeURIComponent(payload.body)
        shell.openExternal(`mailto:${to}?subject=${subject}&body=${body}`)
        return { success: true, method: 'mailto' }
      }
      throw err
    }
  })

  ipcMain.handle(RENDERER_CHANNELS.ACTION_ADD_CALENDAR, async (_e, payload: {
    title: string; dateIso: string; time: string; durationMin: number; description: string
  }) => {
    const link = await addGoogleCalendarEvent(payload.title, payload.dateIso, payload.time, payload.durationMin, payload.description)
    const [hourStr] = payload.time.split(':')
    recordCalendarBlock({
      taskTitle:   payload.title,
      actionType:  'CALENDAR',
      dateIso:     payload.dateIso,
      time:        payload.time,
      hourOfDay:   parseInt(hourStr ?? '9', 10),
      dayOfWeek:   new Date(payload.dateIso).getDay(),
      durationMin: payload.durationMin,
      outcome:     'confirmed',
    }).catch(err => console.warn('[mubit] calendar block record failed:', err))
    return { success: true, link }
  })

  ipcMain.handle(RENDERER_CHANNELS.ACTION_LIST_PROJECTS, async () => {
    return listClaudeProjects()
  })

  ipcMain.handle('action:launchClaude', async (_e, payload: {
    contextMd: string; claudeProjectDir?: string | null
  }) => {
    await launchClaudeCode(payload.contextMd, payload.claudeProjectDir ?? null)
    return { success: true }
  })

  // ---------------------------------------------------------------------------
  // Auth — WorkOS SSO
  // ---------------------------------------------------------------------------

  ipcMain.handle(RENDERER_CHANNELS.AUTH_INITIATE_LOGIN, async () => {
    await initiateLogin(mainWindow, async (profile) => {
      // 1. Cache session in memory so future renderer:ready calls (Cmd+R) skip
      //    Keychain + sync re-init.
      _activeSession = profile
      setMubitUser(profile.id)
      _bootSyncStarted = true
      _setTrayAuth(true)

      // 2. Bring the window back to the front BEFORE broadcasting AUTH_LOGIN.
      //    macOS may queue IPC delivery to a backgrounded webContents (the user
      //    is in the browser during OAuth), causing the renderer to never see
      //    auth:login until something else nudges it (like Cmd+R). Showing +
      //    focusing flushes the queue and guarantees delivery.
      if (mainWindow.isDestroyed()) {
        console.error('[ipc] AUTH_INITIATE_LOGIN onSuccess: mainWindow destroyed')
        return
      }
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
      if (process.platform === 'darwin') app.focus({ steal: true })

      // 3. Wait for the renderer to be done loading before sending — otherwise
      //    a navigation-in-progress drops the message.
      if (mainWindow.webContents.isLoading()) {
        console.log('[ipc] AUTH_INITIATE_LOGIN onSuccess: waiting for renderer load to finish')
        await new Promise<void>(resolve => {
          mainWindow.webContents.once('did-finish-load', () => resolve())
          // Safety timeout — never block forever.
          setTimeout(() => resolve(), 3000)
        })
      }

      // 4. Broadcast AUTH_LOGIN. This is the signal the renderer listens for
      //    to transition from LoginScreen → main UI.
      mainWindow.webContents.send(MAIN_CHANNELS.AUTH_LOGIN, profile)
      console.log('[ipc] auth:login broadcast after OAuth callback for', profile.email)

      // 5. Push auth:status (used by RightPanel etc.) so children also rehydrate.
      await broadcastAuthStatus(mainWindow).catch(err =>
        console.error('[ipc] broadcastAuthStatus after OAuth failed:', err)
      )

      // 6. Start sync + calendar — these used to be triggered via the renderer's
      //    post-login renderer:ready, but with the in-memory session cache the
      //    rendererReady handler short-circuits, so we have to start them here.
      syncModule.init(profile.id, {
        email:     profile.email,
        name:      profile.name,
        avatarUrl: profile.avatarUrl,
      })
      syncModule.pullFromCloud()
        .then(() => syncModule.startPeriodicPull())
        .catch(err => console.warn('[sync] Post-login pull failed:', (err as Error).message))

      startCalendarWatcher(mainWindow)
    })
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.AUTH_GET_SESSION, async () => {
    return getSession()
  })

  ipcMain.handle(RENDERER_CHANNELS.AUTH_LOGOUT, async () => {
    stopCallbackServer()   // cancel any in-progress login
    disconnectCalendar()
    syncModule.stop()      // clear periodic pull timer and pending queue
    mainWindow.webContents.send(MAIN_CHANNELS.CALENDAR_EVENTS_UPDATED, [])
    await logout(mainWindow)
    _activeSession = null
    _bootSyncStarted = false
    _setTrayAuth(false)
    return null
  })

  // ---------------------------------------------------------------------------
  // Module 3 — Calendar connect
  // In Phase 2A calendar is always connected when the user is signed in via
  // WorkOS. This handler now initiates the WorkOS login flow.
  // ---------------------------------------------------------------------------

  ipcMain.handle(RENDERER_CHANNELS.CALENDAR_CONNECT, async () => {
    await initiateLogin(mainWindow, async () => {
      await broadcastAuthStatus(mainWindow)
      // Calendar watcher start is handled by renderer:ready (single call site).
      mainWindow.show()
    })
    return { connected: true }
  })

  ipcMain.handle(RENDERER_CHANNELS.CALENDAR_STATUS, async () => {
    return { isConnected: await isCalendarConnected() }
  })

  // Returns the current cached upcoming events. Called by RightPanel on mount
  // to handle the case where the watcher pushed CALENDAR_EVENTS_UPDATED before
  // the renderer was listening (e.g. during SyncLoadingScreen → main UI swap).
  ipcMain.handle(RENDERER_CHANNELS.CALENDAR_GET_EVENTS, async () => {
    return getCachedDisplayEvents()
  })

  // ---------------------------------------------------------------------------
  // Module 4 + 5 + 6 — Audio capture stop → transcription → speaker inference
  // ---------------------------------------------------------------------------

  ipcMain.handle(RENDERER_CHANNELS.RECORDING_STOP, async () => {
    const paths = await stopCapture()
    const meetingId = _activeMeetingId
    _activeMeetingId = null
    _setTrayRecording(null)

    if (meetingId) {
      const db = getDb()
      db.finalizeMeeting(meetingId, Date.now())
      _lastSystemAudioPath = paths.systemAudioPath

      // Transcription → speaker inference (heuristics + LLM) → LLM extraction
      // Never blocks on manual labelling — unresolved speakers are labelled "Speaker N"
      // and the UI shows inline nudges for medium-confidence and unresolved speakers.
      const sendProcessingComplete = (payload: Record<string, unknown>) => {
        if (mainWindow.isDestroyed()) {
          console.warn('[Main] mainWindow destroyed — cannot send processing:complete')
          return
        }
        if (_ackTimeout !== null) clearTimeout(_ackTimeout)
        mainWindow.webContents.send(MAIN_CHANNELS.PROCESSING_COMPLETE, payload)
        _ackTimeout = setTimeout(() => {
          console.warn('[Main] processing:complete: no ack from renderer after 2s — listener may be missing')
          _ackTimeout = null
        }, 2000)
      }

      runTranscriptionPipeline(paths, meetingId)
        .then(async transcript => {
          const inferResult = await inferSpeakers(transcript, meetingId, paths.systemAudioPath)
          const reviewPayload = await runExtractionPipeline(meetingId)

          // Fire native macOS notifications — one per extracted task with its action type.
          // Shown after extraction so action types are already classified and stored.
          const meeting = getDb().getMeetingById(meetingId)
          if (meeting) {
            showTaskNotifications(reviewPayload.tasks, meeting.title)
          }

          sendProcessingComplete({
            meetingId,
            requiresManualLabelling: inferResult.requiresManualLabelling,
            unresolvedSpeakers:      inferResult.unresolvedSpeakers,
            reviewPayload,
          })
        })
        .catch((err: Error) => {
          console.error('[pipeline] Failed:', err.message, err.stack)
          sendProcessingComplete({
            meetingId,
            requiresManualLabelling: false,
            unresolvedSpeakers:      [],
            error:                   err.message,
          })
        })
        .finally(async () => {
          // Delete WAV files once transcription is done (success or failure).
          // Voice-profile updates still need the systemAudioPath, so keep it until
          // the next recording overwrites _lastSystemAudioPath. Only the mic WAV
          // is unconditionally safe to remove here.
          const fs = await import('fs/promises')
          fs.unlink(paths.micPath).catch(() => {})
        })
    }

    return { meetingId }
  })

  ipcMain.handle(RENDERER_CHANNELS.RECORDING_DISCARD, async () => {
    _activeMeetingId = null
    _setTrayRecording(null)
    const paths = await stopCapture().catch(() => null)
    if (paths) {
      const fs = await import('fs/promises')
      fs.unlink(paths.micPath).catch(() => {})
      fs.unlink(paths.systemAudioPath).catch(() => {})
    }
    return null
  })

  // ---------------------------------------------------------------------------
  // Module 2 (DB) — update meeting title
  // ---------------------------------------------------------------------------

  ipcMain.handle(RENDERER_CHANNELS.RECORDING_UPDATE_TITLE, async (_event, payload: { meetingId: string; title: string }) => {
    getDb().updateMeetingTitle(payload.meetingId, payload.title)
    return null
  })

  // ---------------------------------------------------------------------------
  // Tasks confirm — update task statuses, generate comms copy for assignees
  // ---------------------------------------------------------------------------

  ipcMain.handle(RENDERER_CHANNELS.TASKS_CONFIRM, async (
    _event,
    payload: {
      meetingId: string
      confirmedTaskIds: string[]
      dismissedTaskIds: string[]
    }
  ) => {
    const db = getDb()

    for (const id of (payload.confirmedTaskIds ?? [])) db.confirmTask(id)
    for (const id of (payload.dismissedTaskIds  ?? [])) db.dismissTask(id)

    console.log(`[tasks:confirm] meetingId=${payload.meetingId} confirmed=${payload.confirmedTaskIds?.length ?? 0} dismissed=${payload.dismissedTaskIds?.length ?? 0}`)

    const comms = await generateCommsForMeeting(payload.meetingId)
    const reviewPayload = db.getMeetingReviewPayload(payload.meetingId)

    console.log(`[tasks:confirm] Generated ${comms.length} comms record(s)`)
    return reviewPayload
  })

  // ---------------------------------------------------------------------------
  // Module 7 — Comms dispatch
  // ---------------------------------------------------------------------------

  ipcMain.handle(RENDERER_CHANNELS.COMMS_SEND, async (_event, payload: { meetingId: string }) => {
    const result = await sendComms(payload.meetingId)
    mainWindow.webContents.send(MAIN_CHANNELS.COMMS_SENT, result)
    return result
  })

  // ---------------------------------------------------------------------------
  // Module 6 — Speaker labelling + voice profile update
  // ---------------------------------------------------------------------------

  ipcMain.handle(RENDERER_CHANNELS.SPEAKERS_LABEL, async (
    _event,
    payload: { meetingId: string; resolutions: Array<{ speakerId: string; name: string; email?: string }> }
  ) => {
    const db = getDb()
    db.bulkResolveSpeakers(payload.resolutions)
    db.setMeetingRequiresLabelling(payload.meetingId, false)
    console.log(`[speakers:label] Resolved ${payload.resolutions.length} speaker(s) for meeting ${payload.meetingId}`)
    for (const r of payload.resolutions) {
      if (r.email) {
        recordContactMapping(r.name, r.email)
          .catch(err => console.warn('[mubit] contact record failed:', err))
      }
    }

    // Now that all speakers are named, run LLM extraction
    runExtractionPipeline(payload.meetingId)
      .then(reviewPayload => {
        const meeting = getDb().getMeetingById(payload.meetingId)
        if (meeting) showTaskNotifications(reviewPayload.tasks, meeting.title)
        mainWindow.webContents.send(MAIN_CHANNELS.PROCESSING_COMPLETE, {
          meetingId:               payload.meetingId,
          requiresManualLabelling: false,
          unresolvedSpeakers:      [],
          reviewPayload,
        })
      })
      .catch((err: Error) => {
        console.error('[llm-extraction] Failed after manual labelling:', err.message)
        mainWindow.webContents.send(MAIN_CHANNELS.PROCESSING_COMPLETE, {
          meetingId:               payload.meetingId,
          requiresManualLabelling: false,
          unresolvedSpeakers:      [],
          error:                   err.message,
        })
      })

    return null
  })

  // Confirm a medium-confidence speaker (user taps ✓ on "Is this [name]?" nudge)
  ipcMain.handle(RENDERER_CHANNELS.SPEAKERS_CONFIRM, async (
    _event,
    payload: { meetingId: string; speakerId: string }
  ) => {
    const db = getDb()
    // Upgrade confidence to 'manual' — the name was already set by LLM inference
    const speakers = db.getSpeakersByMeeting(payload.meetingId)
    const speaker = speakers.find(s => s.id === payload.speakerId)
    if (speaker?.name) {
      db.resolveSpeaker(payload.speakerId, speaker.name, 'manual')
      const audioPath = _lastSystemAudioPath
      if (audioPath) {
        updateVoiceProfiles(
          [{ speakerId: payload.speakerId, name: speaker.name, email: speaker.email ?? undefined }],
          payload.meetingId,
          audioPath,
        ).catch(err => console.warn('[speakers:confirm] Profile update failed:', (err as Error).message))
      }
    }
    return null
  })

  // Resolve an unresolved "Speaker N" with user-entered name (from "Who is this?" popover)
  ipcMain.handle(RENDERER_CHANNELS.SPEAKERS_RESOLVE, async (
    _event,
    payload: { meetingId: string; speakerId: string; name: string; email?: string }
  ) => {
    const db = getDb()
    db.bulkResolveSpeakers([{ speakerId: payload.speakerId, name: payload.name, email: payload.email }])
    if (payload.email) {
      recordContactMapping(payload.name, payload.email)
        .catch(err => console.warn('[mubit] contact record failed:', err))
    }
    // Re-check if any speakers remain unresolved
    const remaining = db.getSpeakersByMeeting(payload.meetingId).filter(s => !s.isSelf && s.name === null)
    db.setMeetingRequiresLabelling(payload.meetingId, remaining.length > 0)
    const audioPath = _lastSystemAudioPath
    if (audioPath) {
      updateVoiceProfiles(
        [{ speakerId: payload.speakerId, name: payload.name, email: payload.email }],
        payload.meetingId,
        audioPath,
      ).catch(err => console.warn('[speakers:resolve] Profile update failed:', (err as Error).message))
    }
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.PROFILES_UPDATE, async (
    _event,
    payload: { meetingId: string; corrections: Array<{ speakerId: string; name: string; email?: string }> }
  ) => {
    const audioPath = _lastSystemAudioPath
    if (!audioPath) {
      console.warn('[profiles:update] No system audio path available; skipping')
      return null
    }
    // Fire and forget — don't block the renderer on embedding computation
    updateVoiceProfiles(payload.corrections, payload.meetingId, audioPath).catch(err => {
      console.error('[profiles:update] Failed:', (err as Error).message)
    })
    return null
  })

  // ---------------------------------------------------------------------------
  // Calendar profile + disconnect
  // ---------------------------------------------------------------------------

  ipcMain.handle(RENDERER_CHANNELS.CALENDAR_GET_PROFILE, async () => {
    return getDb().getUserProfile() ?? { name: null, email: null }
  })

  ipcMain.handle(RENDERER_CHANNELS.CALENDAR_DISCONNECT, async () => {
    disconnectCalendar()
    mainWindow.webContents.send(MAIN_CHANNELS.CALENDAR_EVENTS_UPDATED, [])
    await logout(mainWindow)
    _activeSession = null
    _bootSyncStarted = false
    _setTrayAuth(false)
    return { success: true }
  })

  // ---------------------------------------------------------------------------
  // Standalone task creation + list queries
  // ---------------------------------------------------------------------------

  ipcMain.handle(RENDERER_CHANNELS.TASKS_CREATE_STANDALONE, async (_event, payload: { title: string; listName: string }) => {
    return getDb().createStandaloneTask(payload.title, payload.listName)
  })

  ipcMain.handle(RENDERER_CHANNELS.TASKS_GET_BY_LIST, async (_event, listName: string) => {
    return getDb().getTasksByList(listName)
  })

  ipcMain.handle(RENDERER_CHANNELS.TASK_DISMISS, async (_event, taskId: string) => {
    getDb().dismissTask(taskId)
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.LISTS_GET_ALL, async () => {
    return getDb().getAllLists()
  })

  ipcMain.handle(RENDERER_CHANNELS.LISTS_CREATE, async (_event, name: string) => {
    return getDb().createList(name)
  })

  ipcMain.handle(RENDERER_CHANNELS.LISTS_DELETE, async (_event, listId: string) => {
    getDb().deleteList(listId)
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.TASKS_COMPLETE, async (_event, payload: { taskId: string; originList: string }) => {
    getDb().completeTask(payload.taskId, payload.originList)
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.MEETINGS_GET_PAST, async () => {
    return getDb().getPastMeetings()
  })

  ipcMain.handle(RENDERER_CHANNELS.MEETINGS_GET_TRASHED, async () => {
    return getDb().getTrashedMeetings()
  })

  ipcMain.handle(RENDERER_CHANNELS.MEETINGS_GET_DETAIL, async (_event, meetingId: string) => {
    return getDb().getMeetingDetail(meetingId)
  })

  ipcMain.handle(RENDERER_CHANNELS.MEETINGS_SOFT_DELETE, async (_event, meetingId: string) => {
    getDb().softDeleteMeeting(meetingId)
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.MEETINGS_UNDELETE, async (_event, meetingId: string) => {
    getDb().undeleteMeeting(meetingId)
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.MEETINGS_HARD_DELETE, async (_event, meetingId: string) => {
    getDb().hardDeleteMeeting(meetingId)
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.MEETINGS_RESTORE_DISMISSED, async (_event, meetingId: string) => {
    getDb().restoreDismissedTasks(meetingId)
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.TASKS_RESTORE, async (_event, taskId: string) => {
    getDb().restoreTask(taskId)
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.TASKS_HARD_DELETE, async (_event, taskId: string) => {
    getDb().hardDeleteTask(taskId)
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.TASKS_GET_BY_ID, async (_event, taskId: string) => {
    return getDb().getTaskById(taskId)
  })

  ipcMain.handle(RENDERER_CHANNELS.TASKS_UPDATE_TITLE, async (_event, payload: { taskId: string; title: string }) => {
    getDb().updateTask(payload.taskId, { title: payload.title })
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.TASKS_REORDER, async (_event, orderedIds: string[]) => {
    getDb().reorderTasks(orderedIds)
    return null
  })

  // Partial update of any task fields (used by inline edit in meeting detail)
  ipcMain.handle(RENDERER_CHANNELS.TASK_SET_ACTION_TYPE, async (
    _event,
    payload: { taskId: string; actionType: string }
  ) => {
    getDb().setTaskActionType(payload.taskId, payload.actionType as any)
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.TASK_CLASSIFY_ACTION_TYPE, async (
    _event,
    payload: { taskTitle: string; transcriptQuote?: string | null }
  ) => {
    return classifyActionType(payload.taskTitle, payload.transcriptQuote)
  })

  ipcMain.handle(RENDERER_CHANNELS.TASKS_UPDATE, async (
    _event,
    payload: {
      taskId: string
      title?: string
      deadlineText?: string | null
      deadlineMs?: number | null
      assigneeSpeakerId?: string | null
      note?: string | null
    }
  ) => {
    getDb().updateTask(payload.taskId, payload)
    return null
  })

  // Approve + dismiss tasks from the meeting detail action items section.
  // Does not generate comms — that's handled separately if/when the comms flow is built.
  ipcMain.handle(RENDERER_CHANNELS.TASKS_APPROVE_DISMISS, async (
    _event,
    payload: { approvedIds: string[]; dismissedIds: string[] }
  ) => {
    const db = getDb()
    for (const id of (payload.approvedIds  ?? [])) db.confirmTask(id)
    for (const id of (payload.dismissedIds ?? [])) db.dismissTask(id)
    return null
  })

  // Approve with per-task list assignment — sets list_name, origin_list, and status atomically
  ipcMain.handle(RENDERER_CHANNELS.TASKS_APPROVE_WITH_LISTS, async (
    _event,
    payload: { approvals: { id: string; listName: string }[]; dismissedIds: string[] }
  ) => {
    const db = getDb()
    for (const { id, listName } of (payload.approvals ?? [])) {
      db.approveTaskToList(id, listName)
    }
    for (const id of (payload.dismissedIds ?? [])) db.dismissTask(id)
    return null
  })

  ipcMain.handle(RENDERER_CHANNELS.BILLING_GET_STATUS, async () => {
    try {
      return await apiGet('/api/billing/subscription-status')
    } catch (err) {
      console.error('[ipc] billing:getStatus error:', err)
      // Fail open — don't block app access if billing API is unreachable
      return { status: 'active' }
    }
  })

  ipcMain.handle(RENDERER_CHANNELS.BILLING_CREATE_CHECKOUT, async () => {
    return await apiPost('/api/billing/create-checkout-session', {})
  })

  ipcMain.handle(RENDERER_CHANNELS.BILLING_OPEN_PORTAL, async () => {
    const { url } = await apiPost('/api/billing/portal', {})
    shell.openExternal(url)
  })
}
