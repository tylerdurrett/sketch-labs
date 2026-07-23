import { describe, expect, it } from 'vitest'

import type { Primitive, Scene } from '../scene'
import {
  flowingContoursPencilComparisonFindings,
  flowingContoursReferenceGateFindings,
  FLOWING_CONTOURS_REFERENCE_CASES,
  FLOWING_CONTOURS_REFERENCE_GATES,
  measureFlowingContoursReferenceGeometryEvidence,
  type FlowingContoursReferenceCaseName,
  type FlowingContoursReferenceGateEvidence,
  type FlowingContoursReferenceGeometryEvidence,
} from './helpers/flowingContoursReferenceCases'
import type {
  FlowingContoursReferenceMetrics,
} from './helpers/flowingContoursReferenceMetrics'

const DIAGONAL = Math.hypot(1000, 1000)
const STROKE = Object.freeze({ color: 'black', width: 1 })

function passingMetrics(
  name: FlowingContoursReferenceCaseName,
): Readonly<FlowingContoursReferenceMetrics> {
  const gate = FLOWING_CONTOURS_REFERENCE_GATES[name]
  const pathCount = 12
  const totalPathLength =
    DIAGONAL * gate.minimumTotalPathDiagonalMultiple * 1.1
  return Object.freeze({
    pathCount,
    shortPathCount: 0,
    shortPathShare: 0,
    medianPathLength:
      DIAGONAL * gate.minimumMedianPathDiagonalFraction * 1.1,
    upperQuartilePathLength:
      DIAGONAL * gate.minimumUpperQuartilePathDiagonalFraction * 1.1,
    longestPathLength:
      DIAGONAL * gate.minimumLongestPathDiagonalFraction * 1.1,
    totalPathLength,
    longPathCount: gate.minimumLongPathCount,
    longGeometryLength:
      totalPathLength * gate.minimumLongGeometryShare,
    longGeometryShare: gate.minimumLongGeometryShare,
    visibleEndpointCount: pathCount * 2,
    endpointCount: pathCount * 2,
    endpointReasonCounts: {
      'source-boundary': pathCount * 2,
      'alpha-boundary': 0,
      ambiguity: 0,
      curvature: 0,
      'evidence-exhausted': 0,
      'represented-collision': 0,
      'safety-limit': 0,
    },
    maximumUnsupportedSpanLength: 0,
    totalUnsupportedSpanLength: 0,
    totalAcceptedTrajectoryLength: 300,
    sampledPathCount: pathCount,
    sampledPointCount: 1000,
    turnEnergy: 1,
    turnCount: 100,
    maximumTurnDegrees: 20,
    turnsOver25DegreesCount: 0,
    turnsOver25DegreesShare: 0,
    turnsOver45DegreesCount: 0,
    turnsOver45DegreesShare: 0,
    orthogonalTurnCount: 0,
    staircasePairCount: 0,
    orthogonalStaircaseSignature: 0,
    coverageColumns: 4,
    coverageRows: 4,
    occupiedCoverageBins: Array.from(
      { length: gate.minimumOccupiedCoverageBinCount },
      (_, index) => `${Math.floor(index / 4)},${index % 4}`,
    ),
    occupiedCoverageBinCount: gate.minimumOccupiedCoverageBinCount,
    occupiedCoverageBinShare:
      gate.minimumOccupiedCoverageBinCount / 16,
    regions: FLOWING_CONTOURS_REFERENCE_CASES[name].regions.map(
      ({ name: regionName }) => ({
        name: regionName,
        occupied: true,
        sampledPointCount:
          gate.minimumRegionSampledPointCount[regionName]!,
      }),
    ),
    sampleSpacing: DIAGONAL / 400,
    shortPathLength: DIAGONAL * 0.015,
    longPathLength: DIAGONAL * 0.08,
    numericTolerance: DIAGONAL * 1e-10,
  })
}

