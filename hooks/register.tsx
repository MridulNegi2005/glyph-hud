import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChatUsage, ColdEstimate, GlyphLifetime, GlyphStats, ModelTally } from '../types'

const PANE = 'glyph-hud'
const RED = '#D71921'
const LIT = '#F2F2F2'
const OFF = '#1F1F1F'
const MUTED = '#8A8A8A'
const MAX_READ = 4_000_000

const EMPTY: GlyphStats = {
  turns: 0,
  tools: {},
  toolCalls: 0,
  edits: 0,
  files: [],
  added: 0,
  removed: 0,
  bashRuns: 0,
  bashFails: 0,
  streak: 0,
  bestStreak: 0,
  longestTurnMs: 0,
  blocked: 0,
}

const NO_LIFETIME: GlyphLifetime = {
  sessions: 0,
  toolCalls: 0,
  added: 0,
  removed: 0,
  edits: 0,
  bestStreak: 0,
}

const NO_USAGE: ChatUsage = { models: [], scannedAt: 0 }

const stats = atom({ plugin: 'glyph-hud', key: 'stats' } as const, EMPTY)
const lifetime = atom({ plugin: 'glyph-hud', key: 'lifetime' } as const, NO_LIFETIME)
const usage = atom({ plugin: 'glyph-hud', key: 'usage' } as const, NO_USAGE)
const cold = atom({ plugin: 'glyph-hud', key: 'cold' } as const, { pairs: [] } as ColdEstimate)
const isLive = atom({ plugin: 'glyph-hud', key: 'isLive' } as const, false)

// 5x7 dot-matrix glyphs, one string per row.
const FONT: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
}

// A real `git commit` invocation at the start of a command or after ; && || |, not the words in prose.
const GIT_COMMIT = /(^|[;&|]\s*)git(\s+-\S+(\s+\S+)?)*\s+commit\b/m

const lineCount = (s: string | undefined) => (s ? s.split('\n').length : 0)

const shortTool = (name: string) => {
  const parts = name.split('__')
  return parts.length >= 3 ? parts.slice(2).join('__') : name
}

const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')

const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const totalOf = (t: ModelTally) => t.input + t.cacheWrite + t.cacheRead + t.output

