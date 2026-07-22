/**
 * Deterministic approximating-curve refinement for Pencil Contour cleanup.
 *
 * Luminance paths use fixed-arc resampling, one denoise pass, and two
 * endpoint-aware Chaikin passes. Above 0.75 smoothing, a third pass ramps in
 * linearly so the established lower range remains exact; a whole-path weight
 * backoff enforces bounds, support, and the source tube. Alpha boundaries
 * instead preserve every raw source vertex in a <=0.5-unit baseline and target
 * a circular arc-distance Gaussian (sigma 2). Only unsafe alpha neighborhoods
 * blend back toward the known-safe baseline, so one transparent corner cannot
 * weaken the whole silhouette. Both branches emit deterministic ordinary
 * polyline points.
 */

import type { Point } from '../../types'

const REFINEMENT_PASSES = 2
const BACKOFF_ATTEMPTS = 8
const MAX_REFINEMENT_CONTROL_POINTS = 1024
const TARGET_CONTROL_SPACING = 4
const LOCAL_MAX_SPACING = 0.5
const LOCAL_MAX_SUBDIVISIONS = 16
const MAX_LOCAL_REFINED_POINTS = 2048
const GAUSSIAN_SIGMA = 2
const GAUSSIAN_RADIUS = GAUSSIAN_SIGMA * 3
const HIGH_SMOOTHING_START = 0.75
const CHAIKIN_CUT_AMOUNT = 0.25

export interface CurveRefinementInput {
  readonly points: readonly Readonly<Point>[]
  readonly closed: boolean
  /** Quantized refinement weight in `[0, 1]`. */
  readonly weight: number
  readonly localFallback?: boolean
  readonly localMaxDeviation?: number
  readonly segmentAccepts?: (
    start: Readonly<Point>,
    end: Readonly<Point>,
  ) => boolean
  readonly accepts: (
    points: readonly Readonly<Point>[],
    closed: boolean,
  ) => boolean
}

interface IndexedPoint {
  readonly point: Readonly<Point>
  readonly pairedIndex: number
}

interface ArcSamples {
  readonly points: readonly Readonly<Point>[]
  readonly positions: readonly number[]
  readonly totalLength: number
}

function pointsCoincide(
  first: Readonly<Point>,
  second: Readonly<Point>,
): boolean {
  return Math.hypot(first[0] - second[0], first[1] - second[1]) <= 1e-12
}

/** @internal Shared by linear and closed-seam paired deduplication. */
export function pairedCurveSamplesCoincide(
  firstPoint: Readonly<Point>,
  firstBaseline: Readonly<Point>,
  secondPoint: Readonly<Point>,
  secondBaseline: Readonly<Point>,
): boolean {
  return pointsCoincide(firstPoint, secondPoint) &&
    pointsCoincide(firstBaseline, secondBaseline)
}

function interpolate(
  first: Readonly<Point>,
  second: Readonly<Point>,
  amount: number,
): Point {
  return [
    first[0] + (second[0] - first[0]) * amount,
    first[1] + (second[1] - first[1]) * amount,
  ]
}

function cornerCutOnce(
  points: readonly Readonly<Point>[],
  closed: boolean,
  amount: number,
): readonly Readonly<Point>[] {
  const cut: Point[] = []
  if (!closed) cut.push([points[0]![0], points[0]![1]])
  const first = closed ? 0 : 1
  const end = closed ? points.length : points.length - 1
  for (let index = first; index < end; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length]!
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    cut.push(interpolate(current, previous, amount))
    cut.push(interpolate(current, next, amount))
  }
  if (!closed) {
    const last = points.at(-1)!
    cut.push([last[0], last[1]])
  }
  return cut
}

function cornerCut(
  points: readonly Readonly<Point>[],
  closed: boolean,
  weight: number,
): readonly Readonly<Point>[] {
  let result = points
  const amount = CHAIKIN_CUT_AMOUNT * weight
  for (let pass = 0; pass < REFINEMENT_PASSES; pass += 1) {
    result = cornerCutOnce(result, closed, amount)
  }
  return result
}

