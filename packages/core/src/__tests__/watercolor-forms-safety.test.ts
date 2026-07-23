import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import type { CoordinateSpace, Scene } from '../scene'
import {
  defaultWatercolorFormsControls,
  normalizeWatercolorFormsControls,
  type WatercolorFormsControls,
} from '../sketches/watercolor-forms/controls'
import { extractWatercolorSharedBoundaries } from '../sketches/watercolor-forms/boundaries'
import { fitWatercolorBoundaryCurves } from '../sketches/watercolor-forms/curves'
import { selectWatercolorForms } from '../sketches/watercolor-forms/forms'
import { generateWatercolorForms } from '../sketches/watercolor-forms/generator'
import {
  buildWatercolorFormsHierarchyWithLimitsAndDiagnosticsForTest,
  buildWatercolorFormsHierarchyWithLimitsForTest,
} from '../sketches/watercolor-forms/hierarchy'
import { WATERCOLOR_FORMS_LIMITS } from '../sketches/watercolor-forms/limits'
import { partitionWatercolorFormsRaster } from '../sketches/watercolor-forms/partition'
import { prepareWatercolorFormsRaster } from '../sketches/watercolor-forms/analysis'
import { traceWatercolorBoundaryNetwork } from '../sketches/watercolor-forms/tracing'
import type {
  SharedBoundarySegment,
  WatercolorBoundaryPath,
  WatercolorFormsGeneratorResult,
} from '../sketches/watercolor-forms/types'
import type { Point } from '../types'

const FRAME: CoordinateSpace = Object.freeze({ width: 160, height: 100 })
const MAX_CONTROLS: WatercolorFormsControls = Object.freeze({
  formDetail: 1,
  colorSensitivity: 1,
  boundaryStrength: 0,
  boundarySmoothing: 1,
})

function pixels(
  width: number,
  height: number,
  rgba: (
    x: number,
    y: number,
  ) => readonly [number, number, number, number],
): DecodedPixels {
  return {
    width,
    height,
    data: Uint8Array.from(
      Array.from({ length: width * height }, (_, index) =>
        rgba(index % width, Math.floor(index / width)),
      ).flat(),
    ),
  }
}

function generate(
  source: Readonly<DecodedPixels>,
  controls: Readonly<WatercolorFormsControls> = MAX_CONTROLS,
  frame: Readonly<CoordinateSpace> = FRAME,
): WatercolorFormsGeneratorResult {
  return generateWatercolorForms({ pixels: source, controls, frame })
}

function allPoints(scene: Readonly<Scene>): readonly Readonly<Point>[] {
  return scene.primitives.flatMap((primitive) => primitive.points)
}

