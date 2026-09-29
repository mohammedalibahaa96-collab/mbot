import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/market.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { calculateAtr, calculateRiskSizedNotional, calculateRsi, calculateSignals, detectTrianglePattern, floorQuantityToStep, getAtrExitPrices, getChartMarkers, getChartZones, DEFAULT_CHART_LAYERS } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)

function risingFifteenMinuteBars() {
  return Array.from({ length: 32 }, (_, index) => ({
    time: index * 900,
    open: 100 + index,
    high: 101.2 + index,
    low: 99.8 + index,
    close: 100.8 + index,
    volume: 100,
  }))
}

function flatOneMinuteBars(length = 25) {
  return Array.from({ length }, (_, index) => ({
    time: index * 60,
    open: 100,
    high: 100.2,
    low: 99.5,
    close: 100,
    volume: 10,
  }))
}

function scalpLongBars() {
  const length = 40
  const closes = Array.from({ length }, (_, index) => 100 + 0.01 * index + 0.1 * Math.sin(index * 0.85))
  closes[length - 3] -= 0.16
  closes[length - 2] -= 0.22
  closes[length - 1] = 100.33
  return closes.map((close, index) => {
    const previous = closes[Math.max(0, index - 1)]
    const open = index === length - 1 ? closes[index - 1] - 0.02 : (previous + close) / 2
    return {
      time: index * 60,
      open,
      high: Math.max(open, close) + 0.02,
      low: Math.min(open, close) - 0.02,
      close,
      volume: index === length - 1 ? 16 : 10,
    }
  })
}

function scalpShortBars() {
  return scalpLongBars().map((bar) => ({
    ...bar,
    open: 202 - bar.open,
    high: 202 - bar.low,
    low: 202 - bar.high,
    close: 202 - bar.close,
  }))
}

function fallingFifteenMinuteBars() {
  return risingFifteenMinuteBars().map((bar) => ({
    ...bar,
    open: 202 - bar.open,
    high: 202 - bar.low,
    low: 202 - bar.high,
    close: 202 - bar.close,
  }))
}

function triangleBars(kind) {
  const bars = Array.from({ length: 40 }, (_, index) => ({
    time: index * 60,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
  }))
  for (const index of [5, 12, 19, 26, 33]) bars[index].high = kind === 'ascending' ? 110 : 110 - index * 0.18
  for (const index of [9, 16, 23, 30, 37]) bars[index].low = kind === 'descending' ? 90 : 90 + index * 0.18
  return bars
}

const risingBars = risingFifteenMinuteBars()

test('RSI and ATR helpers calculate bounded rolling indicators', () => {
  assert.equal(calculateRsi([1, 2, 3, 2, 4], 3), 75)
  assert.equal(calculateRsi([1, 1, 1, 1], 3), 50)
  assert.equal(calculateRsi([1, 2, 3], 3), null)
  const candles = [
    { time: 0, open: 10, high: 12, low: 8, close: 10, volume: 1 },
    { time: 1, open: 10, high: 15, low: 11, close: 13, volume: 1 },
    { time: 2, open: 13, high: 14, low: 10, close: 11, volume: 1 },
  ]
  assert.equal(calculateAtr(candles, 2), 4.5)
  assert.equal(calculateAtr(candles.slice(0, 2), 2), null)
})

test('scalp signal requires closed-candle EMA/RSI/ATR/volume filters plus 15m context', () => {
  const long = calculateSignals(scalpLongBars(), risingBars, 'scalp')
  assert.equal(long.autoSide, 'long')
  assert.ok(long.rsi >= 50 && long.rsi <= 68)
  assert.ok(long.atr > 0)
  assert.ok(long.volumeRatio >= 1.05)
  assert.ok(long.scalpChecks.every((check) => check.status === 'pass'))

  const short = calculateSignals(scalpShortBars(), fallingFifteenMinuteBars(), 'scalp')
  assert.equal(short.autoSide, 'short')
  assert.ok(short.rsi >= 32 && short.rsi <= 50)
  assert.ok(short.scalpChecks.every((check) => check.status === 'pass'))
})

test('scalp readiness reports warmup and volume blockers instead of forcing an entry', () => {
  const warmingUp = calculateSignals(flatOneMinuteBars(), risingBars, 'scalp')
  assert.equal(warmingUp.autoSide, null)
  assert.equal(warmingUp.scalpChecks[0].status, 'warmup')

  const lowVolumeBars = scalpLongBars()
  lowVolumeBars.at(-1).volume = 10
  const lowVolume = calculateSignals(lowVolumeBars, risingBars, 'scalp')
  assert.equal(lowVolume.autoSide, null)
  assert.equal(lowVolume.scalpChecks.find((check) => check.label.startsWith('Volume'))?.status, 'wait')

  const unfinished = scalpLongBars()
  unfinished.at(-1).closeTime = Date.now() + 60_000
  assert.equal(calculateSignals(unfinished, risingBars, 'scalp').autoSide, null)
})

