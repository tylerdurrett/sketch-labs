import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  extname,
  join,
  normalize,
  resolve,
} from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const FLOWER_ASSET = 'img-0672-79d639daec62'
const PINECONE_ASSET = 'pinecone-4330aa0314f7'
const ORACLE_PREFIX = '/__flowing-contours-worker-oracle/'
const DEFAULT_TIMEOUT_MS = 180_000
const root = fileURLToPath(new URL('../../../', import.meta.url))

const options = parseArguments(process.argv.slice(2))
if (options.help) {
  process.stdout.write(`${usage()}\n`)
  process.exit(0)
}
if (options.dryRun) {
  process.stdout.write(
    `${JSON.stringify(
      {
        mode:
          options.studioUrl === null
            ? 'build-and-serve-production'
            : 'external-production-urls',
        samplesPerWorkload: options.samples,
        completionSamplesPerWorkload: 1,
        studioUrl: options.studioUrl,
        oracleUrl: options.oracleUrl,
        requestedPort: options.port,
        output: options.out,
        vite: options.vite,
        puppeteerModule: options.puppeteerModule,
        chrome: options.chrome,
      },
      null,
      2,
    )}\n`,
  )
  process.exit(0)
}

const puppeteerEntry = resolvePuppeteerEntry(options.puppeteerModule)
const puppeteer = (await import(pathToFileURL(puppeteerEntry).href)).default
let temporaryRoot = null
let productionServer = null
let browser

