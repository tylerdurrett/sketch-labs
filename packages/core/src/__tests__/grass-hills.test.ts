import { describe, expect, it } from 'vitest'

import { clipSceneToBounds } from '../clipToBounds'
import { analyzeHiddenLineWorkload, hiddenLinePass } from '../hiddenLine'
import type { PlotProfile } from '../plotProfile'
import { renderPlotterSVG } from '../plotterSvg'
import type { CoordinateSpace, Scene } from '../scene'
import { randomize } from '../sketch'
import { grassHills } from '../sketches/grass-hills'
import { layoutHillBands } from '../sketches/grass-hills/depth'
import { ridgelineYAtX } from '../sketches/grass-hills/grass-placement'
import { buildRidgeBands } from '../sketches/grass-hills/ridge-bands'
import { createTerrainField } from '../sketches/grass-hills/terrain'

const SQUARE: CoordinateSpace = { width: 1000, height: 1000 }
const WIDE: CoordinateSpace = { width: 1600, height: 900 }

const SCHEMA_KEYS = [
  'hillCount',
  'horizonHeight',
  'depthFalloff',
  'foregroundZoom',
  'ridgeScale',
  'ridgeAmplitude',
  'terrainDrift',
  'bladeDensity',
  'bladeLength',
  'bladeLengthVariance',
  'bladeWidth',
  'stiffnessVariance',
  'windLean',
  'backgroundColor',
  'hillColor',
  'hillStrokeColor',
  'bladeColor',
  'bladeStrokeColor',
]

function hills(scene: Scene) {
  return scene.primitives.filter(({ closed }) => closed === false)
}

function blades(scene: Scene) {
  return scene.primitives.filter(({ closed }) => closed === true)
}

function geometry(scene: Scene): Array<Array<[number, number]>> {
  return scene.primitives.map((primitive) =>
    primitive.points.map(([x, y]) => [x, y]),
  )
}

function pathGeometry(scene: Scene) {
  return scene.primitives.map(({ points, closed }) => ({ points, closed }))
}

function ridgelinePoints(scene: Scene): Array<Array<[number, number]>> {
  return hills(scene).map((primitive) => primitive.points.slice(0, -3))
}

function isFrameEdgeSegment(
  [start, end]: [[number, number], [number, number]],
  frame: CoordinateSpace,
): boolean {
  if (start[0] === end[0] && start[1] === end[1]) return false
  return (
    (start[0] === 0 && end[0] === 0) ||
    (start[0] === frame.width && end[0] === frame.width) ||
    (start[1] === frame.height && end[1] === frame.height)
  )
}

type Segment = [[number, number], [number, number]]

function segmentParameter(
  [x, y]: [number, number],
  [[startX, startY], [endX, endY]]: Segment,
): number {
  const dx = endX - startX
  const dy = endY - startY
  return Math.abs(dx) >= Math.abs(dy)
    ? (x - startX) / dx
    : (y - startY) / dy
}

function isCollinear(
  [x, y]: [number, number],
  [[startX, startY], [endX, endY]]: Segment,
): boolean {
  const dx = endX - startX
  const dy = endY - startY
  const cross = (x - startX) * dy - (y - startY) * dx
  return Math.abs(cross) <= 1e-8 * Math.max(1, Math.hypot(dx, dy))
}

/** Exact output segments and contiguous collinear fragments both count. */
function outputCoversSegment(scene: Scene, source: Segment): boolean {
  const intervals: Array<[number, number]> = []

  for (const primitive of scene.primitives) {
    for (let index = 1; index < primitive.points.length; index++) {
      const start = primitive.points[index - 1]!
      const end = primitive.points[index]!
      if (!isCollinear(start, source) || !isCollinear(end, source)) continue
      const low = Math.max(
        0,
        Math.min(segmentParameter(start, source), segmentParameter(end, source)),
      )
      const high = Math.min(
        1,
        Math.max(segmentParameter(start, source), segmentParameter(end, source)),
      )
      if (high >= low) intervals.push([low, high])
    }
  }

  intervals.sort((a, b) => a[0] - b[0])
  let coveredThrough = 0
  for (const [low, high] of intervals) {
    if (low > coveredThrough + 1e-8) break
    coveredThrough = Math.max(coveredThrough, high)
  }
  return coveredThrough >= 1 - 1e-8
}

