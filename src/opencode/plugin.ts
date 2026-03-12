import { loadConfig } from '../config'
import { handlePermissionGesture } from '../gesture'
import { createHapticEngine } from '../haptic'
import { loadNativeModule } from '../native'
import type { GestureConfig } from '../types'

type SessionStatusType = 'idle' | 'busy' | 'retry'

type SessionStatusEvent = {
  type: 'session.status'
  properties: { sessionID: string; status: { type: SessionStatusType } }
}

type PermissionUpdatedEvent = {
  type: 'permission.updated'
  properties: { sessionID: string; [key: string]: unknown }
}

type QuestionAskedEvent = {
  type: 'question.asked'
  properties: { sessionID: string; [key: string]: unknown }
}

type OpenCodeEvent =
  | SessionStatusEvent
  | PermissionUpdatedEvent
  | QuestionAskedEvent
  | { type: string; properties?: Record<string, unknown> }

type OpenCodeClient = {
  session: {
    get(options: { path: { id: string } }): Promise<{ data?: { parentID?: string } }>
  }
}

type PluginInput = {
  client: OpenCodeClient
  project: unknown
  directory: string
  worktree: string
  serverUrl: URL
  $: unknown
}

export const vibeHapticPlugin = async (ctx: PluginInput) => {
  const config = loadConfig('opencode')
  const engine = createHapticEngine('opencode')
  const subprocessCache = new Map<string, boolean>()

  async function isSubprocess(sessionID: string): Promise<boolean> {
    const cached = subprocessCache.get(sessionID)
    if (cached !== undefined) return cached

    try {
      const response = await ctx.client.session.get({ path: { id: sessionID } })
      const result = response.data?.parentID != null
      subprocessCache.set(sessionID, result)
      return result
    } catch {
      return false
    }
  }

  function getSessionID(event: OpenCodeEvent): string | undefined {
    const props = event.properties
    if (props && typeof props === 'object' && 'sessionID' in props) {
      return props.sessionID as string
    }
    return undefined
  }

  async function tryGestureWithHaptic(): Promise<void> {
    const gestureConfig = config.gesture as GestureConfig

    if (!gestureConfig.enabled) {
      await engine.triggerForEvent('prompt')
      return
    }

    const native = loadNativeModule()
    if (!native?.isAccessibilityGranted()) {
      await engine.triggerForEvent('prompt')
      return
    }

    const terminalPid = native.findTerminalPid()
    if (terminalPid === null) {
      await engine.triggerForEvent('prompt')
      return
    }

    await Promise.all([
      engine.triggerForEvent('prompt'),
      handlePermissionGesture(terminalPid, {
        nativeModule: native,
        engine,
        gesture: gestureConfig,
      }),
    ])
  }

  return {
    event: async (input: { event: OpenCodeEvent }): Promise<void> => {
      const { event } = input

      const sessionID = getSessionID(event)
      if (sessionID && (await isSubprocess(sessionID))) return

      if (event.type === 'session.idle') {
        engine.triggerForEvent('stop')
      } else if (event.type === 'permission.updated') {
        await tryGestureWithHaptic()
      } else if (event.type === 'question.asked') {
        engine.triggerForEvent('prompt')
      }
    },
  }
}
