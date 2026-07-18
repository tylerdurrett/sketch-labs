import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CampaignOperationError } from './campaign-runner.js'

const STARTUP_TIMEOUT_MS = 30_000
const ABORT_CLEANUP_TIMEOUT_MS = 2_000

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

async function raceOperation(operation, { page, timeoutMs, signal, label }) {
  let timer
  let abortListener
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CampaignOperationError(
      'job-timeout', `${label} exceeded the frozen ${timeoutMs} ms timeout`,
    )), timeoutMs)
  })
  const aborted = new Promise((_, reject) => {
    if (signal === undefined) return
    abortListener = () => reject(new CampaignOperationError(
      'campaign-aborted', `${label} was aborted`,
    ))
    signal.addEventListener('abort', abortListener, { once: true })
  })
  try {
    return await Promise.race([operation, timeout, aborted])
  } catch (error) {
    if (error instanceof CampaignOperationError) {
      operation.catch(() => {})
      await Promise.race([
        page.evaluate(() => globalThis.__PHOTO_SCRIBBLE_EVIDENCE__?.abortActive()).catch(() => false),
        delay(ABORT_CLEANUP_TIMEOUT_MS),
      ])
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener)
  }
}

export function createBrowserBoundary({
  serverFactory,
  browserFactory,
  url,
  fetchImpl = fetch,
}) {
  let server = null
  let browser = null

  async function startBrowser() {
    browser = await browserFactory()
  }

  async function closeBrowser() {
    const current = browser
    browser = null
    await current?.close().catch(() => {})
  }

  return {
    async start() {
      server = await serverFactory()
      const deadline = Date.now() + STARTUP_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (server.exitCode !== null) {
          throw new Error(`Studio Vite server exited ${server.exitCode}`)
        }
        try {
          const response = await fetchImpl(url)
          if (response.ok) break
        } catch {
          // The fixed startup deadline owns reporting.
        }
        await delay(100)
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the Studio evidence page')
      await startBrowser()
    },

    async runJob({ job, rightsEvidence, timeoutMs, reviewEnvironment, signal }) {
      if (browser === null || browser.isConnected?.() === false) {
        throw new CampaignOperationError('browser-lost', 'Browser is unavailable before job start')
      }
      const page = await browser.newPage()
      const partial = {}
      try {
        await page.setViewport({
          width: reviewEnvironment.viewportWidth,
          height: reviewEnvironment.viewportHeight,
          deviceScaleFactor: reviewEnvironment.deviceScaleFactor,
        })
        page.setDefaultTimeout(timeoutMs)
        await page.goto(url, { waitUntil: 'networkidle0' })
        await page.waitForFunction(
          () => globalThis.__PHOTO_SCRIBBLE_EVIDENCE__ !== undefined,
        )
        partial.runtime = await page.evaluate(() => ({
          userAgent: navigator.userAgent,
          platform: navigator.platform,
        }))
        partial.equivalence = await raceOperation(
          page.evaluate(
            ({ scenarioId, rightsEvidence: evidence }) =>
              globalThis.__PHOTO_SCRIBBLE_EVIDENCE__.runExactEquivalence(
                scenarioId, { rightsEvidence: evidence },
              ),
            { scenarioId: job.scenarioId, rightsEvidence },
          ),
          { page, timeoutMs, signal, label: 'Production tuple equivalence proof' },
        )
        if (!partial.equivalence.identityHashMatches ||
          !partial.equivalence.productionResolverSelectedTuple ||
          !partial.equivalence.sceneHashMatches ||
          !partial.equivalence.diagnosticsHashMatches) {
          throw new CampaignOperationError(
            'equivalence-proof-failed',
            'Production/injected tuple equivalence proof did not match',
            partial,
          )
        }
        partial.observation = await raceOperation(
          page.evaluate(
            ({ scenarioId, candidateId, rightsEvidence: evidence }) =>
              globalThis.__PHOTO_SCRIBBLE_EVIDENCE__.runCandidate(
                scenarioId, candidateId, { rightsEvidence: evidence },
              ),
            { scenarioId: job.scenarioId, candidateId: job.candidateId, rightsEvidence },
          ),
          { page, timeoutMs, signal, label: 'Candidate measurement' },
        )
        return partial
      } catch (error) {
        if (error instanceof CampaignOperationError && Object.keys(error.partial).length === 0) {
          throw new CampaignOperationError(error.kind, error.message, partial)
        }
        if (!(error instanceof CampaignOperationError) &&
          error !== null && typeof error === 'object') {
          error.partial = partial
        }
        throw error
      } finally {
        await page.evaluate(() => globalThis.__PHOTO_SCRIBBLE_EVIDENCE__?.abortActive()).catch(() => false)
        await page.close().catch(() => {})
      }
    },

    async restartBrowser() {
      await closeBrowser()
      await startBrowser()
    },

    async close() {
      await closeBrowser()
      if (server?.exitCode === null) server.kill('SIGTERM')
      if (server !== null) {
        await Promise.race([
          new Promise((done) => server.once('exit', done)),
          delay(ABORT_CLEANUP_TIMEOUT_MS),
        ])
      }
      server = null
    },
  }
}

export async function createDefaultBrowserBoundary(root, port = 4318) {
  const vite = resolve(root, 'apps/studio/node_modules/.bin/vite')
  if (!existsSync(vite)) throw new Error('Use the existing locked Studio install')
  const puppeteerEntry = resolve(
    process.env.PUPPETEER_MODULE ??
      '.claude/skills/chrome-devtools/scripts/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js',
  )
  if (!existsSync(puppeteerEntry)) {
    throw new Error('Set PUPPETEER_MODULE to an existing Puppeteer entry')
  }
  const puppeteer = (await import(pathToFileURL(puppeteerEntry).href)).default
  const url = `http://127.0.0.1:${port}/photo-scribble-evidence.html`
  return createBrowserBoundary({
    url,
    serverFactory: async () => spawn(vite, [
      '--config',
      resolve(root, 'packages/core/benchmarks/photo-scribble/studio-worker.vite.config.ts'),
      '--host', '127.0.0.1', '--port', String(port), '--strictPort',
    ], {
      cwd: resolve(root, 'apps/studio'),
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    browserFactory: () => puppeteer.launch({
      headless: true,
      ...(process.env.PUPPETEER_EXECUTABLE_PATH === undefined
        ? {}
        : { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
      args: ['--enable-precise-memory-info', '--disable-dev-shm-usage'],
    }),
  })
}
