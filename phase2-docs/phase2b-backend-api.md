# Cornflake Phase 2B — Backend API

## Overview

This document covers building the Cornflake backend API — a Node/Express server hosted on Railway that acts as a secure proxy between the Electron app and all external services. No API keys live in the Electron app after this phase.

---

## Prerequisites

Before starting this session:

1. Create a Railway account at railway.app
2. Create a new project in Railway
3. Create a GitHub repo for the backend (separate from the Electron repo):
   `cornflake-api` or a monorepo with `packages/api`
4. Have the following API keys ready to add as Railway environment variables:
   - `WORKOS_API_KEY` — from WorkOS dashboard → API Keys
   - `WORKOS_CLIENT_ID` — from WorkOS dashboard
   - `WORKOS_COOKIE_PASSWORD` — generate a random 32-char string
   - `SUPABASE_URL` — from Supabase project settings
   - `SUPABASE_SERVICE_ROLE_KEY` — from Supabase project settings → API
   - `DEEPGRAM_API_KEY`
   - `ANTHROPIC_API_KEY`
   - `SENDGRID_API_KEY`
   - `SENDGRID_FROM_ADDRESS=nithinsudarsan@basegraph.co`

---

## Repository Structure

```
cornflake-api/
├── src/
│   ├── index.ts                 # Express app entry
│   ├── middleware/
│   │   ├── auth.ts              # WorkOS token validation
│   │   └── errorHandler.ts      # Global error handler
│   ├── routes/
│   │   ├── auth.ts              # /api/auth/*
│   │   ├── transcribe.ts        # /api/transcribe
│   │   ├── extract.ts           # /api/extract
│   │   ├── sync.ts              # /api/sync/*
│   │   ├── comms.ts             # /api/comms/send
│   │   └── voiceProfiles.ts     # /api/voice-profiles/*
│   ├── services/
│   │   ├── deepgram.ts          # Deepgram client
│   │   ├── llm.ts               # LLM provider abstraction
│   │   ├── supabase.ts          # Supabase client (service role)
│   │   └── sendgrid.ts          # SendGrid client
│   └── types.ts                 # Shared TypeScript types
├── package.json
├── tsconfig.json
├── .env.example
└── railway.json                 # Railway config
```

---

## Core Setup

### package.json dependencies
```json
{
  "dependencies": {
    "express": "^4.18.0",
    "@workos-inc/node": "^7.0.0",
    "@supabase/supabase-js": "^2.0.0",
    "multer": "^1.4.5",
    "cors": "^2.8.5",
    "helmet": "^7.0.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/express": "^4.17.0",
    "@types/multer": "^1.4.0",
    "@types/cors": "^2.8.0",
    "tsx": "^4.0.0"
  },
  "scripts": {
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "build": "tsc"
  }
}
```

### src/index.ts
```typescript
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { authMiddleware } from './middleware/auth'
import authRoutes from './routes/auth'
import transcribeRoutes from './routes/transcribe'
import extractRoutes from './routes/extract'
import syncRoutes from './routes/sync'
import commsRoutes from './routes/comms'
import voiceProfileRoutes from './routes/voiceProfiles'

const app = express()

app.use(helmet())
app.use(cors({ origin: true })) // Electron apps don't have a fixed origin
app.use(express.json({ limit: '50mb' }))

// Public routes (no auth required)
app.use('/api/auth', authRoutes)
app.get('/health', (_, res) => res.json({ ok: true }))

// Protected routes (auth required)
app.use('/api', authMiddleware)
app.use('/api/transcribe', transcribeRoutes)
app.use('/api/extract', extractRoutes)
app.use('/api/sync', syncRoutes)
app.use('/api/comms', commsRoutes)
app.use('/api/voice-profiles', voiceProfileRoutes)

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Cornflake API running on port ${PORT}`))
```

---

## Auth Middleware

### src/middleware/auth.ts
```typescript
import { WorkOS } from '@workos-inc/node'
import { Request, Response, NextFunction } from 'express'

const workos = new WorkOS(process.env.WORKOS_API_KEY!)

export async function authMiddleware(
  req: Request, 
  res: Response, 
  next: NextFunction
) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  
  if (!token) {
    return res.status(401).json({ error: 'No authorization token' })
  }

  try {
    const { user } = await workos.userManagement.loadSealedSession({
      sessionData: token,
      cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
    })
    
    // Attach user to request for use in route handlers
    ;(req as any).user = user
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}
```

---

## Routes

### src/routes/auth.ts
```typescript
import { Router } from 'express'
import { WorkOS } from '@workos-inc/node'

