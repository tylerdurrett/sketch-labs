import { describe, expect, it } from 'vitest'

import { buildFlowingContoursAnchorInventory } from '../sketches/flowing-contours/anchors'
import { createFlowingContoursAccounting } from '../sketches/flowing-contours/accounting'
import {
  certifyFlowingContoursCandidateAgainstField,
  searchFlowingContoursCandidateDetailed,
} from '../sketches/flowing-contours/search'
import { createFlowingContoursEvidenceTube } from '../sketches/flowing-contours/tube'
import {
  flowingContoursAcceptedTrajectorySourceHypothesis,
  flowingContoursAcceptedTrajectorySourceField,
  runFlowingContoursFieldEnsemblePipeline,
  runFlowingContoursPipeline,
} from '../sketches/flowing-contours/pipeline'
import {
  createFlowingContoursTestLimits,
  FLOWING_CONTOURS_LIMITS,
} from '../sketches/flowing-contours/limits'
import type {
  FlowingContoursField,
  FlowingContoursFieldEnsemble,
} from '../sketches/flowing-contours/types'
import type { Point } from '../types'

interface FieldValue {
  readonly evidence: number
  readonly tangent: Readonly<Point>
  readonly coherence?: number
  readonly ambiguity?: number
}

const CONTROLS = Object.freeze({
  curveDetail: 1,
  continuity: 0,
  flowSmoothing: 0.7,
  minimumStrokeLength: 0.01,
})

function gaussian(distance: number, width = 0.6): number {
  return Math.exp(-(distance * distance) / (2 * width * width))
}

function field(
  width: number,
  height: number,
  valueAt: (x: number, y: number) => FieldValue,
): Readonly<FlowingContoursField> {
  const luminance: number[] = []
  const alpha: number[] = []
  const positiveSupport: boolean[] = []
  const contourEvidence: number[] = []
  const tangentX: number[] = []
  const tangentY: number[] = []
  const tangentCoherence: number[] = []
  const ambiguity: number[] = []
  const ridgeScale: number[] = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = valueAt(x, y)
      luminance.push(0.5)
      alpha.push(1)
      positiveSupport.push(true)
      contourEvidence.push(value.evidence)
      tangentX.push(value.tangent[0])
      tangentY.push(value.tangent[1])
      tangentCoherence.push(value.coherence ?? 1)
      ambiguity.push(value.ambiguity ?? 0)
      ridgeScale.push(1)
    }
  }
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze(luminance),
    alpha: Object.freeze(alpha),
    positiveSupport: Object.freeze(positiveSupport),
    contourEvidence: Object.freeze(contourEvidence),
    tangentX: Object.freeze(tangentX),
    tangentY: Object.freeze(tangentY),
    tangentCoherence: Object.freeze(tangentCoherence),
    ambiguity: Object.freeze(ambiguity),
    ridgeScale: Object.freeze(ridgeScale),
  })
}

function horizontal(
  width: number,
  height: number,
  row: number,
  amplitude = 1,
) {
  return field(width, height, (_x, y) => ({
    evidence: amplitude * gaussian(y - row),
    tangent: [1, 0],
  }))
}

function vertical(
  width: number,
  height: number,
  column: number,
  amplitude = 1,
) {
  return field(width, height, (x) => ({
    evidence: amplitude * gaussian(x - column),
    tangent: [0, 1],
  }))
}

function authenticatedHorizontalWithLocalHorizontal(
  width: number,
  height: number,
  broadRow: number,
  localRow: number,
  localAmplitude = 1,
  localHalfWidth = Number.POSITIVE_INFINITY,
) {
  const center = (width - 1) / 2
  return field(width, height, (x, y) => {
    const broadEvidence = 0.045 * gaussian(y - broadRow)
    const localEvidence =
      Math.abs(x - center) <= localHalfWidth
        ? localAmplitude * gaussian(y - localRow)
        : 0
    return broadEvidence > localEvidence
      ? {
          evidence: broadEvidence,
          tangent: [1, 0],
          coherence: 0.9,
          ambiguity: 0.1,
        }
      : {
          evidence: localEvidence,
          tangent: [1, 0],
        }
  })
}

