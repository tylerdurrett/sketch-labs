import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import { createRasterContainFit } from '../rasterSampling'
import type { CoordinateSpace } from '../scene'
import {
  defaultFlowingContoursControls,
  type FlowingContoursControls,
} from '../sketches/flowing-contours/controls'
import {
  generateFlowingContours,
  type FlowingContoursGeneratorInput,
} from '../sketches/flowing-contours/generator'
import { FLOWING_CONTOURS_LIMITS } from '../sketches/flowing-contours/limits'
import {
  FLOWING_CONTOURS_LIMIT_NAMES,
  type FlowingContoursGeneratorResult,
  type FlowingContoursLimitName,
} from '../sketches/flowing-contours/types'
import type { Point } from '../types'

const FRAME: Readonly<CoordinateSpace> = Object.freeze({
  width: 240,
  height: 180,
})

const CONTROLS: Readonly<FlowingContoursControls> = Object.freeze({
  curveDetail: 1,
  continuity: 0.8,
  flowSmoothing: 0.8,
  minimumStrokeLength: 0.08,
})

const PRESSURE_LIMITS = Object.freeze({
  'candidate-count': 16,
  'accepted-curve-count': 6,
  'primitive-count': 6,
  'search-step-count': 768,
  'raw-trajectory-point-count': 512,
  'fitted-curve-point-count': 512,
})

function raster(
  width: number,
  height: number,
  at: (x: number, y: number) => readonly [number, number, number, number],
): DecodedPixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(at(x, y), (y * width + x) * 4)
    }
  }
  return Object.freeze({ width, height, data })
}

function boundaryRaster(
  width = 64,
  height = 48,
  boundaryX: (y: number) => number = () => width / 2,
): DecodedPixels {
  return raster(width, height, (x, y) =>
    x < boundaryX(y) ? [18, 18, 18, 255] : [238, 238, 238, 255],
  )
}

function generate(
  pixels: Readonly<DecodedPixels>,
  overrides: Partial<FlowingContoursGeneratorInput> = {},
): Readonly<FlowingContoursGeneratorResult> {
  return generateFlowingContours({
    pixels,
    frame: FRAME,
    controls: CONTROLS,
    ...overrides,
  })
}

function pathLength(
  points: readonly Readonly<Point>[],
  closed: boolean,
): number {
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(
      points[index]![0] - points[index - 1]![0],
      points[index]![1] - points[index - 1]![1],
    )
  }
  if (
    closed &&
    points.length > 0 &&
    (points[0]![0] !== points.at(-1)![0] || points[0]![1] !== points.at(-1)![1])
  ) {
    length += Math.hypot(
      points[0]![0] - points.at(-1)![0],
      points[0]![1] - points.at(-1)![1],
    )
  }
  return length
}

