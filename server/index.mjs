import 'dotenv/config'
import crypto from 'node:crypto'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerTestnetOrderRoute } from './testnet-orders.mjs'

const app = express()
const PORT = Number(process.env.PORT || 3001)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.argv.includes('--production')

app.disable('x-powered-by')
app.use(express.json({ limit: '24kb' }))
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  next()
})

const INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d'])
const SYMBOL_RE = /^[A-Z0-9]{5,20}$/
const requestTimeout = () => AbortSignal.timeout(9000)

async function binanceJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || requestTimeout() })
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { msg: 'Exchange returned an unreadable response.' }
  }
  if (!response.ok) {
    const message = typeof payload?.msg === 'string' ? payload.msg : `Exchange request failed (${response.status}).`
    const error = new Error(message)
    error.status = response.status
    error.exchangeCode = payload?.code
    throw error
  }
  return payload
}

function publicBase() {
  return (process.env.BINANCE_PUBLIC_BASE_URL || 'https://api.binance.com').replace(/\/$/, '')
}

function checkSymbol(value) {
  const symbol = String(value || '').toUpperCase()
  if (!SYMBOL_RE.test(symbol)) throw Object.assign(new Error('Invalid market symbol.'), { status: 400 })
  return symbol
}

function configured(mode) {
  return mode === 'testnet'
    ? Boolean(process.env.BINANCE_TESTNET_API_KEY && process.env.BINANCE_TESTNET_SECRET_KEY)
    : Boolean(process.env.BINANCE_LIVE_API_KEY && process.env.BINANCE_LIVE_SECRET_KEY)
}

function hasValidLocalToken(req) {
  const expected = Buffer.from(process.env.MBOT_ACCESS_TOKEN || '')
  const supplied = Buffer.from(String(req.get('X-MBOT-Access-Token') || ''))
  return expected.length > 0 && supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied)
}

function credentials(mode) {
  return mode === 'testnet'
    ? { key: process.env.BINANCE_TESTNET_API_KEY, secret: process.env.BINANCE_TESTNET_SECRET_KEY }
    : { key: process.env.BINANCE_LIVE_API_KEY, secret: process.env.BINANCE_LIVE_SECRET_KEY }
}

function signedQuery(secret, params) {
  const query = new URLSearchParams(params).toString()
  const signature = crypto.createHmac('sha256', secret).update(query).digest('hex')
  return `${query}&signature=${signature}`
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'mbot', mode: 'paper-first' })
})

app.get('/api/config', (_req, res) => {
  res.json({
    liveAccountConfigured: configured('live'),
    testnetAccountConfigured: configured('testnet'),
    testnetOrdersEnabled: process.env.ENABLE_TESTNET_ORDERS === 'true',
    testnetOrderCapUsdt: Math.min(50, Math.max(1, Number(process.env.MBOT_TESTNET_MAX_ORDER_USDT || 25) || 25)),
    aiConfigured: Boolean(process.env.OPENROUTER_API_KEY),
    accountAuthRequired: true,
    accountAccessConfigured: Boolean(process.env.MBOT_ACCESS_TOKEN),
    execution: 'disabled',
  })
})

app.get('/api/market/klines', async (req, res, next) => {
  try {
    const symbol = checkSymbol(req.query.symbol || 'SHIBUSDT')
    const interval = String(req.query.interval || '1m')
    if (!INTERVALS.has(interval)) return res.status(400).json({ error: 'Unsupported candle interval.' })
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || '240'), 10) || 240, 20), 1000)
    const query = new URLSearchParams({ symbol, interval, limit: String(limit) })
    const raw = await binanceJson(`${publicBase()}/api/v3/klines?${query}`)
    const candles = raw.map((row) => ({
      time: Math.floor(Number(row[0]) / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
    }))
    res.setHeader('Cache-Control', 'no-store')
    res.json({ symbol, interval, candles })
  } catch (error) {
    next(error)
  }
})