function authenticatedHorizontalWithLocalVertical(
  width: number,
  height: number,
  row: number,
  column: number,
) {
  return field(width, height, (x, y) => {
    const broadEvidence = 0.045 * gaussian(y - row)
    const localEvidence = gaussian(x - column)
    const unresolvedCrossing =
      Math.abs(x - column) <= 1 && Math.abs(y - row) <= 1
    if (unresolvedCrossing) {
      return {
        evidence: Math.max(broadEvidence, localEvidence),
        tangent: [1, 0],
        coherence: 0.01,
        ambiguity: 1,
      }
    }
    return broadEvidence > localEvidence
      ? {
          evidence: broadEvidence,
          tangent: [1, 0],
          coherence: 0.9,
          ambiguity: 0.1,
        }
      : {
          evidence: localEvidence,
          tangent: [0, 1],
        }
  })
}

function ownershipDriftLocal(
  width: number,
  height: number,
  row: number,
): Readonly<FlowingContoursField> {
  return field(width, height, (x, y) => {
    const alternatingOffset = Math.floor(x / 2) % 2 === 0 ? -0.75 : 0.75
    const localPeak = gaussian(y - (row + alternatingOffset), 0.3)
    const directCorridor = 0.05 * gaussian(y - row, 2.5)
    return {
      evidence: Math.max(localPeak, directCorridor),
      tangent: [1, 0],
      coherence: 1,
      ambiguity: 0,
    }
  })
}

function withRidgeScale(
  source: Readonly<FlowingContoursField>,
  scale: number,
): Readonly<FlowingContoursField> {
  return Object.freeze({
    ...source,
    ridgeScale: Object.freeze(
      new Array<number>(source.ridgeScale.length).fill(scale),
    ),
  })
}

function ensemble(
  broad: Readonly<FlowingContoursField>,
  local: Readonly<FlowingContoursField>,
  mid: Readonly<FlowingContoursField> = Object.freeze({
    ...local,
    contourEvidence: Object.freeze(
      new Array<number>(local.contourEvidence.length).fill(0),
    ),
    ridgeScale: Object.freeze(
      new Array<number>(local.ridgeScale.length).fill(0),
    ),
  }),
): Readonly<FlowingContoursFieldEnsemble> {
  return Object.freeze({
    hypotheses: Object.freeze([
      Object.freeze({ kind: 'broad-form' as const, field: broad }),
      Object.freeze({ kind: 'mid-form' as const, field: mid }),
      Object.freeze({ kind: 'local-detail' as const, field: local }),
    ]),
  })
}