function expectFiniteBoundedResult(
  result: Readonly<WatercolorFormsGeneratorResult>,
  frame: Readonly<CoordinateSpace> = FRAME,
): void {
  const diagnostics = result.diagnostics
  expect(
    Object.values(diagnostics).every(
      (value) =>
        typeof value !== 'number' ||
        (Number.isFinite(value) && Number.isSafeInteger(value)),
    ),
  ).toBe(true)
  expect(diagnostics.analysisWidth).toBeLessThanOrEqual(
    WATERCOLOR_FORMS_LIMITS.analysisMaxDimension,
  )
  expect(diagnostics.analysisHeight).toBeLessThanOrEqual(
    WATERCOLOR_FORMS_LIMITS.analysisMaxDimension,
  )
  expect(diagnostics.sampleCount).toBeLessThanOrEqual(
    WATERCOLOR_FORMS_LIMITS.maxSampleCount,
  )
  expect(diagnostics.initialRegionCount).toBeLessThanOrEqual(
    WATERCOLOR_FORMS_LIMITS.maxInitialRegionCount,
  )
  expect(diagnostics.gridAdjacencyCount).toBeLessThanOrEqual(
    WATERCOLOR_FORMS_LIMITS.maxGridAdjacencyCount,
  )
  expect(diagnostics.mergeCount).toBeLessThanOrEqual(
    WATERCOLOR_FORMS_LIMITS.maxMergeCount,
  )
  expect(diagnostics.mergeQueueEntryCount).toBeLessThanOrEqual(
    WATERCOLOR_FORMS_LIMITS.maxMergeQueueEntryCount,
  )
  expect(diagnostics.regionUpdateCount).toBeLessThanOrEqual(
    WATERCOLOR_FORMS_LIMITS.maxRegionUpdateCount,
  )
  expect(diagnostics.retainedBoundarySegmentCount).toBeLessThanOrEqual(
    WATERCOLOR_FORMS_LIMITS.maxRetainedBoundarySegmentCount,
  )
  expect(diagnostics.boundaryPathCount).toBeLessThanOrEqual(
    WATERCOLOR_FORMS_LIMITS.maxBoundaryPathCount,
  )
  expect(diagnostics.curvePointCount).toBeLessThanOrEqual(
    WATERCOLOR_FORMS_LIMITS.maxCurvePointCount,
  )
  expect(diagnostics.primitiveCount).toBeLessThanOrEqual(
    WATERCOLOR_FORMS_LIMITS.maxPrimitiveCount,
  )
  expect(diagnostics.primitiveCount).toBe(result.scene.primitives.length)

  for (const primitive of result.scene.primitives) {
    expect(primitive.points.length).toBeGreaterThanOrEqual(
      primitive.closed === true ? 3 : 2,
    )
  }
  for (const [x, y] of allPoints(result.scene)) {
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
    expect(x).toBeGreaterThanOrEqual(0)
    expect(x).toBeLessThanOrEqual(frame.width)
    expect(y).toBeGreaterThanOrEqual(0)
    expect(y).toBeLessThanOrEqual(frame.height)
  }
}

function highEntropyRaster(
  size = WATERCOLOR_FORMS_LIMITS.analysisMaxDimension,
): DecodedPixels {
  return pixels(size, size, (x, y) => {
    const red = (x * 73 + y * 151 + ((x ^ y) * 19)) & 255
    const green = (x * 193 + y * 47 + ((x * y) % 251)) & 255
    const blue = (x * 29 + y * 227 + ((x + y) * 83)) & 255
    return [red, green, blue, 255]
  })
}

function segment(
  id: number,
  start: Readonly<Point>,
  end: Readonly<Point>,
): Readonly<SharedBoundarySegment> {
  return Object.freeze({
    id,
    regionIds: Object.freeze([0, 1]) as readonly [number, number],
    start: Object.freeze([...start]) as Readonly<Point>,
    end: Object.freeze([...end]) as Readonly<Point>,
    strength: 1,
    provenance: 'visible-color',
  })
}

function path(
  ids: readonly number[],
  points: readonly Readonly<Point>[],
): Readonly<WatercolorBoundaryPath> {
  return Object.freeze({
    points: Object.freeze(
      points.map((point) => Object.freeze([...point]) as Readonly<Point>),
    ),
    closed: false,
    boundarySegmentIds: Object.freeze([...ids]),
  })
}

