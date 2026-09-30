import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts'
import type { Fvg, LiquidityLevel, OrderBlock, Pattern, SmcAnalysis, StructureEvent, Verdict } from '../lib/smc'

/**
 * Canvas layer that paints the Smart Money Concepts drawings on top of the
 * price series. A canvas is used instead of extra chart series because zones,
 * rails, sweeps and the scenario path need fills, hatching and multi-segment
 * labels that the line-series API cannot express.
 *
 * The overlay only reads coordinates from the chart, so panning and zooming
 * stay native and fast.
 */

export type OverlayLayers = {
  structure: boolean
  orderBlocks: boolean
  fvg: boolean
  liquidity: boolean
  sweeps: boolean
  patterns: boolean
  projection: boolean
  verdict: boolean
  premium: boolean
}

export const DEFAULT_OVERLAY_LAYERS: OverlayLayers = {
  structure: true,
  orderBlocks: true,
  fvg: true,
  liquidity: true,
  sweeps: true,
  patterns: true,
  projection: true,
  verdict: true,
  premium: true,
}

const INK = {
  bull: '#39e6a4',
  bear: '#ff5f7e',
  line: '#2f4a44',
  text: '#7d9a90',
  bright: '#c8f7e6',
  amber: '#ffc857',
  cyan: '#5ad1ff',
  violet: '#b388ff',
  grid: 'rgba(120,190,165,0.10)',
}

const FONT = '10px "JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace'
const FONT_SMALL = '9px "JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

type Projection = SmcAnalysis['projection']

export type ChartHandle = {
  chart: IChartApi
  series: ISeriesApi<'Candlestick'>
}

type DrawInput = {
  analysis: SmcAnalysis | null
  layers: OverlayLayers
  position: { side: 'long' | 'short'; entry: number; stopLoss: number; takeProfit: number } | null
}

export function SmcOverlay({
  handle,
  analysis,
  layers,
  position,
}: {
  handle: ChartHandle | null
  analysis: SmcAnalysis | null
  layers: OverlayLayers
  position: { side: 'long' | 'short'; entry: number; stopLoss: number; takeProfit: number } | null
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Draw inputs change on every tick; the chart subscriptions must not. Keeping
  // them in a ref means the rAF loop and the listeners are set up exactly once.
  const inputRef = useRef<DrawInput>({ analysis, layers, position })
  inputRef.current = { analysis, layers, position }

  // Marks the canvas stale after every render; the rAF loop below does the work.
  useEffect(() => {
    if (canvasRef.current) canvasRef.current.dataset.dirty = '1'
  })

  useEffect(() => {
    if (!handle) return
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const { chart } = handle

    const invalidate = () => { canvas.dataset.dirty = '1' }
    chart.timeScale().subscribeVisibleTimeRangeChange(invalidate)
    chart.timeScale().subscribeSizeChange(invalidate)
    const resizeObserver = new ResizeObserver(invalidate)
    resizeObserver.observe(parent)

    let frame = 0
    const loop = () => {
      if (canvas.dataset.dirty === '1') {
        canvas.dataset.dirty = '0'
        draw(canvas, handle, inputRef.current)
      }
      frame = requestAnimationFrame(loop)
    }
    canvas.dataset.dirty = '1'
    frame = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      chart.timeScale().unsubscribeVisibleTimeRangeChange(invalidate)
      chart.timeScale().unsubscribeSizeChange(invalidate)
    }
  }, [handle])

  return <canvas ref={canvasRef} className="smc-overlay" aria-hidden="true" />
}

