import { shell, BrowserWindow } from 'electron'
import { getDb } from '../database'
import { MAIN_CHANNELS } from '../../ipc/types'
import { startCallbackServer, buildRedirectUri, stopCallbackServer } from './deep-link-handler'
import {
  primeFromKeychain,
  getToken,
  setToken,
  setManyTokens,
  clearAllTokens,
} from './token-store'

// All Keychain I/O goes through ./token-store. The store reads each token
// exactly once on cold start (primeFromKeychain) and serves all subsequent
// reads from memory, so signing in / Cmd+R does not re-trigger TCC prompts.

export { primeFromKeychain }

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

export async function storeTokens(params: {
  workosAccessToken: string
  workosRefreshToken: string
  googleAccessToken: string
  googleRefreshToken: string
}): Promise<void> {
  await setManyTokens({
    workos_access_token:  params.workosAccessToken,
    workos_refresh_token: params.workosRefreshToken,
    google_access_token:  params.googleAccessToken,
    google_refresh_token: params.googleRefreshToken,
  })
}

export async function clearTokens(): Promise<void> {
  await clearAllTokens()
}

export async function getGoogleAccessToken(): Promise<string | null> {
  return getToken('google_access_token')
}

export async function getGoogleRefreshToken(): Promise<string | null> {
  return getToken('google_refresh_token')
}

export async function storeGoogleAccessToken(token: string): Promise<void> {
  await setToken('google_access_token', token)
}

// ---------------------------------------------------------------------------
// Session check
// ---------------------------------------------------------------------------

export interface UserProfile {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
}

export async function getSession(): Promise<UserProfile | null> {
  const accessToken = getToken('workos_access_token')
  if (!accessToken) return null

  // Use cached profile from DB — avoids a network call on every app launch
  const cached = getDb().getUserProfile()
  if (cached) {
    // We store workos_user_id in _meta separately
    const idRow = getDb().getMetaValue('workos_user_id')
    return {
      id:        idRow ?? 'unknown',
      email:     cached.email,
      name:      cached.name,
      avatarUrl: cached.picture,
    }
  }

  // Token exists but no cached profile — try to refresh
  try {
    const refreshed = await refreshSession()
    return refreshed
  } catch {
    return null
  }
}

export async function isAuthenticated(): Promise<boolean> {
  return getToken('workos_access_token') !== null
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

function buildAuthUrl(redirectUri: string): string {
  const clientId  = process.env.WORKOS_CLIENT_ID
  if (!clientId) throw new Error('WORKOS_CLIENT_ID is not set')
  // WorkOS authorization URL — built manually so the client doesn't need the
  // server-side WORKOS_API_KEY just to construct a URL.
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    provider:      'GoogleOAuth',
  })
  return `https://api.workos.com/user_management/authorize?${params.toString()}`
}

// Fixed loopback port for the OAuth callback server.
// WorkOS requires exact redirect URI registration — register this in the dashboard:
//   http://127.0.0.1:WORKOS_CALLBACK_PORT/callback
// Default port: 52069. Override via WORKOS_CALLBACK_PORT in .env.
const CALLBACK_PORT = () => parseInt(process.env.WORKOS_CALLBACK_PORT ?? '52069', 10)

/**
 * Open the WorkOS consent page in the user's browser.
 *
 * Uses a localhost callback server so the browser tab resolves cleanly with a
 * styled success page instead of spinning indefinitely on a cornflake:// URL.
 *
 * WorkOS dashboard prerequisite (one-time setup):
 *   Go to WorkOS dashboard → User Management → Redirects
 *   Add:  http://127.0.0.1:52069/callback
 *   (or whatever port WORKOS_CALLBACK_PORT is set to in .env)
 */
