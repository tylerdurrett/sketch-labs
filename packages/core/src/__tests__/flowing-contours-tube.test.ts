import { describe, expect, it } from 'vitest'

import { sampleFlowingContoursField } from '../sketches/flowing-contours/field'
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

describe('Flowing Contours corrected-trajectory evidence tube', () => {
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
      scale: 4,
      evidence: x === 0 || x === 1 || x >= 6 ? 1 : 0.01,
    }))
    const points = [
      [0, 4],
      [1, 4],
      [2, 2],
      [3.5, 1],
      [5, 2],
      [6, 4],
      [7, 4],
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
        directionalAlignment: 0.75,
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
        point: [3.5, 3],
        sourceSampleIndex: 3,
      }),
    ).toBeNull()
    expect(
      validateFlowingContoursTubeCurve(source, tube, {
        points: [points[0], points[1], points[5], points[6]],
        sourceSampleIndices: [0, 1, 5, 6],
      }),
    ).toBeNull()
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
})
