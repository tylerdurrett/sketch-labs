import { describe, expect, it } from 'vitest'

import type { Primitive, Scene } from '../scene'
import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
  type AcceptedFlowingTrajectory,
  type FlowingContoursDiagnostics,
} from '../sketches/flowing-contours/types'
import type { Point } from '../types'
import {
  measureFlowingContoursReference,
  type FlowingContoursReferenceMetricOptions,
} from './helpers/flowingContoursReferenceMetrics'

const STROKE = Object.freeze({ color: 'black', width: 1 })

function primitive(
  points: readonly Readonly<Point>[],
  closed = false,
): Primitive {
  return {
    points: points.map(([x, y]) => [x, y]),
    closed,
    stroke: STROKE,
  }
}

function densifyClosed(
  points: readonly Readonly<Point>[],
  fractionsForEdge: (edgeIndex: number) => readonly number[],
): Point[] {
  return points.flatMap((first, edgeIndex) => {
    const second = points[(edgeIndex + 1) % points.length]!
    return [
      [first[0], first[1]] as Point,
      ...fractionsForEdge(edgeIndex).map(
        (amount) =>
          [
            first[0] + (second[0] - first[0]) * amount,
            first[1] + (second[1] - first[1]) * amount,
          ] as Point,
      ),
    ]
  })
}

function trajectory(
  index: number,
  options: {
    length?: number
    analysisDiagonal?: number
    unsupportedSpans?: readonly number[]
  } = {},
): AcceptedFlowingTrajectory {
  const length = options.length ?? 10
  const analysisDiagonal = options.analysisDiagonal ?? 100
  const unsupportedSpans = options.unsupportedSpans ?? []
  const totalUnsupportedSpanLength = unsupportedSpans.reduce(
    (total, span) => total + span,
    0,
  )
  const maximumUnsupportedSpanLength =
    unsupportedSpans.length === 0 ? 0 : Math.max(...unsupportedSpans)
  const directSegmentLength =
    (length - totalUnsupportedSpanLength) / (unsupportedSpans.length + 1)
  const samples: Array<Record<string, unknown>> = []
  const spanSupport: Array<Record<string, unknown>> = []
  let x = 0
  function addSample(pointX: number, evidence: number): void {
    samples.push({
      point: [pointX, index],
      tangent: [1, 0],
      evidence,
      coherence: 1,
      ambiguity: 0,
      scale: 1,
      alpha: 1,
    })
  }
  function addDirectSegment(): void {
    const startSampleIndex = samples.length - 1
    x += directSegmentLength
    addSample(x, 1)
    spanSupport.push({
      kind: 'direct-evidence',
      startSampleIndex,
      endSampleIndex: samples.length - 1,
      length: directSegmentLength,
      entryEvidence: 1,
      exitEvidence: 1,
      directionalAlignment: 1,
    })
  }
  addSample(0, 1)
  for (const unsupportedLength of unsupportedSpans) {
    addDirectSegment()
    const startSampleIndex = samples.length - 1
    x += unsupportedLength / 2
    addSample(x, 0)
    x += unsupportedLength / 2
    addSample(x, 1)
    spanSupport.push({
      kind: 'bounded-gap',
      startSampleIndex,
      endSampleIndex: samples.length - 1,
      length: unsupportedLength,
      entryEvidence: 1,
      exitEvidence: 1,
      directionalAlignment: 1,
    })
  }
  addDirectSegment()

  const accumulatedEvidence =
    4 *
    (samples.reduce((total, sample) => total + (sample.evidence as number), 0) /
      samples.length)
  const usefulLength = 3 * Math.min(1, length / analysisDiagonal)
  const directionalCoherence = 2
  const unsupportedTravelPenalty =
    4.5 * Math.min(1, totalUnsupportedSpanLength / analysisDiagonal)
  const total =
    accumulatedEvidence +
    usefulLength +
    directionalCoherence -
    unsupportedTravelPenalty
  return {
    id: index,
    anchorId: index,
    samples,
    spanSupport,
    startEndpointReason: 'source-boundary',
    endEndpointReason: 'evidence-exhausted',
    length,
    maximumUnsupportedSpanLength,
    totalUnsupportedSpanLength,
    score: {
      accumulatedEvidence,
      usefulLength,
      directionalCoherence,
      curvaturePenalty: 0,
      unsupportedTravelPenalty,
      ambiguityPenalty: 0,
      representedOverlapPenalty: 0,
      total,
    },
  } as unknown as AcceptedFlowingTrajectory
}

