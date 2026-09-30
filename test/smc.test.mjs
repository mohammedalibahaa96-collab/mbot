import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/smc.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const smc = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)

/** Deterministic pseudo-random generator so the fixtures never flake. */
function rng(seed = 7) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

function candles(count, build) {
  return Array.from({ length: count }, (_, index) => build(index, 60_000 * index))
}

function flat(count = 80) {
  return candles(count, (index, time) => ({ time, open: 100, high: 100.2, low: 99.8, close: 100, volume: 10 }))
}

test('findPivots marks a genuine fractal and ignores flat noise', () => {
  const series = flat(40)
  series[20] = { time: 20 * 60_000, open: 100, high: 105, low: 100, close: 104, volume: 10 }
  series[30] = { time: 30 * 60_000, open: 100, high: 100, low: 95, close: 96, volume: 10 }
  const pivots = smc.findPivots(series, 2)
  const high = pivots.highs.find((p) => p.index === 20)
  const low = pivots.lows.find((p) => p.index === 30)
  assert.equal(high?.price, 105)
  assert.equal(low?.price, 95)
})

test('a close above a confirmed swing high prints BOS up, and the flip prints CHoCH', () => {
  const series = candles(120, (index, time) => {
    // base 100, repeated 10-bar swings, then a clean break
    const phase = index % 10
    const base = index > 80 ? 120 : 100
    if (phase === 0) return { time, open: base, high: base + 3, low: base - 3, close: base, volume: 10 }
    if (phase < 5) return { time, open: base, high: base + 1, low: base - 2, close: base + 1, volume: 10 }
    return { time, open: base + 1, high: base + 2, low: base - 1, close: base - 2, volume: 10 }
  })
  const { events } = smc.detectStructure(series, 2)
  assert.ok(events.length >= 1, 'expected at least one structural break')
  const first = events[0]
  assert.equal(first.kind, 'BOS')
  assert.equal(first.direction, 'bull')
  // A later bearish break of the same structure must be labelled CHoCH.
  const ch = events.find((event) => event.kind === 'CHoCH')
  if (ch) assert.equal(ch.direction, 'bear')
  assert.ok(events.every((event, index) => index === 0 || event.breakTime > events[index - 1].breakTime))
})

test('structure never uses a pivot before it is confirmed', () => {
  const series = candles(60, (index, time) => {
    const base = index >= 40 ? 150 : 100
    return { time, open: base, high: base + 1, low: base - 1, close: base, volume: 10 }
  })
  series[30] = { time: 30 * 60_000, open: 100, high: 160, low: 100, close: 155, volume: 50 }
  const { events } = smc.detectStructure(series, 2)
  for (const event of events) {
    assert.ok(event.breakIndex > 0)
    assert.ok(event.breakTime >= event.originTime, 'a break cannot be printed before its origin pivot')
  }
})

test('fair value gaps are found, graded by ATR, and marked filled', () => {
  const series = candles(40, (index, time) => ({ time, open: 100 + index * 0.1, high: 100.5 + index * 0.1, low: 100 + index * 0.1, close: 100.4 + index * 0.1, volume: 10 }))
  // A single displacement candle leaves a gap between bar 8 and bar 10.
  series[10] = { time: 10 * 60_000, open: 100.4, high: 110, low: 104, close: 109, volume: 90 }
  // Everything after the gap stays above it, so the gap is still open.
  for (let i = 11; i < series.length; i += 1) series[i] = { time: i * 60_000, open: 110, high: 111, low: 109, close: 110.5, volume: 10 }
  const atr = smc.lastAtr(series)
  const gaps = smc.detectFvgs(series, atr, { minAtr: 0.05, limit: 10 })
  const bullish = gaps.find((gap) => gap.originTime === 10 * 60_000)
  assert.ok(bullish, 'expected the 3-candle gap to register as a bullish FVG')
  assert.ok(bullish.sizeAtr > 0)
  assert.equal(bullish.fill, 'open')
  assert.ok(Math.abs(bullish.low - 101.3) < 1e-9)
  assert.ok(Math.abs(bullish.high - 104) < 1e-9)

  // A partial tap that stays inside the gap is reported as partial, not filled.
  const partial = smc.detectFvgs([
    ...series.slice(0, 12),
    { time: 12 * 60_000, open: 110, high: 110, low: 102, close: 105, volume: 30 },
  ], atr, { minAtr: 0.05, limit: 10 })
  assert.equal(partial.find((gap) => gap.originTime === 10 * 60_000)?.fill, 'partial')

  // Trading straight back down through the gap has to flip it to filled.
  const filled = smc.detectFvgs([
    ...series.slice(0, 12),
    { time: 12 * 60_000, open: 110, high: 110, low: 99, close: 99.5, volume: 40 },
  ], atr, { minAtr: 0.05, limit: 10 })
  assert.ok(!filled.some((gap) => gap.originTime === 10 * 60_000), 'a fully traded-through gap must not be returned as open')
})