describe('grass-hills Sketch contract', () => {
  it('declares the flat Terrain-Grass-Colors schema with physical defaults', () => {
    expect(Object.keys(grassHills.schema)).toEqual(SCHEMA_KEYS)
    expect(grassHills.schema).toEqual({
      hillCount: {
        kind: 'number',
        min: 1,
        max: 256,
        default: 10,
        step: 1,
        integer: true,
      },
      horizonHeight: {
        kind: 'number',
        min: 0,
        max: 0.9,
        default: 0.25,
        step: 0.01,
      },
      depthFalloff: {
        kind: 'number',
        min: 0.25,
        max: 4,
        default: 2,
        step: 0.05,
      },
      foregroundZoom: {
        kind: 'number',
        min: 1,
        max: 2,
        default: 1,
        step: 0.05,
      },
      ridgeScale: {
        kind: 'number',
        min: 0.25,
        max: 12,
        default: 3.5,
        step: 0.05,
      },
      ridgeAmplitude: {
        kind: 'number',
        min: 0,
        max: 25,
        default: 0.8,
        step: 0.01,
      },
      terrainDrift: {
        kind: 'number',
        min: 0,
        max: 8,
        default: 1.25,
        step: 0.05,
      },
      bladeDensity: {
        kind: 'number',
        min: 0,
        max: 10,
        default: 0,
        step: 0.05,
      },
      bladeLength: {
        kind: 'number',
        min: 4,
        max: 80,
        default: 28,
        step: 1,
      },
      bladeLengthVariance: {
        kind: 'number',
        min: 0,
        max: 40,
        default: 8,
        step: 1,
      },
      bladeWidth: {
        kind: 'number',
        min: 0.5,
        max: 12,
        default: 3,
        step: 0.1,
      },
      stiffnessVariance: {
        kind: 'number',
        min: 0,
        max: 1,
        default: 0.25,
        step: 0.05,
      },
      windLean: {
        kind: 'number',
        min: -1,
        max: 1,
        default: 0,
        step: 0.05,
      },
      backgroundColor: { kind: 'color', default: '#ffffff' },
      hillColor: { kind: 'color', default: '#ffffff' },
      hillStrokeColor: { kind: 'color', default: '#000000' },
      bladeColor: { kind: 'color', default: '#ffffff' },
      bladeStrokeColor: { kind: 'color', default: '#000000' },
    })
    expect(grassHills.schema.hillCount.integer).toBe(true)
    expect(grassHills.time).toBeUndefined()
  })

  it.each([
    ['square', SQUARE],
    ['non-square', WIDE],
  ])('composes into the exact supplied %s frame', (_label, frame) => {
    const scene = grassHills.generate({ bladeDensity: 0.004 }, 'frame', 0, frame)

    expect(scene.space).toEqual(frame)
    expect(scene.space).not.toBe(frame)
    expect(scene.background).toEqual({ color: '#ffffff' })
    expect(hills(scene)).toHaveLength(10)
    expect(blades(scene).length).toBeGreaterThan(0)
  })

  it('uses hillCount as the open ridge-ring count', () => {
    expect(
      hills(
        grassHills.generate(
          { hillCount: 1, bladeDensity: 0 },
          'count',
          0,
          SQUARE,
        ),
      ),
    ).toHaveLength(1)
    expect(
      hills(
        grassHills.generate(
          { hillCount: 37, bladeDensity: 0 },
          'count',
          0,
          SQUARE,
        ),
      ),
    ).toHaveLength(37)
  })

  it('renders literally no blades when bladeDensity is zero', () => {
    const scene = grassHills.generate(
      { hillCount: 10, bladeDensity: 0 },
      'zero-density',
      0,
      SQUARE,
    )

    expect(hills(scene)).toHaveLength(10)
    expect(blades(scene)).toHaveLength(0)
  })

  it('emits filled and stroked explicit rings with open path metadata', () => {
    const scene = grassHills.generate(
      {
        hillCount: 3,
        bladeDensity: 0,
        backgroundColor: '#f7f3e8',
        hillColor: '#88aa55',
        hillStrokeColor: '#102010',
      },
      'rings',
      0,
      WIDE,
    )

    expect(scene.background).toEqual({ color: '#f7f3e8' })
    for (const primitive of hills(scene)) {
      expect(primitive.fill).toEqual({ color: '#88aa55' })
      expect(primitive.stroke).toEqual({ color: '#102010', width: 1 })
      expect(primitive.closed).toBe(false)
      expect(primitive.points.at(-1)).toEqual(primitive.points[0])
      expect(primitive.points[0]![0]).toBeLessThan(0)
      expect(primitive.points.at(-4)![0]).toBeGreaterThan(WIDE.width)
      expect(primitive.points.at(-3)![1]).toBeGreaterThan(WIDE.height)
      expect(primitive.points.at(-2)![1]).toBeGreaterThan(WIDE.height)
    }
  })

  it('emits each hill before closed blades sorted by root y then x', () => {
    const scene = grassHills.generate(
      {
        hillCount: 4,
        bladeDensity: 0.004,
        ridgeAmplitude: 0,
        bladeColor: '#ddeeaa',
        bladeStrokeColor: '#203010',
      },
      'blade-order',
      0,
      WIDE,
    )
    let hillGroups = 0
    let roots: Array<[number, number]> = []

    const assertSortedRoots = () => {
      for (let index = 1; index < roots.length; index++) {
        const [previousX, previousY] = roots[index - 1]!
        const [x, y] = roots[index]!
        expect(y > previousY || (y === previousY && x >= previousX)).toBe(true)
      }
    }

    for (const primitive of scene.primitives) {
      if (primitive.closed === false) {
        if (hillGroups > 0) assertSortedRoots()
        hillGroups++
        roots = []
        continue
      }

      expect(hillGroups).toBeGreaterThan(0)
      expect(primitive.closed).toBe(true)
      expect(primitive.fill).toEqual({ color: '#ddeeaa' })
      expect(primitive.stroke).toEqual({ color: '#203010', width: 0.7 })
      expect(primitive.points.at(-1)).toEqual(primitive.points[0])
      roots.push([...primitive.points[0]!] as [number, number])
    }

    assertSortedRoots()
    expect(hillGroups).toBe(4)
    expect(blades(scene).length).toBeGreaterThan(0)
  })

  it('preserves far-to-near painter order', () => {
    const scene = grassHills.generate(
      { hillCount: 8, ridgeAmplitude: 0, bladeDensity: 0 },
      'painter-order',
      0,
      SQUARE,
    )
    const baselineYs = hills(scene).map((primitive) => primitive.points[0]![1])

    for (let index = 1; index < baselineYs.length; index++) {
      expect(baselineYs[index]).toBeGreaterThan(baselineYs[index - 1]!)
    }
  })
})

