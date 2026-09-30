# MBOT Trading Terminal

A local, single-user trading dashboard. It reads live public Binance spot data,
draws Smart Money Concepts structure on the chart, and simulates execution in a
paper wallet you control.

**This is a paper-first monitoring and simulation tool. It is not an autonomous
live trading system, and it cannot make money for you.**

---

## Read this first

### Your API keys were exposed

Binance live keys, Binance Testnet keys, and an OpenRouter key were pasted into
a chat. **Treat all of them as permanently compromised.**

1. Go to <https://www.binance.com/en/my/settings/api-management>
2. Delete every key that was shared.
3. Create new keys. Never reuse a shared one.
4. Do the same for <https://openrouter.ai/keys>.

Nothing in this repository contains those keys, and the download feature
deliberately excludes `.env` from every archive it produces. But rotating the
keys is the only real fix — a leaked secret cannot be un-leaked.

### What this tool will not do

| Requested | Reality |
| --- | --- |
| 25% profit every day | Not achievable, not by this or any other software. Fees, spread, slippage, and latency all work against short-timeframe systems. |
| Never lose 10–11 times in a row | No rule, confirmation filter, or AI can prevent a losing streak. Martingale *causes* them. |
| AI that predicts the market | No model forecasts price. The AI panel here writes commentary; it cannot place an order. |
| A guaranteed profit | No such thing exists. Anyone promising one is running a scam. |
| Auto-trading real Binance money with martingale | Not implemented, deliberately. An automatic martingale against a real balance destroys accounts. |

The risk controls in this app (daily stop, trade cap, loss-run limit, order cap)
**limit** the damage from a losing run. They do not remove it.

---

## Run it

