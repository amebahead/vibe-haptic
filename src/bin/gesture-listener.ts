import { loadConfig } from '../config'
import { handlePermissionGesture } from '../claude/gesture'
import type { GestureConfig } from '../types'

const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  enabled: true,
  tapTimeout: 300,
  listenTimeout: 10_000,
}

async function main() {
  const terminalPid = parseInt(process.argv[2], 10)
  if (Number.isNaN(terminalPid)) {
    process.exit(1)
  }

  const config = loadConfig('claude')
  const gestureConfig: GestureConfig = {
    ...DEFAULT_GESTURE_CONFIG,
    ...config.gesture,
  }

  if (!gestureConfig.enabled) {
    process.exit(0)
  }

  await handlePermissionGesture(terminalPid, {
    config: { gesture: gestureConfig },
  })

  process.exit(0)
}

main().catch(() => process.exit(1))
