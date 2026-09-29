export type Candle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  closeTime?: number
}

export type MarketDirection = 'up' | 'down' | 'neutral'
export type SignalKind = 'bull' | 'bear' | 'neutral'
export type EntryStrategy = 'confluence' | 'sweep' | 'structure' | 'orderBlock' | 'fvgRetest' | 'trend'

export type MarketSignals = {
  trend: MarketDirection
  confirmations: number
  smc: SignalKind
  bullCount: number
  bearCount: number
  bos: SignalKind
  sweep: SignalKind
  orderBlock: SignalKind
  fvg: SignalKind
  fvgRetest: SignalKind
  labels: string[]
  autoSide: 'long' | 'short' | null
}

export type ChartLayer = 'bos' | 'orderBlock' | 'fvg' | 'sweep' | 'triangle'
export type ChartLayerVisibility = Record<ChartLayer, boolean>
export const DEFAULT_CHART_LAYERS: ChartLayerVisibility = { bos: true, orderBlock: true, fvg: true, sweep: true, triangle: true }

export type ChartMarker = {
  time: number
  position: 'aboveBar' | 'belowBar'
  color: string
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square'
  text: string
  layer: ChartLayer
}

export type TrianglePattern = {
  kind: 'ascending' | 'descending' | 'symmetrical'
  breakout: SignalKind
  startTime: number
  endTime: number
  resistance: Array<{ time: number; value: number }>
  support: Array<{ time: number; value: number }>
}

export type PriceZone = {
  startTime: number
  endTime: number
  low: number
  high: number
  side: 'bull' | 'bear'
}

export type ChartZones = { orderBlock: PriceZone | null; fvg: PriceZone | null }

export function calculateEma(values: number[], period: number): number[] {
  if (values.length === 0) return []
  const alpha = 2 / (period + 1)
  const output: number[] = [values[0]]
  for (let i = 1; i < values.length; i += 1) {
    output.push(values[i] * alpha + output[i - 1] * (1 - alpha))
  }
  return output
}

function kindFrom(bullish: boolean, bearish: boolean): SignalKind {
  return bullish ? 'bull' : bearish ? 'bear' : 'neutral'
}

function countSide(features: SignalKind[], side: 'bull' | 'bear') {
  return features.filter((feature) => feature === side).length
}

/**
 * Lightweight, closed-candle SMC heuristics for chart context and paper entries.
 * These are not validated institutional order-flow rules or a price predictor.
 */
