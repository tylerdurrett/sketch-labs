import { describe, expect, it } from 'vitest'

import { clipSceneToBounds } from '../src/clipToBounds'
import { DEFAULT_COMPOSITION_FRAME } from '../src/compositionFrame'
import { analyzeHiddenLineWorkload, hiddenLinePass } from '../src/hiddenLine'
import { renderToSVG } from '../src/renderer'
import { defaultParams } from '../src/sketch'
import { grassHills } from '../src/sketches/grass-hills'
import { leafField } from '../src/sketches/leaf-field'

const SEED = 12345
const LEAF_FIELD_PARAMS = Object.freeze(defaultParams(leafField.schema))
const GRASS_HILLS_PARAMS = Object.freeze(defaultParams(grassHills.schema))
const DEFAULT_SAMPLES = 20
const DEFAULT_WARMUPS = 1
const MIN_SAMPLES = 20
const EXPECTED_LEAF_FIELD_OUTLINE_CHECKSUM = '44ad772130d46fb1'
const EXPECTED_GRASS_HILLS_OUTLINE_CHECKSUM = '1d6e1ddc0edeef9d'
const SYNTHETIC_SPACE = Object.freeze({ width: 640, height: 640 })
const SYNTHETIC_FILL = Object.freeze({ color: 'black' })

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

function benchmarkSketch(
  { label, sketch, params, expectedOutlineChecksum },
  samples,
  warmups,
) {
  const source = sketch.generate(params, SEED, 0, DEFAULT_COMPOSITION_FRAME)
  const outline = hiddenLinePass(source, { tolerance: 0 })
  const clipped = clipSceneToBounds(outline)
  const outlineChecksum = sceneChecksum(outline)
  const sourceCounts = sceneCounts(source)
  const outlineCounts = sceneCounts(outline)
  if (expectedOutlineChecksum !== undefined) {
    expect(outlineChecksum).toBe(expectedOutlineChecksum)
  }

  const timings = measureCases(samples, warmups, [
    {
      name: 'generation',
      operation: () => {
        const scene = sketch.generate(params, SEED, 0, DEFAULT_COMPOSITION_FRAME)
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
        const generated = sketch.generate(
          params,
          SEED,
          0,
          DEFAULT_COMPOSITION_FRAME,
        )
        const processed = hiddenLinePass(generated, { tolerance: 0 })
        return renderToSVG(clipSceneToBounds(processed)).length
      },
    },
  ])

  console.log(`\n${label} hidden-line benchmark`)
  console.log(`runtime                           ${process.version} ${process.platform}/${process.arch}`)
  console.log(`seed                              ${SEED}`)
  console.log(`source                            ${sourceCounts.primitives} primitives, ${sourceCounts.points} points`)
  console.log(`outline                           ${outlineCounts.primitives} primitives, ${outlineCounts.points} points`)
  console.log(`outline checksum                  ${outlineChecksum}`)
  report('generation', timings.generation, samples)
  report('Hidden-line pass', timings.hiddenLinePass, samples)
  report('bounds clip', timings.boundsClip, samples)
  report('SVG serialization', timings.svgSerialization, samples)
  report('whole export pipeline', timings.wholeExportPipeline, samples)
}

function regularPolygon(centerX, centerY, radius, vertices, rotation = 0) {
  return {
    closed: true,
    fill: SYNTHETIC_FILL,
    points: Array.from({ length: vertices }, (_, index) => {
      const angle = rotation + (index * Math.PI * 2) / vertices
      return [
        centerX + Math.cos(angle) * radius,
        centerY + Math.sin(angle) * radius,
      ]
    }),
  }
}

function gridScene(primitiveCount, verticesPerPrimitive) {
  const columns = Math.ceil(Math.sqrt(primitiveCount))
  return {
    space: SYNTHETIC_SPACE,
    primitives: Array.from({ length: primitiveCount }, (_, index) =>
      regularPolygon(
        30 + (index % columns) * 36,
        30 + Math.floor(index / columns) * 36,
        10,
        verticesPerPrimitive,
      ),
    ),
  }
}

