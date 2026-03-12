import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { loadConfig } from '../config'
import { handlePermissionGesture } from '../gesture'
import { createHapticEngine } from '../haptic'
import { loadNativeModule } from '../native'
import type { GestureConfig } from '../types'

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
    return
  }

  if (input.hook_event_name !== 'Notification') {
    debug('Unknown hook event', { hook_event_name: input.hook_event_name })
    return
  }

  // Non-permission notifications: haptic only
  if (input.notification_type !== 'permission_prompt') {
    await engine.triggerForEvent('prompt')
    return
  }

  // Permission prompt: try gesture + haptic
  debug('Permission prompt detected — checking gesture eligibility')
  const gestureConfig = config.gesture as GestureConfig

  if (!gestureConfig.enabled) {
    await engine.triggerForEvent('prompt')
    return
  }

  const native = loadNativeModule()
  if (!native?.isAccessibilityGranted()) {
    debug('Gesture not available, haptic only')
    await engine.triggerForEvent('prompt')
    return
  }

  const terminalPid = native.findTerminalPid()
  if (terminalPid === null) {
    debug('Terminal PID not found, haptic only')
    await engine.triggerForEvent('prompt')
    return
  }

  debug('Starting gesture listener in-process', { terminalPid })
  await Promise.all([
    engine.triggerForEvent('prompt'),
    handlePermissionGesture(terminalPid, {
      nativeModule: native,
      engine,
      gesture: gestureConfig,
    }),
  ])
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