export function calculateSignals(oneMinute: Candle[], fifteenMinute: Candle[], strategy: EntryStrategy = 'confluence'): MarketSignals {
  const now = Date.now()
  const closed15m = fifteenMinute.filter((bar) => !bar.closeTime || bar.closeTime < now)
  const closes15m = closed15m.map((bar) => bar.close)
  const ema20 = calculateEma(closes15m, 20)
  const last15m = closed15m.at(-1)
  let trend: MarketDirection = 'neutral'
  if (last15m && ema20.length && ema20.at(-1)) {
    const distance = (last15m.close - ema20.at(-1)!) / ema20.at(-1)!
    if (distance > 0.0005) trend = 'up'
    if (distance < -0.0005) trend = 'down'
  }

  const lastTwo15m = closed15m.slice(-2)
  const confirmations = trend === 'up'
    ? lastTwo15m.filter((bar) => bar.close > bar.open).length
    : trend === 'down'
      ? lastTwo15m.filter((bar) => bar.close < bar.open).length
      : 0

  const closed1m = oneMinute.filter((bar) => !bar.closeTime || bar.closeTime < now)
  const current = closed1m.at(-1)
  const prior = closed1m.slice(-13, -1)
  let bos: SignalKind = 'neutral'
  let sweep: SignalKind = 'neutral'
  let orderBlock: SignalKind = 'neutral'
  let fvg: SignalKind = 'neutral'
  let fvgRetest: SignalKind = 'neutral'
  const labels: string[] = []

  if (current && prior.length >= 8) {
    const structure = prior.slice(-8)
    const priorHigh = Math.max(...structure.map((bar) => bar.high))
    const priorLow = Math.min(...structure.map((bar) => bar.low))
    const bullishBos = current.close > priorHigh
    const bearishBos = current.close < priorLow
    const bullishSweep = current.low < priorLow && current.close > priorLow
    const bearishSweep = current.high > priorHigh && current.close < priorHigh
    bos = kindFrom(bullishBos, bearishBos)
    sweep = kindFrom(bullishSweep, bearishSweep)

    if (bullishBos) labels.push(trend === 'down' ? 'CHoCH ↑' : 'BOS ↑')
    if (bearishBos) labels.push(trend === 'up' ? 'CHoCH ↓' : 'BOS ↓')
    if (bullishSweep) labels.push('Low liquidity sweep')
    if (bearishSweep) labels.push('High liquidity sweep')

    const older = closed1m.at(-3)
    const latestBullGap = Boolean(older && current.low > older.high)
    const latestBearGap = Boolean(older && current.high < older.low)
    if (latestBullGap) labels.push('Bullish FVG formed')
    if (latestBearGap) labels.push('Bearish FVG formed')

    // Search recent, already-formed gaps and check whether the latest closed candle revisited them.
    for (let index = closed1m.length - 2; index >= Math.max(2, closed1m.length - 18); index -= 1) {
      const gapBar = closed1m[index]
      const gapOrigin = closed1m[index - 2]
      if (!gapBar || !gapOrigin) continue
      if (gapBar.low > gapOrigin.high) {
        const zoneLow = gapOrigin.high
        const zoneHigh = gapBar.low
        if (current.low <= zoneHigh && current.low >= zoneLow && current.close >= zoneLow) {
          fvgRetest = 'bull'
          break
        }
      }
      if (gapBar.high < gapOrigin.low) {
        const zoneLow = gapBar.high
        const zoneHigh = gapOrigin.low
        if (current.high >= zoneLow && current.high <= zoneHigh && current.close <= zoneHigh) {
          fvgRetest = 'bear'
          break
        }
      }
    }
    fvg = kindFrom(latestBullGap || fvgRetest === 'bull', latestBearGap || fvgRetest === 'bear')
    if (fvgRetest === 'bull') labels.push('Bullish FVG retest')
    if (fvgRetest === 'bear') labels.push('Bearish FVG retest')

    // Find a recent break, then test a revisit to the last opposite candle before that break.
    const scanStart = Math.max(9, closed1m.length - 24)
    for (let index = closed1m.length - 2; index >= scanStart; index -= 1) {
      const breakBar = closed1m[index]
      const beforeBreak = closed1m.slice(Math.max(0, index - 8), index)
      if (beforeBreak.length < 5) continue
      const brokeUp = breakBar.close > Math.max(...beforeBreak.map((bar) => bar.high))
      const brokeDown = breakBar.close < Math.min(...beforeBreak.map((bar) => bar.low))
      if (brokeUp) {
        const block = [...beforeBreak].reverse().find((bar) => bar.close < bar.open)
        if (block) {
          const zoneLow = block.low
          const zoneHigh = Math.max(block.open, block.close)
          if (current.low <= zoneHigh && current.high >= zoneLow && current.close >= zoneLow && current.close >= current.open) {
            orderBlock = 'bull'
          }
        }
        if (orderBlock !== 'neutral') break
      }
      if (brokeDown) {
        const block = [...beforeBreak].reverse().find((bar) => bar.close > bar.open)
        if (block) {
          const zoneLow = Math.min(block.open, block.close)
          const zoneHigh = block.high
          if (current.high >= zoneLow && current.low <= zoneHigh && current.close <= zoneHigh && current.close <= current.open) {
            orderBlock = 'bear'
          }
        }
        if (orderBlock !== 'neutral') break
      }
    }
    if (orderBlock === 'bull') labels.push('Bullish order-block retest')
    if (orderBlock === 'bear') labels.push('Bearish order-block retest')
  }

  const bullCount = countSide([bos, sweep, orderBlock, fvg], 'bull')
  const bearCount = countSide([bos, sweep, orderBlock, fvg], 'bear')
  const smc = kindFrom(bullCount > bearCount, bearCount > bullCount)
  const biasMatches = (side: 'bull' | 'bear') => side === 'bull' ? trend === 'up' : trend === 'down'
  const confirmed = (side: 'bull' | 'bear', minimum: number) => biasMatches(side) && confirmations >= minimum
  let autoSide: 'long' | 'short' | null = null

  if (strategy === 'confluence') {
    if (confirmed('bull', 2) && bullCount >= 2) autoSide = 'long'
    if (confirmed('bear', 2) && bearCount >= 2) autoSide = 'short'
  } else if (strategy === 'sweep') {
    if (sweep === 'bull' && confirmed('bull', 1)) autoSide = 'long'
    if (sweep === 'bear' && confirmed('bear', 1)) autoSide = 'short'
  } else if (strategy === 'structure') {
    if (bos === 'bull' && confirmed('bull', 2)) autoSide = 'long'
    if (bos === 'bear' && confirmed('bear', 2)) autoSide = 'short'
  } else if (strategy === 'orderBlock') {
    if (orderBlock === 'bull' && confirmed('bull', 1)) autoSide = 'long'
    if (orderBlock === 'bear' && confirmed('bear', 1)) autoSide = 'short'
  } else if (strategy === 'fvgRetest') {
    if (fvgRetest === 'bull' && confirmed('bull', 1)) autoSide = 'long'
    if (fvgRetest === 'bear' && confirmed('bear', 1)) autoSide = 'short'
  } else if (strategy === 'trend') {
    if (trend === 'up' && confirmations === 2) autoSide = 'long'
    if (trend === 'down' && confirmations === 2) autoSide = 'short'
  }

  return { trend, confirmations, smc, bullCount, bearCount, bos, sweep, orderBlock, fvg, fvgRetest, labels, autoSide }
}

