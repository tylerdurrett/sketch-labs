import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const samplesArgument = process.argv.find((argument) =>
  argument.startsWith('--samples='),
)
const profileArgument = process.argv.find((argument) =>
  argument.startsWith('--profile='),
)
const profileCase =
  profileArgument === undefined
    ? null
    : profileArgument.slice('--profile='.length)
if (
  profileCase !== null &&
  profileCase !== 'flower' &&
  profileCase !== 'pinecone'
) {
  throw new Error('--profile must be flower or pinecone')
}
const samples =
  samplesArgument === undefined
    ? 3
    : Number(samplesArgument.slice('--samples='.length))
if (!Number.isSafeInteger(samples) || samples < 1) {
  throw new Error('--samples must be an integer >= 1')
}

const root = process.cwd()
const vite = resolve(root, 'apps/studio/node_modules/.bin/vite')
if (!existsSync(vite)) {
  throw new Error('Use the existing locked Studio install')
}
const localPuppeteer = resolve(
  root,
  '.claude/skills/chrome-devtools/scripts/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js',
)
const worktreePuppeteer = resolve(
  root,
  '../../.claude/skills/chrome-devtools/scripts/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js',
)
const puppeteerEntry = resolve(
  process.env.PUPPETEER_MODULE ??
    (existsSync(localPuppeteer) ? localPuppeteer : worktreePuppeteer),
)
if (!existsSync(puppeteerEntry)) {
  throw new Error(
    'Puppeteer is unavailable; set PUPPETEER_MODULE to the existing chrome-devtools package entry',
  )
}

const config = resolve(
  root,
  'packages/core/benchmarks/flowing-contours-browser/vite.config.js',
)
await run(
  vite,
  ['build', '--config', config],
  resolve(root, 'apps/studio'),
  profileCase === null ? {} : { FLOWING_CONTOURS_PROFILE: '1' },
)

const port = 4318
const url = `http://127.0.0.1:${port}/`
const server = spawn(
  vite,
  [
    'preview',
    '--config',
    config,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { cwd: resolve(root, 'apps/studio'), stdio: ['ignore', 'pipe', 'pipe'] },
)
let serverLog = ''
server.stdout.on('data', (chunk) => {
  serverLog += chunk
})
server.stderr.on('data', (chunk) => {
  serverLog += chunk
})

let browser
try {
  await waitForServer(url, server)
  const puppeteer = (await import(pathToFileURL(puppeteerEntry).href)).default
  browser = await puppeteer.launch({
    headless: true,
    ...(process.env.PUPPETEER_EXECUTABLE_PATH === undefined
      ? {}
      : { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
    args: ['--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(1_800_000)
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForFunction(
    () => globalThis.__FLOWING_CONTOURS_BROWSER_PERFORMANCE__ !== undefined,
  )
  let evidence
  if (profileCase === null) {
    evidence = await page.evaluate(
      async (sampleCount) =>
        globalThis.__FLOWING_CONTOURS_BROWSER_PERFORMANCE__.runAll(sampleCount),
      samples,
    )
  } else {
    const session = await page.createCDPSession()
    await session.send('Profiler.enable')
    await session.send('Profiler.setSamplingInterval', { interval: 1000 })
    await session.send('Profiler.start')
    const observation = await page.evaluate(
      async (caseName) =>
        globalThis.__FLOWING_CONTOURS_BROWSER_PERFORMANCE__.runOne(caseName),
      profileCase,
    )
    const { profile } = await session.send('Profiler.stop')
    await session.detach()
    evidence = {
      machine: await page.evaluate(
        () => globalThis.__FLOWING_CONTOURS_BROWSER_PERFORMANCE__.machine,
      ),
      profileCase,
      observation,
      cpuProfile: summarizeCpuProfile(profile),
    }
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
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

async function run(command, args, cwd, extraEnvironment) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnvironment },
  })
  const exitCode = await new Promise((resolveExit) =>
    child.once('exit', resolveExit),
  )
  if (exitCode !== 0) throw new Error(`${command} exited ${exitCode}`)
}

async function waitForServer(target, child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite preview exited ${child.exitCode}`)
    }
    try {
      const response = await fetch(target)
      if (response.ok) return
    } catch {
      // The explicit deadline below owns startup failure reporting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('Timed out waiting for the browser performance fixture')
}

function summarizeCpuProfile(profile) {
  const totalMicroseconds = profile.timeDeltas.reduce(
    (sum, delta) => sum + delta,
    0,
  )
  const totalHits = profile.nodes.reduce(
    (sum, node) => sum + (node.hitCount ?? 0),
    0,
  )
  return {
    durationMs: totalMicroseconds / 1000,
    sampledHitCount: totalHits,
    topSelfTime: profile.nodes
      .filter((node) => (node.hitCount ?? 0) > 0)
      .map((node) => ({
        functionName: node.callFrame.functionName || '(anonymous)',
        url: node.callFrame.url,
        lineNumber: node.callFrame.lineNumber + 1,
        hitCount: node.hitCount,
        approximateSelfMs:
          totalHits === 0
            ? 0
            : ((node.hitCount ?? 0) / totalHits) * (totalMicroseconds / 1000),
      }))
      .sort((left, right) => right.hitCount - left.hitCount)
      .slice(0, 25),
  }
}
