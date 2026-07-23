import { describe, expect, it } from 'vitest'

import { sampleFlowingContoursField } from '../sketches/flowing-contours/field'
import { createFlowingContoursTestLimits } from '../sketches/flowing-contours/limits'
import { searchFlowingContoursCandidate } from '../sketches/flowing-contours/search'
import {
  FLOWING_CONTOURS_EVIDENCE_TUBE_HARD_MAX_RADIUS,
  createFlowingContoursEvidenceTube,
  validateFlowingContoursTubeCurve,
  validateFlowingContoursTubePoint,
  validateFlowingContoursTubeSegment,
} from '../sketches/flowing-contours/tube'
import type {
  AcceptedFlowingTrajectory,
  CorrectedFlowingRidgeSample,
  FlowingContoursCandidateScore,
  FlowingContoursField,
  FlowingContoursSpanSupportProvenance,
} from '../sketches/flowing-contours/types'
import type { Point } from '../types'

interface FieldValue {
  readonly evidence?: number
  readonly tangent?: Readonly<Point>
  readonly coherence?: number
  readonly ambiguity?: number
  readonly scale?: number
  readonly alpha?: number
}

const SCORE: FlowingContoursCandidateScore = Object.freeze({
  accumulatedEvidence: 1,
  usefulLength: 1,
  directionalCoherence: 1,
  curvaturePenalty: 0,
  unsupportedTravelPenalty: 0,
  ambiguityPenalty: 0,
  representedOverlapPenalty: 0,
  total: 3,
})