const router = Router()
const workos = new WorkOS(process.env.WORKOS_API_KEY!)

// Exchange code for session token (called by Electron after OAuth callback)
router.post('/exchange', async (req, res) => {
  const { code } = req.body
  if (!code) return res.status(400).json({ error: 'No code provided' })

  try {
    const { user, sealedSession, oauthTokens } = 
      await workos.userManagement.authenticateWithCode({
        code,
        clientId: process.env.WORKOS_CLIENT_ID!,
        session: { sealSession: true, cookiePassword: process.env.WORKOS_COOKIE_PASSWORD! }
      })

    res.json({
      sessionToken: sealedSession,  // stored in Keychain by Electron
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.profilePictureUrl,
      },
      googleTokens: {
        accessToken: oauthTokens?.accessToken,
        refreshToken: oauthTokens?.refreshToken,
      }
    })
  } catch (err) {
    res.status(400).json({ error: 'Token exchange failed' })
  }
})

// Get current user profile
router.get('/me', async (req, res) => {
  // authMiddleware already validated — user attached to req
  res.json({ user: (req as any).user })
})

export default router
```

### src/routes/transcribe.ts
```typescript
import { Router } from 'express'
import multer from 'multer'
import { transcribeAudio } from '../services/deepgram'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } })

router.post('/', upload.fields([
  { name: 'micAudio', maxCount: 1 },
  { name: 'systemAudio', maxCount: 1 }
]), async (req, res) => {
  try {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] }
    const micBuffer = files.micAudio?.[0]?.buffer
    const systemBuffer = files.systemAudio?.[0]?.buffer

    if (!systemBuffer) {
      return res.status(400).json({ error: 'System audio required' })
    }

    const transcript = await transcribeAudio(micBuffer, systemBuffer)
    
    // Audio buffers are GC'd after this — never persisted
    res.json({ transcript })
  } catch (err) {
    res.status(500).json({ error: 'Transcription failed' })
  }
})

export default router
```

### src/routes/extract.ts
```typescript
import { Router } from 'express'
import { extractFromTranscript } from '../services/llm'

const router = Router()

router.post('/', async (req, res) => {
  const { transcript, meetingTitle, speakers } = req.body

  if (!transcript) {
    return res.status(400).json({ error: 'Transcript required' })
  }

  try {
    const result = await extractFromTranscript(transcript, meetingTitle, speakers)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: 'Extraction failed' })
  }
})

export default router
```

### src/routes/sync.ts
```typescript
import { Router } from 'express'
import { getSupabase } from '../services/supabase'

const router = Router()

// Pull all data for authenticated user
router.get('/pull', async (req, res) => {
  const userId = (req as any).user.id
  const sb = getSupabase()

  try {
    const tables = [
      'users', 'lists', 'meetings', 'speakers',
      'utterances', 'tasks', 'decisions', 'comms', 'voice_profiles'
    ]

    const data: Record<string, unknown[]> = {}
    
    for (const table of tables) {
      const { data: rows, error } = await sb
        .from(table)
        .select('*')
        .eq('user_id', userId)
      
      if (error) throw error
      data[table] = rows || []
    }

    res.json(data)
  } catch (err) {
    res.status(500).json({ error: 'Pull failed' })
  }
})

// Push batch of changes
router.post('/push', async (req, res) => {
  const userId = (req as any).user.id
  const { changes } = req.body // Array of { table, operation, record }
  const sb = getSupabase()

  try {
    for (const change of changes) {
      // Enforce user_id on all writes
      const record = { ...change.record, user_id: userId }

      if (change.operation === 'upsert') {
        await sb.from(change.table).upsert(record)
      } else if (change.operation === 'delete') {
        await sb.from(change.table)
          .update({ deleted_at: Date.now() })
          .eq('id', record.id)
          .eq('user_id', userId)
      }
    }

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Push failed' })
  }
})

export default router
```

### src/routes/comms.ts
```typescript
import { Router } from 'express'
import { sendTaskNotification } from '../services/sendgrid'

const router = Router()

router.post('/send', async (req, res) => {
  const { recipients } = req.body
  // recipients: [{ email, name, tasks, meetingTitle, includeInstallInvite }]

  try {
    const results = await Promise.allSettled(
      recipients.map((r: any) => sendTaskNotification(r))
    )

    const sent = results.filter(r => r.status === 'fulfilled').length
    const failed = results.filter(r => r.status === 'rejected').length

    res.json({ sent, failed })
  } catch (err) {
    res.status(500).json({ error: 'Comms dispatch failed' })
  }
})