function getClosedCandles(candles: Candle[]) {
  const now = Date.now()
  return candles.filter((bar) => !bar.closeTime || bar.closeTime < now)
}

export function getChartMarkers(
  candles: Candle[],
  layers: ChartLayerVisibility = DEFAULT_CHART_LAYERS,
  triangle: TrianglePattern | null = null,
): ChartMarker[] {
  const bars = getClosedCandles(candles)
  const markers: ChartMarker[] = []
  const start = Math.max(2, bars.length - 120)
  for (let i = start; i < bars.length; i += 1) {
    const current = bars[i]
    const older = bars[i - 2]
    const neighborhood = bars.slice(Math.max(0, i - 10), i)
    if (!current || !older || neighborhood.length < 5) continue
    const recentHigh = Math.max(...neighborhood.map((bar) => bar.high))
    const recentLow = Math.min(...neighborhood.map((bar) => bar.low))
    const localMove = (neighborhood.at(-1)!.close - neighborhood[0].close) / Math.max(neighborhood[0].close, Number.EPSILON)
    const localBias: MarketDirection = localMove > 0.0005 ? 'up' : localMove < -0.0005 ? 'down' : 'neutral'

    if (layers.fvg && current.low > older.high) {
      markers.push({ time: current.time, position: 'belowBar', color: '#59cda9', shape: 'circle', text: 'FVG', layer: 'fvg' })
    } else if (layers.fvg && current.high < older.low) {
      markers.push({ time: current.time, position: 'aboveBar', color: '#ef8795', shape: 'circle', text: 'FVG', layer: 'fvg' })
    }
    if (layers.sweep && current.high > recentHigh && current.close < recentHigh) {
      markers.push({ time: current.time, position: 'aboveBar', color: '#deb45e', shape: 'arrowDown', text: 'SWEEP', layer: 'sweep' })
    } else if (layers.sweep && current.low < recentLow && current.close > recentLow) {
      markers.push({ time: current.time, position: 'belowBar', color: '#deb45e', shape: 'arrowUp', text: 'SWEEP', layer: 'sweep' })
    }
    if (layers.bos && current.close > recentHigh) {
      markers.push({ time: current.time, position: 'belowBar', color: '#80b7d2', shape: 'arrowUp', text: localBias === 'down' ? 'CHoCH' : 'BOS', layer: 'bos' })
    } else if (layers.bos && current.close < recentLow) {
      markers.push({ time: current.time, position: 'aboveBar', color: '#b59bd2', shape: 'arrowDown', text: localBias === 'up' ? 'CHoCH' : 'BOS', layer: 'bos' })
    }
    if (layers.orderBlock && current.close > recentHigh) {
      const block = [...neighborhood].reverse().find((bar) => bar.close < bar.open)
      if (block) markers.push({ time: block.time, position: 'belowBar', color: '#59cda9', shape: 'square', text: 'OB', layer: 'orderBlock' })
    } else if (layers.orderBlock && current.close < recentLow) {
      const block = [...neighborhood].reverse().find((bar) => bar.close > bar.open)
      if (block) markers.push({ time: block.time, position: 'aboveBar', color: '#ef8795', shape: 'square', text: 'OB', layer: 'orderBlock' })
    }
  }
  if (triangle && layers.triangle) {
    const text = triangle.kind === 'ascending' ? 'ASC TRI' : triangle.kind === 'descending' ? 'DESC TRI' : 'SYM TRI'
    const breakoutColor = triangle.breakout === 'bull' ? '#59cda9' : triangle.breakout === 'bear' ? '#ef8795' : '#deb45e'
    markers.push({ time: triangle.endTime, position: triangle.breakout === 'bear' ? 'aboveBar' : 'belowBar', color: breakoutColor, shape: triangle.breakout === 'bear' ? 'arrowDown' : 'square', text, layer: 'triangle' })
  }
  return markers.sort((a, b) => a.time - b.time).slice(-100)
}