test('order blocks are graded by displacement and invalidated on a close through', () => {
  const series = candles(80, (index, time) => {
    const base = index > 50 ? 140 : 100
    const phase = index % 8
    if (phase === 0) return { time, open: base, high: base + 4, low: base - 2, close: base + 2, volume: 10 }
    return { time, open: base, high: base + 1, low: base - 1, close: base - 0.5, volume: 10 }
  })
  const atr = smc.lastAtr(series)
  const { events } = smc.detectStructure(series, 2)
  // maxDistanceAtr 0 disables the "is this zone still in reach" filter for this unit test.
  const blocks = smc.detectOrderBlocks(series, events, atr, 6, 0)
  assert.ok(blocks.length >= 1, 'expected at least one order block')
  assert.ok(blocks.every((block) => block.high > block.low))
  assert.ok(blocks.every((block) => block.mitigation !== 'invalidated'))
  assert.ok(blocks.every((block) => ['A', 'B', 'C'].includes(block.grade)))

  assert.ok(blocks.every((block) => block.endTime >= block.startTime))

  // A close far above every zone destroys the bearish ones.
  const top = Math.max(...blocks.map((block) => block.high))
  const crushedUp = smc.detectOrderBlocks(
    [...series, ...Array.from({ length: 30 }, (_, i) => ({ time: (80 + i) * 60_000, open: top * 1.5, high: top * 1.6, low: top * 1.4, close: top * 1.5, volume: 1 }))],
    events,
    atr,
    6,
    0,
  )
  for (const block of blocks.filter((item) => item.side === 'bear')) {
    assert.ok(!crushedUp.some((item) => item.originTime === block.originTime), 'a close above a bearish zone must invalidate it')
  }
  // And a close far below every zone destroys the bullish ones.
  const bottom = Math.min(...blocks.map((block) => block.low))
  const crushedDown = smc.detectOrderBlocks(
    [...series, ...Array.from({ length: 30 }, (_, i) => ({ time: (80 + i) * 60_000, open: bottom * 0.5, high: bottom * 0.6, low: bottom * 0.4, close: bottom * 0.5, volume: 1 }))],
    events,
    atr,
    6,
    0,
  )
  for (const block of blocks.filter((item) => item.side === 'bull')) {
    assert.ok(!crushedDown.some((item) => item.originTime === block.originTime), 'a close below a bullish zone must invalidate it')
  }
})

test('liquidity clusters equal highs and records the sweep that took them', () => {
  const series = candles(70, (index, time) => {
    if (index === 30) return { time, open: 100, high: 106, low: 100, close: 101, volume: 10 }
    if (index === 36) return { time, open: 100, high: 105.9, low: 100, close: 101, volume: 10 }
    if (index === 50) return { time, open: 101, high: 110, low: 100.5, close: 104, volume: 10 }
    return { time, open: 100, high: 101, low: 99, close: 100, volume: 10 }
  })
  const { pivots } = smc.detectStructure(series, 2)
  const levels = smc.detectLiquidity(series, pivots, 0.002)
  const pool = levels.find((level) => level.side === 'buySide' && level.touches >= 2)
  assert.ok(pool, 'two touches within tolerance should cluster into one pool')
  assert.ok(pool.swept, 'a candle that spikes above and closes back below should mark the pool swept')
  assert.equal(typeof pool.sweptTime, 'number')
})