function resampleControls(
  points: readonly Readonly<Point>[],
  closed: boolean,
  targetSpacing: number,
): readonly Readonly<Point>[] {
  const segmentCount = closed ? points.length : points.length - 1
  const cumulative = [0]
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index]!
    const end = points[(index + 1) % points.length]!
    cumulative.push(cumulative.at(-1)! + Math.hypot(
      end[0] - start[0],
      end[1] - start[1],
    ))
  }
  const total = cumulative.at(-1)!
  const maximumSampleCount = closed ? points.length : points.length - 1
  const sampleCount = Math.max(
    closed ? 3 : 2,
    Math.min(maximumSampleCount, Math.ceil(total / targetSpacing)),
  )
  const distances: number[] = []
  const lastIndex = closed ? sampleCount - 1 : sampleCount
  for (let index = 0; index <= lastIndex; index += 1) {
    distances.push((total * index) / sampleCount)
  }

  let segment = 0
  return distances.map((distance, sampleIndex): Point => {
    if (!closed && sampleIndex === 0) {
      return [points[0]![0], points[0]![1]]
    }
    if (!closed && sampleIndex === sampleCount) {
      const last = points.at(-1)!
      return [last[0], last[1]]
    }
    while (
      segment + 1 < cumulative.length - 1 &&
      cumulative[segment + 1]! < distance
    ) {
      segment += 1
    }
    const start = points[segment]!
    const end = points[(segment + 1) % points.length]!
    const length = cumulative[segment + 1]! - cumulative[segment]!
    const amount = length === 0 ? 0 : (distance - cumulative[segment]!) / length
    return interpolate(start, end, amount)
  })
}

function denoiseControls(
  points: readonly Readonly<Point>[],
  closed: boolean,
  weight: number,
): readonly Readonly<Point>[] {
  return points.map((current, index): Readonly<Point> => {
    if (!closed && (index === 0 || index + 1 === points.length)) return current
    const previous = points[(index - 1 + points.length) % points.length]!
    const next = points[(index + 1) % points.length]!
    const average: Point = [
      previous[0] * 0.25 + current[0] * 0.5 + next[0] * 0.25,
      previous[1] * 0.25 + current[1] * 0.5 + next[1] * 0.25,
    ]
    return interpolate(current, average, weight)
  })
}

function densifyControls(
  points: readonly Readonly<Point>[],
  closed: boolean,
): ArcSamples {
  const dense: Point[] = [[points[0]![0], points[0]![1]]]
  const positions = [0]
  let totalLength = 0
  const segmentCount = closed ? points.length : points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index]!
    const end = points[(index + 1) % points.length]!
    const length = Math.hypot(end[0] - start[0], end[1] - start[1])
    const subdivisions = Math.min(
      LOCAL_MAX_SUBDIVISIONS,
      Math.max(1, Math.ceil(length / LOCAL_MAX_SPACING)),
    )
    for (let step = 1; step <= subdivisions; step += 1) {
      totalLength += length / subdivisions
      if (closed && index + 1 === segmentCount && step === subdivisions) {
        continue
      }
      dense.push(interpolate(start, end, step / subdivisions))
      positions.push(totalLength)
    }
  }
  return { points: dense, positions, totalLength }
}

function gaussianCandidate(
  samples: Readonly<ArcSamples>,
  closed: boolean,
  weight: number,
): readonly Readonly<Point>[] {
  const { points, positions, totalLength } = samples
  const gaussian = (distance: number) =>
    Math.exp(-(distance * distance) / (2 * GAUSSIAN_SIGMA * GAUSSIAN_SIGMA))
  return points.map((point, index): Readonly<Point> => {
    let sumX = point[0]
    let sumY = point[1]
    let sumWeight = 1
    const add = (other: number, distance: number) => {
      const sampleWeight = gaussian(distance)
      sumX += points[other]![0] * sampleWeight
      sumY += points[other]![1] * sampleWeight
      sumWeight += sampleWeight
    }
    const maximumStep = closed
      ? Math.floor(points.length / 2)
      : points.length - 1
    for (let step = 1; step <= maximumStep; step += 1) {
      const other = index - step
      const wrapped = (other + points.length) % points.length
      const distance = other >= 0
        ? positions[index]! - positions[other]!
        : positions[index]! + totalLength - positions[wrapped]!
      if ((!closed && other < 0) || distance > GAUSSIAN_RADIUS) break
      add(wrapped, distance)
    }
    for (let step = 1; step <= maximumStep; step += 1) {
      const other = index + step
      const wrapped = other % points.length
      if (closed && wrapped === (index - step + points.length) % points.length) {
        break
      }
      const distance = other < points.length
        ? positions[other]! - positions[index]!
        : totalLength - positions[index]! + positions[wrapped]!
      if ((!closed && other >= points.length) || distance > GAUSSIAN_RADIUS) {
        break
      }
      add(wrapped, distance)
    }
    const taper = closed
      ? 1
      : Math.min(
          1,
          Math.min(positions[index]!, totalLength - positions[index]!) /
            GAUSSIAN_RADIUS,
        )
    return interpolate(
      point,
      [sumX / sumWeight, sumY / sumWeight],
      weight * taper,
    )
  })
}

