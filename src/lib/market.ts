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

export type ChartMarker = {
  time: number
  position: 'aboveBar' | 'belowBar'
  color: string
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square'
  text: string
}

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

export function getChartMarkers(candles: Candle[]): ChartMarker[] {
  const markers: ChartMarker[] = []
  const start = Math.max(2, candles.length - 120)
  for (let i = start; i < candles.length; i += 1) {
    const current = candles[i]
    const older = candles[i - 2]
    const neighborhood = candles.slice(Math.max(0, i - 10), i)
    if (neighborhood.length < 5) continue
    const recentHigh = Math.max(...neighborhood.map((bar) => bar.high))
    const recentLow = Math.min(...neighborhood.map((bar) => bar.low))

    if (current.low > older.high) {
      markers.push({ time: current.time, position: 'belowBar', color: '#35d6ad', shape: 'circle', text: 'FVG' })
    } else if (current.high < older.low) {
      markers.push({ time: current.time, position: 'aboveBar', color: '#ff7a90', shape: 'circle', text: 'FVG' })
    }
    if (current.high > recentHigh && current.close < recentHigh) {
      markers.push({ time: current.time, position: 'aboveBar', color: '#f5bb5d', shape: 'arrowDown', text: 'SWEEP' })
    } else if (current.low < recentLow && current.close > recentLow) {
      markers.push({ time: current.time, position: 'belowBar', color: '#f5bb5d', shape: 'arrowUp', text: 'SWEEP' })
    }
    if (current.close > recentHigh) {
      markers.push({ time: current.time, position: 'belowBar', color: '#61a9ff', shape: 'arrowUp', text: 'BOS' })
      const block = [...neighborhood].reverse().find((bar) => bar.close < bar.open)
      if (block) markers.push({ time: block.time, position: 'belowBar', color: '#35d6ad', shape: 'square', text: 'OB' })
    } else if (current.close < recentLow) {
      markers.push({ time: current.time, position: 'aboveBar', color: '#c791ff', shape: 'arrowDown', text: 'BOS' })
      const block = [...neighborhood].reverse().find((bar) => bar.close > bar.open)
      if (block) markers.push({ time: block.time, position: 'aboveBar', color: '#ff7a90', shape: 'square', text: 'OB' })
    }
  }
  return markers.slice(-60)
}

export function getEmaPoints(candles: Candle[], period = 20) {
  const values = calculateEma(candles.map((candle) => candle.close), period)
  return candles.map((candle, index) => ({ time: candle.time as never, value: values[index] }))
}