try {
  let studioUrl = options.studioUrl
  let oracleUrl = options.oracleUrl
  if (studioUrl === null || oracleUrl === null) {
    const vite = resolveExecutable(
      options.vite,
      [
        'apps/studio/node_modules/.bin/vite',
        'node_modules/.bin/vite',
      ],
      'Vite is unavailable; pass --vite=<path> or use the locked Studio install',
    )
    temporaryRoot = mkdtempSync(
      join(tmpdir(), 'flowing-contours-worker-benchmark-'),
    )
    const studioOut = join(temporaryRoot, 'studio')
    const oracleOut = join(temporaryRoot, 'oracle')
    await run(
      vite,
      [
        'build',
        '--config',
        resolve(
          root,
          'packages/core/benchmarks/flowing-contours-studio-worker/studio.vite.config.js',
        ),
      ],
      resolve(root, 'apps/studio'),
      { FLOWING_CONTOURS_WORKER_STUDIO_OUT: studioOut },
    )
    await run(
      vite,
      [
        'build',
        '--config',
        resolve(
          root,
          'packages/core/benchmarks/flowing-contours-studio-worker/oracle.vite.config.js',
        ),
      ],
      resolve(root, 'apps/studio'),
      { FLOWING_CONTOURS_WORKER_ORACLE_OUT: oracleOut },
    )
    productionServer = await startProductionServer({
      studioOut,
      oracleOut,
      imageAssetsRoot: resolve(root, 'assets/image-assets'),
      port: options.port,
    })
    studioUrl = `${productionServer.origin}/`
    oracleUrl = `${productionServer.origin}${ORACLE_PREFIX}`
  }

  browser = await puppeteer.launch({
    headless: true,
    ...(options.chrome === null
      ? {}
      : { executablePath: resolve(options.chrome) }),
    args: ['--disable-dev-shm-usage'],
  })
  const evidence = await measure({
    browser,
    studioUrl,
    oracleUrl,
    samples: options.samples,
  })
  validateEvidence(evidence, options.samples)
  writeFileSync(
    resolve(options.out),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
  process.stdout.write(`${JSON.stringify(summarize(evidence), null, 2)}\n`)
} finally {
  await browser?.close()
  await productionServer?.close()
  if (temporaryRoot !== null) {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

async function measure({
  browser,
  studioUrl,
  oracleUrl,
  samples,
}) {
  const page = await browser.newPage()
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS)
  const consoleMessages = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleMessages.push({
        type: message.type(),
        text: message.text(),
      })
    }
  })
  page.on('pageerror', (error) => {
    consoleMessages.push({ type: 'pageerror', text: error.message })
  })
  await installInstrumentation(page)
  await page.goto(studioUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(
    'input[aria-label="curveDetail slider"]',
  )

  await selectImageAsset(page, 'img 0672')
  await waitForRequest(page, FLOWER_ASSET, null, 0)
  const flowerStartRequestCount = await requestCount(page)
  const flowerEdits = []
  for (let index = 1; index <= samples; index += 1) {
    const detail = Number((1 + index / 100).toFixed(2))
    flowerEdits.push(await measureCurveDetailEdit(page, detail))
    await waitForRequest(
      page,
      FLOWER_ASSET,
      detail,
      flowerStartRequestCount,
    )
  }
  const flowerPendingGate = await uiSnapshot(page)
  const flowerDetail = Number((1 + samples / 100).toFixed(2))
  const flower = await waitForCompletedCase(
    page,
    FLOWER_ASSET,
    flowerDetail,
  )
  const flowerCurrentGate = await uiSnapshot(page)

  const oraclePage = await browser.newPage()
  oraclePage.setDefaultTimeout(DEFAULT_TIMEOUT_MS)
  await oraclePage.goto(oracleUrl, { waitUntil: 'networkidle0' })
  await oraclePage.waitForFunction(
    () => globalThis.__FLOWING_CONTOURS_SYNC_ORACLE__ !== undefined,
  )
  const flowerOracle = await oraclePage.evaluate(
    (identity) => globalThis.__FLOWING_CONTOURS_SYNC_ORACLE__(identity),
    flower.identity,
  )

  const pineconeSelection = await selectImageAsset(page, 'pinecone')
  await waitForRequest(page, PINECONE_ASSET, null, 0)
  const pineconeStaleGate = await uiSnapshot(page)
  const pineconeStartRequestCount = await requestCount(page)
  const pineconeEdits = []
  for (let index = 1; index <= samples; index += 1) {
    const detail = Number(
      (1 + (samples + index) / 100).toFixed(2),
    )
    pineconeEdits.push(await measureCurveDetailEdit(page, detail))
    await waitForRequest(
      page,
      PINECONE_ASSET,
      detail,
      pineconeStartRequestCount,
    )
  }
  const pineconePendingGate = await uiSnapshot(page)
  const pineconeDetail = Number(
    (1 + (samples * 2) / 100).toFixed(2),
  )
  const pinecone = await waitForCompletedCase(
    page,
    PINECONE_ASSET,
    pineconeDetail,
  )
  const pineconeCurrentGate = await uiSnapshot(page)
  const pineconeOracle = await oraclePage.evaluate(
    (identity) => globalThis.__FLOWING_CONTOURS_SYNC_ORACLE__(identity),
    pinecone.identity,
  )

  const machine = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    platform: navigator.userAgentData?.platform ?? navigator.platform,
    logicalCpuCount: navigator.hardwareConcurrency ?? null,
    deviceMemoryGiB: navigator.deviceMemory ?? null,
    devicePixelRatio,
  }))
  const trace = await page.evaluate(() => {
    const instrumentation =
      globalThis.__FLOWING_CONTOURS_WORKER_BENCHMARK__
    return {
      requests: instrumentation.requests.map(
        ({ workerId, postedAt, value }) => ({
          workerId,
          postedAt,
          jobId: value.jobId,
          identity: value.identity,
        }),
      ),
      responses: instrumentation.responses.map(
        ({ workerId, receivedAt, value }) => ({
          workerId,
          receivedAt,
          type: value.type,
          jobId: value.jobId,
          identity: value.identity,
          computeTimeMs: value.computeTimeMs ?? null,
        }),
      ),
      terminations: instrumentation.terminations,
      longTasks: instrumentation.longTasks,
    }
  })

  await oraclePage.close()
  await page.close()
  return Object.freeze({
    methodology: Object.freeze({
      productionStudio: true,
      responsivenessSamplesPerWorkload: samples,
      completionSamplesPerWorkload: 1,
      handler:
        'document capture timestamp at each real Base UI Curve-detail ArrowRight keydown to a queueMicrotask timestamp after its synchronous handler',
      heartbeat:
        '50 ms setTimeout scheduled at keydown capture; reported value is lateness beyond the 50 ms target',
      longTasks:
        'PerformanceObserver longtask entries overlapping each edit observation or the final request-to-paint window',
      percentile:
        'nearest-rank percentile; with n=3, p95 is the largest raw observation',
      completion:
        'final worker request post to terminal response, worker-reported computeTimeMs, then current/paint acknowledgement',
    }),
    urls: Object.freeze({ studioUrl, oracleUrl }),
    machine,
    flower: caseEvidence({
      edits: flowerEdits,
      pendingGate: flowerPendingGate,
      currentGate: flowerCurrentGate,
      completion: flower,
      oracle: flowerOracle,
    }),
    pinecone: {
      ...caseEvidence({
        edits: pineconeEdits,
        pendingGate: pineconePendingGate,
        currentGate: pineconeCurrentGate,
        completion: pinecone,
        oracle: pineconeOracle,
      }),
      selection: pineconeSelection,
      staleGate: pineconeStaleGate,
    },
    cancellation: cancellationEvidence(trace),
    trace,
    consoleMessages,
  })
}