export async function initiateLogin(
  mainWindow: BrowserWindow,
  onSuccess?: (profile: UserProfile) => Promise<void> | void
): Promise<void> {
  try {
    const port        = CALLBACK_PORT()
    const redirectUri = buildRedirectUri(port)

    console.log('[auth] initiateLogin: starting callback server on port', port,
      '— env present:',
      { WORKOS_CLIENT_ID: !!process.env.WORKOS_CLIENT_ID,
        WORKOS_CALLBACK_PORT: process.env.WORKOS_CALLBACK_PORT ?? '(default 52069)',
        BACKEND_URL: process.env.BACKEND_URL ?? '(default localhost)' })

    await startCallbackServer(port, async (code) => {
      try {
        const profile = await handleCallback(code, mainWindow)
        await onSuccess?.(profile)
      } catch (err) {
        console.error('[auth] handleCallback failed inside callback server:', err)
      }
    })

    const url = buildAuthUrl(redirectUri)
    console.log('[auth] redirect URI:', redirectUri)
    console.log('[auth] opening browser:', url.slice(0, 80) + '...')
    shell.openExternal(url)
  } catch (err) {
    console.error('[auth] initiateLogin failed:', (err as Error).message, (err as Error).stack)
    // Re-throw so the renderer IPC handler surfaces the error to the user.
    throw err
  }
}