describe('grass-hills preparation and determinism', () => {
  const params = {
    hillCount: 7,
    horizonHeight: 0.31,
    depthFalloff: 2.4,
    foregroundZoom: 1,
    ridgeScale: 4.25,
    ridgeAmplitude: 0.72,
    terrainDrift: 2.1,
    bladeDensity: 0.004,
    bladeLength: 28,
    bladeLengthVariance: 8,
    bladeWidth: 3,
    stiffnessVariance: 0.25,
    windLean: 0.2,
    backgroundColor: '#faf7ed',
    hillColor: '#8ea769',
    hillStrokeColor: '#172211',
    bladeColor: '#dce8bd',
    bladeStrokeColor: '#26351b',
  }

  it('makes warm and cold generation byte-identical', () => {
    const warm = grassHills.prepare(params, 'warm-cold', WIDE)(3.5)
    const cold = grassHills.generate(params, 'warm-cold', 3.5, WIDE)

    expect(warm).toEqual(cold)
  })

  it('returns identical static scenes for different t values', () => {
    const sample = grassHills.prepare(params, 'static-time', WIDE)

    expect(sample(-100)).toEqual(sample(0))
    expect(sample(0)).toEqual(sample(1234.5))
  })

  it('returns the identical Scene for identical params, Seed, t, and frame', () => {
    const first = grassHills.generate(params, 'terrain-a', 0, WIDE)
    const repeated = grassHills.generate(params, 'terrain-a', 0, WIDE)

    expect(first).toEqual(repeated)
  })

  it('remains stateless when unrelated calls are interleaved', () => {
    const firstA = grassHills.generate(params, 'interleaved-a', -4, WIDE)
    const firstB = grassHills.generate(
      { ...params, hillCount: 3, ridgeScale: 11 },
      'interleaved-b',
      99,
      SQUARE,
    )
    const secondA = grassHills.generate(params, 'interleaved-a', -4, WIDE)
    const secondB = grassHills.generate(
      { ...params, hillCount: 3, ridgeScale: 11 },
      'interleaved-b',
      99,
      SQUARE,
    )

    expect(secondA).toEqual(firstA)
    expect(secondB).toEqual(firstB)
  })

  it('changes geometry when reseeded', () => {
    const first = grassHills.generate(params, 'terrain-a', 0, WIDE)
    const reseeded = grassHills.generate(params, 'terrain-b', 0, WIDE)

    expect(geometry(first)).not.toEqual(geometry(reseeded))
  })

  it.each([
    ['backgroundColor', '#010203'],
    ['hillColor', '#aabbcc'],
    ['hillStrokeColor', '#ddeeff'],
    ['bladeColor', '#112233'],
    ['bladeStrokeColor', '#445566'],
  ] as const)(
    'keeps points and path metadata byte-identical when only %s changes',
    (key, color) => {
      const base = grassHills.generate(params, 'colors', 0, WIDE)
      const recolored = grassHills.generate(
        { ...params, [key]: color },
        'colors',
        0,
        WIDE,
      )

      expect(pathGeometry(recolored)).toEqual(pathGeometry(base))
    },
  )

  it('randomizes unlocked numeric schema fields while preserving locks, integer count, and colors', () => {
    const locks = new Set(['depthFalloff'])
    const randomized = randomize(grassHills.schema, params, locks, () => 0.37)

    for (const key of [
      'hillCount',
      'horizonHeight',
      'foregroundZoom',
      'ridgeScale',
      'ridgeAmplitude',
      'terrainDrift',
      'bladeDensity',
      'bladeLength',
      'bladeLengthVariance',
      'bladeWidth',
      'stiffnessVariance',
      'windLean',
    ] as const) {
      expect(randomized[key]).not.toBe(params[key])
    }
    expect(randomized.depthFalloff).toBe(params.depthFalloff)
    expect(Number.isInteger(randomized.hillCount)).toBe(true)
    expect(randomized.backgroundColor).toBe(params.backgroundColor)
    expect(randomized.hillColor).toBe(params.hillColor)
    expect(randomized.hillStrokeColor).toBe(params.hillStrokeColor)
    expect(randomized.bladeColor).toBe(params.bladeColor)
    expect(randomized.bladeStrokeColor).toBe(params.bladeStrokeColor)
  })

  it('keeps the original terrain geometry for the same terrain inputs and seed', () => {
    const seed = 'terrain-stream'
    const scene = grassHills.generate(params, seed, 0, WIDE)
    const projection = {
      frame: WIDE,
      horizonHeight: params.horizonHeight,
      depthFalloff: params.depthFalloff,
    }
    const bands = layoutHillBands(params.hillCount, projection)
    const expected = buildRidgeBands({
      frame: WIDE,
      bands,
      terrainAt: createTerrainField(seed, {
        ridgeScale: params.ridgeScale,
        terrainDrift: params.terrainDrift,
      }),
      ridgeAmplitude: params.ridgeAmplitude,
      ridgeSamples: 128,
    })

    expect(hills(scene).map(({ points }) => points)).toEqual(
      expected.map(({ points }) => points),
    )
  })

  it('retraces blades into fresh Scene-owned containers and resists caller mutation', () => {
    const sample = grassHills.prepare(params, 'isolated', WIDE)
    const first = sample(0)
    const pristine = sample(1)
    const firstBlade = blades(first)[0]!
    const pristineBlade = blades(pristine)[0]!

    expect(first).toEqual(pristine)
    expect(first).not.toBe(pristine)
    expect(first.space).not.toBe(pristine.space)
    expect(first.background).not.toBe(pristine.background)
    expect(first.primitives).not.toBe(pristine.primitives)
    expect(first.primitives[0]).not.toBe(pristine.primitives[0])
    expect(first.primitives[0]!.points).not.toBe(pristine.primitives[0]!.points)
    expect(first.primitives[0]!.points[0]).not.toBe(pristine.primitives[0]!.points[0])
    expect(first.primitives[0]!.fill).not.toBe(pristine.primitives[0]!.fill)
    expect(first.primitives[0]!.stroke).not.toBe(pristine.primitives[0]!.stroke)
    expect(firstBlade).not.toBe(pristineBlade)
    expect(firstBlade.points).not.toBe(pristineBlade.points)
    expect(firstBlade.points[0]).not.toBe(pristineBlade.points[0])
    expect(firstBlade.fill).not.toBe(pristineBlade.fill)
    expect(firstBlade.stroke).not.toBe(pristineBlade.stroke)

    first.space.width = -1
    first.background!.color = '#000000'
    first.primitives[0]!.points[0]![0] = Number.NaN
    first.primitives[0]!.fill!.color = '#000000'
    first.primitives[0]!.stroke!.width = 999
    firstBlade.points[0]![0] = Number.NaN
    firstBlade.fill!.color = '#000000'
    firstBlade.stroke!.width = 999
    firstBlade.points.splice(0)
    first.primitives.reverse()

    expect(sample(2)).toEqual(pristine)
  })
})