function caseEvidence({
  edits,
  pendingGate,
  currentGate,
  completion,
  oracle,
}) {
  return Object.freeze({
    edits,
    handlerMs: statistics(edits.map(({ handlerMs }) => handlerMs)),
    heartbeatDelayMs: statistics(
      edits.map(({ heartbeatDelayMs }) => heartbeatDelayMs),
    ),
    editLongTaskMaxMs: statistics(
      edits.map(({ longTasks }) =>
        Math.max(0, ...longTasks.map(({ duration }) => duration)),
      ),
    ),
    pendingGate,
    currentGate,
    completion,
    oracle,
    parity: Object.freeze({
      sceneChecksum:
        completion.sceneChecksum === oracle.sceneChecksum,
      primitiveCount:
        completion.primitiveCount === oracle.primitiveCount,
      pointCount: completion.pointCount === oracle.pointCount,
    }),
  })
}

async function installInstrumentation(page) {
  await page.evaluateOnNewDocument(() => {
    const instrumentation = {
      nextWorkerId: 1,
      requests: [],
      responses: [],
      terminations: [],
      longTasks: [],
      editProbe: null,
    }
    globalThis.__FLOWING_CONTOURS_WORKER_BENCHMARK__ = instrumentation

    const NativeWorker = globalThis.Worker
    globalThis.Worker = class InstrumentedWorker extends NativeWorker {
      constructor(url, options) {
        super(url, options)
        this.__flowingWorkerId = instrumentation.nextWorkerId++
        this.__flowingWorkerUrl = String(url)
        if (this.__flowingWorkerUrl.includes('flowingContoursWorker')) {
          this.addEventListener('message', (event) => {
            const value = event.data
            if (
              value !== null &&
              typeof value === 'object' &&
              (value.type === 'success' || value.type === 'failure')
            ) {
              instrumentation.responses.push({
                workerId: this.__flowingWorkerId,
                receivedAt: performance.now(),
                value: structuredClone(value),
              })
            }
          })
        }
      }

      postMessage(message, transferOrOptions) {
        if (
          this.__flowingWorkerUrl.includes('flowingContoursWorker') &&
          message !== null &&
          typeof message === 'object' &&
          message.type === 'compute'
        ) {
          instrumentation.requests.push({
            workerId: this.__flowingWorkerId,
            postedAt: performance.now(),
            value: structuredClone(message),
          })
        }
        if (transferOrOptions === undefined) return super.postMessage(message)
        return super.postMessage(message, transferOrOptions)
      }

      terminate() {
        if (this.__flowingWorkerUrl.includes('flowingContoursWorker')) {
          instrumentation.terminations.push({
            workerId: this.__flowingWorkerId,
            terminatedAt: performance.now(),
          })
        }
        return super.terminate()
      }
    }

    if (
      typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes.includes('longtask')
    ) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          instrumentation.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          })
        }
      })
      observer.observe({ type: 'longtask', buffered: true })
    }
  })
}