describe('Flowing Contours bounded field ensemble', () => {
  it('requires the exact broad, mid, local hypothesis inventory and order', () => {
    const broad = horizontal(21, 21, 5)
    const mid = horizontal(21, 21, 10)
    const local = horizontal(21, 21, 15)
    const invalid = [
      Object.freeze({
        hypotheses: Object.freeze([
          Object.freeze({ kind: 'broad-form' as const, field: broad }),
          Object.freeze({ kind: 'local-detail' as const, field: local }),
        ]),
      }),
      Object.freeze({
        hypotheses: Object.freeze([
          Object.freeze({ kind: 'mid-form' as const, field: mid }),
          Object.freeze({ kind: 'broad-form' as const, field: broad }),
          Object.freeze({ kind: 'local-detail' as const, field: local }),
        ]),
      }),
    ]

    for (const candidate of invalid) {
      expect(
        runFlowingContoursFieldEnsemblePipeline(
          candidate as Readonly<FlowingContoursFieldEnsemble>,
          CONTROLS,
        ).diagnostics.termination,
      ).toBe('invalid-input')
    }
  })

  it('keeps broad and local whole-curve topology in one stable result', () => {
    const broad = horizontal(31, 31, 8)
    const local = authenticatedHorizontalWithLocalHorizontal(
      31,
      31,
      8,
      22,
    )
    const result = runFlowingContoursFieldEnsemblePipeline(
      ensemble(broad, local),
      { ...CONTROLS, continuity: 1 },
    )

    expect(result.diagnostics.termination).toBe('complete')
    const hypotheses = result.acceptedTrajectories.map((trajectory) =>
      flowingContoursAcceptedTrajectorySourceHypothesis(trajectory),
    )
    expect(hypotheses).toContain('broad-form')
    expect(hypotheses).toContain('local-detail')
    expect(
      result.acceptedTrajectories
        .filter(
          (trajectory) =>
            flowingContoursAcceptedTrajectorySourceHypothesis(trajectory) !==
            'local-detail',
        )
        .every(
          (trajectory) =>
            trajectory.totalUnsupportedSpanLength === 0 &&
            trajectory.spanSupport.every(
              ({ kind }) => kind === 'direct-evidence',
            ),
        ),
    ).toBe(true)
    expect(
      result.acceptedTrajectories.every(
        (trajectory) =>
          flowingContoursAcceptedTrajectorySourceField(trajectory) === local,
      ),
    ).toBe(true)
    expect(result.acceptedTrajectories.length).toBe(
      result.fittedCurves.length,
    )
  })

  it('never rebinds accepted evidence or tube provenance across hypotheses', () => {
    const broad = horizontal(31, 31, 8)
    const local = authenticatedHorizontalWithLocalHorizontal(
      31,
      31,
      8,
      22,
    )
    const result = runFlowingContoursFieldEnsemblePipeline(
      ensemble(broad, local),
      CONTROLS,
    )

    for (const trajectory of result.acceptedTrajectories) {
      const source = flowingContoursAcceptedTrajectorySourceField(trajectory)
      expect(source).toBe(local)
      expect(
        createFlowingContoursEvidenceTube(source!, trajectory),
      ).not.toBeNull()
      expect(createFlowingContoursEvidenceTube(broad, trajectory)).toBeNull()
      expect(
        flowingContoursAcceptedTrajectorySourceField({ ...trajectory }),
      ).toBeNull()
      expect(
        flowingContoursAcceptedTrajectorySourceHypothesis({
          ...trajectory,
        }),
      ).toBeNull()
    }
  })

  it('shares accepted occupancy without duplicate flooding', () => {
    const first = horizontal(31, 31, 15)
    const equivalent = horizontal(31, 31, 15)
    const single = runFlowingContoursPipeline(first, CONTROLS)
    const combined = runFlowingContoursFieldEnsemblePipeline(
      ensemble(first, equivalent),
      CONTROLS,
    )

    expect(combined.acceptedTrajectories).toHaveLength(
      single.acceptedTrajectories.length,
    )
    expect(combined.acceptedTrajectories).toHaveLength(1)
    expect(combined.diagnostics.suppressedAnchorCount).toBeGreaterThan(0)
    expect(
      flowingContoursAcceptedTrajectorySourceField(
        combined.acceptedTrajectories[0]!,
      ),
    ).toBe(equivalent)
  })

  it('auditions the stronger broad candidate before an earlier local anchor', () => {
    const broad = horizontal(31, 31, 8, 1)
    const earlierLocal = authenticatedHorizontalWithLocalHorizontal(
      31,
      31,
      8,
      22,
      0.05,
      4,
    )
    const result = runFlowingContoursFieldEnsemblePipeline(
      ensemble(broad, earlierLocal),
      CONTROLS,
    )

    expect(result.acceptedTrajectories.length).toBeGreaterThan(0)
    expect(
      flowingContoursAcceptedTrajectorySourceHypothesis(
        result.acceptedTrajectories[0]!,
      ),
    ).toBe('broad-form')
    expect(
      flowingContoursAcceptedTrajectorySourceField(
        result.acceptedTrajectories[0]!,
      ),
    ).toBe(earlierLocal)
  })

  it('is deterministic and applies one aggregate candidate cap and order', () => {
    const input = ensemble(
      horizontal(31, 31, 8),
      horizontal(31, 31, 22),
    )
    const first = runFlowingContoursFieldEnsemblePipeline(input, CONTROLS)
    const second = runFlowingContoursFieldEnsemblePipeline(input, CONTROLS)
    expect(second).toEqual(first)

    const limits = createFlowingContoursTestLimits({
      'candidate-count': 1,
    })!
    const limited = runFlowingContoursFieldEnsemblePipeline(
      input,
      CONTROLS,
      limits,
    )
    expect(limited.diagnostics).toMatchObject({
      termination: 'limit-reached',
      limitedBy: 'candidate-count',
      candidateCount: 1,
    })
    expect(limited.diagnostics.candidateCount).toBeLessThanOrEqual(
      FLOWING_CONTOURS_LIMITS['candidate-count'],
    )
    expect(
      flowingContoursAcceptedTrajectorySourceField(
        limited.acceptedTrajectories[0]!,
      ),
    ).toBe(input.hypotheses[2]!.field)
  })

  it('preserves parallel ridges and a perpendicular crossing', () => {
    const parallels = runFlowingContoursFieldEnsemblePipeline(
      ensemble(
        horizontal(31, 31, 8),
        authenticatedHorizontalWithLocalHorizontal(31, 31, 8, 22),
      ),
      CONTROLS,
    )
    expect(
      new Set(
        parallels.acceptedTrajectories.map((trajectory) =>
          flowingContoursAcceptedTrajectorySourceHypothesis(trajectory),
        ),
      ).size,
    ).toBe(2)
    expect(parallels.acceptedTrajectories).toHaveLength(2)

    const crossing = runFlowingContoursFieldEnsemblePipeline(
      ensemble(
        horizontal(31, 31, 15),
        authenticatedHorizontalWithLocalVertical(31, 31, 15, 15),
      ),
      { ...CONTROLS, continuity: 1 },
    )
    expect(crossing.acceptedTrajectories.length).toBeGreaterThanOrEqual(2)
    expect(
      crossing.acceptedTrajectories.every(
        (trajectory) =>
          trajectory.length > 8 &&
          trajectory.totalUnsupportedSpanLength === 0,
      ),
    ).toBe(true)
    expect(
      crossing.acceptedTrajectories.every(
        (trajectory) =>
          flowingContoursAcceptedTrajectorySourceHypothesis(trajectory) ===
          'local-detail',
      ),
    ).toBe(true)
    expect(crossing.diagnostics.termination).toBe('complete')
  })

  it('uses a direct mid guide when local correction repeatedly loses ownership', () => {
    const local = ownershipDriftLocal(41, 21, 10)
    const controls = {
      ...CONTROLS,
      continuity: 0,
      minimumStrokeLength: 0.2,
    }
    const localOnly = runFlowingContoursPipeline(local, controls)
    const combined = runFlowingContoursFieldEnsemblePipeline(
      ensemble(
        horizontal(41, 21, 10, 0),
        local,
        horizontal(41, 21, 10),
      ),
      controls,
    )

    expect(
      Math.max(
        0,
        ...localOnly.acceptedTrajectories.map(({ length }) => length),
      ),
    ).toBeLessThan(16)
    const mid = combined.acceptedTrajectories.filter(
      (trajectory) =>
        flowingContoursAcceptedTrajectorySourceHypothesis(trajectory) ===
        'mid-form',
    )
    expect(mid.length).toBeGreaterThan(0)
    expect(
      mid.every(
        (trajectory) =>
          trajectory.length > 16 &&
          trajectory.totalUnsupportedSpanLength === 0 &&
          trajectory.spanSupport.every(
            ({ kind }) => kind === 'direct-evidence',
          ) &&
          flowingContoursAcceptedTrajectorySourceField(trajectory) === local,
      ),
    ).toBe(true)
  })

  it('lets guide search use one adjacent stencil maximum before exact local proof', () => {
    const width = 49
    const height = 31
    const row = 10
    const boundary = 24
    const angle = Math.PI / 6
    const tangent: Point = [Math.cos(angle), Math.sin(angle)]
    const ridgeY = (x: number) =>
      x <= boundary
        ? row
        : row + 0.1 + (x - boundary) * Math.tan(angle)
    const guide = withRidgeScale(
      field(width, height, (x, y) => {
        return {
          evidence: gaussian(y - ridgeY(x), 0.6),
          tangent: x <= boundary ? [1, 0] : tangent,
        }
      }),
      4,
    )
    const local = field(width, height, (x, y) => ({
      evidence: gaussian(y - ridgeY(x), 2),
      tangent: x <= boundary ? [1, 0] : tangent,
    }))
    const contradictory = field(width, height, (x, y) => ({
      evidence: gaussian(y - ridgeY(x), 2),
      tangent: [0, 1],
    }))
    const anchors = buildFlowingContoursAnchorInventory(
      guide,
      createFlowingContoursAccounting(),
    ).anchors
    const anchor = [...anchors].sort(
      (first, second) =>
        Math.abs(first.sample.point[0] - (boundary - 4)) -
        Math.abs(second.sample.point[0] - (boundary - 4)),
    )[0]!
    const ordinary = searchFlowingContoursCandidateDetailed(
      guide,
      anchor,
      { continuity: 0, flowSmoothing: 0.7 },
    ).candidate
    const widened = searchFlowingContoursCandidateDetailed(
      guide,
      anchor,
      {
        continuity: 0,
        flowSmoothing: 0.7,
        ridgeStepOptions: { maximumOwnershipRadius: 0.75 },
      },
    ).candidate

    expect(ordinary).not.toBeNull()
    expect(widened).not.toBeNull()
    expect(ordinary!.length).toBeLessThan(30)
    expect(widened!.length).toBeGreaterThan(ordinary!.length + 8)
    const authenticated = certifyFlowingContoursCandidateAgainstField(
      widened!,
      local,
      0,
      0.7,
    )
    expect(authenticated).not.toBeNull()
    expect(
      authenticated!.spanSupport.every(
        ({ kind }) => kind === 'direct-evidence',
      ),
    ).toBe(true)
    expect(
      certifyFlowingContoursCandidateAgainstField(
        widened!,
        contradictory,
        0,
        0.7,
      ),
    ).toBeNull()
  })

  it.each([
    ['accepted-curve-count', 0],
    ['fitted-curve-point-count', 1],
    ['primitive-count', 0],
  ] as const)(
    'preflights a zero-output %s cap without search or partial output',
    (limit, value) => {
      const input = ensemble(
        horizontal(31, 31, 8),
        vertical(31, 31, 22),
      )
      const result = runFlowingContoursFieldEnsemblePipeline(
        input,
        CONTROLS,
        createFlowingContoursTestLimits({ [limit]: value })!,
      )

      expect(result.acceptedTrajectories).toEqual([])
      expect(result.fittedCurves).toEqual([])
      expect(result.diagnostics).toMatchObject({
        termination: 'limit-reached',
        limitedBy: limit,
        searchStepCount: 0,
        candidateCount: 0,
      })
    },
  )

  it.each([
    ['accepted-curve-count', 1],
    ['primitive-count', 1],
    ['fitted-curve-point-count', 2],
  ] as const)(
    'publishes only complete curve transactions at a lowered %s cap',
    (limit, value) => {
      const result = runFlowingContoursFieldEnsemblePipeline(
        ensemble(
          horizontal(31, 31, 8),
          authenticatedHorizontalWithLocalHorizontal(31, 31, 8, 22),
        ),
        CONTROLS,
        createFlowingContoursTestLimits({ [limit]: value })!,
      )

      expect(result.diagnostics).toMatchObject({
        termination: 'limit-reached',
        limitedBy: limit,
      })
      expect(result.acceptedTrajectories.length).toBe(
        result.fittedCurves.length,
      )
      expect(
        result.fittedCurves.every((curve) => curve.points.length >= 2),
      ).toBe(true)
      expect(
        result.acceptedTrajectories.map(({ id }) => id),
      ).toEqual(
        result.acceptedTrajectories.map((_trajectory, index) => index),
      )
    },
  )

  it('keeps accepted ids contiguous when a represented candidate is rejected', () => {
    const result = runFlowingContoursFieldEnsemblePipeline(
      ensemble(horizontal(31, 31, 15), horizontal(31, 31, 15)),
      CONTROLS,
    )

    expect(result.acceptedTrajectories.map(({ id }) => id)).toEqual([0])
    expect(result.diagnostics).toMatchObject({
      acceptedCandidateCount: 1,
      rawTrajectoryCount: 1,
    })
    expect(result.diagnostics.rejectedCandidateCount).toBeGreaterThan(0)
  })
})