function expectSafeResult(
  result: Readonly<FlowingContoursGeneratorResult>,
  frame: Readonly<CoordinateSpace> = FRAME,
): void {
  const diagnostics = result.diagnostics

  expect(FLOWING_CONTOURS_LIMIT_NAMES).toHaveLength(14)
  expect(
    Object.values(diagnostics).every(
      (value) => typeof value !== 'number' || Number.isFinite(value),
    ),
  ).toBe(true)
  expect(diagnostics.analysisWidth).toBeLessThanOrEqual(
    FLOWING_CONTOURS_LIMITS['analysis-dimension'],
  )
  expect(diagnostics.analysisHeight).toBeLessThanOrEqual(
    FLOWING_CONTOURS_LIMITS['analysis-dimension'],
  )
  expect(diagnostics.analysisSampleCount).toBeLessThanOrEqual(
    FLOWING_CONTOURS_LIMITS['analysis-sample-count'],
  )
  expect(diagnostics.eligibleAnchorCount).toBeLessThanOrEqual(
    FLOWING_CONTOURS_LIMITS['anchor-count'],
  )
  expect(diagnostics.searchStepCount).toBeLessThanOrEqual(
    FLOWING_CONTOURS_LIMITS['search-step-count'],
  )
  expect(diagnostics.candidateCount).toBeLessThanOrEqual(
    FLOWING_CONTOURS_LIMITS['candidate-count'],
  )
  expect(diagnostics.acceptedCandidateCount).toBeLessThanOrEqual(
    FLOWING_CONTOURS_LIMITS['accepted-curve-count'],
  )
  expect(diagnostics.rawTrajectoryPointCount).toBeLessThanOrEqual(
    FLOWING_CONTOURS_LIMITS['raw-trajectory-point-count'],
  )
  expect(diagnostics.fittedCurvePointCount).toBeLessThanOrEqual(
    FLOWING_CONTOURS_LIMITS['fitted-curve-point-count'],
  )
  expect(diagnostics.primitiveCount).toBeLessThanOrEqual(
    FLOWING_CONTOURS_LIMITS['primitive-count'],
  )

  expect(diagnostics.acceptedCandidateCount).toBe(
    diagnostics.rawTrajectoryCount,
  )
  expect(diagnostics.rawTrajectoryCount).toBe(diagnostics.fittedCurveCount)
  expect(diagnostics.fittedCurveCount).toBe(diagnostics.primitiveCount)
  expect(diagnostics.primitiveCount).toBe(result.scene.primitives.length)

  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result.scene)).toBe(true)
  expect(Object.isFrozen(result.scene.space)).toBe(true)
  expect(Object.isFrozen(result.scene.primitives)).toBe(true)
  expect(Object.isFrozen(diagnostics)).toBe(true)
  expect(Object.isFrozen(diagnostics.endpointReasonCounts)).toBe(true)

  for (const primitive of result.scene.primitives) {
    expect(Object.isFrozen(primitive)).toBe(true)
    expect(Object.isFrozen(primitive.points)).toBe(true)
    expect(Object.isFrozen(primitive.stroke)).toBe(true)
    expect(primitive.points.length).toBeGreaterThanOrEqual(
      primitive.closed ? 4 : 2,
    )
    for (const point of primitive.points) {
      expect(Object.isFrozen(point)).toBe(true)
      expect(point.every(Number.isFinite)).toBe(true)
      expect(point[0]).toBeGreaterThanOrEqual(0)
      expect(point[0]).toBeLessThanOrEqual(frame.width)
      expect(point[1]).toBeGreaterThanOrEqual(0)
      expect(point[1]).toBeLessThanOrEqual(frame.height)
    }
  }
}

function expectEmptyInvalid(
  result: Readonly<FlowingContoursGeneratorResult>,
): void {
  expect(result.diagnostics.termination).toBe('invalid-input')
  expect(result.diagnostics.limitedBy).toBeNull()
  expect(result.scene.primitives).toEqual([])
  expectSafeResult(result)
}

function expectWholeOutput(
  result: Readonly<FlowingContoursGeneratorResult>,
): void {
  expect(result.diagnostics.acceptedCandidateCount).toBe(
    result.scene.primitives.length,
  )
  expect(result.diagnostics.rawTrajectoryCount).toBe(
    result.scene.primitives.length,
  )
  expect(result.diagnostics.fittedCurveCount).toBe(
    result.scene.primitives.length,
  )
  expect(result.diagnostics.primitiveCount).toBe(result.scene.primitives.length)
}

