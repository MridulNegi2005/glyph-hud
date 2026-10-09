export type GlyphStats = {
  turns: number
  tools: Record<string, number>
  toolCalls: number
  edits: number
  files: string[]
  added: number
  removed: number
  bashRuns: number
  bashFails: number
  streak: number
  bestStreak: number
  longestTurnMs: number
  blocked: number
}

export type GlyphLifetime = {
  sessions: number
  toolCalls: number
  added: number
  removed: number
  edits: number
  bestStreak: number
}

export type ModelTally = {
  model: string
  requests: number
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

export type ChatUsage = {
  models: ModelTally[]
  costUsd?: number
  contextPct?: number
  fiveHourPct?: number
  error?: string
  scannedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'glyph-hud': {
      stats: GlyphStats
      lifetime: GlyphLifetime
      usage: ChatUsage
      isLive: boolean
    }
  }
}