describe('grass-hills public geometry acceptance', () => {
  it.each([
    ['minimum horizon and falloff', 0, 0.25, 0.25, 0],
    ['minimum horizon and maximum falloff', 0, 4, 12, 8],
    ['maximum horizon and minimum falloff', 0.9, 0.25, 12, 8],
    ['maximum horizon and falloff', 0.9, 4, 0.25, 0],
  ])(
    'keeps generated ridge geometry finite at %s',
    (_label, horizonHeight, depthFalloff, ridgeScale, terrainDrift) => {
      const scene = grassHills.generate(
        {
          hillCount: 256,
          horizonHeight,
          depthFalloff,
          ridgeScale,
          ridgeAmplitude: 25,
          terrainDrift,
          bladeDensity: 0,
        },
        'public-extremes',
        0,
        WIDE,
      )
      const ridges = ridgelinePoints(scene)

      for (const ridge of ridges) {
        expect(
          ridge.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)),
        ).toBe(true)
      }
    },
  )

  it('builds a fuzzy silhouette with ridge-crossing tips in every dense hill group', () => {
    const source = grassHills.generate(
      {
        hillCount: 3,
        ridgeAmplitude: 0,
        bladeDensity: 0.04,
        bladeLength: 80,
        bladeLengthVariance: 0,
        bladeWidth: 3,
        stiffnessVariance: 0,
        windLean: 0,
      },
      'dense-silhouette',
      0,
      SQUARE,
    )
    let currentRidge = source.primitives[0]!
    let hillIndex = -1
    const crossingsByHill = [0, 0, 0]

    for (const primitive of source.primitives) {
      if (primitive.closed === false) {
        currentRidge = primitive
        hillIndex++
        continue
      }

      const root = primitive.points[0]!
      const tip = primitive.points[(primitive.points.length - 1) / 2]!
      const ridgeY = ridgelineYAtX(currentRidge, root[0])
      if (root[1] > ridgeY && tip[1] < ridgeY) crossingsByHill[hillIndex]++
    }

    expect(crossingsByHill).toHaveLength(3)
    expect(crossingsByHill.every((count) => count >= 2)).toBe(true)
    expect(crossingsByHill.reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(8)
  })

  it('preserves a known interior segment from the final unoccluded blade', () => {
    const source = grassHills.generate(
      {
        hillCount: 1,
        ridgeAmplitude: 0,
        bladeDensity: 0.0016,
        bladeLength: 4,
        bladeLengthVariance: 0,
        bladeWidth: 0.5,
        stiffnessVariance: 0,
        windLean: 0,
      },
      'surviving-blade',
      0,
      SQUARE,
    )
    const finalBlade = source.primitives.at(-1)!
    const segment: Segment = [finalBlade.points[5]!, finalBlade.points[6]!]

    expect(finalBlade.closed).toBe(true)
    expect(finalBlade.fill).toBeDefined()
    expect(source.primitives.at(-1)).toBe(finalBlade)
    expect(
      segment.every(
        ([x, y]) => x > 0 && x < SQUARE.width && y > 0 && y < SQUARE.height,
      ),
    ).toBe(true)

    const output = clipSceneToBounds(hiddenLinePass(source, { tolerance: 0 }))
    expect(outputCoversSegment(output, segment)).toBe(true)
  })

  it('survives the real outline and bounds pipeline as visible open linework', () => {
    const source = grassHills.generate(
      {
        hillCount: 5,
        horizonHeight: 0.25,
        ridgeAmplitude: 25,
        bladeDensity: 0.002,
      },
      'outline-acceptance',
      0,
      WIDE,
    )
    const outline = clipSceneToBounds(hiddenLinePass(source))

    expect(
      source.primitives.some((primitive) =>
        primitive.points.some(
          ([x, y]) => x < 0 || x > WIDE.width || y < 0 || y > WIDE.height,
        ),
      ),
    ).toBe(true)
    expect(outline.primitives.length).toBeGreaterThan(0)
    expect(outline.background).toBeUndefined()
    expect(
      outline.primitives.some((primitive) =>
        primitive.points.some(
          ([x, y]) =>
            x === 0 || x === WIDE.width || y === 0 || y === WIDE.height,
        ),
      ),
    ).toBe(true)
    for (const primitive of outline.primitives) {
      expect(primitive.stroke).toBeDefined()
      expect(primitive.fill).toBeUndefined()
      expect(primitive.closed).not.toBe(true)
      expect(primitive.points.length).toBeGreaterThan(1)
      expect(
        primitive.points.every(
          ([x, y]) => x >= 0 && x <= WIDE.width && y >= 0 && y <= WIDE.height,
        ),
      ).toBe(true)

      const frameEdgeSegments = []
      for (let index = 1; index < primitive.points.length; index++) {
        const segment: [[number, number], [number, number]] = [
          primitive.points[index - 1]!,
          primitive.points[index]!,
        ]
        if (isFrameEdgeSegment(segment, WIDE)) frameEdgeSegments.push(segment)
      }
      expect(frameEdgeSegments).toEqual([])
    }
  })

  it('serializes the processed Scene as path-only plotter geometry with no frame or closure chord', () => {
    const source = grassHills.generate(
      { hillCount: 5, ridgeAmplitude: 25, bladeDensity: 0.002 },
      'plotter-acceptance',
      0,
      WIDE,
    )
    const outline = clipSceneToBounds(hiddenLinePass(source))
    const profile: PlotProfile = {
      width: 180,
      height: 100,
      insets: { top: 5, right: 10, bottom: 5, left: 10 },
      includeFrame: true,
    }
    const svg = renderPlotterSVG(outline, profile)
    const paths = svg.match(/<path\b[^>]*>/g) ?? []

    expect(paths).toHaveLength(outline.primitives.length)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.every((path) => path.includes('fill="none"'))).toBe(true)
    expect(paths.every((path) => !/\bZ\b/.test(path))).toBe(true)
    expect(svg).not.toMatch(/<(?:rect|line|polyline|polygon|circle|ellipse)\b/)
    expect(svg).not.toContain(source.background!.color)
  })
})

