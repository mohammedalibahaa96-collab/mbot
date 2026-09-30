/**
 * MBOT — Smart Money Concepts analysis engine.
 *
 * This module turns a candle series into the structure drawings the terminal
 * renders (order blocks, fair value gaps, market structure, liquidity pools,
 * chart patterns) and into a single, explicit trade *verdict* that says
 * BUY FROM HERE / SELL FROM HERE / WAIT FOR CONFIRMATION HERE.
 *
 * IMPORTANT: every output is a deterministic, rule-based reading of past and
 * forming candles. Nothing here forecasts a price, and no function can promise
 * that a detected zone will be respected by the market. The verdict is a
 * checklist for a human decision, not a guarantee.
 */

export type SmcCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  closeTime?: number
}

export type Pivot = { index: number; time: number; price: number; kind: 'high' | 'low' }
export type PivotSet = { highs: Pivot[]; lows: Pivot[]; all: Pivot[] }

export type StructureEvent = {
  kind: 'BOS' | 'CHoCH'
  direction: 'bull' | 'bear'
  breakTime: number
  breakIndex: number
  price: number
  originTime: number
  originPrice: number
}

export type LiquidityLevel = {
  side: 'buySide' | 'sellSide'
  price: number
  time: number
  touches: number
  swept: boolean
  sweptTime: number | null
  strength: number
}

export type Sweep = {
  side: 'bull' | 'bear'
  time: number
  price: number
  wickRatio: number
  label: string
}

export type OrderBlock = {
  side: 'bull' | 'bear'
  low: number
  high: number
  originTime: number
  originIndex: number
  startTime: number
  endTime: number
  mitigation: 'fresh' | 'tested' | 'invalidated'
  grade: 'A' | 'B' | 'C'
  displacement: number
  ageBars: number
}

export type Fvg = {
  side: 'bull' | 'bear'
  low: number
  high: number
  originTime: number
  index: number
  endTime: number
  fill: 'open' | 'partial' | 'filled'
  sizeAtr: number
}

export type PatternKind =
  | 'ascendingTriangle'
  | 'descendingTriangle'
  | 'symmetricalTriangle'
  | 'risingWedge'
  | 'fallingWedge'
  | 'channel'
  | 'doubleTop'
  | 'doubleBottom'
  | 'range'

export type RailPoint = { time: number; value: number }

export type Pattern = {
  kind: PatternKind
  label: string
  bias: 'bull' | 'bear' | 'neutral'
  quality: number
  upper: RailPoint[]
  lower: RailPoint[]
  apexTime: number | null
  widthAtEnd: number
  widthAtr: number
  breakout: 'none' | 'bull' | 'bear'
  target: number | null
  targetTime: number | null
  note: string
}

export type VerdictStance = 'buyNow' | 'sellNow' | 'waitConfirm' | 'waitRetrace' | 'noTrade' | 'invalid'
export type VerdictSide = 'long' | 'short' | null

export type VerdictCheck = { label: string; state: 'pass' | 'wait' | 'fail' }

export type Verdict = {
  stance: VerdictStance
  side: VerdictSide
  headline: string
  directive: string
  score: number
  zoneLabel: string
  entryLow: number | null
  entryHigh: number | null
  stop: number | null
  targets: Array<{ price: number; label: string }>
  riskReward: number | null
  invalidation: string
  reasons: string[]
  checks: VerdictCheck[]
}

export type ProjectionLeg = { time: number; value: number }
export type Projection = {
  side: VerdictSide
  confidence: number
  path: ProjectionLeg[]
  targetLabel: string
  invalidation: number | null
  note: string
}

export type DealingRange = { high: number; low: number; equilibrium: number; originTime: number }

export type SmcAnalysis = {
  candles: SmcCandle[]
  pivots: PivotSet
  structure: StructureEvent[]
  liquidity: LiquidityLevel[]
  sweeps: Sweep[]
  orderBlocks: OrderBlock[]
  fvgs: Fvg[]
  patterns: Pattern[]
  dealingRange: DealingRange | null
  atr: number
  lastPrice: number
  bias: 'bull' | 'bear' | 'neutral'
  verdict: Verdict
  projection: Projection
  computedAt: number
}

export type SmcOptions = {
  pivotStrength?: number
  lookback?: number
  /** Price distance below which two swing points count as "equal" liquidity. */
  liquidityTolerance?: number
  /** Minimum FVG height, expressed in ATR multiples. */
  minFvgAtr?: number
  maxFvg?: number
  maxOrderBlocks?: number
}

const DEFAULTS: Required<SmcOptions> = {
  pivotStrength: 2,
  lookback: 320,
  liquidityTolerance: 0.0016,
  minFvgAtr: 0.08,
  maxFvg: 6,
  maxOrderBlocks: 4,
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export function trueRange(candles: SmcCandle[], period = 14): number[] {
  const out: number[] = []
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i]
    const prev = candles[i - 1]
    if (!c) continue
    if (!prev) { out.push(c.high - c.low); continue }
    out.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)))
  }
  const smoothed: number[] = []
  let sum = 0
  for (let i = 0; i < out.length; i += 1) {
    sum += out[i]
    if (i >= period) sum -= out[i - period]
    smoothed.push(sum / Math.min(i + 1, period))
  }
  return smoothed
}

