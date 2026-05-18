// Phase 2D — Sync Module
// Mirrors local SQLite writes to Supabase via the Cornflake backend API.
// Write-through: every local write queues a background push.
// Pull: on login and app restart, fetches cloud data and merges into local SQLite.

import { apiGet, apiPost } from '../api-client/index.js'
import { registerWriteHook, registerDeleteHook, getDb } from '../database/index.js'
import type { BrowserWindow } from 'electron'

// IPC channel names — inlined to avoid importing electron types into this module
const CH_PULL_START      = 'sync:pullStart'
const CH_PULL_COMPLETE   = 'sync:pullComplete'
const CH_DATA_UPDATED    = 'sync:dataUpdated'

// FK dependency order — parents must be upserted before children.
// Used both for push ordering AND for pull ordering.
const PULL_TABLE_ORDER = [
  'users',
  'user_profiles',
  'lists',
  'meetings',
  'speakers',
  'utterances',
  'tasks',
  'decisions',
  'comms',
  'voice_profiles',
]

interface PendingChange {
  id:        string
  table:     string
  operation: 'upsert' | 'delete'
  record:    Record<string, unknown>
  createdAt: number
  attempts:  number
}

type SyncStatus = 'synced' | 'syncing' | 'pending' | 'offline' | 'error'

class SyncModule {
  private queue:         PendingChange[] = []
  private isFlushing     = false
  private flushTimer:    ReturnType<typeof setTimeout> | null = null
  private pullTimer:     ReturnType<typeof setInterval> | null = null
  private userId:        string | null = null
  private status:        SyncStatus = 'synced'
  private isPulling      = false
  private mainWindow:    BrowserWindow | null = null

  // Per-user guards — set on first init() for a given userId, cleared on stop().
  // Prevents init/backfill/startPeriodicPull from re-running on every call.
  private initializedForUser: string | null = null
  private listsBackfilled:    boolean = false
  private periodicPullStarted: boolean = false

