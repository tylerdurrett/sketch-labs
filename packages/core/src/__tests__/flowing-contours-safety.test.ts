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
import {
  createFlowingContoursTestLimits,
  FLOWING_CONTOURS_LIMITS,
  type FlowingContoursLimits,
} from '../sketches/flowing-contours/limits'
import { runFlowingContoursPipeline } from '../sketches/flowing-contours/pipeline'
import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
  FLOWING_CONTOURS_LIMIT_NAMES,
  type FlowingContoursDiagnostics,
  type FlowingContoursField,
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

const DISCRETE_DIAGNOSTIC_NAMES = Object.freeze([
  'analysisWidth',
  'analysisHeight',
  'analysisSampleCount',
  'contourEvidenceSampleCount',
  'correctedRidgeSampleCount',
  'eligibleAnchorCount',
  'processedAnchorCount',
  'directionalTraceCount',
  'searchStepCount',
  'candidateCount',
  'acceptedCandidateCount',
  'rejectedCandidateCount',
  'suppressedAnchorCount',
  'suppressedEvidenceSampleCount',
  'rawTrajectoryCount',
  'rawTrajectoryPointCount',
  'fittedCurveCount',
  'fittedCurvePointCount',
  'primitiveCount',
] as const satisfies readonly (keyof FlowingContoursDiagnostics)[])

const MODERATE_TURN = (25 * Math.PI) / 180
const ABRUPT_TURN = (45 * Math.PI) / 180
const MAXIMUM_FLOWING_TURN = (110 * Math.PI) / 180
const AXIS_ALIGNMENT_COSINE = Math.cos((10 * Math.PI) / 180)
const ORTHOGONAL_TURN_FLOOR = (60 * Math.PI) / 180
const METRIC_SPACINGS = Object.freeze([2, 4] as const)

interface FixedSpacingFlowMetrics {
  readonly turnCount: number
  readonly turnEnergy: number
  readonly maximumTurn: number
  readonly moderateTurnCount: number
  readonly abruptTurnCount: number
  readonly repeatedAbruptAlternationCount: number
  readonly maximumAxisToggleRun: number
}

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

function opaqueLowEvidenceGapField(): Readonly<FlowingContoursField> {
  const width = 28
  const height = 13
  const count = width * height
  const contourEvidence = Array.from({ length: count }, (_value, index) => {
    const x = index % width
    const y = Math.floor(index / width)
    const distance = y - 6
    const ridge = Math.exp(-(distance * distance) / (2 * 0.55 * 0.55))
    return (x >= 13 && x <= 14 ? 0.01 : 1) * ridge
  })
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze(new Array<number>(count).fill(0.5)),
    alpha: Object.freeze(new Array<number>(count).fill(1)),
    positiveSupport: Object.freeze(new Array<boolean>(count).fill(true)),
    contourEvidence: Object.freeze(contourEvidence),
    tangentX: Object.freeze(new Array<number>(count).fill(1)),
    tangentY: Object.freeze(new Array<number>(count).fill(0)),
    tangentCoherence: Object.freeze(new Array<number>(count).fill(1)),
    ambiguity: Object.freeze(new Array<number>(count).fill(0)),
    ridgeScale: Object.freeze(new Array<number>(count).fill(1)),
  })
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

function effectiveLimits(
  overrides: Readonly<Partial<FlowingContoursLimits>> = {},
): Readonly<FlowingContoursLimits> {
  return Object.freeze({ ...FLOWING_CONTOURS_LIMITS, ...overrides })
}