app.get('/api/market/ticker', async (req, res, next) => {
  try {
    const symbol = checkSymbol(req.query.symbol || 'SHIBUSDT')
    const data = await binanceJson(`${publicBase()}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`)
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      symbol: data.symbol,
      lastPrice: Number(data.lastPrice),
      priceChange: Number(data.priceChange),
      priceChangePercent: Number(data.priceChangePercent),
      highPrice: Number(data.highPrice),
      lowPrice: Number(data.lowPrice),
      volume: Number(data.volume),
      quoteVolume: Number(data.quoteVolume),
      count: Number(data.count),
      closeTime: Number(data.closeTime),
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/market/rules', async (req, res, next) => {
  try {
    const symbol = checkSymbol(req.query.symbol || 'SHIBUSDT')
    const query = new URLSearchParams({ symbol })
    const data = await binanceJson(`${publicBase()}/api/v3/exchangeInfo?${query}`)
    const record = data.symbols?.[0]
    if (!record) return res.status(404).json({ error: `No spot trading rules found for ${symbol}.` })
    const filters = Object.fromEntries((record.filters || []).map((filter) => [filter.filterType, filter]))
    const marketLot = filters.MARKET_LOT_SIZE
    const lot = marketLot && Number(marketLot.stepSize) > 0 ? marketLot : filters.LOT_SIZE
    const notional = filters.NOTIONAL || filters.MIN_NOTIONAL
    res.json({
      symbol: record.symbol,
      status: record.status,
      baseAsset: record.baseAsset,
      quoteAsset: record.quoteAsset,
      minQty: Number(lot?.minQty || 0),
      maxQty: Number(lot?.maxQty || 0),
      stepSize: Number(lot?.stepSize || 0),
      minNotional: Number(notional?.minNotional || 0),
      tickSize: Number(filters.PRICE_FILTER?.tickSize || 0),
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/account', async (req, res, next) => {
  try {
    const mode = req.query.mode === 'testnet' ? 'testnet' : 'live'
    const market = req.query.market === 'futures' ? 'futures' : 'spot'
    if (!configured(mode)) {
      return res.json({ configured: false, mode, market, balances: [], message: 'Read-only API credentials are not configured on this server.' })
    }
    if (!process.env.MBOT_ACCESS_TOKEN) return res.status(503).json({ error: 'Set MBOT_ACCESS_TOKEN on the server before exposing account balances.' })
    if (!hasValidLocalToken(req)) return res.status(401).json({ error: 'Enter the local dashboard access token to view account balances.' })
    const { key, secret } = credentials(mode)
    const timestamp = Date.now()
    const query = signedQuery(secret, { recvWindow: '5000', timestamp: String(timestamp) })
    const root = mode === 'testnet'
      ? (market === 'futures' ? 'https://testnet.binancefuture.com' : 'https://testnet.binance.vision')
      : (market === 'futures' ? 'https://fapi.binance.com' : 'https://api.binance.com')
    const endpoint = market === 'futures' ? '/fapi/v2/account' : '/api/v3/account'
    const data = await binanceJson(`${root}${endpoint}?${query}`, {
      headers: { 'X-MBX-APIKEY': key },
    })
    const balances = market === 'futures'
      ? (data.assets || []).map((asset) => ({
          asset: asset.asset,
          free: Number(asset.availableBalance || 0),
          locked: Math.max(Number(asset.walletBalance || 0) - Number(asset.availableBalance || 0), 0),
          walletBalance: Number(asset.walletBalance || 0),
          unrealizedProfit: Number(asset.unrealizedProfit || 0),
        })).filter((asset) => asset.walletBalance !== 0 || asset.unrealizedProfit !== 0)
      : (data.balances || []).map((asset) => ({
          asset: asset.asset,
          free: Number(asset.free || 0),
          locked: Number(asset.locked || 0),
        })).filter((asset) => asset.free !== 0 || asset.locked !== 0)
    res.setHeader('Cache-Control', 'no-store')
    res.json({ configured: true, mode, market, canTrade: false, balances, updateTime: Date.now() })
  } catch (error) {
    next(error)
  }
})

registerTestnetOrderRoute(app, { binanceJson, publicBase, configured, hasValidLocalToken })

app.post('/api/ai/insight', async (req, res, next) => {
  try {
    if (!process.env.MBOT_ACCESS_TOKEN) return res.status(503).json({ error: 'Set MBOT_ACCESS_TOKEN on the server before enabling paid AI commentary.' })
    if (!hasValidLocalToken(req)) return res.status(401).json({ error: 'Enter the local dashboard access token to use AI commentary.' })
    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(503).json({ error: 'AI commentary is not configured. The local dashboard remains fully usable.' })
    }
    const body = req.body || {}
    const symbol = checkSymbol(body.symbol || 'SHIBUSDT')
    const context = {
      interval: INTERVALS.has(String(body.interval)) ? body.interval : '1m',
      price: Number.isFinite(Number(body.price)) ? Number(body.price) : null,
      trend15m: ['up', 'down', 'neutral'].includes(body.trend15m) ? body.trend15m : 'neutral',
      signal: String(body.signal || 'No confirmed setup').slice(0, 180),
      riskNote: 'Paper-trading context only. Do not forecast certainty or issue execution instructions.',
    }
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost',
        'X-Title': 'MBOT Advisory Panel',
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3-0324',
        temperature: 0.2,
        max_tokens: 180,
        messages: [
          { role: 'system', content: 'You are a cautious market-structure explainer, not an execution agent. Explain uncertainty and risk in plain language. Never claim prediction or guaranteed profit. Do not provide instructions to place an order. Keep the answer under 100 words.' },
          { role: 'user', content: `Explain this dashboard snapshot without making a price prediction: ${JSON.stringify({ symbol, ...context })}` },
        ],
      }),
      signal: requestTimeout(),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(payload?.error?.message || 'AI provider request failed.')
      error.status = response.status
      throw error
    }
    const text = payload?.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new Error('AI provider returned no commentary.')
    res.json({ text: text.slice(0, 1200), model: payload.model || process.env.OPENROUTER_MODEL || 'DeepSeek' })
  } catch (error) {
    next(error)
  }
})

// Mainnet order placement is never exposed. The isolated Spot Testnet route is manually gated and capped.
if (IS_PRODUCTION) {
  app.use(express.static(path.join(ROOT, 'dist'), { index: false, maxAge: '1h' }))
  app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'dist', 'index.html')))
}

app.use((error, _req, res, _next) => {
  const status = Number(error.status) || 502
  if (status >= 500 && error.message !== 'fetch failed') console.error('[api]', error.message)
  res.status(status).json({
    error: status === 429
      ? 'Binance rate limit reached. Wait before retrying.'
      : status >= 500 && !String(error.message || '').includes('Invalid API-key')
        ? (error.message || 'Upstream service is unavailable.')
        : error.message || 'Request failed.',
    exchangeCode: error.exchangeCode,
  })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MBOT API listening on 0.0.0.0:${PORT} (${IS_PRODUCTION ? 'production' : 'development'})`)
})