  // ---------------------------------------------------------------------------
  // Renderer event emission
  // ---------------------------------------------------------------------------

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
  }

  private emit(channel: string, payload?: unknown): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  // ---------------------------------------------------------------------------
  // Init + stop
  // ---------------------------------------------------------------------------

  // Called after login. Idempotent: if already initialized for the same user,
  // this is a no-op so it can be safely called multiple times (e.g. from
  // renderer:ready firing on initial mount and again on authState change).
  init(userId: string, profile?: { email: string; name?: string | null; avatarUrl?: string | null }): void {
    if (this.initializedForUser === userId) {
      // Already set up — don't re-queue users, don't re-backfill lists, don't reset state.
      return
    }
    this.initializedForUser = userId
    this.userId = userId
    console.log('[sync] Initialized for user', userId)

    // Queue the users row — must land in Supabase before meetings/tasks (FK parent).
    const email = profile?.email ?? this.readEmailFromDb(userId)
    if (email) {
      this.queue.unshift({
        id:        crypto.randomUUID(),
        table:     'users',
        operation: 'upsert',
        // Supabase users table: id, email, name, avatar_url only — NO user_id column.
        record: {
          id:         userId,
          email,
          name:       profile?.name ?? null,
          avatar_url: profile?.avatarUrl ?? null,
        },
        createdAt: Date.now(),
        attempts:  0,
      })
    }

    // Backfill the local user_profiles row (seeded in auth.handleCallback before
    // syncModule had a userId, so the write hook was dropped). Once Supabase has it,
    // the periodic pull keeps local in sync.
    try {
      const profileMd = getDb().getUserProfileMd(userId)
      if (profileMd) {
        this.queue.push({
          id:        crypto.randomUUID(),
          table:     'user_profiles',
          operation: 'upsert',
          record:    {
            id:         userId,
            user_id:    userId,
            profile_md: profileMd,
            updated_at: Date.now(),
          },
          createdAt: Date.now(),
          attempts:  0,
        })
      }
    } catch (err) {
      console.warn('[sync] user_profiles backfill failed:', (err as Error).message)
    }

    // Backfill local lists exactly once per user — handles seed migration 007.
    // After the first push lands them in Supabase, subsequent pulls re-hydrate
    // local SQLite from cloud, so re-queuing them on every init would be wasteful.
    if (!this.listsBackfilled) {
      try {
        const localLists = getDb().getAllLists()
        for (const list of localLists) {
          this.queueUpsert('lists', {
            id:         list.id,
            name:       list.name,
            created_at: list.createdAt,
          })
        }
        if (localLists.length > 0) {
          console.log(`[sync] Backfilled ${localLists.length} local list(s) to push queue`)
        }
        this.listsBackfilled = true
      } catch (err) {
        console.warn('[sync] List backfill failed:', (err as Error).message)
      }
    }

    this.scheduleFlush()
  }

  // Called on logout — clears user state, stops background timers, and resets
  // the per-user guards so the next login (possibly as a different user) can
  // re-initialize cleanly.
  stop(): void {
    this.userId = null
    this.initializedForUser = null
    this.listsBackfilled = false
    this.periodicPullStarted = false
    this.queue  = []
    this.status = 'synced'
    if (this.pullTimer) {
      clearInterval(this.pullTimer)
      this.pullTimer = null
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    console.log('[sync] Stopped')
  }

  private readEmailFromDb(userId: string): string | null {
    try {
      const row = getDb().getUserById(userId)
      return row?.email ?? null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Pull from cloud
  // ---------------------------------------------------------------------------

  async pullFromCloud(): Promise<void> {
    if (this.isPulling) return
    this.isPulling = true
    this.emit(CH_PULL_START)
    let success = false
    let totalSeen    = 0   // rows pulled from cloud, regardless of whether they changed
    let totalChanged = 0   // rows that were actually inserted or updated in local SQLite
    try {
      console.log('[sync] Pulling from cloud...')
      const data = await apiGet('/api/sync/pull')
      const db = getDb()
      const summary: string[] = []

      // Process in FK dependency order so parent rows land before children.
      for (const table of PULL_TABLE_ORDER) {
        const rows = data[table] as Record<string, unknown>[] | undefined
        if (!rows || rows.length === 0) {
          summary.push(`${table}:0`)
          continue
        }
        let changedHere = 0
        for (const row of rows) {
          try {
            if (db.upsertFromCloud(table, row)) changedHere++
          } catch (err) {
            console.warn(`[sync/pull] upsertFromCloud failed for ${table} row ${row.id}:`, (err as Error).message)
          }
        }
        totalSeen    += rows.length
        totalChanged += changedHere
        summary.push(`${table}:${changedHere}/${rows.length}`)
      }

      success = true
      console.log(`[sync] Pull complete — ${totalChanged}/${totalSeen} row(s) changed | ${summary.join(', ')}`)
    } catch (err) {
      console.error('[sync] Pull failed:', (err as Error).message)
    } finally {
      this.isPulling = false
      // pull-complete always fires (the loading screen state machine relies on it
      // even when nothing changed).
      this.emit(CH_PULL_COMPLETE, { success, rows: totalChanged })
      // dataUpdated only fires when at least one row actually changed — avoids
      // unnecessary UI re-fetches on idle periodic pulls.
      if (success && totalChanged > 0) this.emit(CH_DATA_UPDATED)
    }
  }

  // Start a periodic background pull every 60s.
  // Idempotent: guarded by both the timer ref and a boolean flag so concurrent
  // callers can never spawn a second interval.
  startPeriodicPull(): void {
    if (this.periodicPullStarted || this.pullTimer) return
    this.periodicPullStarted = true
    console.log('[sync] Starting periodic pull (60s interval)')
    this.pullTimer = setInterval(() => {
      this.pullFromCloud().catch(err =>
        console.warn('[sync] Periodic pull failed:', (err as Error).message)
      )
    }, 60_000)
  }

  // ---------------------------------------------------------------------------
  // Push to cloud
  // ---------------------------------------------------------------------------

  // Queue a local upsert for background push.
  queueUpsert(table: string, record: Record<string, unknown>): void {
    if (!this.userId) return
    console.log(`[sync] queueUpsert → ${table} (id=${record.id ?? '?'})`)
    // The `users` table in Supabase has no `user_id` column — it uses `id` as PK.
    // All other tables get user_id stamped for ownership queries.
    const enriched = table === 'users'
      ? { ...record }
      : { ...record, user_id: this.userId }
    this.queue.push({
      id:        crypto.randomUUID(),
      table,
      operation: 'upsert',
      record:    enriched,
      createdAt: Date.now(),
      attempts:  0,
    })
    this.scheduleFlush()
  }

  // Queue a soft delete for background push.
  queueDelete(table: string, recordId: string): void {
    if (!this.userId) return
    this.queue.push({
      id:        crypto.randomUUID(),
      table,
      operation: 'delete',
      record:    { id: recordId, user_id: this.userId },
      createdAt: Date.now(),
      attempts:  0,
    })
    this.scheduleFlush()
  }

  async flushQueue(): Promise<void> {
    if (this.isFlushing || this.queue.length === 0) return
    this.isFlushing = true
    this.status = 'syncing'

    const batch = [...this.queue]
    this.queue = []

    try {
      await apiPost('/api/sync/push', { changes: batch })
      this.status = 'synced'
      console.log(`[sync] Pushed ${batch.length} change(s)`)
      // Notify renderer that data has changed (own writes already reflect, but
      // other devices' changes may now be relevant after the next pull)
      this.emit(CH_DATA_UPDATED)
    } catch (err) {
      const retry = batch
        .filter(c => c.attempts < 3)
        .map(c => ({ ...c, attempts: c.attempts + 1 }))
      this.queue = [...retry, ...this.queue]
      this.status = retry.length > 0 ? 'pending' : 'error'
      console.warn('[sync] Push failed, queued for retry:', (err as Error).message)
    } finally {
      this.isFlushing = false
    }
  }

  onReconnect(): void {
    this.flushQueue().catch(console.error)
  }

  getStatus(): SyncStatus { return this.status }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushQueue().catch(console.error)
    }, 100)
  }
}

export const syncModule = new SyncModule()

// Register write-through and delete-through hooks so every local DB change queues a sync.
registerWriteHook((table, record) => syncModule.queueUpsert(table, record))
registerDeleteHook((table, id) => syncModule.queueDelete(table, id))
