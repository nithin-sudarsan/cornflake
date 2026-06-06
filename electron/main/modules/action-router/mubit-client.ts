// Mubit memory integration for the action router.
//
// mubit.learn.init() is called once at app startup with agent_id "action-router".
// Every "Do it" / "Dismiss" tap is recorded so Mubit can learn over time which
// action types this team approves for which task patterns.
//
// If the mubit package is not installed or fails to load, all calls are no-ops.

interface MubitLearn {
  init(opts: { agent_id: string; [key: string]: unknown }): Promise<void>
  record?(opts: Record<string, unknown>): Promise<void>
}

interface MubitModule {
  learn: MubitLearn
  default?: { learn: MubitLearn }
}

let _mubit: MubitModule | null = null

export async function initMubit(): Promise<void> {
  try {
    // Dynamic require — mubit is an optional runtime dependency.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('mubit') as MubitModule
    // Handle both ESM-style (mod.default) and CJS-style (mod.learn) exports.
    _mubit = mod.default ?? mod
    await _mubit.learn.init({
      agent_id: 'action-router',
      ...(process.env.MUBIT_API_KEY && { api_key: process.env.MUBIT_API_KEY }),
      ...(process.env.MUBIT_API_URL && { api_url: process.env.MUBIT_API_URL }),
    })
    console.log('[mubit] initialized — agent_id: action-router')
  } catch (err) {
    console.warn('[mubit] package unavailable — outcomes will not be recorded:', (err as Error).message)
    _mubit = null
  }
}

export async function recordActionOutcome(
  taskId: string,
  taskTitle: string,
  actionType: string,
  outcome: 'approved' | 'dismissed',
): Promise<void> {
  if (!_mubit?.learn?.record) return
  try {
    await _mubit.learn.record({
      agent_id:   'action-router',
      taskId,
      taskTitle,
      actionType,
      outcome,
      timestamp:  Date.now(),
    })
    console.log(`[mubit] recorded outcome: ${outcome} for "${taskTitle}" (${actionType})`)
  } catch (err) {
    console.warn('[mubit] Failed to record outcome:', (err as Error).message)
  }
}