async function measureCurveDetailEdit(page, detail) {
  await page.evaluate((nextDetail) => {
    const instrumentation =
      globalThis.__FLOWING_CONTOURS_WORKER_BENCHMARK__
    const input = document.querySelector(
      'input[aria-label="curveDetail slider"]',
    )
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('curveDetail slider missing')
    }
    const probe = {
      curveDetail: nextDetail,
      scheduledAt: performance.now(),
      longTaskStartIndex: instrumentation.longTasks.length,
      handlerStartedAt: null,
      handlerEndedAt: null,
      heartbeatDelayMs: null,
    }
    instrumentation.editProbe = probe
    const onKeyDownCapture = (event) => {
      if (event.key !== 'ArrowRight') return
      document.removeEventListener('keydown', onKeyDownCapture, true)
      probe.handlerStartedAt = performance.now()
      const heartbeatTarget = probe.handlerStartedAt + 50
      setTimeout(() => {
        probe.heartbeatDelayMs = performance.now() - heartbeatTarget
      }, 50)
      queueMicrotask(() => {
        probe.handlerEndedAt = performance.now()
      })
    }
    document.addEventListener('keydown', onKeyDownCapture, true)
  }, detail)
  await page.focus('input[aria-label="curveDetail slider"]')
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(
    () => {
      const probe =
        globalThis.__FLOWING_CONTOURS_WORKER_BENCHMARK__.editProbe
      return (
        probe?.handlerEndedAt !== null &&
        probe?.heartbeatDelayMs !== null
      )
    },
    { polling: 5, timeout: 10_000 },
  )
  const observation = await page.evaluate(async () => {
    const instrumentation =
      globalThis.__FLOWING_CONTOURS_WORKER_BENCHMARK__
    const probe = instrumentation.editProbe
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0))
    const observedUntil = performance.now()
    const numberInput = document.querySelector('#control-curveDetail')
    return Object.freeze({
      curveDetail: probe.curveDetail,
      actualNumberValue:
        numberInput instanceof HTMLInputElement
          ? Number(numberInput.value)
          : null,
      scheduledAt: probe.scheduledAt,
      handlerStartedAt: probe.handlerStartedAt,
      handlerEndedAt: probe.handlerEndedAt,
      handlerMs: probe.handlerEndedAt - probe.handlerStartedAt,
      heartbeatDelayMs: probe.heartbeatDelayMs,
      longTasks: instrumentation.longTasks
        .slice(probe.longTaskStartIndex)
        .filter(
          (entry) =>
            entry.startTime < observedUntil &&
            entry.startTime + entry.duration >= probe.scheduledAt,
        ),
    })
  })
  return Object.freeze({
    ...observation,
    gateAfterHeartbeat: await uiSnapshot(page),
  })
}

