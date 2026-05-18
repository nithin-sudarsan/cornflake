// macOS microphone permission helper.
//
// Screen Recording is intentionally NOT checked here: ScreenCaptureKit /
// SCContentSharingPicker manages its own permission grant separately from
// the legacy TCC entry that systemPreferences.getMediaAccessStatus('screen')
// returns — that API reports 'denied' for ScreenCaptureKit apps even after
// the user has granted access. Letting SCStream raise the system prompt
// natively when it's first started is the correct behaviour.

import { systemPreferences, shell } from 'electron'

export type PermissionStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'

function normalise(s: string | undefined): PermissionStatus {
  switch (s) {
    case 'granted':
    case 'denied':
    case 'not-determined':
    case 'restricted':
      return s
    default:
      return 'unknown'
  }
}

export function getMicStatus(): PermissionStatus {
  if (process.platform !== 'darwin') return 'granted'
  return normalise(systemPreferences.getMediaAccessStatus('microphone'))
}

/**
 * If mic status is 'not-determined', trigger the macOS prompt and wait for
 * the user's response. Returns the resulting status.
 */
export async function ensureMicAccess(): Promise<PermissionStatus> {
  if (process.platform !== 'darwin') return 'granted'

  const current = getMicStatus()
  if (current !== 'not-determined') return current

  try {
    const ok = await systemPreferences.askForMediaAccess('microphone')
    return ok ? 'granted' : 'denied'
  } catch (err) {
    console.error('[permissions] askForMediaAccess(microphone) failed:', (err as Error).message)
    return getMicStatus()
  }
}

export function openMicSettings(): void {
  shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
  )
}

export function openScreenSettings(): void {
  shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
  )
}
