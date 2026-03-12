import type { HapticEngine } from '../haptic'
import type { GestureConfig } from '../types'

export type GestureType = 'single' | 'double'

export interface GestureHandlerOptions {
  nativeModule: {
    startTouchListener: (callback: (gesture: GestureType) => void, tapTimeoutMs?: number) => void
    stopTouchListener: () => void
    sendKeystrokeToTerminal: (terminalPid: number, key: string) => void
  }
  engine: HapticEngine
  gesture: GestureConfig
  onPatternTriggered?: (patternName: string) => void
}

export async function handlePermissionGesture(
  terminalPid: number,
  options: GestureHandlerOptions,
): Promise<void> {
  const { nativeModule, engine, gesture } = options
  let answered = false

  return new Promise<void>((resolve) => {
    const cleanup = () => {
      nativeModule.stopTouchListener()
      resolve()
    }

    nativeModule.startTouchListener((gestureType: GestureType) => {
      if (answered) return
      answered = true

      const key = gestureType === 'single' ? '1' : '3'
      nativeModule.sendKeystrokeToTerminal(terminalPid, key)

      const pattern = gestureType === 'single' ? 'confirm-yes' : 'confirm-no'
      options.onPatternTriggered?.(pattern)
      engine.trigger(pattern)

      cleanup()
    }, gesture.tapTimeout)

    setTimeout(() => {
      if (!answered) cleanup()
    }, gesture.listenTimeout)
  })
}