function diagnosticFor(
  primitives: number,
  accepted: readonly Readonly<AcceptedFlowingTrajectory>[],
): FlowingContoursDiagnostics {
  const endpointReasonCounts = Object.fromEntries(
    FLOWING_CONTOURS_ENDPOINT_REASONS.map((reason) => [reason, 0]),
  ) as Record<(typeof FLOWING_CONTOURS_ENDPOINT_REASONS)[number], number>
  let maximumUnsupported = 0
  let totalUnsupported = 0
  let rawPoints = 0
  for (const item of accepted) {
    endpointReasonCounts[item.startEndpointReason] += 1
    endpointReasonCounts[item.endEndpointReason] += 1
    maximumUnsupported = Math.max(
      maximumUnsupported,
      item.maximumUnsupportedSpanLength,
    )
    totalUnsupported += item.totalUnsupportedSpanLength
    rawPoints += item.samples.length
  }
  return {
    primitiveCount: primitives,
    rawTrajectoryCount: accepted.length,
    rawTrajectoryPointCount: rawPoints,
    acceptedMaximumUnsupportedSpanLength: maximumUnsupported,
    acceptedTotalUnsupportedSpanLength: totalUnsupported,
    endpointReasonCounts,
  } as unknown as FlowingContoursDiagnostics
}

function replaceFirstSpan(
  accepted: Readonly<AcceptedFlowingTrajectory>,
  patch: Partial<AcceptedFlowingTrajectory['spanSupport'][number]>,
): AcceptedFlowingTrajectory {
  return {
    ...accepted,
    spanSupport: [
      { ...accepted.spanSupport[0]!, ...patch },
      ...accepted.spanSupport.slice(1),
    ],
  }
}

function replaceFirstSample(
  accepted: Readonly<AcceptedFlowingTrajectory>,
  patch: Partial<AcceptedFlowingTrajectory['samples'][number]>,
): AcceptedFlowingTrajectory {
  return {
    ...accepted,
    samples: [
      { ...accepted.samples[0]!, ...patch },
      ...accepted.samples.slice(1),
    ],
  }
}

function measure(
  primitives: Primitive[],
  options?: FlowingContoursReferenceMetricOptions,
  accepted = primitives.map((_, index) => trajectory(index)),
  space = { width: 100, height: 100 },
) {
  const scene: Scene = { space, primitives }
  return measureFlowingContoursReference({
    scene,
    acceptedTrajectories: accepted,
    diagnostics: diagnosticFor(primitives.length, accepted),
    options,
  })
}

const UNIT_OPTIONS = Object.freeze({
  sampleSpacing: 1,
  shortPathLength: 5,
  longPathLength: 8,
})