describe('Watercolor Forms adversarial generator safety', () => {
  it.each([
    [
      'empty decoded storage',
      { width: 0, height: 0, data: new Uint8Array() },
      'invalid-input',
    ],
    [
      'fractional dimensions',
      { width: 1.5, height: 2, data: new Uint8Array(12) },
      'invalid-input',
    ],
    [
      'negative dimensions',
      { width: -1, height: 2, data: new Uint8Array() },
      'invalid-input',
    ],
    [
      'non-finite dimensions',
      { width: Number.POSITIVE_INFINITY, height: 2, data: new Uint8Array() },
      'invalid-input',
    ],
    [
      'short RGBA storage',
      { width: 2, height: 2, data: new Uint8Array(15) },
      'invalid-input',
    ],
    [
      'long RGBA storage',
      { width: 2, height: 2, data: new Uint8Array(17) },
      'invalid-input',
    ],
    ['null raster', null, 'invalid-input'],
    ['missing raster fields', {}, 'invalid-input'],
    [
      'ordinary numeric storage',
      { width: 1, height: 1, data: [0, 0, 0, 255] },
      'invalid-input',
    ],
  ] as const)(
    'fails closed for %s',
    (_name, malformed, termination) => {
      const result = generate(malformed as DecodedPixels)

      expect(result.diagnostics.termination).toBe(termination)
      expect(result.diagnostics.limitedBy).toBeNull()
      expect(result.scene.primitives).toEqual([])
      expectFiniteBoundedResult(result)
    },
  )

  it.each([
    [
      'fully transparent hidden noise',
      pixels(17, 11, (x, y) => [
        (x * 71 + y * 13) & 255,
        (x * 19 + y * 89) & 255,
        (x * 43 + y * 31) & 255,
        0,
      ]),
    ],
    ['flat opaque', pixels(17, 11, () => [127, 127, 127, 255])],
    ['one pixel', pixels(1, 1, () => [255, 0, 0, 255])],
    [
      'one by many',
      pixels(1, 257, (_x, y) =>
        y < 128 ? [20, 60, 220, 255] : [230, 180, 20, 255],
      ),
    ],
    [
      'many by one',
      pixels(257, 1, (x) =>
        x < 128 ? [20, 60, 220, 255] : [230, 180, 20, 255],
      ),
    ],
    [
      'extreme portrait aspect',
      pixels(1, 8_192, (_x, y) =>
        y % 37 < 18 ? [16, 16, 16, 255] : [240, 240, 240, 255],
      ),
    ],
    [
      'extreme landscape aspect',
      pixels(8_192, 1, (x) =>
        x % 37 < 18 ? [16, 16, 16, 255] : [240, 240, 240, 255],
      ),
    ],
    [
      'checkerboard',
      pixels(33, 31, (x, y) =>
        (x + y) % 2 === 0
          ? [12, 240, 72, 255]
          : [236, 28, 208, 255],
      ),
    ],
    [
      'alpha silhouette with holes',
      pixels(31, 29, (x, y) => {
        const outer = x >= 3 && x < 28 && y >= 3 && y < 26
        const hole = x >= 11 && x < 20 && y >= 10 && y < 19
        return [90, 130, 180, outer && !hole ? 255 : 0]
      }),
    ],
  ])('terminates with bounded finite geometry for %s', (_name, source) => {
    const result = generate(source)

    expect(['complete', 'limit-reached']).toContain(
      result.diagnostics.termination,
    )
    if (result.diagnostics.termination === 'complete') {
      expect(result.diagnostics.limitedBy).toBeNull()
    } else {
      expect(result.diagnostics.limitedBy).not.toBeNull()
    }
    expectFiniteBoundedResult(result)
  })

  it('ignores every hidden-RGB variation behind exact-zero alpha', () => {
    const source = (hidden: readonly [number, number, number]) =>
      pixels(25, 23, (x, y) => {
        const silhouette = x >= 3 && x < 22 && y >= 2 && y < 21
        const hole = x >= 9 && x < 16 && y >= 8 && y < 15
        return silhouette && !hole
          ? [110, 150, 190, 255]
          : [hidden[0], hidden[1], hidden[2], 0]
      })

    const black = generate(source([0, 0, 0]))
    const magenta = generate(source([255, 0, 255]))
    const pseudoRandom = generate(
      pixels(25, 23, (x, y) => {
        const silhouette = x >= 3 && x < 22 && y >= 2 && y < 21
        const hole = x >= 9 && x < 16 && y >= 8 && y < 15
        return silhouette && !hole
          ? [110, 150, 190, 255]
          : [
              (x * 197 + y * 53) & 255,
              (x * 29 + y * 211) & 255,
              (x * 101 + y * 71) & 255,
              0,
            ]
      }),
    )

    expect(magenta).toEqual(black)
    expect(pseudoRandom).toEqual(black)
    expect(black.scene.primitives.length).toBeGreaterThan(0)
    expectFiniteBoundedResult(black)
  })

  it('normalizes non-finite and out-of-range controls without non-finite work', () => {
    const source = pixels(19, 13, (x, y) =>
      x < 6
        ? [30, 80, 210, 255]
        : y < 7
          ? [230, 80, 40, 255]
          : [40, 210, 100, 255],
    )
    const malformed = {
      formDetail: Number.NaN,
      colorSensitivity: Number.POSITIVE_INFINITY,
      boundaryStrength: Number.NEGATIVE_INFINITY,
      boundarySmoothing: Number.NaN,
    } as WatercolorFormsControls
    const outOfRange = {
      formDetail: -1e300,
      colorSensitivity: 1e300,
      boundaryStrength: -1e300,
      boundarySmoothing: 1e300,
    } as WatercolorFormsControls

    const malformedResult = generate(source, malformed)
    const outOfRangeResult = generate(source, outOfRange)

    expect(malformedResult).toEqual(
      generate(source, defaultWatercolorFormsControls),
    )
    expect(outOfRangeResult).toEqual(
      generate(source, normalizeWatercolorFormsControls(outOfRange)),
    )
    expectFiniteBoundedResult(malformedResult)
    expectFiniteBoundedResult(outOfRangeResult)
  })

  it(
    'returns useful deterministic simplified geometry at maximum admitted high-entropy pressure',
    () => {
      const source = highEntropyRaster()
      const first = generate(source)
      const second = generate(source)

      expect(second).toEqual(first)
      expect(first.diagnostics).toMatchObject({
        analysisWidth: WATERCOLOR_FORMS_LIMITS.analysisMaxDimension,
        analysisHeight: WATERCOLOR_FORMS_LIMITS.analysisMaxDimension,
        sampleCount: WATERCOLOR_FORMS_LIMITS.maxSampleCount,
      })
      expect(first.diagnostics.termination).toBe('limit-reached')
      expect(first.diagnostics.limitedBy).toBe('maxMergeQueueEntryCount')
      expect(first.scene.primitives.length).toBeGreaterThan(0)
      expect(first.diagnostics.boundaryPathCount).toBeLessThan(
        first.diagnostics.retainedBoundarySegmentCount,
      )
      expect(first.diagnostics.curvePointCount).toBeLessThan(
        first.diagnostics.retainedBoundarySegmentCount * 2,
      )
      expectFiniteBoundedResult(first)
    },
    120_000,
  )
})