async function waitForCompletedCase(page, asset, curveDetail) {
  await page.waitForFunction(
    ({ assetId, detail }) =>
      globalThis.__FLOWING_CONTOURS_WORKER_BENCHMARK__.responses.some(
        ({ value }) => {
          const params = Object.fromEntries(
            value.identity.params.map(({ key, value: item }) => [key, item]),
          )
          return (
            params.imageAsset === assetId &&
            params.curveDetail === detail
          )
        },
      ),
    { polling: 10, timeout: DEFAULT_TIMEOUT_MS },
    { assetId: asset, detail: curveDetail },
  )
  const terminal = await page.evaluate(
    ({ assetId, detail }) =>
      globalThis.__FLOWING_CONTOURS_WORKER_BENCHMARK__.responses
        .filter(({ value }) => {
          const params = Object.fromEntries(
            value.identity.params.map(({ key, value: item }) => [key, item]),
          )
          return (
            params.imageAsset === assetId &&
            params.curveDetail === detail
          )
        })
        .at(-1)?.value,
    { assetId: asset, detail: curveDetail },
  )
  if (terminal?.type !== 'success') {
    throw new Error(
      `worker terminal failure: ${terminal?.error ?? 'missing response'}`,
    )
  }
  await page.waitForFunction(
    () =>
      document
        .querySelector('.canvas-region')
        ?.getAttribute('data-flowing-contours-preparation') === 'current',
    { polling: 10, timeout: 30_000 },
  )
  await page.waitForFunction(
    () => {
      const exportButton = [...document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Export SVG',
      )
      return exportButton !== undefined && !exportButton.disabled
    },
    { polling: 10, timeout: 30_000 },
  )

  return page.evaluate(async ({ assetId, detail }) => {
    const instrumentation =
      globalThis.__FLOWING_CONTOURS_WORKER_BENCHMARK__
    const response = instrumentation.responses
      .filter(({ value }) => {
        if (value.type !== 'success') return false
        const params = Object.fromEntries(
          value.identity.params.map(({ key, value: item }) => [key, item]),
        )
        return (
          params.imageAsset === assetId &&
          params.curveDetail === detail
        )
      })
      .at(-1)
    if (response === undefined) throw new Error('success response missing')
    const request = instrumentation.requests.find(
      (candidate) =>
        candidate.workerId === response.workerId &&
        candidate.value.jobId === response.value.jobId,
    )
    if (request === undefined) throw new Error('request timing missing')
    const paintAcknowledgedAt = performance.now()
    const scene = response.value.scene
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(scene)),
    )
    const sceneChecksum = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    return Object.freeze({
      identity: response.value.identity,
      jobId: response.value.jobId,
      workerId: response.workerId,
      requestPostedAt: request.postedAt,
      responseReceivedAt: response.receivedAt,
      paintAcknowledgedAt,
      wallRequestToResponseMs: response.receivedAt - request.postedAt,
      workerComputeTimeMs: response.value.computeTimeMs,
      nonComputeRequestToResponseMs:
        response.receivedAt -
        request.postedAt -
        response.value.computeTimeMs,
      responseToPaintAcknowledgementMs:
        paintAcknowledgedAt - response.receivedAt,
      primitiveCount: scene.primitives.length,
      pointCount: scene.primitives.reduce(
        (sum, primitive) => sum + primitive.points.length,
        0,
      ),
      sceneChecksum,
      longTasks: instrumentation.longTasks.filter(
        (entry) =>
          entry.startTime < paintAcknowledgedAt &&
          entry.startTime + entry.duration >= request.postedAt,
      ),
    })
  }, { assetId: asset, detail: curveDetail })
}

async function selectImageAsset(page, assetName) {
  const openSelection = await page.evaluate((name) => {
    const button = [
      ...document.querySelectorAll('[aria-label="Image Assets"] button'),
    ].find((candidate) => candidate.textContent?.trim().startsWith(name))
    if (button === undefined) return null
    const startedAt = performance.now()
    button.click()
    return {
      startedAt,
      handlerMs: performance.now() - startedAt,
    }
  }, assetName)
  if (openSelection !== null) return openSelection

  await page.evaluate(() => {
    const choose = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Choose image',
    )
    if (choose === undefined) throw new Error('Choose image button missing')
    choose.click()
  })
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('[aria-label="Image Assets"] button')]
        .some((button) => button.textContent?.trim().startsWith(name)),
    { polling: 10, timeout: 30_000 },
    assetName,
  )
  return page.evaluate((name) => {
    const button = [
      ...document.querySelectorAll('[aria-label="Image Assets"] button'),
    ].find((candidate) => candidate.textContent?.trim().startsWith(name))
    if (button === undefined) throw new Error(`${name} asset missing`)
    const startedAt = performance.now()
    button.click()
    return {
      startedAt,
      handlerMs: performance.now() - startedAt,
    }
  }, assetName)
}

