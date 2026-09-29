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

export type MarketSignals = {
  trend: MarketDirection
  confirmations: number
  smc: SignalKind
  bullCount: number
  bearCount: number
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

export function calculateSignals(oneMinute: Candle[], fifteenMinute: Candle[]): MarketSignals {
  const now = Date.now()
  const closed15m = fifteenMinute.filter((bar) => !bar.closeTime || bar.closeTime < now)
  const closes15m = closed15m.map((bar) => bar.close)
  const ema20 = calculateEma(closes15m, 20)
  const last15m = closed15m.at(-1)
  let trend: MarketDirection = 'neutral'
  if (last15m && ema20.length) {
    const distance = (last15m.close - ema20.at(-1)!) / ema20.at(-1)!
    if (distance > 0.0005) trend = 'up'
    if (distance < -0.0005) trend = 'down'
  }

  const lastTwo = closed15m.slice(-2)
  const targetDirection = trend === 'up' ? 'up' : trend === 'down' ? 'down' : null
  const confirmations = targetDirection
    ? lastTwo.filter((bar) => targetDirection === 'up' ? bar.close > bar.open : bar.close < bar.open).length
    : 0

  const closed1m = oneMinute.filter((bar) => !bar.closeTime || bar.closeTime < now)
  const current = closed1m.at(-1)
  const previous = closed1m.slice(-12, -1)
  let bullCount = 0
  let bearCount = 0
  const labels: string[] = []

  if (current && previous.length >= 4) {
    const priorHigh = Math.max(...previous.slice(-8).map((bar) => bar.high))
    const priorLow = Math.min(...previous.slice(-8).map((bar) => bar.low))
    if (current.close > priorHigh) {
      bullCount += 1
      labels.push('BOS ↑')
      if (previous.slice(-6).some((bar) => bar.close < bar.open)) labels.push('Bullish OB')
    } else if (current.close < priorLow) {
      bearCount += 1
      labels.push('BOS ↓')
      if (previous.slice(-6).some((bar) => bar.close > bar.open)) labels.push('Bearish OB')
    }
    const older = closed1m.at(-3)
    if (older && current.low > older.high) {
      bullCount += 1
      labels.push('Bullish FVG')
    }
    if (older && current.high < older.low) {
      bearCount += 1
      labels.push('Bearish FVG')
    }
    if (current.low < priorLow && current.close > priorLow) {
      bullCount += 1
      labels.push('Low sweep')
    }
    if (current.high > priorHigh && current.close < priorHigh) {
      bearCount += 1
      labels.push('High sweep')
    }
  }

  const smc: SignalKind = bullCount > bearCount ? 'bull' : bearCount > bullCount ? 'bear' : 'neutral'
  const autoSide = confirmations === 2 && bullCount >= 2 && trend === 'up'
    ? 'long'
    : confirmations === 2 && bearCount >= 2 && trend === 'down'
      ? 'short'
      : null

  return { trend, confirmations, smc, bullCount, bearCount, labels, autoSide }
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