export async function handleCallback(
  code: string,
  mainWindow: BrowserWindow
): Promise<UserProfile> {
  console.log('[auth] handleCallback: exchanging code via backend')

  const BACKEND = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '')

  const res = await fetch(`${BACKEND}/api/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Backend auth exchange failed: ${res.status} ${text}`)
  }

  const { accessToken, refreshToken: workosRefreshToken, user, googleTokens } = await res.json() as {
    accessToken:   string
    refreshToken?: string
    user: { id: string; email: string; firstName?: string | null; avatarUrl?: string | null }
    googleTokens: { accessToken: string; refreshToken?: string }
  }

  if (!accessToken) {
    throw new Error('Backend auth exchange did not return an accessToken — check backend deployment')
  }

  if (!googleTokens?.accessToken) {
    throw new Error(
      'Google OAuth access token not returned by backend. ' +
      'Ensure "Return Google OAuth tokens" is enabled in the WorkOS dashboard ' +
      'with calendar.readonly scope.'
    )
  }

  if (!googleTokens.refreshToken) {
    console.warn('[auth] Google refresh token not returned (normal if user already consented). Calendar token will expire in ~1h.')
  }

  // Log the full exchange response shape so we can confirm which fields are present
  console.log('[auth] exchange response fields:', {
    hasAccessToken:      !!accessToken,
    accessTokenLength:   accessToken?.length,
    accessTokenPrefix:   accessToken?.substring(0, 30),
    hasRefreshToken:     !!workosRefreshToken,
    hasGoogleAccess:     !!googleTokens?.accessToken,
    hasGoogleRefresh:    !!googleTokens?.refreshToken,
    userId:              user?.id,
  })

  console.log('[auth] storing tokens in Keychain (batched)...')
  await setManyTokens({
    workos_access_token:  accessToken,
    workos_refresh_token: workosRefreshToken,
    google_access_token:  googleTokens.accessToken,
    google_refresh_token: googleTokens.refreshToken,
  })

  console.log('[auth] tokens stored in Keychain, user:', user.email)

  const name      = user.firstName ?? null
  const avatarUrl = user.avatarUrl ?? null

  // Safety net: if the previous user's data is still in local SQLite (logout
  // failed to wipe, or this is a different user logging in), wipe it before
  // we write the new user row. The next pullFromCloud() will hydrate from
  // Supabase with only this user's data.
  const existingUserIdRaw = getDb().getMetaValue('workos_user_id')
  if (existingUserIdRaw && existingUserIdRaw !== user.id) {
    console.warn(`[auth] User mismatch detected — local user ${existingUserIdRaw} != incoming ${user.id}. Wiping local data.`)
    getDb().wipeUserData()
  }

  // Write user to the SQLite users table (needed for FK integrity and sync).
  // Must happen before any meetings/tasks are written that reference user_id.
  // Note: syncModule.userId is null here (init() is called after this returns),
  // so the write hook's queueUpsert call is dropped. syncModule.init() re-queues
  // the users row directly (without user_id) after setting this.userId.
  getDb().upsertUser(user.id, user.email, name, avatarUrl)

  // Seed an initial user_profiles row from the WorkOS profile on first login.
  // Subsequent meetings enrich this markdown via the backend extract pipeline.
  // The sync layer pushes it to Supabase on the next flush (queued via the
  // write hook below; syncModule.init() runs shortly after this function returns).
  if (!getDb().getUserProfileMd(user.id)) {
    const displayName = name ?? user.email
    const seedMd = `## About me\n\n- Name: ${displayName}\n- Email: ${user.email}\n`
    getDb().upsertUserProfileMd(user.id, seedMd)
  }

  // Persist profile to _meta for fast offline access on next launch
  getDb().saveUserProfile(name ?? user.email, user.email, avatarUrl)
  getDb().setMetaValue('workos_user_id', user.id)

  const profile: UserProfile = { id: user.id, email: user.email, name, avatarUrl }

  // Note: AUTH_LOGIN is broadcast by the IPC layer (ipc/index.ts) AFTER the
  // window is shown and focused. Sending from here used to race the renderer
  // because the browser still owns focus at this point and IPC to a
  // background webContents can be deferred until the window is foregrounded.

  return profile
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export async function refreshSession(): Promise<UserProfile | null> {
  const accessToken = getToken('workos_access_token')
  if (!accessToken) return null

  const BACKEND = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '')

  // First: try the current accessToken against /api/auth/me
  try {
    const res = await fetch(`${BACKEND}/api/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (res.ok) {
      const body = await res.json() as {
        user?: { id: string; email: string; firstName?: string | null; avatarUrl?: string | null }
      }
      const user = body?.user
      if (!user?.email) {
        // /api/auth/me returned 200 but no user — treat as invalid token
        console.warn('[auth] refreshSession: /api/auth/me returned 200 but no user object')
      } else {
        const email    = user.email
        const name     = user.firstName ?? null
        const avatarUrl = user.avatarUrl ?? null

        getDb().saveUserProfile(name ?? email, email, avatarUrl)
        const idRow = getDb().getMetaValue('workos_user_id')
        if (!idRow) getDb().setMetaValue('workos_user_id', user.id)
        console.log('[auth] refreshSession: current token valid for', email)
        return { id: user.id, email, name, avatarUrl }
      }
    }

    // 401 — accessToken expired, try the WorkOS refresh token
    if (res.status === 401) {
      console.log('[auth] refreshSession: accessToken expired, attempting refresh...')
      const workosRefreshToken = getToken('workos_refresh_token')
      if (!workosRefreshToken) {
        console.warn('[auth] refreshSession: no WorkOS refresh token stored')
        return null
      }

      const refreshRes = await fetch(`${BACKEND}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: workosRefreshToken }),
      })

      if (!refreshRes.ok) {
        console.warn('[auth] refreshSession: refresh endpoint returned', refreshRes.status)
        return null
      }

      const { accessToken: newAccessToken, refreshToken: newRefreshToken, user } =
        await refreshRes.json() as {
          accessToken?:  string
          refreshToken?: string
          user?: { id: string; email: string; firstName?: string | null; avatarUrl?: string | null }
        }

      if (!newAccessToken || !user?.email) {
        console.warn('[auth] refreshSession: refresh response missing accessToken or user — forcing logout')
        return null
      }

      await setManyTokens({
        workos_access_token:  newAccessToken,
        workos_refresh_token: newRefreshToken,
      })

      const email    = user.email
      const name     = user.firstName ?? null
      const avatarUrl = user.avatarUrl ?? null

      getDb().saveUserProfile(name ?? email, email, avatarUrl)
      const idRow = getDb().getMetaValue('workos_user_id')
      if (!idRow) getDb().setMetaValue('workos_user_id', user.id)
      console.log('[auth] refreshSession: token refreshed for', email)
      return { id: user.id, email, name, avatarUrl }
    }

    return null
  } catch (err) {
    console.error('[auth] refreshSession failed:', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

export { stopCallbackServer }

export async function logout(mainWindow: BrowserWindow): Promise<void> {
  await clearTokens()

  // Wipe ALL user-owned data from local SQLite so the next user can't see it.
  // Includes profile cache, meta keys, and all data tables. The next login
  // hydrates everything fresh from Supabase via pullFromCloud().
  getDb().wipeUserData()

  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send(MAIN_CHANNELS.AUTH_LOGOUT)
  }
}
