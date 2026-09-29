# MBOT Trading Terminal

A paper-first desktop-style trading dashboard with live public Binance spot market data. The current build is intentionally a **monitoring and simulation prototype**, not an autonomous live trading system.

## Security first

API credentials were exposed in the project request. Treat the Binance live, Binance testnet, and OpenRouter keys as compromised: revoke/rotate them in their provider dashboards before using this project. Do not reuse the pasted values. Never enable withdrawals on a Binance API key. Mainnet account keys should remain read-only. Testnet trade permission, if deliberately enabled, must belong to a fresh Testnet-only key and cannot access real funds.

Secrets belong in a server-side `.env` file on the computer running the API. They are never embedded into Vite/browser code and the API only reports whether credentials are configured. `.env` is git-ignored.

## What is implemented

- Binance public ticker/candlestick feed for SHIB, BTC, ETH, SOL, BNB, and DGB against USDT; selectable 1m, 5m, 15m, and 1h intervals. WebSocket is the live path, reconnects with backoff, and REST polling backs it up every 15 seconds when disconnected. The UI shows feed status and freshness.
- A compact terminal theme and incremental chart updates for live candles; account balances refresh automatically every 15 seconds and retain the last successful snapshot during refresh.
- EMA 20 plus independent chart-layer toggles for BOS/CHoCH, order blocks, FVGs, liquidity sweeps, and triangles. OB/FVG zones render as bounded chart rails; ascending, descending, and symmetrical triangle candidates draw two fitted rails and a breakout marker. This is simplified pivot-based technical analysis—not exact or guaranteed pattern recognition, and it can produce false positives.
- Six selectable Paper entry rules: SMC confluence, liquidity-sweep reversal, BOS/CHoCH continuation, order-block retest, FVG retest, and 15-minute trend with two candle confirmations. Each uses closed candles and the 15-minute direction/confirmation filter; signals can be absent or wrong and are not guarantees.
- Local paper wallet with editable starting USDT balance, simulated spot/futures positions, basic fees, stop-loss/take-profit monitoring, trade history with per-trade time, configurable bot trade cooldown (1–60 seconds/minutes), CSV export, and capped strategy controls.
- Terminal-style runtime console for feed connection/retry, paper entries/exits, bot controls, safety pauses, and Testnet order results.
- Optional server-side, advisory-only OpenRouter/DeepSeek commentary. It cannot submit an order.
- Optional read-only live/testnet account balance display, if configured on the server.
- Optional **manual Spot Testnet-only** market orders behind an explicit server flag, local access token, hard per-order cap, and a confirmation dialog. Disabled by default; no automated testnet orders.

## Explicitly not implemented

- No Binance Mainnet order-placement endpoint and no autonomous real-money trading.
- Live account mode is read-only. Testnet order submission is Spot-only, manual, optional, and disabled unless explicitly enabled in the server `.env`; Binance Futures Testnet orders are not implemented.
- No guarantee of profitability, predictive AI, or reliable identification of every order block/FVG/triangle.
- The futures selector only changes the **paper simulation**. It does not connect to Binance Futures or model funding, liquidation, slippage, or all exchange rules.
- AI commentary is not MCP and cannot control the bot. It is optional natural-language context only.

## Run locally

Requirements: Node.js 20+ and npm. A typical always-on PC is sufficient for this dashboard; live trading uptime and risk are separate concerns. A VPS, UPS, or faster PC cannot make a strategy profitable or prevent exchange/network failures.

```bash
npm install
cp .env.example .env
npm run dev
```

Open the Vite URL shown by the terminal (normally `http://localhost:5173`). The API runs on port 3001. In development, Vite proxies `/api` to the API server. For a production build, run:

```bash
npm run build
npm start
```

Run the SMC entry-rule and Testnet safety-gate tests with `npm test`.

If market data is unavailable in your region, check network access to `api.binance.com`. The paper ledger is stored in this browser's local storage and does not sync across devices. Use **Reset demo wallet** to change its starting balance; this does not change exchange funds.

## Optional read-only account display

Copy `.env.example` to `.env`. Before enabling account/AI routes, create a strong local access token, for example with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, and set it along with new keys created after rotating the exposed ones:

```dotenv
MBOT_ACCESS_TOKEN=use-a-new-random-64-character-value
BINANCE_LIVE_API_KEY=...
BINANCE_LIVE_SECRET_KEY=...
BINANCE_TESTNET_API_KEY=...
BINANCE_TESTNET_SECRET_KEY=...
ENABLE_TESTNET_ORDERS=false
MBOT_TESTNET_MAX_ORDER_USDT=25
```

To enable **manual Spot Testnet only**, set `ENABLE_TESTNET_ORDERS=true`, use a fresh Testnet key with spot trading permission, and restart the server. The per-order cap defaults to 25 USDT and is hard-limited to 50 USDT in code. A confirmation dialog is required for each order. There is no Mainnet route; Testnet orders do not attach stop-loss/take-profit orders and are not automatically managed. Enter `MBOT_ACCESS_TOKEN` in the dashboard unlock dialog to read private account data or use AI commentary. It is held in session storage for that browser tab and sent only to this app. Without the server token, private balance and paid AI routes stay locked. Do not host this prototype on a public server without additional authentication and HTTPS.

Recommended Binance setup:

1. Create separate keys for dashboard read access and any future order service.
2. Keep withdrawals disabled. Keep Mainnet permissions read-only. Only if you intentionally enable the optional Spot Testnet feature, use a separate Testnet key with spot trading permission; never reuse a Mainnet key.
3. Restrict access with an IP allowlist when the host has a stable public IP. Never expose a private key in a web page, screenshot, chat, Git commit, or browser local storage.
4. Select Live or Testnet in the dashboard to request balances. Testnet balance endpoints use Binance Spot Testnet or Futures Testnet as appropriate.
5. Revoke any key you no longer need. Treat a leaked secret as permanently compromised.

`OPENROUTER_API_KEY` and `OPENROUTER_MODEL` are optional. The AI panel only sends the selected pair, current quote, timeframe, 15m bias, and signal labels to the configured provider; it sends no exchange credentials and cannot place trades. Rotate the key previously shared before configuring this option.

## Risk notes

- Martingale sizing is bounded in the demo and the bot pauses at configured safety limits, but a cap does not remove the strategy's tail risk. A losing streak can exhaust available capital; a sequence of losses cannot be prevented by AI or a confirmation rule.
- A target such as 25% every day is not a realistic or guaranteed expectation. Fees, spread, slippage, latency, and market regime can make short-timeframe systems unprofitable.
- A low unit price (for example, SHIB) does not make a trade cheaper in percentage terms. Exchange minimum notional, quantity step size, fees, and quote-currency balance determine whether an order is possible.
- Do not use money you cannot afford to lose. Paper results do not establish live profitability.
