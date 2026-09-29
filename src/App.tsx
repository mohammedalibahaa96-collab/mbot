import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowLeftRight,
  ArrowUpRight,
  Bell,
  Bot,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  ExternalLink,
  Eye,
  EyeOff,
  FileDown,
  Gauge,
  Info,
  Layers3,
  LockKeyhole,
  Maximize2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  TrendingDown,
  TrendingUp,
  Trash2,
  TerminalSquare,
  Wallet,
  X,
  Zap,
} from 'lucide-react'
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { calculateEma, calculateSignals, getChartMarkers, type Candle, type ChartMarker, type MarketSignals } from './lib/market'

type TradingMode = 'paper' | 'testnet' | 'live'
type MarketType = 'spot' | 'futures'
type Strategy = 'smc' | 'fixed' | 'martingale' | 'anti'
type TradeSide = 'long' | 'short'
type Timeframe = '1m' | '5m' | '15m' | '1h'
type SymbolOption = { symbol: string; base: string; quote: string; name: string }

type ExchangeRules = {
  symbol: string
  status: string
  baseAsset: string
  quoteAsset: string
  minQty: number
  maxQty: number
  stepSize: number
  minNotional: number
  tickSize: number
}

type ExchangeBalance = {
  asset: string
  free: number
  locked: number
  walletBalance?: number
  unrealizedProfit?: number
}

type Settings = {
  strategy: Strategy
  baseOrder: number
  maxOrder: number
  multiplier: number
  maxLosses: number
  riskPct: number
  slPct: number
  tpPct: number
  dailyStopPct: number
  dailyTargetPct: number
  maxTrades: number
  leverage: number
}

type ClosedTrade = {
  id: string
  time: number
  openedAt: number
  timeframe: Timeframe
  symbol: string
  marketType: MarketType
  side: TradeSide
  entry: number
  exit: number
  quantity: number
  notional: number
  pnl: number
  fees: number
  result: 'win' | 'loss' | 'flat'
  reason: string
  source: 'manual' | 'bot'
}

type OpenPosition = {
  id: string
  symbol: string
  marketType: MarketType
  side: TradeSide
  entry: number
  quantity: number
  notional: number
  margin: number
  openFee: number
  stopLoss: number
  takeProfit: number
  openedAt: number
  timeframe: Timeframe
  source: 'manual' | 'bot'
}

type PaperAccount = {
  cash: number
  startingBalance: number
  history: ClosedTrade[]
  position: OpenPosition | null
  settings: Settings
}

type ConsoleLevel = 'info' | 'success' | 'warning' | 'error'
type ConsoleEvent = {
  id: string
  time: number
  level: ConsoleLevel
  source: string
  message: string
}

type TestnetOrder = {
  orderId: number | string
  clientOrderId?: string
  symbol: string
  side: 'BUY' | 'SELL'
  type: string
  status: string
  executedQty: number
  quoteQty: number
  averagePrice: number
  submittedAt: number
  timeframe?: Timeframe
}

type AccountResponse = {
  configured: boolean
  canTrade?: boolean
  mode: TradingMode
  market: MarketType
  balances: ExchangeBalance[]
  message?: string
  updateTime?: number
}

type ApiConfig = {
  liveAccountConfigured: boolean
  testnetAccountConfigured: boolean
  testnetOrdersEnabled: boolean
  testnetOrderCapUsdt: number
  aiConfigured: boolean
  accountAuthRequired: boolean
  accountAccessConfigured: boolean
  execution: 'disabled' | string
}

const SYMBOLS: SymbolOption[] = [
  { symbol: 'SHIBUSDT', base: 'SHIB', quote: 'USDT', name: 'Shiba Inu' },
  { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', name: 'Bitcoin' },
  { symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT', name: 'Ethereum' },
  { symbol: 'SOLUSDT', base: 'SOL', quote: 'USDT', name: 'Solana' },
  { symbol: 'BNBUSDT', base: 'BNB', quote: 'USDT', name: 'BNB' },
  { symbol: 'DGBUSDT', base: 'DGB', quote: 'USDT', name: 'DigiByte' },
]
const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h']
const DEFAULT_SETTINGS: Settings = {
  strategy: 'smc',
  baseOrder: 10,
  maxOrder: 30,
  multiplier: 2,
  maxLosses: 5,
  riskPct: 0.5,
  slPct: 0.6,
  tpPct: 1.2,
  dailyStopPct: 2,
  dailyTargetPct: 2,
  maxTrades: 10,
  leverage: 1,
}
const PAPER_STORAGE_KEY = 'mbot-paper-account-v1'
const TESTNET_ORDERS_STORAGE_KEY = 'mbot-testnet-orders-v1'
const FEE_RATE = 0.001

function freshPaper(balance = 1000): PaperAccount {
  return { cash: balance, startingBalance: balance, history: [], position: null, settings: { ...DEFAULT_SETTINGS } }
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback
}

function normalizeSettings(value: Partial<Settings> = {}): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...value }
  const strategies: Strategy[] = ['smc', 'fixed', 'martingale', 'anti']
  return {
    strategy: strategies.includes(merged.strategy) ? merged.strategy : 'smc',
    baseOrder: clampNumber(merged.baseOrder, 1, 100_000, DEFAULT_SETTINGS.baseOrder),
    maxOrder: clampNumber(merged.maxOrder, 1, 100_000, DEFAULT_SETTINGS.maxOrder),
    multiplier: clampNumber(merged.multiplier, 1, 3, DEFAULT_SETTINGS.multiplier),
    maxLosses: Math.round(clampNumber(merged.maxLosses, 1, 7, DEFAULT_SETTINGS.maxLosses)),
    riskPct: clampNumber(merged.riskPct, 0.1, 2, DEFAULT_SETTINGS.riskPct),
    slPct: clampNumber(merged.slPct, 0.1, 20, DEFAULT_SETTINGS.slPct),
    tpPct: clampNumber(merged.tpPct, 0.1, 50, DEFAULT_SETTINGS.tpPct),
    dailyStopPct: clampNumber(merged.dailyStopPct, 0.1, 50, DEFAULT_SETTINGS.dailyStopPct),
    dailyTargetPct: clampNumber(merged.dailyTargetPct, 0.1, 20, DEFAULT_SETTINGS.dailyTargetPct),
    maxTrades: Math.round(clampNumber(merged.maxTrades, 1, 100, DEFAULT_SETTINGS.maxTrades)),
    leverage: Math.round(clampNumber(merged.leverage, 1, 3, DEFAULT_SETTINGS.leverage)),
  }
}

function loadPaper(): PaperAccount {
  if (typeof window === 'undefined') return freshPaper()
  try {
    const raw = localStorage.getItem(PAPER_STORAGE_KEY)
    if (!raw) return freshPaper()
    const value = JSON.parse(raw) as Partial<PaperAccount>
    return {
      ...freshPaper(),
      ...value,
      cash: clampNumber(value.cash, 0, 1_000_000, 1000),
      startingBalance: clampNumber(value.startingBalance, 10, 1_000_000, 1000),
      history: Array.isArray(value.history) ? value.history : [],
      position: value.position && typeof value.position === 'object' ? value.position : null,
      settings: normalizeSettings(value.settings),
    }
  } catch {
    return freshPaper()
  }
}

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, cache: 'no-store' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`)
  return data as T
}

async function getPublicJson<T>(apiPath: string): Promise<T> {
  // Public market data has no credentials; the browser can serve as a fallback if the local API host has no egress.
  return getJson<T>(`https://api.binance.com${apiPath}`)
}

async function requestKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const query = new URLSearchParams({ symbol, interval, limit: String(limit) })
  try {
    const response = await getJson<{ candles: Candle[] }>(`/api/market/klines?${query}`)
    return response.candles
  } catch (proxyError) {
    try {
      const raw = await getPublicJson<Array<Array<string | number>>>(`/api/v3/klines?${query}`)
      return raw.map((row) => ({ time: Math.floor(Number(row[0]) / 1000), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), closeTime: Number(row[6]) }))
    } catch {
      throw proxyError
    }
  }
}

async function requestTicker(symbol: string) {
  try {
    return await getJson<{ lastPrice: number; priceChangePercent: number; highPrice: number; lowPrice: number; quoteVolume: number }>(`/api/market/ticker?symbol=${encodeURIComponent(symbol)}`)
  } catch (proxyError) {
    try {
      const raw = await getPublicJson<Record<string, string>>(`/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`)
      return { lastPrice: Number(raw.lastPrice), priceChangePercent: Number(raw.priceChangePercent), highPrice: Number(raw.highPrice), lowPrice: Number(raw.lowPrice), quoteVolume: Number(raw.quoteVolume) }
    } catch {
      throw proxyError
    }
  }
}

async function requestRules(symbol: string) {
  try {
    return await getJson<ExchangeRules>(`/api/market/rules?symbol=${encodeURIComponent(symbol)}`)
  } catch (proxyError) {
    try {
      const response = await getPublicJson<{ symbols: Array<{ symbol: string; status: string; baseAsset: string; quoteAsset: string; filters: Array<Record<string, string>> }> }>(`/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`)
      const record = response.symbols?.[0]
      if (!record) throw new Error('No spot trading rules found for this symbol.')
      const filters = Object.fromEntries(record.filters.map((filter) => [filter.filterType, filter]))
      const marketLot = filters.MARKET_LOT_SIZE
      const lot = marketLot && Number(marketLot.stepSize) > 0 ? marketLot : filters.LOT_SIZE
      const notional = filters.NOTIONAL || filters.MIN_NOTIONAL
      return { symbol: record.symbol, status: record.status, baseAsset: record.baseAsset, quoteAsset: record.quoteAsset, minQty: Number(lot?.minQty || 0), maxQty: Number(lot?.maxQty || 0), stepSize: Number(lot?.stepSize || 0), minNotional: Number(notional?.minNotional || 0), tickSize: Number(filters.PRICE_FILTER?.tickSize || 0) } as ExchangeRules
    } catch {
      throw proxyError
    }
  }
}

function formatMoney(value: number, digits = 2) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number.isFinite(value) ? value : 0)
}

function formatCompact(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0)
}