function expectSafeDiagnostics(
  diagnostics: Readonly<FlowingContoursDiagnostics>,
  overrides: Readonly<Partial<FlowingContoursLimits>> = {},
): void {
  const limits = effectiveLimits(overrides)

  expect(FLOWING_CONTOURS_LIMIT_NAMES).toHaveLength(14)
  for (const name of DISCRETE_DIAGNOSTIC_NAMES) {
    expect(
      Number.isSafeInteger(diagnostics[name]) && diagnostics[name] >= 0,
      `${name} must be a nonnegative safe integer`,
    ).toBe(true)
  }
  for (const name of [
    'acceptedMaximumUnsupportedSpanLength',
    'acceptedTotalUnsupportedSpanLength',
  ] as const) {
    expect(
      Number.isFinite(diagnostics[name]) && diagnostics[name] >= 0,
      `${name} must be finite and nonnegative`,
    ).toBe(true)
  }
  expect(Object.keys(diagnostics.endpointReasonCounts).sort()).toEqual(
    [...FLOWING_CONTOURS_ENDPOINT_REASONS].sort(),
  )
  for (const reason of FLOWING_CONTOURS_ENDPOINT_REASONS) {
    const count = diagnostics.endpointReasonCounts[reason]
    expect(
      Number.isSafeInteger(count) && count >= 0,
      `${reason} endpoint count must be a nonnegative safe integer`,
    ).toBe(true)
  }

  expect(diagnostics.analysisWidth).toBeLessThanOrEqual(
    limits['analysis-dimension'],
  )
  expect(diagnostics.analysisHeight).toBeLessThanOrEqual(
    limits['analysis-dimension'],
  )
  expect(diagnostics.analysisSampleCount).toBeLessThanOrEqual(
    limits['analysis-sample-count'],
  )
  expect(diagnostics.contourEvidenceSampleCount).toBeLessThanOrEqual(
    diagnostics.analysisSampleCount,
  )
  expect(diagnostics.correctedRidgeSampleCount).toBeLessThanOrEqual(
    diagnostics.analysisSampleCount,
  )
  expect(diagnostics.eligibleAnchorCount).toBeLessThanOrEqual(
    limits['anchor-count'],
  )
  expect(diagnostics.processedAnchorCount).toBeLessThanOrEqual(
    diagnostics.eligibleAnchorCount,
  )
  expect(diagnostics.directionalTraceCount).toBeLessThanOrEqual(
    diagnostics.processedAnchorCount * 2,
  )
  expect(diagnostics.searchStepCount).toBeLessThanOrEqual(
    limits['search-step-count'],
  )
  expect(diagnostics.candidateCount).toBeLessThanOrEqual(
    limits['candidate-count'],
  )
  expect(diagnostics.candidateCount).toBeLessThanOrEqual(
    diagnostics.processedAnchorCount,
  )
  expect(diagnostics.acceptedCandidateCount).toBeLessThanOrEqual(
    limits['accepted-curve-count'],
  )
  expect(diagnostics.acceptedCandidateCount).toBeLessThanOrEqual(
    diagnostics.candidateCount,
  )
  expect(diagnostics.rejectedCandidateCount).toBe(
    diagnostics.candidateCount - diagnostics.acceptedCandidateCount,
  )
  expect(diagnostics.suppressedAnchorCount).toBeLessThanOrEqual(
    diagnostics.processedAnchorCount,
  )
  expect(diagnostics.suppressedEvidenceSampleCount).toBeLessThanOrEqual(
    diagnostics.analysisSampleCount,
  )
  expect(diagnostics.rawTrajectoryPointCount).toBeLessThanOrEqual(
    limits['raw-trajectory-point-count'],
  )
  expect(diagnostics.fittedCurvePointCount).toBeLessThanOrEqual(
    limits['fitted-curve-point-count'],
  )
  expect(diagnostics.primitiveCount).toBeLessThanOrEqual(
    limits['primitive-count'],
  )
  expect(
    FLOWING_CONTOURS_ENDPOINT_REASONS.reduce(
      (total, reason) => total + diagnostics.endpointReasonCounts[reason],
      0,
    ),
  ).toBe(diagnostics.acceptedCandidateCount * 2)
  expect(Object.isFrozen(diagnostics)).toBe(true)
  expect(Object.isFrozen(diagnostics.endpointReasonCounts)).toBe(true)
}

