#!/usr/bin/env node
// Build a stripped-down .env.production from the developer's local .env,
// containing ONLY the non-secret keys the packaged Electron client needs.
// Output is shipped via electron-builder's extraResources entry and loaded
// at runtime from process.resourcesPath/.env (see electron/main/index.ts).

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC  = path.join(ROOT, '.env')
const OUT  = path.join(ROOT, 'build', '.env.production')

const ALLOWED_KEYS = new Set([
  'BACKEND_URL',
  'WORKOS_CLIENT_ID',
  'WORKOS_CALLBACK_PORT',
])

if (!fs.existsSync(SRC)) {
  console.error(`[build-prod-env] ${SRC} not found — cannot build production env`)
  process.exit(1)
}

const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/)
const out = []
const seen = new Set()

for (const line of lines) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq === -1) continue
  const key = trimmed.slice(0, eq).trim()
  if (!ALLOWED_KEYS.has(key)) continue
  out.push(trimmed)
  seen.add(key)
}

const missing = [...ALLOWED_KEYS].filter(k => !seen.has(k))
if (missing.length > 0) {
  console.warn('[build-prod-env] WARNING — missing from .env:', missing.join(', '))
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, out.join('\n') + '\n', { mode: 0o644 })

console.log(`[build-prod-env] wrote ${OUT}`)
console.log(`[build-prod-env] keys: ${[...seen].join(', ')}`)
