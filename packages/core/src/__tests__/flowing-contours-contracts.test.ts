import { describe, expect, expectTypeOf, it } from 'vitest'

import type { Scene } from '../scene'
import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
  FLOWING_CONTOURS_LIMIT_NAMES,
  type AcceptedFlowingTrajectory,
  type CorrectedFlowingRidgeSample,
  type FittedFlowingCurve,
  type FlowingContoursAnchor,
  type FlowingContoursCandidate,
  type FlowingContoursDiagnostics,
  type FlowingContoursDirectionalTrace,
  type FlowingContoursEndpointReason,
  type FlowingContoursEndpointReasonCounts,
  type FlowingContoursField,
  type FlowingContoursGeneratorResult,
  type FlowingContoursLimitName,
  type FlowingContoursPipelineResult,
  type FlowingContoursSpanSupportProvenance,
} from '../sketches/flowing-contours/types'

const SAMPLE = {
  point: [0.25, 0.5],
  tangent: [Math.SQRT1_2, Math.SQRT1_2],
  evidence: 0.8,
  coherence: 0.9,
  ambiguity: 0.1,
  scale: 2,
  alpha: 1,
} as const satisfies CorrectedFlowingRidgeSample

const SCORE = {
  accumulatedEvidence: 4,
  usefulLength: 6,
  directionalCoherence: 0.9,
  curvaturePenalty: 0.1,
  unsupportedTravelPenalty: 0.2,
  ambiguityPenalty: 0,
  representedOverlapPenalty: 0,
  total: 10.6,
} as const

const DIRECT_SUPPORT = {
  kind: 'direct-evidence',
  startSampleIndex: 0,
  endSampleIndex: 1,
  length: 1,
  entryEvidence: 0.8,
  exitEvidence: 0.75,
  directionalAlignment: 0.95,
} as const satisfies FlowingContoursSpanSupportProvenance

const ENDPOINT_REASON_COUNTS = {
  'source-boundary': 1,
  'alpha-boundary': 2,
  ambiguity: 3,
  curvature: 4,
  'evidence-exhausted': 5,
  'represented-collision': 6,
  'safety-limit': 7,
} as const satisfies FlowingContoursEndpointReasonCounts

const DIAGNOSTICS = {
  termination: 'complete',
  limitedBy: null,
  analysisWidth: 2,
  analysisHeight: 1,
  analysisSampleCount: 2,
  contourEvidenceSampleCount: 2,
  correctedRidgeSampleCount: 2,
  eligibleAnchorCount: 1,
  processedAnchorCount: 1,
  directionalTraceCount: 2,
  searchStepCount: 2,
  candidateCount: 1,
  acceptedCandidateCount: 1,
  rejectedCandidateCount: 0,
  suppressedAnchorCount: 0,
  suppressedEvidenceSampleCount: 1,
  endpointReasonCounts: ENDPOINT_REASON_COUNTS,
  rawTrajectoryCount: 1,
  rawTrajectoryPointCount: 2,
  acceptedMaximumUnsupportedSpanLength: 0,
  acceptedTotalUnsupportedSpanLength: 0,
  fittedCurveCount: 1,
  fittedCurvePointCount: 2,
  primitiveCount: 1,
} as const satisfies FlowingContoursDiagnostics