describe('Flowing Contours reference metric vocabulary', () => {
  it('defines zero and empty-inventory behavior without NaN shares', () => {
    const result = measure([])

    expect(result).toMatchObject({
      pathCount: 0,
      shortPathCount: 0,
      shortPathShare: 0,
      medianPathLength: 0,
      upperQuartilePathLength: 0,
      longestPathLength: 0,
      totalPathLength: 0,
      longGeometryShare: 0,
      visibleEndpointCount: 0,
      endpointCount: 0,
      maximumUnsupportedSpanLength: 0,
      totalUnsupportedSpanLength: 0,
      totalAcceptedTrajectoryLength: 0,
      turnEnergy: 0,
      maximumTurnDegrees: 0,
      turnsOver25DegreesShare: 0,
      turnsOver45DegreesShare: 0,
      orthogonalStaircaseSignature: 0,
      occupiedCoverageBinCount: 0,
      occupiedCoverageBinShare: 0,
    })
    expect(Object.values(result).some(Number.isNaN)).toBe(false)
  })

  it('uses Euclidean length and linear R-7 percentile interpolation', () => {
    const result = measure(
      [10, 20, 30, 40].map((length, index) =>
        primitive([
          [0, index * 10],
          [length, index * 10],
        ]),
      ),
      { ...UNIT_OPTIONS, shortPathLength: 15, longPathLength: 30 },
    )

    expect(result.pathCount).toBe(4)
    expect(result.shortPathCount).toBe(1)
    expect(result.shortPathShare).toBe(0.25)
    expect(result.medianPathLength).toBe(25)
    expect(result.upperQuartilePathLength).toBe(32.5)
    expect(result.longestPathLength).toBe(40)
    expect(result.totalPathLength).toBe(100)
    expect(result.longPathCount).toBe(2)
    expect(result.longGeometryLength).toBe(70)
    expect(result.longGeometryShare).toBe(0.7)
  })

  it('counts a closed edge once and ignores its repeated endpoint representation', () => {
    const repeated = measure(
      [
        primitive(
          [
            [10, 10],
            [20, 10],
            [20, 20],
            [10, 20],
            [10, 10],
          ],
          true,
        ),
      ],
      UNIT_OPTIONS,
    )
    const implicit = measure(
      [
        primitive(
          [
            [10, 10],
            [20, 10],
            [20, 20],
            [10, 20],
          ],
          true,
        ),
      ],
      UNIT_OPTIONS,
    )

    expect(repeated.totalPathLength).toBe(40)
    expect(repeated.visibleEndpointCount).toBe(0)
    expect(repeated).toEqual(implicit)
  })

  it('retains endpoint, unsupported-span, and accepted-length evidence', () => {
    const accepted = [
      trajectory(0, {
        length: 17,
        unsupportedSpans: [2, 1],
      }),
      trajectory(1, {
        length: 23,
        unsupportedSpans: [4, 1],
      }),
    ]
    const result = measure(
      [
        primitive([
          [0, 10],
          [80, 10],
        ]),
        primitive([
          [0, 20],
          [80, 20],
        ]),
      ],
      UNIT_OPTIONS,
      accepted,
    )

    expect(result.endpointCount).toBe(4)
    expect(result.visibleEndpointCount).toBe(4)
    expect(result.endpointReasonCounts).toMatchObject({
      'source-boundary': 2,
      'evidence-exhausted': 2,
    })
    expect(result.maximumUnsupportedSpanLength).toBe(4)
    expect(result.totalUnsupportedSpanLength).toBe(8)
    expect(result.totalAcceptedTrajectoryLength).toBe(40)
  })

  it('does not clamp raw geometry inventory at the objective length ceiling', () => {
    const accepted = [
      trajectory(0, { length: 50, analysisDiagonal: 100 }),
      trajectory(1, { length: 200, analysisDiagonal: 100 }),
    ]
    const result = measure(
      [
        primitive([
          [10, 20],
          [90, 20],
        ]),
        primitive([
          [10, 40],
          [90, 40],
        ]),
      ],
      UNIT_OPTIONS,
      accepted,
    )

    // The score contribution is 1.5 + 3: the second trajectory clamps at one
    // analysis diagonal. The anti-deletion inventory remains the actual 250.
    expect(accepted.map(({ score }) => score.usefulLength)).toEqual([1.5, 3])
    expect(result.totalAcceptedTrajectoryLength).toBe(250)
  })

  it('accepts bounded-gap provenance oriented in reverse travel', () => {
    const gapLength = 1 + Math.SQRT2
    const endpointTangentX = 2 / Math.sqrt(5)
    const endpointTangentY = 1 / Math.sqrt(5)
    const alignment = endpointTangentX
    const accumulatedEvidence = (4 * 2) / 3
    const usefulLength = (3 * gapLength) / 100
    const directionalCoherence = 2 * alignment
    const unsupportedTravelPenalty = (4.5 * gapLength) / 100
    const reversedGap = {
      id: 0,
      anchorId: 0,
      samples: [
        {
          point: [2, 1],
          tangent: [-endpointTangentX, -endpointTangentY],
          evidence: 1,
          coherence: 1,
          ambiguity: 0,
          scale: 1,
          alpha: 1,
        },
        {
          point: [1, 0],
          tangent: [-1, 0],
          evidence: 0,
          coherence: 1,
          ambiguity: 0,
          scale: 1,
          alpha: 1,
        },
        {
          point: [0, 0],
          tangent: [-endpointTangentX, -endpointTangentY],
          evidence: 1,
          coherence: 1,
          ambiguity: 0,
          scale: 1,
          alpha: 1,
        },
      ],
      spanSupport: [
        {
          kind: 'bounded-gap',
          startSampleIndex: 0,
          endSampleIndex: 2,
          length: gapLength,
          entryEvidence: 1,
          exitEvidence: 1,
          // Retained from forward growth. Recomputing in assembled reverse
          // order yields sqrt(1/2), so accepting only that value is wrong.
          directionalAlignment: alignment,
        },
      ],
      startEndpointReason: 'source-boundary',
      endEndpointReason: 'evidence-exhausted',
      length: gapLength,
      maximumUnsupportedSpanLength: gapLength,
      totalUnsupportedSpanLength: gapLength,
      score: {
        accumulatedEvidence,
        usefulLength,
        directionalCoherence,
        curvaturePenalty: 0,
        unsupportedTravelPenalty,
        ambiguityPenalty: 0,
        representedOverlapPenalty: 0,
        total:
          accumulatedEvidence +
          usefulLength +
          directionalCoherence -
          unsupportedTravelPenalty,
      },
    } as AcceptedFlowingTrajectory
    const accepted = [reversedGap]
    const result = measure(
      [
        primitive([
          [10, 20],
          [90, 20],
        ]),
      ],
      UNIT_OPTIONS,
      accepted,
    )

    expect(result.totalAcceptedTrajectoryLength).toBe(gapLength)
    expect(result.maximumUnsupportedSpanLength).toBe(gapLength)
    expect(result.totalUnsupportedSpanLength).toBe(gapLength)

    const forgedDirection = {
      ...accepted[0]!,
      samples: accepted[0]!.samples.map((sample) => ({
        ...sample,
        tangent: [1, 0] as Point,
      })),
    } as AcceptedFlowingTrajectory
    expect(() =>
      measureFlowingContoursReference({
        scene: {
          space: { width: 100, height: 100 },
          primitives: [
            primitive([
              [10, 20],
              [90, 20],
            ]),
          ],
        },
        acceptedTrajectories: [forgedDirection],
        diagnostics: diagnosticFor(1, [forgedDirection]),
        options: UNIT_OPTIONS,
      }),
    ).toThrow(/alignment mismatch/)
  })

  it('is invariant to collinear point density for straight and diagonal paths', () => {
    const sparse = [
      primitive([
        [10, 20],
        [90, 20],
      ]),
      primitive([
        [10, 10],
        [90, 90],
      ]),
    ]
    const dense = [
      primitive(
        Array.from({ length: 81 }, (_, index) => [10 + index, 20] as Point),
      ),
      primitive(
        Array.from(
          { length: 81 },
          (_, index) => [10 + index, 10 + index] as Point,
        ),
      ),
    ]

    const first = measure(sparse, UNIT_OPTIONS)
    const second = measure(dense, UNIT_OPTIONS)

    expect(second.totalPathLength).toBeCloseTo(first.totalPathLength, 12)
    expect(second.sampledPointCount).toBe(first.sampledPointCount)
    expect(second.turnEnergy).toBeCloseTo(first.turnEnergy, 12)
    expect(second.turnsOver25DegreesCount).toBe(first.turnsOver25DegreesCount)
    expect(second.occupiedCoverageBins).toEqual(first.occupiedCoverageBins)
  })

  it('separates smooth arcs from repeated orthogonal staircase turns', () => {
    const arc = primitive(
      Array.from({ length: 65 }, (_, index) => {
        const angle = Math.PI + (Math.PI * index) / 64
        return [50 + 35 * Math.cos(angle), 50 + 35 * Math.sin(angle)] as Point
      }),
    )
    const staircase = primitive([
      [10, 10],
      [30, 10],
      [30, 30],
      [50, 30],
      [50, 50],
      [70, 50],
      [70, 70],
      [90, 70],
    ])
    const arcResult = measure([arc], UNIT_OPTIONS)
    const stairResult = measure([staircase], UNIT_OPTIONS)

    expect(arcResult.maximumTurnDegrees).toBeLessThan(10)
    expect(arcResult.turnsOver25DegreesCount).toBe(0)
    expect(arcResult.orthogonalStaircaseSignature).toBe(0)
    expect(stairResult.maximumTurnDegrees).toBeCloseTo(90, 8)
    expect(stairResult.turnsOver45DegreesCount).toBeGreaterThanOrEqual(6)
    expect(stairResult.orthogonalTurnCount).toBeGreaterThanOrEqual(6)
    expect(stairResult.staircasePairCount).toBeGreaterThanOrEqual(5)
    expect(stairResult.orthogonalStaircaseSignature).toBeGreaterThan(0.8)
  })

  it('measures loops, arcs, and mixed inventories deterministically', () => {
    const loop = primitive(
      Array.from({ length: 32 }, (_, index) => {
        const angle = (index / 32) * Math.PI * 2
        return [25 + 12 * Math.cos(angle), 25 + 12 * Math.sin(angle)] as Point
      }),
      true,
    )
    const mixed = [
      loop,
      primitive([
        [5, 80],
        [95, 80],
      ]),
      primitive([
        [80, 5],
        [80, 9],
      ]),
    ]

    const first = measure(mixed, UNIT_OPTIONS)
    const second = measure(mixed, UNIT_OPTIONS)

    expect(first).toEqual(second)
    expect(first.pathCount).toBe(3)
    expect(first.shortPathCount).toBe(1)
    expect(first.visibleEndpointCount).toBe(4)
    expect(first.turnCount).toBeGreaterThan(0)
    expect(first.longPathCount).toBe(2)
  })

  it('makes all closed turn metrics invariant to nonintegral cyclic start phase', () => {
    const points: Point[] = [
      [10, 10],
      [30.2, 10],
      [30.2, 30.8],
      [25.2, 30.8],
      [25.2, 37.8],
      [31.2, 37.8],
      [31.2, 60.8],
      [10, 60.8],
    ]
    // At spacing 1, authored starts expose corners at .2/.8 and .5 phases.
    const shiftedOne = [...points.slice(1), ...points.slice(0, 1)]
    const shiftedThree = [...points.slice(3), ...points.slice(0, 3)]
    const rotatedShift = shiftedThree.map(([x, y]) => [100 - y, x] as Point)
    const denseA = densifyClosed(points, (edgeIndex) =>
      edgeIndex % 3 === 0
        ? [0.13, 0.61]
        : edgeIndex % 3 === 1
          ? [0.27]
          : [0.08, 0.42, 0.87],
    )
    const denseB = densifyClosed(points, (edgeIndex) =>
      edgeIndex % 2 === 0 ? [0.2, 0.8] : [0.5],
    )
    const shiftedDenseA = [...denseA.slice(7), ...denseA.slice(0, 7)]
    const rotatedDenseB = denseB
      .map(([x, y]) => [100 - y, x] as Point)
      .slice(5)
      .concat(denseB.map(([x, y]) => [100 - y, x] as Point).slice(0, 5))
    const first = measure([primitive(points, true)], UNIT_OPTIONS)
    const shiftedResults = [
      measure([primitive(shiftedOne, true)], UNIT_OPTIONS),
      measure([primitive(shiftedThree, true)], UNIT_OPTIONS),
      measure([primitive(rotatedShift, true)], UNIT_OPTIONS),
      measure([primitive(denseA, true)], UNIT_OPTIONS),
      measure([primitive(shiftedDenseA, true)], UNIT_OPTIONS),
      measure([primitive(denseB, true)], UNIT_OPTIONS),
      measure([primitive(rotatedDenseB, true)], UNIT_OPTIONS),
    ]

    expect(first.staircasePairCount).toBeGreaterThan(0)
    for (const result of shiftedResults) {
      expect(result.turnCount).toBe(first.turnCount)
      expect(result.turnEnergy).toBe(first.turnEnergy)
      expect(result.maximumTurnDegrees).toBe(first.maximumTurnDegrees)
      expect(result.turnsOver25DegreesCount).toBe(first.turnsOver25DegreesCount)
      expect(result.turnsOver25DegreesShare).toBe(first.turnsOver25DegreesShare)
      expect(result.turnsOver45DegreesCount).toBe(first.turnsOver45DegreesCount)
      expect(result.turnsOver45DegreesShare).toBe(first.turnsOver45DegreesShare)
      expect(result.orthogonalTurnCount).toBe(first.orthogonalTurnCount)
      expect(result.staircasePairCount).toBe(first.staircasePairCount)
      expect(result.orthogonalStaircaseSignature).toBe(
        first.orthogonalStaircaseSignature,
      )
      expect(result.totalPathLength).toBe(first.totalPathLength)
    }
  })

  it('retains a genuine closed-path 180-degree cusp', () => {
    const result = measure(
      [
        primitive(
          [
            [10, 10],
            [40, 10],
            [25, 10],
            [25, 40],
          ],
          true,
        ),
      ],
      UNIT_OPTIONS,
    )

    expect(result.maximumTurnDegrees).toBe(180)
    expect(result.turnsOver45DegreesCount).toBeGreaterThan(0)
  })

  it('preserves dimensionless flow metrics under translation, rotation, and scale', () => {
    const sourcePoints: Point[] = [
      [20, 30],
      [40, 30],
      [50, 45],
      [60, 60],
      [80, 60],
    ]
    const translated = sourcePoints.map(([x, y]) => [x + 5, y + 10] as Point)
    const rotated = sourcePoints.map(([x, y]) => [100 - y, x] as Point)
    const scaled = sourcePoints.map(([x, y]) => [x * 2, y * 2] as Point)

    const original = measure([primitive(sourcePoints)])
    const moved = measure([primitive(translated)])
    const turned = measure([primitive(rotated)])
    const enlarged = measure([primitive(scaled)], undefined, [trajectory(0)], {
      width: 200,
      height: 200,
    })

    for (const result of [moved, turned, enlarged]) {
      expect(result.turnCount).toBe(original.turnCount)
      expect(result.turnEnergy).toBeCloseTo(original.turnEnergy, 9)
      expect(result.maximumTurnDegrees).toBeCloseTo(
        original.maximumTurnDegrees,
        9,
      )
      expect(result.turnsOver25DegreesShare).toBe(
        original.turnsOver25DegreesShare,
      )
      expect(result.orthogonalStaircaseSignature).toBe(
        original.orthogonalStaircaseSignature,
      )
      expect(result.longGeometryShare).toBe(original.longGeometryShare)
    }
    expect(enlarged.totalPathLength).toBeCloseTo(
      original.totalPathLength * 2,
      9,
    )
  })

  it('uses row-major half-open coverage bins and normalized named regions', () => {
    const result = measure(
      [
        primitive([
          [50, 0],
          [50, 100],
        ]),
      ],
      {
        ...UNIT_OPTIONS,
        coverageColumns: 2,
        coverageRows: 2,
        regions: [
          { name: 'left', left: 0, top: 0, right: 0.5, bottom: 1 },
          { name: 'right', left: 0.5, top: 0, right: 1, bottom: 1 },
          { name: 'corner', left: 0, top: 0, right: 0.2, bottom: 0.2 },
        ],
      },
    )

    expect(result.occupiedCoverageBins).toEqual(['0,1', '1,1'])
    expect(result.occupiedCoverageBinShare).toBe(0.5)
    expect(result.regions).toEqual([
      { name: 'left', occupied: false, sampledPointCount: 0 },
      { name: 'right', occupied: true, sampledPointCount: 101 },
      { name: 'corner', occupied: false, sampledPointCount: 0 },
    ])
  })

  it('uses strict turn thresholds with tolerance', () => {
    function bent(degrees: number): Primitive {
      const angle = (degrees * Math.PI) / 180
      return primitive([
        [10, 50],
        [40, 50],
        [40 + 30 * Math.cos(angle), 50 + 30 * Math.sin(angle)],
      ])
    }

    expect(measure([bent(25)], UNIT_OPTIONS).turnsOver25DegreesCount).toBe(0)
    expect(measure([bent(25.1)], UNIT_OPTIONS).turnsOver25DegreesCount).toBe(1)
    expect(measure([bent(45)], UNIT_OPTIONS).turnsOver45DegreesCount).toBe(0)
    expect(measure([bent(45.1)], UNIT_OPTIONS).turnsOver45DegreesCount).toBe(1)
  })

  it('fails closed on malformed, nonfinite, inconsistent, and over-cap inputs', () => {
    const accepted = [trajectory(0)]
    const diagnostics = diagnosticFor(1, accepted)
    const validScene: Scene = {
      space: { width: 100, height: 100 },
      primitives: [
        primitive([
          [0, 0],
          [10, 10],
        ]),
      ],
    }

    expect(() =>
      measureFlowingContoursReference({
        scene: {
          ...validScene,
          primitives: [
            primitive([
              [0, 0],
              [Number.NaN, 10],
            ]),
          ],
        },
        acceptedTrajectories: accepted,
        diagnostics,
      }),
    ).toThrow(/Invalid Flowing Contours reference input/)
    expect(() =>
      measureFlowingContoursReference({
        scene: validScene,
        acceptedTrajectories: accepted,
        diagnostics: { ...diagnostics, rawTrajectoryCount: 2 },
      }),
    ).toThrow(/mismatch/)
    expect(() =>
      measureFlowingContoursReference({
        scene: validScene,
        acceptedTrajectories: accepted,
        diagnostics,
        options: { coverageColumns: 65 },
      }),
    ).toThrow(/coverage columns/)
    expect(() =>
      measureFlowingContoursReference({
        scene: validScene,
        acceptedTrajectories: accepted,
        diagnostics,
        options: {
          sampleSpacing: Number.MIN_VALUE,
          shortPathLength: 1,
          longPathLength: 2,
        },
      }),
    ).toThrow(/resampled point cap/)
    expect(() =>
      measureFlowingContoursReference({
        scene: {
          ...validScene,
          primitives: [
            primitive([
              [-1, 0],
              [10, 10],
            ]),
          ],
        },
        acceptedTrajectories: accepted,
        diagnostics,
      }),
    ).toThrow(/outside Scene/)

    const mismatchedLength = {
      ...accepted[0]!,
      length: accepted[0]!.length + 1,
    } as AcceptedFlowingTrajectory
    expect(() =>
      measureFlowingContoursReference({
        scene: validScene,
        acceptedTrajectories: [mismatchedLength],
        diagnostics: diagnosticFor(1, [mismatchedLength]),
      }),
    ).toThrow(/length mismatch/)

    const firstSpan = accepted[0]!.spanSupport[0]!
    const mismatchedProvenance = {
      ...accepted[0]!,
      spanSupport: [
        { ...firstSpan, length: firstSpan.length + 1 },
        ...accepted[0]!.spanSupport.slice(1),
      ],
    } as AcceptedFlowingTrajectory
    expect(() =>
      measureFlowingContoursReference({
        scene: validScene,
        acceptedTrajectories: [mismatchedProvenance],
        diagnostics: diagnosticFor(1, [mismatchedProvenance]),
      }),
    ).toThrow(/span 0 length mismatch/)

    for (const malformedProvenance of [
      replaceFirstSpan(accepted[0]!, {
        entryEvidence: Number.NaN,
      }),
      replaceFirstSpan(accepted[0]!, {
        exitEvidence: 0.5,
      }),
      replaceFirstSpan(accepted[0]!, {
        directionalAlignment: Number.NaN,
      }),
      replaceFirstSpan(accepted[0]!, {
        directionalAlignment: 0.5,
      }),
    ]) {
      expect(() =>
        measureFlowingContoursReference({
          scene: validScene,
          acceptedTrajectories: [malformedProvenance],
          diagnostics: diagnosticFor(1, [malformedProvenance]),
        }),
      ).toThrow(/span 0/)
    }

    for (const malformedSample of [
      replaceFirstSample(accepted[0]!, {
        point: [Number.NaN, 0],
      }),
      replaceFirstSample(accepted[0]!, {
        tangent: [Number.NaN, 0],
      }),
      replaceFirstSample(accepted[0]!, {
        tangent: [2, 0],
      }),
      replaceFirstSample(accepted[0]!, {
        evidence: Number.NaN,
      }),
      replaceFirstSample(accepted[0]!, {
        evidence: -0.1,
      }),
      replaceFirstSample(accepted[0]!, {
        coherence: Number.NaN,
      }),
      replaceFirstSample(accepted[0]!, {
        coherence: 1.1,
      }),
      replaceFirstSample(accepted[0]!, {
        ambiguity: Number.NaN,
      }),
      replaceFirstSample(accepted[0]!, {
        ambiguity: -0.1,
      }),
      replaceFirstSample(accepted[0]!, {
        scale: Number.NaN,
      }),
      replaceFirstSample(accepted[0]!, {
        scale: -1,
      }),
      replaceFirstSample(accepted[0]!, {
        scale: 0,
      }),
      replaceFirstSample(accepted[0]!, {
        alpha: Number.NaN,
      }),
      replaceFirstSample(accepted[0]!, {
        alpha: 1.1,
      }),
      replaceFirstSample(accepted[0]!, {
        alpha: 0,
      }),
    ]) {
      expect(() =>
        measureFlowingContoursReference({
          scene: validScene,
          acceptedTrajectories: [malformedSample],
          diagnostics: diagnosticFor(1, [malformedSample]),
        }),
      ).toThrow(/trajectory 0 sample 0/)
    }

    const direct = accepted[0]!
    const degenerate = {
      ...direct,
      samples: [
        direct.samples[0]!,
        { ...direct.samples[0] },
        direct.samples[1]!,
      ],
      spanSupport: [
        {
          ...direct.spanSupport[0]!,
          endSampleIndex: 2,
        },
      ],
    } as AcceptedFlowingTrajectory
    expect(() =>
      measureFlowingContoursReference({
        scene: validScene,
        acceptedTrajectories: [degenerate],
        diagnostics: diagnosticFor(1, [degenerate]),
      }),
    ).toThrow(/degenerate sample segment/)

    const hostileSpace = {}
    Object.defineProperty(hostileSpace, 'width', {
      get() {
        throw new Error('nope')
      },
    })
    expect(() =>
      measureFlowingContoursReference({
        scene: { ...validScene, space: hostileSpace as Scene['space'] },
        acceptedTrajectories: accepted,
        diagnostics,
      }),
    ).toThrow(/hostile accessor/)
  })
})