function field(
  width: number,
  height: number,
  valueAt: (x: number, y: number) => FieldValue = () => ({}),
): FlowingContoursField {
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
      const sampleAlpha = value.alpha ?? 1
      const tangent = value.tangent ?? ([1, 0] as const)
      luminance.push(0.5)
      alpha.push(sampleAlpha)
      positiveSupport.push(sampleAlpha > 0)
      contourEvidence.push(value.evidence ?? 1)
      tangentX.push(tangent[0])
      tangentY.push(tangent[1])
      tangentCoherence.push(value.coherence ?? 1)
      ambiguity.push(value.ambiguity ?? 0)
      ridgeScale.push(value.scale ?? 1)
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

function sampled(
  source: Readonly<FlowingContoursField>,
  point: Readonly<Point>,
): Readonly<CorrectedFlowingRidgeSample> {
  const result = sampleFlowingContoursField(source, point)
  if (result === null) throw new Error(`Expected sample at ${point}`)
  return result
}

function length(points: readonly Readonly<Point>[]): number {
  let result = 0
  for (let index = 1; index < points.length; index += 1) {
    result += Math.hypot(
      points[index]![0] - points[index - 1]![0],
      points[index]![1] - points[index - 1]![1],
    )
  }
  return result
}

function directSpan(
  source: readonly Readonly<CorrectedFlowingRidgeSample>[],
  start = 0,
  end = source.length - 1,
): FlowingContoursSpanSupportProvenance {
  return Object.freeze({
    kind: 'direct-evidence',
    startSampleIndex: start,
    endSampleIndex: end,
    length: length(
      source.slice(start, end + 1).map((sample) => sample.point),
    ),
    entryEvidence: source[start]!.evidence,
    exitEvidence: source[end]!.evidence,
    directionalAlignment: 1,
  })
}

function trajectory(
  source: Readonly<FlowingContoursField>,
  points: readonly Readonly<Point>[],
  spans?: readonly Readonly<FlowingContoursSpanSupportProvenance>[],
): AcceptedFlowingTrajectory {
  const samples = Object.freeze(points.map((point) => sampled(source, point)))
  const support = Object.freeze(spans ?? [directSpan(samples)])
  const gaps = support.filter((span) => span.kind === 'bounded-gap')
  return Object.freeze({
    id: 17,
    anchorId: 3,
    samples,
    spanSupport: support,
    startEndpointReason: 'source-boundary',
    endEndpointReason: 'evidence-exhausted',
    length: length(points),
    maximumUnsupportedSpanLength: Math.max(
      0,
      ...gaps.map((span) => span.length),
    ),
    totalUnsupportedSpanLength: gaps.reduce(
      (sum, span) => sum + span.length,
      0,
    ),
    score: SCORE,
  })
}

function allIndices(count: number): readonly number[] {
  return Array.from({ length: count }, (_value, index) => index)
}

function gaussian(distance: number, width = 0.65): number {
  return Math.exp(-(distance * distance) / (2 * width * width))
}

function canonicalGapAlignment(
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  span: Readonly<FlowingContoursSpanSupportProvenance>,
): number {
  const entry = samples[span.startSampleIndex]!
  let result = 1
  for (
    let index = span.startSampleIndex + 1;
    index <= span.endSampleIndex;
    index += 1
  ) {
    const sample = samples[index]!
    const dx = sample.point[0] - entry.point[0]
    const dy = sample.point[1] - entry.point[1]
    const distance = Math.hypot(dx, dy)
    result = Math.min(
      result,
      entry.tangent[0] * sample.tangent[0] +
        entry.tangent[1] * sample.tangent[1],
      (entry.tangent[0] * dx + entry.tangent[1] * dy) / distance,
      (sample.tangent[0] * dx + sample.tangent[1] * dy) / distance,
    )
  }
  return result
}

describe('Flowing Contours corrected-trajectory evidence tube', () => {
  it('preserves the final monotonic correspondence of a repeated loop endpoint', () => {
    const source = field(12, 12)
    const raw = trajectory(source, [
      [3, 3],
      [7, 3],
      [7, 7],
      [3, 7],
      [3, 3],
    ])
    const tube = createFlowingContoursEvidenceTube(source, raw)

    expect(tube).not.toBeNull()
    expect(
      validateFlowingContoursTubeCurve(
        source,
        tube!,
        {
          points: raw.samples.map((sample) => sample.point),
          sourceSampleIndices: allIndices(raw.samples.length),
        },
      ),
    ).toMatchObject({
      sourceTrajectoryId: raw.id,
      sourceSampleIndices: [0, 1, 2, 3, 4],
      maximumDeviation: 0,
    })
    expect(
      validateFlowingContoursTubePoint(source, tube!, {
        point: raw.samples.at(-1)!.point,
        sourceSampleIndex: raw.samples.length - 1,
      }),
    ).toMatchObject({
      sourceSampleIndex: raw.samples.length - 1,
    })
  })

  it('does not alias a merely near-closed endpoint to the loop origin', () => {
    const source = field(12, 12)
    const raw = trajectory(source, [
      [3, 3],
      [7, 3],
      [7, 7],
      [3, 7],
      [3 + 5e-10, 3],
    ])
    const tube = createFlowingContoursEvidenceTube(source, raw)
    const identity = raw.samples.map((sample) => sample.point)
    const snapped = [...identity]
    snapped[snapped.length - 1] = raw.samples[0]!.point

    expect(tube).not.toBeNull()
    expect(
      validateFlowingContoursTubeCurve(source, tube!, {
        points: identity,
        sourceSampleIndices: allIndices(raw.samples.length),
      }),
    ).not.toBeNull()
    expect(
      validateFlowingContoursTubePoint(source, tube!, {
        point: raw.samples[0]!.point,
        sourceSampleIndex: raw.samples.length - 1,
      }),
    ).toBeNull()
    expect(
      validateFlowingContoursTubeCurve(source, tube!, {
        points: snapped,
        sourceSampleIndices: allIndices(raw.samples.length),
      }),
    ).toBeNull()
  })

  it('accepts points on the local scale tube and rejects points outside it', () => {
    const source = field(12, 9)
    const raw = trajectory(source, [
      [2, 4],
      [3, 4],
      [4, 4],
      [5, 4],
      [6, 4],
    ])
    const tube = createFlowingContoursEvidenceTube(source, raw)!

    expect(tube.evidenceTubeRadius).toBe(0.25)
    const inside = validateFlowingContoursTubePoint(source, tube, {
      point: [4, 4.2],
      sourceSampleIndex: 2,
    })
    expect(inside).toMatchObject({
      sourceSampleIndex: 2,
      supportKind: 'direct-evidence',
    })
    expect(inside!.deviation).toBeCloseTo(0.2)
    expect(
      validateFlowingContoursTubePoint(source, tube, {
        point: [4, 4.3],
        sourceSampleIndex: 2,
      }),
    ).toBeNull()
  })

  it.each([
    {
      name: 'diagonal',
      source: field(14, 14, () => ({
        tangent: [Math.SQRT1_2, Math.SQRT1_2],
      })),
      points: [
        [2, 2],
        [3, 3],
        [4, 4],
        [5, 5],
        [6, 6],
        [7, 7],
      ] as const,
    },
    {
      name: 'arc',
      source: field(18, 18),
      points: Array.from({ length: 9 }, (_value, index) => {
        const angle = (index * Math.PI) / 16
        return [
          5 + 7 * Math.cos(angle),
          5 + 7 * Math.sin(angle),
        ] as const
      }),
    },
  ])('validates a finite $name raw-following curve', ({ source, points }) => {
    const raw = trajectory(source, points)
    const tube = createFlowingContoursEvidenceTube(source, raw)!
    const result = validateFlowingContoursTubeCurve(source, tube, {
      points,
      sourceSampleIndices: allIndices(points.length),
    })

    expect(result).toMatchObject({ sourceTrajectoryId: raw.id })
    expect(result!.maximumDeviation).toBeCloseTo(0)
    expect(result!.validationSampleCount).toBeGreaterThan(points.length)
  })

  it('rejects a high-curvature chord instead of smoothing it into a shortcut', () => {
    const source = field(14, 14, () => ({ scale: 4 }))
    const points = [
      [2, 6],
      [2.5, 4],
      [4, 2.5],
      [6, 2],
      [8, 2.5],
      [9.5, 4],
      [10, 6],
    ] as const
    const raw = trajectory(source, points)
    const tube = createFlowingContoursEvidenceTube(source, raw)!

    expect(
      validateFlowingContoursTubeCurve(source, tube, {
        points: [points[0], points.at(-1)!],
        sourceSampleIndices: [0, points.length - 1],
      }),
    ).toBeNull()
  })

  it('rejects zero-alpha travel even when it remains inside the geometric tube', () => {
    const source = field(9, 8, (x, y) => ({
      scale: 4,
      alpha: x === 4 && y === 4 ? 0 : 1,
    }))
    const points = [
      [2, 3],
      [3, 3],
      [4, 3],
      [5, 3],
      [6, 3],
    ] as const
    const raw = trajectory(source, points)
    const tube = createFlowingContoursEvidenceTube(source, raw)!

    expect(
      validateFlowingContoursTubeCurve(source, tube, {
        points: [points[0], [4, 4], points.at(-1)!],
        sourceSampleIndices: [0, 2, 4],
      }),
    ).toBeNull()
  })

  it.each([
    { channel: 'zero alpha', alpha: 0, evidence: 1 },
    { channel: 'unresolved evidence', alpha: 1, evidence: 0 },
  ])(
    'finds a phase-offset $channel line at an exact lattice crossing',
    ({ alpha, evidence }) => {
      const source = field(9, 7, (x, y) => ({
        scale: 4,
        alpha: x === 4 && y === 3 ? alpha : 1,
        evidence: x === 4 && y === 3 ? evidence : 1,
      }))
      const points = [
        [1.1, 2.2],
        [3, 2.2],
        [5, 2.2],
        [6.7, 2.2],
      ] as const
      const raw = trajectory(source, points)
      const tube = createFlowingContoursEvidenceTube(source, raw)!

      expect(tube).not.toBeNull()
      expect(
        validateFlowingContoursTubeCurve(source, tube, {
          points: [points[0], [3, 3], [5, 3], points.at(-1)!],
          sourceSampleIndices: [0, 1, 2, 3],
        }),
      ).toBeNull()
    },
  )

  it('rejects a radius-0.25 chord whose true interior deviation is 0.2795', () => {
    const source = field(8, 8)
    const points = [
      [2, 4],
      [3, 4.2795],
      [4, 4],
    ] as const
    const raw = trajectory(source, points)
    const tube = createFlowingContoursEvidenceTube(source, raw)!

    expect(tube.evidenceTubeRadius).toBe(0.25)
    expect(
      validateFlowingContoursTubeCurve(source, tube, {
        points: [points[0], points[2]],
        sourceSampleIndices: [0, 2],
      }),
    ).toBeNull()
  })

  it('rejects source-boundary and endpoint overshoot', () => {
    const source = field(8, 7, () => ({ scale: 4 }))
    const points = [
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ] as const
    const raw = trajectory(source, points)
    const tube = createFlowingContoursEvidenceTube(source, raw)!

    expect(
      validateFlowingContoursTubeSegment(source, tube, {
        start: { point: [0, 3], sourceSampleIndex: 0 },
        end: { point: [-0.1, 3], sourceSampleIndex: 1 },
      }),
    ).toBeNull()
    expect(
      validateFlowingContoursTubeCurve(source, tube, {
        points: [[0.1, 3], ...points.slice(1)],
        sourceSampleIndices: allIndices(points.length),
      }),
    ).toBeNull()
  })

  it('keeps a valid bounded gap weak but rejects widening and a chord shortcut', () => {
    const source = field(10, 9, (x) => ({
      evidence: x <= 1 || x >= 5 ? 1 : 0.01,
    }))
    const points = [
      [0, 4],
      [1, 4],
      [2, 3.5],
      [3, 3.25],
      [4, 3.5],
      [5, 4],
      [6, 4],
    ] as const
    const samples = points.map((point) => sampled(source, point))
    const gapLength = length(points.slice(1, 6))
    const spans = [
      directSpan(samples, 0, 1),
      Object.freeze({
        kind: 'bounded-gap',
        startSampleIndex: 1,
        endSampleIndex: 5,
        length: gapLength,
        entryEvidence: samples[1]!.evidence,
        exitEvidence: samples[5]!.evidence,
        directionalAlignment: 2 / Math.sqrt(5),
      }),
      directSpan(samples, 5, 6),
    ] as const
    const raw = trajectory(source, points, spans)
    const tube = createFlowingContoursEvidenceTube(source, raw)!

    expect(
      validateFlowingContoursTubeCurve(source, tube, {
        points,
        sourceSampleIndices: allIndices(points.length),
      }),
    ).not.toBeNull()
    expect(
      validateFlowingContoursTubePoint(source, tube, {
        point: [3, 3.6],
        sourceSampleIndex: 3,
      }),
    ).toBeNull()
    expect(
      validateFlowingContoursTubeCurve(source, tube, {
        points: [points[0], points[1], points[5], points[6]],
        sourceSampleIndices: [0, 1, 5, 6],
      }),
    ).toBeNull()
    expect(
      validateFlowingContoursTubePoint(source, tube, {
        point: [0.9, 4],
        sourceSampleIndex: 1,
      }),
    ).toMatchObject({ supportKind: 'direct-evidence' })
    expect(
      validateFlowingContoursTubePoint(source, tube, {
        point: [1.1, 3.95],
        sourceSampleIndex: 1,
      }),
    ).toMatchObject({ supportKind: 'bounded-gap' })

    const asymmetricButStrongGap = {
      ...spans[1],
      directionalAlignment: 0.8,
    } as const
    expect(
      createFlowingContoursEvidenceTube(source, {
        ...raw,
        spanSupport: [spans[0], asymmetricButStrongGap, spans[2]],
      }),
    ).not.toBeNull()
    expect(
      createFlowingContoursEvidenceTube(source, {
        ...raw,
        spanSupport: [
          spans[0],
          { ...spans[1], directionalAlignment: 0.7 },
          spans[2],
        ],
      }),
    ).toBeNull()
    expect(
      createFlowingContoursEvidenceTube(source, {
        ...raw,
        spanSupport: [
          spans[0],
          { ...spans[1], directionalAlignment: -0.1 },
          spans[2],
        ],
      }),
    ).toBeNull()
  })

  it('rejects a bounded gap with weak boundary evidence', () => {
    const source = field(8, 7, (x) => ({
      evidence: x === 0 || x >= 5 ? 1 : 0.01,
    }))
    const points = [
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
      [4, 3],
      [5, 3],
      [6, 3],
    ] as const
    const samples = points.map((point) => sampled(source, point))
    const spans = [
      directSpan(samples, 0, 1),
      {
        kind: 'bounded-gap',
        startSampleIndex: 1,
        endSampleIndex: 5,
        length: 4,
        entryEvidence: samples[1]!.evidence,
        exitEvidence: samples[5]!.evidence,
        directionalAlignment: 1,
      },
      directSpan(samples, 5, 6),
    ] as const

    expect(
      createFlowingContoursEvidenceTube(
        source,
        trajectory(source, points, spans),
      ),
    ).toBeNull()
  })

  it('accepts an asymmetric curved gap reversed from real backward search', () => {
    const source = field(25, 15, (x, y) => {
      const offset = x - 12
      const curveY = 6 + 0.018 * offset * offset
      const slope = 0.036 * offset
      const tangentLength = Math.hypot(1, slope)
      return {
        evidence:
          (x === 6 || x === 7 ? 0.01 : 1) *
          gaussian(y - curveY),
        tangent: [1 / tangentLength, slope / tangentLength],
      }
    })
    const anchorSample = sampled(source, [12, 6])
    const candidate = searchFlowingContoursCandidate(
      source,
      {
        id: 9,
        fieldSampleIndex: 6 * source.width + 12,
        sample: anchorSample,
      },
      {
        continuity: 1,
        flowSmoothing: 0.7,
        ridgeStepOptions: { stepLength: 1 },
      },
      createFlowingContoursTestLimits({
        'search-step-count': 64,
        'raw-trajectory-point-count': 128,
      })!,
    )

    expect(candidate).not.toBeNull()
    const gaps = candidate!.spanSupport.filter(
      (span) => span.kind === 'bounded-gap',
    )
    expect(gaps.length).toBeGreaterThan(0)
    const recomputed = gaps.map((gap) =>
      canonicalGapAlignment(candidate!.samples, gap),
    )
    expect(
      gaps.every((gap) => gap.directionalAlignment >= 0.75),
    ).toBe(true)
    expect(recomputed.every((alignment) => alignment >= 0.75)).toBe(true)
    const anchorIndex = candidate!.backward.samples.length - 1
    expect(
      gaps.some(
        (gap, index) =>
          gap.endSampleIndex <= anchorIndex &&
          Math.abs(gap.directionalAlignment - recomputed[index]!) > 1e-10,
      ),
    ).toBe(true)

    const raw: AcceptedFlowingTrajectory = Object.freeze({
      id: 44,
      anchorId: candidate!.anchor.id,
      samples: candidate!.samples,
      spanSupport: candidate!.spanSupport,
      startEndpointReason: candidate!.backward.endpointReason,
      endEndpointReason: candidate!.forward.endpointReason,
      length: candidate!.length,
      maximumUnsupportedSpanLength: Math.max(
        ...gaps.map((gap) => gap.length),
      ),
      totalUnsupportedSpanLength: gaps.reduce(
        (sum, gap) => sum + gap.length,
        0,
      ),
      score: candidate!.score,
    })
    expect(createFlowingContoursEvidenceTube(source, raw)).not.toBeNull()
  })

  it('uses true stable global sample provenance on a nonlocal loop', () => {
    const source = field(8, 8, () => ({ scale: 4 }))
    const points = [
      [1, 1],
      [2, 1],
      [3, 1],
      [3, 2],
      [2.05, 1.05],
      [1, 2],
    ] as const
    const raw = trajectory(source, points)
    const tube = createFlowingContoursEvidenceTube(source, raw)!

    expect(
      validateFlowingContoursTubePoint(source, tube, {
        point: [2.04, 1.04],
        sourceSampleIndex: 1,
      }),
    ).toBeNull()
    expect(
      validateFlowingContoursTubePoint(source, tube, {
        point: [2.04, 1.04],
        sourceSampleIndex: 4,
      }),
    ).not.toBeNull()
  })

  it('does not shortcut between nearby nonlocal ends of a loop', () => {
    const source = field(8, 7, () => ({ scale: 4 }))
    const points = [
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
      [4, 2.2],
      [3, 2.2],
      [2, 2.2],
      [1, 2.2],
    ] as const
    const raw = trajectory(source, points)
    const tube = createFlowingContoursEvidenceTube(source, raw)!

    expect(
      validateFlowingContoursTubeCurve(source, tube, {
        points: [points[0], points.at(-1)!],
        sourceSampleIndices: [0, points.length - 1],
      }),
    ).toBeNull()
  })

  it('rejects micro-backtracking hidden inside a straight fitted chord', () => {
    const source = field(8, 7, () => ({ scale: 4 }))
    const points = [
      [1, 2],
      [1.2, 2.05],
      [1.1, 1.95],
      [1.4, 2],
    ] as const
    const raw = trajectory(source, points)
    const tube = createFlowingContoursEvidenceTube(source, raw)!

    expect(
      validateFlowingContoursTubeCurve(source, tube, {
        points: [points[0], points.at(-1)!],
        sourceSampleIndices: [0, points.length - 1],
      }),
    ).toBeNull()
  })

  it('validates a 1000-sample identity curve comfortably inside the work cap', () => {
    const source = field(202, 5)
    const points = Array.from(
      { length: 1000 },
      (_value, index) => [1 + index * 0.2, 2] as const,
    )
    const raw = trajectory(source, points)
    const tube = createFlowingContoursEvidenceTube(source, raw)!
    const validation = validateFlowingContoursTubeCurve(source, tube, {
      points,
      sourceSampleIndices: allIndices(points.length),
    })

    expect(validation).not.toBeNull()
    expect(validation!.validationSampleCount).toBeLessThan(100_000)
  })

  it('caps adversarial dense-segment work and fails closed before sampling', () => {
    const source = field(128, 5)
    const points = [
      [1, 2],
      [126, 2],
    ] as const
    const raw = trajectory(source, points)
    const tube = createFlowingContoursEvidenceTube(source, raw)!

    expect(
      validateFlowingContoursTubeSegment(
        source,
        tube,
        {
          start: { point: points[0], sourceSampleIndex: 0 },
          end: { point: points[1], sourceSampleIndex: 1 },
        },
        { maximumValidationSamples: 16 },
      ),
    ).toBeNull()
  })

  it('does not mutate raw evidence and returns finite frozen deterministic data', () => {
    const source = field(10, 8, () => ({ scale: 100 }))
    const points = [
      [2, 4],
      [3, 4],
      [4, 4],
      [5, 4],
      [6, 4],
    ] as const
    const raw = trajectory(source, points)
    const before = JSON.stringify(raw)
    const tube = createFlowingContoursEvidenceTube(source, raw)!
    const proposal = {
      points,
      sourceSampleIndices: allIndices(points.length),
    } as const
    const first = validateFlowingContoursTubeCurve(source, tube, proposal)!
    const second = validateFlowingContoursTubeCurve(source, tube, proposal)!

    expect(JSON.stringify(raw)).toBe(before)
    expect(tube.evidenceTubeRadius).toBe(
      FLOWING_CONTOURS_EVIDENCE_TUBE_HARD_MAX_RADIUS,
    )
    expect(first).toEqual(second)
    expect(Object.isFrozen(tube)).toBe(true)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.sourceSampleIndices)).toBe(true)
    expect(
      Object.values(first).every((value) =>
        typeof value === 'number' ? Number.isFinite(value) : true,
      ),
    ).toBe(true)
  })

  it('fails closed on malformed correspondence, provenance, and hostile options', () => {
    const source = field(8, 7)
    const points = [
      [2, 3],
      [3, 3],
      [4, 3],
      [5, 3],
    ] as const
    const raw = trajectory(source, points)
    const tube = createFlowingContoursEvidenceTube(source, raw)!

    expect(
      validateFlowingContoursTubeCurve(source, tube, {
        points,
        sourceSampleIndices: [0, 2, 1, 3],
      }),
    ).toBeNull()
    expect(
      validateFlowingContoursTubeCurve(
        source,
        tube,
        { points, sourceSampleIndices: allIndices(points.length) },
        { maximumValidationSamples: Number.POSITIVE_INFINITY },
      ),
    ).toBeNull()
    expect(
      createFlowingContoursEvidenceTube(source, {
        ...raw,
        maximumUnsupportedSpanLength: 1,
      }),
    ).toBeNull()
  })

  it('binds a tube to one immutable field identity', () => {
    const source = field(8, 7)
    const points = [
      [2, 3],
      [3, 3],
      [4, 3],
      [5, 3],
    ] as const
    const raw = trajectory(source, points)
    const tube = createFlowingContoursEvidenceTube(source, raw)!
    const equivalentOtherField = field(8, 7)
    const mutableAlpha = [...source.alpha]
    const mutableChannelField = Object.freeze({
      ...source,
      alpha: mutableAlpha,
    }) as FlowingContoursField

    expect(
      validateFlowingContoursTubeCurve(equivalentOtherField, tube, {
        points,
        sourceSampleIndices: allIndices(points.length),
      }),
    ).toBeNull()
    expect(
      createFlowingContoursEvidenceTube(mutableChannelField, raw),
    ).toBeNull()
    mutableAlpha[3] = 0
    expect(
      createFlowingContoursEvidenceTube(mutableChannelField, raw),
    ).toBeNull()
  })
})