function draw(
  canvas: HTMLCanvasElement | null,
  { chart, series }: ChartHandle,
  { analysis, layers, position }: DrawInput,
) {
  if (!canvas) return
  const parent = canvas.parentElement
  if (!parent) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = parent.clientWidth
  const height = parent.clientHeight
  if (width <= 0 || height <= 0) return
  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr)
    canvas.height = Math.floor(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  // The time scale starts after the left price gutter, so every x has to be shifted.
  const gutter = chart.priceScale('left').width() + chart.priceScale('right').width()
  const plotWidth = Math.max(1, width - gutter)
  const toX = (time: number) => {
    const raw = chart.timeScale().timeToCoordinate(time as UTCTimestamp)
    return raw === null ? null : gutter + raw
  }
  const toY = (price: number) => {
    const y = series.priceToCoordinate(price)
    return y === null ? null : y
  }
  const range = chart.timeScale().getVisibleRange()
  if (!range) return
  const firstX = toX(Number(range.from))
  const lastX = toX(Number(range.to))
  if (firstX === null || lastX === null || lastX <= firstX) return
  const rightEdge = Math.min(width, lastX + 10)

  ctx.lineWidth = 1
  ctx.font = FONT
  ctx.textBaseline = 'middle'

  if (!analysis) return

  if (layers.premium && analysis.dealingRange) drawDealingRange(ctx, analysis, toX, toY, rightEdge, firstX)
  if (layers.structure) drawStructure(ctx, analysis.structure, toX, toY, rightEdge)
  if (layers.liquidity) drawLiquidity(ctx, analysis.liquidity, analysis.lastPrice, toX, toY, rightEdge)
  if (layers.orderBlocks) drawOrderBlocks(ctx, analysis.orderBlocks, toX, toY, rightEdge, firstX, analysis.candles.at(-1)?.time ?? 0)
  if (layers.fvg) drawFvgs(ctx, analysis.fvgs, toX, toY, rightEdge, firstX, analysis.candles.at(-1)?.time ?? 0)
  if (layers.sweeps) drawSweeps(ctx, analysis.sweeps, toX, toY)
  if (layers.patterns) for (const pattern of analysis.patterns) drawPattern(ctx, pattern, toX, toY, rightEdge)
  if (layers.projection) drawProjection(ctx, analysis.projection, toX, toY)
  if (layers.verdict) drawVerdict(ctx, analysis.verdict, toY, rightEdge, width, analysis.atr)
  if (position) drawOpenPosition(ctx, position, toY, rightEdge, width)
}

/* ---------------------------------------------------------------- */
/* Primitive drawing helpers                                         */
/* ---------------------------------------------------------------- */

type Projector = (time: number) => number | null
type YProjector = (price: number) => number | null

function hatch(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, gap = 6) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  for (let offset = -h; offset < w + h; offset += gap) {
    ctx.beginPath()
    ctx.moveTo(x + offset, y + h)
    ctx.lineTo(x + offset + h, y)
    ctx.stroke()
  }
  ctx.restore()
}

function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  background: string,
  align: 'left' | 'right' | 'center' = 'left',
  font = FONT_SMALL,
) {
  ctx.font = font
  const width = ctx.measureText(text).width
  const padding = 3
  const boxX = align === 'right' ? x - width - padding * 2 : align === 'center' ? x - width / 2 - padding : x
  ctx.fillStyle = background
  ctx.fillRect(Math.round(boxX), Math.round(y - 7), Math.round(width + padding * 2), 14)
  ctx.fillStyle = color
  ctx.textAlign = 'left'
  ctx.fillText(text, Math.round(boxX + padding), Math.round(y))
  return width + padding * 2
}

function dashedLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, dash: number[] = [3, 3]) {
  ctx.save()
  ctx.setLineDash(dash)
  ctx.strokeStyle = color
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  ctx.restore()
}

/* ---------------------------------------------------------------- */
/* Layers                                                            */
/* ---------------------------------------------------------------- */

function drawDealingRange(
  ctx: CanvasRenderingContext2D,
  analysis: SmcAnalysis,
  toX: Projector,
  toY: YProjector,
  rightEdge: number,
  leftEdge: number,
) {
  const range = analysis.dealingRange
  if (!range) return
  const highY = toY(range.high)
  const lowY = toY(range.low)
  const eqY = toY(range.equilibrium)
  if (highY === null || lowY === null || eqY === null) return
  const startX = toX(range.originTime) ?? leftEdge
  ctx.fillStyle = 'rgba(255, 200, 87, 0.045)'
  ctx.fillRect(startX, highY, rightEdge - startX, eqY - highY)
  ctx.fillStyle = 'rgba(90, 209, 255, 0.045)'
  ctx.fillRect(startX, eqY, rightEdge - startX, lowY - eqY)
  dashedLine(ctx, startX, eqY, rightEdge, eqY, 'rgba(200,247,230,0.35)', [6, 4])
  label(ctx, 'PREMIUM', rightEdge - 4, (highY + eqY) / 2, INK.amber, 'rgba(0,0,0,0.55)', 'right')
  label(ctx, 'DISCOUNT', rightEdge - 4, (eqY + lowY) / 2, INK.cyan, 'rgba(0,0,0,0.55)', 'right')
  label(ctx, 'EQ', rightEdge - 4, eqY, INK.text, 'rgba(0,0,0,0.55)', 'right')
}

