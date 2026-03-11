import { describe, expect, test } from 'bun:test'
import { HapticEngine, parseBeat } from '../src/haptic'
import { DEFAULT_CONFIG, loadConfig } from '../src/config'
import { DEFAULT_PATTERNS, resolvePattern } from '../src/patterns'
import type { HapticConfig } from '../src/types'

const mockNativeModule = { actuate: () => {} }

function createTestEngine(config: HapticConfig) {
  return new HapticEngine(config, { nativeModule: mockNativeModule })
}

describe('HapticEngine', () => {
  test('trigger does not throw without native module', () => {
    const config: HapticConfig = {
      events: { stop: 'tap' },
    }
    const engine = createTestEngine(config)

    expect(() => engine.trigger('tap')).not.toThrow()
  })

  test('triggerForEvent maps event to pattern', () => {
    const config: HapticConfig = {
      events: { stop: 'dopamine', prompt: 'tap' },
    }
    const engine = createTestEngine(config)

    expect(() => engine.triggerForEvent('stop')).not.toThrow()
    expect(() => engine.triggerForEvent('prompt')).not.toThrow()
  })

  test('triggerForEvent ignores unmapped events', () => {
    const config: HapticConfig = {
      events: {},
    }
    const engine = createTestEngine(config)

    expect(() => engine.triggerForEvent('stop')).not.toThrow()
  })

  test('handles custom patterns', () => {
    const config: HapticConfig = {
      patterns: {
        custom: { beat: '666 444' },
      },
      events: { stop: 'custom' },
    }
    const engine = createTestEngine(config)

    expect(() => engine.trigger('custom')).not.toThrow()
  })

  test('handles string shorthand patterns', () => {
    const config: HapticConfig = {
      patterns: {
        quick: '66',
      },
      events: { stop: 'quick' },
    }
    const engine = createTestEngine(config)

    expect(() => engine.trigger('quick')).not.toThrow()
  })

  test('returns immediately (non-blocking)', () => {
    const config: HapticConfig = {
      events: { stop: 'dopamine' },
    }
    const engine = createTestEngine(config)

    const start = Date.now()
    engine.trigger('dopamine')
    const duration = Date.now() - start

    expect(duration).toBeLessThan(50)
  })
})

describe('Built-in Patterns', () => {
  const builtInPatterns = ['vibe', 'alert', 'dopamine', 'noise']

  for (const pattern of builtInPatterns) {
    test(`${pattern} pattern does not throw`, () => {
      const engine = createTestEngine({})
      expect(() => engine.trigger(pattern)).not.toThrow()
    })
  }
})

describe('Platform Handling', () => {
  test('gracefully handles null native module', () => {
    const engine = new HapticEngine({}, { nativeModule: null })
    expect(() => engine.trigger('tap')).not.toThrow()
  })
})

describe('Gesture Config', () => {
  test('DEFAULT_CONFIG includes gesture defaults', () => {
    expect(DEFAULT_CONFIG.gesture).toEqual({
      enabled: true,
      tapTimeout: 300,
      listenTimeout: 10_000,
    })
  })

  test('loadConfig returns gesture config with expected shape', () => {
    const config = loadConfig('claude')
    expect(config.gesture).toBeDefined()
    expect(typeof config.gesture!.enabled).toBe('boolean')
    expect(typeof config.gesture!.tapTimeout).toBe('number')
    expect(typeof config.gesture!.listenTimeout).toBe('number')
  })
})

describe('GestureConfig type', () => {
  test('HapticConfig accepts gesture field', () => {
    const config: HapticConfig = {
      gesture: {
        enabled: true,
        tapTimeout: 300,
        listenTimeout: 10_000,
      },
    }
    expect(config.gesture).toBeDefined()
    expect(config.gesture!.enabled).toBe(true)
    expect(config.gesture!.tapTimeout).toBe(300)
    expect(config.gesture!.listenTimeout).toBe(10_000)
  })

  test('HapticConfig accepts partial gesture field', () => {
    const config: HapticConfig = {
      gesture: {
        enabled: false,
      },
    }
    expect(config.gesture!.enabled).toBe(false)
    expect(config.gesture!.tapTimeout).toBeUndefined()
  })
})

