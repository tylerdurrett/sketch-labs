import { describe, expect, it } from 'vitest'

import { clipSceneToBounds } from '../src/clipToBounds'
import { DEFAULT_COMPOSITION_FRAME } from '../src/compositionFrame'
import { hiddenLinePass } from '../src/hiddenLine'
import { renderToSVG } from '../src/renderer'
import { defaultParams } from '../src/sketch'
import { leafField } from '../src/sketches/leaf-field'

const SEED = 12345
const PARAMS = Object.freeze(defaultParams(leafField.schema))
const DEFAULT_SAMPLES = 20
const DEFAULT_WARMUPS = 1
const MIN_SAMPLES = 20
const EXPECTED_OUTLINE_CHECKSUM = '1ffab356a8fc888a'

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
      guard += benchmarkCase.operation()
    }
  }

  for (let i = 0; i < samples; i++) {
    for (let step = 0; step < cases.length; step++) {
      const benchmarkCase = cases[(i + step) % cases.length]
      const start = performance.now()
      guard += benchmarkCase.operation()
      durations[benchmarkCase.name].push(performance.now() - start)
    }
  }

  if (!Number.isFinite(guard) || guard === 0) {
    throw new Error(`benchmark work guard failed: ${guard}`)
  }
  return Object.fromEntries(
    cases.map(({ name }) => [name, { ...stats(durations[name]), guard }]),
  )
}

function sceneCounts(scene) {
  let points = 0
  for (const primitive of scene.primitives) points += primitive.points.length
  return { primitives: scene.primitives.length, points }
}

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

function report(label, result, samples) {
  console.log(
    `${label.padEnd(34)} median ${`${result.median.toFixed(2)} ms`.padStart(11)}  p95 ${`${result.p95.toFixed(2)} ms`.padStart(11)}  n=${samples}`,
  )
}

describe('hidden-line performance feedback loop', () => {
  it('reports pinned, exact-output phase and end-to-end timings', () => {
    const samples = readPositiveInteger('HIDDEN_LINE_BENCH_SAMPLES', DEFAULT_SAMPLES, MIN_SAMPLES)
    const warmups = readPositiveInteger('HIDDEN_LINE_BENCH_WARMUPS', DEFAULT_WARMUPS, 0)
    const source = leafField.generate(PARAMS, SEED, 0, DEFAULT_COMPOSITION_FRAME)
    const outline = hiddenLinePass(source, { tolerance: 0 })
    const clipped = clipSceneToBounds(outline)
    const expectedChecksum = sceneChecksum(outline)
    const sourceCounts = sceneCounts(source)
    const outlineCounts = sceneCounts(outline)
    expect(expectedChecksum).toBe(EXPECTED_OUTLINE_CHECKSUM)

    const timings = measureCases(samples, warmups, [
      {
        name: 'generation',
        operation: () => {
          const scene = leafField.generate(PARAMS, SEED, 0, DEFAULT_COMPOSITION_FRAME)
          return scene.primitives.length + scene.primitives[0].points[0][0]
        },
      },
      {
        name: 'hiddenLinePass',
        operation: () => {
          const result = hiddenLinePass(source, { tolerance: 0 })
          return result.primitives.length + result.primitives[0].points[0][0]
        },
      },
      {
        name: 'boundsClip',
        operation: () => {
          const result = clipSceneToBounds(outline)
          return result.primitives.length + result.primitives[0].points[0][0]
        },
      },
      {
        name: 'svgSerialization',
        operation: () => renderToSVG(clipped).length,
      },
      {
        name: 'wholeExportPipeline',
        operation: () => {
          const generated = leafField.generate(PARAMS, SEED, 0, DEFAULT_COMPOSITION_FRAME)
          const processed = hiddenLinePass(generated, { tolerance: 0 })
          return renderToSVG(clipSceneToBounds(processed)).length
        },
      },
    ])

    console.log('\nHidden-line benchmark')
    console.log(`runtime                           ${process.version} ${process.platform}/${process.arch}`)
    console.log(`seed                              ${SEED}`)
    console.log(`source                            ${sourceCounts.primitives} primitives, ${sourceCounts.points} points`)
    console.log(`outline                           ${outlineCounts.primitives} primitives, ${outlineCounts.points} points`)
    console.log(`outline checksum                  ${expectedChecksum}`)
    report('generation', timings.generation, samples)
    report('Hidden-line pass', timings.hiddenLinePass, samples)
    report('bounds clip', timings.boundsClip, samples)
    report('SVG serialization', timings.svgSerialization, samples)
    report('whole export pipeline', timings.wholeExportPipeline, samples)
  })
})
