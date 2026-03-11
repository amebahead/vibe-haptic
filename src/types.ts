export type HapticEvent = 'stop' | 'prompt'

export interface PatternConfig {
  beat: string
  intensity?: number
}

export interface GestureConfig {
  enabled: boolean
  tapTimeout: number
  listenTimeout: number
}

export interface HapticConfig {
  patterns?: Record<string, string | PatternConfig>
  events?: Partial<Record<HapticEvent, string>>
  gesture?: Partial<GestureConfig>
}

export interface ResolvedPattern {
  beat: string
  intensity?: number
}
