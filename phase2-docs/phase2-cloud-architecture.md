# Cornflake Phase 2 — Cloud Architecture (Revised)

## Overview

Phase 2 transforms Cornflake from a local-first app into a secure, cloud-synced, multi-device platform. A real backend API sits between the Electron app and all external services — no sensitive API keys ever live in the Electron app bundle.

---

## Core Principles

1. **No secrets in the client** — Deepgram, Anthropic, SendGrid, Supabase service role key all stay server-side
2. **Every request is authenticated** — backend validates WorkOS session token on every call
3. **Local-first UX** — local SQLite remains the primary read cache; UI is always fast
4. **Audio never leaves the device unencrypted** — WAV files sent to backend over HTTPS only, deleted after processing

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Electron App                        │
│                                                         │
│  ┌──────────────┐  ┌─────────────┐  ┌───────────────┐  │
│  │ Audio Capture│  │ Local SQLite│  │ Python Sidecar│  │
│  │ (local only) │  │ (UI cache)  │  │ (voice embeds)│  │
│  └──────┬───────┘  └──────┬──────┘  └───────┬───────┘  │
│         │                 │                  │          │
│         └─────────────────▼──────────────────┘          │
│                           │                             │
│              WorkOS session token (Keychain)            │
│                           │                             │
└───────────────────────────┼─────────────────────────────┘
                            │ HTTPS + Bearer token
                            ▼
┌─────────────────────────────────────────────────────────┐
│              Cornflake Backend API                      │
│              (Node/Express on Railway)                  │
│                                                         │
│  Auth middleware → validates WorkOS token               │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  /transcribe│  │  /extract    │  │  /sync        │  │
│  │  (Deepgram) │  │  (Anthropic) │  │  (Supabase)   │  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐                      │
│  │  /comms     │  │  /auth       │                      │
│  │  (SendGrid) │  │  (WorkOS)    │                      │
│  └─────────────┘  └──────────────┘                      │
└──────────┬──────────────┬──────────────────┬────────────┘
           │              │                  │
           ▼              ▼                  ▼
      WorkOS          Supabase          Deepgram/
      AuthKit         (Postgres)        Anthropic/
                                        SendGrid
```

---

## What Lives Where

### Electron App (client)
- Audio capture (ScreenCaptureKit — must be local)
- Python sidecar (voice embeddings — local processing)
- Local SQLite (UI read cache — fast, works offline)
- WorkOS session token (Keychain — never in code)
- UI components (React/Tailwind)

### Backend API (server)
- All API keys: Deepgram, Anthropic, SendGrid, Supabase service role
- WorkOS token validation middleware
- Audio → transcript pipeline (proxies to Deepgram)
- Transcript → notes/tasks pipeline (proxies to Anthropic)
- Email dispatch (proxies to SendGrid)
- All Supabase reads/writes (canonical data store)

### WorkOS
- Identity and SSO
- Session token issuance and validation
- Google OAuth flow

### Supabase
- Postgres database (canonical cloud store)
- Accessed only by the backend — never directly by Electron
- Storage bucket for voice profile embeddings

---

## Phase 2 Build Order

### Phase 2A — WorkOS SSO ✅ Complete
### Phase 2B — Backend API
### Phase 2C — Supabase Schema
### Phase 2D — Sync Layer
### Phase 2E — Multi-device

---

## Request Authentication

Every Electron → Backend request includes the WorkOS session token:

```typescript
// Electron side — every API call
const token = await keytar.getPassword('cornflake', 'workos_access_token')

const response = await fetch(`${BACKEND_URL}/api/transcribe`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(payload)
})
```

```typescript
// Backend side — auth middleware on every route
import { WorkOS } from '@workos-inc/node'
const workos = new WorkOS(process.env.WORKOS_API_KEY)

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token' })
  
  try {
    const { user } = await workos.userManagement.loadSealedSession({
      sessionData: token,
      cookiePassword: process.env.WORKOS_COOKIE_PASSWORD,
    })
    req.user = user
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid token' })
  }
}
```

---

## API Endpoints

### Auth
| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/exchange` | Exchange WorkOS code for session token |
| POST | `/api/auth/refresh` | Refresh expired session token |
| GET | `/api/auth/me` | Get current user profile |

### Pipeline
| Method | Path | Description |
|---|---|---|
| POST | `/api/transcribe` | Send audio → Deepgram → return transcript |
| POST | `/api/extract` | Send transcript → Anthropic → return notes/tasks/decisions |
| POST | `/api/comms/send` | Send task notifications via SendGrid |

### Sync
| Method | Path | Description |
|---|---|---|
| GET | `/api/sync/pull` | Pull all user data from Supabase |
| POST | `/api/sync/push` | Upsert batch of local changes to Supabase |
| DELETE | `/api/sync/:table/:id` | Soft delete a record |

### Voice profiles
| Method | Path | Description |
|---|---|---|
| GET | `/api/voice-profiles` | List user's voice profiles |
| POST | `/api/voice-profiles` | Upload/update a voice profile embedding |
| GET | `/api/voice-profiles/:name/embedding` | Download embedding binary |

---

## Environment Variables

### Electron App `.env`
```
# WorkOS (client-safe — no API key here)
WORKOS_CLIENT_ID=client_...
WORKOS_REDIRECT_URI=http://127.0.0.1:52069/callback

# Backend URL
BACKEND_URL=https://cornflake-api.railway.app
```

### Backend `.env` (Railway environment variables)
```
# WorkOS
WORKOS_API_KEY=sk_...
WORKOS_CLIENT_ID=client_...
WORKOS_COOKIE_PASSWORD=<32-char random string>

# Supabase (service role — full access)
SUPABASE_URL=https://yourproject.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Deepgram
DEEPGRAM_API_KEY=...

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI (optional)
OPENAI_API_KEY=sk-...

# Grok (optional)
GROK_API_KEY=...

# SendGrid
SENDGRID_API_KEY=SG....
SENDGRID_FROM_ADDRESS=hello@cornflake.app

# Server
PORT=3000
NODE_ENV=production
```

---

## Security Model

- **API keys** — all third-party keys live only in Railway environment variables
- **WorkOS token** — validated on every backend request
- **Supabase** — service role key on backend only; anon key never used
- **Audio files** — sent over HTTPS; deleted from backend immediately after Deepgram processing; never stored
- **Voice embeddings** — Supabase Storage, accessible only via authenticated backend
- **Local SQLite** — contains only the logged-in user's data

---

## Hosting

**Railway** for the backend:
- Free tier covers early design partners
- One-click Node.js deploy from GitHub
- Environment variables in dashboard
- Automatic HTTPS and zero-downtime deploys