function formatPrice(value: number) {
  if (!Number.isFinite(value) || value === 0) return '—'
  const digits = value >= 1000 ? 2 : value >= 1 ? 4 : value >= 0.01 ? 6 : 9
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function formatQuantity(value: number) {
  return value.toLocaleString('en-US', { maximumFractionDigits: 8 })
}

function formatClock(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDateTime(timestamp: number) {
  return new Date(timestamp).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—'
  const totalSeconds = Math.floor(durationMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function dailyPnl(history: ClosedTrade[], openPnl: number) {
  const day = new Date().toDateString()
  return history.filter((trade) => new Date(trade.time).toDateString() === day).reduce((sum, trade) => sum + trade.pnl, 0) + openPnl
}

function getStreak(history: ClosedTrade[]) {
  let wins = 0
  let losses = 0
  for (const trade of history) {
    if (trade.result === 'win' && losses === 0) wins += 1
    else if (trade.result === 'loss' && wins === 0) losses += 1
    else break
  }
  return { wins, losses }
}

function mergeCandle(current: Candle[], next: Candle[], limit = 240) {
  const updated = [...current]
  for (const candle of next) {
    const index = updated.findIndex((item) => item.time === candle.time)
    if (index >= 0) updated[index] = candle
    else updated.push(candle)
  }
  return updated.sort((a, b) => a.time - b.time).slice(-limit)
}

function smaMarkerTime(time: number) {
  return time as UTCTimestamp
}

function ChartPanel({
  candles,
  symbol,
  timeframe,
  showEma,
  showSignals,
  position,
  history,
  price,
  loading,
  error,
  streamConnected,
  onToggleEma,
  onToggleSignals,
}: {
  candles: Candle[]
  symbol: string
  timeframe: string
  showEma: boolean
  showSignals: boolean
  position: OpenPosition | null
  history: ClosedTrade[]
  price: number
  loading: boolean
  error: string | null
  streamConnected: boolean
  onToggleEma: () => void
  onToggleSignals: () => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const emaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const stopLineRef = useRef<IPriceLine | null>(null)
  const targetLineRef = useRef<IPriceLine | null>(null)
  const [full, setFull] = useState(false)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: { background: { type: ColorType.Solid, color: '#0b1119' }, textColor: '#718096', fontFamily: 'Inter, ui-sans-serif, system-ui', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(119, 139, 164, 0.065)' }, horzLines: { color: 'rgba(119, 139, 164, 0.075)' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: 'rgba(124, 153, 188, 0.3)', width: 1, style: 3, labelBackgroundColor: '#263548' }, horzLine: { color: 'rgba(124, 153, 188, 0.3)', width: 1, style: 3, labelBackgroundColor: '#263548' } },
      rightPriceScale: { borderColor: 'rgba(119, 139, 164, 0.13)', scaleMargins: { top: 0.09, bottom: 0.1 } },
      timeScale: { borderColor: 'rgba(119, 139, 164, 0.13)', timeVisible: true, secondsVisible: false, rightOffset: 5, barSpacing: 7 },
      localization: { priceFormatter: (value: number) => formatPrice(value) },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    })
    const candlesSeries = chart.addCandlestickSeries({
      upColor: '#28c59a',
      downColor: '#f06d82',
      borderUpColor: '#28c59a',
      borderDownColor: '#f06d82',
      wickUpColor: '#28c59a',
      wickDownColor: '#f06d82',
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: '#5c83a8',
      priceLineStyle: 2,
    })
    const emaSeries = chart.addLineSeries({ color: '#e9b65b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible: showEma })
    chartRef.current = chart
    candleSeriesRef.current = candlesSeries
    emaSeriesRef.current = emaSeries

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      chart.applyOptions({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) })
    })
    resizeObserver.observe(containerRef.current)
    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      emaSeriesRef.current = null
      stopLineRef.current = null
      targetLineRef.current = null
    }
  }, [])

  useEffect(() => {
    const series = candleSeriesRef.current
    const chart = chartRef.current
    if (!series || !chart) return
    if (!candles.length) {
      series.setData([])
      emaSeriesRef.current?.setData([])
      if (stopLineRef.current) series.removePriceLine(stopLineRef.current)
      if (targetLineRef.current) series.removePriceLine(targetLineRef.current)
      stopLineRef.current = null
      targetLineRef.current = null
      return
    }
    series.setData(candles.map((bar) => ({ time: bar.time as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close })))
    const values = calculateEma(candles.map((bar) => bar.close), 20)
    emaSeriesRef.current?.setData(candles.map((bar, index) => ({ time: smaMarkerTime(bar.time), value: values[index] })))
    const chartMarkers: ChartMarker[] = showSignals ? getChartMarkers(candles) : []
    const fills = history.slice(0, 14).flatMap((trade) => [{
      time: Math.floor(trade.time / (timeframe === '1m' ? 60_000 : timeframe === '5m' ? 300_000 : timeframe === '15m' ? 900_000 : 3_600_000)) * (timeframe === '1m' ? 60 : timeframe === '5m' ? 300 : timeframe === '15m' ? 900 : 3600),
      position: trade.side === 'long' ? 'belowBar' as const : 'aboveBar' as const,
      color: trade.pnl >= 0 ? '#27c59a' : '#f06d82',
      shape: trade.side === 'long' ? 'arrowUp' as const : 'arrowDown' as const,
      text: trade.result === 'win' ? 'WIN' : trade.result === 'loss' ? 'LOSS' : 'EXIT',
    }])
    const markerTimes = [...chartMarkers, ...fills].sort((a, b) => a.time - b.time)
    series.setMarkers(markerTimes.map((marker) => ({ ...marker, time: marker.time as UTCTimestamp })))
    if (stopLineRef.current) series.removePriceLine(stopLineRef.current)
    if (targetLineRef.current) series.removePriceLine(targetLineRef.current)
    stopLineRef.current = null
    targetLineRef.current = null
    if (position) {
      stopLineRef.current = series.createPriceLine({ price: position.stopLoss, color: '#f06d82', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'SL' })
      targetLineRef.current = series.createPriceLine({ price: position.takeProfit, color: '#28c59a', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'TP' })
    }
  }, [candles, history, position, showSignals, timeframe])

  useEffect(() => {
    emaSeriesRef.current?.applyOptions({ visible: showEma })
  }, [showEma])

  return (
    <section className={`panel chart-panel ${full ? 'chart-panel-full' : ''}`}>
      <div className="panel-heading chart-heading">
        <div className="chart-market-title">
          <div className="chart-coin-icon">{symbol.replace('USDT', '').slice(0, 1)}</div>
          <div>
            <div className="pair-line"><strong>{symbol.replace('USDT', '')}</strong><span>/ USDT</span><span className="mini-market-tag">SPOT DATA</span></div>
            <div className="chart-live-line"><i className="status-dot" /> {streamConnected ? 'Binance WebSocket stream' : 'Binance market feed'} <span className="subtle-dot">·</span> {timeframe} <span className="subtle-dot">·</span> {candles.length ? `${candles.length} bars` : 'waiting for feed'}</div>
          </div>
        </div>
        <div className="chart-actions">
          <button className={`tool-button ${showEma ? 'is-active' : ''}`} onClick={onToggleEma} title="Toggle EMA 20"><span className="legend-line ema-line" /> EMA 20</button>
          <button className={`tool-button ${showSignals ? 'is-active' : ''}`} onClick={onToggleSignals} title="Toggle heuristic structure markers"><Layers3 size={14} /> SMC markers</button>
          <button className="icon-button" onClick={() => setFull((value) => !value)} title={full ? 'Restore chart' : 'Expand chart'}><Maximize2 size={15} /></button>
        </div>
      </div>
      <div className="chart-price-strip">
        <div className="chart-last-price">{formatPrice(price)} <span>USDT</span></div>
        <div className="chart-high-low"><span><small>H</small> {candles.length ? formatPrice(Math.max(...candles.slice(-90).map((c) => c.high))) : '—'}</span><span><small>L</small> {candles.length ? formatPrice(Math.min(...candles.slice(-90).map((c) => c.low))) : '—'}</span></div>
      </div>
      <div className="chart-wrap" ref={containerRef}>
        {!candles.length && <div className="chart-empty"><div className="empty-orbit"><Activity size={20} /></div><strong>{loading ? 'Connecting to Binance market data' : 'Market feed unavailable'}</strong><span>{error || 'Waiting for the public candle feed…'}</span></div>}
        {candles.length > 0 && error && <div className="chart-error-pill"><AlertTriangle size={12} /> Stale feed · retrying</div>}
      </div>
      <div className="chart-footnote"><span><span className="foot-dot teal" /> Green candles close higher</span><span><span className="foot-dot red" /> Red candles close lower</span><span className="footnote-risk"><Info size={12} /> SMC drawings are heuristic examples, not trade guarantees</span></div>
    </section>
  )
}

