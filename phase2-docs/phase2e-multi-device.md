# Cornflake Phase 2E — Multi-device

## Overview

Phase 2E completes the cloud sync vision. A user installs Cornflake on a new Mac, signs in, and all their data is immediately available. This builds on Phase 2D's sync layer.

---

## New Device Login Flow

```
New device, no local data
        │
        ▼
App launch → no Keychain token → login screen
        │
        ▼
User signs in with Google via WorkOS
        │
        ▼
Backend exchanges code → returns session token + user profile + Google tokens
        │
        ▼
Tokens stored in Keychain
        │
        ▼
Show loading screen: "Setting up your Cornflake..."
        │
        ▼
Pull all data: GET /api/sync/pull
→ Hydrate local SQLite
        │
        ▼
Download voice embeddings: GET /api/voice-profiles/:name/embedding
→ Write to local SQLite + Python sidecar
        │
        ▼
Register device: POST /api/devices
        │
        ▼
Main UI loads with all data present
```

---

## Pre-login Data Migration

For users who used Cornflake before Phase 2 (local data, no account):

```
App detects: local SQLite has data but no user_id on rows
        │
        ▼
After login, show one-time prompt:

  "We found existing data on this device"
  • X meeting notes
  • Y reminders
  
  [Upload to my account]  [Skip]
        │
        ▼
If Upload:
  - Tag all local rows with new user_id
  - Push everything via POST /api/sync/push
  - Mark migration complete in _meta table
```

---

## Device Registration

Add to backend routes (`/api/devices`):

```typescript
// POST /api/devices — register or update device
router.post('/', async (req, res) => {
  const userId = req.user.id
  const { deviceId, name, platform } = req.body
  const sb = getSupabase()

  await sb.from('devices').upsert({
    id: deviceId,
    user_id: userId,
    name,
    platform,
    last_seen_at: new Date().toISOString()
  })

  res.json({ ok: true })
})
```

In Electron, on every login:
```typescript
import { machineId } from 'node-machine-id'
import os from 'os'

const deviceId = await machineId()
await apiPost('/api/devices', {
  deviceId,
  name: os.hostname(),
  platform: 'mac'
})
```

Install: `npm install node-machine-id`

---

## Voice Profile Download

On new device, after pulling metadata, download embeddings:

```typescript
async function syncVoiceProfilesDown(): Promise<void> {
  const db = getDb()
  const profiles = db.getAllVoiceProfiles()

  for (const profile of profiles) {
    if (profile.embedding && profile.embedding.length > 0) continue

    try {
      // Download from backend
      const token = await keytar.getPassword('cornflake', 'workos_access_token')
      const res = await fetch(
        `${BACKEND_URL}/api/voice-profiles/${profile.name}/embedding`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer())
        db.upsertVoiceProfile(profile.name, profile.email, buffer)
      }
    } catch (err) {
      console.warn(`[sync] Could not download embedding for ${profile.name}`)
    }
  }
}
```

---

## Conflict Resolution

| Scenario | Resolution |
|---|---|
| Same task edited on two devices while offline | Last `updated_at` wins on sync |
| Task deleted locally, edited on other device | Deletion wins — `deleted_at` takes precedence |
| Meeting recorded on device A only | Stays on device A — audio never synced |
| Voice profile updated on device A | Overwrites on device B — `sample_count` prefers higher value |
| List renamed on both devices | Last `updated_at` wins |

---

## Settings Screen

Add a Settings view accessible from the profile popover:

- **Account**: name, email, avatar, sign out button
- **Devices**: list of registered devices with last seen time
- **Sync**: last synced timestamp, "Sync now" button, sync status
- **Data**: "Clear local cache and re-sync" option

---

## Verification

1. Clear local SQLite → relaunch → sign in → all data restored from cloud
2. Voice profiles downloaded — record a meeting with a known speaker → auto-identified
3. Device appears in Supabase `devices` table
4. Pre-login migration prompt appears if local data exists without user_id
5. Settings screen shows account info and device list correctly

---

## Claude Code Session Prompt

```
Read these files before doing anything else:
@cornflake-product-plan.md
@cornflake-architecture.md
@cornflake-data-model.md
@phase2-docs/phase2-cloud-architecture.md
@phase2-docs/phase2e-multi-device.md

Phases 2A–2D are complete. We are now building Phase 2E — 
multi-device support.

Install additional dependency in Electron app:
npm install node-machine-id

Build everything in phase2e-multi-device.md:
1. New device onboarding loading screen with progress
2. Voice profile download on new device login
3. Device registration — add POST /api/devices to backend 
   and call it from Electron on every login
4. Pre-login data migration prompt for existing local data
5. Settings screen accessible from profile popover

Verify all 5 items in the Verification section before closing.
```