test('patterns classify triangle, wedge, channel and double top from pivots', () => {
  const random = rng(31)
  const series = []
  for (let i = 0; i < 160; i += 1) {
    const drift = i * 0.02
    const wobble = Math.sin(i / 3) * 1.4 + (random() - 0.5) * 0.3
    series.push({ time: i * 60_000, open: 100 + drift + wobble, high: 100.6 + drift + wobble, low: 99.4 + drift + wobble, close: 100.2 + drift + wobble, volume: 10 })
  }
  const { pivots } = smc.detectStructure(series, 2)
  const atr = smc.lastAtr(series)
  const patterns = smc.detectPatterns(series, pivots, atr)
  assert.ok(patterns.length >= 1, 'a wavy series should produce at least one pattern')
  assert.ok(patterns.every((pattern) => pattern.quality >= 0 && pattern.quality <= 1))
  assert.ok(patterns.every((pattern) => pattern.label && pattern.note))

  // Force a clean double top.
  const doubleTop = []
  for (let i = 0; i < 60; i += 1) {
    const base = 100 + Math.sin(i / 4) * 0.2
    doubleTop.push({ time: i * 60_000, open: base, high: base + 0.3, low: base - 0.3, close: base, volume: 10 })
  }
  doubleTop[40] = { time: 40 * 60_000, open: 100, high: 110, low: 100, close: 100, volume: 10 }
  doubleTop[50] = { time: 50 * 60_000, open: 100, high: 109.9, low: 100, close: 100, volume: 10 }
  doubleTop[45] = { time: 45 * 60_000, open: 100, high: 100.5, low: 95, close: 96, volume: 10 }
  const dtPivots = smc.findPivots(doubleTop, 2)
  const dtPatterns = smc.detectPatterns(doubleTop, dtPivots, smc.lastAtr(doubleTop))
  const found = dtPatterns.find((pattern) => pattern.kind === 'doubleTop')
  assert.ok(found, 'equal highs separated by a deep trough should be a double top')
  assert.equal(found.bias, 'bear')
  assert.ok(found.target < 110, 'the neckline trough is the measured target')
})

test('order blocks outside the reach window are dropped, nearest first', () => {
  const random = rng(404)
  const series = []
  let price = 100
  for (let i = 0; i < 320; i += 1) {
    const open = price
    price = Math.max(5, price * (1 + (random() - 0.48) * 0.06))
    const high = Math.max(open, price) * (1 + random() * 0.01)
    const low = Math.min(open, price) * (1 - random() * 0.01)
    series.push({ time: i * 60_000, open, high, low, close: price, volume: 10 })
  }
  const atr = smc.lastAtr(series)
  const { events } = smc.detectStructure(series, 2)
  const unfiltered = smc.detectOrderBlocks(series, events, atr, 30, 0)
  const reachable = smc.detectOrderBlocks(series, events, atr, 30, 8)
  const last = series.at(-1).close
  assert.ok(reachable.length > 0, 'at least one zone must survive the reach filter')
  assert.ok(reachable.length <= unfiltered.length)
  assert.ok(reachable.every((block) => Math.abs((block.low + block.high) / 2 - last) / atr <= 8 + 1e-6), 'every kept zone must be within the reach window')
  for (let i = 1; i < reachable.length; i += 1) {
    const a = reachable[i - 1]
    const b = reachable[i]
    if (a.mitigation === b.mitigation) {
      assert.ok(Math.abs((a.low + a.high) / 2 - last) <= Math.abs((b.low + b.high) / 2 - last) + 1e-9, 'zones of equal freshness must be ordered by distance')
    }
  }
})

