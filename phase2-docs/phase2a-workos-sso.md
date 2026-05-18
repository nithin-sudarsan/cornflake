# Cornflake Phase 2A — WorkOS SSO

## Overview

This document covers the implementation of WorkOS AuthKit SSO for Cornflake. After this phase, users must sign in before accessing the app. Identity is established via Google OAuth through WorkOS. The session token is stored securely in the macOS Keychain.

This phase does NOT include cloud sync — that is Phase 2B/2C. Phase 2A is identity only.

---

## Prerequisites

Before starting this session:

1. Create a WorkOS account at workos.com
2. Create an AuthKit application in the WorkOS dashboard
3. Enable Google OAuth as a provider in WorkOS with these settings:
   - Select "Your app's credentials" and enter your Google Client ID and Secret
   - Check "Return Google OAuth tokens" — this returns Google access/refresh tokens alongside the WorkOS session token so the user only signs in once for both identity and calendar access
   - Add scope: `https://www.googleapis.com/auth/calendar.readonly` in addition to the default email and profile scopes
   - Save changes
4. Add the redirect URI in WorkOS AuthKit settings: `cornflake://auth/callback`
5. Copy your credentials into `.env`:
   ```
   WORKOS_CLIENT_ID=client_...
   WORKOS_API_KEY=sk_...
   WORKOS_REDIRECT_URI=cornflake://auth/callback
   ```
   Note: WORKOS_API_KEY is found under API Keys in the WorkOS dashboard — it is different from the Client ID and required for server-side token exchange.
6. Install the WorkOS Node SDK:
   ```bash
   npm install @workos-inc/node
   ```
7. Install keytar for Keychain storage:
   ```bash
   npm install keytar
   npm run rebuild:native
   ```

---

## What to Build

### 1. Custom URL scheme registration
- Register `cornflake://` as a custom URL scheme in the Electron app
- When WorkOS redirects to `cornflake://auth/callback?code=...`, Electron intercepts it
- Extract the `code` parameter and exchange it for a session token

In `electron/main/index.ts`:
```typescript
// Register custom protocol
app.setAsDefaultProtocolClient('cornflake')

// Handle protocol callback
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleAuthCallback(url) // extract code, exchange for token
})
```

### 2. Auth module
File: `electron/main/modules/auth/index.ts`

Responsibilities:
- `initiateLogin()` — build WorkOS AuthKit URL, open in system browser
- `handleCallback(code)` — exchange code for session token via WorkOS SDK
- `getSession()` — read token from Keychain, validate, return user profile
- `logout()` — clear Keychain token, emit auth:logout to renderer
- `refreshSession()` — silently refresh expired token

WorkOS SDK usage:
```typescript
import { WorkOS } from '@workos-inc/node'
const workos = new WorkOS(process.env.WORKOS_API_KEY)

// Get authorization URL
const authUrl = workos.userManagement.getAuthorizationUrl({
  provider: 'GoogleOAuth',
  redirectUri: process.env.WORKOS_REDIRECT_URI,
  clientId: process.env.WORKOS_CLIENT_ID,
})

// Exchange code for token — response includes Google OAuth tokens
// because "Return Google OAuth tokens" is enabled in WorkOS dashboard
const { user, accessToken, refreshToken, oauthTokens } = 
  await workos.userManagement.authenticateWithCode({
    code,
    clientId: process.env.WORKOS_CLIENT_ID,
  })

// oauthTokens contains:
// {
//   accessToken: string  — Google access token (for Calendar API)
//   refreshToken: string — Google refresh token
//   scopes: string[]     — includes calendar.readonly
// }
```

### 3. Keychain storage
Use `keytar` to store tokens securely:
```typescript
import keytar from 'keytar'
const SERVICE = 'cornflake'

// WorkOS session tokens
await keytar.setPassword(SERVICE, 'workos_access_token', accessToken)
await keytar.setPassword(SERVICE, 'workos_refresh_token', refreshToken)

// Google OAuth tokens (returned by WorkOS because 
// "Return Google OAuth tokens" is enabled)
// These replace the existing Google Calendar OAuth tokens
await keytar.setPassword(SERVICE, 'google_access_token', oauthTokens.accessToken)
await keytar.setPassword(SERVICE, 'google_refresh_token', oauthTokens.refreshToken)

// Read
const workosToken = await keytar.getPassword(SERVICE, 'workos_access_token')
const googleToken = await keytar.getPassword(SERVICE, 'google_access_token')

// Clear all on logout
const keys = ['workos_access_token', 'workos_refresh_token', 
               'google_access_token', 'google_refresh_token']
await Promise.all(keys.map(k => keytar.deletePassword(SERVICE, k)))
```