describe('Flowing Contours adversarial input safety', () => {
  it.each([
    ['null raster', null],
    ['missing raster fields', {}],
    [
      'empty decoded storage',
      { width: 0, height: 0, data: new Uint8ClampedArray() },
    ],
    [
      'fractional width',
      { width: 1.5, height: 2, data: new Uint8ClampedArray(12) },
    ],
    [
      'negative height',
      { width: 2, height: -1, data: new Uint8ClampedArray() },
    ],
    [
      'NaN width',
      { width: Number.NaN, height: 2, data: new Uint8ClampedArray() },
    ],
    [
      'infinite height',
      {
        width: 2,
        height: Number.POSITIVE_INFINITY,
        data: new Uint8ClampedArray(),
      },
    ],
    [
      'short RGBA storage',
      { width: 2, height: 2, data: new Uint8ClampedArray(15) },
    ],
    [
      'long RGBA storage',
      { width: 2, height: 2, data: new Uint8ClampedArray(17) },
    ],
    ['ordinary numeric storage', { width: 1, height: 1, data: [0, 0, 0, 255] }],
    [
      'unsafe dimensions',
      {
        width: Number.MAX_SAFE_INTEGER,
        height: Number.MAX_SAFE_INTEGER,
        data: new Uint8ClampedArray(),
      },
    ],
  ] as const)('fails %s closed', (_name, pixels) => {
    expectEmptyInvalid(
      generateFlowingContours({
        pixels: pixels as unknown as DecodedPixels,
        frame: FRAME,
        controls: CONTROLS,
      }),
    )
  })

  it('fails hostile decoded records and typed-array proxies closed', () => {
    let decodedGetterCount = 0
    const accessorRaster = Object.defineProperty(
      {
        height: 1,
        data: new Uint8ClampedArray([0, 0, 0, 255]),
      },
      'width',
      {
        get() {
          decodedGetterCount += 1
          throw new Error('hostile decoded width')
        },
      },
    )
    const descriptorTrapRaster = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('hostile decoded descriptor')
        },
      },
    )
    const byteProxy = new Proxy(new Uint8ClampedArray([0, 0, 0, 255]), {
      get(_target, property) {
        if (property === '0') {
          throw new Error('hostile byte access')
        }
        return Reflect.get(_target, property)
      },
    })

    for (const pixels of [
      accessorRaster,
      descriptorTrapRaster,
      { width: 1, height: 1, data: byteProxy },
    ]) {
      expectEmptyInvalid(
        generateFlowingContours({
          pixels: pixels as unknown as DecodedPixels,
          frame: FRAME,
          controls: CONTROLS,
        }),
      )
    }
    expect(decodedGetterCount).toBeLessThanOrEqual(1)
  })

  it('fails malformed frames and hostile top-level descriptors closed', () => {
    const source = boundaryRaster()
    let frameGetterCount = 0
    const accessorFrame = Object.defineProperty({ height: 1 }, 'width', {
      get() {
        frameGetterCount += 1
        throw new Error('hostile frame width')
      },
    })
    const topLevelTrap = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('hostile input descriptor')
        },
      },
    )

    for (const frame of [
      null,
      {},
      { width: 0, height: 1 },
      { width: Number.NaN, height: 1 },
      { width: 1, height: Number.POSITIVE_INFINITY },
      accessorFrame,
    ]) {
      expectEmptyInvalid(
        generateFlowingContours({
          pixels: source,
          frame: frame as unknown as CoordinateSpace,
          controls: CONTROLS,
        }),
      )
    }
    expectEmptyInvalid(
      generateFlowingContours(
        topLevelTrap as unknown as FlowingContoursGeneratorInput,
      ),
    )
    expect(frameGetterCount).toBe(0)
  })

  it('snapshots malformed, non-finite, accessor, and Proxy controls to defaults', () => {
    const source = boundaryRaster(32, 24)
    const expected = generate(source, {
      controls: defaultFlowingContoursControls,
    })
    let accessorCount = 0
    const accessorControls = Object.defineProperty({}, 'flowSmoothing', {
      get() {
        accessorCount += 1
        throw new Error('hostile control getter')
      },
    })
    const descriptorTrapControls = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('hostile control descriptor')
        },
      },
    )

    for (const controls of [
      {
        curveDetail: Number.NaN,
        continuity: Number.POSITIVE_INFINITY,
        flowSmoothing: Number.NEGATIVE_INFINITY,
        minimumStrokeLength: 'short',
      },
      accessorControls,
      descriptorTrapControls,
    ]) {
      const result = generate(source, {
        controls: controls as unknown as FlowingContoursControls,
      })
      expect(result).toEqual(expected)
      expectSafeResult(result)
    }
    expect(accessorCount).toBe(0)
  })

  it('rejects malformed, raised, accessor, and Proxy limit policies', () => {
    const source = boundaryRaster()
    let accessorCount = 0
    const accessorLimits = Object.defineProperty({}, 'candidate-count', {
      get() {
        accessorCount += 1
        return 1
      },
    })
    const ownKeysTrap = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile limit inventory')
        },
      },
    )

    for (const limits of [
      null,
      [],
      { unknown: 1 },
      { 'analysis-dimension': 257 },
      { 'candidate-count': -1 },
      { 'candidate-count': 1.5 },
      { 'candidate-count': Number.NaN },
      { 'candidate-count': Number.POSITIVE_INFINITY },
      accessorLimits,
      ownKeysTrap,
    ]) {
      expectEmptyInvalid(
        generate(source, {
          limits: limits as unknown as FlowingContoursGeneratorInput['limits'],
        }),
      )
    }
    expect(accessorCount).toBe(0)
  })
})

