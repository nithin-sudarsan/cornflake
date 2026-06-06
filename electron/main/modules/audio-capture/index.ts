// Module 4 — Audio Capture
// Loads the native cornflake_capture.node addon and wraps it in a Promise API.
// startCapture() → starts SCStream (system audio) + AVAudioEngine (mic)
// stopCapture()  → stops streams, finalises WAV files, returns { micPath, systemAudioPath }

import path from 'path'
import { app } from 'electron'

// In a packaged build the native addon is copied into Resources via extraResources.
// In dev it lives in the source tree.
const addonPath = app.isPackaged
  ? path.join(process.resourcesPath, 'cornflake_capture.node')
  : path.join(__dirname, '..', '..', '..', '..', 'swift', 'build', 'Release', 'cornflake_capture.node')

type Addon = {
  startCapture: (cb: (err: string | null) => void) => void
  stopCapture:  (cb: (err: string | null, result: { micPath: string; systemAudioPath: string } | null) => void) => void
  getMicInputPIDs?: () => number[]
}

// Lazy-load so the app starts even if the addon hasn't been compiled yet.
// Errors are deferred to the first startCapture() / stopCapture() call.
let _addon: Addon | null = null
let _addonError: string | null = null
function getAddon(): Addon {
  if (_addon) return _addon
  if (_addonError) throw new Error(_addonError)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _addon = require(addonPath) as Addon
    return _addon
  } catch (err) {
    _addonError = (err as Error).message
    throw err
  }
}

export interface AudioPaths {
  micPath: string
  systemAudioPath: string
}

export function startCapture(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      getAddon().startCapture((err) => {
        if (err) reject(new Error(err))
        else resolve()
      })
    } catch (err) {
      reject(err)
    }
  })
}

// Returns POSIX PIDs of every process currently reading from the microphone.
// Used by the meeting-app watcher to detect browser-based meetings. Returns
// an empty array if the native function isn't available (older addon build).
export function getMicInputPIDs(): number[] {
  try {
    const a = getAddon()
    if (!a.getMicInputPIDs) return []
    return a.getMicInputPIDs()
  } catch (err) {
    console.error('[audio-capture] getMicInputPIDs failed:', (err as Error).message)
    return []
  }
}

export function stopCapture(): Promise<AudioPaths> {
  return new Promise((resolve, reject) => {
    try {
      getAddon().stopCapture((err, result) => {
        if (err) reject(new Error(err))
        else if (!result) reject(new Error('stopCapture returned no paths'))
        else resolve(result)
      })
    } catch (err) {
      reject(err)
    }
  })
}