function pairedTriangles(pairCount, partnerOffset) {
  const primitives = []
  for (let pair = 0; pair < pairCount; pair++) {
    const originX = 20 + (pair % 4) * 80
    const originY = 20 + Math.floor(pair / 4) * 80
    const triangle = (offset) => ({
      closed: true,
      fill: SYNTHETIC_FILL,
      points: [
        [originX + offset, originY + offset],
        [originX + offset + 10, originY + offset],
        [originX + offset, originY + offset + 10],
      ],
    })
    primitives.push(triangle(0))
    primitives.push(triangle(partnerOffset(pair)))
  }
  return { space: SYNTHETIC_SPACE, primitives }
}

function aabbOverlapScene(overlappingPairCount) {
  return pairedTriangles(6, (pair) => (pair < overlappingPairCount ? 6 : 18))
}

function denseOverlapScene() {
  const primitiveCount = 12
  return {
    space: SYNTHETIC_SPACE,
    primitives: Array.from({ length: primitiveCount }, (_, index) => {
      return regularPolygon(
        40,
        40,
        12,
        6,
        (index * Math.PI) / 37,
      )
    }),
  }
}

/**
 * Build isolated pairs whose AABBs always overlap. The first triangle occupies
 * x+y <= 10; its partner is shifted by (3, 3) for two proper edge crossings,
 * or by (6, 6), where the overlapping AABB corner contains no geometry. This
 * varies narrow-phase intersection density without changing any A1 count.
 */
function intersectionScene(intersectingPairCount) {
  return pairedTriangles(8, (pair) => (pair < intersectingPairCount ? 3 : 6))
}

function scalingCase(family, label, scene) {
  return {
    family,
    label,
    name: `${family}: ${label}`,
    scene,
    workload: analyzeHiddenLineWorkload(scene),
  }
}

function reportScaling(benchmarkCase, result, samples) {
  const work = benchmarkCase.workload
  console.log(
    `${benchmarkCase.label.padEnd(22)} ${String(work.filledPrimitiveCount).padStart(6)} ${String(work.sourceSegmentCount).padStart(9)} ${String(work.overlappingPairCount).padStart(10)} ${String(work.estimatedSegmentEdgeComparisons).padStart(13)} ${String(work.totalWorkUnits).padStart(11)} ${result.median.toFixed(2).padStart(10)} ${result.p95.toFixed(2).padStart(9)}  n=${samples}`,
  )
}

function reportOverhead(label, unobserved, observed) {
  const format = (baseline, instrumented) => {
    const delta = instrumented - baseline
    return `${baseline.toFixed(2)} ms unobserved, ${instrumented.toFixed(2)} ms observed, ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ms delta, ${(instrumented / baseline).toFixed(3)}x ratio`
  }
  console.log(`${label} median  ${format(unobserved.median, observed.median)}`)
  console.log(`${label} p95     ${format(unobserved.p95, observed.p95)}`)
}