function expectSafeResult(
  result: Readonly<FlowingContoursGeneratorResult>,
  overrides: Readonly<Partial<FlowingContoursLimits>> = {},
  frame: Readonly<CoordinateSpace> = FRAME,
): void {
  const diagnostics = result.diagnostics

  expectSafeDiagnostics(diagnostics, overrides)

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

function fixedSpacingPoints(
  points: readonly Readonly<Point>[],
  closed: boolean,
  spacing: number,
): readonly Readonly<Point>[] {
  if (points.length < 2) return Object.freeze([...points])
  const source = [...points]
  if (
    closed &&
    (source[0]![0] !== source.at(-1)![0] || source[0]![1] !== source.at(-1)![1])
  ) {
    source.push(source[0]!)
  }
  const cumulative = [0]
  for (let index = 1; index < source.length; index += 1) {
    cumulative.push(
      cumulative[index - 1]! +
        Math.hypot(
          source[index]![0] - source[index - 1]![0],
          source[index]![1] - source[index - 1]![1],
        ),
    )
  }
  const total = cumulative.at(-1)!
  if (!(total > 0)) return Object.freeze([source[0]!])

  const sampled: Readonly<Point>[] = []
  let segment = 1
  for (let distance = 0; distance < total; distance += spacing) {
    while (segment < cumulative.length - 1 && cumulative[segment]! < distance) {
      segment += 1
    }
    const startDistance = cumulative[segment - 1]!
    const endDistance = cumulative[segment]!
    const ratio =
      endDistance > startDistance
        ? (distance - startDistance) / (endDistance - startDistance)
        : 0
    const start = source[segment - 1]!
    const end = source[segment]!
    sampled.push(
      Object.freeze([
        start[0] + (end[0] - start[0]) * ratio,
        start[1] + (end[1] - start[1]) * ratio,
      ] as Point),
    )
  }
  if (!closed) sampled.push(Object.freeze([...source.at(-1)!] as Point))
  return Object.freeze(sampled)
}

function fixedSpacingFlowMetrics(
  points: readonly Readonly<Point>[],
  closed: boolean,
  spacing: number,
): Readonly<FixedSpacingFlowMetrics> {
  const sampled = fixedSpacingPoints(points, closed, spacing)
  const directions: Readonly<Point>[] = []
  const segmentCount = closed ? sampled.length : Math.max(0, sampled.length - 1)
  for (let index = 0; index < segmentCount; index += 1) {
    const start = sampled[index]!
    const end = closed
      ? sampled[(index + 1) % sampled.length]!
      : sampled[index + 1]!
    const x = end[0] - start[0]
    const y = end[1] - start[1]
    const length = Math.hypot(x, y)
    if (length > 1e-9) {
      directions.push(Object.freeze([x / length, y / length] as Point))
    }
  }

  let turnEnergy = 0
  let maximumTurn = 0
  let moderateTurnCount = 0
  let abruptTurnCount = 0
  const abruptSigns: number[] = []
  const axisRecords: { readonly known: boolean; readonly toggle: boolean }[] =
    []
  const turnCount = closed
    ? directions.length
    : Math.max(0, directions.length - 1)

  for (let offset = 0; offset < turnCount; offset += 1) {
    const index = closed ? offset : offset + 1
    const previous = closed
      ? directions[(index - 1 + directions.length) % directions.length]!
      : directions[index - 1]!
    const current = directions[index]!
    const cross = previous[0] * current[1] - previous[1] * current[0]
    const dot = previous[0] * current[0] + previous[1] * current[1]
    const signedTurn = Math.atan2(cross, dot)
    const turn = Math.abs(signedTurn)
    turnEnergy += turn * turn
    maximumTurn = Math.max(maximumTurn, turn)
    if (turn > MODERATE_TURN) moderateTurnCount += 1
    if (turn > ABRUPT_TURN) {
      abruptTurnCount += 1
      abruptSigns.push(Math.sign(signedTurn))
    }

    const previousAxis =
      Math.abs(previous[0]) >= AXIS_ALIGNMENT_COSINE
        ? 'horizontal'
        : Math.abs(previous[1]) >= AXIS_ALIGNMENT_COSINE
          ? 'vertical'
          : null
    const currentAxis =
      Math.abs(current[0]) >= AXIS_ALIGNMENT_COSINE
        ? 'horizontal'
        : Math.abs(current[1]) >= AXIS_ALIGNMENT_COSINE
          ? 'vertical'
          : null
    axisRecords.push(
      Object.freeze({
        known: previousAxis !== null && currentAxis !== null,
        toggle:
          previousAxis !== null &&
          currentAxis !== null &&
          previousAxis !== currentAxis &&
          turn >= ORTHOGONAL_TURN_FLOOR,
      }),
    )
  }

  let repeatedAbruptAlternationCount = 0
  const abruptPairCount =
    abruptSigns.length < 2
      ? 0
      : closed
        ? abruptSigns.length
        : abruptSigns.length - 1
  for (let index = 0; index < abruptPairCount; index += 1) {
    if (
      abruptSigns[index]! !== abruptSigns[(index + 1) % abruptSigns.length]!
    ) {
      repeatedAbruptAlternationCount += 1
    }
  }

  let maximumAxisToggleRun = 0
  let axisToggleRun = 0
  const hasUnknownAxis = axisRecords.some((record) => !record.known)
  const scannedAxisRecords =
    closed && hasUnknownAxis ? [...axisRecords, ...axisRecords] : axisRecords
  for (const record of scannedAxisRecords) {
    if (!record.known) {
      axisToggleRun = 0
      continue
    }
    if (record.toggle) axisToggleRun += 1
    maximumAxisToggleRun = Math.max(
      maximumAxisToggleRun,
      Math.min(axisToggleRun, axisRecords.length),
    )
  }

  return Object.freeze({
    turnCount,
    turnEnergy,
    maximumTurn,
    moderateTurnCount,
    abruptTurnCount,
    repeatedAbruptAlternationCount,
    maximumAxisToggleRun,
  })
}

function passesFlowingMetricGate(
  points: readonly Readonly<Point>[],
  closed: boolean,
): boolean {
  return METRIC_SPACINGS.every((spacing) => {
    const metrics = fixedSpacingFlowMetrics(points, closed, spacing)
    return (
      Number.isFinite(metrics.turnEnergy) &&
      Number.isFinite(metrics.maximumTurn) &&
      metrics.maximumTurn <= MAXIMUM_FLOWING_TURN &&
      metrics.moderateTurnCount <=
        Math.max(2, Math.ceil(metrics.turnCount * 0.2)) &&
      metrics.abruptTurnCount <=
        Math.max(1, Math.ceil(metrics.turnCount * 0.08)) &&
      metrics.turnEnergy <=
        MAXIMUM_FLOWING_TURN ** 2 +
          metrics.turnCount * ((20 * Math.PI) / 180) ** 2 &&
      metrics.repeatedAbruptAlternationCount === 0 &&
      metrics.maximumAxisToggleRun <= 1
    )
  })
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

function expectLimitAttemptSemantics(
  name: FlowingContoursLimitName,
  diagnostics: Readonly<FlowingContoursDiagnostics>,
): void {
  switch (name) {
    case 'analysis-dimension':
    case 'analysis-sample-count':
      expect(diagnostics.analysisSampleCount).toBe(0)
      expect(diagnostics.eligibleAnchorCount).toBe(0)
      expect(diagnostics.processedAnchorCount).toBe(0)
      break
    case 'scale-plane-count':
      expect(diagnostics.analysisSampleCount).toBe(64 * 48)
      expect(diagnostics.eligibleAnchorCount).toBe(0)
      expect(diagnostics.processedAnchorCount).toBe(0)
      break
    case 'anchor-count':
    case 'normal-search-sample-count':
      expect(diagnostics.analysisSampleCount).toBe(64 * 48)
      expect(diagnostics.processedAnchorCount).toBe(0)
      expect(diagnostics.candidateCount).toBe(0)
      break
    case 'search-breadth':
    case 'search-step-count':
    case 'raw-trajectory-point-count':
      expect(diagnostics.eligibleAnchorCount).toBeGreaterThan(0)
      expect(diagnostics.processedAnchorCount).toBe(0)
      expect(diagnostics.directionalTraceCount).toBe(0)
      expect(diagnostics.candidateCount).toBe(0)
      break
    case 'candidate-count':
    case 'primitive-count':
      expect(diagnostics.eligibleAnchorCount).toBeGreaterThan(0)
      expect(diagnostics.processedAnchorCount).toBe(1)
      expect(diagnostics.directionalTraceCount).toBe(0)
      expect(diagnostics.searchStepCount).toBe(0)
      expect(diagnostics.candidateCount).toBe(0)
      break
    case 'accepted-curve-count':
    case 'fitted-curve-point-count':
      expect(diagnostics.processedAnchorCount).toBe(1)
      expect(diagnostics.directionalTraceCount).toBe(2)
      expect(diagnostics.searchStepCount).toBeGreaterThan(0)
      expect(diagnostics.candidateCount).toBe(1)
      expect(diagnostics.acceptedCandidateCount).toBe(0)
      expect(diagnostics.rejectedCandidateCount).toBe(1)
      break
    case 'weak-span-step-count':
    case 'weak-span-distance':
      throw new Error('weak-span caps are non-terminating local policy')
  }
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
    expectSafeResult(first, PRESSURE_LIMITS)
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
    expectSafeResult(black, PRESSURE_LIMITS)
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
      for (const primitive of first.scene.primitives) {
        expect(
          passesFlowingMetricGate(primitive.points, primitive.closed),
          `${_name} emitted grid-like turn metrics`,
        ).toBe(true)
      }
      if (expectLongGesture) {
        expect(lengths.length).toBeGreaterThan(0)
        expect(Math.max(...lengths)).toBeGreaterThan(
          Math.min(fit.fittedWidth, fit.fittedHeight) * 0.55,
        )
      }
      expectWholeOutput(first)
      expectSafeResult(first, PRESSURE_LIMITS)
    },
    30_000,
  )

  it('rejects a synthetic axis staircase that the multiscale gate can detect', () => {
    const staircase = Object.freeze(
      Array.from({ length: 13 }, (_value, index) =>
        Object.freeze([
          Math.ceil(index / 2) * 6,
          Math.floor(index / 2) * 6,
        ] as Point),
      ),
    )

    const profiles = METRIC_SPACINGS.map((spacing) =>
      fixedSpacingFlowMetrics(staircase, false, spacing),
    )
    for (const metrics of profiles) {
      expect(metrics.turnEnergy).toBeGreaterThan(0)
      expect(metrics.maximumTurn).toBeGreaterThan(ABRUPT_TURN)
      expect(metrics.moderateTurnCount).toBeGreaterThan(2)
      expect(metrics.abruptTurnCount).toBeGreaterThan(2)
    }
    expect(
      profiles.some((metrics) => metrics.repeatedAbruptAlternationCount > 0),
    ).toBe(true)
    expect(profiles.some((metrics) => metrics.maximumAxisToggleRun > 1)).toBe(
      true,
    )
    expect(passesFlowingMetricGate(staircase, false)).toBe(false)
  })

  it('includes the closing segment and seam turn without duplicate-endpoint bias', () => {
    const seamCusp = Object.freeze([
      Object.freeze([0, 0] as Point),
      Object.freeze([8, 0] as Point),
      Object.freeze([16, 0] as Point),
      Object.freeze([24, 0] as Point),
      Object.freeze([32, 0] as Point),
      Object.freeze([32, 4] as Point),
    ])
    expect(passesFlowingMetricGate(seamCusp, false)).toBe(true)
    expect(passesFlowingMetricGate(seamCusp, true)).toBe(false)
    for (const spacing of METRIC_SPACINGS) {
      const open = fixedSpacingFlowMetrics(seamCusp, false, spacing)
      const closed = fixedSpacingFlowMetrics(seamCusp, true, spacing)
      expect(closed.turnCount).toBeGreaterThan(open.turnCount)
      expect(closed.maximumTurn).toBeGreaterThan(MAXIMUM_FLOWING_TURN)
    }

    const circle = Object.freeze(
      Array.from({ length: 64 }, (_value, index) => {
        const angle = (index / 64) * Math.PI * 2
        return Object.freeze([
          40 + 30 * Math.cos(angle),
          40 + 30 * Math.sin(angle),
        ] as Point)
      }),
    )
    const repeatedEndpointCircle = Object.freeze([
      ...circle,
      Object.freeze([...circle[0]!] as Point),
    ])
    expect(passesFlowingMetricGate(circle, true)).toBe(true)
    expect(passesFlowingMetricGate(repeatedEndpointCircle, true)).toBe(true)
    for (const spacing of METRIC_SPACINGS) {
      expect(
        fixedSpacingFlowMetrics(repeatedEndpointCircle, true, spacing),
      ).toEqual(fixedSpacingFlowMetrics(circle, true, spacing))
    }
  })

  it('rejects a closed staircase while admitting a smooth closed circle', () => {
    const closedStaircase = Object.freeze([
      Object.freeze([0, 0] as Point),
      Object.freeze([8, 0] as Point),
      Object.freeze([8, 8] as Point),
      Object.freeze([16, 8] as Point),
      Object.freeze([16, 16] as Point),
      Object.freeze([8, 16] as Point),
      Object.freeze([8, 24] as Point),
      Object.freeze([0, 24] as Point),
    ])
    const smoothCircle = Object.freeze(
      Array.from({ length: 48 }, (_value, index) => {
        const angle = (index / 48) * Math.PI * 2
        return Object.freeze([
          30 + 20 * Math.cos(angle),
          30 + 20 * Math.sin(angle),
        ] as Point)
      }),
    )

    expect(passesFlowingMetricGate(closedStaircase, true)).toBe(false)
    expect(passesFlowingMetricGate(smoothCircle, true)).toBe(true)
    for (const spacing of METRIC_SPACINGS) {
      const staircaseMetrics = fixedSpacingFlowMetrics(
        closedStaircase,
        true,
        spacing,
      )
      const circleMetrics = fixedSpacingFlowMetrics(smoothCircle, true, spacing)
      expect(staircaseMetrics.maximumAxisToggleRun).toBeGreaterThan(1)
      expect(staircaseMetrics.abruptTurnCount).toBeGreaterThan(
        circleMetrics.abruptTurnCount,
      )
      expect(staircaseMetrics.turnEnergy).toBeGreaterThan(
        circleMetrics.turnEnergy,
      )
    }
  })

  it('proves weak-span step and distance caps on an opaque low-evidence gap', () => {
    const field = opaqueLowEvidenceGapField()
    const controls = Object.freeze({
      ...CONTROLS,
      continuity: 1,
      minimumStrokeLength: 0.005,
    })
    const permissive = runFlowingContoursPipeline(field, controls)
    const stepLimits = createFlowingContoursTestLimits({
      'weak-span-step-count': 0,
    })!
    const distanceLimits = createFlowingContoursTestLimits({
      'weak-span-distance': 0.5,
    })!
    const stepLimited = runFlowingContoursPipeline(field, controls, stepLimits)
    const distanceLimited = runFlowingContoursPipeline(
      field,
      controls,
      distanceLimits,
    )
    const permissiveGaps = permissive.acceptedTrajectories.flatMap(
      (trajectory) =>
        trajectory.spanSupport.filter((span) => span.kind === 'bounded-gap'),
    )

    expect(permissive.acceptedTrajectories.length).toBeGreaterThan(0)
    expect(permissiveGaps.length).toBeGreaterThan(0)
    expect(
      permissiveGaps.every(
        (gap) =>
          gap.length > 0 &&
          gap.entryEvidence > 0 &&
          gap.exitEvidence > 0 &&
          gap.directionalAlignment >= 0.75,
      ),
    ).toBe(true)
    expect(Math.max(...permissiveGaps.map((gap) => gap.length))).toBe(
      permissive.diagnostics.acceptedMaximumUnsupportedSpanLength,
    )
    expect(permissiveGaps.reduce((total, gap) => total + gap.length, 0)).toBe(
      permissive.diagnostics.acceptedTotalUnsupportedSpanLength,
    )

    for (const [output, limits, cap] of [
      [stepLimited, stepLimits, 0],
      [distanceLimited, distanceLimits, 0.5],
    ] as const) {
      const gaps = output.acceptedTrajectories.flatMap((trajectory) =>
        trajectory.spanSupport.filter((span) => span.kind === 'bounded-gap'),
      )
      expect(
        output.diagnostics.acceptedMaximumUnsupportedSpanLength,
      ).toBeLessThan(
        permissive.diagnostics.acceptedMaximumUnsupportedSpanLength,
      )
      expect(
        output.diagnostics.acceptedTotalUnsupportedSpanLength,
      ).toBeLessThan(permissive.diagnostics.acceptedTotalUnsupportedSpanLength)
      expect(gaps.every((gap) => gap.length <= cap)).toBe(true)
      expect(output.fittedCurves).toHaveLength(
        output.acceptedTrajectories.length,
      )
      expectSafeDiagnostics(output.diagnostics, limits)
    }
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
      expectLimitAttemptSemantics(limitedBy, result.diagnostics)
      expectWholeOutput(result)
      expectSafeResult(result, limits)
    },
  )

  it('keeps the chronologically first limit when later caps are also zero', () => {
    const limits = Object.freeze({
      'search-step-count': 2,
      'accepted-curve-count': 0,
      'fitted-curve-point-count': 0,
    })
    const result = generate(source, {
      limits,
    })

    expect(result.diagnostics.termination).toBe('limit-reached')
    expect(result.diagnostics.limitedBy).toBe('search-step-count')
    expect(result.diagnostics.searchStepCount).toBe(2)
    expect(result.scene.primitives).toEqual([])
    expectWholeOutput(result)
    expectSafeResult(result, limits)
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
    expectSafeResult(result, limits)
  })
})