function passingEvidence(
  name: FlowingContoursReferenceCaseName,
  metrics: Readonly<FlowingContoursReferenceMetrics>,
  geometry: Partial<FlowingContoursReferenceGeometryEvidence> = {},
): Readonly<FlowingContoursReferenceGateEvidence> {
  return {
    geometry: {
      pathCount: metrics.pathCount,
      segmentCount: metrics.pathCount * 10,
      totalSegmentLength: metrics.totalPathLength,
      primaryAxisLengthShare: 0.3,
      perpendicularAxisLengthShare: 0.15,
      primaryAxisPathCount: 1,
      perpendicularAxisPathCount: 1,
      ...geometry,
    },
    topology: FLOWING_CONTOURS_REFERENCE_GATES[
      name
    ].topologyCheckNames.map((checkName) => ({
      name: checkName,
      sourceConnectionVerified: true,
      forbiddenBridgeObserved: false,
    })),
  }
}

function changedMetrics(
  metrics: Readonly<FlowingContoursReferenceMetrics>,
  changes: Partial<FlowingContoursReferenceMetrics>,
): Readonly<FlowingContoursReferenceMetrics> {
  return { ...metrics, ...changes }
}

function line(
  start: readonly [number, number],
  end: readonly [number, number],
): Primitive {
  return {
    points: [
      [start[0], start[1]],
      [end[0], end[1]],
    ],
    stroke: STROKE,
  }
}

function orientedLine(
  center: readonly [number, number],
  angle: number,
  length: number,
): Primitive {
  const halfX = Math.cos(angle) * length * 0.5
  const halfY = Math.sin(angle) * length * 0.5
  return line(
    [center[0] - halfX, center[1] - halfY],
    [center[0] + halfX, center[1] + halfY],
  )
}

function lineMetrics(
  name: FlowingContoursReferenceCaseName,
  geometry: Readonly<FlowingContoursReferenceGeometryEvidence>,
): Readonly<FlowingContoursReferenceMetrics> {
  const baseline = passingMetrics(name)
  const pathLength = geometry.totalSegmentLength / geometry.pathCount
  return changedMetrics(baseline, {
    pathCount: geometry.pathCount,
    shortPathCount: 0,
    shortPathShare: 0,
    medianPathLength: pathLength,
    upperQuartilePathLength: pathLength,
    longestPathLength: pathLength,
    totalPathLength: geometry.totalSegmentLength,
    longPathCount: geometry.pathCount,
    longGeometryLength: geometry.totalSegmentLength,
    longGeometryShare: 1,
    visibleEndpointCount: geometry.pathCount * 2,
    endpointCount: geometry.pathCount * 2,
    endpointReasonCounts: {
      ...baseline.endpointReasonCounts,
      'source-boundary': geometry.pathCount * 2,
    },
    sampledPathCount: geometry.pathCount,
    sampledPointCount: geometry.pathCount * 20,
    turnEnergy: 0,
    turnCount: 0,
    maximumTurnDegrees: 0,
  })
}

