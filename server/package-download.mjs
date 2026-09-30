import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createZip } from './zip.mjs'

/**
 * Builds a runnable copy of the project so the user can download one archive,
 * extract it, run the launcher and be on the dashboard.
 *
 * Secrets are never included: `.env`, `.env.*` and anything that looks like a
 * credential file is skipped, and `.git` / `node_modules` / `dist` are skipped
 * so the archive stays small.
 */

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage', '.scratch', '.vite', '.cache'])
// `.env.example` is the empty template and ships; every other dotenv file may
// hold a real key, so it never leaves the machine.
const SKIP_FILE = /^(?:\.env|\.env\.(?!example$).*|\.DS_Store|.*\.log|.*\.tsbuildinfo|.*\.pem|.*\.key)$/i
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_FILES = 1500

const EXTRA_FILES = [
  { name: 'START-HERE.md', mode: 0o100644 },
  { name: 'start-windows.bat', mode: 0o100644 },
  { name: 'start-mac-linux.sh', mode: 0o100755 },
]

const START_HERE = `# MBOT — start here

This archive is the whole project. It is not a build: you run it from source.

## 1. Install Node.js 20 or newer

Download the LTS installer from https://nodejs.org and run it. Check it worked
by opening a terminal and typing:

    node -v
    npm -v

## 2. Unzip and install

    cd mbot-terminal
    npm install

## 3. Add your Binance keys (optional)

    cp .env.example .env        (Windows: copy .env.example .env)

Open \`.env\` in any text editor and paste your keys. This file stays on your
computer. It is never sent to a website and never included in a download.

> If a Binance key was ever pasted into a chat, screenshot, or shared file,
> revoke it in the Binance app first and create a new one. A leaked key must be
> treated as permanently compromised.

## 4. Run

    Windows        double-click  start-windows.bat
    macOS / Linux  ./start-mac-linux.sh

Then open the URL it prints, normally http://localhost:5173

## What runs where

- The dashboard is a local web app. It is not published anywhere.
- Market data is read from the public Binance REST and WebSocket endpoints.
- Paper trading is simulated in your browser and stored in local storage.
- The API server holds your keys. The browser never receives a secret key.
- **Live Binance account mode is read-only.** There is no Mainnet order route in
  this build. Spot Testnet orders are manual, optional, capped, and off by
  default.

## Honest expectations

- No bot can guarantee a profit, and no AI can predict the market.
- Martingale sizing grows the next order after a loss. A long losing streak will
  exhaust the balance; the caps in this app limit the damage, they do not remove
  the risk.
- 25% per day is not a realistic target. Fees, spread, slippage and latency all
  work against a short-timeframe system.
- The Smart Money Concepts drawings are rule-based readings of closed candles.
  They can be wrong. Treat "BUY FROM HERE" as a checklist to evaluate, not an
  instruction.

Start in Paper mode. Only move to Testnet once you trust what you are seeing.
`

const START_WINDOWS = `@echo off
setlocal
title MBOT Trading Terminal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js 20 or newer is required and was not found.
  echo   Install it from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist ".env" copy ".env.example" ".env" >nul
if not exist "node_modules" (
  echo Installing dependencies. This runs once and takes a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo.
echo   MBOT is starting. Open http://localhost:5173
echo   Press Ctrl+C to stop.
echo.
start "" http://localhost:5173
call npm run dev
pause
`

const START_POSIX = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js 20 or newer is required and was not found."
  echo "  Install it from https://nodejs.org and run this script again."
  echo
  exit 1
fi

[ -f .env ] || cp .env.example .env

if [ ! -d node_modules ]; then
  echo "Installing dependencies. This runs once and takes a minute..."
  npm install
fi

echo
echo "  MBOT is starting. Open http://localhost:5173"
echo "  Press Ctrl+C to stop."
echo
( sleep 2; command -v xdg-open >/dev/null 2>&1 && xdg-open http://localhost:5173 || open http://localhost:5173 || true ) &
exec npm run dev
`

async function collectFiles(root) {
  const files = []
  async function walk(directory, relative) {
    if (files.length >= MAX_FILES) return
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_FILES) return
      const absolute = path.join(directory, entry.name)
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        await walk(absolute, name)
        continue
      }
      if (!entry.isFile()) continue
      if (SKIP_FILE.test(entry.name)) continue
      const stats = await fs.stat(absolute)
      if (stats.size > MAX_FILE_BYTES) continue
      files.push({ absolute, name, mtime: stats.mtime })
    }
  }
  await walk(root, '')
  return files
}

/** @returns {Promise<{buffer: Buffer, fileCount: number, skipped: string[]}>} */
export async function buildProjectZip(root) {
  const files = await collectFiles(root)
  const entries = []
  const included = new Set(files.map((file) => file.name))

  entries.push({ name: 'START-HERE.md', data: Buffer.from(START_HERE, 'utf8'), mode: 0o100644 })
  entries.push({ name: 'start-windows.bat', data: Buffer.from(START_WINDOWS, 'utf8'), mode: 0o100644 })
  entries.push({ name: 'start-mac-linux.sh', data: Buffer.from(START_POSIX, 'utf8'), mode: 0o100755 })

  for (const file of files) {
    if (EXTRA_FILES.some((extra) => extra.name === file.name)) continue
    entries.push({
      name: `mbot-terminal/${file.name}`,
      data: await fs.readFile(file.absolute),
      mtime: file.mtime,
      mode: file.name.endsWith('.sh') ? 0o100755 : 0o100644,
    })
  }

  const buffer = createZip(entries)
  return {
    buffer,
    fileCount: entries.length,
    skipped: ['.env', 'node_modules/', '.git/', 'dist/'].filter((name) => !included.has(name.replace(/\/$/, ''))),
  }
}

export function packageFileName(version) {
  const safe = String(version || '0.1.0').replace(/[^a-zA-Z0-9.-]/g, '')
  return `mbot-terminal-${safe}.zip`
}

export function packageEtag(buffer) {
  return `"${createHash('sha256').update(buffer).digest('hex').slice(0, 16)}"`
}