function App() {
  const [symbol, setSymbol] = useState('SHIBUSDT')
  const [timeframe, setTimeframe] = useState<Timeframe>('1m')
  const [marketMode, setMarketMode] = useState<TradingMode>('paper')
  const [marketType, setMarketType] = useState<MarketType>('spot')
  const [paper, setPaper] = useState<PaperAccount>(loadPaper)
  const [testnetOrders, setTestnetOrders] = useState<TestnetOrder[]>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(TESTNET_ORDERS_STORAGE_KEY) || '[]')
      return Array.isArray(value) ? value : []
    } catch { return [] }
  })
  const [testnetSide, setTestnetSide] = useState<'BUY' | 'SELL'>('BUY')
  const [testnetOrderBusy, setTestnetOrderBusy] = useState(false)
  const [showTestnetConfirm, setShowTestnetConfirm] = useState(false)
  const [price, setPrice] = useState(0)
  const [ticker, setTicker] = useState<{ changePct: number; high: number; low: number; quoteVolume: number } | null>(null)
  const [candles, setCandles] = useState<Candle[]>([])
  const [oneMinuteBars, setOneMinuteBars] = useState<Candle[]>([])
  const [fifteenMinuteBars, setFifteenMinuteBars] = useState<Candle[]>([])
  const [rules, setRules] = useState<ExchangeRules | null>(null)
  const [marketLoading, setMarketLoading] = useState(true)
  const [marketError, setMarketError] = useState<string | null>(null)
  const [streamConnected, setStreamConnected] = useState(false)
  const streamConnectedRef = useRef(false)
  const [lastUpdate, setLastUpdate] = useState(0)
  const [config, setConfig] = useState<ApiConfig | null>(null)
  const [accessToken, setAccessToken] = useState(() => {
    try { return sessionStorage.getItem('mbot-local-access-token') || '' } catch { return '' }
  })
  const [accessTokenDraft, setAccessTokenDraft] = useState('')
  const [showAccessModal, setShowAccessModal] = useState(false)
  const [account, setAccount] = useState<AccountResponse | null>(null)
  const [accountLoading, setAccountLoading] = useState(false)
  const [accountError, setAccountError] = useState<string | null>(null)
  const [showSignals, setShowSignals] = useState(true)
  const [showEma, setShowEma] = useState(true)
  const [orderSize, setOrderSize] = useState(10)
  const [isRunning, setIsRunning] = useState(false)
  const [activeTab, setActiveTab] = useState<'activity' | 'positions' | 'balances' | 'console'>('activity')
  const [consoleEvents, setConsoleEvents] = useState<ConsoleEvent[]>(() => [{ id: `boot-${Date.now()}`, time: Date.now(), level: 'info', source: 'SYSTEM', message: 'MBOT terminal initialized · mainnet order routing disabled.' }])
  const [showSecurity, setShowSecurity] = useState(true)
  const [showBalanceEditor, setShowBalanceEditor] = useState(false)
  const [newBalance, setNewBalance] = useState('1000')
  const [aiText, setAiText] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [alertOn, setAlertOn] = useState(true)
  const audioContextRef = useRef<AudioContext | null>(null)
  const autoTradeCandleRef = useRef(0)
  const symbolInfo = SYMBOLS.find((item) => item.symbol === symbol) || SYMBOLS[0]
  const settings = paper.settings
  const logEvent = useCallback((source: string, level: ConsoleLevel, message: string) => {
    setConsoleEvents((current) => [{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, time: Date.now(), level, source, message }, ...current].slice(0, 100))
  }, [])

  useEffect(() => {
    try { localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify(paper)) } catch { /* private browsing may block storage */ }
  }, [paper])

  useEffect(() => {
    try { localStorage.setItem(TESTNET_ORDERS_STORAGE_KEY, JSON.stringify(testnetOrders.slice(0, 100))) } catch { /* local testnet history is optional */ }
  }, [testnetOrders])

  useEffect(() => {
    let live = true
    getJson<ApiConfig>('/api/config').then((data) => { if (live) setConfig(data) }).catch(() => { if (live) setConfig(null) })
    return () => { live = false }
  }, [])

  const refreshMarket = useCallback(async (initial = false) => {
    if (initial) setMarketLoading(true)
    try {
      const calls = await Promise.all([
        requestTicker(symbol),
        requestKlines(symbol, timeframe, 240),
        timeframe === '1m' ? Promise.resolve(null) : requestKlines(symbol, '1m', 240),
        requestKlines(symbol, '15m', 120),
      ])
      setPrice(calls[0].lastPrice)
      setTicker({ changePct: calls[0].priceChangePercent, high: calls[0].highPrice, low: calls[0].lowPrice, quoteVolume: calls[0].quoteVolume })
      setCandles(calls[1])
      setOneMinuteBars(timeframe === '1m' ? calls[1] : calls[2] || [])
      setFifteenMinuteBars(calls[3])
      setLastUpdate(Date.now())
      setMarketError(null)
    } catch (error) {
      if (!streamConnectedRef.current) setMarketError(error instanceof Error ? error.message : 'Cannot reach Binance market data.')
    } finally {
      setMarketLoading(false)
    }
  }, [symbol, timeframe])

  useEffect(() => {
    void refreshMarket(true)
    const timer = window.setInterval(() => { void refreshMarket() }, 5000)
    return () => window.clearInterval(timer)
  }, [refreshMarket])

  useEffect(() => {
    let active = true
    let retryDelay = 1000
    let retryTimer: number | undefined
    let socket: WebSocket | null = null
    let reportedOffline = false
    const intervals = [...new Set(['1m', '15m', timeframe])]
    const streams = [`${symbol.toLowerCase()}@ticker`, ...intervals.map((interval) => `${symbol.toLowerCase()}@kline_${interval}`)]
    const socketUrl = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`

    const connect = () => {
      if (!active) return
      try {
        socket = new WebSocket(socketUrl)
      } catch {
        scheduleRetry()
        return
      }
      socket.onopen = () => {
        retryDelay = 1000
        reportedOffline = false
        streamConnectedRef.current = true
        setStreamConnected(true)
        logEvent('FEED', 'success', `Binance market stream connected for ${symbol} (${timeframe}).`)
      }
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { data?: Record<string, any> }
          const data = message.data || message as Record<string, any>
          if (data.e === '24hrTicker') {
            setPrice(Number(data.c))
            setTicker({ changePct: Number(data.P), high: Number(data.h), low: Number(data.l), quoteVolume: Number(data.q) })
            setLastUpdate(Date.now())
            setMarketError(null)
          }
          if (data.e === 'kline' && data.k) {
            const kline = data.k as Record<string, string | number>
            const candle: Candle = { time: Math.floor(Number(kline.t) / 1000), open: Number(kline.o), high: Number(kline.h), low: Number(kline.l), close: Number(kline.c), volume: Number(kline.v), closeTime: Number(kline.T) }
            const interval = String(kline.i)
            if (interval === timeframe) setCandles((current) => mergeCandle(current, [candle]))
            if (interval === '1m') setOneMinuteBars((current) => mergeCandle(current, [candle]))
            if (interval === '15m') setFifteenMinuteBars((current) => mergeCandle(current, [candle], 120))
            setPrice(candle.close)
            setLastUpdate(Date.now())
            setMarketError(null)
          }
          setMarketLoading(false)
        } catch { /* ignore malformed stream messages */ }
      }
      socket.onerror = () => socket?.close()
      socket.onclose = () => {
        const wasConnected = streamConnectedRef.current
        streamConnectedRef.current = false
        if (active) {
          setStreamConnected(false)
          if (!reportedOffline) {
            logEvent('FEED', 'warning', wasConnected ? 'Market stream disconnected · retrying with REST fallback.' : 'WebSocket unavailable · using REST fallback when reachable.')
            reportedOffline = true
          }
          scheduleRetry()
        }
      }
    }
    function scheduleRetry() {
      if (!active) return
      window.clearTimeout(retryTimer)
      retryTimer = window.setTimeout(connect, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 30_000)
    }
    connect()
    return () => {
      active = false
      window.clearTimeout(retryTimer)
      streamConnectedRef.current = false
      socket?.close(1000)
      setStreamConnected(false)
    }
  }, [symbol, timeframe, logEvent])

  useEffect(() => {
    let live = true
    setRules(null)
    requestRules(symbol)
      .then((data) => { if (live) setRules(data) })
      .catch(() => { if (live) setRules(null) })
    return () => { live = false }
  }, [symbol])

  const refreshAccount = useCallback(async () => {
    if (marketMode === 'paper') {
      setAccount(null)
      setAccountError(null)
      return
    }
    setAccountLoading(true)
    setAccount(null)
    setAccountError(null)
    try {
      const result = await getJson<AccountResponse>(`/api/account?mode=${marketMode}&market=${marketType}`, {
        headers: accessToken ? { 'X-MBOT-Access-Token': accessToken } : {},
      })
      setAccount(result)
      if (!result.configured) setAccountError(result.message || 'Read-only API keys are not configured.')
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : 'Unable to read the account.')
    } finally {
      setAccountLoading(false)
    }
  }, [marketMode, marketType, accessToken])

  useEffect(() => { void refreshAccount() }, [refreshAccount])

  const signals: MarketSignals = useMemo(() => calculateSignals(oneMinuteBars, fifteenMinuteBars), [oneMinuteBars, fifteenMinuteBars])
  const openPnl = useMemo(() => {
    if (!paper.position || !price) return 0
    const direction = paper.position.side === 'long' ? 1 : -1
    const gross = (price - paper.position.entry) * paper.position.quantity * direction
    const estimatedExitFee = paper.position.quantity * price * FEE_RATE
    return gross - paper.position.openFee - estimatedExitFee
  }, [paper.position, price])
  const paperEquity = paper.cash + (paper.position
    ? paper.position.marketType === 'spot'
      ? paper.position.quantity * price
      : paper.position.margin + (price - paper.position.entry) * paper.position.quantity * (paper.position.side === 'long' ? 1 : -1)
    : 0)
  const todayResult = dailyPnl(paper.history, openPnl)
  const todayPercent = paper.startingBalance > 0 ? (todayResult / paper.startingBalance) * 100 : 0
  const closedToday = paper.history.filter((trade) => new Date(trade.time).toDateString() === new Date().toDateString()).length
  const streak = getStreak(paper.history)
  const totalWins = paper.history.filter((trade) => trade.result === 'win').length
  const winRate = paper.history.length ? (totalWins / paper.history.length) * 100 : 0
  const minNotional = rules?.minNotional || 1
  const marketSourceReady = Boolean(price && candles.length)
  const dailyLocked = todayPercent <= -settings.dailyStopPct || todayPercent >= settings.dailyTargetPct
  const lossLimitAmount = paper.startingBalance * settings.dailyStopPct / 100
  const targetAmount = paper.startingBalance * settings.dailyTargetPct / 100
  const lossRemaining = Math.max(0, lossLimitAmount + todayResult)
  const targetRemaining = Math.max(0, targetAmount - todayResult)
  const lossProgress = lossLimitAmount > 0 ? Math.min(100, Math.max(0, (1 - lossRemaining / lossLimitAmount) * 100)) : 0
  const targetProgress = targetAmount > 0 ? Math.min(100, Math.max(0, todayResult / targetAmount * 100)) : 0
  const matches = SYMBOLS.filter((item) => `${item.base} ${item.name}`.toLowerCase().includes(searchTerm.toLowerCase()))

  const prepareAudio = useCallback(() => {
    if (typeof window === 'undefined' || !window.AudioContext) return null
    if (!audioContextRef.current) audioContextRef.current = new window.AudioContext()
    if (audioContextRef.current.state === 'suspended') void audioContextRef.current.resume().catch(() => undefined)
    return audioContextRef.current
  }, [])

  const playTradeTone = useCallback((kind: 'open' | 'close') => {
    const context = prepareAudio()
    if (!context) return
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = kind === 'open' ? 880 : 620
    gain.gain.setValueAtTime(0.045, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.16)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.17)
  }, [prepareAudio])

  const closePosition = useCallback((position: OpenPosition, exitPrice: number, reason: string) => {
    if (!exitPrice || !Number.isFinite(exitPrice)) return
    setPaper((current) => {
      if (!current.position || current.position.id !== position.id) return current
      const direction = position.side === 'long' ? 1 : -1
      const grossPnl = (exitPrice - position.entry) * position.quantity * direction
      const exitFee = position.quantity * exitPrice * FEE_RATE
      const pnl = grossPnl - position.openFee - exitFee
      const result: ClosedTrade['result'] = pnl > 0.0000001 ? 'win' : pnl < -0.0000001 ? 'loss' : 'flat'
      const trade: ClosedTrade = {
        id: position.id,
        time: Date.now(),
        openedAt: position.openedAt,
        timeframe: position.timeframe || '1m',
        symbol: position.symbol,
        marketType: position.marketType,
        side: position.side,
        entry: position.entry,
        exit: exitPrice,
        quantity: position.quantity,
        notional: position.notional,
        pnl,
        fees: position.openFee + exitFee,
        result,
        reason,
        source: position.source,
      }
      const cashDelta = position.marketType === 'spot'
        ? position.quantity * exitPrice - exitFee
        : position.margin + grossPnl - exitFee
      return { ...current, cash: current.cash + cashDelta, position: null, history: [trade, ...current.history].slice(0, 500) }
    })
    if (alertOn && typeof window !== 'undefined') {
      playTradeTone('close')
      try { window.dispatchEvent(new CustomEvent('mbot-trade-close', { detail: { reason } })) } catch { /* ignore */ }
    }
    setToast(`${reason} · position closed at ${formatPrice(exitPrice)}`)
    logEvent('PAPER', 'info', `${reason} · ${position.side.toUpperCase()} ${position.symbol} closed at ${formatPrice(exitPrice)}.`)
  }, [alertOn, playTradeTone, logEvent])

  const currentPosition = paper.position
  useEffect(() => {
    if (!currentPosition || !price) return
    const hitStop = currentPosition.side === 'long' ? price <= currentPosition.stopLoss : price >= currentPosition.stopLoss
    const hitTarget = currentPosition.side === 'long' ? price >= currentPosition.takeProfit : price <= currentPosition.takeProfit
    if (hitStop) closePosition(currentPosition, price, 'Stop loss')
    else if (hitTarget) closePosition(currentPosition, price, 'Take profit')
  }, [price, currentPosition, closePosition])

  const autoOrderSize = useCallback(() => {
    const equity = Math.max(0, paperEquity)
    const riskSizedNotional = settings.slPct > 0 ? (equity * settings.riskPct / 100) / (settings.slPct / 100) : settings.baseOrder
    const streakNow = getStreak(paper.history)
    let requested = Math.min(settings.baseOrder, riskSizedNotional)
    if (settings.strategy === 'martingale') requested = settings.baseOrder * Math.pow(settings.multiplier, streakNow.losses)
    if (settings.strategy === 'anti') requested = settings.baseOrder * Math.pow(settings.multiplier, streakNow.wins)
    return Math.max(0, Math.min(requested, riskSizedNotional, settings.maxOrder, Math.max(0, paper.cash * 0.9)))
  }, [paper.history, paper.cash, paperEquity, settings])

  const openPaperPosition = useCallback((side: TradeSide, source: 'manual' | 'bot' = 'manual', customSize?: number) => {
    if (marketMode !== 'paper') {
      setToast('Exchange mode is read-only in this build. Switch to Paper to simulate an order.')
      return
    }
    if (!marketSourceReady || !price) {
      setToast('Waiting for the live market price before placing a paper order.')
      return
    }
    if (paper.position) {
      setToast('A paper position is already open. Close it before opening another.')
      return
    }
    if (marketType === 'spot' && side === 'short') {
      setToast('Spot markets do not support short positions. Switch to paper futures to simulate a short.')
      return
    }
    if (source === 'bot' && (dailyLocked || streak.losses >= settings.maxLosses || closedToday >= settings.maxTrades)) {
      setIsRunning(false)
      setToast('Safety lock reached. The paper bot has been paused.')
      return
    }
    const requested = customSize ?? orderSize
    const notional = Math.min(requested, settings.maxOrder, paper.cash * (marketType === 'futures' ? settings.leverage : 1) * 0.98)
    if (notional < minNotional) {
      setToast(`Order is below this symbol's current minimum notional (${formatMoney(minNotional)}).`)
      return
    }
    const leverage = marketType === 'futures' ? Math.min(Math.max(settings.leverage, 1), 3) : 1
    const margin = marketType === 'futures' ? notional / leverage : notional
    const openFee = notional * FEE_RATE
    if (margin + openFee > paper.cash) {
      setToast('Insufficient demo balance for this size and estimated fee.')
      return
    }
    const quantity = notional / price
    const stopLoss = side === 'long' ? price * (1 - settings.slPct / 100) : price * (1 + settings.slPct / 100)
    const takeProfit = side === 'long' ? price * (1 + settings.tpPct / 100) : price * (1 - settings.tpPct / 100)
    const position: OpenPosition = {
      id: `paper-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      symbol,
      marketType,
      side,
      entry: price,
      quantity,
      notional,
      margin,
      openFee,
      stopLoss,
      takeProfit,
      openedAt: Date.now(),
      timeframe: source === 'bot' ? '1m' : timeframe,
      source,
    }
    setPaper((current) => ({ ...current, cash: current.cash - margin - openFee, position }))
    logEvent(source === 'bot' ? 'BOT' : 'PAPER', 'success', `${side.toUpperCase()} ${symbol} opened · ${formatMoney(notional)} notional at ${formatPrice(price)}.`)
    setToast(`${source === 'bot' ? 'Paper bot' : 'Manual paper'} ${side} opened · ${formatMoney(notional)} notional`)
    if (alertOn && typeof window !== 'undefined') {
      playTradeTone('open')
      try { window.dispatchEvent(new CustomEvent('mbot-trade-open', { detail: { side, symbol } })) } catch { /* ignore */ }
    }
  }, [marketMode, marketSourceReady, price, paper.position, paper.cash, marketType, dailyLocked, streak.losses, settings, closedToday, orderSize, minNotional, symbol, timeframe, alertOn, playTradeTone, logEvent])

  useEffect(() => {
    if (!isRunning || marketMode !== 'paper') return
    if (dailyLocked || streak.losses >= settings.maxLosses || closedToday >= settings.maxTrades) {
      setIsRunning(false)
      const reason = dailyLocked ? 'Daily paper limit reached.' : 'Paper bot safety limit reached.'
      logEvent('GUARD', 'warning', `${reason} Bot paused for safety.`)
      setToast(`${reason} Bot paused for safety.`)
      return
    }
    if (paper.position || !signals.autoSide || !oneMinuteBars.length) return
    const closed = oneMinuteBars.filter((bar) => !bar.closeTime || bar.closeTime < Date.now()).at(-1)
    if (!closed || closed.time === autoTradeCandleRef.current) return
    if (marketType === 'spot' && signals.autoSide === 'short') return
    autoTradeCandleRef.current = closed.time
    openPaperPosition(signals.autoSide, 'bot', autoOrderSize())
  }, [isRunning, marketMode, dailyLocked, streak.losses, settings.maxLosses, settings.maxTrades, closedToday, paper.position, signals, oneMinuteBars, marketType, openPaperPosition, autoOrderSize, logEvent])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const updateSettings = (patch: Partial<Settings>) => {
    setPaper((current) => ({ ...current, settings: normalizeSettings({ ...current.settings, ...patch }) }))
  }

  const setPaperBalance = () => {
    const balance = Number(newBalance)
    if (!Number.isFinite(balance) || balance < 10 || balance > 1_000_000) {
      setToast('Demo balance must be between $10 and $1,000,000.')
      return
    }
    if (paper.position) {
      setToast('Close the open demo position before resetting the wallet.')
      return
    }
    setPaper(freshPaper(balance))
    setIsRunning(false)
    setShowBalanceEditor(false)
    setToast(`Paper wallet reset to ${formatMoney(balance)}. This is not real exchange funds.`)
  }

  const saveAccessToken = () => {
    const token = accessTokenDraft.trim()
    if (!token) {
      setToast('Enter the local dashboard access token from the server .env.')
      return
    }
    setAccessToken(token)
    try { sessionStorage.setItem('mbot-local-access-token', token) } catch { /* session remains active until refresh */ }
    setAccessTokenDraft('')
    setShowAccessModal(false)
    setToast('Local access unlocked for this browser tab.')
  }

  const clearAccessToken = () => {
    setAccessToken('')
    setAccount(null)
    try { sessionStorage.removeItem('mbot-local-access-token') } catch { /* ignore */ }
    setShowAccessModal(false)
    setToast('Local access token cleared from this tab.')
  }

  const requestManual = (side: TradeSide) => {
    if (paper.position) {
      closePosition(paper.position, price, 'Manual close')
      return
    }
    openPaperPosition(side, 'manual')
  }

  const exportCsv = () => {
    const isTestnet = marketMode === 'testnet'
    const header = isTestnet
      ? ['submitted_at', 'completed_at', 'duration_seconds', 'symbol', 'market', 'chart_interval', 'side', 'order_id', 'status', 'average_price', 'executed_qty', 'quote_qty_usdt']
      : ['opened_at', 'closed_at', 'duration_seconds', 'symbol', 'market', 'chart_interval', 'side', 'entry', 'exit', 'quantity', 'notional_usdt', 'pnl_usdt', 'fees_usdt', 'result', 'reason']
    const records = isTestnet
      ? testnetOrders.map((order) => [new Date(order.submittedAt).toISOString(), '', '', order.symbol, 'spot-testnet', order.timeframe || '', order.side, order.orderId, order.status, order.averagePrice, order.executedQty, order.quoteQty])
      : paper.history.map((trade) => [new Date(trade.openedAt || trade.time).toISOString(), new Date(trade.time).toISOString(), trade.openedAt ? Math.max(0, (trade.time - trade.openedAt) / 1000).toFixed(1) : '', trade.symbol, trade.marketType, trade.timeframe || '1m', trade.side, trade.entry, trade.exit, trade.quantity, trade.notional, trade.pnl, trade.fees, trade.result, trade.reason])
    const rows = [header, ...records]
    const csv = rows.map((row) => row.map((field) => `"${String(field).replaceAll('"', '""')}"`).join(',')).join('\n')
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    link.download = `mbot-${isTestnet ? 'testnet-orders' : 'paper-trades'}-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const submitTestnetOrder = async () => {
    if (!accessToken) {
      setShowTestnetConfirm(false)
      setAccessTokenDraft('')
      setShowAccessModal(true)
      return
    }
    if (marketMode !== 'testnet' || marketType !== 'spot') return
    setTestnetOrderBusy(true)
    try {
      const response = await fetch('/api/testnet/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MBOT-Access-Token': accessToken },
        body: JSON.stringify({ symbol, side: testnetSide, quoteOrderQty: orderSize }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error || 'Testnet order was rejected.')
      const order = data as TestnetOrder
      setTestnetOrders((current) => [{ ...order, timeframe }, ...current].slice(0, 100))
      setShowTestnetConfirm(false)
      logEvent('TESTNET', 'success', `${order.side} ${symbol} ${order.status.toLowerCase()} · order #${order.orderId} · ${formatMoney(order.quoteQty)}.`)
      setToast(`Spot Testnet ${order.side} ${order.status.toLowerCase()} · order #${order.orderId}`)
      void refreshAccount()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Testnet order failed.'
      if (message.toLowerCase().includes('access token')) {
        setShowTestnetConfirm(false)
        setShowAccessModal(true)
      }
      logEvent('TESTNET', 'error', message)
      setToast(message)
    } finally {
      setTestnetOrderBusy(false)
    }
  }

  const askAi = async () => {
    if (config?.aiConfigured && config.accountAccessConfigured && !accessToken) {
      setAccessTokenDraft('')
      setShowAccessModal(true)
      return
    }
    setAiBusy(true)
    setAiText('')
    try {
      const response = await fetch('/api/ai/insight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(accessToken ? { 'X-MBOT-Access-Token': accessToken } : {}) },
        body: JSON.stringify({ symbol, interval: timeframe, price, trend15m: signals.trend, signal: signals.labels.join(', ') || 'No confirmed setup' }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error || 'AI commentary unavailable.')
      setAiText(data.text)
    } catch (error) {
      setAiText(error instanceof Error ? error.message : 'AI commentary is not configured. Local market tools still work.')
    } finally {
      setAiBusy(false)
    }
  }

  const paperWinRate = `${winRate.toFixed(0)}%`
  const primaryUsdt = marketMode === 'paper' ? paper.cash : (account?.balances.find((asset) => asset.asset === 'USDT')?.free || 0)
  const accountTitle = marketMode === 'paper' ? 'Paper wallet' : marketMode === 'testnet' ? 'Testnet account' : 'Live account'
  const marketStatus = marketError && !streamConnected ? 'warning' : streamConnected || lastUpdate ? 'online' : 'connecting'
  const signalDescription = signals.smc === 'bull' ? 'Bullish structure' : signals.smc === 'bear' ? 'Bearish structure' : 'No confluence'
  const riskCap = Math.min(settings.maxOrder, Math.max(0, paper.cash))
  const testnetCap = config?.testnetOrderCapUsdt || 25
  const canTestnetTrade = marketMode === 'testnet' && marketType === 'spot' && Boolean(config?.testnetOrdersEnabled && config.testnetAccountConfigured && config.accountAccessConfigured)
  const historyCount = marketMode === 'testnet' ? testnetOrders.length : paper.history.length
  const maxNotionalInfo = rules ? `Exchange minimum ${formatMoney(rules.minNotional)} · step ${formatQuantity(rules.stepSize)}` : 'Exchange filters loading · paper fallback minimum $1'

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Activity size={20} strokeWidth={2.5} /></div>
          <div className="brand-name">m<span>bot</span><small>TERMINAL</small></div>
        </div>
        <div className="topbar-divider" />
        <div className="workspace-label"><span className="workspace-dot" /> Trading workspace <ChevronDown size={13} /></div>
        <div className="topbar-center">
          <div className={`exchange-status ${marketStatus}`}><span className="status-dot" />{marketError && !streamConnected ? 'Feed issue' : streamConnected ? 'Binance WebSocket live' : lastUpdate ? 'Binance market live' : 'Connecting market'}</div>
          <span className="topbar-market">PUBLIC MARKET DATA <span>·</span> READ-ONLY EXCHANGE</span>
        </div>
        <div className="topbar-right">
          <button className={`top-icon-button ${alertOn ? 'notify-on' : ''}`} onClick={() => { const next = !alertOn; setAlertOn(next); if (next) prepareAudio() }} title={alertOn ? 'Turn trade sound alerts off' : 'Turn trade sound alerts on'}><Bell size={16} /><i /></button>
          <div className="topbar-user"><div className="avatar">M</div><div><strong>Local operator</strong><span>On this device</span></div><ChevronDown size={13} /></div>
        </div>
      </header>

      <div className="app-body">
        <aside className="rail">
          <button className="rail-icon selected" title="Trading terminal"><Activity size={18} /></button>
          <button className="rail-icon" title="Markets" onClick={() => setSearchOpen(true)}><Search size={18} /></button>
          <button className="rail-icon" title="Strategy settings" onClick={() => document.getElementById('strategy-panel')?.scrollIntoView({ behavior: 'smooth' })}><SlidersHorizontal size={18} /></button>
          <div className="rail-spacer" />
          <div className="rail-lock"><LockKeyhole size={15} /><span>LOCAL</span></div>
        </aside>

        <main className="main-content">
          {showSecurity && <div className="security-banner">
            <div className="security-icon"><AlertTriangle size={16} /></div>
            <div className="security-copy"><strong>Security action required</strong><span>API and AI keys were shared in chat. Revoke and replace them before configuring this app. This terminal never uses keys pasted into the browser.</span></div>
            <button className="security-link" onClick={() => setShowSecurity(false)}>Dismiss <X size={14} /></button>
          </div>}

          <div className="page-title-row">
            <div>
              <div className="eyebrow">OVERVIEW <span> / </span> TERMINAL</div>
              <h1>Trading terminal <span className="title-live-dot" /></h1>
              <p className="page-subtitle">Live market context. Simulated execution. You stay in control.</p>
            </div>
            <div className="header-controls">
              <div className="mode-picker-wrap">
                <div className="mode-label">ACCOUNT MODE</div>
                <div className="mode-picker">
                  <span className={`mode-dot ${marketMode}`} />
                  <select aria-label="Account mode" value={marketMode} onChange={(event) => { setMarketMode(event.target.value as TradingMode); setIsRunning(false) }}>
                    <option value="paper">Paper trading</option>
                    <option value="testnet">Binance Testnet · {config?.testnetOrdersEnabled && config.testnetAccountConfigured && config.accountAccessConfigured ? 'Spot orders gated' : 'read-only by default'}</option>
                    <option value="live">Live account · read-only</option>
                  </select>
                  <ChevronDown size={13} />
                </div>
              </div>
              <button className="button button-outline refresh-button" onClick={() => { void refreshMarket(); void refreshAccount() }}><RefreshCw size={14} /> Refresh</button>
            </div>
          </div>

          <section className="metrics-grid">
            <div className="metric-card balance-card">
              <div className="metric-heading"><span>{marketMode === 'paper' ? 'PAPER EQUITY' : 'USDT AVAILABLE'}</span><span className="metric-icon green-icon"><Wallet size={15} /></span></div>
              <div className="metric-main-value">{marketMode === 'paper' ? formatMoney(paperEquity) : account?.configured ? formatMoney(primaryUsdt) : '—'}</div>
              <div className="metric-caption"><span className={marketMode === 'paper' ? 'soft-green' : 'muted-text'}>{marketMode === 'paper' ? 'Simulated · not real funds' : account?.configured ? `${account.balances.length} non-zero assets` : 'Read-only credentials not configured'}</span>{marketMode === 'paper' && <button className="inline-action" onClick={() => { setNewBalance(String(paper.startingBalance)); setShowBalanceEditor(true) }}>Edit wallet</button>}</div>
            </div>
            <div className="metric-card">
              <div className="metric-heading"><span>DAY P&L <small>paper ledger</small></span><span className={`metric-icon ${todayResult >= 0 ? 'green-icon' : 'red-icon'}`}>{todayResult >= 0 ? <TrendingUp size={15} /> : <TrendingDown size={15} />}</span></div>
              <div className={`metric-main-value ${todayResult >= 0 ? 'value-positive' : 'value-negative'}`}>{marketMode === 'paper' ? `${todayResult >= 0 ? '+' : '−'}${formatMoney(Math.abs(todayResult))}` : '—'}</div>
              <div className="metric-caption"><span className={todayPercent >= 0 ? 'soft-green' : 'soft-red'}>{marketMode === 'paper' ? `${todayPercent >= 0 ? '+' : ''}${todayPercent.toFixed(2)}% today` : 'Live P&L not calculated'}</span><span className="caption-right">Target {settings.dailyTargetPct}%</span></div>
            </div>
            <div className="metric-card">
              <div className="metric-heading"><span>24H MARKET MOVE</span><span className={`metric-icon ${ticker && ticker.changePct >= 0 ? 'green-icon' : 'red-icon'}`}><Activity size={15} /></span></div>
              <div className={`metric-main-value ${ticker && ticker.changePct >= 0 ? 'value-positive' : 'value-negative'}`}>{ticker ? `${ticker.changePct >= 0 ? '+' : ''}${ticker.changePct.toFixed(2)}%` : '—'}</div>
              <div className="metric-caption"><span className="muted-text">{symbolInfo.base}/USDT · 24h change</span><span className="caption-right">Vol {ticker ? formatCompact(ticker.quoteVolume) : '—'} USDT</span></div>
            </div>
            <div className="metric-card">
              <div className="metric-heading"><span>WIN RATE <small>paper history</small></span><span className="metric-icon blue-icon"><Gauge size={15} /></span></div>
              <div className="metric-main-value">{marketMode === 'paper' ? paperWinRate : '—'}</div>
              <div className="metric-caption"><span className="muted-text">{paper.history.length} closed trades</span><span className="caption-right">{streak.wins ? `${streak.wins}W streak` : streak.losses ? `${streak.losses}L streak` : 'No active streak'}</span></div>
            </div>
          </section>

          <div className="market-toolbar">
            <div className="market-selector-area">
              <button className="market-select" onClick={() => setSearchOpen((value) => !value)}>
                <div className="token-icon">{symbolInfo.base.slice(0, 1)}</div><div className="market-pair"><strong>{symbolInfo.base}<span>/USDT</span></strong><small>{symbolInfo.name}</small></div><ChevronDown size={14} />
              </button>
              <div className="toolbar-divider" />
              <div className="timeframes" aria-label="Chart timeframe">
                {TIMEFRAMES.map((item) => <button key={item} className={timeframe === item ? 'selected' : ''} onClick={() => setTimeframe(item)}>{item}</button>)}
              </div>
              <div className="toolbar-divider small-hide" />
              <div className="market-type-switch" aria-label="Market type">
                <button className={marketType === 'spot' ? 'selected' : ''} onClick={() => setMarketType('spot')}>Spot</button>
                <button className={marketType === 'futures' ? 'selected' : ''} onClick={() => setMarketType('futures')}>Futures</button>
              </div>
            </div>
            <div className="market-stats">
              <span>24H HIGH <strong>{ticker ? formatPrice(ticker.high) : '—'}</strong></span>
              <span>24H LOW <strong>{ticker ? formatPrice(ticker.low) : '—'}</strong></span>
              <span className="updated-time"><Clock3 size={12} /> {lastUpdate ? formatClock(lastUpdate) : '--:--:--'} UTC</span>
            </div>
          </div>

          <div className="dashboard-grid">
            <div className="dashboard-left">
              <ChartPanel
                candles={candles}
                symbol={symbol}
                timeframe={timeframe}
                showEma={showEma}
                showSignals={showSignals}
                position={paper.position}
                history={paper.history}
                price={price}
                loading={marketLoading}
                error={marketError}
                streamConnected={streamConnected}
                onToggleEma={() => setShowEma((value) => !value)}
                onToggleSignals={() => setShowSignals((value) => !value)}
              />

              <section className="panel activity-panel">
                <div className="panel-heading activity-heading">
                  <div className="tabs-list">
                    <button className={activeTab === 'activity' ? 'active' : ''} onClick={() => setActiveTab('activity')}>{marketMode === 'testnet' ? 'Testnet orders' : 'Trade history'} <span className="tab-count">{historyCount}</span></button>
                    <button className={activeTab === 'positions' ? 'active' : ''} onClick={() => setActiveTab('positions')}>Open position <span className="tab-count">{paper.position ? '1' : '0'}</span></button>
                    <button className={activeTab === 'balances' ? 'active' : ''} onClick={() => setActiveTab('balances')}>Assets</button>
                    <button className={activeTab === 'console' ? 'active' : ''} onClick={() => setActiveTab('console')}><TerminalSquare size={12} /> Console <span className="tab-count">{consoleEvents.length}</span></button>
                  </div>
                  <div className="activity-actions">
                    {activeTab === 'activity' && <button className="tool-button" onClick={exportCsv}><FileDown size={14} /> Export CSV</button>}
                    {activeTab === 'balances' && marketMode !== 'paper' && <button className="tool-button" onClick={() => void refreshAccount()}><RefreshCw size={13} /> Sync</button>}
                    {activeTab === 'console' && <button className="tool-button" onClick={() => setConsoleEvents([])}><Trash2 size={13} /> Clear console</button>}
                  </div>
                </div>
                {activeTab === 'activity' && <div className="table-scroll"><table className="data-table">
                  <thead><tr><th>OPENED</th><th>CLOSED</th><th>TIME PER TRADE</th><th>PAIR</th><th>TYPE</th><th>SIDE</th><th>ENTRY</th><th>EXIT</th><th>SIZE</th><th>PNL</th><th>STATUS</th></tr></thead>
                  <tbody>
                    {marketMode === 'testnet' ? testnetOrders.slice(0, 8).map((order) => <tr key={`testnet-${order.orderId}`}>
                      <td className="time-cell">{formatDateTime(order.submittedAt)}</td><td>—</td><td>—</td><td className="pair-cell">{order.symbol.replace('USDT', '')}<span>/USDT</span><small className="trade-timeframe">{order.timeframe || timeframe} chart</small></td><td>market</td><td><span className={`side-label ${order.side === 'BUY' ? 'long' : 'short'}`}>{order.side}</span></td><td>{order.averagePrice ? formatPrice(order.averagePrice) : '—'}</td><td>—</td><td>{formatMoney(order.quoteQty)}</td><td>—</td><td><span className={`result-pill ${order.status === 'FILLED' ? 'win' : 'flat'}`}>{order.status}</span></td>
                    </tr>) : paper.history.slice(0, 8).map((trade) => <tr key={trade.id}>
                      <td className="time-cell">{formatDateTime(trade.openedAt || trade.time)}</td><td className="time-cell">{formatDateTime(trade.time)}</td><td>{trade.openedAt ? formatDuration(trade.time - trade.openedAt) : '—'}</td><td className="pair-cell">{trade.symbol.replace('USDT', '')}<span>/USDT</span><small className="trade-timeframe">{trade.timeframe || '1m'} chart</small></td><td>{trade.marketType}</td><td><span className={`side-label ${trade.side}`}>{trade.side}</span></td><td>{formatPrice(trade.entry)}</td><td>{formatPrice(trade.exit)}</td><td>{formatMoney(trade.notional)}</td><td className={trade.pnl >= 0 ? 'value-positive' : 'value-negative'}>{trade.pnl >= 0 ? '+' : '−'}{formatMoney(Math.abs(trade.pnl))}</td><td><span className={`result-pill ${trade.result}`}>{trade.result === 'win' ? 'Win' : trade.result === 'loss' ? 'Loss' : 'Flat'}</span></td>
                    </tr>)}
                    {!historyCount && <tr><td colSpan={11} className="empty-table"><div className="empty-table-icon"><ArrowLeftRight size={17} /></div><strong>{marketMode === 'testnet' ? 'No Testnet orders yet' : 'No closed trades yet'}</strong><span>{marketMode === 'testnet' ? 'Confirmed Spot Testnet market orders will appear here.' : 'Manual or paper-bot activity will appear here. Nothing is sent to Binance.'}</span></td></tr>}
                  </tbody>
                </table></div>}
                {activeTab === 'positions' && <div className="position-table-area">
                  {paper.position ? <div className="open-position-row">
                    <div className="position-main"><span className={`position-side-dot ${paper.position.side}`} /><div><strong>{paper.position.symbol.replace('USDT', '')}/USDT <em>{paper.position.side}</em></strong><small>{paper.position.marketType} · {paper.position.timeframe || '1m'} chart · opened {formatDateTime(paper.position.openedAt)}</small></div></div>
                    <div><small>ENTRY</small><strong>{formatPrice(paper.position.entry)}</strong></div><div><small>MARK PRICE</small><strong>{formatPrice(price)}</strong></div><div><small>SIZE</small><strong>{formatMoney(paper.position.notional)}</strong></div><div><small>UNREALIZED P&L</small><strong className={openPnl >= 0 ? 'value-positive' : 'value-negative'}>{openPnl >= 0 ? '+' : '−'}{formatMoney(Math.abs(openPnl))}</strong></div><div><small>TIME OPEN</small><strong>{formatDuration(Date.now() - paper.position.openedAt)}</strong></div><button className="button button-danger-sm" onClick={() => closePosition(paper.position!, price, 'Manual close')}>Close</button>
                  </div> : <div className="empty-inline"><Layers3 size={18} /><span>No open paper positions.</span></div>}
                </div>}
                {activeTab === 'balances' && <div className="balances-table-area">
                  {marketMode === 'paper' ? <div className="asset-line"><div className="asset-icon usdt-icon">$</div><div className="asset-name"><strong>USDT</strong><small>Paper quote balance</small></div><div className="asset-amount"><strong>{formatQuantity(paper.cash)}</strong><small>{formatMoney(paper.cash)}</small></div><div className="asset-context">Simulated only</div></div> : accountLoading ? <div className="empty-inline"><RefreshCw size={16} className="spin" /><span>Reading account securely on the server…</span></div> : account?.configured ? account.balances.length ? account.balances.map((balance) => <div className="asset-line" key={balance.asset}><div className="asset-icon asset-generic">{balance.asset.slice(0, 1)}</div><div className="asset-name"><strong>{balance.asset}</strong><small>{marketType === 'futures' ? 'Futures wallet' : 'Spot balance'}</small></div><div className="asset-amount"><strong>{formatQuantity(balance.free + balance.locked)}</strong><small>{formatQuantity(balance.free)} available</small></div><div className="asset-context">Read-only</div></div>) : <div className="empty-inline"><Wallet size={16} /><span>No non-zero assets returned.</span></div> : <div className="empty-inline account-locked"><LockKeyhole size={16} /><span>{accountError || 'Configure read-only API credentials in the server .env.'}</span>{config?.accountAccessConfigured && accountError?.toLowerCase().includes('token') && <button className="auth-link" onClick={() => { setAccessTokenDraft(''); setShowAccessModal(true) }}>Unlock</button>}</div>}
                </div>}
                {activeTab === 'console' && <div className="console-terminal">
                  <div className="console-toolbar"><span><i className="console-live-led" /> LOCAL SESSION / {marketMode.toUpperCase()} / {symbol}</span><span>{consoleEvents.length} EVENTS</span></div>
                  <div className="console-stream" role="log" aria-live="polite">
                    {consoleEvents.slice(0, 50).reverse().map((event) => <div className="console-row" key={event.id}>
                      <time>{formatClock(event.time)}</time><span className={`console-level ${event.level}`}>{event.level.toUpperCase()}</span><b>{event.source}</b><code>{event.message}</code>
                    </div>)}
                    {!consoleEvents.length && <div className="console-empty">Console cleared. New runtime events will appear here.</div>}
                    <div className="console-prompt"><b>mbot&gt;</b><span>monitoring feed · execution policy: {marketMode === 'paper' ? 'PAPER SIMULATION' : marketMode === 'testnet' ? 'TESTNET GATED' : 'MAINNET READ-ONLY'}</span><i /></div>
                  </div>
                </div>}
              </section>
            </div>

            <aside className="dashboard-right">
              <section className="panel order-panel">
                <div className="panel-heading order-panel-heading">
                  <div><div className="panel-kicker">ORDER TICKET</div><h2>{marketMode === 'paper' ? 'Paper order' : marketMode === 'testnet' ? 'Spot Testnet' : 'Live account'}</h2></div>
                  <span className={`read-only-pill ${marketMode === 'paper' || canTestnetTrade ? 'paper-pill' : ''}`}>{marketMode === 'paper' ? <><span className="status-dot" /> SIM ONLY</> : canTestnetTrade ? <><span className="status-dot" /> TESTNET · CAPPED</> : <><Eye size={12} /> READ-ONLY</>}</span>
                </div>
                <div className="order-market-row"><div className="token-icon small-token">{symbolInfo.base.slice(0, 1)}</div><div><strong>{symbolInfo.base}/USDT</strong><span>{marketType === 'spot' ? 'Spot market' : 'Futures market'}</span></div><div className="order-current-price"><strong>{formatPrice(price)}</strong><small className={ticker && ticker.changePct >= 0 ? 'value-positive' : 'value-negative'}>{ticker ? `${ticker.changePct >= 0 ? '+' : ''}${ticker.changePct.toFixed(2)}%` : '—'}</small></div></div>

                {marketMode === 'live' ? <div className="readonly-notice"><ShieldCheck size={17} /><div><strong>Mainnet is read-only</strong><span>Live balances may be displayed, but this app has no mainnet order route. Switch to Paper or explicitly enable the capped Spot Testnet route.</span></div></div> : marketMode === 'testnet' && !canTestnetTrade ? <div className="readonly-notice"><ShieldCheck size={17} /><div><strong>{marketType === 'futures' ? 'Futures Testnet orders are off' : !config?.testnetOrdersEnabled ? 'Testnet order route is disabled' : !config.testnetAccountConfigured ? 'Fresh Testnet credentials required' : 'Local server access token required'}</strong><span>{marketType === 'futures' ? 'This milestone supports Spot Testnet market orders only. Futures remains read-only.' : !config?.testnetOrdersEnabled ? 'Testnet submission is off by default. Set ENABLE_TESTNET_ORDERS=true on the API server to allow capped manual Spot Testnet orders.' : !config.testnetAccountConfigured ? 'Set fresh Spot Testnet API keys in .env. Never use the exposed keys from chat.' : 'Set MBOT_ACCESS_TOKEN in the API .env, restart the server, then unlock the dashboard tab.'}</span></div></div> : <>
                  <div className="side-selector">
                    <button className={`side-button buy-side ${marketMode === 'testnet' && testnetSide === 'BUY' ? 'testnet-selected' : ''}`} onClick={() => marketMode === 'testnet' ? setTestnetSide('BUY') : requestManual('long')} disabled={!price || (marketMode === 'paper' && Boolean(paper.position))}><ArrowUpRight size={15} /> {marketMode === 'testnet' ? 'Buy' : marketType === 'spot' ? 'Buy' : 'Long'}</button>
                    <button className={`side-button sell-side ${marketMode === 'testnet' ? testnetSide === 'SELL' ? 'testnet-selected' : '' : paper.position ? 'close-side' : ''}`} onClick={() => marketMode === 'testnet' ? setTestnetSide('SELL') : paper.position ? requestManual(paper.position.side) : marketType === 'futures' ? requestManual('short') : setToast('Spot cannot open a short. Use Buy to open, then Close position to exit.')} disabled={!price}><ArrowDownRight size={15} /> {marketMode === 'testnet' ? 'Sell' : paper.position ? 'Close position' : marketType === 'spot' ? 'Sell' : 'Short'}</button>
                  </div>
                  <div className="order-field">
                    <div className="field-label-row"><label htmlFor="order-size">Order size</label><span>{marketMode === 'paper' ? <>Available <b>{formatMoney(paper.cash)}</b></> : <>Server cap <b>{formatMoney(testnetCap)}</b></>}</span></div>
                    <div className="input-with-unit"><input id="order-size" type="number" min="1" max={marketMode === 'testnet' ? testnetCap : riskCap || 100000} step="1" value={orderSize} onChange={(event) => setOrderSize(Math.max(0, Number(event.target.value)))} /><span>USDT</span><button className="max-link" onClick={() => setOrderSize(marketMode === 'testnet' ? testnetCap : Math.max(0, Math.min(settings.maxOrder, paper.cash * (marketType === 'futures' ? settings.leverage : 1) * 0.98)))}>MAX</button></div>
                    <div className="quick-sizes"><button onClick={() => setOrderSize(Math.min(marketMode === 'testnet' ? testnetCap : settings.maxOrder, 10))}>$10</button><button onClick={() => setOrderSize(Math.min(marketMode === 'testnet' ? testnetCap : settings.maxOrder, 25))}>$25</button><button onClick={() => setOrderSize(Math.min(marketMode === 'testnet' ? testnetCap : settings.maxOrder, 50))}>$50</button><span>{marketMode === 'testnet' ? 'Spot Testnet · market' : marketType === 'futures' ? `${Math.min(settings.leverage, 3)}× paper` : 'Paper simulation'}</span></div>
                  </div>
                  <div className="order-summary">
                    <div><span>Est. quantity</span><strong>{price ? formatQuantity(orderSize / price) : '—'} {symbolInfo.base}</strong></div>
                    <div><span>Est. taker fee <i title="Illustrative fee estimate only. Actual rates depend on your account and venue."><CircleHelp size={12} /></i></span><strong>{formatMoney(orderSize * FEE_RATE, 4)}</strong></div>
                    <div><span>{marketMode === 'testnet' ? 'Protective orders' : 'Stop loss / take profit'}</span><strong>{marketMode === 'testnet' ? 'Not attached' : `${settings.slPct}% / ${settings.tpPct}%`}</strong></div>
                  </div>
                  <div className="minimum-info"><Info size={12} /><span>{maxNotionalInfo}</span></div>
                  <button className={`button primary-order-button ${marketMode === 'testnet' && testnetSide === 'SELL' ? 'testnet-sell-order' : ''} ${marketMode === 'paper' && paper.position ? 'button-muted' : ''}`} onClick={() => marketMode === 'testnet' ? setShowTestnetConfirm(true) : paper.position ? closePosition(paper.position, price, 'Manual close') : openPaperPosition('long', 'manual')} disabled={!price || (marketMode === 'testnet' ? !canTestnetTrade || orderSize < minNotional || orderSize > testnetCap || testnetOrderBusy : !paper.position && orderSize < minNotional)}>
                    {marketMode === 'testnet' ? <><ShieldCheck size={14} /> Review Testnet {testnetSide}</> : paper.position ? <><Square size={14} fill="currentColor" /> Close paper position</> : <><Plus size={15} /> {marketType === 'spot' ? 'Buy' : 'Open long'} {symbolInfo.base}</>}
                  </button>
                  <div className="paper-order-note"><LockKeyhole size={11} /> {marketMode === 'testnet' ? `Manual Spot Testnet only · hard-capped at ${formatMoney(testnetCap)} · no Mainnet route` : 'Simulated at the current quote · no Binance order is sent'}</div>
                </>}
                <div className="ticket-bottom-row"><span><span className="status-dot" /> {accountTitle}</span><button onClick={() => marketMode === 'paper' ? setShowBalanceEditor(true) : void refreshAccount()}>{marketMode === 'paper' ? 'Edit' : accountLoading ? 'Syncing…' : 'Sync'} <RefreshCw size={11} /></button></div>
              </section>

              <section className="panel strategy-panel" id="strategy-panel">
                <div className="panel-heading strategy-heading"><div><div className="panel-kicker">BOT CONTROL</div><h2>Strategy & risk</h2></div><button className="icon-button compact" title="Strategy help"><CircleHelp size={15} /></button></div>
                <div className="strategy-status-row">
                  <div><span className="status-indicator" /><span>{isRunning ? 'Paper bot running' : 'Bot stopped'}</span></div>
                  <button className={`bot-toggle ${isRunning ? 'running' : ''}`} onClick={() => {
                    if (marketMode !== 'paper') { setToast('Automatic execution is available in Paper mode only.'); return }
                    if (isRunning) { setIsRunning(false); logEvent('BOT', 'warning', 'Paper strategy paused by operator.'); setToast('Paper bot paused.') }
                    else if (!marketSourceReady) setToast('Wait for market data before starting the paper bot.')
                    else { prepareAudio(); setIsRunning(true); logEvent('BOT', 'success', `Paper strategy started · ${settings.strategy.toUpperCase()} · ${symbol}.`); setToast('Paper bot started. Trades are simulated only.') }
                  }}>
                    {isRunning ? <><Pause size={13} /> Pause</> : <><Play size={13} fill="currentColor" /> Start</>}
                  </button>
                </div>
                <div className="strategy-form">
                  <div className="field-label-row"><label htmlFor="strategy-select">Strategy</label><span className="demo-only-label"><ShieldCheck size={11} /> Paper only</span></div>
                  <div className="select-wrap"><select id="strategy-select" value={settings.strategy} onChange={(event) => updateSettings({ strategy: event.target.value as Strategy })}>
                    <option value="smc">SMC confluence · cautious</option><option value="fixed">Fixed size</option><option value="martingale">Martingale · capped demo</option><option value="anti">Anti-martingale · capped demo</option>
                  </select><ChevronDown size={13} /></div>
                  <div className="two-field-row">
                    <div><label htmlFor="base-order">Base size</label><div className="mini-input"><input id="base-order" type="number" min="1" max="100000" value={settings.baseOrder} onChange={(event) => updateSettings({ baseOrder: Math.max(1, Number(event.target.value)) })} /><span>USDT</span></div></div>
                    <div><label htmlFor="max-order">Max size cap</label><div className="mini-input"><input id="max-order" type="number" min="1" max="100000" value={settings.maxOrder} onChange={(event) => updateSettings({ maxOrder: Math.max(1, Number(event.target.value)) })} /><span>USDT</span></div></div>
                  </div>
                  {(settings.strategy === 'martingale' || settings.strategy === 'anti') && <div className="two-field-row compact-row">
                    <div><label htmlFor="multiplier">Step multiplier</label><div className="mini-input"><input id="multiplier" type="number" min="1" max="3" step="0.1" value={settings.multiplier} onChange={(event) => updateSettings({ multiplier: Math.min(3, Math.max(1, Number(event.target.value))) })} /><span>×</span></div></div>
                    <div><label htmlFor="max-losses">Loss stop</label><div className="mini-input"><input id="max-losses" type="number" min="1" max="7" value={settings.maxLosses} onChange={(event) => updateSettings({ maxLosses: Math.min(7, Math.max(1, Number(event.target.value))) })} /><span>losses</span></div></div>
                  </div>}
                  <div className="two-field-row">
                    <div><label htmlFor="stop-loss">Stop loss</label><div className="mini-input"><input id="stop-loss" type="number" min="0.1" max="20" step="0.1" value={settings.slPct} onChange={(event) => updateSettings({ slPct: Math.max(0.1, Number(event.target.value)) })} /><span>%</span></div></div>
                    <div><label htmlFor="take-profit">Take profit</label><div className="mini-input"><input id="take-profit" type="number" min="0.1" max="50" step="0.1" value={settings.tpPct} onChange={(event) => updateSettings({ tpPct: Math.max(0.1, Number(event.target.value)) })} /><span>%</span></div></div>
                  </div>
                  {marketType === 'futures' && <div className="two-field-row compact-row">
                    <div><label htmlFor="leverage">Paper leverage</label><div className="mini-input"><input id="leverage" type="number" min="1" max="3" step="1" value={settings.leverage} onChange={(event) => updateSettings({ leverage: Math.min(3, Math.max(1, Number(event.target.value))) })} /><span>×</span></div></div>
                    <div className="future-warning"><AlertTriangle size={12} /> Simulation only</div>
                  </div>}
                  <div className="risk-divider" />
                  <div className="risk-toggles-title"><span>Daily circuit breakers</span><span>based on paper balance</span></div>
                  <div className="two-field-row risk-row">
                    <div><label htmlFor="daily-stop">Max daily loss</label><div className="mini-input"><input id="daily-stop" type="number" min="0.1" max="50" step="0.1" value={settings.dailyStopPct} onChange={(event) => updateSettings({ dailyStopPct: Math.max(0.1, Number(event.target.value)) })} /><span>%</span></div></div>
                    <div><label htmlFor="daily-target">Stop after gain</label><div className="mini-input"><input id="daily-target" type="number" min="0.1" max="20" step="0.1" value={settings.dailyTargetPct} onChange={(event) => updateSettings({ dailyTargetPct: Math.max(0.1, Number(event.target.value)) })} /><span>%</span></div></div>
                  </div>
                  <div className="two-field-row compact-row">
                    <div><label htmlFor="risk-pct">Risk budget</label><div className="mini-input"><input id="risk-pct" type="number" min="0.1" max="2" step="0.1" value={settings.riskPct} onChange={(event) => updateSettings({ riskPct: Math.min(2, Math.max(0.1, Number(event.target.value))) })} /><span>% / trade</span></div></div>
                    <div><label htmlFor="max-trades">Trade limit</label><div className="mini-input"><input id="max-trades" type="number" min="1" max="100" value={settings.maxTrades} onChange={(event) => updateSettings({ maxTrades: Math.max(1, Number(event.target.value)) })} /><span>/ day</span></div></div>
                  </div>
                  <div className="circuit-distance">
                    <div className="distance-item"><div><span>TO DAILY STOP</span><strong>{formatMoney(lossRemaining)}</strong></div><div className="distance-track"><i className="loss-fill" style={{ width: `${lossProgress}%` }} /></div></div>
                    <div className="distance-item"><div><span>TO DAILY TARGET</span><strong>{formatMoney(targetRemaining)}</strong></div><div className="distance-track"><i className="target-fill" style={{ width: `${targetProgress}%` }} /></div></div>
                  </div>
                  <div className="guardrail-note"><ShieldCheck size={13} /><span>Hard caps: multiplier ≤3×, leverage ≤3× in paper, loss stop ≤7. Live execution is off.</span></div>
                  <div className="strategy-footer-stats">
                    <div><span>15m BIAS</span><strong className={signals.trend === 'up' ? 'value-positive' : signals.trend === 'down' ? 'value-negative' : ''}>{signals.trend.toUpperCase()}</strong></div>
                    <div><span>CONFIRM</span><strong>{signals.confirmations}/2</strong></div>
                    <div><span>LOSS RUN</span><strong className={streak.losses ? 'value-negative' : ''}>{streak.losses}/{settings.maxLosses}</strong></div>
                  </div>
                </div>
              </section>

              <section className="panel structure-panel">
                <div className="panel-heading structure-heading"><div><div className="panel-kicker">MARKET STRUCTURE</div><h2>Signal monitor</h2></div><span className="heuristic-tag">HEURISTIC</span></div>
                <div className="signal-summary"><div className={`signal-icon ${signals.smc}`}><Activity size={17} /></div><div><strong>{signalDescription}</strong><span>15m bias {signals.trend} · {signals.confirmations}/2 candle confirmation</span></div><div className={`signal-pip ${signals.smc}`} /></div>
                <div className="signal-list">
                  {(signals.labels.length ? signals.labels.slice(0, 3) : ['Waiting for aligned structure signals']).map((label, index) => <div className="signal-list-item" key={`${label}-${index}`}><span className="signal-check"><Check size={11} /></span><span>{label}</span><small>1m</small></div>)}
                </div>
                <div className="structure-counts"><div><span className="bull-count">BULLISH</span><strong>{signals.bullCount}</strong></div><div><span className="bear-count">BEARISH</span><strong>{signals.bearCount}</strong></div><div><span>CONFLUENCE</span><strong>{signals.autoSide ? '2+ / OK' : '— / —'}</strong></div></div>
                <div className="signal-caveat"><Info size={12} /> Not a prediction. Order blocks, FVGs and sweeps are simplified heuristics.</div>
              </section>

              <section className="panel insight-panel">
                <div className="panel-heading insight-heading"><div className="insight-title"><Sparkles size={15} /><div><div className="panel-kicker">AI COMMENTARY</div><h2>Context, not commands</h2></div></div><span className={`ai-status ${config?.aiConfigured ? 'configured' : ''}`}><span className="status-dot" />{config?.aiConfigured ? 'READY' : 'OPTIONAL'}</span></div>
                <p>{aiText || 'Optional DeepSeek commentary explains the current signal snapshot. AI never places or approves orders.'}</p>
                <button className="ai-button" onClick={() => void askAi()} disabled={aiBusy || !price}><Sparkles size={13} /> {aiBusy ? 'Generating…' : 'Explain current setup'} <ArrowUpRight size={13} /></button>
              </section>
            </aside>
          </div>

          <footer className="page-footer"><span>MBOT <b>0.1.0</b> <span className="footer-dot">·</span> Market feed {lastUpdate ? `updated ${formatClock(lastUpdate)} UTC` : 'connecting'}</span><span><ShieldCheck size={12} /> No exchange order execution enabled in this build</span><a href="https://www.binance.com/en/terms" target="_blank" rel="noreferrer">Exchange terms <ExternalLink size={11} /></a></footer>
        </main>
      </div>

      {searchOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false) }}>
        <div className="market-modal" role="dialog" aria-modal="true" aria-label="Choose market">
          <div className="modal-head"><div><div className="panel-kicker">MARKETS</div><h2>Select a pair</h2></div><button className="icon-button" onClick={() => setSearchOpen(false)}><X size={17} /></button></div>
          <div className="search-box"><Search size={15} /><input autoFocus placeholder="Search coin or ticker" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} /><kbd>ESC</kbd></div>
          <div className="market-option-list">{matches.map((item) => <button className={`market-option ${symbol === item.symbol ? 'current' : ''}`} key={item.symbol} onClick={() => { setSymbol(item.symbol); setSearchOpen(false); setSearchTerm('') }}><div className="token-icon">{item.base.slice(0, 1)}</div><div className="market-option-name"><strong>{item.base}/USDT</strong><span>{item.name}</span></div><span className="market-option-live"><i /> Live market</span><ChevronDown size={14} /></button>)}{!matches.length && <div className="no-search-results">No listed pairs match your search.</div>}</div>
          <div className="modal-foot"><Info size={13} /> Public Binance spot candles are used in all modes, including paper mode.</div>
        </div>
      </div>}

      {showAccessModal && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAccessModal(false) }}>
        <div className="balance-modal" role="dialog" aria-modal="true" aria-label="Unlock read-only account access">
          <div className="modal-head"><div><div className="panel-kicker">LOCAL SECURITY</div><h2>Unlock read-only access</h2></div><button className="icon-button" onClick={() => setShowAccessModal(false)}><X size={17} /></button></div>
          <div className="modal-warning"><LockKeyhole size={16} /><span>Enter the local access token configured on the API server. It is kept in this tab's session storage and sent only to this app.</span></div>
          <label className="modal-label" htmlFor="local-access-token">Dashboard access token</label><div className="input-with-unit modal-input"><input id="local-access-token" type="password" autoComplete="off" value={accessTokenDraft} onChange={(event) => setAccessTokenDraft(event.target.value)} placeholder="Paste local token" /><span><EyeOff size={13} /></span></div>
          <div className="modal-actions"><button className="button button-outline" onClick={() => setShowAccessModal(false)}>Cancel</button>{accessToken && <button className="button button-outline" onClick={clearAccessToken}>Clear token</button>}<button className="button button-primary" onClick={saveAccessToken}>Unlock</button></div>
        </div>
      </div>}

      {showTestnetConfirm && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !testnetOrderBusy) setShowTestnetConfirm(false) }}>
        <div className="balance-modal" role="dialog" aria-modal="true" aria-label="Confirm Binance Spot Testnet order">
          <div className="modal-head"><div><div className="panel-kicker">BINANCE SPOT TESTNET</div><h2>Review market order</h2></div><button className="icon-button" onClick={() => setShowTestnetConfirm(false)} disabled={testnetOrderBusy}><X size={17} /></button></div>
          <div className="modal-warning testnet-warning"><ShieldCheck size={16} /><span>This submits to Binance Spot Testnet only. The server has no Mainnet order route. No stop-loss or take-profit is attached.</span></div>
          <div className="confirm-order-grid"><div><span>PAIR / SIDE</span><strong className={testnetSide === 'BUY' ? 'value-positive' : 'value-negative'}>{symbolInfo.base}/USDT · {testnetSide}</strong></div><div><span>ORDER TYPE</span><strong>Market</strong></div><div><span>QUOTE SIZE</span><strong>{formatMoney(orderSize)}</strong></div><div><span>REFERENCE PRICE</span><strong>{formatPrice(price)}</strong></div><div><span>EST. BASE QTY</span><strong>{price ? formatQuantity(orderSize / price) : '—'} {symbolInfo.base}</strong></div><div><span>SERVER CAP</span><strong>{formatMoney(testnetCap)}</strong></div></div>
          <div className="modal-actions"><button className="button button-outline" onClick={() => setShowTestnetConfirm(false)} disabled={testnetOrderBusy}>Cancel</button><button className={`button ${testnetSide === 'BUY' ? 'button-primary' : 'button-testnet-sell'}`} onClick={() => void submitTestnetOrder()} disabled={testnetOrderBusy}>{testnetOrderBusy ? <><RefreshCw size={13} className="spin" /> Sending…</> : <>Confirm Testnet {testnetSide}</>}</button></div>
        </div>
      </div>}

      {showBalanceEditor && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowBalanceEditor(false) }}>
        <div className="balance-modal" role="dialog" aria-modal="true" aria-label="Reset paper wallet">
          <div className="modal-head"><div><div className="panel-kicker">PAPER ACCOUNT</div><h2>Reset demo wallet</h2></div><button className="icon-button" onClick={() => setShowBalanceEditor(false)}><X size={17} /></button></div>
          <div className="modal-warning"><AlertTriangle size={16} /><span>This resets the local simulation history and balance. It never changes your Binance account.</span></div>
          <label className="modal-label" htmlFor="new-balance">Starting demo balance</label><div className="input-with-unit modal-input"><input id="new-balance" type="number" min="10" max="1000000" value={newBalance} onChange={(event) => setNewBalance(event.target.value)} /><span>USDT</span></div>
          <div className="modal-actions"><button className="button button-outline" onClick={() => setShowBalanceEditor(false)}>Cancel</button><button className="button button-primary" onClick={setPaperBalance}>Reset paper wallet</button></div>
        </div>
      </div>}

      {toast && <div className="toast-message"><span className="toast-icon"><Info size={14} /></span>{toast}<button onClick={() => setToast('')}><X size={14} /></button></div>}
    </div>
  )
}

export default App
