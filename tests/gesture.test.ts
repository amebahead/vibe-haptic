import { describe, expect, test } from 'bun:test'
import type { GestureHandlerOptions } from '../src/gesture'
import { handlePermissionGesture } from '../src/gesture'
import type { HapticConfig } from '../src/types'

const DEFAULT_GESTURE = { enabled: true, tapTimeout: 300, listenTimeout: 10_000 }

function createMockEngine() {
  return { trigger: () => {}, triggerForEvent: async () => {} } as unknown as GestureHandlerOptions['engine']
}

function createMockNative(onGesture?: (cb: (gesture: string) => void) => void) {
  const calls: Array<{ fn: string; args: unknown[] }> = []
  const nativeModule = {
    startTouchListener: (cb: (gesture: string) => void, _timeout?: number) => {
      if (onGesture) onGesture(cb)
    },
    stopTouchListener: () => {
      calls.push({ fn: 'stopTouchListener', args: [] })
    },
    sendKeystrokeToTerminal: (pid: number, key: string) => {
      calls.push({ fn: 'sendKeystrokeToTerminal', args: [pid, key] })
    },
  }
  return { nativeModule, calls }
}

describe('handlePermissionGesture', () => {
  test('sends "1" keystroke on single tap (Yes)', async () => {
    const { nativeModule, calls } = createMockNative((cb) => {
      setTimeout(() => cb('single'), 10)
    })

    await handlePermissionGesture(12345, {
      nativeModule,
      engine: createMockEngine(),
      gesture: DEFAULT_GESTURE,
    })

    const keystrokeCall = calls.find((c) => c.fn === 'sendKeystrokeToTerminal')
    expect(keystrokeCall).toBeDefined()
    expect(keystrokeCall!.args).toEqual([12345, '1'])
  })

  test('sends "3" keystroke on double tap (No)', async () => {
    const { nativeModule, calls } = createMockNative((cb) => {
      setTimeout(() => cb('double'), 10)
    })

    await handlePermissionGesture(12345, {
      nativeModule,
      engine: createMockEngine(),
      gesture: DEFAULT_GESTURE,
    })

    const keystrokeCall = calls.find((c) => c.fn === 'sendKeystrokeToTerminal')
    expect(keystrokeCall).toBeDefined()
    expect(keystrokeCall!.args).toEqual([12345, '3'])
  })

  test('triggers alert haptic on gesture', async () => {
    const triggeredPatterns: string[] = []
    const { nativeModule } = createMockNative((cb) => {
      setTimeout(() => cb('single'), 10)
    })

    await handlePermissionGesture(12345, {
      nativeModule,
      engine: createMockEngine(),
      gesture: DEFAULT_GESTURE,
      onPatternTriggered: (name) => triggeredPatterns.push(name),
    })

    expect(triggeredPatterns).toContain('alert')
  })

  test('auto-stops after listenTimeout with no gesture', async () => {
    let stopCalled = false
    const { nativeModule } = createMockNative() // Never calls callback
    nativeModule.stopTouchListener = () => {
      stopCalled = true
    }

    await handlePermissionGesture(12345, {
      nativeModule,
      engine: createMockEngine(),
      gesture: { ...DEFAULT_GESTURE, listenTimeout: 100 },
    })

    expect(stopCalled).toBe(true)
  })

  test('prevents duplicate responses', async () => {
    const calls: Array<{ fn: string; args: unknown[] }> = []
    const nativeModule = {
      startTouchListener: (cb: (gesture: string) => void, _timeout?: number) => {
        setTimeout(() => cb('single'), 10)
        setTimeout(() => cb('single'), 20)
      },
      stopTouchListener: () => {},
      sendKeystrokeToTerminal: (_pid: number, key: string) => {
        calls.push({ fn: 'sendKeystrokeToTerminal', args: [key] })
      },
    }

    await handlePermissionGesture(12345, {
      nativeModule,
      engine: createMockEngine(),
      gesture: DEFAULT_GESTURE,
    })

    await new Promise((r) => setTimeout(r, 50))

    const keystrokeCalls = calls.filter((c) => c.fn === 'sendKeystrokeToTerminal')
    expect(keystrokeCalls.length).toBe(1)
  })
})