export function getChartZones(candles: Candle[]): ChartZones {
  const bars = getClosedCandles(candles)
  const endTime = bars.at(-1)?.time || 0
  let fvg: PriceZone | null = null
  const fvgStart = Math.max(2, bars.length - 80)
  for (let index = bars.length - 2; index >= fvgStart; index -= 1) {
    const gapBar = bars[index]
    const origin = bars[index - 2]
    if (!gapBar || !origin) continue
    if (gapBar.low > origin.high) {
      const low = origin.high
      const high = gapBar.low
      const mitigated = bars.slice(index + 1).some((bar) => bar.low <= low)
      if (!mitigated) { fvg = { startTime: gapBar.time, endTime, low, high, side: 'bull' }; break }
    } else if (gapBar.high < origin.low) {
      const low = gapBar.high
      const high = origin.low
      const mitigated = bars.slice(index + 1).some((bar) => bar.high >= high)
      if (!mitigated) { fvg = { startTime: gapBar.time, endTime, low, high, side: 'bear' }; break }
    }
  }

  let orderBlock: PriceZone | null = null
  const breakStart = Math.max(9, bars.length - 48)
  for (let index = bars.length - 2; index >= breakStart; index -= 1) {
    const breakBar = bars[index]
    const before = bars.slice(Math.max(0, index - 8), index)
    if (!breakBar || before.length < 5) continue
    const brokeUp = breakBar.close > Math.max(...before.map((bar) => bar.high))
    const brokeDown = breakBar.close < Math.min(...before.map((bar) => bar.low))
    if (brokeUp) {
      const block = [...before].reverse().find((bar) => bar.close < bar.open)
      if (block) {
        const low = block.low
        const high = Math.max(block.open, block.close)
        const invalidated = bars.slice(index + 1).some((bar) => bar.close < low)
        if (!invalidated) { orderBlock = { startTime: block.time, endTime, low, high, side: 'bull' }; break }
      }
    }
    if (brokeDown) {
      const block = [...before].reverse().find((bar) => bar.close > bar.open)
      if (block) {
        const low = Math.min(block.open, block.close)
        const high = block.high
        const invalidated = bars.slice(index + 1).some((bar) => bar.close > high)
        if (!invalidated) { orderBlock = { startTime: block.time, endTime, low, high, side: 'bear' }; break }
      }
    }
  }
  return { orderBlock, fvg }
}

type Pivot = { index: number; time: number; price: number }
type FittedLine = { slope: number; intercept: number; error: number; at: (index: number) => number }