describe('Flowing Contours hard reference gates', () => {
  it.each(['flower', 'pinecone'] as const)(
    'accepts a complete smooth, flowing %s inventory at every boundary',
    (name) => {
      const metrics = passingMetrics(name)
      expect(
        flowingContoursReferenceGateFindings(
          name,
          metrics,
          passingEvidence(name, metrics),
        ),
      ).toEqual([])
    },
  )

  it('rejects #396-style stumpy texture despite high plotted length', () => {
    const baseline = passingMetrics('flower')
    const totalPathLength = DIAGONAL * 4
    const metrics = changedMetrics(baseline, {
      pathCount: 200,
      shortPathCount: 160,
      shortPathShare: 0.8,
      medianPathLength: DIAGONAL * 0.008,
      upperQuartilePathLength: DIAGONAL * 0.012,
      longestPathLength: DIAGONAL * 0.2,
      totalPathLength,
      longPathCount: 4,
      longGeometryLength: DIAGONAL,
      longGeometryShare: DIAGONAL / totalPathLength,
      visibleEndpointCount: 400,
      endpointCount: 400,
      endpointReasonCounts: {
        ...baseline.endpointReasonCounts,
        'source-boundary': 400,
      },
      sampledPathCount: 200,
    })
    const findings = flowingContoursReferenceGateFindings(
      'flower',
      metrics,
      passingEvidence('flower', metrics),
    )
    expect(findings).toEqual(
      expect.arrayContaining([
        'short-path-share',
        'median-path-length',
        'upper-quartile-path-length',
        'long-geometry-share',
      ]),
    )
    expect(findings).not.toContain('total-path-length')
  })

  it('rejects #402-style stair steps despite excellent path lengths', () => {
    const baseline = passingMetrics('pinecone')
    const metrics = changedMetrics(baseline, {
      turnCount: 200,
      maximumTurnDegrees: 90,
      turnsOver25DegreesCount: 80,
      turnsOver25DegreesShare: 0.4,
      turnsOver45DegreesCount: 60,
      turnsOver45DegreesShare: 0.3,
      orthogonalTurnCount: 60,
      staircasePairCount: 45,
      orthogonalStaircaseSignature: 0.75,
    })
    const findings = flowingContoursReferenceGateFindings(
      'pinecone',
      metrics,
      passingEvidence('pinecone', metrics),
    )
    expect(findings).toEqual(
      expect.arrayContaining([
        'turns-over-25',
        'turns-over-45',
        'staircase-pairs',
        'orthogonal-staircase',
      ]),
    )
  })

  it('rejects four horizontal plus four vertical long grid lines', () => {
    const primitives = [
      ...[200, 350, 500, 650].map((y) => line([100, y], [900, y])),
      ...[200, 350, 500, 650].map((x) => line([x, 100], [x, 900])),
    ]
    const scene: Scene = {
      space: { width: 1000, height: 1000 },
      primitives,
    }
    const geometry =
      measureFlowingContoursReferenceGeometryEvidence(scene)!
    const metrics = lineMetrics('flower', geometry)

    expect(geometry).toMatchObject({
      pathCount: 8,
      primaryAxisLengthShare: 0.5,
      perpendicularAxisLengthShare: 0.5,
      primaryAxisPathCount: 4,
      perpendicularAxisPathCount: 4,
    })
    expect(
      flowingContoursReferenceGateFindings('flower', metrics, {
        ...passingEvidence('flower', metrics),
        geometry,
      }),
    ).toContain('orthogonal-grid-family')
  })

  it('rejects a rotated two-by-two lattice', () => {
    const angle = Math.PI / 6
    const direction = [Math.cos(angle), Math.sin(angle)] as const
    const perpendicular = [-direction[1], direction[0]] as const
    const offset = 100
    const primitives = [
      orientedLine(
        [
          500 + perpendicular[0] * offset,
          500 + perpendicular[1] * offset,
        ],
        angle,
        600,
      ),
      orientedLine(
        [
          500 - perpendicular[0] * offset,
          500 - perpendicular[1] * offset,
        ],
        angle,
        600,
      ),
      orientedLine(
        [
          500 + direction[0] * offset,
          500 + direction[1] * offset,
        ],
        angle + Math.PI / 2,
        600,
      ),
      orientedLine(
        [
          500 - direction[0] * offset,
          500 - direction[1] * offset,
        ],
        angle + Math.PI / 2,
        600,
      ),
    ]
    const geometry =
      measureFlowingContoursReferenceGeometryEvidence({
        space: { width: 1000, height: 1000 },
        primitives,
      })!
    const metrics = lineMetrics('pinecone', geometry)

    expect(geometry.primaryAxisPathCount).toBe(2)
    expect(geometry.perpendicularAxisPathCount).toBe(2)
    expect(
      flowingContoursReferenceGateFindings('pinecone', metrics, {
        ...passingEvidence('pinecone', metrics),
        geometry,
      }),
    ).toContain('orthogonal-grid-family')
  })

  it('does not classify one legitimate straight contour as a grid family', () => {
    const scene: Scene = {
      space: { width: 1000, height: 1000 },
      primitives: [line([100, 500], [900, 500])],
    }
    const geometry =
      measureFlowingContoursReferenceGeometryEvidence(scene)!
    const metrics = lineMetrics('flower', geometry)
    const findings = flowingContoursReferenceGateFindings(
      'flower',
      metrics,
      {
        ...passingEvidence('flower', metrics),
        geometry,
      },
    )
    expect(
      Math.max(
        geometry.primaryAxisPathCount,
        geometry.perpendicularAxisPathCount,
      ),
    ).toBe(1)
    expect(findings).not.toContain('orthogonal-grid-family')
  })

  it('does not classify six legitimate parallel contours as a grid', () => {
    const geometry =
      measureFlowingContoursReferenceGeometryEvidence({
        space: { width: 1000, height: 1000 },
        primitives: [150, 280, 410, 540, 670, 800].map((y) =>
          line([100, y], [900, y]),
        ),
      })!
    const metrics = lineMetrics('flower', geometry)
    const familyCounts = [
      geometry.primaryAxisPathCount,
      geometry.perpendicularAxisPathCount,
    ].sort((first, second) => first - second)

    expect(familyCounts).toEqual([0, 6])
    expect(
      flowingContoursReferenceGateFindings('flower', metrics, {
        ...passingEvidence('flower', metrics),
        geometry,
      }),
    ).not.toContain('orthogonal-grid-family')
  })

  it.each(['flower', 'pinecone'] as const)(
    'rejects %s deletion and subject erasure region by region',
    (name) => {
      const baseline = passingMetrics(name)
      const firstRegion = baseline.regions[0]!
      const totalPathLength = DIAGONAL * 0.5
      const metrics = changedMetrics(baseline, {
        totalPathLength,
        longGeometryLength:
          totalPathLength * baseline.longGeometryShare,
        occupiedCoverageBins: ['0,0', '0,1'],
        occupiedCoverageBinCount: 2,
        occupiedCoverageBinShare: 2 / 16,
        regions: baseline.regions.map((region) =>
          region.name === firstRegion.name
            ? { ...region, occupied: false, sampledPointCount: 0 }
            : region,
        ),
      })
      const findings = flowingContoursReferenceGateFindings(
        name,
        metrics,
        passingEvidence(name, metrics),
      )
      expect(findings).toEqual(
        expect.arrayContaining([
          'total-path-length',
          'coverage',
          `region:${firstRegion.name}`,
        ]),
      )
    },
  )

  it('requires every named source-connection and forbidden-bridge check', () => {
    const metrics = passingMetrics('flower')
    const evidence = passingEvidence('flower', metrics)
    const first = evidence.topology[0]!
    expect(
      flowingContoursReferenceGateFindings('flower', metrics, {
        ...evidence,
        topology: evidence.topology.map((check) =>
          check.name === first.name
            ? { ...check, forbiddenBridgeObserved: true }
            : check,
        ),
      }),
    ).toContain(`topology:${first.name}`)
    expect(
      flowingContoursReferenceGateFindings('flower', metrics, {
        ...evidence,
        topology: evidence.topology.slice(1),
      }),
    ).toEqual(['invalid-evidence'])
  })

  it('rejects one overlong unsupported bridge', () => {
    const baseline = passingMetrics('flower')
    const maximumUnsupportedSpanLength =
      FLOWING_CONTOURS_REFERENCE_GATES.flower
        .maximumUnsupportedSpanLength + 0.001
    const metrics = changedMetrics(baseline, {
      maximumUnsupportedSpanLength,
      totalUnsupportedSpanLength: maximumUnsupportedSpanLength,
    })
    expect(
      flowingContoursReferenceGateFindings(
        'flower',
        metrics,
        passingEvidence('flower', metrics),
      ),
    ).toContain('unsupported-span')
  })

  it('rejects repeated individually legal gaps by total and ratio', () => {
    const baseline = passingMetrics('pinecone')
    const gate = FLOWING_CONTOURS_REFERENCE_GATES.pinecone
    const totalUnsupportedSpanLength =
      gate.maximumUnsupportedSpanLength * 5
    const metrics = changedMetrics(baseline, {
      maximumUnsupportedSpanLength: gate.maximumUnsupportedSpanLength,
      totalUnsupportedSpanLength,
      totalAcceptedTrajectoryLength: totalUnsupportedSpanLength * 5,
    })
    const findings = flowingContoursReferenceGateFindings(
      'pinecone',
      metrics,
      passingEvidence('pinecone', metrics),
    )
    expect(findings).toEqual(
      expect.arrayContaining([
        'total-unsupported-span',
        'unsupported-travel-ratio',
      ]),
    )
    expect(findings).not.toContain('unsupported-span')
  })

  it('fails closed on non-finite and inconsistent metric inventories', () => {
    const baseline = passingMetrics('flower')
    const evidence = passingEvidence('flower', baseline)
    const hostile = { ...baseline }
    Object.defineProperty(hostile, 'medianPathLength', {
      get() {
        throw new Error('hostile metric')
      },
    })
    const cases: readonly Readonly<FlowingContoursReferenceMetrics>[] = [
      changedMetrics(baseline, { medianPathLength: Number.NaN }),
      changedMetrics(baseline, { shortPathShare: 0.5 }),
      changedMetrics(baseline, { shortPathCount: baseline.pathCount + 1 }),
      changedMetrics(baseline, { occupiedCoverageBinCount: 7 }),
      changedMetrics(baseline, {
        endpointReasonCounts: {
          ...baseline.endpointReasonCounts,
          ambiguity: 1,
        },
      }),
      changedMetrics(baseline, {
        regions: baseline.regions.map((region, index) =>
          index === 0 ? { ...region, occupied: false } : region,
        ),
      }),
      hostile,
    ]
    for (const metrics of cases) {
      expect(
        flowingContoursReferenceGateFindings(
          'flower',
          metrics,
          evidence,
        ),
      ).toEqual(['invalid-metrics'])
    }
    expect(
      flowingContoursReferenceGateFindings('flower', baseline, {
        ...evidence,
        geometry: {
          ...evidence.geometry,
          primaryAxisLengthShare: Number.NaN,
        },
      }),
    ).toEqual(['invalid-evidence'])
  })

  it('strictly improves every required Pencil path-length direction', () => {
    const flowing = {
      shortPathShare: 0.1,
      medianPathLength: 50,
      upperQuartilePathLength: 100,
      longestPathLength: 250,
    }
    const pencil = {
      shortPathShare: 0.7,
      medianPathLength: 10,
      upperQuartilePathLength: 20,
      longestPathLength: 100,
    }
    expect(
      flowingContoursPencilComparisonFindings(flowing, pencil),
    ).toEqual([])
    expect(
      flowingContoursPencilComparisonFindings(pencil, pencil),
    ).toEqual([
      'pencil-short-path-share',
      'pencil-median-path-length',
      'pencil-upper-quartile-path-length',
      'pencil-longest-path-length',
    ])
    expect(
      flowingContoursPencilComparisonFindings(
        { ...flowing, longestPathLength: Number.POSITIVE_INFINITY },
        pencil,
      ),
    ).toEqual(['invalid-comparison-metrics'])
  })

  it('pairs favorable shares with inventory, spatial, and topology gates', () => {
    for (const gate of Object.values(FLOWING_CONTOURS_REFERENCE_GATES)) {
      expect(gate.minimumPathCount).toBeGreaterThan(0)
      expect(gate.minimumLongPathCount).toBeGreaterThan(0)
      expect(gate.minimumTotalPathDiagonalMultiple).toBeGreaterThan(0)
      expect(gate.minimumOccupiedCoverageBinCount).toBeGreaterThan(0)
      expect(gate.maximumUnsupportedTravelRatio).toBeLessThan(1)
      expect(
        Object.keys(gate.minimumRegionSampledPointCount).length,
      ).toBeGreaterThan(0)
      expect(gate.topologyCheckNames.length).toBeGreaterThan(0)
    }
  })
})
