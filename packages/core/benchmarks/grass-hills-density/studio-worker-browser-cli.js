import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const outArgument = process.argv.find((argument) => argument.startsWith('--out='))
if (outArgument === undefined) throw new Error('--out=<JSON file> is required')

const root = process.cwd()
const vite = resolve(root, 'apps/studio/node_modules/.bin/vite')
if (!existsSync(vite)) {
  throw new Error('Studio dependencies are unavailable; use the existing locked workspace install')
}

const puppeteerEntry = resolve(
  process.env.PUPPETEER_MODULE ??
    '.claude/skills/chrome-devtools/scripts/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js',
)
if (!existsSync(puppeteerEntry)) {
  throw new Error(
    'Puppeteer is unavailable; point PUPPETEER_MODULE at the existing chrome-devtools skill package entry',
  )
}

const port = 4316
const url = `http://127.0.0.1:${port}/outline-worker-evidence.html`
const server = spawn(
  vite,
  [
    '--config',
    resolve(
      root,
      'packages/core/benchmarks/grass-hills-density/studio-worker.vite.config.js',
    ),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { cwd: resolve(root, 'apps/studio'), stdio: ['ignore', 'pipe', 'pipe'] },
)
let serverLog = ''
server.stdout.on('data', (chunk) => { serverLog += chunk })
server.stderr.on('data', (chunk) => { serverLog += chunk })

let browser
try {
  await waitForServer(url, server)
  const puppeteer = (await import(pathToFileURL(puppeteerEntry).href)).default
  browser = await puppeteer.launch({
    headless: true,
    ...(process.env.PUPPETEER_EXECUTABLE_PATH === undefined
      ? {}
      : { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
    args: ['--enable-precise-memory-info', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(600_000)
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForFunction(
    () => globalThis.__GRASS_HILLS_OUTLINE_WORKER_EVIDENCE__ !== undefined,
  )
  const evidence = await page.evaluate(() =>
    globalThis.__GRASS_HILLS_OUTLINE_WORKER_EVIDENCE__.runAll(),
  )
  writeFileSync(resolve(outArgument.slice('--out='.length)), `${JSON.stringify(evidence, null, 2)}\n`)
} catch (error) {
  if (serverLog.trim() !== '') process.stderr.write(serverLog)
  throw error
} finally {
  await browser?.close()
  if (server.exitCode === null) server.kill('SIGTERM')
  await Promise.race([
    new Promise((resolveExit) => server.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ])
}

async function waitForServer(target, child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Studio Vite server exited ${child.exitCode}`)
    }
    try {
      const response = await fetch(target)
      if (response.ok) return
    } catch {
      // The explicit deadline below owns startup failure reporting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('Timed out waiting for the Studio evidence page')
}
