import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config'
import { createHapticEngine } from '../haptic'
import type { GestureConfig } from '../types'
import type { NativeGestureModule } from './gesture'
import { handlePermissionGesture } from './gesture'

const DEBUG = process.env.VIBE_HAPTIC_DEBUG === '1'

function debug(message: string, data?: unknown) {
  if (!DEBUG) return
  const logPath = `${homedir()}/.vibe-haptic-debug.log`
  const timestamp = new Date().toISOString()
  const logLine = data ? `[${timestamp}] ${message}: ${JSON.stringify(data, null, 2)}\n` : `[${timestamp}] ${message}\n`
  appendFileSync(logPath, logLine)
}

interface ClaudeHookInput {
  session_id: string
  transcript_path: string
  cwd: string
  hook_event_name: string
  notification_type?: string
}

const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  enabled: true,
  tapTimeout: 300,
  listenTimeout: 10_000,
}

function loadNativeModule(): NativeGestureModule | null {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url))
    const nativePath = join(currentDir, '..', 'native', 'vibe-haptic-native.node')
    const require = createRequire(import.meta.url)
    return require(nativePath)
  } catch {
    return null
  }
}

export async function handleHookEvent(input: ClaudeHookInput): Promise<void> {
  debug('handleHookEvent called', input)

  const engine = createHapticEngine('claude')

  if (input.hook_event_name === 'Stop') {
    debug('Triggering stop event')
    await engine.triggerForEvent('stop')
  } else if (input.hook_event_name === 'Notification') {
    debug('Triggering prompt event for notification', { notification_type: input.notification_type })

    if (input.notification_type === 'permission_prompt') {
      debug('Permission prompt detected — checking gesture eligibility')

      const config = loadConfig('claude')
      const gestureConfig: GestureConfig = {
        ...DEFAULT_GESTURE_CONFIG,
        ...config.gesture,
      }

      const native = gestureConfig.enabled ? loadNativeModule() : null
      let terminalPid: number | null = null

      if (native?.isAccessibilityGranted()) {
        terminalPid = native.findTerminalPid()
      }

      if (terminalPid !== null && native) {
        debug('Starting gesture listener in-process', { terminalPid })
        // Run haptic + gesture listener in parallel — listener is ready when user feels the tap
        await Promise.all([
          engine.triggerForEvent('prompt'),
          handlePermissionGesture(terminalPid, {
            nativeModule: native,
            config: { gesture: gestureConfig },
          }),
        ])
      } else {
        debug('Gesture not available, haptic only')
        await engine.triggerForEvent('prompt')
      }
    } else {
      await engine.triggerForEvent('prompt')
    }
  } else {
    debug('Unknown hook event', { hook_event_name: input.hook_event_name })
  }
}

async function readStdin(): Promise<string> {
  if (typeof Bun !== 'undefined') {
    return Bun.stdin.text()
  }

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    process.stdin.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    process.stdin.on('error', reject)
  })
}

export async function main() {
  try {
    const input = await readStdin()
    const hookInput = JSON.parse(input) as ClaudeHookInput
    await handleHookEvent(hookInput)
    process.exit(0)
  } catch {
    process.exit(0)
  }
}
