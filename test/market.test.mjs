import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/market.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { calculateSignals } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)

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

const risingBars = risingFifteenMinuteBars()

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