describe('Confirmation Patterns', () => {
  test('confirm-yes pattern exists in DEFAULT_PATTERNS', () => {
    expect(DEFAULT_PATTERNS['confirm-yes']).toBeDefined()
    expect(DEFAULT_PATTERNS['confirm-yes'].beat).toBe('6/0.6 3/0.4')
  })

  test('confirm-no pattern exists in DEFAULT_PATTERNS', () => {
    expect(DEFAULT_PATTERNS['confirm-no']).toBeDefined()
    expect(DEFAULT_PATTERNS['confirm-no'].beat).toBe('6/1.0  6/1.0')
  })

  test('resolvePattern finds confirm-yes', () => {
    const result = resolvePattern('confirm-yes', undefined)
    expect(result).toEqual({ beat: '6/0.6 3/0.4' })
  })

  test('resolvePattern finds confirm-no', () => {
    const result = resolvePattern('confirm-no', undefined)
    expect(result).toEqual({ beat: '6/1.0  6/1.0' })
  })

  test('confirm-yes can be overridden by user patterns', () => {
    const result = resolvePattern('confirm-yes', { 'confirm-yes': '6/1.0' })
    expect(result).toEqual({ beat: '6/1.0' })
  })

  test('confirm-yes pattern triggers without error', () => {
    const engine = createTestEngine({})
    expect(() => engine.trigger('confirm-yes')).not.toThrow()
  })

  test('confirm-no pattern triggers without error', () => {
    const engine = createTestEngine({})
    expect(() => engine.trigger('confirm-no')).not.toThrow()
  })
})

describe('parseBeat', () => {
  test('parses simple actuation digits', () => {
    const tokens = parseBeat('66', 1.0)
    expect(tokens).toEqual([
      { type: 'tap', actuation: 6, intensity: 1.0 },
      { type: 'tap', actuation: 6, intensity: 1.0 },
    ])
  })

  test('parses spaces as pauses', () => {
    const tokens = parseBeat('6  6', 1.0)
    expect(tokens).toEqual([
      { type: 'tap', actuation: 6, intensity: 1.0 },
      { type: 'pause', pauseCount: 2 },
      { type: 'tap', actuation: 6, intensity: 1.0 },
    ])
  })

  test('parses actuation/intensity notation', () => {
    const tokens = parseBeat('6/0.5', 1.0)
    expect(tokens).toEqual([{ type: 'tap', actuation: 6, intensity: 0.5 }])
  })

  test('parses mixed notation', () => {
    const tokens = parseBeat('6/1.0 4 3/0.5', 2.0)
    expect(tokens).toEqual([
      { type: 'tap', actuation: 6, intensity: 1.0 },
      { type: 'pause', pauseCount: 1 },
      { type: 'tap', actuation: 4, intensity: 2.0 },
      { type: 'pause', pauseCount: 1 },
      { type: 'tap', actuation: 3, intensity: 0.5 },
    ])
  })

  test('clamps intensity to valid range 0-2', () => {
    const tokens = parseBeat('6/5.0 6/-1', 1.0)
    expect(tokens[0].intensity).toBe(2)
    expect(tokens[2].intensity).toBe(0)
  })

  test('uses default intensity when no slash notation', () => {
    const tokens = parseBeat('5', 1.5)
    expect(tokens).toEqual([{ type: 'tap', actuation: 5, intensity: 1.5 }])
  })

  test('handles complex pattern', () => {
    const tokens = parseBeat('6/2.0 6/0.1  4/1.5 3/0.5', 1.0)
    expect(tokens).toEqual([
      { type: 'tap', actuation: 6, intensity: 2.0 },
      { type: 'pause', pauseCount: 1 },
      { type: 'tap', actuation: 6, intensity: 0.1 },
      { type: 'pause', pauseCount: 2 },
      { type: 'tap', actuation: 4, intensity: 1.5 },
      { type: 'pause', pauseCount: 1 },
      { type: 'tap', actuation: 3, intensity: 0.5 },
    ])
  })
})