function locallyRefinedCurve(
  input: Readonly<CurveRefinementInput>,
): readonly Readonly<Point>[] {
  if (input.segmentAccepts === undefined) return input.points
  if (input.localMaxDeviation === undefined || input.localMaxDeviation < 0) {
    return input.points
  }
  const samples = densifyControls(input.points, input.closed)
  if (samples.points.length > MAX_LOCAL_REFINED_POINTS) return input.points
  const baseline = samples.points
  const candidate = gaussianCandidate(samples, input.closed, input.weight)
  if (baseline.length !== candidate.length) return input.points
  const weights = new Float64Array(candidate.length)
  weights.fill(1)

  const build = (): readonly IndexedPoint[] => {
    const result: IndexedPoint[] = []
    for (let index = 0; index < candidate.length; index += 1) {
      const point = interpolate(baseline[index]!, candidate[index]!, weights[index]!)
      const previous = result.at(-1)
      if (
        previous !== undefined &&
        pairedCurveSamplesCoincide(
          point,
          baseline[index]!,
          previous.point,
          baseline[previous.pairedIndex]!,
        )
      ) {
        continue
      }
      result.push({ point, pairedIndex: index })
    }
    if (
      input.closed &&
      result.length > 1 &&
      pairedCurveSamplesCoincide(
        result[0]!.point,
        baseline[result[0]!.pairedIndex]!,
        result.at(-1)!.point,
        baseline[result.at(-1)!.pairedIndex]!,
      )
    ) {
      result.pop()
    }
    return result
  }

  for (let iteration = 0; iteration < 16; iteration += 1) {
    const hybrid = build()
    const segmentCount = input.closed ? hybrid.length : hybrid.length - 1
    const unsafe: readonly [number, number][] = Array.from(
      { length: segmentCount },
      (_, index): [number, number] => [index, (index + 1) % hybrid.length],
    ).filter(([first, second]) => {
      const firstPoint = hybrid[first]!
      const secondPoint = hybrid[second]!
      const exceedsTube = (value: Readonly<IndexedPoint>) =>
        Math.hypot(
          value.point[0] - baseline[value.pairedIndex]![0],
          value.point[1] - baseline[value.pairedIndex]![1],
        ) > input.localMaxDeviation! + 1e-12
      return exceedsTube(firstPoint) || exceedsTube(secondPoint) ||
        !input.segmentAccepts!(firstPoint.point, secondPoint.point)
    })
    if (unsafe.length === 0) {
      const points = hybrid.map(({ point }) => point)
      return input.accepts(points, input.closed) ? points : input.points
    }

    for (const [first, second] of unsafe) {
      const firstIndex = hybrid[first]!.pairedIndex
      const secondIndex = hybrid[second]!.pairedIndex
      for (const index of [firstIndex - 1, firstIndex, secondIndex, secondIndex + 1]) {
        if (!input.closed && (index < 0 || index >= weights.length)) continue
        const wrapped = (index + weights.length) % weights.length
        weights[wrapped] = iteration < 7 ? weights[wrapped]! / 2 : 0
      }
    }
  }
  return input.points
}

function distanceToChord(
  point: Readonly<Point>,
  start: Readonly<Point>,
  end: Readonly<Point>,
): number {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) {
    return Math.hypot(point[0] - start[0], point[1] - start[1])
  }
  return Math.abs(dx * (point[1] - start[1]) - dy * (point[0] - start[0])) /
    Math.sqrt(lengthSquared)
}

export function refinePencilContourCurve(
  input: Readonly<CurveRefinementInput>,
): readonly Readonly<Point>[] {
  if (
    input.weight <= 0 ||
    input.points.length === 2 ||
    input.points.length > MAX_REFINEMENT_CONTROL_POINTS
  ) {
    return input.points
  }
  if (!input.closed) {
    const start = input.points[0]!
    const end = input.points.at(-1)!
    if (input.points.every((point) =>
      distanceToChord(point, start, end) <= 1e-12,
    )) {
      return input.points
    }
  }

  if (input.localFallback) return locallyRefinedCurve(input)

  const highSmoothingWeight = Math.max(
    0,
    Math.min(1, (input.weight - HIGH_SMOOTHING_START) /
      (1 - HIGH_SMOOTHING_START)),
  )

  for (const targetSpacing of [TARGET_CONTROL_SPACING, TARGET_CONTROL_SPACING / 2]) {
    const controls = resampleControls(input.points, input.closed, targetSpacing)
    let weight = Math.min(1, input.weight)
    for (let attempt = 0; attempt < BACKOFF_ATTEMPTS; attempt += 1) {
      const denoised = denoiseControls(controls, input.closed, weight)
      const refined = highSmoothingWeight === 0
        ? cornerCut(denoised, input.closed, weight)
        : cornerCutOnce(
            cornerCut(denoised, input.closed, weight),
            input.closed,
            CHAIKIN_CUT_AMOUNT * highSmoothingWeight *
              (weight / input.weight),
          )
      if (input.accepts(refined, input.closed)) return refined
      weight /= 2
    }
  }
  return input.points
}
