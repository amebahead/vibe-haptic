import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHapticEngine } from '../haptic'
import type { GestureConfig } from '../types'

const LOCK_FILE = '/tmp/vibe-haptic-gesture.lock'

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function acquireGestureLock(): boolean {
  // Try atomic exclusive create first (prevents TOCTOU race)
  try {
    writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    // File exists — check if held by a live process
  }

  try {
    const existingPid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10)
    if (!Number.isNaN(existingPid) && isProcessAlive(existingPid)) {
      return false
    }
  } catch {
    // Stale or corrupt lock file — proceed to overwrite
  }

  writeFileSync(LOCK_FILE, String(process.pid))
  return true
}

export function releaseGestureLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      unlinkSync(LOCK_FILE)
    }
  } catch {
    // Best-effort cleanup
  }
}

export type GestureType = 'single' | 'double'

export interface NativeGestureModule {
  startTouchListener: (callback: (gesture: GestureType) => void, tapTimeoutMs?: number) => void
  stopTouchListener: () => void
  sendKeystrokeToTerminal: (terminalPid: number, key: string) => void
  isAccessibilityGranted: () => boolean
  findTerminalPid: () => number | null
}

export interface GestureHandlerOptions {
  nativeModule?: NativeGestureModule
  config?: { gesture: GestureConfig }
  onPatternTriggered?: (patternName: string) => void
}

export async function handlePermissionGesture(
  terminalPid: number,
  options?: GestureHandlerOptions,
): Promise<void> {
  const native = options?.nativeModule ?? loadNativeModule()
  if (!native) return

  const gestureConfig = options?.config?.gesture ?? {
    enabled: true,
    tapTimeout: 300,
    listenTimeout: 10_000,
  }

  if (!gestureConfig.enabled) return

  // Acquire lock
  if (!acquireGestureLock()) return

  // Clean up lock on exit (use once to avoid stale handlers)
  process.once('exit', releaseGestureLock)
  process.once('SIGTERM', () => {
    releaseGestureLock()
    process.exit(0)
  })
  process.once('SIGINT', () => {
    releaseGestureLock()
    process.exit(0)
  })

  const engine = createHapticEngine('claude')
  let answered = false

  return new Promise<void>((resolve) => {
    const cleanup = () => {
      native.stopTouchListener()
      releaseGestureLock()
      resolve()
    }

    native.startTouchListener(
      (gesture: GestureType) => {
        if (answered) return
        answered = true

        const key = gesture === 'single' ? 'y' : 'n'
        native.sendKeystrokeToTerminal(terminalPid, key)

        const pattern = gesture === 'single' ? 'confirm-yes' : 'confirm-no'
        if (options?.onPatternTriggered) {
          options.onPatternTriggered(pattern)
        }
        engine.trigger(pattern)

        cleanup()
      },
      gestureConfig.tapTimeout,
    )

    // Auto-stop after timeout
    setTimeout(() => {
      if (!answered) {
        cleanup()
      }
    }, gestureConfig.listenTimeout)
  })
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
