import { drawSceneFitted } from '../../src/renderer.ts'
import { defaultFlowingContoursControls } from '../../src/sketches/flowing-contours/controls.ts'
import { generateFlowingContours } from '../../src/sketches/flowing-contours/generator.ts'

const FRAME = Object.freeze({ width: 1000, height: 1000 })
const FIXTURES = Object.freeze({
  flower: new URL(
    '../../../../assets/image-assets/img-0672-79d639daec62.png',
    import.meta.url,
  ).href,
  pinecone: new URL(
    '../../../../assets/image-assets/pinecone-4330aa0314f7.png',
    import.meta.url,
  ).href,
})
const EXPECTED = Object.freeze({
  flower: Object.freeze({
    outputChecksum:
      'a3848f8e79ae02e68732fe2cbe5ea3dd866514528075ff4af1373ae3d303a0ca',
    pixelChecksum:
      '88b7826654d3771a6d0b2f7d4f348001b39a837d71b5447585774e5a1819155f',
    primitiveCount: 111,
    pointCount: 1399,
  }),
  pinecone: Object.freeze({
    outputChecksum:
      '6b99506ec056cdbc2025cd25566701110271f035f8c128ed03ba60ccd8cca56b',
    pixelChecksum:
      '059ab9ae600481fbc7f489f3e51f16df63e045874405c5c6b4c9d6f77dc8f1f1',
    primitiveCount: 27,
    pointCount: 321,
  }),
})

const canvas = document.querySelector('#surface')
const context = canvas.getContext('2d', { willReadFrequently: true })
const curveDetail = document.querySelector('#curve-detail')
const status = document.querySelector('#status')
if (context === null) throw new Error('Canvas2D is unavailable')

const pixelsByCase = Object.fromEntries(
  await Promise.all(
    Object.entries(FIXTURES).map(async ([name, url]) => [
      name,
      await decodeRgba8(url),
    ]),
  ),
)

const longTasks = []
const longTaskObserver =
  typeof PerformanceObserver === 'undefined' ||
  !PerformanceObserver.supportedEntryTypes.includes('longtask')
    ? null
    : new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          })
        }
      })
longTaskObserver?.observe({ type: 'longtask', buffered: true })

let selectedCase = 'flower'
let pendingMeasurement = null
curveDetail.addEventListener('input', () => {
  const scheduledAt = pendingMeasurement?.scheduledAt ?? performance.now()
  const handlerStartedAt = performance.now()
  const longTaskStartIndex = longTasks.length
  const controls = Object.freeze({
    ...defaultFlowingContoursControls,
    curveDetail: Number(curveDetail.value),
  })
  const generationStartedAt = performance.now()
  const result = generateFlowingContours({
    pixels: pixelsByCase[selectedCase],
    frame: FRAME,
    controls,
  })
  const generationEndedAt = performance.now()

  const submissionStartedAt = performance.now()
  drawSceneFitted(context, result.scene, canvas.width, canvas.height)
  const submissionEndedAt = performance.now()

  const readbackStartedAt = performance.now()
  const readback = context.getImageData(0, 0, canvas.width, canvas.height)
  const readbackEndedAt = performance.now()
  const handlerEndedAt = performance.now()

  const measurement = {
    caseName: selectedCase,
    curveDetail: controls.curveDetail,
    scheduledToHandlerStartMs: handlerStartedAt - scheduledAt,
    generationMs: generationEndedAt - generationStartedAt,
    canvasSubmissionMs: submissionEndedAt - submissionStartedAt,
    forcedRasterReadbackMs: readbackEndedAt - readbackStartedAt,
    handlerBlockingMs: handlerEndedAt - handlerStartedAt,
    scheduledToHandlerEndMs: handlerEndedAt - scheduledAt,
    primitiveCount: result.scene.primitives.length,
    pointCount: result.scene.primitives.reduce(
      (sum, primitive) => sum + primitive.points.length,
      0,
    ),
    diagnostics: result.diagnostics,
    result,
    readback,
    handlerEndedAt,
    longTaskStartIndex,
  }
  pendingMeasurement?.resolve(measurement)
})