const sumUsage = (u: ChatUsage) =>
  u.models.reduce(
    (a, t) => ({
      requests: a.requests + t.requests,
      input: a.input + t.input,
      cacheWrite: a.cacheWrite + t.cacheWrite,
      cacheRead: a.cacheRead + t.cacheRead,
      output: a.output + t.output,
    }),
    { requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  )

const topTools = (s: GlyphStats, n: number) =>
  Object.entries(s.tools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)

const codeTiles = (s: GlyphStats, life: GlyphLifetime): [string, string, boolean?][] => [
  ['TOOL CALLS', String(s.toolCalls)],
  ['TURNS', String(s.turns)],
  ['EDITS', String(s.edits)],
  ['FILES', String(s.files.length)],
  ['LINES', `+${compact(s.added)} -${compact(s.removed)}`],
  ['BASH ERR', `${s.bashFails}/${s.bashRuns}`, s.bashFails > 0],
  ['STREAK', `${s.streak} / ${s.bestStreak}`],
  ['LONGEST', `${Math.round(s.longestTurnMs / 1000)}s`],
  ['ALL-TIME', `${compact(life.toolCalls + s.toolCalls)} calls`],
]

// --- 5-hour limit estimate ------------------------------------------------

const PAIR_WINDOW = 60
const MAX_GAP_MS = 90_000
const MIN_PCT_SUM = 0.3

// Input-token equivalents: output is priced 5x input, cache reads 0.1x,
// cache writes 2x (1-hour TTL) or 1.25x (5-minute TTL).
const writeWeight = () => (cacheTtlMs >= 60 * 60 * 1000 ? 2 : 1.25)

type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

const unitsOfStep = (u: StepUsage) =>
  u.input_tokens + u.cache_creation_input_tokens * writeWeight() + u.cache_read_input_tokens * 0.1 + u.output_tokens * 5

// Only deltas between readings seconds apart count, so other chats barely leak in.
async function recordStep($: EngineInterface, u: StepUsage, isFirstOfTurn: boolean) {
  const session = await $.session.usage()
  const five = session.rateLimits.find(r => r.kind === 'five_hour')
  if (!five) return
  const now = Date.now()
  const isCold = isFirstOfTurn && u.cache_creation_input_tokens > 20_000 && u.cache_read_input_tokens < u.cache_creation_input_tokens

  await update($, cold, c => {
    const base = c ?? { pairs: [] }
    let pairs = base.pairs ?? []
    const prev = base.prev
    let lastCold = base.lastCold
    const dPct = prev ? five.percentUsed - prev.pct : 0

    if (prev && dPct < 0) pairs = []
    else if (prev && now - prev.at <= MAX_GAP_MS) {
      pairs = [...pairs, { units: unitsOfStep(u), dPct }].slice(-PAIR_WINDOW)
    }
    if (isCold && prev && dPct >= 0) {
      lastCold = { before: prev.pct, after: five.percentUsed, staleMinutes: Math.round((now - prev.at) / 60_000), at: now }
    }

    const units = pairs.reduce((a, p) => a + p.units, 0)
    const pct = pairs.reduce((a, p) => a + p.dPct, 0)
    const perUnit = units > 0 && pct >= MIN_PCT_SUM ? pct / units : undefined
    const ctx = session.context.tokens
    return {
      pairs,
      prev: { pct: five.percentUsed, at: now },
      fiveHourPct: five.percentUsed,
      pctPerMUnits: perUnit === undefined ? undefined : perUnit * 1_000_000,
      coldPct: perUnit === undefined || ctx === undefined ? undefined : perUnit * ctx * writeWeight(),
      lastCold,
    }
  })
  await refreshStatus($)
}

// --- transcript scan -------------------------------------------------------

let transcriptPath: string | undefined
let isScanning = false
let lastSignature = ''
let cacheAt = 0
let cacheTtlMs = 60 * 60 * 1000
let isTurnRunning = false
let baseStatus: string | undefined
let draftStatus: string | undefined

async function findTranscript($: EngineInterface) {
  if (transcriptPath) return transcriptPath
  const configDir =
    (await $.env.get('CLAUDE_CONFIG_DIR')) ??
    `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''}/.claude`
  const id = await $.session.id()
  for (const dir of [await $.session.root(), await $.session.cwd()]) {
    const candidate = `${configDir}/projects/${dir.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
    try {
      if ((await $.fs.stat(candidate)).kind === 'file') return (transcriptPath = candidate)
    } catch {}
  }
  return undefined
}

async function transcriptFiles($: EngineInterface, main: string) {
  const files = [main]
  const subDir = `${main.replace(/\.jsonl$/, '')}/subagents`
  try {
    for (const entry of await $.fs.list(subDir)) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) files.push(`${subDir}/${entry.name}`)
    }
  } catch {}
  return files
}

async function linesOf($: EngineInterface, path: string, size: number) {
  if (size <= MAX_READ) return (await $.fs.read(path)).split('\n')
  const script = `${$.plugin.root}/scripts/usage_lines.py`
  const out = await $.process.run(['python', script, path])
  return out.stdout.split('\n')
}

async function scanUsage($: EngineInterface, force = false) {
  if (isScanning) return
  isScanning = true
  try {
    const main = await findTranscript($)
    const session = await $.session.usage()
    const costUsd = session.cost?.usd
    const contextPct = session.context.percent

    if (!main) {
      await update($, usage, u => ({ ...u, costUsd, contextPct, error: 'transcript not found', scannedAt: Date.now() }))
      return
    }

    const files = await transcriptFiles($, main)
    const sizes = await Promise.all(files.map(f => $.fs.stat(f).then(s => s.size)))
    const signature = files.map((f, i) => `${f}:${sizes[i]}`).join('|')
    if (!force && signature === lastSignature) {
      await update($, usage, u => ({ ...u, costUsd, contextPct }))
      return
    }

    const seen = new Set<string>()
    const byModel = new Map<string, ModelTally>()
    for (let i = 0; i < files.length; i++) {
      for (const line of await linesOf($, files[i]!, sizes[i]!)) {
        if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
        let row: {
          message?: { id?: string; model?: string; usage?: Record<string, number> & { cache_creation?: Record<string, number> } }
          requestId?: string
          timestamp?: string
        }
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        const m = row.message
        const u = m?.usage
        if (!m?.model || !u || m.model === '<synthetic>') continue
        // One response is split across several rows that repeat the same usage.
        const key = m.id ?? row.requestId
        if (key) {
          if (seen.has(key)) continue
          seen.add(key)
        }
        const t = byModel.get(m.model) ?? { model: m.model, requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }
        t.requests += 1
        t.input += u.input_tokens ?? 0
        t.cacheWrite += u.cache_creation_input_tokens ?? 0
        t.cacheRead += u.cache_read_input_tokens ?? 0
        t.output += u.output_tokens ?? 0
        byModel.set(m.model, t)

        if (i === 0 && row.timestamp) {
          const at = Date.parse(row.timestamp)
          if (at > cacheAt) {
            cacheAt = at
            const cc = u.cache_creation
            if ((cc?.ephemeral_1h_input_tokens ?? 0) > 0) cacheTtlMs = 60 * 60 * 1000
            else if ((cc?.ephemeral_5m_input_tokens ?? 0) > 0) cacheTtlMs = 5 * 60 * 1000
          }
        }
      }
    }

    lastSignature = signature
    const models = [...byModel.values()].sort((a, b) => totalOf(b) - totalOf(a))
    const next = { models, costUsd, contextPct, scannedAt: Date.now() }
    await update($, usage, () => next)
  } catch (err) {
    await update($, usage, u => ({ ...u, error: String(err).slice(0, 80) }))
  } finally {
    isScanning = false
    await refreshStatus($)
  }
}

// --- drawing ---------------------------------------------------------------

function dotText(text: string, x: number, y: number, pitch: number, r: number, color = LIT) {
  const out: string[] = []
  let cx = x
  for (const ch of text) {
    const rows = FONT[ch] ?? FONT['0']!
    rows.forEach((row, ri) => {
      ;[...row].forEach((bit, ci) => {
        out.push(`<circle cx="${cx + ci * pitch}" cy="${y + ri * pitch}" r="${r}" fill="${bit === '1' ? color : OFF}"/>`)
      })
    })
    cx += 6 * pitch
  }
  return out.join('')
}

function dotBar(x: number, y: number, count: number, lit: number, gap: number, r: number, color: string) {
  let s = ''
  for (let d = 0; d < count; d++) s += `<circle cx="${x + d * gap}" cy="${y}" r="${r}" fill="${d < lit ? color : OFF}"/>`
  return s
}

function svgHud(s: GlyphStats, life: GlyphLifetime, u: ChatUsage, c: ColdEstimate, live: boolean) {
  const W = 400
  const P = 20
  const font = `font-family="ui-monospace, 'JetBrains Mono', Consolas, monospace"`
  const label = (x: number, y: number, t: string, color = MUTED) =>
    `<text x="${x}" y="${y}" ${font} font-size="10" letter-spacing="2" fill="${color}">${esc(t)}</text>`
  const value = (x: number, y: number, t: string, color = LIT, size = 17) =>
    `<text x="${x}" y="${y}" ${font} font-size="${size}" font-weight="700" fill="${color}">${esc(t)}</text>`
  const out: string[] = []
  const sum = sumUsage(u)
  const total = sum.input + sum.cacheWrite + sum.cacheRead + sum.output

  out.push(label(P, 32, 'GLYPH / HUD'))
  out.push(`<circle cx="${W - P - 4}" cy="28" r="6" fill="${live ? RED : OFF}"/>`)

  let y = 70
  out.push(label(P, y, 'THIS CHAT · TOKENS'))
  y += 22
  const big = compact(total)
  const pitch = Math.min(12, Math.floor((W - 2 * P) / (big.length * 6)))
  out.push(dotText(big, P + pitch / 2, y, pitch, pitch * 0.36))
  y += 7 * pitch + 22

  const col3 = (W - 2 * P) / 3
  out.push(label(P, y, 'COST'))
  out.push(label(P + col3, y, 'CONTEXT'))
  out.push(label(P + col3 * 2, y, 'REQUESTS'))
  out.push(value(P, y + 24, u.costUsd === undefined ? '—' : `$${u.costUsd.toFixed(2)}`, RED))
  out.push(value(P + col3, y + 24, u.contextPct === undefined ? '—' : `${u.contextPct}%`))
  out.push(value(P + col3 * 2, y + 24, String(sum.requests)))
  y += 44
  const ctxDots = 36
  out.push(dotBar(P + 4, y, ctxDots, Math.round(((u.contextPct ?? 0) / 100) * ctxDots), (W - 2 * P - 8) / (ctxDots - 1), 3, LIT))
  y += 34

  out.push(label(P, y, 'COLD CACHE CALL'))
  out.push(label(P + col3 * 2, y, '5H USED'))
  out.push(
    value(P, y + 24, c.coldPct === undefined ? 'calibrating' : `≈ ${c.coldPct.toFixed(1)}% of 5h`, c.coldPct === undefined ? MUTED : RED),
  )
  out.push(value(P + col3 * 2, y + 24, c.fiveHourPct === undefined ? '—' : `${c.fiveHourPct}%`))
  y += 44
  if (c.lastCold) {
    const lc = c.lastCold
    out.push(
      label(
        P,
        y,
        `LAST COLD: ${lc.before}% → ${lc.after}% (+${(lc.after - lc.before).toFixed(1)}) · BEFORE ${lc.staleMinutes}M OLD`,
      ).replace('letter-spacing="2"', 'letter-spacing="0.5"'),
    )
    y += 20
  }
  y += 6

  const col4 = (W - 2 * P) / 4
  ;(
    [
      ['INPUT', sum.input],
      ['CACHE W', sum.cacheWrite],
      ['CACHE R', sum.cacheRead],
      ['OUTPUT', sum.output],
    ] as const
  ).forEach(([name, n], i) => {
    out.push(label(P + i * col4, y, name))
    out.push(value(P + i * col4, y + 22, compact(n), LIT, 15))
  })
  y += 56

  out.push(`<line x1="${P}" x2="${W - P}" y1="${y}" y2="${y}" stroke="${OFF}" stroke-width="2"/>`)
  y += 30
  out.push(label(P, y, 'SPREAD BY MODEL'))
  y += 26
  if (u.models.length === 0) {
    out.push(label(P, y, u.error ?? 'no responses counted yet'))
    y += 24
  }
  u.models.forEach((t, i) => {
    const tt = totalOf(t)
    const share = total > 0 ? tt / total : 0
    const color = i === 0 ? RED : LIT
    out.push(value(P, y, shortModel(t.model), color, 14))
    out.push(
      `<text x="${W - P}" y="${y}" text-anchor="end" ${font} font-size="14" font-weight="700" fill="${LIT}">${esc(
        `${compact(tt)} · ${Math.round(share * 100)}%`,
      )}</text>`,
    )
    y += 14
    out.push(dotBar(P + 4, y, 36, Math.max(1, Math.round(share * 36)), (W - 2 * P - 8) / 35, 3, color))
    y += 18
    out.push(
      label(
        P,
        y,
        `in ${compact(t.input)}  cw ${compact(t.cacheWrite)}  cr ${compact(t.cacheRead)}  out ${compact(t.output)}  ${t.requests} req`,
      ).replace('letter-spacing="2"', 'letter-spacing="0.5"'),
    )
    y += 32
  })

  out.push(`<line x1="${P}" x2="${W - P}" y1="${y}" y2="${y}" stroke="${OFF}" stroke-width="2"/>`)
  y += 30
  out.push(label(P, y, 'CODE · THIS SESSION'))
  y += 24
  const top = topTools(s, 4)
  const max = top[0]?.[1] ?? 1
  top.forEach(([name, count], i) => {
    out.push(`<text x="${P}" y="${y + 4}" ${font} font-size="11" fill="${LIT}">${esc(shortTool(name).slice(0, 13))}</text>`)
    out.push(dotBar(132, y, 22, Math.max(1, Math.round((count / max) * 22)), 10, 2.8, i === 0 ? RED : LIT))
    out.push(`<text x="${W - P}" y="${y + 4}" text-anchor="end" ${font} font-size="11" fill="${MUTED}">${count}</text>`)
    y += 18
  })
  if (top.length === 0) {
    out.push(label(P, y, 'no tool calls yet'))
    y += 18
  }
  y += 16

  const grid = codeTiles(s, life)
  grid.forEach(([name, v, isAlert], i) => {
    const tx = P + (i % 3) * col3
    const ty = y + Math.floor(i / 3) * 50
    out.push(label(tx, ty, name))
    out.push(value(tx, ty + 24, v, isAlert ? RED : LIT, 15))
  })
  y += Math.ceil(grid.length / 3) * 50

  if (s.blocked > 0) {
    out.push(label(P, y + 6, `● ${s.blocked} AI-ATTRIBUTION COMMIT${s.blocked === 1 ? '' : 'S'} BLOCKED`, RED))
    y += 24
  }

  const H = y + 12
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${H * 3}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" rx="16" fill="#000"/>${out.join('')}</svg>`
}

function textDots(text: string) {
  return Array.from({ length: 7 }, (_, r) =>
    [...text].map(ch => (FONT[ch] ?? FONT['0']!)[r]!.replace(/1/g, '●').replace(/0/g, ' ')).join(' '),
  )
}

// --- state helpers ---------------------------------------------------------

async function refreshStatus($: EngineInterface) {
  const [u, c] = await Promise.all([read($, usage), read($, cold)])
  const sum = sumUsage(u)
  const total = sum.input + sum.cacheWrite + sum.cacheRead + sum.output
  const parts = [`◉ ${compact(total)} tok`]
  if (u.costUsd !== undefined) parts.push(`$${u.costUsd.toFixed(2)}`)
  if (c.coldPct !== undefined) parts.push(`cold ≈ ${c.coldPct.toFixed(1)}% of 5h`)
  baseStatus = total === 0 ? undefined : parts.join(' · ')
  paintStatus($)
}

function cacheLabel(now: number) {
  if (isTurnRunning) return 'cache ● warm'
  if (cacheAt === 0) return undefined
  const left = cacheAt + cacheTtlMs - now
  if (left <= 0) return 'cache ○ cold'
  const sec = Math.floor(left / 1000)
  return `cache ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

// ~4 characters per token for English and code; a rough count, not the tokenizer's.
async function estimateDraft($: EngineInterface, draft: string) {
  if (!draft.trim()) {
    draftStatus = undefined
    paintStatus($)
    return
  }
  const draftTokens = Math.ceil(draft.length / 4)
  const [c, session] = await Promise.all([read($, cold), $.session.usage()])
  const ctx = session.context.tokens ?? 0
  const isWarm = cacheAt > 0 && cacheAt + cacheTtlMs > Date.now()
  // The first request re-reads the context (or rewrites it when cold) and caches the new message.
  const units = (isWarm ? ctx * 0.1 : ctx * writeWeight()) + draftTokens * writeWeight()
  const pct = c.pctPerMUnits === undefined ? undefined : (c.pctPerMUnits * units) / 1_000_000
  draftStatus =
    `✎ ${compact(draftTokens)} tok` +
    (pct === undefined ? '' : ` → send ≈ ${pct < 0.1 ? pct.toFixed(2) : pct.toFixed(1)}% 5h${isWarm ? '' : ' (cold)'}`)
  paintStatus($)
}

function paintStatus($: EngineInterface) {
  const cache = cacheLabel(Date.now())
  const parts = [draftStatus, baseStatus, cache].filter(Boolean)
  $.ui.status(parts.length ? parts.join(' · ') : undefined)
}

async function bump($: EngineInterface, fn: (s: GlyphStats) => GlyphStats) {
  await update($, stats, s => fn(s ?? EMPTY))
  await refreshStatus($)
}

async function flushLifetime($: EngineInterface) {
  const [s, life] = await Promise.all([read($, stats), read($, lifetime)])
  await $.store.set('lifetime', {
    ...life,
    toolCalls: life.toolCalls + s.toolCalls,
    added: life.added + s.added,
    removed: life.removed + s.removed,
    edits: life.edits + s.edits,
    bestStreak: Math.max(life.bestStreak, s.bestStreak),
  } satisfies GlyphLifetime)
}

const touch = (s: GlyphStats, file: string, added: number, removed: number): GlyphStats => ({
  ...s,
  edits: s.edits + 1,
  added: s.added + added,
  removed: s.removed + removed,
  files: s.files.includes(file) ? s.files : [...s.files, file],
})

// --- hooks -----------------------------------------------------------------

export const register: Register = (on, options) => {
  const blockAttribution = options.blockAttribution === true

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'glyph', description: 'Open the Glyph HUD: chat tokens by model and code stats' })

    const life = await read($, lifetime)
    if (life.sessions === 0) {
      const stored = ((await $.store.get('lifetime')) as GlyphLifetime | undefined) ?? NO_LIFETIME
      const loaded = { ...NO_LIFETIME, ...stored, sessions: stored.sessions + 1 }
      await update($, lifetime, () => loaded)
      await $.store.set('lifetime', loaded)
    }

    void $.ui.open({ id: PANE, title: 'Glyph' })
    void scanUsage($, true)
    $.clock.every(1000, () => paintStatus($))
    return next(e)
  })

  on('command.run', { command: 'glyph' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Glyph' })
    void scanUsage($, true)
    return {}
  })

  on('classic.Stop', ($, e, next) => {
    if (e.transcript_path) transcriptPath = e.transcript_path
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    void scanUsage($)
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    void estimateDraft($, box.text)
    return box
  })

  on('prompt.submit', ($, e, next) => {
    draftStatus = undefined
    paintStatus($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    if (res.usage) await recordStep($, res.usage, e.index === 0 && e.agentId === undefined)
    return res
  })

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    await update($, isLive, () => true)
    paintStatus($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false
      cacheAt = Math.max(cacheAt, Date.now())
      await update($, isLive, () => false)
      await bump($, s => ({ ...s, turns: s.turns + 1, longestTurnMs: Math.max(s.longestTurnMs, e.durationMs) }))
      await flushLifetime($)
      void scanUsage($)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const isError = ran.isError === true
    await bump($, s => {
      const streak = isError ? 0 : s.streak + 1
      return {
        ...s,
        toolCalls: s.toolCalls + 1,
        tools: { ...s.tools, [e.tool]: (s.tools[e.tool] ?? 0) + 1 },
        streak,
        bestStreak: Math.max(s.bestStreak, streak),
      }
    })
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (blockAttribution && GIT_COMMIT.test(e.command) && /co-authored-by/i.test(e.command)) {
      await bump($, s => ({ ...s, blocked: s.blocked + 1 }))
      return { deny: 'glyph-hud: Co-Authored-By trailers are blocked by your settings. Remove the trailer and commit again.' }
    }
    const ran = await next(e)
    if (ran.deny === undefined) {
      const hasFailed = ran.isError === true
      await bump($, s => ({ ...s, bashRuns: s.bashRuns + 1, bashFails: s.bashFails + (hasFailed ? 1 : 0) }))
    }
    return ran
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await bump($, s => touch(s, e.file_path, lineCount(e.new_string), lineCount(e.old_string)))
    }
    return ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await bump($, s => touch(s, e.file_path, lineCount(e.content), 0))
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [s, life, u, c, live] = await Promise.all([
      read($, stats),
      read($, lifetime),
      read($, usage),
      read($, cold),
      read($, isLive),
    ])

    if (e.surface !== 'terminal') {
      const { Box, Svg, Button } = $.ui.resolve(e)
      const sum = sumUsage(u)
      return (
        <Box flexDirection="column" gap={1}>
          <Svg
            source={svgHud(s, life, u, c, live)}
            alt={`This chat used ${compact(sum.input + sum.cacheWrite + sum.cacheRead + sum.output)} tokens across ${u.models.length} models; ${s.toolCalls} tool calls, ${s.edits} edits`}
          />
          <Box flexDirection="row" gap={1}>
            <Button key="rescan" label="Rescan" onPress={() => scanUsage($, true)} />
            <Button key="reset" label="Reset code stats" onPress={() => bump($, () => EMPTY)} />
            <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        </Box>
      )
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(24, (e.props.bodyColumns ?? 40) - 2)
    const barRoom = Math.max(6, Math.min(30, width - 22))
    const sum = sumUsage(u)
    const total = sum.input + sum.cacheWrite + sum.cacheRead + sum.output
    const top = topTools(s, 4)
    const max = top[0]?.[1] ?? 1

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>G L Y P H / H U D</Text>
          <Text color={live ? RED : MUTED}>{live ? '● LIVE' : '○ IDLE'}</Text>
        </Box>
        <Text dimColor>THIS CHAT · TOKENS</Text>
        {textDots(compact(total)).map(row => (
          <Text>{row}</Text>
        ))}
        <Text>
          <Text color={RED}>{u.costUsd === undefined ? '—' : `$${u.costUsd.toFixed(2)}`}</Text>
          <Text dimColor>  ctx </Text>
          {u.contextPct === undefined ? '—' : `${u.contextPct}%`}
          <Text dimColor>  req </Text>
          {sum.requests}
        </Text>
        <Text>
          <Text dimColor>cold cache call </Text>
          <Text color={c.coldPct === undefined ? MUTED : RED}>
            {c.coldPct === undefined ? 'calibrating' : `≈ ${c.coldPct.toFixed(1)}% of 5h`}
          </Text>
          <Text dimColor>  5h used </Text>
          {c.fiveHourPct === undefined ? '—' : `${c.fiveHourPct}%`}
        </Text>
        {c.lastCold && (
          <Text dimColor>
            last cold {c.lastCold.before}% → {c.lastCold.after}% (+{(c.lastCold.after - c.lastCold.before).toFixed(1)}),
            before-reading {c.lastCold.staleMinutes}m old
          </Text>
        )}
        <Text dimColor>
          in {compact(sum.input)} · cw {compact(sum.cacheWrite)} · cr {compact(sum.cacheRead)} · out {compact(sum.output)}
        </Text>
        <Text> </Text>
        <Text dimColor>SPREAD BY MODEL</Text>
        {u.models.length === 0 && <Text dimColor>{u.error ?? 'no responses counted yet'}</Text>}
        {u.models.map((t, i) => {
          const share = total > 0 ? totalOf(t) / total : 0
          const lit = Math.max(1, Math.round(share * barRoom))
          return (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text bold color={i === 0 ? RED : undefined}>
                  {shortModel(t.model).slice(0, 16).padEnd(17)}
                </Text>
                <Text color={i === 0 ? RED : undefined}>{'●'.repeat(lit)}</Text>
                <Text dimColor>
                  {'·'.repeat(barRoom - lit)} {compact(totalOf(t))} {Math.round(share * 100)}%
                </Text>
              </Box>
              <Text dimColor>
                {'  '}in {compact(t.input)} cw {compact(t.cacheWrite)} cr {compact(t.cacheRead)} out {compact(t.output)} · {t.requests} req
              </Text>
            </Box>
          )
        })}
        <Text> </Text>
        <Text dimColor>CODE · THIS SESSION</Text>
        {top.map(([name, count], i) => {
          const lit = Math.max(1, Math.round((count / max) * barRoom))
          return (
            <Box flexDirection="row">
              <Text>{shortTool(name).slice(0, 16).padEnd(17)}</Text>
              <Text color={i === 0 ? RED : undefined}>{'●'.repeat(lit)}</Text>
              <Text dimColor>
                {'·'.repeat(barRoom - lit)} {count}
              </Text>
            </Box>
          )
        })}
        {codeTiles(s, life).map(([name, v, isAlert]) => (
          <Box flexDirection="row">
            <Text dimColor>{name.padEnd(12)}</Text>
            <Text bold color={isAlert ? RED : undefined}>
              {v}
            </Text>
          </Box>
        ))}
        {s.blocked > 0 && <Text color={RED}>● {s.blocked} AI-attribution commit(s) blocked</Text>}
        <Box flexDirection="row" gap={1}>
          <Button key="rescan" label="rescan" onPress={() => scanUsage($, true)} />
          <Button key="reset" label="reset" onPress={() => bump($, () => EMPTY)} />
          <Button key="close" label="close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