describe('hidden-line performance feedback loop', () => {
  it.each([
    {
      label: 'Leaf Field',
      sketch: leafField,
      params: LEAF_FIELD_PARAMS,
      expectedOutlineChecksum: EXPECTED_LEAF_FIELD_OUTLINE_CHECKSUM,
    },
    {
      label: 'Grass Hills',
      sketch: grassHills,
      params: GRASS_HILLS_PARAMS,
      expectedOutlineChecksum: EXPECTED_GRASS_HILLS_OUTLINE_CHECKSUM,
    },
  ])('reports $label phase and end-to-end timings', (fixture) => {
    const samples = readPositiveInteger('HIDDEN_LINE_BENCH_SAMPLES', DEFAULT_SAMPLES, MIN_SAMPLES)
    const warmups = readPositiveInteger('HIDDEN_LINE_BENCH_WARMUPS', DEFAULT_WARMUPS, 0)
    benchmarkSketch(fixture, samples, warmups)
  })

  it('reports controlled synthetic scaling fixtures beside workload inventory', () => {
    const samples = readPositiveInteger('HIDDEN_LINE_BENCH_SAMPLES', DEFAULT_SAMPLES, MIN_SAMPLES)
    const warmups = readPositiveInteger('HIDDEN_LINE_BENCH_WARMUPS', DEFAULT_WARMUPS, 0)
    const families = [
      {
        name: 'primitive count (6 vertices, disjoint)',
        cases: [8, 16, 24].map((count) =>
          scalingCase('primitive-count', `${count} primitives`, gridScene(count, 6)),
        ),
      },
      {
        name: 'vertices per primitive (8 primitives, disjoint)',
        cases: [3, 6, 12].map((vertices) =>
          scalingCase('vertex-count', `${vertices} vertices`, gridScene(8, vertices)),
        ),
      },
      {
        name: 'AABB overlap density (6 isolated pairs, no intersections)',
        cases: [0, 3, 6].map((overlaps) =>
          scalingCase(
            'aabb-overlap',
            `${(overlaps / 6) * 100}% overlapping`,
            aabbOverlapScene(overlaps),
          ),
        ),
      },
      {
        name: 'actual intersection density (8 fixed AABB pairs)',
        cases: [0, 4, 8].map((intersections) =>
          scalingCase(
            'intersection-density',
            `${(intersections / 8) * 100}% intersecting`,
            intersectionScene(intersections),
          ),
        ),
      },
    ]
    const cases = families.flatMap((family) => family.cases)

    for (const benchmarkCase of cases) {
      expect(analyzeHiddenLineWorkload(benchmarkCase.scene)).toEqual(
        benchmarkCase.workload,
      )
    }
    const intersectionWorkloads = families[3].cases.map(({ workload }) => workload)
    expect(intersectionWorkloads[1]).toEqual(intersectionWorkloads[0])
    expect(intersectionWorkloads[2]).toEqual(intersectionWorkloads[0])
    const intersectionOutputs = families[3].cases.map(({ scene }) =>
      sceneChecksum(hiddenLinePass(scene, { tolerance: 0 })),
    )
    expect(new Set(intersectionOutputs).size).toBe(intersectionOutputs.length)

    const timings = measureCases(
      samples,
      warmups,
      cases.map((benchmarkCase) => ({
        name: benchmarkCase.name,
        operation: () => {
          const result = hiddenLinePass(benchmarkCase.scene, { tolerance: 0 })
          return result.primitives.length + result.primitives[0].points[0][0]
        },
      })),
    )

    console.log('\nSynthetic hidden-line scaling (dedicated opt-in config only)')
    console.log(
      'case                   filled  segments aabb-pairs edge-compares  work-units  median-ms    p95-ms',
    )
    for (const family of families) {
      console.log(`\n${family.name}`)
      for (const benchmarkCase of family.cases) {
        reportScaling(benchmarkCase, timings[benchmarkCase.name], samples)
      }
    }

    const representative = scalingCase(
      'observation-overhead',
      '12 fully overlapping hexagons',
      denseOverlapScene(),
    )
    let observedSnapshots = 0
    const overhead = measureCases(samples, warmups, [
      {
        name: 'unobserved',
        operation: () => {
          const result = hiddenLinePass(representative.scene, { tolerance: 0 })
          return result.primitives.length + result.primitives[0].points[0][0]
        },
      },
      {
        name: 'observed',
        operation: () => {
          const result = hiddenLinePass(representative.scene, {
            tolerance: 0,
            observer: (progress) => {
              observedSnapshots += progress.terminal ? 2 : 1
            },
          })
          return result.primitives.length + result.primitives[0].points[0][0]
        },
      },
    ])
    expect(observedSnapshots).toBeGreaterThan(0)
    console.log(`\nObservation overhead (${representative.label})`)
    reportOverhead('Hidden-line pass', overhead.unobserved, overhead.observed)
  })
})