async function waitForRequest(page, asset, curveDetail, afterCount) {
  await page.waitForFunction(
    ({ assetId, detail, startIndex }) =>
      globalThis.__FLOWING_CONTOURS_WORKER_BENCHMARK__.requests
        .slice(startIndex)
        .some(({ value }) => {
          const params = Object.fromEntries(
            value.identity.params.map(({ key, value: item }) => [key, item]),
          )
          return (
            params.imageAsset === assetId &&
            (detail === null || params.curveDetail === detail)
          )
        }),
    { polling: 10, timeout: DEFAULT_TIMEOUT_MS },
    {
      assetId: asset,
      detail: curveDetail,
      startIndex: afterCount,
    },
  )
}

async function requestCount(page) {
  return page.evaluate(
    () =>
      globalThis.__FLOWING_CONTOURS_WORKER_BENCHMARK__.requests.length,
  )
}

async function uiSnapshot(page) {
  return page.evaluate(currentUiSnapshot)
}

function currentUiSnapshot() {
  const button = (text) =>
    [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === text,
    )
  const region = document.querySelector('.canvas-region')
  return Object.freeze({
    at: performance.now(),
    preparation: region?.getAttribute(
      'data-flowing-contours-preparation',
    ),
    computeMs: region?.getAttribute(
      'data-flowing-contours-compute-ms',
    ),
    outlineDisabled:
      document.querySelector(
        'button[aria-label="Toggle outline render mode"]',
      )?.disabled ?? null,
    pngDisabled: button('Export PNG')?.disabled ?? null,
    svgDisabled: button('Export SVG')?.disabled ?? null,
    hiddenLineDisabled:
      button('Export Hidden-line SVG')?.disabled ?? null,
  })
}

function cancellationEvidence(trace) {
  const respondedWorkers = new Set(
    trace.responses.map(({ workerId }) => workerId),
  )
  const terminatedWorkers = new Set(
    trace.terminations.map(({ workerId }) => workerId),
  )
  const cancelled = trace.requests.filter(
    ({ workerId }) =>
      terminatedWorkers.has(workerId) && !respondedWorkers.has(workerId),
  )
  const cancelledWorkerIds = new Set(
    cancelled.map(({ workerId }) => workerId),
  )
  return Object.freeze({
    cancelledRequestCount: cancelled.length,
    cancelledWorkerIds: [...cancelledWorkerIds],
    responseWorkerIds: [...respondedWorkers],
    staleCancelledResponseCount: trace.responses.filter(({ workerId }) =>
      cancelledWorkerIds.has(workerId),
    ).length,
  })
}

function statistics(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = (fraction) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null
  return Object.freeze({
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? null,
    samples: Object.freeze([...values]),
  })
}

function validateEvidence(evidence, samples) {
  for (const [name, workload] of [
    ['Flower', evidence.flower],
    ['Pinecone', evidence.pinecone],
  ]) {
    if (workload.edits.length !== samples) {
      throw new Error(`${name} did not record ${samples} edit samples`)
    }
    if (
      workload.edits.some(
        ({ curveDetail, actualNumberValue }) =>
          curveDetail !== actualNumberValue,
      )
    ) {
      throw new Error(`${name} did not perform the requested real edits`)
    }
    if (Object.values(workload.parity).some((value) => !value)) {
      throw new Error(`${name} synchronous oracle parity failed`)
    }
    if (
      workload.pendingGate.pngDisabled !== true ||
      workload.pendingGate.svgDisabled !== true ||
      workload.pendingGate.hiddenLineDisabled !== true
    ) {
      throw new Error(`${name} stale/pending export freshness failed`)
    }
    if (
      workload.currentGate.pngDisabled !== false ||
      workload.currentGate.svgDisabled !== false ||
      workload.currentGate.hiddenLineDisabled !== false
    ) {
      throw new Error(`${name} current export readiness failed`)
    }
  }
  if (evidence.cancellation.cancelledRequestCount < samples * 2) {
    throw new Error('latest-input-wins cancellation evidence is incomplete')
  }
  if (evidence.cancellation.staleCancelledResponseCount !== 0) {
    throw new Error('a cancelled stale worker produced a terminal response')
  }
  if (evidence.consoleMessages.length !== 0) {
    throw new Error('the production probe recorded browser console errors')
  }
}

