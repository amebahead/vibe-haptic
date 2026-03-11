import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { loadConfig } from '../config'
import { createHapticEngine } from '../haptic'
import type { GestureConfig } from '../types'
import { handlePermissionGesture, loadNativeModule } from './gesture'

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

export async function handleHookEvent(input: ClaudeHookInput): Promise<void> {
  debug('handleHookEvent called', input)

  const config = loadConfig('claude')
  const engine = createHapticEngine('claude')

  if (input.hook_event_name === 'Stop') {
    debug('Triggering stop event')
    await engine.triggerForEvent('stop')
  } else if (input.hook_event_name === 'Notification') {
    debug('Triggering prompt event for notification', { notification_type: input.notification_type })

    if (input.notification_type === 'permission_prompt') {
      debug('Permission prompt detected — checking gesture eligibility')

      const gestureConfig = config.gesture as GestureConfig
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
            engine,
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