async function runOne(caseName, detail = defaultFlowingContoursControls.curveDetail) {
  selectedCase = caseName
  const scheduledAt = performance.now()
  const heartbeatTarget = scheduledAt + 50
  const heartbeat = new Promise((resolve) => {
    setTimeout(() => resolve(performance.now() - heartbeatTarget), 50)
  })
  const handled = new Promise((resolve) => {
    pendingMeasurement = { scheduledAt, resolve }
    setTimeout(() => {
      curveDetail.value = String(detail)
      curveDetail.dispatchEvent(new Event('input', { bubbles: true }))
    }, 0)
  })
  const measurement = await handled
  pendingMeasurement = null
  const heartbeatDelayMs = await heartbeat
  const firstFrameMs = await new Promise((resolve) => {
    requestAnimationFrame((now) => resolve(now - measurement.handlerEndedAt))
  })
  const secondFrameMs = await new Promise((resolve) => {
    requestAnimationFrame((now) => resolve(now - measurement.handlerEndedAt))
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const outputChecksum = await sha256Text(JSON.stringify(measurement.result))
  const pixelChecksum = await sha256Bytes(measurement.readback.data)
  const observedLongTasks = longTasks
    .slice(measurement.longTaskStartIndex)
    .filter(
      (entry) =>
        entry.startTime <= measurement.handlerEndedAt &&
        entry.startTime + entry.duration >= measurement.handlerEndedAt -
          measurement.handlerBlockingMs,
    )
  const {
    result: _result,
    readback: _readback,
    handlerEndedAt: _handlerEndedAt,
    longTaskStartIndex: _longTaskStartIndex,
    ...plain
  } = measurement
  return Object.freeze({
    ...plain,
    heartbeatDelayMs,
    firstAnimationFrameAfterHandlerMs: firstFrameMs,
    secondAnimationFrameAfterHandlerMs: secondFrameMs,
    outputChecksum,
    pixelChecksum,
    longTasks: observedLongTasks,
  })
}

async function runAll(samples = 3) {
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new Error('samples must be an integer >= 1')
  }
  const observations = { flower: [], pinecone: [] }
  for (let sample = 0; sample < samples; sample += 1) {
    for (const caseName of sample % 2 === 0
      ? ['flower', 'pinecone']
      : ['pinecone', 'flower']) {
      observations[caseName].push(await runOne(caseName))
    }
  }
  const summaries = Object.fromEntries(
    Object.entries(observations).map(([caseName, caseObservations]) => {
      const summary = summarize(caseObservations)
      const expected = EXPECTED[caseName]
      for (const name of [
        'outputChecksum',
        'pixelChecksum',
        'primitiveCount',
        'pointCount',
      ]) {
        if (summary[name] !== expected[name]) {
          throw new Error(
            `${caseName} ${name} changed: expected ${expected[name]}, received ${summary[name]}`,
          )
        }
      }
      return [caseName, summary]
    }),
  )
  return Object.freeze({
    machine: Object.freeze({
      userAgent: navigator.userAgent,
      platform: navigator.userAgentData?.platform ?? navigator.platform,
      logicalCpuCount: navigator.hardwareConcurrency ?? null,
      deviceMemoryGiB: navigator.deviceMemory ?? null,
      devicePixelRatio,
    }),
    canvas: Object.freeze({ width: canvas.width, height: canvas.height }),
    samples,
    summaries,
    observations,
  })
}

function summarize(observations) {
  const metricNames = [
    'scheduledToHandlerStartMs',
    'generationMs',
    'canvasSubmissionMs',
    'forcedRasterReadbackMs',
    'handlerBlockingMs',
    'heartbeatDelayMs',
    'firstAnimationFrameAfterHandlerMs',
    'secondAnimationFrameAfterHandlerMs',
  ]
  return Object.freeze({
    outputChecksum: oneValue(observations.map(({ outputChecksum }) => outputChecksum)),
    pixelChecksum: oneValue(observations.map(({ pixelChecksum }) => pixelChecksum)),
    primitiveCount: oneValue(observations.map(({ primitiveCount }) => primitiveCount)),
    pointCount: oneValue(observations.map(({ pointCount }) => pointCount)),
    longTaskCount: observations.reduce(
      (sum, observation) => sum + observation.longTasks.length,
      0,
    ),
    metrics: Object.fromEntries(
      metricNames.map((name) => [name, statistics(observations.map((item) => item[name]))]),
    ),
  })
}

function oneValue(values) {
  const unique = new Set(values)
  if (unique.size !== 1) throw new Error('deterministic browser values diverged')
  return values[0]
}

function statistics(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return Object.freeze({
    median: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samples: Object.freeze([...values]),
  })
}

async function decodeRgba8(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`failed to load fixture: ${response.status}`)
  const bitmap = await createImageBitmap(await response.blob())
  const surface = new OffscreenCanvas(bitmap.width, bitmap.height)
  const surfaceContext = surface.getContext('2d', { willReadFrequently: true })
  if (surfaceContext === null) throw new Error('fixture Canvas2D is unavailable')
  surfaceContext.drawImage(bitmap, 0, 0)
  const data = surfaceContext.getImageData(0, 0, bitmap.width, bitmap.height).data
  bitmap.close()
  return Object.freeze({
    width: surface.width,
    height: surface.height,
    data: new Uint8Array(data),
  })
}

async function sha256Text(value) {
  return sha256Bytes(new TextEncoder().encode(value))
}

async function sha256Bytes(value) {
  const digest = await crypto.subtle.digest('SHA-256', value)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

globalThis.__FLOWING_CONTOURS_BROWSER_PERFORMANCE__ = Object.freeze({
  runOne,
  runAll,
  machine: Object.freeze({
    userAgent: navigator.userAgent,
    logicalCpuCount: navigator.hardwareConcurrency ?? null,
  }),
})
status.textContent = 'Ready'