function summarize(evidence) {
  const summarizeCase = (workload) => ({
    handlerMs: workload.handlerMs,
    heartbeatDelayMs: workload.heartbeatDelayMs,
    editLongTaskMaxMs: workload.editLongTaskMaxMs,
    completion: {
      wallRequestToResponseMs:
        workload.completion.wallRequestToResponseMs,
      workerComputeTimeMs: workload.completion.workerComputeTimeMs,
      nonComputeRequestToResponseMs:
        workload.completion.nonComputeRequestToResponseMs,
      responseToPaintAcknowledgementMs:
        workload.completion.responseToPaintAcknowledgementMs,
      primitiveCount: workload.completion.primitiveCount,
      pointCount: workload.completion.pointCount,
      sceneChecksum: workload.completion.sceneChecksum,
      longTasks: workload.completion.longTasks,
    },
    oracle: workload.oracle,
    parity: workload.parity,
    pendingGate: workload.pendingGate,
    currentGate: workload.currentGate,
  })
  return Object.freeze({
    methodology: evidence.methodology,
    machine: evidence.machine,
    flower: summarizeCase(evidence.flower),
    pinecone: summarizeCase(evidence.pinecone),
    cancellation: evidence.cancellation,
  })
}

async function startProductionServer({
  studioOut,
  oracleOut,
  imageAssetsRoot,
  port,
}) {
  const mediaTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  }
  const server = createServer((request, response) => {
    try {
      const address = server.address()
      const activePort =
        address !== null && typeof address === 'object'
          ? address.port
          : port
      const pathname = new URL(
        request.url ?? '/',
        `http://127.0.0.1:${activePort}`,
      ).pathname
      if (pathname === '/__api/image-assets') {
        const ids = readdirSync(imageAssetsRoot)
          .filter((name) => name.endsWith('.png'))
          .map((name) => name.slice(0, -4))
          .sort()
        send(response, 200, 'application/json', JSON.stringify(ids))
        return
      }

      let base = studioOut
      let relative = pathname === '/' ? 'index.html' : pathname.slice(1)
      let spaFallback = true
      if (pathname.startsWith('/image-assets/')) {
        base = imageAssetsRoot
        relative = pathname.slice('/image-assets/'.length)
        spaFallback = false
      } else if (pathname.startsWith(ORACLE_PREFIX)) {
        base = oracleOut
        relative =
          pathname === ORACLE_PREFIX
            ? 'index.html'
            : pathname.slice(ORACLE_PREFIX.length)
        spaFallback = false
      }
      const candidate = safeChild(base, relative)
      let file = candidate
      if (!existsSync(file) || !statSync(file).isFile()) {
        if (!spaFallback) {
          response.writeHead(404).end()
          return
        }
        file = join(studioOut, 'index.html')
      }
      const body = readFileSync(file)
      send(
        response,
        200,
        mediaTypes[extname(file)] ?? 'application/octet-stream',
        body,
      )
    } catch {
      response.writeHead(500).end()
    }
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('production benchmark server has no TCP address')
  }
  return Object.freeze({
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) =>
          error === undefined ? resolveClose() : rejectClose(error),
        )
      }),
  })
}

function safeChild(base, relative) {
  const normalized = normalize(join(base, relative))
  if (normalized !== base && !normalized.startsWith(`${base}/`)) {
    throw new Error('request escaped benchmark root')
  }
  return normalized
}

function send(response, status, contentType, value) {
  const body =
    typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function run(command, args, cwd, extraEnvironment) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnvironment },
  })
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', resolveExit)
  })
  if (exitCode !== 0) throw new Error(`${command} exited ${exitCode}`)
}

