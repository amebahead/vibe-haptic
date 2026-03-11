import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

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
    expect(parseInt(content)).toBe(process.pid)
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