describe('Flowing Contours bounded adversarial completion', () => {
  it.each([
    ['flat opaque', raster(31, 23, () => [127, 127, 127, 255])],
    [
      'fully transparent hidden noise',
      raster(31, 23, (x, y) => [
        (x * 197 + y * 53) & 255,
        (x * 29 + y * 211) & 255,
        (x * 101 + y * 71) & 255,
        0,
      ]),
    ],
    ['one pixel', raster(1, 1, () => [0, 0, 0, 255])],
    [
      'one by many',
      raster(1, 257, (_x, y) =>
        y < 128 ? [16, 16, 16, 255] : [240, 240, 240, 255],
      ),
    ],
    [
      'many by one',
      raster(257, 1, (x) =>
        x < 128 ? [16, 16, 16, 255] : [240, 240, 240, 255],
      ),
    ],
    [
      'extreme portrait aspect',
      raster(1, 8_192, (_x, y) =>
        y % 43 < 20 ? [16, 16, 16, 255] : [240, 240, 240, 255],
      ),
    ],
    [
      'extreme landscape aspect',
      raster(8_192, 1, (x) =>
        x % 43 < 20 ? [16, 16, 16, 255] : [240, 240, 240, 255],
      ),
    ],
    [
      'checkerboard',
      raster(33, 31, (x, y) =>
        (x + y) % 2 === 0 ? [12, 12, 12, 255] : [242, 242, 242, 255],
      ),
    ],
    [
      'alpha silhouette with holes',
      raster(27, 23, (x, y) => {
        const outer = x >= 3 && x < 24 && y >= 3 && y < 20
        const hole =
          (x >= 8 && x < 12 && y >= 7 && y < 17) ||
          (x >= 16 && x < 22 && y >= 9 && y < 15)
        return outer && !hole
          ? [92, 92, 92, 255]
          : [(x * 73) & 255, (y * 151) & 255, ((x + y) * 47) & 255, 0]
      }),
    ],
  ])('is deterministic, finite, and bounded for %s', (_name, source) => {
    const first = generate(source, { limits: PRESSURE_LIMITS })
    const second = generate(source, { limits: PRESSURE_LIMITS })

    expect(second).toEqual(first)
    expect(['complete', 'limit-reached']).toContain(
      first.diagnostics.termination,
    )
    expectSafeResult(first)
  })

  it('makes alpha-hole geometry invariant to every hidden-RGB variation', () => {
    const source = (
      hidden: (x: number, y: number) => readonly [number, number, number],
    ) =>
      raster(21, 17, (x, y) => {
        const outer = x >= 2 && x < 19 && y >= 2 && y < 15
        const hole = x >= 7 && x < 14 && y >= 5 && y < 12
        if (outer && !hole) {
          return x < 11 ? [35, 35, 35, 255] : [215, 215, 215, 255]
        }
        const [red, green, blue] = hidden(x, y)
        return [red, green, blue, 0]
      })

    const black = generate(
      source(() => [0, 0, 0]),
      {
        limits: PRESSURE_LIMITS,
      },
    )
    const magenta = generate(
      source(() => [255, 0, 255]),
      {
        limits: PRESSURE_LIMITS,
      },
    )
    const noise = generate(
      source((x, y) => [
        (x * 193 + y * 47) & 255,
        (x * 29 + y * 211) & 255,
        (x * 101 + y * 71) & 255,
      ]),
      { limits: PRESSURE_LIMITS },
    )

    expect(magenta).toEqual(black)
    expect(noise).toEqual(black)
    expectSafeResult(black)
  })

  it.each([
    ['vertical axis step', boundaryRaster(36, 30), true],
    [
      'horizontal axis step',
      raster(36, 30, (_x, y) =>
        y < 15 ? [18, 18, 18, 255] : [238, 238, 238, 255],
      ),
      true,
    ],
    ['diagonal step', boundaryRaster(36, 30, (y) => 6 + y * 0.78), true],
    [
      'orthogonal grid',
      raster(48, 40, (x, y) =>
        x % 10 < 2 || y % 9 < 2 ? [18, 18, 18, 255] : [238, 238, 238, 255],
      ),
      false,
    ],
    [
      'single-pixel checker',
      raster(48, 40, (x, y) =>
        (x + y) % 2 === 0 ? [18, 18, 18, 255] : [238, 238, 238, 255],
      ),
      false,
    ],
    [
      'deterministic high-frequency noise',
      raster(48, 40, (x, y) => {
        const value = (x * 73 + y * 151 + (x ^ y) * 19 + ((x * y) % 251)) & 255
        return [value, value, value, 255]
      }),
      false,
    ],
  ] as const)(
    'prevents a lattice/stump flood for %s',
    (_name, source, expectLongGesture) => {
      const controls = Object.freeze({
        ...CONTROLS,
        minimumStrokeLength: 0.1,
      })
      const first = generate(source, {
        controls,
        limits: PRESSURE_LIMITS,
      })
      const second = generate(source, {
        controls,
        limits: PRESSURE_LIMITS,
      })
      const fit = createRasterContainFit(source, FRAME)!
      const minimumLength =
        controls.minimumStrokeLength *
        Math.hypot(fit.fittedWidth, fit.fittedHeight)
      const lengths = first.scene.primitives.map((primitive) =>
        pathLength(primitive.points, primitive.closed),
      )

      expect(second).toEqual(first)
      expect(first.scene.primitives.length).toBeLessThanOrEqual(6)
      expect(lengths.every((length) => length + 1e-8 >= minimumLength)).toBe(
        true,
      )
      if (expectLongGesture) {
        expect(lengths.length).toBeGreaterThan(0)
        expect(Math.max(...lengths)).toBeGreaterThan(
          Math.min(fit.fittedWidth, fit.fittedHeight) * 0.55,
        )
      }
      expectWholeOutput(first)
      expectSafeResult(first)
    },
    30_000,
  )

  it('uses zero weak-travel policy without leaking across alpha holes', () => {
    const source = raster(80, 52, (x, y) => {
      const boundary = 38 + 5 * Math.sin(y / 7)
      const hole = y >= 21 && y <= 29 && x >= 34 && x <= 45
      if (hole) return [255, 0, 255, 0]
      return x < boundary ? [18, 18, 18, 255] : [238, 238, 238, 255]
    })
    const result = generate(source, {
      limits: {
        'weak-span-step-count': 0,
        'weak-span-distance': 0,
      },
    })

    expect(result.diagnostics.acceptedMaximumUnsupportedSpanLength).toBe(0)
    expect(result.diagnostics.acceptedTotalUnsupportedSpanLength).toBe(0)
    expectWholeOutput(result)
    expectSafeResult(result)
  })
})

