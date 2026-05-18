# Cornflake Phase 2D — Sync Layer

## Overview

Phase 2D implements sync between local SQLite and Supabase via the backend API. The app remains local-first — all reads and writes go to SQLite first. Changes are synced to the backend in the background.

---

## Sync Strategy

**Write path (local → cloud):**
1. Write to local SQLite immediately
2. Queue a background push to backend API
3. Online → immediate flush, offline → retry on reconnect

**Read path (cloud → local, login only):**
1. On login or new device: call `GET /api/sync/pull`
2. Backend returns all user data from Supabase
3. Merge into local SQLite

**Conflict resolution:** last `updated_at` wins.

---

## Sync Module

File: `electron/main/modules/sync/index.ts`

```typescript
import { apiGet, apiPost } from '../api-client'
import { getDb } from '../database'

interface PendingChange {
  id: string
  table: string
  operation: 'upsert' | 'delete'
  record: Record<string, unknown>
  createdAt: number
  attempts: number
}

class SyncModule {
  private queue: PendingChange[] = []
  private isFlushing = false
  private status: 'synced' | 'syncing' | 'pending' | 'offline' | 'error' = 'synced'

  // Called after every local write
  queueUpsert(table: string, record: Record<string, unknown>): void {
    this.queue.push({
      id: crypto.randomUUID(),
      table,
      operation: 'upsert',
      record,
      createdAt: Date.now(),
      attempts: 0
    })
    this.scheduleFlush()
  }

  queueDelete(table: string, recordId: string): void {
    this.queue.push({
      id: crypto.randomUUID(),
      table,
      operation: 'delete',
      record: { id: recordId },
      createdAt: Date.now(),
      attempts: 0
    })
    this.scheduleFlush()
  }

  // Pull all data from cloud on login
  async pullFromCloud(): Promise<void> {
    try {
      const data = await apiGet('/api/sync/pull')
      
      // Merge into local SQLite
      const db = getDb()
      for (const [table, rows] of Object.entries(data)) {
        for (const row of rows as any[]) {
          db.upsertFromCloud(table, row)
        }
      }
    } catch (err) {
      console.error('[sync] Pull failed:', err)
    }
  }

  private scheduleFlush(): void {
    if (this.isFlushing) return
    setTimeout(() => this.flushQueue(), 100)
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
    } catch (err) {
      // Re-queue failed items (max 3 attempts)
      const retry = batch
        .filter(c => c.attempts < 3)
        .map(c => ({ ...c, attempts: c.attempts + 1 }))
      this.queue = [...retry, ...this.queue]
      this.status = retry.length > 0 ? 'pending' : 'error'
    } finally {
      this.isFlushing = false
    }
  }

  onReconnect(): void {
    this.flushQueue()
  }

  getStatus() { return this.status }
}

export const syncModule = new SyncModule()
```

---

## Write-Through Pattern

Wrap all existing DB query helpers to also queue a sync:

```typescript
// In electron/main/modules/database/queries.ts
// After every write, add: syncModule.queueUpsert(table, record)

export function createMeeting(title: string, ...args): Meeting {
  const meeting = /* existing insert */ 
  syncModule.queueUpsert('meetings', meeting)  // add this
  return meeting
}

export function updateTask(taskId: string, updates: Partial<Task>): Task {
  const task = /* existing update */
  syncModule.queueUpsert('tasks', task)  // add this
  return task
}
// ... repeat for all write helpers
```

---

## Local SQLite — upsertFromCloud helper

Add to `electron/main/modules/database/queries.ts`:

```typescript
// Used during pull — inserts cloud row into local SQLite
// Skips if local row is newer (updated_at comparison)
export function upsertFromCloud(table: string, row: Record<string, unknown>): void {
  const db = getRawDb() // raw better-sqlite3 instance
  
  const existing = db.prepare(
    `SELECT updated_at FROM ${table} WHERE id = ?`
  ).get(row.id as string) as any

  // Skip if local row is newer
  if (existing && existing.updated_at > (row.updated_at as number)) return

  const cols = Object.keys(row).join(', ')
  const placeholders = Object.keys(row).map(() => '?').join(', ')
  const vals = Object.values(row)

  db.prepare(
    `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`
  ).run(vals)
}
```

---

## Sync Queue Persistence

Store pending sync operations in SQLite so they survive app restarts:

Add migration `012_add_sync_queue.sql`:

```sql
CREATE TABLE IF NOT EXISTS sync_queue (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER
);
```

On app start, load any pending items from `sync_queue` into the in-memory queue and attempt to flush.

---

## Network Detection

```typescript
import { net, powerMonitor } from 'electron'

// Flush on network reconnect
powerMonitor.on('resume', () => syncModule.onReconnect())

// Poll every 30s as fallback
setInterval(() => {
  if (net.isOnline()) syncModule.flushQueue()
}, 30_000)
```

---

## Sync Status UI

Subtle indicator at the bottom of the right panel:

- No indicator when synced and online
- Amber pulsing dot: syncing or pending items
- Grey dot: offline
- Red dot: sync error

---

## Login Flow with Sync

```typescript
// In auth module, after successful login:

async function onLoginSuccess(user: UserProfile, tokens: Tokens): Promise<void> {
  // 1. Store tokens in Keychain
  await storeTokens(tokens)
  
  // 2. Upsert user record locally
  db.upsertUser(user)
  
  // 3. Pull all cloud data
  await syncModule.pullFromCloud()
  
  // 4. Send auth:login to renderer
  mainWindow.webContents.send('auth:login', user)
  
  // 5. Start calendar watcher
  startCalendarWatcher()
}
```

---

## Verification

1. Create a task in the app → within 2 seconds, row appears in Supabase `tasks` table
2. Complete a task → Supabase row updated with `status = 'completed'`
3. Delete a meeting → Supabase row updated with `deleted_at` set
4. Turn off wifi → create a task → turn on wifi → task syncs to Supabase
5. Sign out and sign back in → all data restored from cloud via pull
6. `sync_queue` table is empty after successful sync

---

## Claude Code Session Prompt

```
Read these files before doing anything else:
@cornflake-product-plan.md
@cornflake-architecture.md
@cornflake-data-model.md
@phase2-docs/phase2-cloud-architecture.md
@phase2-docs/phase2d-sync-layer.md

Phases 2A, 2B, 2C are complete. We are now building Phase 2D 
— the sync layer.

Build everything specified in phase2d-sync-layer.md:
1. Sync module at electron/main/modules/sync/index.ts
2. Migration 012_add_sync_queue.sql
3. Write-through: wrap all existing DB query helpers to queue syncs
4. upsertFromCloud helper in database/queries.ts
5. Load sync queue from SQLite on app start
6. Network detection and reconnect flush
7. Pull from cloud on login (after auth:login succeeds)
8. Sync status indicator in UI

Do not modify any existing module behaviour — sync is additive.
All existing reads/writes continue to work as before.

Verify all 6 items in the Verification section before closing.
```