export default router
```

### src/routes/voiceProfiles.ts
```typescript
import { Router } from 'express'
import multer from 'multer'
import { getSupabase } from '../services/supabase'

const router = Router()
const upload = multer({ storage: multer.memoryStorage() })

// List voice profiles for user
router.get('/', async (req, res) => {
  const userId = (req as any).user.id
  const sb = getSupabase()

  const { data, error } = await sb
    .from('voice_profiles')
    .select('id, name, email, sample_count, updated_at')
    .eq('user_id', userId)

  if (error) return res.status(500).json({ error })
  res.json(data)
})

// Upload/update voice profile embedding
router.post('/', upload.single('embedding'), async (req, res) => {
  const userId = (req as any).user.id
  const { name, email, sampleCount } = req.body
  const embedding = req.file?.buffer

  if (!embedding || !name) {
    return res.status(400).json({ error: 'name and embedding required' })
  }

  const sb = getSupabase()
  const path = `${userId}/${name}.bin`

  // Upload binary to Supabase Storage
  await sb.storage.from('voice-profiles').upload(path, embedding, { upsert: true })

  // Upsert metadata record
  await sb.from('voice_profiles').upsert({
    user_id: userId,
    name,
    email: email || null,
    embedding_path: path,
    sample_count: parseInt(sampleCount) || 1,
    updated_at: new Date().toISOString()
  })

  res.json({ ok: true })
})

// Download embedding binary
router.get('/:name/embedding', async (req, res) => {
  const userId = (req as any).user.id
  const { name } = req.params
  const sb = getSupabase()

  const { data, error } = await sb.storage
    .from('voice-profiles')
    .download(`${userId}/${name}.bin`)

  if (error || !data) return res.status(404).json({ error: 'Not found' })

  const buffer = Buffer.from(await data.arrayBuffer())
  res.setHeader('Content-Type', 'application/octet-stream')
  res.send(buffer)
})

export default router
```

---

## Services

### src/services/deepgram.ts
```typescript
import https from 'https'

export async function transcribeAudio(
  micBuffer: Buffer | undefined,
  systemBuffer: Buffer
): Promise<Transcript> {
  // System audio → Deepgram with diarization
  const systemUtterances = await callDeeepgram(systemBuffer, true)
  
  // Mic audio → Deepgram without diarization (always "you")
  const micUtterances = micBuffer 
    ? await callDeeepgram(micBuffer, false)
    : []

  // Merge and sort by timestamp
  const merged = [
    ...micUtterances.map(u => ({ ...u, speakerId: 'you' })),
    ...systemUtterances.map(u => ({ ...u, speakerId: `deepgram_${u.speaker}` }))
  ].sort((a, b) => a.startMs - b.startMs)

  return merged
}

async function callDeeepgram(audio: Buffer, diarize: boolean): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.deepgram.com',
      path: `/v1/listen?model=nova-2&diarize=${diarize}&utterances=true&smart_format=true`,
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'audio/wav',
        'Content-Length': audio.length,
      }
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          resolve(parsed.results?.utterances || [])
        } catch { reject(new Error('Deepgram parse error')) }
      })
    })

    req.on('error', reject)
    req.write(audio)
    req.end()
  })
}
```

### src/services/llm.ts
```typescript
// Provider abstraction — same pattern as Electron app
// but running server-side with keys from environment

type Provider = 'claude' | 'openai' | 'grok'
const PROVIDER: Provider = (process.env.LLM_PROVIDER as Provider) || 'claude'

export async function extractFromTranscript(
  transcript: any[],
  meetingTitle: string,
  speakers: any[]
): Promise<ExtractionResult> {
  const transcriptText = transcript
    .map(u => `[${u.speakerId}] ${u.text}`)
    .join('\n')

  const [tasks, decisions, summary, speakerInference] = await Promise.all([
    extractTasks(transcriptText, speakers),
    extractDecisions(transcriptText),
    generateSummary(transcriptText, meetingTitle),
    inferSpeakers(transcriptText, speakers),
  ])

  return { tasks, decisions, summary, speakerInference }
}

async function complete(prompt: string, systemPrompt: string): Promise<string> {
  // Route to correct provider based on env var
  switch (PROVIDER) {
    case 'claude': return claudeComplete(prompt, systemPrompt)
    case 'openai': return openaiComplete(prompt, systemPrompt)
    case 'grok': return grokComplete(prompt, systemPrompt)
  }
}

// ... provider implementations using server-side API keys
```

### src/services/supabase.ts
```typescript
import { createClient, SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!client) {
    // Service role key — full access, never exposed to client
    client = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return client
}
```

### src/services/sendgrid.ts
```typescript
import https from 'https'