function drawStructure(
  ctx: CanvasRenderingContext2D,
  events: StructureEvent[],
  toX: Projector,
  toY: YProjector,
  rightEdge: number,
) {
  for (const event of events.slice(-6)) {
    const fromX = toX(event.originTime)
    const breakX = toX(event.breakTime)
    const y = toY(event.originPrice)
    if (fromX === null || breakX === null || y === null) continue
    const color = event.direction === 'bull' ? INK.bull : INK.bear
    ctx.save()
    ctx.setLineDash(event.kind === 'CHoCH' ? [5, 3] : [])
    ctx.strokeStyle = event.kind === 'CHoCH' ? color : `${color}99`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(fromX, y)
    ctx.lineTo(breakX, y)
    ctx.stroke()
    ctx.restore()
    label(ctx, `${event.kind} ${event.direction === 'bull' ? '↑' : '↓'}`, (fromX + breakX) / 2, y - 9, color, 'rgba(3,10,8,0.88)', 'center')
    // The most recent break keeps its level alive to the right edge.
    if (event === events.at(-1)) {
      dashedLine(ctx, breakX, y, rightEdge, y, `${color}66`, [2, 4])
    }
  }
}

function drawLiquidity(
  ctx: CanvasRenderingContext2D,
  levels: LiquidityLevel[],
  lastPrice: number,
  toX: Projector,
  toY: YProjector,
  rightEdge: number,
) {
  const shown = levels.filter((level) => !level.swept).slice(0, 6)
  for (const level of shown) {
    const y = toY(level.price)
    if (y === null) continue
    const distance = Math.abs(level.price - lastPrice)
    const alpha = Math.max(0.12, 0.5 - distance / (level.price * 0.02) * 0.3)
    ctx.save()
    ctx.setLineDash([6, 4])
    ctx.strokeStyle = level.side === 'buySide' ? `rgba(255, 200, 87, ${alpha})` : `rgba(90, 209, 255, ${alpha})`
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(rightEdge, y)
    ctx.stroke()
    ctx.restore()
    label(
      ctx,
      `${level.side === 'buySide' ? 'BSL' : 'SSL'}${level.touches > 1 ? ` x${level.touches}` : ''}`,
      4,
      y - 8,
      level.side === 'buySide' ? INK.amber : INK.cyan,
      'rgba(3,10,8,0.8)',
    )
  }
}

function drawOrderBlocks(
  ctx: CanvasRenderingContext2D,
  blocks: OrderBlock[],
  toX: Projector,
  toY: YProjector,
  rightEdge: number,
  leftEdge: number,
  lastTime: number,
) {
  for (const block of blocks) {
    const highY = toY(block.high)
    const lowY = toY(block.low)
    if (highY === null || lowY === null) continue
    const startX = Math.max(leftEdge - 20, toX(block.startTime) ?? leftEdge)
    const width = Math.max(4, rightEdge - startX)
    const height = Math.max(2, lowY - highY)
    const bull = block.side === 'bull'
    const base = bull ? INK.bull : INK.bear
    const faded = block.mitigation === 'tested'
    ctx.fillStyle = faded ? `${base}12` : `${base}26`
    ctx.fillRect(startX, highY, width, height)
    hatch(ctx, startX, highY, width, height, faded ? `${base}12` : `${base}22`, 7)
    ctx.strokeStyle = faded ? `${base}55` : base
    ctx.lineWidth = 1
    ctx.strokeRect(Math.round(startX) + 0.5, Math.round(highY) + 0.5, Math.round(width), Math.round(height))
    // Solid edge on the side that must hold.
    ctx.fillStyle = base
    ctx.fillRect(Math.round(startX), bull ? Math.round(lowY) - 2 : Math.round(highY), Math.round(width), 2)
    const age = Math.max(0, Math.round((lastTime - block.startTime) / 60_000))
    const text = `${bull ? 'OB↑' : 'OB↓'} ${block.grade} ${block.mitigation.toUpperCase()} · ${age}m`
    label(ctx, text, startX + 4, highY - 8, faded ? `${base}cc` : INK.bright, 'rgba(3,10,8,0.9)')
  }
}