test('ATR exits mirror correctly for long and short paper positions; sizing respects stop distance and lot steps', () => {
  assert.deepEqual(getAtrExitPrices(100, 'long', 2, 1.2, 1.8), { stopLoss: 97.6, takeProfit: 103.6 })
  assert.deepEqual(getAtrExitPrices(100, 'short', 2, 1.2, 1.8), { stopLoss: 102.4, takeProfit: 96.4 })
  assert.equal(calculateRiskSizedNotional(1000, 0.5, 1), 500)
  assert.equal(calculateRiskSizedNotional(1000, 0.5, 0), 0)
  assert.equal(calculateRiskSizedNotional(1000, 0.5, -1), 0)
  assert.equal(calculateRiskSizedNotional(0, 0.5, 1), 0)
  assert.equal(floorQuantityToStep(1.239, 0.01), 1.23)
  assert.equal(floorQuantityToStep(1.239, 1), 1)
  assert.equal(floorQuantityToStep(1.239, 0), 1.239)
  assert.equal(floorQuantityToStep(1.239, 1e-8), 1.239)
})

test('trend strategy waits for two aligned 15m candle confirmations', () => {
  const signals = calculateSignals(flatOneMinuteBars(), risingBars, 'trend')
  assert.equal(signals.trend, 'up')
  assert.equal(signals.confirmations, 2)
  assert.equal(signals.autoSide, 'long')
})

test('sweep strategy recognizes a bullish low-liquidity sweep in the trend direction', () => {
  const bars = flatOneMinuteBars()
  bars[bars.length - 1] = { ...bars.at(-1), open: 99.8, high: 100.25, low: 99, close: 100.1 }
  const signals = calculateSignals(bars, risingBars, 'sweep')
  assert.equal(signals.sweep, 'bull')
  assert.equal(signals.autoSide, 'long')
})

test('structure strategy requires a close beyond the recent range', () => {
  const bars = flatOneMinuteBars()
  bars[bars.length - 1] = { ...bars.at(-1), open: 100.1, high: 101.2, low: 100, close: 101 }
  const signals = calculateSignals(bars, risingBars, 'structure')
  assert.equal(signals.bos, 'bull')
  assert.equal(signals.autoSide, 'long')
})

test('order-block strategy waits for a bullish revisit after a recent structure break', () => {
  const bars = flatOneMinuteBars()
  bars[19] = { ...bars[19], open: 101, high: 101.2, low: 100, close: 100.5 }
  bars[20] = { ...bars[20], open: 101.2, high: 103.2, low: 101.1, close: 103 }
  bars[24] = { ...bars[24], open: 100.4, high: 101.4, low: 100.8, close: 100.9 }
  const signals = calculateSignals(bars, risingBars, 'orderBlock')
  assert.equal(signals.orderBlock, 'bull')
  assert.equal(signals.autoSide, 'long')
})

test('FVG strategy requires a revisit of a previously formed bullish gap', () => {
  const bars = flatOneMinuteBars()
  bars[18] = { ...bars[18], high: 104, low: 103.8, open: 103.9, close: 103.95 }
  bars[20] = { ...bars[20], high: 106, low: 105, open: 105.2, close: 105.5 }
  bars[24] = { ...bars[24], open: 104.7, high: 105.6, low: 104.5, close: 105.3 }
  const signals = calculateSignals(bars, risingBars, 'fvgRetest')
  assert.equal(signals.fvgRetest, 'bull')
  assert.equal(signals.autoSide, 'long')
})

test('SMC confluence needs at least two aligned features; an isolated BOS does not trigger', () => {
  const oneFeature = flatOneMinuteBars()
  oneFeature[oneFeature.length - 1] = { ...oneFeature.at(-1), open: 100.1, high: 101.2, low: 100, close: 101 }
  assert.equal(calculateSignals(oneFeature, risingBars, 'confluence').autoSide, null)

  const twoFeatures = flatOneMinuteBars()
  twoFeatures[twoFeatures.length - 1] = { ...twoFeatures.at(-1), open: 102, high: 103.2, low: 101, close: 103 }
  const signals = calculateSignals(twoFeatures, risingBars, 'confluence')
  assert.equal(signals.bos, 'bull')
  assert.equal(signals.fvg, 'bull')
  assert.equal(signals.autoSide, 'long')
})

test('triangle detector draws ascending, descending, and symmetrical converging rails', () => {
  const symmetrical = detectTrianglePattern(triangleBars('symmetrical'))
  assert.equal(symmetrical?.kind, 'symmetrical')
  assert.equal(symmetrical?.resistance.length, 2)
  assert.equal(symmetrical?.support.length, 2)
  assert.ok(symmetrical.resistance[1].value < symmetrical.resistance[0].value)
  assert.ok(symmetrical.support[1].value > symmetrical.support[0].value)

  assert.equal(detectTrianglePattern(triangleBars('ascending'))?.kind, 'ascending')
  assert.equal(detectTrianglePattern(triangleBars('descending'))?.kind, 'descending')
  assert.equal(detectTrianglePattern(flatOneMinuteBars(40)), null)
})

test('chart layers filter markers independently and return OB/FVG zone rails', () => {
  const bars = flatOneMinuteBars(30)
  bars[18] = { ...bars[18], high: 104, low: 103.8, open: 103.9, close: 103.95 }
  bars[20] = { ...bars[20], high: 106, low: 105, open: 105.2, close: 105.5 }
  bars[29] = { ...bars[29], open: 100.1, high: 101.2, low: 100, close: 101 }
  const bosOnly = getChartMarkers(bars, { ...DEFAULT_CHART_LAYERS, orderBlock: false, fvg: false, sweep: false, triangle: false })
  assert.ok(bosOnly.length)
  assert.ok(bosOnly.every((marker) => marker.layer === 'bos'))
  const zones = getChartZones(bars)
  assert.ok(zones.fvg)
  assert.ok(zones.fvg.high > zones.fvg.low)
})