interface NotificationPayload {
  email: string
  name: string
  tasks: { title: string; deadlineText?: string }[]
  meetingTitle: string
  includeInstallInvite: boolean
}

export async function sendTaskNotification(payload: NotificationPayload): Promise<void> {
  const body = {
    personalizations: [{ to: [{ email: payload.email, name: payload.name }] }],
    from: { email: process.env.SENDGRID_FROM_ADDRESS, name: 'Cornflake' },
    subject: `Action items from ${payload.meetingTitle}`,
    content: [{
      type: 'text/plain',
      value: buildEmailBody(payload)
    }]
  }

  // POST to SendGrid API
  await sendgridPost('/v3/mail/send', body)
}

function buildEmailBody(payload: NotificationPayload): string {
  const taskList = payload.tasks
    .map(t => `• ${t.title}${t.deadlineText ? ` — ${t.deadlineText}` : ''}`)
    .join('\n')

  let body = `Hey ${payload.name} — from the ${payload.meetingTitle} earlier.\n\n`
  body += `You're down to:\n${taskList}\n`
  
  if (payload.includeInstallInvite) {
    body += `\nGet Cornflake to track your action items: https://cornflake.app/download`
  }

  return body
}
```

---

## Electron App Changes

After building the backend, update the Electron app to route all API calls through the backend instead of calling services directly.

### New API client module
File: `electron/main/modules/api-client/index.ts`

```typescript
import keytar from 'keytar'

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000'

async function getToken(): Promise<string> {
  const token = await keytar.getPassword('cornflake', 'workos_access_token')
  if (!token) throw new Error('No session token')
  return token
}

export async function apiGet(path: string): Promise<any> {
  const token = await getToken()
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function apiPost(path: string, body: any): Promise<any> {
  const token = await getToken()
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function apiPostForm(path: string, formData: FormData): Promise<any> {
  const token = await getToken()
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}
```

### Module updates required in Electron
- `transcription/index.ts` → call `POST /api/transcribe` with audio files instead of Deepgram directly
- `llm/extraction.ts` → call `POST /api/extract` instead of Anthropic directly
- `comms-dispatch/index.ts` → call `POST /api/comms/send` instead of SendGrid directly
- `auth/index.ts` → call `POST /api/auth/exchange` for token exchange instead of WorkOS SDK directly
- Remove all third-party SDK imports from Electron main process
- Remove `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `SENDGRID_API_KEY` from Electron `.env`

---

## Railway Deployment

### railway.json
```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm run build && npm start",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

### Deploy steps
1. Push backend code to GitHub
2. In Railway: New Project → Deploy from GitHub repo → select `cornflake-api`
3. Add all environment variables in Railway dashboard
4. Railway auto-deploys and gives you a URL: `https://cornflake-api.railway.app`
5. Add `BACKEND_URL=https://cornflake-api.railway.app` to Electron `.env`

---

## Verification

After building Phase 2B, verify:

1. `GET https://cornflake-api.railway.app/health` returns `{ ok: true }`
2. `POST /api/auth/exchange` with a valid WorkOS code returns session token + user profile
3. `GET /api/auth/me` with a valid Bearer token returns user profile
4. `GET /api/auth/me` with no token returns 401
5. `POST /api/transcribe` with audio files returns a transcript
6. `POST /api/extract` with a transcript returns tasks, decisions, summary
7. Electron app successfully routes transcription through backend — terminal shows no direct Deepgram calls from Electron
8. Deepgram API key is no longer present in Electron `.env`

---

## Claude Code Session Prompt

```
Read these files before doing anything else:
@cornflake-product-plan.md
@cornflake-architecture.md
@cornflake-data-model.md
@phase2-docs/phase2-cloud-architecture.md
@phase2-docs/phase2b-backend-api.md

Phase 2A (WorkOS SSO) is complete. We are now building Phase 2B 
— the Cornflake backend API.

This is a NEW separate codebase from the Electron app.
Create it in a new directory: cornflake-api/

Build everything specified in phase2b-backend-api.md:
1. Express server with TypeScript
2. Auth middleware using WorkOS token validation
3. All routes: auth, transcribe, extract, sync, comms, voice-profiles
4. All services: deepgram, llm, supabase, sendgrid
5. Railway deployment config

Then update the Electron app:
6. Add api-client module
7. Update transcription, llm extraction, comms dispatch to call 
   backend instead of third-party APIs directly
8. Remove third-party API keys from Electron .env

For local development, run the backend on localhost:3000 and 
set BACKEND_URL=http://localhost:3000 in Electron .env.

Verify all 8 items in the Verification section before closing.
```