describe('grass-hills hidden-line workload inventory', () => {
  const seed = 'workload-inventory'

  it('pins deterministic small and bounded generation inventories', () => {
    const small = grassHills.generate(
      { hillCount: 1, bladeDensity: 0.0016, ridgeAmplitude: 0 },
      seed,
      0,
      SQUARE,
    )
    const bounded = grassHills.generate(
      { bladeDensity: 0.004 },
      seed,
      0,
      SQUARE,
    )

    expect(analyzeHiddenLineWorkload(small)).toEqual({
      filledPrimitiveCount: 9,
      sourceSegmentCount: 181,
      overlappingPairCount: 8,
      estimatedSegmentEdgeComparisons: 7_448,
      totalWorkUnits: 8_372,
    })
    expect(analyzeHiddenLineWorkload(bounded)).toEqual({
      filledPrimitiveCount: 30,
      sourceSegmentCount: 1_450,
      overlappingPairCount: 102,
      estimatedSegmentEdgeComparisons: 854_295,
      totalWorkUnits: 861_967,
    })
  })

  it('emits the adopted 10k count and inventories a hills-only diagnostic', () => {
    const maximum = grassHills.generate(
      {
        hillCount: 10,
        horizonHeight: 0.9,
        depthFalloff: 4,
        ridgeScale: 12,
        ridgeAmplitude: 25,
        terrainDrift: 8,
        bladeDensity: 2,
        bladeLength: 80,
        bladeLengthVariance: 40,
        bladeWidth: 12,
        stiffnessVariance: 1,
        windLean: 1,
      },
      seed,
      0,
      SQUARE,
    )

    expect(blades(maximum)).toHaveLength(10_000)

    const hillOnly = { ...maximum, primitives: hills(maximum) }
    expect(analyzeHiddenLineWorkload(hillOnly)).toEqual({
      filledPrimitiveCount: 10,
      sourceSegmentCount: 1_330,
      overlappingPairCount: 45,
      estimatedSegmentEdgeComparisons: 801_990,
      totalWorkUnits: 808_110,
    })
  })

  it('emits 50,000 blades at the extended density ceiling', () => {
    const maximum = grassHills.generate(
      { hillCount: 1, bladeDensity: 10 },
      seed,
      0,
      SQUARE,
    )

    expect(blades(maximum)).toHaveLength(50_000)
  })
})