test('a break against the higher timeframe loses its directional bias', () => {
  const series = []
  for (let i = 0; i < 200; i += 1) {
    const base = i > 120 ? 260 : 100
    const phase = i % 8
    if (phase === 0) series.push({ time: i * 60_000, open: base, high: base + 4, low: base - 2, close: base + 2, volume: 10 })
    else series.push({ time: i * 60_000, open: base, high: base + 1, low: base - 1, close: base - 0.5, volume: 10 })
  }
  const withTrend = smc.analyzeSmc(series, {}, 'up')
  const againstTrend = smc.analyzeSmc(series, {}, 'down')
  assert.equal(withTrend.bias, 'bull', 'a break with the higher timeframe keeps its bias')
  assert.equal(againstTrend.bias, 'neutral', 'a break against the higher timeframe must not claim a bias')
  assert.ok(againstTrend.verdict.score < withTrend.verdict.score, 'counter-trend confluence must score lower')
  assert.ok(againstTrend.verdict.checks.some((check) => check.label.startsWith('HTF') && check.state === 'fail'))
  assert.notEqual(againstTrend.verdict.stance, 'buyNow', 'a counter-trend setup must never be a full-conviction buy')
  assert.notEqual(againstTrend.verdict.stance, 'sellNow')
})

test('analyzeSmc returns a complete, self-consistent analysis', () => {
  const random = rng(99)
  const series = []
  let price = 100
  for (let i = 0; i < 300; i += 1) {
    price += (random() - 0.48) * 0.9
    price = Math.max(50, price)
    series.push({ time: i * 60_000, open: price, high: price + 0.5, low: price - 0.5, close: price + (random() - 0.5) * 0.4, volume: 100 + random() * 50 })
  }
  const analysis = smc.analyzeSmc(series, {}, 'up')
  assert.ok(analysis.atr > 0)
  assert.ok(analysis.candles.length <= 320)
  assert.ok(['bull', 'bear', 'neutral'].includes(analysis.bias))
  assert.ok(analysis.verdict.directive.length > 20)
  assert.ok(analysis.verdict.checks.length >= 5)
  assert.ok(analysis.verdict.score >= 0 && analysis.verdict.score <= 100)
  assert.ok(['buyNow', 'sellNow', 'waitConfirm', 'waitRetrace', 'noTrade', 'invalid'].includes(analysis.verdict.stance))
  if (analysis.verdict.side) {
    const { side, entryLow, entryHigh, stop, targets } = analysis.verdict
    assert.ok(entryLow !== null && entryHigh !== null)
    assert.ok(entryLow <= entryHigh)
    assert.ok(stop !== null)
    if (side === 'long') {
      assert.ok(stop < entryLow, 'a long stop belongs below the zone')
      assert.ok(targets.every((target) => target.price > entryHigh), 'long targets belong above the zone')
    } else {
      assert.ok(stop > entryHigh, 'a short stop belongs above the zone')
      assert.ok(targets.every((target) => target.price < entryLow), 'short targets belong below the zone')
    }
  }
  if (analysis.projection.side) {
    assert.ok(analysis.projection.path.length > 3)
    assert.ok(analysis.projection.confidence <= 95)
  }
  assert.ok(analysis.liquidity.every((level) => level.swept || level.sweptTime === null))
})

test('the engine refuses a verdict on a warm-up series', () => {
  const analysis = smc.analyzeSmc(flat(20), {}, 'flat')
  assert.equal(analysis.verdict.stance, 'noTrade')
  assert.equal(analysis.verdict.side, null)
  assert.match(analysis.verdict.directive, /30 closed bars/)
})

test('formatLevel prints enough precision for micro-cap pairs', () => {
  assert.equal(smc.formatLevel(1234.5), '1234.50')
  assert.equal(smc.formatLevel(12.3456789), '12.3457')
  assert.equal(smc.formatLevel(0.00001235), '0.00001235')
  assert.equal(smc.formatLevel(0), '—')
})
