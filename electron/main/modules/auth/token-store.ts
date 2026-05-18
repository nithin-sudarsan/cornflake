// In-memory cache for the four auth tokens, persisted as a SINGLE keychain
// entry. Cold start must perform exactly one Keychain read: the consolidated
// JSON blob under BUNDLE_KEY. Every later token read in the app session comes
// from _cache.

import keytar from 'keytar'

const SERVICE = 'cornflake'
const BUNDLE_KEY = 'tokens'

// Legacy per-token keychain item names. These are only deleted during logout or
// after a successful modern token write. They are intentionally NOT read during
// cold start because each item can trigger its own macOS Keychain prompt.
const LEGACY_KEYS = [
  'workos_access_token',
  'workos_refresh_token',
  'google_access_token',
  'google_refresh_token',
] as const

export type TokenKey =
  | 'workos_access_token'
  | 'workos_refresh_token'
  | 'google_access_token'
  | 'google_refresh_token'

type Cache = Partial<Record<TokenKey, string | null>>

let _cache: Cache = {}
let _primed = false
let _primePromise: Promise<void> | null = null
let _persistPromise: Promise<void> = Promise.resolve()

/**
 * Read the consolidated token blob from the Keychain in a single get.
 *
 * Safe to call multiple times — the actual Keychain access only happens once.
 */
export async function primeFromKeychain(): Promise<void> {
  if (_primed) return
  if (_primePromise) return _primePromise

  _primePromise = (async () => {
    const blob = await keytar.getPassword(SERVICE, BUNDLE_KEY)

    if (blob) {
      try {
        const parsed = JSON.parse(blob) as Cache
        _cache = { ...parsed }
        _primed = true
        console.log('[token-store] primed from consolidated keychain entry — present:',
          present(_cache) || '(none)')
        return
      } catch (err) {
        console.warn('[token-store] consolidated entry corrupt; ignoring stored tokens:', (err as Error).message)
      }
    }

    _cache = {}
    _primed = true
    console.log('[token-store] primed from consolidated keychain entry — (no tokens stored)')
  })()

  return _primePromise
}

function present(c: Cache): string {
  return (Object.keys(c) as TokenKey[]).filter(k => c[k]).join(', ')
}

/**
 * Synchronous read from the in-memory cache. Requires primeFromKeychain() to
 * have completed at least once (otherwise returns null). All token accesses
 * after boot should use this — never read Keychain directly.
 */
export function getToken(key: TokenKey): string | null {
  return _cache[key] ?? null
}

async function persistBundle(): Promise<void> {
  // Serialise persists so concurrent writes don't race the keychain.
  _persistPromise = _persistPromise.then(async () => {
    const json = JSON.stringify(_cache)
    // Delete-then-add. Writing to an EXISTING keychain item via SecItemUpdate
    // re-evaluates the item's ACL — if the ACL was created by a different
    // build of the app (dev Electron vs packaged ad-hoc-signed Cornflake.app)
    // macOS will prompt for the user's keychain password. Deleting the item
    // first (no prompt — user owns it in the login keychain) and then writing
    // via SecItemAdd creates a fresh entry whose ACL contains the current
    // binary, so subsequent writes from this same binary are silent.
    await keytar.deletePassword(SERVICE, BUNDLE_KEY).catch(() => false)
    await keytar.setPassword(SERVICE, BUNDLE_KEY, json)
  })
  return _persistPromise
}

/** Write-through: cache updated immediately, keychain bundle persisted asynchronously. */
export async function setToken(key: TokenKey, value: string): Promise<void> {
  _cache[key] = value
  await persistBundle()
  await deleteLegacyKeys()
}

/** Write-through delete. */
export async function deleteToken(key: TokenKey): Promise<void> {
  _cache[key] = null
  await persistBundle()
}

/** Clear all tokens. Removes the consolidated bundle and any legacy entries. */
export async function clearAllTokens(): Promise<void> {
  _cache = {}
  await Promise.all([
    keytar.deletePassword(SERVICE, BUNDLE_KEY).catch(() => false),
    ...LEGACY_KEYS.map(k => keytar.deletePassword(SERVICE, k).catch(() => false)),
  ])
}

/** Set multiple tokens in one batched write. Skips undefined values. */
export async function setManyTokens(values: Partial<Record<TokenKey, string>>): Promise<void> {
  for (const [k, v] of Object.entries(values) as Array<[TokenKey, string | undefined]>) {
    if (typeof v === 'string') _cache[k] = v
  }
  await persistBundle()
  await deleteLegacyKeys()
}

async function deleteLegacyKeys(): Promise<void> {
  await Promise.all(LEGACY_KEYS.map(k => keytar.deletePassword(SERVICE, k).catch(() => false)))
}
