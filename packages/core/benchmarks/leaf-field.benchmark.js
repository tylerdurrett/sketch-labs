import { describe, expect, it } from 'vitest'

import { drawSceneFitted } from '../src/renderer'
import { leafField } from '../src/sketches/leaf-field'

const SEED = 'leaf-field-performance-v1'

// Intentionally explicit rather than derived from schema defaults. A default
// change should not silently change this workload and invalidate comparisons.
const PARAMS = Object.freeze({
  fieldScale: 0.75,
  turbulence: 0.1536,
  octaves: 2,
  density: 18.696,
  leafSizeMin: 50,
  leafSizeMax: 64.6,
  leafWidthMin: 0.5,
  leafWidthMax: 1.15,
  pointinessMin: 0,
  pointinessMax: 0,
  variation: 0,
  sphereCount: 6,
  sphereRadiusMin: 40,
  sphereRadiusMax: 190.12,
  sphereDepth: 0.5,
  backgroundColor: '#878787',
  discColor: '#ffffff',
})

const PIXEL_WIDTH = 1000
const PIXEL_HEIGHT = 1000
const DEFAULT_SAMPLES = 30
const DEFAULT_WARMUPS = 5
const MIN_SAMPLES = 20
const EXPECTED_PRIMITIVES = 1405
const EXPECTED_POINTS = 136093
const EXPECTED_CHECKSUM = '8a44b4fb25fbbb0f'