describe('Watercolor Forms useful deterministic cap prefixes', () => {
  const source = pixels(12, 8, (x, y) => {
    if (x < 4) return [20, 40, 220, 255]
    if (x < 8) return [230, 60, 30, 255]
    return [30, 210, 80, 255]
  })
  const prepared = prepareWatercolorFormsRaster(source, FRAME)
  const partition = partitionWatercolorFormsRaster(prepared)

  it.each([
    [
      'maxMergeCount',
      { maxMergeCount: 1 },
    ],
    [
      'maxMergeQueueEntryCount',
      { maxMergeQueueEntryCount: 1 },
    ],
    [
      'maxRegionUpdateCount',
      { maxRegionUpdateCount: 0 },
    ],
  ] as const)(
    'keeps useful deterministic downstream geometry when %s is exhausted',
    (limitedBy, limits) => {
      const run = () => {
        const hierarchy =
          buildWatercolorFormsHierarchyWithLimitsAndDiagnosticsForTest(
            partition,
            1,
            limits,
          )
        const selected = selectWatercolorForms(hierarchy.hierarchy, 1)
        const boundaries = extractWatercolorSharedBoundaries(selected, 0)
        const traced = traceWatercolorBoundaryNetwork(
          boundaries.sharedBoundarySegments,
        )
        const curves = fitWatercolorBoundaryCurves(traced.paths, 1, {
          latticeWidth: prepared.width,
          latticeHeight: prepared.height,
          positiveSupport: prepared.positiveSupport,
        })
        return { hierarchy, boundaries, traced, curves }
      }
      const first = run()
      const second = run()

      expect(second).toEqual(first)
      expect(first.hierarchy.hierarchy.complete).toBe(false)
      expect(first.hierarchy.diagnostics.limitedBy).toBe(limitedBy)
      expect(first.boundaries.sharedBoundarySegments.length).toBeGreaterThan(0)
      expect(first.traced.paths.length).toBeGreaterThan(0)
      expect(first.curves.length).toBeGreaterThan(0)
      expect(
        first.curves.flatMap((curve) => curve.points).every(([x, y]) =>
          Number.isFinite(x) && Number.isFinite(y),
        ),
      ).toBe(true)
    },
  )

  it('keeps a useful canonical boundary prefix at the boundary-segment cap', () => {
    const hierarchy = buildWatercolorFormsHierarchyWithLimitsForTest(
      partition,
      1,
      { maxMergeCount: 0 },
    )
    const selected = selectWatercolorForms(hierarchy, 1)
    const run = () =>
      extractWatercolorSharedBoundaries(selected, 0, {
        maxRetainedBoundarySegmentCount: 3,
      })
    const first = run()
    const second = run()
    const traced = traceWatercolorBoundaryNetwork(
      first.sharedBoundarySegments,
    )

    expect(second).toEqual(first)
    expect(first.sharedBoundarySegments).toHaveLength(3)
    expect(traced.paths.length).toBeGreaterThan(0)
    expect(traced.diagnostics.termination).toBe('complete')
  })

  it.each([
    [
      'maxRetainedBoundarySegmentCount',
      { maxRetainedBoundarySegmentCount: 2 },
    ],
    ['maxBoundaryPathCount', { maxBoundaryPathCount: 2 }],
  ] as const)(
    'returns a useful deterministic trace prefix at %s',
    (limitedBy, limits) => {
      const sourceSegments = [
        segment(1, [0, 0], [1, 0]),
        segment(2, [3, 0], [4, 0]),
        segment(3, [6, 0], [7, 0]),
      ]
      const first = traceWatercolorBoundaryNetwork(sourceSegments, limits)
      const second = traceWatercolorBoundaryNetwork(sourceSegments, limits)

      expect(second).toEqual(first)
      expect(first.diagnostics).toMatchObject({
        termination: 'limit-reached',
        limitedBy,
      })
      expect(first.paths.length).toBeGreaterThan(0)
      expect(first.diagnostics.consumedSegmentCount).toBeGreaterThan(0)
    },
  )

  it('returns a useful deterministic complete-path prefix at the curve-point cap', () => {
    const paths = [
      path(
        [1, 2],
        [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
      ),
      path(
        [3, 4],
        [
          [0, 2],
          [1, 2],
          [2, 2],
        ],
      ),
    ]
    const options = {
      latticeWidth: 3,
      latticeHeight: 3,
      maxPointCount: 3,
    }
    const first = fitWatercolorBoundaryCurves(paths, 1, options)
    const second = fitWatercolorBoundaryCurves(paths, 1, options)

    expect(second).toEqual(first)
    expect(first).toHaveLength(1)
    expect(first[0]!.boundarySegmentIds).toEqual([1, 2])
    expect(first[0]!.points.length).toBeGreaterThanOrEqual(2)
  })

  afterEach(() => {
    vi.doUnmock('../sketches/watercolor-forms/limits')
    vi.resetModules()
  })

  it('reports and preserves a useful generator prefix at the primitive cap', async () => {
    vi.resetModules()
    vi.doMock('../sketches/watercolor-forms/limits', async (importOriginal) => {
      const original = await importOriginal<
        typeof import('../sketches/watercolor-forms/limits')
      >()
      return {
        ...original,
        WATERCOLOR_FORMS_LIMITS: Object.freeze({
          ...original.WATERCOLOR_FORMS_LIMITS,
          maxPrimitiveCount: 1,
        }),
      }
    })
    const { generateWatercolorForms: generateWithPrimitiveLimit } =
      await import('../sketches/watercolor-forms/generator')
    const controls: WatercolorFormsControls = {
      formDetail: 1,
      colorSensitivity: 1,
      boundaryStrength: 0,
      boundarySmoothing: 0,
    }
    const input = {
      pixels: source,
      controls,
      frame: FRAME,
    }

    const first = generateWithPrimitiveLimit(input)
    const second = generateWithPrimitiveLimit(input)

    expect(second).toEqual(first)
    expect(first.diagnostics).toMatchObject({
      termination: 'limit-reached',
      limitedBy: 'maxPrimitiveCount',
      primitiveCount: 1,
    })
    expect(first.scene.primitives).toHaveLength(1)
    expect(allPoints(first.scene).length).toBeGreaterThanOrEqual(2)
  })
})
