import { describe, expect, it } from 'vitest'

import {
  flowingContoursPencilComparisonFindings,
  flowingContoursReferenceGateFindings,
  FLOWING_CONTOURS_REFERENCE_CASES,
  FLOWING_CONTOURS_REFERENCE_GATES,
  type FlowingContoursReferenceCaseName,
} from './helpers/flowingContoursReferenceCases'
import type {
  FlowingContoursReferenceMetrics,
} from './helpers/flowingContoursReferenceMetrics'

const DIAGONAL = Math.hypot(1000, 1000)

function passingMetrics(
  name: FlowingContoursReferenceCaseName,
): Readonly<FlowingContoursReferenceMetrics> {
  const gate = FLOWING_CONTOURS_REFERENCE_GATES[name]
  const pathCount = 12
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
    totalPathLength:
      DIAGONAL * gate.minimumTotalPathDiagonalMultiple * 1.1,
    longPathCount: gate.minimumLongPathCount,
    longGeometryLength:
      DIAGONAL *
      gate.minimumTotalPathDiagonalMultiple *
      gate.minimumLongGeometryShare,
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
    maximumUnsupportedSpanLength: gate.maximumUnsupportedSpanLength,
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

function changedMetrics(
  metrics: Readonly<FlowingContoursReferenceMetrics>,
  changes: Partial<FlowingContoursReferenceMetrics>,
): Readonly<FlowingContoursReferenceMetrics> {
  return { ...metrics, ...changes }
}

describe('Flowing Contours hard reference gates', () => {
  it.each(['flower', 'pinecone'] as const)(
    'accepts a complete smooth, flowing %s inventory at every boundary',
    (name) => {
      expect(
        flowingContoursReferenceGateFindings(name, passingMetrics(name)),
      ).toEqual([])
    },
  )

  it('rejects #396-style stumpy texture even when total plotted length is high', () => {
    const baseline = passingMetrics('flower')
    const findings = flowingContoursReferenceGateFindings(
      'flower',
      changedMetrics(baseline, {
        pathCount: 200,
        shortPathCount: 160,
        shortPathShare: 0.8,
        medianPathLength: DIAGONAL * 0.008,
        upperQuartilePathLength: DIAGONAL * 0.012,
        longestPathLength: DIAGONAL * 0.2,
        totalPathLength: DIAGONAL * 4,
        longPathCount: 4,
        longGeometryLength: DIAGONAL,
        longGeometryShare: 0.25,
      }),
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

  it('rejects #402-style lattice stair steps even with excellent path lengths', () => {
    const baseline = passingMetrics('pinecone')
    const findings = flowingContoursReferenceGateFindings(
      'pinecone',
      changedMetrics(baseline, {
        turnCount: 200,
        maximumTurnDegrees: 90,
        turnsOver25DegreesCount: 80,
        turnsOver25DegreesShare: 0.4,
        turnsOver45DegreesCount: 60,
        turnsOver45DegreesShare: 0.3,
        orthogonalTurnCount: 60,
        staircasePairCount: 45,
        orthogonalStaircaseSignature: 0.75,
      }),
    )
    expect(findings).toEqual(
      expect.arrayContaining([
        'turns-over-25',
        'turns-over-45',
        'staircase-pairs',
        'orthogonal-staircase',
      ]),
    )
    expect(findings).not.toEqual(
      expect.arrayContaining([
        'median-path-length',
        'upper-quartile-path-length',
        'longest-path-length',
      ]),
    )
  })

  it.each(['flower', 'pinecone'] as const)(
    'rejects %s deletion and subject erasure region by region',
    (name) => {
      const baseline = passingMetrics(name)
      const firstRegion = baseline.regions[0]!
      const findings = flowingContoursReferenceGateFindings(
        name,
        changedMetrics(baseline, {
          totalPathLength: DIAGONAL * 0.5,
          occupiedCoverageBinCount: 2,
          regions: baseline.regions.map((region) =>
            region.name === firstRegion.name
              ? { ...region, occupied: false, sampledPointCount: 0 }
              : region,
          ),
        }),
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

  it('requires evidence in every flower gesture and pinecone tier', () => {
    expect(
      Object.keys(
        FLOWING_CONTOURS_REFERENCE_GATES.flower
          .minimumRegionSampledPointCount,
      ),
    ).toEqual([
      'left-petals',
      'flower-center',
      'right-petals',
      'lower-gesture',
    ])
    expect(
      Object.keys(
        FLOWING_CONTOURS_REFERENCE_GATES.pinecone
          .minimumRegionSampledPointCount,
      ),
    ).toEqual([
      'upper-scales',
      'middle-scales',
      'lower-scales',
      'left-interior',
      'right-interior',
    ])
  })

  it('rejects an unsupported bridge independently of smooth geometry', () => {
    const baseline = passingMetrics('flower')
    expect(
      flowingContoursReferenceGateFindings(
        'flower',
        changedMetrics(baseline, {
          maximumUnsupportedSpanLength:
            FLOWING_CONTOURS_REFERENCE_GATES.flower
              .maximumUnsupportedSpanLength + 0.001,
        }),
      ),
    ).toContain('unsupported-span')
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
        { ...flowing, longestPathLength: pencil.longestPathLength },
        pencil,
      ),
    ).toEqual(['pencil-longest-path-length'])
  })

  it('pairs favorable shares with non-share inventory and spatial gates', () => {
    for (const gate of Object.values(FLOWING_CONTOURS_REFERENCE_GATES)) {
      expect(gate.minimumPathCount).toBeGreaterThan(0)
      expect(gate.minimumLongPathCount).toBeGreaterThan(0)
      expect(gate.minimumTotalPathDiagonalMultiple).toBeGreaterThan(0)
      expect(gate.minimumOccupiedCoverageBinCount).toBeGreaterThan(0)
      expect(
        Object.keys(gate.minimumRegionSampledPointCount).length,
      ).toBeGreaterThan(0)
    }
  })
})
