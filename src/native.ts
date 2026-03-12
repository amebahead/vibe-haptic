import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function loadNativeModule() {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url))
    const nativePath = join(currentDir, '..', 'native', 'vibe-haptic-native.node')
    const require = createRequire(import.meta.url)
    return require(nativePath)
  } catch {
    return null
  }
}