export function lastAtr(candles: SmcCandle[], period = 14): number {
  if (!candles.length) return 0
  const ranges = trueRange(candles.slice(-Math.max(period * 3, 40)), period)
  return ranges.at(-1) ?? 0
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function average(values: number[]) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function safeDiv(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : numerator / denominator
}

/* ------------------------------------------------------------------ */
/* Swing points and market structure                                   */
/* ------------------------------------------------------------------ */

export function findPivots(candles: SmcCandle[], strength = 2): PivotSet {
  const highs: Pivot[] = []
  const lows: Pivot[] = []
  const span = Math.max(1, Math.floor(strength))
  for (let i = span; i < candles.length - span; i += 1) {
    const candle = candles[i]
    let isHigh = true
    let isLow = true
    for (let j = i - span; j <= i + span; j += 1) {
      if (j === i) continue
      const other = candles[j]
      if (other.high >= candle.high) isHigh = false
      if (other.low <= candle.low) isLow = false
    }
    if (isHigh) highs.push({ index: i, time: candle.time, price: candle.high, kind: 'high' })
    if (isLow) lows.push({ index: i, time: candle.time, price: candle.low, kind: 'low' })
  }
  return { highs, lows, all: [...highs, ...lows].sort((a, b) => a.index - b.index) }
}

/**
 * Break of structure and change of character.
 *
 * A pivot only becomes a reference level once `strength` bars have closed after
 * it, so this never looks into the future.
 */
export function detectStructure(candles: SmcCandle[], strength = 2): { pivots: PivotSet; events: StructureEvent[] } {
  const pivots = findPivots(candles, strength)
  const events: StructureEvent[] = []
  let highCursor = 0
  let lowCursor = 0
  let referenceHigh: Pivot | null = null
  let referenceLow: Pivot | null = null
  let brokenHigh = -Infinity
  let brokenLow = Infinity
  let previousDirection: 'bull' | 'bear' | null = null

  for (let i = 1; i < candles.length; i += 1) {
    while (highCursor < pivots.highs.length && pivots.highs[highCursor].index + strength <= i) {
      referenceHigh = pivots.highs[highCursor]
      highCursor += 1
    }
    while (lowCursor < pivots.lows.length && pivots.lows[lowCursor].index + strength <= i) {
      referenceLow = pivots.lows[lowCursor]
      lowCursor += 1
    }
    const candle = candles[i]
    if (referenceHigh && candle.close > referenceHigh.price && referenceHigh.price > brokenHigh) {
      events.push({
        kind: previousDirection === 'bear' ? 'CHoCH' : 'BOS',
        direction: 'bull',
        breakTime: candle.time,
        breakIndex: i,
        price: referenceHigh.price,
        originTime: referenceHigh.time,
        originPrice: referenceHigh.price,
      })
      brokenHigh = referenceHigh.price
      previousDirection = 'bull'
    } else if (referenceLow && candle.close < referenceLow.price && referenceLow.price < brokenLow) {
      events.push({
        kind: previousDirection === 'bull' ? 'CHoCH' : 'BOS',
        direction: 'bear',
        breakTime: candle.time,
        breakIndex: i,
        price: referenceLow.price,
        originTime: referenceLow.time,
        originPrice: referenceLow.price,
      })
      brokenLow = referenceLow.price
      previousDirection = 'bear'
    }
  }
  return { pivots, events }
}

/* ------------------------------------------------------------------ */
/* Liquidity                                                           */
/* ------------------------------------------------------------------ */

/** `tolerance` is relative: 0.0016 means "within 0.16% of the level". */
function clusterPivots(pivots: Pivot[], tolerance: number): LiquidityLevel[] {
  const sorted = [...pivots].sort((a, b) => a.index - b.index)
  const clusters: Array<{ level: number; times: number[]; indices: number[] }> = []
  for (const pivot of sorted) {
    const cluster = clusters.find((item) => Math.abs(item.level - pivot.price) <= Math.abs(item.level) * tolerance)
    if (cluster) {
      cluster.level = (cluster.level * cluster.times.length + pivot.price) / (cluster.times.length + 1)
      cluster.times.push(pivot.time)
      cluster.indices.push(pivot.index)
    } else {
      clusters.push({ level: pivot.price, times: [pivot.time], indices: [pivot.index] })
    }
  }
  return clusters.map((cluster) => ({
    side: 'buySide' as const,
    price: cluster.level,
    time: cluster.times[cluster.times.length - 1],
    touches: cluster.times.length,
    swept: false,
    sweptTime: null,
    strength: clamp(cluster.times.length / 3, 0.2, 1),
  }))
}

export function detectLiquidity(candles: SmcCandle[], pivots: PivotSet, tolerance: number): LiquidityLevel[] {
  const highs = clusterPivots(pivots.highs, tolerance).map((level) => ({ ...level, side: 'buySide' as const }))
  const lows = clusterPivots(pivots.lows, tolerance).map((level) => ({ ...level, side: 'sellSide' as const }))
  const levels: LiquidityLevel[] = []

  for (const level of [...highs, ...lows]) {
    const originIndex = candles.findIndex((candle) => candle.time === level.time)
    const from = originIndex < 0 ? 0 : originIndex + 1
    for (let i = from; i < candles.length; i += 1) {
      const candle = candles[i]
      if (level.side === 'buySide') {
        if (candle.high > level.price && candle.close < level.price) {
          level.swept = true
          level.sweptTime = candle.time
          break
        }
      } else if (candle.low < level.price && candle.close > level.price) {
        level.swept = true
        level.sweptTime = candle.time
        break
      }
    }
    levels.push(level)
  }
  return levels.sort((a, b) => b.time - a.time)
}

export function detectSweeps(candles: SmcCandle[], liquidity: LiquidityLevel[], atr: number): Sweep[] {
  const sweeps: Sweep[] = []
  const floor = Math.max(atr * 0.35, 0)
  for (const level of liquidity) {
    if (!level.swept || level.sweptTime === null) continue
    const candle = candles.find((item) => item.time === level.sweptTime)
    if (!candle) continue
    const range = Math.max(candle.high - candle.low, 1e-12)
    const wickRatio = level.side === 'buySide'
      ? safeDiv(candle.high - Math.max(candle.close, candle.open), range)
      : safeDiv(Math.min(candle.close, candle.open) - candle.low, range)
    if (wickRatio < 0.25 && level.touches < 2) continue
    if (range < floor) continue
    sweeps.push({
      side: level.side === 'buySide' ? 'bear' : 'bull',
      time: candle.time,
      price: level.price,
      wickRatio,
      label: level.side === 'buySide' ? 'SWEEP HIGHS' : 'SWEEP LOWS',
    })
  }
  return sweeps.slice(-8)
}

/* ------------------------------------------------------------------ */
/* Order blocks and fair value gaps                                    */
/* ------------------------------------------------------------------ */

export function detectOrderBlocks(candles: SmcCandle[], events: StructureEvent[], atr: number, limit: number, maxDistanceAtr = 8): OrderBlock[] {
  const blocks: OrderBlock[] = []
  const price = candles.at(-1)?.close ?? 0
  for (const event of events.slice(-24)) {
    const start = Math.max(1, event.breakIndex - 16)
    const wanted: 'down' | 'up' = event.direction === 'bull' ? 'down' : 'up'
    for (let i = event.breakIndex - 1; i >= start; i -= 1) {
      const candle = candles[i]
      const isOrigin = wanted === 'down' ? candle.close < candle.open : candle.close > candle.open
      if (!isOrigin) continue
      const zone: OrderBlock = {
        side: event.direction === 'bull' ? 'bull' : 'bear',
        low: candle.low,
        high: candle.high,
        originTime: candle.time,
        originIndex: i,
        startTime: candle.time,
        endTime: candles[event.breakIndex]?.time ?? candle.time,
        mitigation: 'fresh',
        grade: 'C',
        displacement: 0,
        ageBars: candles.length - 1 - i,
      }
      const impulse = event.direction === 'bull' ? event.price - candle.low : candle.high - event.price
      zone.displacement = safeDiv(impulse, Math.max(atr, 1e-12))
      zone.grade = zone.displacement > 1.2 ? 'A' : zone.displacement > 0.5 ? 'B' : 'C'
      for (let j = i + 1; j < candles.length; j += 1) {
        const later = candles[j]
        const invalid = zone.side === 'bull' ? later.close < zone.low : later.close > zone.high
        if (invalid) { zone.mitigation = 'invalidated'; break }
        const touched = zone.side === 'bull'
          ? later.low <= zone.high && later.close >= zone.low
          : later.high >= zone.low && later.close <= zone.high
        if (touched) zone.mitigation = 'tested'
        if (zone.mitigation === 'tested' && j > event.breakIndex) break
      }
      if (zone.mitigation === 'invalidated') continue
      blocks.push(zone)
      break
    }
  }
  const seen = new Set<number>()
  const reachable = blocks.filter((block) => {
    if (maxDistanceAtr <= 0 || atr <= 0) return true
    const middle = (block.low + block.high) / 2
    return safeDiv(Math.abs(middle - price), atr) <= maxDistanceAtr
  })
  return reachable
    .sort((a, b) => {
      // Fresh zones first, then the closest ones — ancient history is not actionable.
      const freshness = (block: OrderBlock) => (block.mitigation === 'fresh' ? 0 : 1)
      const drift = freshness(a) - freshness(b)
      if (drift !== 0) return drift
      return Math.abs((a.low + a.high) / 2 - price) - Math.abs((b.low + b.high) / 2 - price)
    })
    .filter((block) => {
      const key = Math.round(block.low * 1e10) + Math.round(block.high * 1e6)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
}

export function detectFvgs(candles: SmcCandle[], atr: number, options: { minAtr: number; limit: number }): Fvg[] {
  const zones: Fvg[] = []
  const floor = Math.max(atr * options.minAtr, 0)
  for (let i = 2; i < candles.length; i += 1) {
    const middle = candles[i]
    const older = candles[i - 2]
    if (middle.low > older.high) {
      const height = middle.low - older.high
      if (height >= floor) {
        zones.push({ side: 'bull', low: older.high, high: middle.low, originTime: middle.time, index: i, endTime: candles.at(-1)?.time ?? middle.time, fill: 'open', sizeAtr: safeDiv(height, Math.max(atr, 1e-12)) })
      }
    } else if (middle.high < older.low) {
      const height = older.low - middle.high
      if (height >= floor) {
        zones.push({ side: 'bear', low: middle.high, high: older.low, originTime: middle.time, index: i, endTime: candles.at(-1)?.time ?? middle.time, fill: 'open', sizeAtr: safeDiv(height, Math.max(atr, 1e-12)) })
      }
    }
  }
  for (const zone of zones) {
    for (let j = zone.index + 1; j < candles.length; j += 1) {
      const candle = candles[j]
      if (zone.side === 'bull') {
        if (candle.low <= zone.low) { zone.fill = 'filled'; break }
        if (candle.low <= zone.high) zone.fill = 'partial'
      } else {
        if (candle.high >= zone.high) { zone.fill = 'filled'; break }
        if (candle.high >= zone.low) zone.fill = 'partial'
      }
    }
  }
  const price = candles.at(-1)?.close ?? 0
  // Nearest-to-price first: a gap from an hour ago is not a tradeable level.
  return zones
    .filter((zone) => zone.fill !== 'filled')
    .sort((a, b) => Math.abs((a.low + a.high) / 2 - price) - Math.abs((b.low + b.high) / 2 - price))
    .slice(0, options.limit)
}

/* ------------------------------------------------------------------ */
/* Chart patterns                                                      */
/* ------------------------------------------------------------------ */

type FittedLine = { slope: number; intercept: number; r2: number; x1: number; x2: number; y1: number; y2: number }

function fitLine(xs: number[], ys: number[]): FittedLine | null {
  if (xs.length < 2 || xs.length !== ys.length) return null
  const n = xs.length
  const meanX = average(xs)
  const meanY = average(ys)
  let numerator = 0
  let denominator = 0
  for (let i = 0; i < n; i += 1) {
    numerator += (xs[i] - meanX) * (ys[i] - meanY)
    denominator += (xs[i] - meanX) ** 2
  }
  const slope = safeDiv(numerator, denominator)
  const intercept = meanY - slope * meanX
  let ssRes = 0
  let ssTot = 0
  for (let i = 0; i < n; i += 1) {
    const predicted = slope * xs[i] + intercept
    ssRes += (ys[i] - predicted) ** 2
    ssTot += (ys[i] - meanY) ** 2
  }
  return { slope, intercept, r2: ssTot === 0 ? 0 : clamp(1 - ssRes / ssTot, 0, 1), x1: xs[0], x2: xs[n - 1], y1: ys[0], y2: ys[n - 1] }
}

function railFrom(line: FittedLine, candles: SmcCandle[], extendRight = 0): RailPoint[] {
  const firstIndex = Math.max(0, Math.round(line.x1) - 2)
  const lastIndex = Math.min(candles.length - 1, Math.round(line.x2) + 2 + extendRight)
  const points: RailPoint[] = []
  for (let i = firstIndex; i <= lastIndex; i += 1) {
    const candle = candles[i]
    if (!candle) continue
    points.push({ time: candle.time, value: line.slope * i + line.intercept })
  }
  return points
}

const PATTERN_LABELS: Record<PatternKind, string> = {
  ascendingTriangle: 'ASCENDING TRIANGLE',
  descendingTriangle: 'DESCENDING TRIANGLE',
  symmetricalTriangle: 'SYMMETRICAL TRIANGLE',
  risingWedge: 'RISING WEDGE',
  fallingWedge: 'FALLING WEDGE',
  channel: 'CHANNEL',
  doubleTop: 'DOUBLE TOP',
  doubleBottom: 'DOUBLE BOTTOM',
  range: 'RANGE',
}

/**
 * Fraction of bars that actually respected both rails. Without this check a
 * regression line through four arbitrary pivots looks like a "perfect channel".
 */
function railContainment(candles: SmcCandle[], upper: FittedLine, lower: FittedLine, atr: number, fromX: number) {
  const pad = Math.max(atr * 0.35, 1e-12)
  let inside = 0
  let total = 0
  for (let i = Math.max(0, Math.round(fromX)); i < candles.length; i += 1) {
    const candle = candles[i]
    if (!candle) continue
    total += 1
    if (candle.high <= upper.slope * i + upper.intercept + pad && candle.low >= lower.slope * i + lower.intercept - pad) inside += 1
  }
  return total ? inside / total : 0
}

export function detectPatterns(candles: SmcCandle[], pivots: PivotSet, atr: number): Pattern[] {
  if (candles.length < 30 || atr <= 0) return []
  const found: Pattern[] = []
  const recentHighs = pivots.highs.slice(-4)
  const recentLows = pivots.lows.slice(-4)
  if (recentHighs.length >= 3 && recentLows.length >= 3) {
    const upper = fitLine(recentHighs.map((p) => p.index), recentHighs.map((p) => p.price))
    const lower = fitLine(recentLows.map((p) => p.index), recentLows.map((p) => p.price))
    if (upper && lower) {
      const upperNorm = upper.slope / atr
      const lowerNorm = lower.slope / atr
      const flat = 0.022
      const trending = 0.03
      const endX = candles.length - 1
      const upperEnd = upper.slope * endX + upper.intercept
      const lowerEnd = lower.slope * endX + lower.intercept
      const widthEnd = upperEnd - lowerEnd
      const widthAtr = safeDiv(widthEnd, atr)
      const startX = Math.max(upper.x1, lower.x1)
      const widthStart = (upper.slope * startX + upper.intercept) - (lower.slope * startX + lower.intercept)
      const converging = widthStart > 0 ? (widthStart - widthEnd) / widthStart : 0
      const last = candles.at(-1)!
      const breakout: Pattern['breakout'] = widthEnd <= 0
        ? 'none'
        : last.close > upperEnd + atr * 0.1 ? 'bull'
          : last.close < lowerEnd - atr * 0.1 ? 'bear'
            : 'none'
      const containment = railContainment(candles, upper, lower, atr, startX)
      const base = {
        upper: railFrom(upper, candles, 12),
        lower: railFrom(lower, candles, 12),
        widthAtEnd: widthEnd,
        widthAtr,
        breakout,
      }
      const apex = converging > 0.18 && widthEnd > 0
        ? Math.round(endX + safeDiv(widthEnd, Math.max(upperNorm - lowerNorm, 1e-6)))
        : null
      const push = (kind: PatternKind, bias: Pattern['bias'], quality: number, note: string, target: number | null) => {
        if (containment < 0.62) return
        if (widthAtr < 0.4 || widthAtr > 18) return
        found.push({
          kind,
          label: PATTERN_LABELS[kind],
          bias,
          quality: clamp(quality, 0, 1),
          apexTime: apex !== null && apex < candles.length + 400 ? (candles[endX + 1]?.time ?? last.time) + (apex - endX) * 60_000 : null,
          target,
          targetTime: target !== null ? last.time + 40 * 60_000 : null,
          note,
          ...base,
        })
      }
      const fit = (upper.r2 + lower.r2) / 2
      if (Math.abs(upperNorm) <= flat && lowerNorm > trending && fit > 0.5) {
        push('ascendingTriangle', 'bull', 0.45 + fit * 0.35 + containment * 0.2, 'Flat resistance, rising support — buyers defending each dip.', upperEnd + safeDiv(widthEnd, Math.max(lowerNorm, 0.01)))
      }
      if (Math.abs(lowerNorm) <= flat && upperNorm < -trending && fit > 0.5) {
        push('descendingTriangle', 'bear', 0.45 + fit * 0.35 + containment * 0.2, 'Flat support, falling resistance — sellers capping every rally.', lowerEnd - safeDiv(widthEnd, Math.max(-upperNorm, 0.01)))
      }
      if (upperNorm < -trending && lowerNorm > trending && converging > 0.1 && fit > 0.5) {
        push('symmetricalTriangle', 'neutral', 0.4 + fit * 0.35 + containment * 0.2, 'Both rails converge — direction undecided, wait for the break.', upperEnd)
      }
      if (upperNorm > trending && lowerNorm > upperNorm * 1.6 && fit > 0.5) {
        push('risingWedge', 'bear', 0.45 + fit * 0.3 + containment * 0.2, 'Rising but narrowing — momentum fades into support.', lowerEnd)
      }
      if (upperNorm < -trending && lowerNorm < upperNorm * 1.6 && fit > 0.5) {
        push('fallingWedge', 'bull', 0.45 + fit * 0.3 + containment * 0.2, 'Falling but narrowing — selling pressure dries into support.', upperEnd)
      }
      if (Math.abs(upperNorm - lowerNorm) < 0.012 && Math.abs(upperNorm) > trending * 0.5 && fit > 0.7) {
        push('channel', upperNorm > 0 ? 'bull' : 'bear', 0.4 + fit * 0.3 + containment * 0.2, 'Parallel rails — trade the channel, fade the extremes.', upperNorm > 0 ? upperEnd : lowerEnd)
      }
      if (Math.abs(upperNorm) <= flat && Math.abs(lowerNorm) <= flat && pivots.all.length >= 8) {
        push('range', 'neutral', 0.4 + fit * 0.3 + containment * 0.2, 'Both rails horizontal — buy discount, sell premium.', last.close < (upperEnd + lowerEnd) / 2 ? upperEnd : lowerEnd)
      }
    }
  }

  const doubleTop = detectDoubleTop(candles, pivots, atr)
  if (doubleTop) found.push(doubleTop)
  const doubleBottom = detectDoubleBottom(candles, pivots, atr)
  if (doubleBottom) found.push(doubleBottom)

  return found.sort((a, b) => b.quality - a.quality).slice(0, 3)
}

/**
 * Two swing highs of near-equal price separated by a real trough.
 * Every candidate pair is scored so the cleanest, deepest double is the one drawn.
 */
function detectDoubleTop(candles: SmcCandle[], pivots: PivotSet, atr: number): Pattern | null {
  const highs = pivots.highs.slice(-6)
  let best: { a: Pivot; b: Pivot; trough: Pivot; score: number } | null = null
  for (let i = 0; i < highs.length; i += 1) {
    for (let j = i + 1; j < highs.length; j += 1) {
      const a = highs[i]
      const b = highs[j]
      if (!a || !b) continue
      if (Math.abs(a.price - b.price) > atr * 0.9) continue
      const troughs = pivots.lows.filter((p) => p.index > a.index && p.index < b.index)
      if (!troughs.length) continue
      const trough = troughs.reduce((min, p) => (p.price < min.price ? p : min))
      const depth = Math.min(a.price, b.price) - trough.price
      if (depth < atr * 1.2) continue
      const score = clamp(
        0.45
        + (1 - safeDiv(Math.abs(a.price - b.price), atr * 0.9)) * 0.3
        + clamp(safeDiv(depth, atr * 4), 0, 1) * 0.25,
        0,
        1,
      )
      if (!best || score > best.score) best = { a, b, trough, score }
    }
  }
  if (!best) return null
  const level = (best.a.price + best.b.price) / 2
  const last = candles.at(-1)!
  return {
    kind: 'doubleTop',
    label: PATTERN_LABELS.doubleTop,
    bias: 'bear',
    quality: best.score,
    upper: [
      { time: candles[Math.max(0, best.a.index - 1)].time, value: level },
      { time: best.a.time, value: level },
      { time: best.b.time, value: level },
      { time: candles[Math.min(candles.length - 1, best.b.index + 1)].time, value: level },
    ],
    lower: [
      { time: best.trough.time, value: best.trough.price },
      { time: last.time, value: best.trough.price },
    ],
    apexTime: null,
    widthAtEnd: level - best.trough.price,
    widthAtr: safeDiv(level - best.trough.price, atr),
    breakout: last.close < level - atr * 0.1 ? 'bear' : 'none',
    target: best.trough.price,
    targetTime: last.time + 40 * 60_000,
    note: 'Two equal highs rejected — demand the neckline retest, not the highs.',
  }
}

/** Mirror of {@link detectDoubleTop} for two equal lows with a peak between them. */
function detectDoubleBottom(candles: SmcCandle[], pivots: PivotSet, atr: number): Pattern | null {
  const lows = pivots.lows.slice(-6)
  let best: { a: Pivot; b: Pivot; peak: Pivot; score: number } | null = null
  for (let i = 0; i < lows.length; i += 1) {
    for (let j = i + 1; j < lows.length; j += 1) {
      const a = lows[i]
      const b = lows[j]
      if (!a || !b) continue
      if (Math.abs(a.price - b.price) > atr * 0.9) continue
      const peaks = pivots.highs.filter((p) => p.index > a.index && p.index < b.index)
      if (!peaks.length) continue
      const peak = peaks.reduce((max, p) => (p.price > max.price ? p : max))
      const height = peak.price - Math.max(a.price, b.price)
      if (height < atr * 1.2) continue
      const score = clamp(
        0.45
        + (1 - safeDiv(Math.abs(a.price - b.price), atr * 0.9)) * 0.3
        + clamp(safeDiv(height, atr * 4), 0, 1) * 0.25,
        0,
        1,
      )
      if (!best || score > best.score) best = { a, b, peak, score }
    }
  }
  if (!best) return null
  const level = (best.a.price + best.b.price) / 2
  const last = candles.at(-1)!
  return {
    kind: 'doubleBottom',
    label: PATTERN_LABELS.doubleBottom,
    bias: 'bull',
    quality: best.score,
    upper: [
      { time: best.peak.time, value: best.peak.price },
      { time: last.time, value: best.peak.price },
    ],
    lower: [
      { time: candles[Math.max(0, best.a.index - 1)].time, value: level },
      { time: best.a.time, value: level },
      { time: best.b.time, value: level },
      { time: candles[Math.min(candles.length - 1, best.b.index + 1)].time, value: level },
    ],
    apexTime: null,
    widthAtEnd: best.peak.price - level,
    widthAtr: safeDiv(best.peak.price - level, atr),
    breakout: last.close > level + atr * 0.1 ? 'bull' : 'none',
    target: best.peak.price,
    targetTime: last.time + 40 * 60_000,
    note: 'Two equal lows defended — demand the neckline reclaim, not the lows.',
  }
}

/* ------------------------------------------------------------------ */
/* Verdict engine                                                      */
/* ------------------------------------------------------------------ */

const STANCE_COPY: Record<VerdictStance, string> = {
  buyNow: 'BUY FROM HERE',
  sellNow: 'SELL FROM HERE',
  waitConfirm: 'WAIT FOR CONFIRMATION HERE',
  waitRetrace: 'WAIT FOR RETRACE',
  noTrade: 'NO TRADE',
  invalid: 'SETUP INVALID',
}

function priceLine(value: number) {
  if (!Number.isFinite(value) || value === 0) return '—'
  if (Math.abs(value) >= 1000) return value.toFixed(2)
  if (Math.abs(value) >= 1) return value.toFixed(4)
  if (Math.abs(value) >= 0.001) return value.toFixed(6)
  if (Math.abs(value) >= 0.00001) return value.toFixed(8)
  return value.toExponential(3)
}

export function formatLevel(value: number) {
  return priceLine(value)
}

function nearestOpposingTargets(side: 'long' | 'short', levels: LiquidityLevel[], price: number, atr: number) {
  const pool = levels.filter((level) => !level.swept)
  const relevant = side === 'long' ? pool.filter((l) => l.side === 'buySide' && l.price > price + atr * 0.15) : pool.filter((l) => l.side === 'sellSide' && l.price < price - atr * 0.15)
  return relevant
    .sort((a, b) => (side === 'long' ? a.price - b.price : b.price - a.price))
    .slice(0, 3)
}

function buildVerdict(input: {
  candles: SmcCandle[]
  atr: number
  bias: 'bull' | 'bear' | 'neutral'
  structure: StructureEvent[]
  orderBlocks: OrderBlock[]
  fvgs: Fvg[]
  liquidity: LiquidityLevel[]
  sweeps: Sweep[]
  patterns: Pattern[]
  higherTimeframeBias: 'up' | 'down' | 'flat'
}): Verdict {
  const { candles, atr, bias, structure, orderBlocks, fvgs, liquidity, sweeps, patterns, higherTimeframeBias } = input
  const price = candles.at(-1)?.close ?? 0
  const last = candles.at(-1)
  const checks: VerdictCheck[] = []
  const reasons: string[] = []
  const lastEvent = structure.at(-1) ?? null
  const recentEvent = structure.at(-2) ?? null

  const htfAgree = (side: 'long' | 'short') => (side === 'long' ? higherTimeframeBias !== 'down' : higherTimeframeBias !== 'up')
  const side: VerdictSide = bias === 'neutral' ? null : bias === 'bull' ? 'long' : 'short'
  const primarySide: VerdictSide = side ?? (lastEvent ? (lastEvent.direction === 'bull' ? 'long' : 'short') : null)

  if (!last || atr <= 0 || candles.length < 30) {
    return {
      stance: 'noTrade',
      side: null,
      headline: STANCE_COPY.noTrade,
      directive: 'Collecting candles — the engine needs 30 closed bars before it will call a setup.',
      score: 0,
      zoneLabel: '—',
      entryLow: null,
      entryHigh: null,
      stop: null,
      targets: [],
      riskReward: null,
      invalidation: '—',
      reasons: ['Not enough closed candles.'],
      checks: [{ label: 'Warm-up (30 bars)', state: 'wait' }],
    }
  }

  const blocks = orderBlocks.filter((block) => block.mitigation !== 'invalidated')
  const gapZones = fvgs.filter((gap) => gap.fill !== 'filled')
  const lastSweep = sweeps.at(-1) ?? null

  const distanceIn = (zone: OrderBlock | Fvg) => safeDiv(Math.abs((zone.low + zone.high) / 2 - price), Math.max(atr, 1e-12))
  /**
   * The zone the verdict is built on: the closest untested block of the right
   * side, or the closest open gap if no usable block is in reach. A grade-A
   * block that is ten ATR away is worth less than a plain gap price is touching.
   */
  const pickZone = (direction: 'bull' | 'bear') => {
    const sameSideBlocks = blocks.filter((block) => block.side === direction && distanceIn(block) <= 4)
    const fresh = sameSideBlocks.filter((block) => block.mitigation === 'fresh')
    const bestBlock = (fresh.length ? fresh : sameSideBlocks)
      .slice()
      .sort((a, b) => distanceIn(a) - distanceIn(b))[0]
    const sameSideGaps = gapZones.filter((gap) => gap.side === direction && distanceIn(gap) <= 4)
    const bestGap = sameSideGaps[0]
    if (bestBlock && bestGap) {
      const blockScore = distanceIn(bestBlock) - (bestBlock.grade === 'A' ? 0.8 : bestBlock.grade === 'B' ? 0.3 : 0)
      return blockScore <= distanceIn(bestGap) ? bestBlock : bestGap
    }
    return bestBlock ?? bestGap ?? null
  }

  const zone = primarySide ? pickZone(primarySide === 'long' ? 'bull' : 'bear') : null
  const zoneLow = zone ? zone.low : null
  const zoneHigh = zone ? zone.high : null
  const inZone = zoneLow !== null && zoneHigh !== null && price >= zoneLow && price <= zoneHigh
  const zoneHeld = zone ? zoneStateLabel(zone) !== 'invalidated' && zoneStateLabel(zone) !== 'filled' : false

  const structureAligned = lastEvent ? (primarySide === 'long' ? lastEvent.direction === 'bull' : lastEvent.direction === 'bear') : false
  const characterShift = lastEvent?.kind === 'CHoCH'
  const liquiditySweepAligned = lastSweep
    ? (primarySide === 'long' ? lastSweep.side === 'bull' : lastSweep.side === 'bear')
    : false
  const patternAligned = patterns.find((pattern) => (primarySide === 'long' ? pattern.bias === 'bull' : pattern.bias === 'bear')) ?? null
  const extended = atr > 0 && zoneLow !== null && zoneHigh !== null
    ? (primarySide === 'long' ? price - zoneHigh : zoneLow - price) / atr > 1.6
    : false

  let score = 0
  if (structureAligned) score += 30
  if (characterShift) score += 8
  if (zoneHeld) score += 22
  if (inZone) score += 12
  if (liquiditySweepAligned) score += 18
  if (patternAligned) score += 12
  if (htfAgree(primarySide ?? 'long')) score += 8
  if (extended) score -= 18
  score = Math.round(clamp(score, 0, 100))

  checks.push({ label: `Structure ${lastEvent ? `${lastEvent.kind} ${lastEvent.direction === 'bull' ? '↑' : '↓'}` : 'none'}`, state: structureAligned ? 'pass' : lastEvent ? 'fail' : 'wait' })
  checks.push({ label: zone ? `Zone ${zoneStateLabel(zone)} (${zoneGradeLabel(zone)})` : 'No valid zone', state: zoneHeld ? 'pass' : 'wait' })
  checks.push({ label: lastSweep ? `${lastSweep.label} ${lastSweep.side === 'bull' ? '↑' : '↓'}` : 'No liquidity sweep', state: liquiditySweepAligned ? 'pass' : 'wait' })
  checks.push({ label: higherTimeframeBias === 'flat' ? 'HTF neutral' : `HTF ${higherTimeframeBias === 'up' ? 'up ↑' : 'down ↓'}`, state: htfAgree(primarySide ?? 'long') ? 'pass' : 'fail' })
  checks.push({ label: inZone ? 'Price inside zone' : extended ? 'Price extended from zone' : 'Price outside zone', state: inZone ? 'pass' : extended ? 'fail' : 'wait' })

  let stance: VerdictStance = 'noTrade'
  const zoneIsFresh = zone ? ('mitigation' in zone ? zone.mitigation === 'fresh' : zone.fill === 'open') : false
  if (primarySide) {
    if (!zoneHeld) stance = 'noTrade'
    // A mitigated block or a partially filled gap can be traded, but never at full conviction.
    else if (inZone && score >= 55 && zoneIsFresh) stance = primarySide === 'long' ? 'buyNow' : 'sellNow'
    else if (inZone) stance = 'waitConfirm'
    else stance = 'waitRetrace'
  }

  if (lastEvent) reasons.push(`Last structure event: ${lastEvent.kind} ${lastEvent.direction === 'bull' ? 'upward' : 'downward'} at ${formatLevel(lastEvent.price)}.`)
  if (recentEvent && characterShift) reasons.push(`Character shifted against the previous ${recentEvent.direction === 'bull' ? 'bullish' : 'bearish'} sequence.`)
  if (zone) {
    reasons.push(`${zoneLabelFor(zone)} ${zoneStateLabel(zone)} zone ${formatLevel(zone.low)} – ${formatLevel(zone.high)}.`)
  }
  if (lastSweep) reasons.push(`${lastSweep.label} at ${formatLevel(lastSweep.price)} (wick ${(lastSweep.wickRatio * 100).toFixed(0)}%).`)
  if (patternAligned) reasons.push(`${patternAligned.label}: ${patternAligned.note}`)
  if (extended) reasons.push('Price is stretched from the zone — a poor entry even with a valid bias.')

  const entry = primarySide
    ? {
        low: Math.min(price, zoneLow ?? price),
        high: Math.max(price, zoneHigh ?? price),
      }
    : { low: price, high: price }

  const stop = zone
    ? primarySide === 'long'
      ? zone.low - atr * 0.35
      : zone.high + atr * 0.35
    : primarySide === 'long' ? price - atr * 1.2 : price + atr * 1.2

  const rawTargets = primarySide ? nearestOpposingTargets(primarySide, liquidity, price, atr) : []
  // Only pools that are realistically reachable count as a target; anything
  // further out than 8 ATR is a "next level", not this trade's take profit.
  const targets = rawTargets
    .filter((level) => safeDiv(Math.abs(level.price - price), Math.max(atr, 1e-12)) <= 8)
    .map((level) => ({ price: level.price, label: level.touches > 1 ? `LIQUIDITY POOL x${level.touches}` : 'LIQUIDITY' }))
  const risk = Math.abs(entry.low + entry.high === 0 ? 0 : (entry.low + entry.high) / 2 - stop)
  const firstReward = targets[0] ? Math.abs(targets[0].price - (entry.low + entry.high) / 2) : 0
  const riskReward = risk > 0 && firstReward > 0 ? firstReward / risk : null

  if (patternAligned?.target && !targets.some((t) => Math.abs(t.price - patternAligned.target!) < atr * 0.5)) {
    targets.push({ price: patternAligned.target, label: `${patternAligned.label} TARGET` })
  }

  const invalidation = zone
    ? primarySide === 'long'
      ? `A 1m close back below ${formatLevel(zone.low)} kills the idea.`
      : `A 1m close back above ${formatLevel(zone.high)} kills the idea.`
    : 'No zone — nothing to invalidate yet.'

  const headline = STANCE_COPY[stance]
  const zoneName = zone ? zoneLabelFor(zone) : 'NO ZONE'
  const directive = stance === 'noTrade'
    ? primarySide
      ? `NO TRADE — ${zoneName} ${zoneHeld ? 'has already been consumed' : 'has not formed yet'}. Wait for a fresh zone.`
      : 'NO TRADE — market structure has no direction. Wait for a BOS or CHoCH.'
    : stance === 'buyNow' || stance === 'sellNow'
      ? `${zoneName} ${headline} — ${zoneLow !== null && zoneHigh !== null ? `${formatLevel(zoneLow)} to ${formatLevel(zoneHigh)}` : 'price'}. Stop ${formatLevel(stop)}. ${targets[0] ? `First liquidity ${formatLevel(targets[0].price)}.` : 'No clean liquidity above yet.'}`
      : stance === 'waitConfirm'
        ? `${zoneName} — WAIT FOR CONFIRMATION HERE. Price is in the zone but only ${score}/100 confluence. Want a 1m close in your direction and a stop under ${formatLevel(stop)}.`
        : `${zoneName} — WAIT FOR RETRACE into ${zoneLow !== null && zoneHigh !== null ? `${formatLevel(zoneLow)} – ${formatLevel(zoneHigh)}` : 'the zone'}. Entering here chases ${extended ? 'an extended move' : 'price away from the zone'}.`

  return {
    stance,
    side: stance === 'noTrade' ? null : primarySide,
    headline,
    directive,
    score,
    zoneLabel: zoneName,
    entryLow: zoneLow,
    entryHigh: zoneHigh,
    stop,
    targets: targets.slice(0, 3),
    riskReward,
    invalidation,
    reasons,
    checks,
  }
}

function zoneLabelFor(zone: OrderBlock | Fvg): string {
  if ('mitigation' in zone) return `ORDER BLOCK (${zone.side === 'bull' ? 'BULLISH' : 'BEARISH'})`
  return `FVG (${zone.side === 'bull' ? 'BULLISH' : 'BEARISH'})`
}

function zoneStateLabel(zone: OrderBlock | Fvg): string {
  return ('mitigation' in zone ? zone.mitigation : zone.fill).toUpperCase()
}

function zoneGradeLabel(zone: OrderBlock | Fvg): string {
  return 'grade' in zone ? `GRADE ${zone.grade}` : `${zone.sizeAtr.toFixed(2)} ATR`
}

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

function buildProjection(input: {
  candles: SmcCandle[]
  atr: number
  verdict: Verdict
  liquidity: LiquidityLevel[]
  patterns: Pattern[]
  orderBlocks: OrderBlock[]
}): Projection {
  const { candles, atr, verdict, liquidity, patterns, orderBlocks } = input
  const last = candles.at(-1)
  if (!last) return { side: null, confidence: 0, path: [], targetLabel: '—', invalidation: null, note: 'No candles.' }
  const side = verdict.side
  if (!side) {
    return {
      side: null,
      confidence: 0,
      path: [],
      targetLabel: 'NO DIRECTIONAL BIAS',
      invalidation: null,
      note: 'Structure has not declared a side, so the engine refuses to draw a path.',
    }
  }
  const price = last.close
  const zone = orderBlocks.find((block) => block.side === (side === 'long' ? 'bull' : 'bear') && block.mitigation !== 'invalidated')
  const start = zone ? (side === 'long' ? zone.low : zone.high) : price
  const targets = nearestOpposingTargets(side, liquidity, Math.min(price, start), Math.max(atr, 1e-12))
  const patternTarget = patterns.find((pattern) => (side === 'long' ? pattern.bias === 'bull' : pattern.bias === 'bear'))?.target ?? null
  const first = targets[0]?.price ?? patternTarget
  const second = targets[1]?.price ?? (first !== null ? first + (side === 'long' ? atr * 2 : -atr * 2) : null)
  if (first === null) {
    return {
      side,
      confidence: Math.round(verdict.score * 0.4),
      path: [],
      targetLabel: 'NO LIQUIDITY TARGET',
      invalidation: verdict.stop,
      note: 'No unswept liquidity pool beyond the zone, so there is nothing sensible to project toward.',
    }
  }
  const bars = 20
  const stepMs = 60_000
  const path: ProjectionLeg[] = [{ time: last.time, value: price }]
  const legs: Array<{ value: number; bars: number }> = [
    { value: start, bars: 4 },
    { value: first, bars: 10 },
  ]
  if (second !== null) legs.push({ value: second, bars: bars - 14 })
  let cursor = last.time
  for (const leg of legs) {
    const from = path.at(-1)!.value
    for (let i = 1; i <= leg.bars; i += 1) {
      cursor += stepMs
      path.push({ time: cursor, value: from + (leg.value - from) * (i / leg.bars) })
    }
  }
  return {
    side,
    confidence: clamp(Math.round(verdict.score * 0.7 + (targets.length > 1 ? 12 : 0)), 0, 95),
    path,
    targetLabel: targets[0] ? `${targets[0].touches > 1 ? 'POOL x' + targets[0].touches : 'LIQUIDITY'} ${formatLevel(targets[0].price)}` : 'MEASURED MOVE',
    invalidation: verdict.stop,
    note: 'Scenario path only: zone → nearest unswept liquidity → next pool. It is a drawing of where liquidity sits, not a prediction.',
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function analyzeSmc(candles: SmcCandle[], options: SmcOptions = {}, higherTimeframeBias: 'up' | 'down' | 'flat' = 'flat'): SmcAnalysis {
  const settings = { ...DEFAULTS, ...options }
  const series = candles.slice(-settings.lookback)
  const atr = lastAtr(series)
  const { pivots, events } = detectStructure(series, settings.pivotStrength)
  const liquidity = detectLiquidity(series, pivots, settings.liquidityTolerance)
  const sweeps = detectSweeps(series, liquidity, atr)
  const orderBlocks = detectOrderBlocks(series, events, atr, settings.maxOrderBlocks)
  const fvgs = detectFvgs(series, atr, { minAtr: settings.minFvgAtr, limit: settings.maxFvg })
  const price = series.at(-1)?.close ?? 0
  // Keep the drawings the user can actually act on: reachable, high quality,
  // and never a double top and a double bottom from the same window.
  const patterns = (() => {
    const ranked = detectPatterns(series, pivots, atr)
      .filter((pattern) => pattern.quality >= 0.45)
      .filter((pattern) => {
        const level = pattern.target ?? pattern.upper.at(-1)?.value ?? price
        return safeDiv(Math.abs(level - price), Math.max(atr, 1e-12)) <= 12
      })
    const dt = ranked.find((pattern) => pattern.kind === 'doubleTop')
    const db = ranked.find((pattern) => pattern.kind === 'doubleBottom')
    const withoutContradiction = dt && db
      ? (dt.quality >= db.quality ? ranked.filter((pattern) => pattern !== db) : ranked.filter((pattern) => pattern !== dt))
      : ranked
    return withoutContradiction.slice(0, 2)
  })()
  const lastEvent = events.at(-1) ?? null
  // A break that fights the higher timeframe is not a clean bias. Reporting it as
  // one is how a counter-trend trade gets dressed up as a trend continuation.
  const bias: 'bull' | 'bear' | 'neutral' = !lastEvent
    ? 'neutral'
    : higherTimeframeBias === 'flat' ? lastEvent.direction
      : lastEvent.direction === 'bull' && higherTimeframeBias === 'up' ? 'bull'
        : lastEvent.direction === 'bear' && higherTimeframeBias === 'down' ? 'bear'
          : 'neutral'

  const dealingRange: DealingRange | null = orderBlocks.length
    ? (() => {
        const source = [...pivots.highs, ...pivots.lows].filter((p) => p.index <= (lastEvent?.breakIndex ?? series.length - 1))
        if (source.length < 4) return null
        const high = source.reduce((max, p) => Math.max(max, p.price), -Infinity)
        const low = source.reduce((min, p) => Math.min(min, p.price), Infinity)
        return { high, low, equilibrium: (high + low) / 2, originTime: source[0].time }
      })()
    : null

  const verdict = buildVerdict({ candles: series, atr, bias, structure: events, orderBlocks, fvgs, liquidity, sweeps, patterns, higherTimeframeBias })
  const projection = buildProjection({ candles: series, atr, verdict, liquidity, patterns, orderBlocks })

  return {
    candles: series,
    pivots,
    structure: events,
    liquidity,
    sweeps,
    orderBlocks,
    fvgs,
    patterns,
    dealingRange,
    atr,
    lastPrice: series.at(-1)?.close ?? 0,
    bias,
    verdict,
    projection,
    computedAt: Date.now(),
  }
}

export const SMC_LABELS = PATTERN_LABELS