### 4. Users table in SQLite
Add migration `011_add_users_and_user_id.sql`:

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,           -- WorkOS user_id
  email TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Add user_id to all existing tables
ALTER TABLE meetings ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE speakers ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE voice_profiles ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE lists ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE oauth_tokens ADD COLUMN user_id TEXT REFERENCES users(id);
```

All new rows must include `user_id` from the logged-in session.

### 5. Login screen (renderer)
File: `electron/renderer/src/components/LoginScreen/index.tsx`

- Shown on app launch if no valid session exists
- Full-screen, dark theme matching ui-spec.md
- Cornflake logo/wordmark centred
- "Sign in with Google" button — calls `window.electronAPI.initiateLogin()`
- Tagline: "Your meetings, organised."
- No other navigation — login is the only option before auth

Design:
```
┌─────────────────────────────────┐
│                                 │
│                                 │
│         cornflake               │
│                                 │
│    Your meetings, organised.    │
│                                 │
│  ┌───────────────────────────┐  │
│  │  Sign in with Google      │  │
│  └───────────────────────────┘  │
│                                 │
└─────────────────────────────────┘
```

### 6. App.tsx auth gate
- On mount: call `window.electronAPI.getSession()`
- If session valid → render main app UI
- If no session → render `<LoginScreen />`
- Listen for `auth:login` IPC event → transition to main app
- Listen for `auth:logout` IPC event → transition to login screen

### 7. IPC channels (additions)
```typescript
// Renderer → Main
'auth:initiateLogin'    payload: none
'auth:logout'           payload: none
'auth:getSession'       payload: none → returns UserProfile | null

// Main → Renderer  
'auth:login'            payload: UserProfile
'auth:logout'           payload: none
```

### 8. Profile section update
The sidebar profile section (bottom left) should now show:
- WorkOS profile picture (from `avatar_url`)
- User's first name (from WorkOS profile)
- Click → popover with name, email, "Sign out" button
- Sign out calls `auth:logout` IPC

---

## Google Calendar Integration — Unified Flow

Because "Return Google OAuth tokens" is enabled in WorkOS, the user's Google access token (with `calendar.readonly` scope) is returned alongside the WorkOS session token during sign-in. This means the user only signs in once — no separate "Connect Google Calendar" step needed.

**Changes to the existing calendar watcher:**
- The existing Google Calendar OAuth flow (separate OAuth popup, `oauth_tokens` table) is replaced
- On login, store the Google access token and refresh token from WorkOS in Keychain
- Pass the Google access token from Keychain to the calendar watcher module instead of reading from `oauth_tokens` table
- The calendar watcher module itself does not change — only where it reads the token from
- Remove the "Connect Google Calendar" button from the sidebar — calendar is always connected when the user is signed in
- Remove the `initiateOAuthFlow` / Google OAuth popup code from the calendar watcher module

**Token refresh:**
- Google access tokens expire after 1 hour
- When the calendar watcher receives a 401 from Google, refresh the token using the stored Google refresh token via the Google OAuth endpoint
- Store the new access token back in Keychain

**Migration for existing users (pre-Phase 2A):**
- Users who previously connected Google Calendar via the old flow have tokens in the `oauth_tokens` SQLite table
- On first WorkOS login, if valid Google tokens exist in `oauth_tokens`, migrate them to Keychain and delete from `oauth_tokens`
- This ensures no disruption for existing users

---

## Verification

After building Phase 2A, verify:

1. Fresh app launch → login screen appears
2. Click "Sign in with Google" → system browser opens WorkOS consent screen
3. Complete Google OAuth → browser redirects to `cornflake://auth/callback`
4. Electron intercepts callback → exchanges code → stores WorkOS and Google tokens in Keychain
5. Main app UI loads with correct user name and avatar
6. Calendar events appear in the right panel automatically — no "Connect Google Calendar" prompt
7. Quit and relaunch app → session restored from Keychain, no login required, calendar still connected
8. Click "Sign out" → all Keychain tokens cleared, login screen shown, calendar events cleared
9. All new DB rows have `user_id` populated
10. "Connect Google Calendar" button is no longer visible in the sidebar