function readPositiveInteger(name, fallback, minimum) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}; received ${raw}`)
  }
  return parsed
}

function percentile(sorted, fraction) {
  return sorted[Math.ceil(sorted.length * fraction) - 1]
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  }
}

function measureCases(samples, warmups, cases) {
  let guard = 0
  const durations = Object.fromEntries(cases.map(({ name }) => [name, []]))

  for (let i = 0; i < warmups; i++) {
    for (let step = 0; step < cases.length; step++) {
      const benchmarkCase = cases[(i + step) % cases.length]
      guard += benchmarkCase.operation(i)
    }
  }

  for (let i = 0; i < samples; i++) {
    // Rotate phase order each sample so later phases do not systematically get
    // a hotter JIT/CPU than earlier ones.
    for (let step = 0; step < cases.length; step++) {
      const benchmarkCase = cases[(i + step) % cases.length]
      const start = performance.now()
      guard += benchmarkCase.operation(i + warmups)
      durations[benchmarkCase.name].push(performance.now() - start)
    }
  }

  // Every measured operation contributes a finite, non-zero value. Returning
  // the guard also keeps the work observably live outside the timing loop.
  if (!Number.isFinite(guard) || guard === 0) {
    throw new Error(`benchmark work guard failed: ${guard}`)
  }
  return Object.fromEntries(
    cases.map(({ name }) => [name, { ...stats(durations[name]), guard }]),
  )
}

function formatMs(value) {
  return `${value.toFixed(2)} ms`
}

function report(label, result, samples) {
  console.log(
    `${label.padEnd(34)} median ${formatMs(result.median).padStart(10)}  p95 ${formatMs(result.p95).padStart(10)}  n=${samples}`,
  )
}

function sceneCounts(scene) {
  let points = 0
  for (const primitive of scene.primitives) points += primitive.points.length
  return { primitives: scene.primitives.length, points }
}

// FNV-1a 64-bit over every Scene field, including the IEEE-754 bytes of every
// coordinate. This is deliberately independent of JSON formatting and guards
// against a "speedup" that changes or skips geometry.
function sceneChecksum(scene) {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  const bytes = new Uint8Array(8)
  const view = new DataView(bytes.buffer)

  const byte = (value) => {
    hash ^= BigInt(value)
    hash = (hash * prime) & mask
  }
  const number = (value) => {
    view.setFloat64(0, value, false)
    for (const valueByte of bytes) byte(valueByte)
  }
  const string = (value) => {
    number(value.length)
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      byte(code >>> 8)
      byte(code & 0xff)
    }
  }

  number(scene.space.width)
  number(scene.space.height)
  byte(scene.background === undefined ? 0 : 1)
  if (scene.background !== undefined) string(scene.background.color)
  number(scene.primitives.length)

  for (const primitive of scene.primitives) {
    byte(primitive.closed === true ? 1 : 0)
    byte(primitive.fill === undefined ? 0 : 1)
    if (primitive.fill !== undefined) string(primitive.fill.color)
    byte(primitive.stroke === undefined ? 0 : 1)
    if (primitive.stroke !== undefined) {
      string(primitive.stroke.color)
      number(primitive.stroke.width)
    }
    number(primitive.points.length)
    for (const [x, y] of primitive.points) {
      number(x)
      number(y)
    }
  }

  return hash.toString(16).padStart(16, '0')
}

function createCountingCanvas() {
  const counts = {
    save: 0,
    restore: 0,
    beginPath: 0,
    moveTo: 0,
    lineTo: 0,
    closePath: 0,
    fill: 0,
    stroke: 0,
    setTransform: 0,
    fillRect: 0,
    clearRect: 0,
    coordinateGuard: 0,
  }

  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    save() { counts.save++ },
    restore() { counts.restore++ },
    beginPath() { counts.beginPath++ },
    moveTo(x, y) {
      counts.moveTo++
      counts.coordinateGuard += x * 0.5 + y * 0.25
    },
    lineTo(x, y) {
      counts.lineTo++
      counts.coordinateGuard += x * 0.5 + y * 0.25
    },
    closePath() { counts.closePath++ },
    fill() { counts.fill++ },
    stroke() { counts.stroke++ },
    setTransform(a, b, c, d, e, f) {
      counts.setTransform++
      counts.coordinateGuard += a + b + c + d + e + f
    },
    fillRect(x, y, width, height) {
      counts.fillRect++
      counts.coordinateGuard += x + y + width + height
    },
    clearRect(x, y, width, height) {
      counts.clearRect++
      counts.coordinateGuard += x + y + width + height
    },
  }

  return { context, counts }
}

function canvasGuard(counts) {
  return counts.lineTo + counts.fill + counts.stroke + counts.coordinateGuard
}

function varyingTime(index) {
  return (index % 120) / 60
}

function createWarmFrameSource() {
  // Structural detection keeps this benchmark usable before and after the
  // optional prepared-frame contract lands, without widening production types
  // in the benchmark-only branch.
  if (typeof leafField.prepare === 'function') {
    return { kind: 'prepare', frameAt: leafField.prepare(PARAMS, SEED) }
  }
  return {
    kind: 'generate fallback',
    frameAt: (t) => leafField.generate(PARAMS, SEED, t),
  }
}

describe('leaf-field performance feedback loop', () => {
  it('reports pinned, guarded phase timings', () => {
    const samples = readPositiveInteger('LEAF_BENCH_SAMPLES', DEFAULT_SAMPLES, MIN_SAMPLES)
    const warmups = readPositiveInteger('LEAF_BENCH_WARMUPS', DEFAULT_WARMUPS, 0)

    const reference = leafField.generate(PARAMS, SEED, 0)
    const counts = sceneCounts(reference)
    const checksum = sceneChecksum(reference)
    const warm = createWarmFrameSource()

    const submissionCanvas = createCountingCanvas()
    const wholeFrameCanvas = createCountingCanvas()
    const timings = measureCases(samples, warmups, [
      {
        name: 'oneShotGeneration',
        operation: () => {
          const scene = leafField.generate(PARAMS, SEED, 0)
          return scene.primitives.length + scene.primitives[0].points[0][0]
        },
      },
      {
        name: 'warmGeneration',
        operation: (index) => {
          const scene = warm.frameAt(varyingTime(index))
          return scene.primitives.length + scene.primitives[0].points[0][0]
        },
      },
      {
        name: 'canvasSubmission',
        operation: () => {
          drawSceneFitted(
            submissionCanvas.context,
            reference,
            PIXEL_WIDTH,
            PIXEL_HEIGHT,
          )
          return canvasGuard(submissionCanvas.counts)
        },
      },
      {
        name: 'wholeFrame',
        operation: (index) => {
          const scene = warm.frameAt(varyingTime(index))
          drawSceneFitted(
            wholeFrameCanvas.context,
            scene,
            PIXEL_WIDTH,
            PIXEL_HEIGHT,
          )
          return scene.primitives.length + canvasGuard(wholeFrameCanvas.counts)
        },
      },
    ])

    console.log('\nLeaf Field benchmark')
    console.log(`runtime                           ${process.version} ${process.platform}/${process.arch}`)
    console.log(`seed                              ${SEED}`)
    console.log(`warm frame source                 ${warm.kind}`)
    console.log(`scene                             ${counts.primitives} primitives, ${counts.points} points`)
    console.log(`checksum                          ${checksum}`)
    report('cold/full generation (generate)', timings.oneShotGeneration, samples)
    report(`warm generation (${warm.kind})`, timings.warmGeneration, samples)
    report('Canvas port submission', timings.canvasSubmission, samples)
    report('warm whole frame', timings.wholeFrame, samples)
    console.log('Canvas note                       injected counting port; no browser raster/flush')

    expect(checksum).toBe(EXPECTED_CHECKSUM)
    expect(sceneChecksum(warm.frameAt(0))).toBe(checksum)
    expect(sceneChecksum(warm.frameAt(61 / 60))).toBe(
      sceneChecksum(leafField.generate(PARAMS, SEED, 61 / 60)),
    )
    expect(counts.primitives).toBe(EXPECTED_PRIMITIVES)
    expect(counts.points).toBe(EXPECTED_POINTS)
    expect(submissionCanvas.counts.moveTo).toBe(
      counts.primitives * (samples + warmups),
    )
    expect(submissionCanvas.counts.lineTo).toBe(
      (counts.points - counts.primitives) * (samples + warmups),
    )
    expect(submissionCanvas.counts.fillRect).toBe(samples + warmups)
    expect(submissionCanvas.counts.clearRect).toBe(0)
  })
})
