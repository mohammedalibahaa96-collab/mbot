import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildProjectZip, packageFileName } from '../server/package-download.mjs'
import { createZip, crc32 } from '../server/zip.mjs'

const run = promisify(execFile)
const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50

function listEntries(buffer) {
  const entries = []
  let offset = 0
  while (offset < buffer.length - 3 && buffer.readUInt32LE(offset) === LOCAL_SIGNATURE) {
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength)
    const dataStart = offset + 30 + nameLength + extraLength
    entries.push({ name, data: buffer.subarray(dataStart, dataStart + compressedSize) })
    offset = dataStart + compressedSize
  }
  return { entries, offset }
}

test('crc32 matches the known reference value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
  assert.equal(crc32(Buffer.alloc(0)), 0)
})

test('createZip writes a structurally valid archive', () => {
  const zip = createZip([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'dir/b.txt', data: Buffer.from('world') },
  ])
  assert.equal(zip.readUInt32LE(0), LOCAL_SIGNATURE)
  assert.equal(zip.readUInt32LE(zip.length - 22), END_SIGNATURE)

  const { entries, offset } = listEntries(zip)
  assert.deepEqual(entries.map((entry) => entry.name), ['a.txt', 'dir/b.txt'])
  assert.equal(entries[0].data.toString(), 'hello')
  assert.equal(entries[1].data.toString(), 'world')

  const end = zip.readUInt32LE(zip.length - 22)
  assert.equal(end, END_SIGNATURE)
  assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 2, 'entry count in the end record')

  // The central directory must start exactly where the local entries stopped.
  assert.equal(zip.readUInt32LE(offset), CENTRAL_SIGNATURE)
  const centralSize = zip.readUInt32LE(zip.length - 22 + 12)
  assert.equal(offset + centralSize, zip.length - 22, 'central directory length must be consistent')
})

test('every entry records the crc of its own bytes', () => {
  const payload = Buffer.from('the quick brown fox jumps over the lazy dog')
  const zip = createZip([{ name: 'x.bin', data: payload }])
  const { entries } = listEntries(zip)
  assert.equal(crc32(entries[0].data), crc32(payload))
  const storedCrc = zip.readUInt32LE(14)
  assert.equal(storedCrc, crc32(payload))
})

test('a real unzip agrees with our reader', async () => {
  const zip = createZip([
    { name: 'one.txt', data: Buffer.from('first file') },
    { name: 'nested/two.txt', data: Buffer.from('second file') },
  ])
  const dir = await mkdtemp(path.join(tmpdir(), 'mbot-zip-'))
  const file = path.join(dir, 'out.zip')
  await writeFile(file, zip)
  const { stdout } = await run('python3', ['-c', [
    'import zipfile,sys',
    'z=zipfile.ZipFile(sys.argv[1])',
    'assert z.testzip() is None',
    'print("|".join(f"{n}:{z.read(n).decode()}" for n in sorted(z.namelist())))',
  ].join('\n'), file])
  assert.equal(stdout.trim(), 'nested/two.txt:second file|one.txt:first file')
})

test('the project archive carries the launchers and excludes secrets', async () => {
  const root = path.resolve(new URL('..', import.meta.url).pathname)
  const { buffer } = await buildProjectZip(root)
  const { entries } = listEntries(buffer)
  const names = entries.map((entry) => entry.name)

  assert.ok(names.includes('START-HERE.md'))
  assert.ok(names.includes('start-windows.bat'))
  assert.ok(names.includes('start-mac-linux.sh'))
  assert.ok(names.includes('mbot-terminal/package.json'))
  assert.ok(names.includes('mbot-terminal/src/lib/smc.ts'))
  assert.ok(names.includes('mbot-terminal/.env.example'), 'the blank template must ship')

  // A populated .env must never be packed, even if the user has one on disk.
  const envName = 'mbot-terminal/.env'
  assert.ok(!names.includes(envName), '.env must never be included')
  const secretish = /(^|\/)\.env\.(?!example$)/i
  assert.ok(!names.some((name) => secretish.test(name)), 'no dotenv variant may be included')
  assert.ok(!names.some((name) => name.includes('node_modules/')), 'node_modules must be excluded')
  assert.ok(!names.some((name) => name.includes('/.git/')), '.git must be excluded')

  const readme = entries.find((entry) => entry.name === 'START-HERE.md').data.toString()
  assert.match(readme, /npm install/)
  assert.match(readme, /revoke it in the Binance app first/i)
  assert.match(readme, /read-only/i)
})

test('a stray .env on disk is skipped, and .env.example is kept', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mbot-secret-'))
  await mkdir(path.join(dir, 'node_modules', 'left-pad'), { recursive: true })
  await mkdir(path.join(dir, '.git'), { recursive: true })
  await writeFile(path.join(dir, '.env'), 'BINANCE_LIVE_SECRET_KEY=super-secret-value\n')
  await writeFile(path.join(dir, '.env.example'), 'BINANCE_LIVE_SECRET_KEY=\n')
  await writeFile(path.join(dir, '.env.local'), 'TOKEN=nope\n')
  await writeFile(path.join(dir, 'id_rsa.pem'), 'PRIVATE KEY\n')
  await writeFile(path.join(dir, 'index.js'), 'console.log(1)\n')
  await writeFile(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n')
  await writeFile(path.join(dir, '.git', 'config'), '[core]\n')

  const { buffer } = await buildProjectZip(dir)
  const { entries } = listEntries(buffer)
  const names = entries.map((entry) => entry.name)
  const blob = Buffer.concat(entries.map((entry) => entry.data)).toString('utf8')

  assert.ok(!blob.includes('super-secret-value'), 'the secret value must not appear anywhere in the archive')
  assert.ok(!names.some((name) => name.endsWith('.env')))
  assert.ok(!names.some((name) => name.endsWith('.env.local')))
  assert.ok(!names.some((name) => name.endsWith('.pem')))
  assert.ok(!names.some((name) => name.includes('node_modules')))
  assert.ok(!names.some((name) => name.includes('.git/')))
  assert.ok(names.includes('mbot-terminal/.env.example'))
  assert.ok(names.includes('mbot-terminal/index.js'))
})

test('packageFileName sanitises the version string', () => {
  assert.equal(packageFileName('0.1.0'), 'mbot-terminal-0.1.0.zip')
  assert.equal(packageFileName('../../etc/passwd'), 'mbot-terminal-....etcpasswd.zip')
  assert.equal(packageFileName(undefined), 'mbot-terminal-0.1.0.zip')
})
