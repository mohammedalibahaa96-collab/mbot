import crypto from 'node:crypto'

const TESTNET_SPOT = 'https://testnet.binance.vision'
const SYMBOL_ALLOWLIST = new Set(['SHIBUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DGBUSDT'])

function badRequest(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function decimalPlaces(value) {
  const text = String(value)
  return (text.split('.')[1] || '').replace(/0+$/, '').length
}

function floorToStep(value, step) {
  const precision = Math.min(12, decimalPlaces(step))
  return Number((Math.floor((value + step * 1e-10) / step) * step).toFixed(precision))
}

function orderCapFromEnv() {
  const configured = Number(process.env.MBOT_TESTNET_MAX_ORDER_USDT || 25)
  return Number.isFinite(configured) ? Math.min(50, Math.max(1, configured)) : 25
}

export function registerTestnetOrderRoute(app, { binanceJson, publicBase, configured, hasValidLocalToken }) {
  app.post('/api/testnet/order', async (req, res, next) => {
    try {
      if (process.env.ENABLE_TESTNET_ORDERS !== 'true') {
        return res.status(403).json({ error: 'Testnet order placement is disabled. Set ENABLE_TESTNET_ORDERS=true on the API server to enable manual test orders.' })
      }
      if (!configured('testnet')) return res.status(503).json({ error: 'Fresh Binance Spot Testnet API keys are not configured on this server.' })
      if (!process.env.MBOT_ACCESS_TOKEN) return res.status(503).json({ error: 'Set MBOT_ACCESS_TOKEN on the server before enabling testnet orders.' })
      if (!hasValidLocalToken(req)) return res.status(401).json({ error: 'Enter the local dashboard access token to place a testnet order.' })

      const symbol = String(req.body?.symbol || '').toUpperCase()
      const side = String(req.body?.side || '').toUpperCase()
      const requestedQuoteQty = Number(req.body?.quoteOrderQty)
      if (!SYMBOL_ALLOWLIST.has(symbol)) throw badRequest('This symbol is not on the testnet allowlist.')
      if (side !== 'BUY' && side !== 'SELL') throw badRequest('Only manual Spot Testnet BUY and SELL market orders are supported.')
      if (!Number.isFinite(requestedQuoteQty) || requestedQuoteQty <= 0) throw badRequest('Enter a positive order size in USDT.')
      const quoteOrderQty = Math.floor((requestedQuoteQty + 1e-10) * 100) / 100
      if (quoteOrderQty <= 0) throw badRequest('Order size must be at least 0.01 USDT.')

      const cap = orderCapFromEnv()
      if (quoteOrderQty > cap) throw badRequest(`Testnet order exceeds the server cap of ${cap} USDT.`)

      const info = await binanceJson(`${TESTNET_SPOT}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`)
      const market = info.symbols?.[0]
      if (!market || market.status !== 'TRADING') throw badRequest(`${symbol} is not trading on Binance Spot Testnet.`)
      if (market.quoteAsset !== 'USDT') throw badRequest('Only USDT-quoted testnet symbols are allowed.')
      if (market.quoteOrderQtyMarketAllowed === false) throw badRequest('This symbol does not support quote-sized market orders on Testnet.')

      const filters = Object.fromEntries((market.filters || []).map((filter) => [filter.filterType, filter]))
      const notionalFilter = filters.NOTIONAL || filters.MIN_NOTIONAL
      const minNotional = Number(notionalFilter?.minNotional || 0)
      if (quoteOrderQty < minNotional) throw badRequest(`Order is below the Testnet minimum notional of ${minNotional} USDT.`)

      const { key, secret } = {
        key: process.env.BINANCE_TESTNET_API_KEY,
        secret: process.env.BINANCE_TESTNET_SECRET_KEY,
      }
      const signedGet = async (endpoint) => {
        const params = new URLSearchParams({ recvWindow: '5000', timestamp: String(Date.now()) })
        const signature = crypto.createHmac('sha256', secret).update(params.toString()).digest('hex')
        return binanceJson(`${TESTNET_SPOT}${endpoint}?${params.toString()}&signature=${signature}`, {
          headers: { 'X-MBX-APIKEY': key },
        })
      }
      const account = await signedGet('/api/v3/account')
      const balances = Object.fromEntries((account.balances || []).map((balance) => [balance.asset, Number(balance.free || 0)]))
      if (side === 'BUY' && quoteOrderQty > (balances[market.quoteAsset] || 0)) {
        throw badRequest(`Insufficient Testnet ${market.quoteAsset} balance for this BUY.`)
      }

      if (side === 'SELL') {
        const priceData = await binanceJson(`${publicBase()}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`)
        const livePrice = Number(priceData.price)
        if (!Number.isFinite(livePrice) || livePrice <= 0) throw badRequest('Could not obtain a current reference price to validate the Testnet SELL size.')
        const estimatedBaseQty = quoteOrderQty / livePrice
        const lotFilter = Number(filters.MARKET_LOT_SIZE?.stepSize) > 0 ? filters.MARKET_LOT_SIZE : filters.LOT_SIZE
        const stepSize = Number(lotFilter?.stepSize || 0)
        const minQty = Number(lotFilter?.minQty || 0)
        const alignedQty = stepSize > 0 ? floorToStep(estimatedBaseQty, stepSize) : estimatedBaseQty
        if (alignedQty < minQty) throw badRequest(`Estimated sell quantity is below the Testnet minimum quantity (${minQty}).`)
        if (alignedQty > (balances[market.baseAsset] || 0)) throw badRequest(`Insufficient Testnet ${market.baseAsset} balance for this SELL.`)
      }

      const params = new URLSearchParams({
        symbol,
        side,
        type: 'MARKET',
        quoteOrderQty: quoteOrderQty.toFixed(2),
        recvWindow: '5000',
        timestamp: String(Date.now()),
      })
      const signature = crypto.createHmac('sha256', secret).update(params.toString()).digest('hex')
      params.set('signature', signature)
      const result = await binanceJson(`${TESTNET_SPOT}/api/v3/order`, {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': key, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      })
      const executedQty = Number(result.executedQty || 0)
      const quoteQty = Number(result.cummulativeQuoteQty || 0)
      const fillPrice = executedQty > 0 ? quoteQty / executedQty : 0
      res.status(201).json({
        testnet: true,
        symbol: result.symbol || symbol,
        orderId: result.orderId,
        clientOrderId: result.clientOrderId,
        side: result.side || side,
        type: result.type || 'MARKET',
        status: result.status || 'UNKNOWN',
        executedQty,
        quoteQty,
        averagePrice: fillPrice,
        submittedAt: Number(result.transactTime || Date.now()),
        cappedAtUsdt: cap,
      })
    } catch (error) {
      next(error)
    }
  })
}