function drawFvgs(
  ctx: CanvasRenderingContext2D,
  zones: Fvg[],
  toX: Projector,
  toY: YProjector,
  rightEdge: number,
  leftEdge: number,
  lastTime: number,
) {
  for (const zone of zones) {
    const highY = toY(zone.high)
    const lowY = toY(zone.low)
    if (highY === null || lowY === null) continue
    const startX = Math.max(leftEdge - 20, toX(zone.originTime) ?? leftEdge)
    const width = Math.max(4, rightEdge - startX)
    const height = Math.max(2, lowY - highY)
    const bull = zone.side === 'bull'
    const color = bull ? INK.violet : INK.cyan
    ctx.fillStyle = `${color}1c`
    ctx.fillRect(startX, highY, width, height)
    ctx.save()
    ctx.setLineDash([2, 3])
    ctx.strokeStyle = `${color}88`
    ctx.strokeRect(Math.round(startX) + 0.5, Math.round(highY) + 0.5, Math.round(width), Math.round(height))
    ctx.restore()
    const age = Math.max(0, Math.round((lastTime - zone.originTime) / 60_000))
    label(ctx, `FVG ${bull ? '↑' : '↓'} ${zone.fill.toUpperCase()} · ${age}m`, startX + 4, lowY + 8, INK.bright, 'rgba(3,10,8,0.9)')
  }
}

function drawSweeps(
  ctx: CanvasRenderingContext2D,
  sweeps: SmcAnalysis['sweeps'],
  toX: Projector,
  toY: YProjector,
) {
  for (const sweep of sweeps.slice(-4)) {
    const x = toX(sweep.time)
    const y = toY(sweep.price)
    if (x === null || y === null) continue
    const bull = sweep.side === 'bull'
    const color = bull ? INK.bull : INK.bear
    const direction = bull ? 1 : -1
    ctx.save()
    ctx.strokeStyle = color
    ctx.fillStyle = `${color}33`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x - 5, y - 7 * direction)
    ctx.lineTo(x + 5, y - 7 * direction)
    ctx.lineTo(x, y)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.restore()
    label(ctx, `✕${sweep.label}`, x, y - 15 * direction, color, 'rgba(3,10,8,0.9)', 'center')
  }
}

