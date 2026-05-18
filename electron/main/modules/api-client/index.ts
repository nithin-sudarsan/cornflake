import { getToken as readCachedToken } from '../auth/token-store'

function backendUrl(): string {
  const url = process.env.BACKEND_URL || 'http://localhost:3000'
  return url.replace(/\/$/, '')
}

// ---------------------------------------------------------------------------
// In-memory token read (Keychain is primed once at app boot — see token-store)
// ---------------------------------------------------------------------------

async function getToken(): Promise<string> {
  const token = readCachedToken('workos_access_token')
  if (!token) throw new Error('No session token — user must be logged in')
  return token
}

// ---------------------------------------------------------------------------
// Auto-refresh on 401
// ---------------------------------------------------------------------------

// Registered by registerIpcHandlers() after app ready.
// Returns true if a new token was stored, false if refresh failed (triggers logout).
let _refreshHandler: (() => Promise<boolean>) | null = null

export function setRefreshHandler(fn: () => Promise<boolean>): void {
  _refreshHandler = fn
}

// Single in-flight refresh — all concurrent 401 callers wait for the same promise.
let _refreshing: Promise<boolean> | null = null

async function tryRefresh(): Promise<boolean> {
  if (!_refreshHandler) return false

  if (!_refreshing) {
    _refreshing = _refreshHandler().finally(() => { _refreshing = null })
  }
  return _refreshing
}

// ---------------------------------------------------------------------------
// Fetch helpers with auto-refresh retry
// ---------------------------------------------------------------------------

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  isRetry = false
): Promise<Response> {
  const res = await fetch(url, init)

  if (res.status === 401 && !isRetry) {
    console.log('[api-client] 401 received — attempting token refresh...')
    const refreshed = await tryRefresh()

    if (!refreshed) {
      console.warn('[api-client] Refresh failed — session ended')
      throw new Error('SESSION_EXPIRED')
    }

    // Retry with the fresh token now in Keychain
    const newToken = await getToken()
    const newInit: RequestInit = {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        Authorization: `Bearer ${newToken}`,
      },
    }
    return fetchWithRetry(url, newInit, true)
  }

  return res
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function apiGet(path: string): Promise<any> {
  const token = await getToken()
  const res = await fetchWithRetry(`${backendUrl()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Backend ${path} → ${res.status}`)
  return res.json()
}

export async function apiPost(path: string, body: unknown): Promise<any> {
  const token = await getToken()
  const res = await fetchWithRetry(`${backendUrl()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Backend ${path} → ${res.status}: ${text}`)
  }
  return res.json()
}

// No auth — used for the initial token exchange
export async function apiPostPublic(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${backendUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Backend ${path} → ${res.status}: ${text}`)
  }
  return res.json()
}

// Multipart upload (audio files)
export async function apiPostForm(path: string, formData: FormData): Promise<any> {
  const token = await getToken()
  const res = await fetchWithRetry(`${backendUrl()}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Backend ${path} → ${res.status}: ${text}`)
  }
  return res.json()
}
