import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { NativeGestureModule } from '../src/claude/gesture'
import { handlePermissionGesture } from '../src/claude/gesture'

const LOCK_FILE = '/tmp/vibe-haptic-gesture.lock'

beforeEach(() => {
  if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE)
})
afterEach(() => {
  if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE)
})

describe('Gesture Lock File', () => {
  test('acquireGestureLock creates lock file with current PID', async () => {
    const { acquireGestureLock, releaseGestureLock } = await import('../src/claude/gesture')
    const result = acquireGestureLock()
    expect(result).toBe(true)
    expect(existsSync(LOCK_FILE)).toBe(true)
    const content = readFileSync(LOCK_FILE, 'utf-8')
    expect(parseInt(content, 10)).toBe(process.pid)
    releaseGestureLock()
  })

  test('acquireGestureLock returns false if lock held by live process', async () => {
    const { acquireGestureLock, releaseGestureLock } = await import('../src/claude/gesture')
    // Write our own PID (a live process) to simulate held lock
    writeFileSync(LOCK_FILE, String(process.pid))

    const result = acquireGestureLock()
    expect(result).toBe(false)

    releaseGestureLock()
  })

  test('acquireGestureLock succeeds if lock held by dead process', async () => {
    const { acquireGestureLock, releaseGestureLock } = await import('../src/claude/gesture')
    // Write a very high PID that almost certainly doesn't exist
    writeFileSync(LOCK_FILE, '9999999')

    const result = acquireGestureLock()
    expect(result).toBe(true)

    releaseGestureLock()
  })

  test('releaseGestureLock removes lock file', async () => {
    const { acquireGestureLock, releaseGestureLock } = await import('../src/claude/gesture')
    acquireGestureLock()
    expect(existsSync(LOCK_FILE)).toBe(true)

    releaseGestureLock()
    expect(existsSync(LOCK_FILE)).toBe(false)
  })
})

function createMockNative(onGesture?: (cb: (gesture: string) => void) => void): {
  native: NativeGestureModule
  calls: Array<{ fn: string; args: unknown[] }>
} {
  const calls: Array<{ fn: string; args: unknown[] }> = []
  const native: NativeGestureModule = {
    startTouchListener: (cb, _timeout?) => {
      if (onGesture) onGesture(cb)
    },
    stopTouchListener: () => {
      calls.push({ fn: 'stopTouchListener', args: [] })
    },
    sendKeystrokeToTerminal: (pid, key) => {
      calls.push({ fn: 'sendKeystrokeToTerminal', args: [pid, key] })
    },
    isAccessibilityGranted: () => true,
    findTerminalPid: () => 12345,
  }
  return { native, calls }
}

describe('handlePermissionGesture', () => {
  test('sends "1" keystroke on single tap (Yes)', async () => {
    const { native, calls } = createMockNative((cb) => {
      setTimeout(() => cb('single'), 10)
    })

    await handlePermissionGesture(12345, {
      nativeModule: native,
      config: { gesture: { enabled: true, tapTimeout: 300, listenTimeout: 10_000 } },
    })

    const keystrokeCall = calls.find((c) => c.fn === 'sendKeystrokeToTerminal')
    expect(keystrokeCall).toBeDefined()
    expect(keystrokeCall!.args).toEqual([12345, '1'])
  })

  test('sends "3" keystroke on double tap (No)', async () => {
    const { native, calls } = createMockNative((cb) => {
      setTimeout(() => cb('double'), 10)
    })

    await handlePermissionGesture(12345, {
      nativeModule: native,
      config: { gesture: { enabled: true, tapTimeout: 300, listenTimeout: 10_000 } },
    })

    const keystrokeCall = calls.find((c) => c.fn === 'sendKeystrokeToTerminal')
    expect(keystrokeCall).toBeDefined()
    expect(keystrokeCall!.args).toEqual([12345, '3'])
  })

  test('triggers confirm-yes haptic on single tap', async () => {
    const triggeredPatterns: string[] = []
    const { native } = createMockNative((cb) => {
      setTimeout(() => cb('single'), 10)
    })

    await handlePermissionGesture(12345, {
      nativeModule: native,
      config: { gesture: { enabled: true, tapTimeout: 300, listenTimeout: 10_000 } },
      onPatternTriggered: (name) => triggeredPatterns.push(name),
    })

    expect(triggeredPatterns).toContain('confirm-yes')
  })

  test('auto-stops after listenTimeout with no gesture', async () => {
    let stopCalled = false
    const { native } = createMockNative() // Never calls callback
    native.stopTouchListener = () => {
      stopCalled = true
    }

    await handlePermissionGesture(12345, {
      nativeModule: native,
      config: { gesture: { enabled: true, tapTimeout: 300, listenTimeout: 100 } },
    })

    expect(stopCalled).toBe(true)
  })

  test('prevents duplicate responses', async () => {
    const calls: Array<{ fn: string; args: unknown[] }> = []
    const native: NativeGestureModule = {
      startTouchListener: (cb, _timeout?) => {
        // Simulate two rapid gestures
        setTimeout(() => cb('single'), 10)
        setTimeout(() => cb('single'), 20)
      },
      stopTouchListener: () => {},
      sendKeystrokeToTerminal: (_pid, key) => {
        calls.push({ fn: 'sendKeystrokeToTerminal', args: [key] })
      },
      isAccessibilityGranted: () => true,
      findTerminalPid: () => 12345,
    }

    await handlePermissionGesture(12345, {
      nativeModule: native,
      config: { gesture: { enabled: true, tapTimeout: 300, listenTimeout: 10_000 } },
    })

    // Wait for second callback to fire
    await new Promise((r) => setTimeout(r, 50))

    const keystrokeCalls = calls.filter((c) => c.fn === 'sendKeystrokeToTerminal')
    expect(keystrokeCalls.length).toBe(1)
  })
})