function drawPattern(
  ctx: CanvasRenderingContext2D,
  pattern: Pattern,
  toX: Projector,
  toY: YProjector,
  rightEdge: number,
) {
  const color = pattern.bias === 'bull' ? INK.bull : pattern.bias === 'bear' ? INK.bear : INK.amber
  const drawRail = (points: Array<{ time: number; value: number }>, dash: number[]) => {
    ctx.save()
    ctx.setLineDash(dash)
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    let started = false
    for (const point of points) {
      const x = toX(point.time)
      const y = toY(point.value)
      if (x === null || y === null) { started = false; continue }
      if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.restore()
    return points.at(-1)
  }
  const upperEnd = drawRail(pattern.upper, [6, 3])
  const lowerEnd = drawRail(pattern.lower, [6, 3])
  if (pattern.apexTime) {
    const apexX = toX(pattern.apexTime)
    const anchor = upperEnd ?? lowerEnd
    const anchorY = anchor ? toY(anchor.value) : null
    if (apexX !== null && anchorY !== null) dashedLine(ctx, apexX, anchorY, apexX, anchorY + (pattern.bias === 'bear' ? 40 : -40), `${color}55`, [2, 3])
  }
  if (pattern.target !== null) {
    const targetY = toY(pattern.target)
    if (targetY !== null) {
      dashedLine(ctx, Math.max(0, rightEdge - 220), targetY, rightEdge, targetY, `${color}66`, [2, 4])
      label(ctx, `${pattern.label.split(' ')[0]} TGT`, rightEdge - 4, targetY, color, 'rgba(3,10,8,0.85)', 'right')
    }
  }
  const head = upperEnd ?? lowerEnd
  if (head) {
    const x = toX(head.time)
    const y = toY(head.value)
    if (x !== null && y !== null) {
      label(ctx, `${pattern.label} ${Math.round(pattern.quality * 100)}%`, Math.min(x, rightEdge - 4), y - 9, color, 'rgba(3,10,8,0.92)', 'right')
    }
  }
}

function drawProjection(ctx: CanvasRenderingContext2D, projection: Projection, toX: Projector, toY: YProjector) {
  if (projection.path.length < 2) return
  const color = projection.side === 'long' ? INK.bull : projection.side === 'short' ? INK.bear : INK.text
  ctx.save()
  ctx.setLineDash([5, 4])
  ctx.strokeStyle = `${color}aa`
  ctx.lineWidth = 1.5
  ctx.beginPath()
  let started = false
  for (const point of projection.path) {
    const x = toX(point.time)
    const y = toY(point.value)
    if (x === null || y === null) continue
    if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.restore()
  const last = projection.path.at(-1)!
  const x = toX(last.time)
  const y = toY(last.value)
  if (x === null || y === null) return
  ctx.save()
  ctx.fillStyle = `${color}33`
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(x, y, 4, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.restore()
  label(ctx, `SCENARIO ${projection.confidence}%`, x + 8, y, color, 'rgba(3,10,8,0.9)')
  label(ctx, projection.targetLabel, x + 8, y + 12, INK.text, 'rgba(3,10,8,0.9)')
}

function drawVerdict(ctx: CanvasRenderingContext2D, verdict: Verdict, toY: YProjector, rightEdge: number, width: number, atr: number) {
  if (verdict.entryLow === null || verdict.entryHigh === null || verdict.stop === null) return
  const lowY = toY(verdict.entryLow)
  const highY = toY(verdict.entryHigh)
  const stopY = toY(verdict.stop)
  if (lowY === null || highY === null || stopY === null) return
  const long = verdict.side === 'long'
  const color = long ? INK.bull : INK.bear
  const startX = Math.max(0, rightEdge - Math.min(260, width * 0.32))

  ctx.fillStyle = `${color}14`
  ctx.fillRect(startX, Math.min(lowY, highY), rightEdge - startX, Math.abs(lowY - highY))
  ctx.strokeStyle = color
  ctx.setLineDash([4, 2])
  ctx.strokeRect(Math.round(startX) + 0.5, Math.round(Math.min(lowY, highY)) + 0.5, Math.round(rightEdge - startX), Math.round(Math.abs(lowY - highY)))
  ctx.setLineDash([])
  label(ctx, verdict.zoneLabel, startX + 4, Math.min(lowY, highY) - 9, INK.bright, 'rgba(3,10,8,0.92)')

  dashedLine(ctx, 0, stopY, rightEdge, stopY, `${INK.bear}aa`, [2, 3])
  label(ctx, `SL ${verdict.stop.toPrecision(6)}`, 4, stopY, INK.bear, 'rgba(3,10,8,0.9)')
  for (const [index, target] of verdict.targets.entries()) {
    const targetY = toY(target.price)
    if (targetY === null) continue
    dashedLine(ctx, 0, targetY, rightEdge, targetY, `${INK.bull}aa`, [2, 3])
    label(ctx, `TP${index + 1} ${target.price.toPrecision(6)}`, 4, targetY, INK.bull, 'rgba(3,10,8,0.9)')
  }
  if (atr > 0 && verdict.riskReward) {
    const midY = (lowY + highY) / 2
    label(ctx, `R:R ${verdict.riskReward.toFixed(2)} · SCORE ${verdict.score}`, rightEdge - 4, midY, color, 'rgba(3,10,8,0.9)', 'right')
  }
}

function drawOpenPosition(
  ctx: CanvasRenderingContext2D,
  position: { side: 'long' | 'short'; entry: number; stopLoss: number; takeProfit: number },
  toY: YProjector,
  rightEdge: number,
  width: number,
) {
  const entryY = toY(position.entry)
  const stopY = toY(position.stopLoss)
  const targetY = toY(position.takeProfit)
  if (entryY === null || stopY === null || targetY === null) return
  const color = position.side === 'long' ? INK.bull : INK.bear
  const startX = Math.max(0, rightEdge - Math.min(300, width * 0.36))
  ctx.fillStyle = `${color}10`
  ctx.fillRect(startX, Math.min(stopY, targetY), rightEdge - startX, Math.abs(targetY - stopY))
  ctx.strokeStyle = `${color}66`
  ctx.setLineDash([5, 3])
  ctx.strokeRect(Math.round(startX) + 0.5, Math.round(Math.min(stopY, targetY)) + 0.5, Math.round(rightEdge - startX), Math.round(Math.abs(targetY - stopY)))
  ctx.setLineDash([])
  label(ctx, `OPEN ${position.side.toUpperCase()} @ ${position.entry.toPrecision(6)}`, startX + 4, entryY - 9, color, 'rgba(3,10,8,0.92)')
}
