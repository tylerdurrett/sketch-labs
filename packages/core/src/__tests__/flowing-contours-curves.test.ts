import { describe, expect, it } from 'vitest'

import {
  FLOWING_CONTOURS_CURVE_MAX_WORK_PER_SOURCE_POINT,
  fitFlowingContoursCurve,
  fitFlowingContoursCurves,
} from '../sketches/flowing-contours/curves'
import { sampleFlowingContoursField } from '../sketches/flowing-contours/field'
import { createFlowingContoursTestLimits } from '../sketches/flowing-contours/limits'
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
  accumulatedEvidence: 10,
  usefulLength: 10,
  directionalCoherence: 1,
  curvaturePenalty: 0,
  unsupportedTravelPenalty: 0,
  ambiguityPenalty: 0,
  representedOverlapPenalty: 0,
  total: 21,
})

const DIAGONAL = Object.freeze([
  Math.SQRT1_2,
  Math.SQRT1_2,
] as Point)

function field(
  width: number,
  height: number,
  valueAt: (x: number, y: number) => FieldValue = () => ({
    scale: 4,
  }),
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
      const alphaValue = value.alpha ?? 1
      const tangent = value.tangent ?? DIAGONAL
      luminance.push(0.5)
      alpha.push(alphaValue)
      positiveSupport.push(alphaValue > 0)
      contourEvidence.push(value.evidence ?? 1)
      tangentX.push(tangent[0])
      tangentY.push(tangent[1])
      tangentCoherence.push(value.coherence ?? 1)
      ambiguity.push(value.ambiguity ?? 0)
      ridgeScale.push(value.scale ?? 4)
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

function sample(
  source: Readonly<FlowingContoursField>,
  point: Readonly<Point>,
): Readonly<CorrectedFlowingRidgeSample> {
  const result = sampleFlowingContoursField(source, point)
  if (result === null) throw new Error(`Missing field sample at ${point}`)
  return result
}

function pathLength(points: readonly Readonly<Point>[]): number {
  let result = 0
  for (let index = 1; index < points.length; index += 1) {
    result += Math.hypot(
      points[index]![0] - points[index - 1]![0],
      points[index]![1] - points[index - 1]![1],
    )
  }
  return result
}

function span(
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  kind: 'direct-evidence' | 'bounded-gap',
  startSampleIndex: number,
  endSampleIndex: number,
): Readonly<FlowingContoursSpanSupportProvenance> {
  return Object.freeze({
    kind,
    startSampleIndex,
    endSampleIndex,
    length: pathLength(
      samples
        .slice(startSampleIndex, endSampleIndex + 1)
        .map((entry) => entry.point),
    ),
    entryEvidence: samples[startSampleIndex]!.evidence,
    exitEvidence: samples[endSampleIndex]!.evidence,
    directionalAlignment: 1,
  })
}

function trajectory(
  source: Readonly<FlowingContoursField>,
  points: readonly Readonly<Point>[],
  spans?: (
    samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  ) => readonly Readonly<FlowingContoursSpanSupportProvenance>[],
  id = 7,
): AcceptedFlowingTrajectory {
  const samples = Object.freeze(points.map((point) => sample(source, point)))
  const support = Object.freeze(
    spans?.(samples) ?? [span(samples, 'direct-evidence', 0, samples.length - 1)],
  )
  const gaps = support.filter((entry) => entry.kind === 'bounded-gap')
  return Object.freeze({
    id,
    anchorId: id + 10,
    samples,
    spanSupport: support,
    startEndpointReason: 'source-boundary',
    endEndpointReason: 'evidence-exhausted',
    length: pathLength(points),
    maximumUnsupportedSpanLength: Math.max(
      0,
      ...gaps.map((entry) => entry.length),
    ),
    totalUnsupportedSpanLength: gaps.reduce(
      (sum, entry) => sum + entry.length,
      0,
    ),
    score: SCORE,
  })
}

function resample(
  points: readonly Readonly<Point>[],
  spacing = 0.25,
): readonly Readonly<Point>[] {
  const total = pathLength(points)
  const result: Readonly<Point>[] = []
  let segment = 0
  let before = 0
  for (let distance = 0; distance < total; distance += spacing) {
    while (
      segment + 1 < points.length - 1 &&
      before +
        Math.hypot(
          points[segment + 1]![0] - points[segment]![0],
          points[segment + 1]![1] - points[segment]![1],
        ) <
        distance
    ) {
      before += Math.hypot(
        points[segment + 1]![0] - points[segment]![0],
        points[segment + 1]![1] - points[segment]![1],
      )
      segment += 1
    }
    const start = points[segment]!
    const end = points[segment + 1]!
    const length = Math.hypot(end[0] - start[0], end[1] - start[1])
    const amount = length === 0 ? 0 : (distance - before) / length
    result.push([
      start[0] + (end[0] - start[0]) * amount,
      start[1] + (end[1] - start[1]) * amount,
    ])
  }
  result.push(points.at(-1)!)
  return result
}

function turnEnergy(points: readonly Readonly<Point>[]): number {
  const spaced = resample(points)
  let result = 0
  for (let index = 1; index < spaced.length - 1; index += 1) {
    const previous = spaced[index - 1]!
    const point = spaced[index]!
    const next = spaced[index + 1]!
    const first = Math.atan2(
      point[1] - previous[1],
      point[0] - previous[0],
    )
    const second = Math.atan2(
      next[1] - point[1],
      next[0] - point[0],
    )
    const difference = Math.atan2(
      Math.sin(second - first),
      Math.cos(second - first),
    )
    result += difference * difference
  }
  return result
}

function maximumTurn(points: readonly Readonly<Point>[]): number {
  const spaced = resample(points)
  let result = 0
  for (let index = 1; index < spaced.length - 1; index += 1) {
    const previous = spaced[index - 1]!
    const point = spaced[index]!
    const next = spaced[index + 1]!
    const first = Math.atan2(
      point[1] - previous[1],
      point[0] - previous[0],
    )
    const second = Math.atan2(
      next[1] - point[1],
      next[0] - point[0],
    )
    result = Math.max(
      result,
      Math.abs(
        Math.atan2(
          Math.sin(second - first),
          Math.cos(second - first),
        ),
      ),
    )
  }
  return result
}

function coherentRandomPoints(seedValue: number): readonly Readonly<Point>[] {
  let seed = seedValue
  const random = () =>
    ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const points: Readonly<Point>[] = [[3, 20]]
  for (let index = 0; index < 20; index += 1) {
    const previous = points.at(-1)!
    points.push([
      previous[0] + 0.75,
      previous[1] + (random() * 2 - 1) * 0.5,
    ])
  }
  return points
}

function fittedPoints(
  source: Readonly<FlowingContoursField>,
  raw: Readonly<AcceptedFlowingTrajectory>,
  smoothing: number,
): readonly Readonly<Point>[] {
  const result = fitFlowingContoursCurve(source, raw, smoothing)
  expect(result.status).toBe('fitted')
  if (result.status !== 'fitted') throw new Error(result.status)
  return result.curve.points
}

describe('Flowing Contours evidence-preserving curve fitting', () => {
  it('turns a staircase into a lower-energy flowing gesture at fixed spacing', () => {
    const source = field(20, 20)
    const points = [
      [2, 2],
      [3, 2],
      [3, 3],
      [4, 3],
      [4, 4],
      [5, 4],
      [5, 5],
      [6, 5],
      [6, 6],
      [7, 6],
      [7, 7],
      [8, 7],
    ] as const
    const fitted = fittedPoints(source, trajectory(source, points), 1)

    expect(fitted.length).toBeLessThanOrEqual(points.length)
    expect(turnEnergy(fitted)).toBeLessThanOrEqual(
      turnEnergy(points) + 1e-10,
    )
    expect(turnEnergy(fitted)).toBeLessThan(turnEnergy(points) * 0.35)
    expect(fitted[0]).toEqual(points[0])
    expect(fitted.at(-1)).toEqual(points.at(-1))
  })

  it('collapses a supported diagonal without introducing grid turns', () => {
    const source = field(16, 16)
    const points = Array.from(
      { length: 9 },
      (_value, index) => [2 + index, 2 + index] as const,
    )
    const fitted = fittedPoints(source, trajectory(source, points), 1)

    expect(fitted).toEqual([points[0], points.at(-1)])
    expect(turnEnergy(fitted)).toBeCloseTo(0)
  })

  it('preserves sampled arc flow and refuses the unsupported endpoint chord', () => {
    const center = [10, 10] as const
    const points = Array.from({ length: 13 }, (_value, index) => {
      const angle = Math.PI + (index * Math.PI) / 24
      return [
        center[0] + 6 * Math.cos(angle),
        center[1] + 6 * Math.sin(angle),
      ] as const
    })
    const source = field(22, 22, (x, y) => {
      const angle = Math.atan2(y - center[1], x - center[0])
      return {
        tangent: [-Math.sin(angle), Math.cos(angle)],
        scale: 3,
      }
    })
    const fitted = fittedPoints(source, trajectory(source, points), 1)

    expect(fitted.length).toBeGreaterThan(2)
    expect(fitted.length).toBeLessThanOrEqual(points.length)
    expect(turnEnergy(fitted)).toBeLessThanOrEqual(
      turnEnergy(points) + 1e-10,
    )
    expect(fitted[0]).toEqual(points[0])
    expect(fitted.at(-1)).toEqual(points.at(-1))
  })

  it('retains enough points around high curvature to forbid a shortcut', () => {
    const source = field(18, 18, () => ({
      tangent: [1, 0],
      scale: 4,
    }))
    const points = [
      [3, 9],
      [3.5, 6],
      [5, 3.5],
      [8, 3],
      [11, 3.5],
      [12.5, 6],
      [13, 9],
    ] as const
    const fitted = fittedPoints(source, trajectory(source, points), 1)

    expect(fitted.length).toBeGreaterThan(2)
    expect(Math.min(...fitted.map((point) => point[1]))).toBeLessThan(5)
  })

  it('preserves a documented weak span while retaining its provenance', () => {
    const source = field(12, 9, (x) => ({
      evidence: x >= 4 && x <= 6 ? 0.01 : 1,
      tangent: [1, 0],
      scale: 4,
    }))
    const points = [
      [2, 4],
      [3, 4],
      [4, 4],
      [5, 4],
      [6, 4],
      [7, 4],
      [8, 4],
    ] as const
    const raw = trajectory(source, points, (samples) => [
      span(samples, 'direct-evidence', 0, 1),
      span(samples, 'bounded-gap', 1, 5),
      span(samples, 'direct-evidence', 5, 6),
    ])
    const result = fitFlowingContoursCurve(source, raw, 1)

    expect(result.status).toBe('fitted')
    if (result.status !== 'fitted') return
    expect(result.curve.points).toEqual([points[0], points.at(-1)])
    expect(result.curve.provenance.sourceTrajectoryId).toBe(raw.id)
    expect(result.curve.provenance.evidenceTubeRadius).toBeLessThanOrEqual(1)
  })

  it('does not fair or simplify through an alpha hole', () => {
    const source = field(12, 10, (x, y) => ({
      alpha: x === 5 && y === 5 ? 0 : 1,
      tangent: [1, 0],
      scale: 4,
    }))
    const points = [
      [2, 5],
      [3, 5.8],
      [4, 6.2],
      [5, 6.4],
      [6, 6.2],
      [7, 5.8],
      [8, 5],
    ] as const
    const result = fitFlowingContoursCurve(
      source,
      trajectory(source, points),
      1,
    )

    expect(result.status).toBe('fitted')
    if (result.status !== 'fitted') return
    expect(result.curve.points.length).toBeGreaterThan(2)
    expect(
      result.curve.points.some(
        (point) => point[0] === 5 && point[1] === 5,
      ),
    ).toBe(false)
  })

  it('monotonically strengthens simplification across Flow Smoothing', () => {
    const source = field(20, 20)
    const points = Array.from({ length: 18 }, (_value, index) => [
      1 + index * 0.7,
      8 + (index % 2 === 0 ? 0.32 : -0.32),
    ] as const)
    const raw = trajectory(source, points)
    const outputs = [0, 0.25, 0.5, 0.75, 1].map((smoothing) =>
      fittedPoints(source, raw, smoothing),
    )

    for (let index = 1; index < outputs.length; index += 1) {
      expect(outputs[index]!.length).toBeLessThanOrEqual(
        outputs[index - 1]!.length,
      )
      expect(turnEnergy(outputs[index]!)).toBeLessThanOrEqual(
        turnEnergy(outputs[index - 1]!) + 1e-8,
      )
    }
  })

  it('does not regress whole-output turns at the exact production-scale seed', () => {
    const source = field(24, 40, () => ({
      tangent: [1, 0],
      scale: 4,
    }))
    const raw = trajectory(source, coherentRandomPoints(1234567))
    const lower = fittedPoints(source, raw, 0.9)
    const stronger = fittedPoints(source, raw, 1)

    expect(turnEnergy(stronger)).toBeLessThanOrEqual(
      turnEnergy(lower) + 1e-10,
    )
    expect(maximumTurn(stronger)).toBeLessThanOrEqual(
      maximumTurn(lower) + 1e-10,
    )
    expect(stronger.length).toBeLessThanOrEqual(lower.length)
  })

  it('keeps energy and abrupt turns monotonic across a bounded coherent family', () => {
    const source = field(24, 40, () => ({
      tangent: [1, 0],
      scale: 4,
    }))
    const smoothings = [0.7, 0.8, 0.9, 1] as const
    for (let seed = 1; seed <= 24; seed += 1) {
      const raw = trajectory(
        source,
        coherentRandomPoints(seed * 7919),
        undefined,
        seed,
      )
      const outputs = smoothings.map((smoothing) =>
        fittedPoints(source, raw, smoothing),
      )
      for (let index = 1; index < outputs.length; index += 1) {
        expect(turnEnergy(outputs[index]!)).toBeLessThanOrEqual(
          turnEnergy(outputs[index - 1]!) + 1e-10,
        )
        expect(maximumTurn(outputs[index]!)).toBeLessThanOrEqual(
          maximumTurn(outputs[index - 1]!) + 1e-10,
        )
        expect(outputs[index]!.length).toBeLessThanOrEqual(
          outputs[index - 1]!.length,
        )
      }
    }
  })

  it('suppresses repeated orthogonal alternation rather than emitting stumps', () => {
    const source = field(24, 24)
    const points: Readonly<Point>[] = [[2, 2]]
    for (let index = 0; index < 16; index += 1) {
      const last = points.at(-1)!
      points.push(
        index % 2 === 0
          ? [last[0] + 1, last[1]]
          : [last[0], last[1] + 1],
      )
    }
    const fitted = fittedPoints(source, trajectory(source, points), 1)

    expect(fitted.length).toBeLessThan(points.length / 2)
    expect(turnEnergy(fitted)).toBeLessThan(turnEnergy(points) * 0.25)
    expect(pathLength(fitted)).toBeGreaterThan(8)
  })

  it('preserves the immutable accepted trajectory and freezes audit output', () => {
    const source = field(14, 14)
    const raw = trajectory(source, [
      [2, 2],
      [3, 2.4],
      [4, 3],
      [5, 3.5],
      [6, 4],
    ])
    const before = JSON.stringify(raw)
    const result = fitFlowingContoursCurve(source, raw, 0.8)

    expect(JSON.stringify(raw)).toBe(before)
    expect(result.status).toBe('fitted')
    if (result.status !== 'fitted') return
    expect(Object.isFrozen(result.curve)).toBe(true)
    expect(Object.isFrozen(result.curve.points)).toBe(true)
    expect(Object.isFrozen(result.curve.points[0])).toBe(true)
    expect(Object.isFrozen(result.curve.provenance)).toBe(true)
    expect(
      Object.isFrozen(result.curve.provenance.sourceSampleIndices),
    ).toBe(true)
  })

  it('is deterministic, bounded, and preserves accepted batch order', () => {
    const source = field(18, 18)
    const first = trajectory(
      source,
      [
        [2, 2],
        [3, 2.3],
        [4, 3],
        [5, 3.2],
      ],
      undefined,
      11,
    )
    const second = trajectory(
      source,
      [
        [7, 7],
        [8, 7.4],
        [9, 8],
        [10, 8.2],
      ],
      undefined,
      12,
    )
    const a = fitFlowingContoursCurves(source, [first, second], 0.7)
    const b = fitFlowingContoursCurves(source, [first, second], 0.7)

    expect(a).toEqual(b)
    expect(a.status).toBe('fitted')
    if (a.status !== 'fitted') return
    expect(
      a.curves.map((curve) => curve.provenance.sourceTrajectoryId),
    ).toEqual([11, 12])
    expect(a.workCount).toBeLessThanOrEqual(
      (first.samples.length + second.samples.length) *
        FLOWING_CONTOURS_CURVE_MAX_WORK_PER_SOURCE_POINT,
    )
  })

  it('distinguishes aggregate point-cap exhaustion and returns no partial batch', () => {
    const source = field(12, 12)
    const first = trajectory(
      source,
      [
        [2, 2],
        [3, 3],
      ],
      undefined,
      21,
    )
    const second = trajectory(
      source,
      [
        [5, 5],
        [6, 6],
      ],
      undefined,
      22,
    )
    const limits = createFlowingContoursTestLimits({
      'fitted-curve-point-count': 3,
    })!
    const result = fitFlowingContoursCurves(
      source,
      [first, second],
      1,
      { limits },
    )

    expect(result).toMatchObject({
      status: 'limit-reached',
      limitedBy: 'fitted-curve-point-count',
      curves: [],
      fittedPointCount: 0,
    })
  })

  it('fails closed on hostile controls, proof caps, fields, and trajectories', () => {
    const source = field(10, 10)
    const raw = trajectory(source, [
      [2, 2],
      [3, 3],
      [4, 4],
    ])
    expect(fitFlowingContoursCurve(source, raw, Number.NaN).status).toBe(
      'invalid-input',
    )
    expect(
      fitFlowingContoursCurve(source, raw, 0.5, {
        maximumValidationSamples: 1,
      }).status,
    ).toBe('invalid-input')
    expect(
      fitFlowingContoursCurve(
        { ...source, alpha: [...source.alpha] },
        raw,
        0.5,
      ).status,
    ).toBe('invalid-input')
    expect(
      fitFlowingContoursCurve(
        source,
        { ...raw, length: Infinity },
        0.5,
      ).status,
    ).toBe('invalid-input')
    expect(
      fitFlowingContoursCurve(source, raw, 0.5, {
        get currentFittedPointCount() {
          throw new Error('hostile getter')
        },
      }).status,
    ).toBe('invalid-input')
  })
})