function parseArguments(args) {
  const values = {
    out: null,
    samples: 3,
    port: 0,
    studioUrl: null,
    oracleUrl: null,
    vite: process.env.VITE_BIN ?? null,
    puppeteerModule: process.env.PUPPETEER_MODULE ?? null,
    chrome: process.env.PUPPETEER_EXECUTABLE_PATH ?? null,
    dryRun: false,
    help: false,
  }
  for (const argument of args) {
    if (argument === '--dry-run') values.dryRun = true
    else if (argument === '--help') values.help = true
    else if (argument.startsWith('--out=')) {
      values.out = argument.slice('--out='.length)
    } else if (argument.startsWith('--samples=')) {
      values.samples = Number(argument.slice('--samples='.length))
    } else if (argument.startsWith('--port=')) {
      values.port = Number(argument.slice('--port='.length))
    } else if (argument.startsWith('--studio-url=')) {
      values.studioUrl = argument.slice('--studio-url='.length)
    } else if (argument.startsWith('--oracle-url=')) {
      values.oracleUrl = argument.slice('--oracle-url='.length)
    } else if (argument.startsWith('--vite=')) {
      values.vite = argument.slice('--vite='.length)
    } else if (argument.startsWith('--puppeteer-module=')) {
      values.puppeteerModule = argument.slice(
        '--puppeteer-module='.length,
      )
    } else if (argument.startsWith('--chrome=')) {
      values.chrome = argument.slice('--chrome='.length)
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  if (
    !values.help &&
    !values.dryRun &&
    (values.out === null || values.out === '')
  ) {
    throw new Error('--out=<JSON file> is required')
  }
  if (!Number.isSafeInteger(values.samples) || values.samples < 1) {
    throw new Error('--samples must be an integer >= 1')
  }
  if (
    !Number.isSafeInteger(values.port) ||
    values.port < 0 ||
    values.port > 65_535
  ) {
    throw new Error('--port must be an integer from 0 through 65535')
  }
  if ((values.studioUrl === null) !== (values.oracleUrl === null)) {
    throw new Error(
      '--studio-url and --oracle-url must be supplied together',
    )
  }
  return Object.freeze(values)
}

function resolvePuppeteerEntry(explicit) {
  return resolveExecutable(
    explicit,
    [
      '.claude/skills/chrome-devtools/scripts/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js',
      '.agents/skills/chrome-devtools/scripts/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js',
    ],
    'Puppeteer is unavailable; pass --puppeteer-module=<entry> or set PUPPETEER_MODULE',
  )
}

function resolveExecutable(explicit, fallbacks, error) {
  const candidates =
    explicit === null
      ? fallbacks.map((candidate) => resolve(root, candidate))
      : [resolve(explicit)]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) throw new Error(error)
  return found
}

function usage() {
  return `Usage:
  node packages/core/benchmarks/flowing-contours-studio-worker-cli.js \\
    --samples=3 --out=/tmp/flowing-worker.json

By default the CLI builds a minified production Studio and a minified
synchronous oracle into a private temporary directory, serves both plus the
managed Image Assets on an ephemeral localhost port, launches Puppeteer, writes
raw JSON evidence, then removes the temporary build.

Options:
  --out=<file>                 Required evidence JSON path
  --samples=<n>                Real Curve-detail edits per workload (default 3)
  --port=<n>                   Local server port; 0 chooses a free port
  --vite=<path>                Vite executable (or VITE_BIN)
  --puppeteer-module=<path>    Puppeteer ESM entry (or PUPPETEER_MODULE)
  --chrome=<path>              Chrome executable (or PUPPETEER_EXECUTABLE_PATH)
  --studio-url=<url>           Existing production Studio URL
  --oracle-url=<url>           Existing compatible synchronous-oracle URL
  --dry-run                    Validate arguments and print the execution plan
  --help                       Show this help

External URLs must be supplied together. The Studio must expose the production
Flowing Contours controls and DOM probe attributes; the oracle must expose
globalThis.__FLOWING_CONTOURS_SYNC_ORACLE__.`
}