Requirements: **Node.js 20 or newer** and npm. A normal PC is enough; a faster
PC or a VPS will not make a strategy profitable.

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm run dev
```

Open <http://localhost:5173>. The API listens on port 3001 and Vite proxies
`/api` to it.

### Or take the whole thing with you

Click **Download project .zip** in the dashboard footer, or run:

```bash
node -e "import('./server/package-download.mjs').then(async m => { const r = await m.buildProjectZip(process.cwd()); require('fs').writeFileSync('mbot-terminal.zip', r.buffer); console.log('entries', r.fileCount) })"
```

Extract it anywhere and use the included launchers: `start-windows.bat` or
`start-mac-linux.sh`. They check for Node, create `.env` from the template, run
`npm install` once, and start the dashboard. The archive never contains `.env`,
`.git`, or `node_modules`.

Production build:

```bash
npm run build
npm start
```

---

## The terminal

Monospace, hairline borders, no gradients or blur, and no web fonts. Every
animation is a state change rather than a decoration, so the page stays cheap to
repaint while a one-minute candle ticks several times a second.

Layout: top status bar, icon rail, metric row, market toolbar, then a two-column
dashboard — chart and trade log on the left, controls, verdict, and signals on
the right.

---

## The SMC engine

`src/lib/smc.ts` is a self-contained analysis engine. It runs in about 1.2 ms
for 320 candles, so it re-evaluates on the live candle rather than only on the
close.

**Structure**
- Fractal swing points with a configurable strength filter.
- Break of structure and change of character, drawn from confirmed pivots only —
  a pivot is never used before `strength` bars have closed after it, so there is
  no look-ahead.
- Unswept buy-side and sell-side liquidity pools, clustered by relative distance,
  with a swept/not-swept flag and touch count.
- Sweeps with wick ratios.

**Zones**
- Order blocks found by walking back from each structural break to the last
  opposite-coloured candle, graded A/B/C by displacement in ATR, tracked as
  `fresh` / `tested` / `invalidated`, and invalidated by a close through them.
- Fair value gaps from three-candle gaps, filtered by ATR size, tracked as
  `open` / `partial` / `filled`.
- Zones further than 8 ATR from price are dropped, because a level you cannot
  reach is not a level you can trade.

**Patterns**
Ascending, descending and symmetrical triangles, rising and falling wedges,
channels, ranges, and scored double tops / bottoms. Each candidate must pass a
fit-quality threshold *and* a containment check — the fraction of bars that
actually respected both rails — so a regression line through four arbitrary
pivots cannot masquerade as a channel. A double top and a double bottom from the
same window are never shown together.

**Verdict**
The engine resolves to one explicit instruction, with a score out of 100 and a
visible checklist:

| Stance | Meaning |
| --- | --- |
| `BUY FROM HERE` | Price is inside a fresh bullish zone with confluence, stop and targets computed. |
| `SELL FROM HERE` | The bearish mirror. |
| `WAIT FOR CONFIRMATION HERE` | Price is in the zone but confluence is too weak, or the zone is already mitigated. |
| `WAIT FOR RETRACE` | The idea is valid but price has run away from the zone. |
| `NO TRADE` | No valid zone, or structure has no direction. |

A mitigated block or a partially filled gap can never produce `BUY FROM HERE` or
`SELL FROM HERE` — at most `WAIT FOR CONFIRMATION HERE`.

**Scenario path**
A dashed projection from the zone to the nearest unswept liquidity pool and then
the next one, with a stated confidence. It is a drawing of where liquidity
sits, not a prediction of where price goes. The panel says so.

---

## Chart

`lightweight-charts` renders candles and EMA 20. Everything else is drawn by
`src/components/SmcOverlay.tsx`, a device-pixel-ratio-aware canvas layered on top
that reads coordinates from the chart, so panning and zooming stay native.

Nine independent toggles: `BOS`, `OB`, `FVG`, `LIQ`, `SWEEP`, `PAT`, `PREM`,
`PATH`, `PLAN`, plus `EMA20`. A second row keeps the older marker layers.

The overlay draws order blocks with grade and mitigation state, gaps with fill
state, structure lines with BOS/CHoCH labels, liquidity rails with pool counts,
sweep arrows, pattern rails with quality and target lines, the dealing range with
premium/discount/equilibrium, the scenario path, and the verdict zone with stop
and take-profit levels.

---

## Trading modes

| Mode | Market data | Orders | Account |
| --- | --- | --- | --- |
| **Paper** | Live Binance | Simulated locally | Local wallet, editable starting balance |
| **Testnet** | Live Binance | Manual Spot Testnet only, optional, capped, off by default | Read-only unless enabled |
| **Live** | Live Binance | **None — no Mainnet order route exists** | Read-only balances |

The Futures selector changes the paper simulation only. It does not connect to
Binance Futures and does not model funding, liquidation, or slippage.

### Paper wallet controls

Entry strategy (SMC confluence, liquidity sweep, BOS/CHoCH, order-block retest,
FVG retest, 15-minute trend confirmation, filtered momentum scalp), sizing
strategy (fixed, martingale, anti-martingale), base order, multiplier, maximum
order, consecutive-loss limit, risk percentage, stop-loss and take-profit
percentage, daily stop and target, max trades per day, leverage, and trade
cooldown. Every field is clamped in code, and the caps are listed in the UI.

### Testnet orders

Disabled by default. To enable:

```dotenv
MBOT_ACCESS_TOKEN=<64 random hex characters>
ENABLE_TESTNET_ORDERS=true
MBOT_TESTNET_MAX_ORDER_USDT=25
```

Requires a fresh Testnet key with spot permission, a hard per-order cap of 50
USDT that cannot be raised in code, a confirmation dialog per order, and the
dashboard token. Orders are market orders; no stop-loss or take-profit is
attached and nothing is managed automatically.

---

## AI panel

Optional OpenRouter / DeepSeek commentary. It receives the pair, current quote,
timeframe, bias, and signal labels. It sends no exchange credentials, cannot
place orders, and cannot approve them. This is not MCP and it is not connected
to the trading loop.

---

## Environment

```dotenv
PORT=3001
MBOT_ACCESS_TOKEN=            # required for private routes and non-local downloads
BINANCE_LIVE_API_KEY=         # read-only account display
BINANCE_LIVE_SECRET_KEY=
BINANCE_TESTNET_API_KEY=      # testnet balances, and Spot orders if enabled
BINANCE_TESTNET_SECRET_KEY=
ENABLE_TESTNET_ORDERS=false
MBOT_TESTNET_MAX_ORDER_USDT=25
OPENROUTER_API_KEY=           # optional commentary only
OPENROUTER_MODEL=deepseek/deepseek-chat-v3-0324
```

Keys live only in the server-side `.env`, which is git-ignored. The browser
never receives a secret key. Keep withdrawals disabled. Keep Mainnet keys
read-only. Restrict keys by IP if the host has a stable public address.

Generate a token with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Tests

```bash
npm test      # 35 tests
npm run check # TypeScript
npm run build
```

Coverage: RSI/ATR, the scalp filter chain, all seven entry strategies, the
triangle detector, chart layer filtering, ZIP structure and CRC correctness,
archive secret exclusion, SMC pivots, structure look-ahead safety, FVG fill
states, order-block grading and invalidation, liquidity clustering and sweeps,
pattern classification, zone reachability, verdict self-consistency, and the
Testnet safety gates.

---

## Layout

```
server/
  index.mjs            Express API: market data, account reads, AI, package
  package-download.mjs Builds the downloadable archive, excludes secrets
  zip.mjs              Dependency-free ZIP writer
  testnet-orders.mjs   Gated, capped Spot Testnet market orders
src/
  App.tsx              Dashboard
  lib/market.ts        Indicators, entry strategies, marker generation
  lib/smc.ts           SMC engine: structure, zones, patterns, verdict
  components/
    SmcOverlay.tsx     Canvas layer for every SMC drawing
  styles.css           Terminal theme
test/                  node:test suites
```

---

## Risk notes

- **Martingale is the main way people lose everything.** After five losses a 3×
  multiplier has already committed 121× the base stake. The caps here bound it;
  the tail risk is unchanged.
- **One-minute entries are expensive.** Round-trip fees and spread consume a
  large share of a small target, and most apparent edge disappears after costs.
- **A cheap coin is not a cheap trade.** SHIB at $0.00001 is the same percentage
  move as BTC at $60,000. Unit price changes nothing. What matters is the
  exchange minimum notional, the quantity step size, and your quote balance.
- **Paper results are not live results.** Simulation has no partial fills,
  latency, rejection, disconnection, or liquidation.
- **This app cannot lose your Binance money** because it has no route to place a
  Mainnet order. Keep it that way until you have independently verified a
  strategy over a long period on Testnet and at real size.
- Do not trade money you cannot afford to lose.