describe('Flowing Contours exact safety-limit accounting', () => {
  const source = boundaryRaster()

  it.each([
    ['analysis-dimension', { 'analysis-dimension': 63 }],
    ['analysis-sample-count', { 'analysis-sample-count': 3_071 }],
    ['scale-plane-count', { 'scale-plane-count': 0 }],
    ['anchor-count', { 'anchor-count': 0 }],
    ['normal-search-sample-count', { 'normal-search-sample-count': 2 }],
    ['search-breadth', { 'search-breadth': 0 }],
    ['search-step-count', { 'search-step-count': 0 }],
    ['candidate-count', { 'candidate-count': 0 }],
    ['accepted-curve-count', { 'accepted-curve-count': 0 }],
    ['raw-trajectory-point-count', { 'raw-trajectory-point-count': 1 }],
    ['fitted-curve-point-count', { 'fitted-curve-point-count': 1 }],
    ['primitive-count', { 'primitive-count': 0 }],
  ] as const)(
    'reports %s as the exact first exhausted cap with no partial output',
    (limitedBy, limits) => {
      const result = generate(source, { limits })

      expect(result.diagnostics.termination).toBe('limit-reached')
      expect(result.diagnostics.limitedBy).toBe(
        limitedBy satisfies FlowingContoursLimitName,
      )
      expectWholeOutput(result)
      expectSafeResult(result)
    },
  )

  it('keeps the chronologically first limit when later caps are also zero', () => {
    const result = generate(source, {
      limits: {
        'search-step-count': 2,
        'accepted-curve-count': 0,
        'fitted-curve-point-count': 0,
      },
    })

    expect(result.diagnostics.termination).toBe('limit-reached')
    expect(result.diagnostics.limitedBy).toBe('search-step-count')
    expect(result.diagnostics.searchStepCount).toBe(2)
    expect(result.scene.primitives).toEqual([])
    expectWholeOutput(result)
    expectSafeResult(result)
  })

  it('does not turn a high-detail minimum-stroke rejection into a short-curve flood', () => {
    const source = raster(48, 48, (x, y) => {
      const cell = ((x >> 2) + (y >> 2)) & 1
      const perturbation = (x * 31 + y * 17 + (x ^ y) * 7) & 31
      const value = cell === 0 ? 32 + perturbation : 224 - perturbation
      return [value, value, value, 255]
    })
    const controls = Object.freeze({
      curveDetail: 1,
      continuity: 1,
      flowSmoothing: 1,
      minimumStrokeLength: 0.25,
    })
    const limits = Object.freeze({
      'candidate-count': 16,
      'accepted-curve-count': 4,
      'primitive-count': 4,
      'search-step-count': 768,
      'raw-trajectory-point-count': 384,
      'fitted-curve-point-count': 384,
    })
    const result = generate(source, { controls, limits })
    const fit = createRasterContainFit(source, FRAME)!
    const minimumLength =
      controls.minimumStrokeLength *
      Math.hypot(fit.fittedWidth, fit.fittedHeight)

    expect(result.scene.primitives.length).toBeLessThanOrEqual(4)
    expect(
      result.scene.primitives.every(
        (primitive) =>
          pathLength(primitive.points, primitive.closed) + 1e-8 >=
          minimumLength,
      ),
    ).toBe(true)
    expect(result.diagnostics.rejectedCandidateCount).toBe(
      result.diagnostics.candidateCount -
        result.diagnostics.acceptedCandidateCount,
    )
    expectWholeOutput(result)
    expectSafeResult(result)
  })
})