describe('Flowing Contours contracts', () => {
  it('publishes the exact stable endpoint-reason inventory', () => {
    expect(FLOWING_CONTOURS_ENDPOINT_REASONS).toEqual([
      'source-boundary',
      'alpha-boundary',
      'ambiguity',
      'curvature',
      'evidence-exhausted',
      'represented-collision',
      'safety-limit',
    ])
    expect(new Set(FLOWING_CONTOURS_ENDPOINT_REASONS).size).toBe(7)
    expect(Object.isFrozen(FLOWING_CONTOURS_ENDPOINT_REASONS)).toBe(true)
    expect(Object.keys(ENDPOINT_REASON_COUNTS)).toEqual(
      FLOWING_CONTOURS_ENDPOINT_REASONS,
    )
    expectTypeOf<
      (typeof FLOWING_CONTOURS_ENDPOINT_REASONS)[number]
    >().toEqualTypeOf<FlowingContoursEndpointReason>()
  })

  it('publishes the exact complete deterministic-cap inventory', () => {
    expect(FLOWING_CONTOURS_LIMIT_NAMES).toEqual([
      'analysis-dimension',
      'analysis-sample-count',
      'scale-plane-count',
      'anchor-count',
      'normal-search-sample-count',
      'search-breadth',
      'search-step-count',
      'candidate-count',
      'weak-span-step-count',
      'weak-span-distance',
      'accepted-curve-count',
      'raw-trajectory-point-count',
      'fitted-curve-point-count',
      'primitive-count',
    ])
    expect(new Set(FLOWING_CONTOURS_LIMIT_NAMES).size).toBe(14)
    expect(Object.isFrozen(FLOWING_CONTOURS_LIMIT_NAMES)).toBe(true)
    expectTypeOf<
      (typeof FLOWING_CONTOURS_LIMIT_NAMES)[number]
    >().toEqualTypeOf<FlowingContoursLimitName>()
  })

  it('keeps continuous field, directional search, and whole-candidate records distinct', () => {
    const field = {
      sourceWidth: 2,
      sourceHeight: 1,
      width: 2,
      height: 1,
      luminance: [0.2, 0.8],
      alpha: [1, 1],
      positiveSupport: [true, true],
      contourEvidence: [0.75, 0.8],
      tangentX: [Math.SQRT1_2, Math.SQRT1_2],
      tangentY: [Math.SQRT1_2, Math.SQRT1_2],
      tangentCoherence: [0.9, 0.95],
      ambiguity: [0.1, 0.05],
      ridgeScale: [2, 2],
    } as const satisfies FlowingContoursField
    const anchor = {
      id: 4,
      fieldSampleIndex: 1,
      sample: SAMPLE,
    } as const satisfies FlowingContoursAnchor
    const backward = {
      direction: 'backward',
      samples: [SAMPLE],
      spanSupport: [],
      endpointReason: 'source-boundary',
      searchStepCount: 1,
    } as const satisfies FlowingContoursDirectionalTrace
    const forward = {
      direction: 'forward',
      samples: [SAMPLE],
      spanSupport: [],
      endpointReason: 'evidence-exhausted',
      searchStepCount: 1,
    } as const satisfies FlowingContoursDirectionalTrace
    const candidate = {
      anchor,
      backward,
      forward,
      samples: [SAMPLE, SAMPLE],
      spanSupport: [DIRECT_SUPPORT],
      length: 1,
      score: SCORE,
    } as const satisfies FlowingContoursCandidate

    expect(field.tangentX[0]).toBeCloseTo(Math.SQRT1_2)
    expect(candidate.backward.endpointReason).toBe('source-boundary')
    expect(candidate.forward.endpointReason).toBe('evidence-exhausted')
    expectTypeOf(candidate.samples).toMatchTypeOf<
      readonly Readonly<CorrectedFlowingRidgeSample>[]
    >()
  })

  it('retains raw acceptance and fitting provenance in the pipeline result', () => {
    const trajectory = {
      id: 8,
      anchorId: 4,
      samples: [SAMPLE, SAMPLE],
      spanSupport: [DIRECT_SUPPORT],
      startEndpointReason: 'source-boundary',
      endEndpointReason: 'evidence-exhausted',
      length: 1,
      maximumUnsupportedSpanLength: 0,
      totalUnsupportedSpanLength: 0,
      score: SCORE,
    } as const satisfies AcceptedFlowingTrajectory
    const fittedCurve = {
      points: [
        [0.25, 0.5],
        [1.25, 1.5],
      ],
      provenance: {
        sourceTrajectoryId: trajectory.id,
        sourceSampleIndices: [0, 1],
        evidenceTubeRadius: 0.25,
        maximumDeviation: 0.1,
      },
    } as const satisfies FittedFlowingCurve
    const pipeline = {
      acceptedTrajectories: [trajectory],
      fittedCurves: [fittedCurve],
      diagnostics: DIAGNOSTICS,
    } as const satisfies FlowingContoursPipelineResult

    expect(pipeline.acceptedTrajectories[0]?.samples).toEqual([
      SAMPLE,
      SAMPLE,
    ])
    expect(pipeline.fittedCurves[0]?.provenance.sourceTrajectoryId).toBe(8)
    expect(pipeline.diagnostics.endpointReasonCounts).toBe(
      ENDPOINT_REASON_COUNTS,
    )
    expectTypeOf(pipeline.acceptedTrajectories).toMatchTypeOf<
      readonly Readonly<AcceptedFlowingTrajectory>[]
    >()
  })

  it('keeps the public generator result to an ordinary Scene plus diagnostics', () => {
    const scene: Scene = {
      space: { width: 10, height: 8 },
      primitives: [],
    }
    const result = {
      scene,
      diagnostics: DIAGNOSTICS,
    } satisfies FlowingContoursGeneratorResult

    expect(Object.keys(result)).toEqual(['scene', 'diagnostics'])
    expect(result.scene).toBe(scene)
    expectTypeOf(result.scene).toEqualTypeOf<Scene>()
    expectTypeOf(result.diagnostics).toMatchTypeOf<
      Readonly<FlowingContoursDiagnostics>
    >()
  })
})
