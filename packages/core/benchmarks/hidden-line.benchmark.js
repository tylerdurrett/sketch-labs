import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { clipSceneToBounds } from '../src/clipToBounds'
import { DEFAULT_COMPOSITION_FRAME } from '../src/compositionFrame'
import { hiddenLinePass } from '../src/hiddenLine'
import { renderToSVG } from '../src/renderer'
import { defaultParams } from '../src/sketch'
import { leafField } from '../src/sketches/leaf-field'

const SEED = 12345
const PARAMS = Object.freeze(defaultParams(leafField.schema))
const DEFAULT_SAMPLES = 10
const DEFAULT_WARMUPS = 1
const MIN_SAMPLES = 5
const EXPECTED_OUTLINE_CHECKSUM = 'c4056d4d8f9eb6eb59f7c5e0abb08760a9cdb4f02f92100f3037f7c200418b20'

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
  return createHash('sha256').update(JSON.stringify(scene)).digest('hex')
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
