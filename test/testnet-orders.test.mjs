import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTestnetOrderRoute } from '../server/testnet-orders.mjs'

function setTestEnv(values) {
  const previous = new Map()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function makeHarness({ binanceJson = async () => { throw new Error('Unexpected upstream request') }, configured = () => true } = {}) {
  let handler
  registerTestnetOrderRoute({ post: (_path, routeHandler) => { handler = routeHandler } }, {
    binanceJson,
    publicBase: () => 'https://api.binance.com',
    configured,
    hasValidLocalToken: (req) => req.token === 'test-access-token',
  })
  return async (body, token = 'test-access-token') => {
    let status = 200
    let payload
    let forwardedError
    const res = {
      status(code) { status = code; return this },
      json(value) { payload = value; return this },
    }
    await handler({ body, token }, res, (error) => { forwardedError = error })
    if (forwardedError) {
      status = Number(forwardedError.status) || 502
      payload = { error: forwardedError.message }
    }
    return { status, payload, forwardedError }
  }
}

function mockExchange() {
  const calls = []
  const binanceJson = async (url, options = {}) => {
    calls.push({ url, options })
    if (url.includes('/api/v3/exchangeInfo')) {
      return { symbols: [{
        symbol: 'SHIBUSDT', status: 'TRADING', baseAsset: 'SHIB', quoteAsset: 'USDT', quoteOrderQtyMarketAllowed: true,
        filters: [
          { filterType: 'NOTIONAL', minNotional: '1' },
          { filterType: 'LOT_SIZE', minQty: '1', maxQty: '999999999', stepSize: '1' },
        ],
      }] }
    }
    if (url.includes('/api/v3/account')) return { balances: [{ asset: 'USDT', free: '100' }, { asset: 'SHIB', free: '500000' }] }
    if (url.includes('/api/v3/ticker/price')) return { symbol: 'SHIBUSDT', price: '0.00002' }
    if (url.endsWith('/api/v3/order')) return {
      symbol: 'SHIBUSDT', orderId: 789, clientOrderId: 'test-client-id', side: 'BUY', type: 'MARKET', status: 'FILLED',
      executedQty: '617000', cummulativeQuoteQty: '12.34', transactTime: 1700000000000,
    }
    throw new Error(`Unexpected URL ${url}`)
  }
  return { calls, binanceJson }
}

test('Testnet order route is disabled by default', async () => {
  const restore = setTestEnv({ ENABLE_TESTNET_ORDERS: 'false' })
  try {
    const invoke = makeHarness()
    const result = await invoke({ symbol: 'SHIBUSDT', side: 'BUY', quoteOrderQty: 10 })
    assert.equal(result.status, 403)
    assert.match(result.payload.error, /disabled/i)
  } finally { restore() }
})

test('Testnet order route requires the local access token', async () => {
  const restore = setTestEnv({ ENABLE_TESTNET_ORDERS: 'true', BINANCE_TESTNET_API_KEY: 'test-key', BINANCE_TESTNET_SECRET_KEY: 'test-secret', MBOT_ACCESS_TOKEN: 'test-access-token' })
  try {
    const { calls, binanceJson } = mockExchange()
    const invoke = makeHarness({ binanceJson })
    const result = await invoke({ symbol: 'SHIBUSDT', side: 'BUY', quoteOrderQty: 10 }, 'wrong-token')
    assert.equal(result.status, 401)
    assert.equal(calls.length, 0)
  } finally { restore() }
})

test('Testnet BUY is capped, rounded down, and sent only to Spot Testnet', async () => {
  const restore = setTestEnv({ ENABLE_TESTNET_ORDERS: 'true', BINANCE_TESTNET_API_KEY: 'test-key', BINANCE_TESTNET_SECRET_KEY: 'test-secret', MBOT_ACCESS_TOKEN: 'test-access-token', MBOT_TESTNET_MAX_ORDER_USDT: '100' })
  try {
    const { calls, binanceJson } = mockExchange()
    const invoke = makeHarness({ binanceJson })
    const result = await invoke({ symbol: 'SHIBUSDT', side: 'BUY', quoteOrderQty: 12.349 })
    assert.equal(result.status, 201)
    assert.equal(result.payload.testnet, true)
    assert.equal(result.payload.status, 'FILLED')
    assert.equal(result.payload.quoteQty, 12.34)
    assert.ok(calls.every((call) => call.url.startsWith('https://testnet.binance.vision')))
    const orderCall = calls.find((call) => call.url.endsWith('/api/v3/order'))
    assert.equal(orderCall.options.method, 'POST')
    assert.match(orderCall.options.body, /quoteOrderQty=12.34/)
  } finally { restore() }
})

test('server cap cannot be configured above 50 USDT', async () => {
  const restore = setTestEnv({ ENABLE_TESTNET_ORDERS: 'true', BINANCE_TESTNET_API_KEY: 'test-key', BINANCE_TESTNET_SECRET_KEY: 'test-secret', MBOT_ACCESS_TOKEN: 'test-access-token', MBOT_TESTNET_MAX_ORDER_USDT: '1000' })
  try {
    const { calls, binanceJson } = mockExchange()
    const invoke = makeHarness({ binanceJson })
    const result = await invoke({ symbol: 'SHIBUSDT', side: 'BUY', quoteOrderQty: 50.01 })
    assert.equal(result.status, 400)
    assert.match(result.payload.error, /50 USDT/)
    assert.equal(calls.length, 0)
  } finally { restore() }
})

test('Testnet SELL checks the free base balance and has no Mainnet order route', async () => {
  const restore = setTestEnv({ ENABLE_TESTNET_ORDERS: 'true', BINANCE_TESTNET_API_KEY: 'test-key', BINANCE_TESTNET_SECRET_KEY: 'test-secret', MBOT_ACCESS_TOKEN: 'test-access-token' })
  try {
    const { calls, binanceJson } = mockExchange()
    const invoke = makeHarness({ binanceJson })
    const result = await invoke({ symbol: 'SHIBUSDT', side: 'SELL', quoteOrderQty: 5 })
    assert.equal(result.status, 201)
    assert.ok(calls.some((call) => call.url.startsWith('https://api.binance.com/api/v3/ticker/price')))
    assert.ok(calls.filter((call) => call.url.endsWith('/api/v3/order')).every((call) => call.url.startsWith('https://testnet.binance.vision')))
  } finally { restore() }
})