function fitLine(points: Pivot[]): FittedLine | null {
  if (points.length < 2) return null
  const meanX = points.reduce((sum, point) => sum + point.index, 0) / points.length
  const meanY = points.reduce((sum, point) => sum + point.price, 0) / points.length
  const denominator = points.reduce((sum, point) => sum + (point.index - meanX) ** 2, 0)
  if (!denominator) return null
  const slope = points.reduce((sum, point) => sum + (point.index - meanX) * (point.price - meanY), 0) / denominator
  const intercept = meanY - slope * meanX
  const error = Math.sqrt(points.reduce((sum, point) => sum + (point.price - (slope * point.index + intercept)) ** 2, 0) / points.length)
  return { slope, intercept, error, at: (index) => slope * index + intercept }
}

/** Closed-candle swing-pivot approximation; patterns are descriptive overlays, not predictions. */
export function detectTrianglePattern(candles: Candle[]): TrianglePattern | null {
  const bars = getClosedCandles(candles)
  if (bars.length < 28) return null
  const firstIndex = Math.max(2, bars.length - 100)
  const highs: Pivot[] = []
  const lows: Pivot[] = []
  for (let index = firstIndex; index < bars.length - 2; index += 1) {
    const bar = bars[index]
    const left = bars[index - 1]
    const left2 = bars[index - 2]
    const right = bars[index + 1]
    const right2 = bars[index + 2]
    if (!bar || !left || !left2 || !right || !right2) continue
    if (bar.high >= left.high && bar.high >= left2.high && bar.high > right.high && bar.high >= right2.high) highs.push({ index, time: bar.time, price: bar.high })
    if (bar.low <= left.low && bar.low <= left2.low && bar.low < right.low && bar.low <= right2.low) lows.push({ index, time: bar.time, price: bar.low })
  }
  const selectedHighs = highs.slice(-4)
  const selectedLows = lows.slice(-4)
  if (selectedHighs.length < 3 || selectedLows.length < 3) return null
  const upper = fitLine(selectedHighs)
  const lower = fitLine(selectedLows)
  if (!upper || !lower) return null

  const averagePrice = bars.slice(-60).reduce((sum, bar) => sum + bar.close, 0) / Math.min(bars.length, 60)
  const upperRate = upper.slope / averagePrice
  const lowerRate = lower.slope / averagePrice
  const kind = upperRate < -0.00008 && lowerRate > 0.00008
    ? 'symmetrical'
    : Math.abs(upperRate) <= 0.00018 && lowerRate > 0.00008
      ? 'ascending'
      : upperRate < -0.00008 && Math.abs(lowerRate) <= 0.00018
        ? 'descending'
        : null
  if (!kind || upper.error / averagePrice > 0.012 || lower.error / averagePrice > 0.012) return null

  const startIndex = Math.min(selectedHighs[0].index, selectedLows[0].index)
  const endIndex = bars.length - 1
  const startGap = upper.at(startIndex) - lower.at(startIndex)
  const endGap = upper.at(endIndex) - lower.at(endIndex)
  if (startGap <= averagePrice * 0.001 || endGap <= 0 || endGap >= startGap * 0.94) return null

  const last = bars[endIndex]
  const priorBar = bars[endIndex - 1]
  if (!last || !priorBar) return null
  const upperAtLast = upper.at(endIndex)
  const lowerAtLast = lower.at(endIndex)
  const upperBefore = upper.at(endIndex - 1)
  const lowerBefore = lower.at(endIndex - 1)
  const breakout: SignalKind = last.close > upperAtLast && priorBar.close <= upperBefore
    ? 'bull'
    : last.close < lowerAtLast && priorBar.close >= lowerBefore
      ? 'bear'
      : 'neutral'
  const outsideDistance = Math.max(lowerAtLast - last.close, last.close - upperAtLast, 0)
  if (breakout === 'neutral' && outsideDistance > averagePrice * 0.002) return null

  const startTime = bars[startIndex].time
  const endTime = last.time
  return {
    kind,
    breakout,
    startTime,
    endTime,
    resistance: [{ time: startTime, value: upper.at(startIndex) }, { time: endTime, value: upperAtLast }],
    support: [{ time: startTime, value: lower.at(startIndex) }, { time: endTime, value: lowerAtLast }],
  }
}

export function getEmaPoints(candles: Candle[], period = 20) {
  const values = calculateEma(candles.map((candle) => candle.close), period)
  return candles.map((candle, index) => ({ time: candle.time as never, value: values[index] }))
}
