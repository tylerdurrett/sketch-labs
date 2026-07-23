/**
 * Bounded, evidence-preserving fitting for accepted Flowing Contours paths.
 *
 * Fitting is deliberately approximating rather than interpolating. A nested
 * shortcut hierarchy removes small lattice-scale turns, then a fixed number
 * of conservative Laplacian passes rounds the surviving polyline. Every
 * shortcut and every point move is proved against the accepted trajectory's
 * FC13a evidence tube before it can become current geometry. The final curve
 * is validated again as one monotonic, endpoint-exact whole.
 */

import type { Point } from '../../types'
import type { FlowingContoursLimits } from './limits'
import { FLOWING_CONTOURS_LIMITS } from './limits'
import {
  FLOWING_CONTOURS_TUBE_MAX_VALIDATION_SAMPLES,
  createFlowingContoursEvidenceTube,
  validateFlowingContoursTubeCurve,
  validateFlowingContoursTubePoint,
  validateFlowingContoursTubeSegment,
} from './tube'
import type {
  AcceptedFlowingTrajectory,
  FittedFlowingCurve,
  FlowingContoursField,
} from './types'

const MAX_FAIRING_PASSES = 10
const FAIRING_PASS_AMOUNT = 0.12
const FAIRING_BACKOFF_ATTEMPTS = 6
const MAX_SIMPLIFICATION_ATTEMPTS_PER_SOURCE_POINT = 12
const MAX_SIMPLIFICATION_DEVIATION_FRACTION = 0.9
const GEOMETRY_EPSILON = 1e-12
const ROUGHNESS_TOLERANCE = 1e-12

/** Explicit, source-size-linear ceiling for local fitting proposals. */
export const FLOWING_CONTOURS_CURVE_MAX_WORK_PER_SOURCE_POINT =
  MAX_SIMPLIFICATION_ATTEMPTS_PER_SOURCE_POINT +
  MAX_FAIRING_PASSES * (FAIRING_BACKOFF_ATTEMPTS + 2)

export interface FlowingContoursCurveFittingOptions {
  /** A complete lower-only policy, normally the production limits. */
  readonly limits?: Readonly<FlowingContoursLimits>
  /** Points already committed by earlier accepted trajectories. */
  readonly currentFittedPointCount?: number
  /** Lower-only FC13a proof budget for each individual proposal. */
  readonly maximumValidationSamples?: number
}

export type FlowingContoursCurveFitResult =
  | Readonly<{
      readonly status: 'fitted'
      readonly curve: Readonly<FittedFlowingCurve>
      readonly fittedPointCount: number
      readonly workCount: number
    }>
  | Readonly<{
      readonly status: 'invalid-input'
      readonly curve: null
      readonly fittedPointCount: 0
      readonly workCount: number
    }>
  | Readonly<{
      readonly status: 'limit-reached'
      readonly limitedBy: 'fitted-curve-point-count'
      readonly curve: null
      readonly fittedPointCount: 0
      readonly workCount: number
    }>

export type FlowingContoursCurvesFitResult =
  | Readonly<{
      readonly status: 'fitted'
      readonly curves: readonly Readonly<FittedFlowingCurve>[]
      readonly fittedPointCount: number
      readonly workCount: number
    }>
  | Readonly<{
      readonly status: 'invalid-input'
      readonly curves: readonly Readonly<FittedFlowingCurve>[]
      readonly fittedPointCount: 0
      readonly workCount: number
    }>
  | Readonly<{
      readonly status: 'limit-reached'
      readonly limitedBy: 'fitted-curve-point-count'
      readonly curves: readonly Readonly<FittedFlowingCurve>[]
      readonly fittedPointCount: 0
      readonly workCount: number
    }>

interface MutableCurvePoint {
  readonly point: Readonly<Point>
  readonly sourceSampleIndex: number
}

interface SimplificationNode {
  readonly sourceSampleIndex: number
  previous: number
  next: number
  generation: number
  present: boolean
}

interface RemovalCandidate {
  readonly sourceSampleIndex: number
  readonly generation: number
  readonly requiredSmoothing: number
}

interface FittingPolicy {
  readonly limits: Readonly<FlowingContoursLimits>
  readonly fittedPointLimit: number
  readonly currentFittedPointCount: number
  readonly maximumValidationSamples: number
}

function frozenPoint(point: Readonly<Point>): Readonly<Point> {
  return Object.freeze([point[0], point[1]] as Point)
}

function invalid(workCount = 0): FlowingContoursCurveFitResult {
  return Object.freeze({
    status: 'invalid-input',
    curve: null,
    fittedPointCount: 0,
    workCount,
  })
}

function limited(workCount = 0): FlowingContoursCurveFitResult {
  return Object.freeze({
    status: 'limit-reached',
    limitedBy: 'fitted-curve-point-count',
    curve: null,
    fittedPointCount: 0,
    workCount,
  })
}

function ownDataNumber(
  source: object,
  name: PropertyKey,
): number | null {
  const descriptor = Object.getOwnPropertyDescriptor(source, name)
  return descriptor !== undefined &&
    'value' in descriptor &&
    typeof descriptor.value === 'number'
    ? descriptor.value
    : null
}

function resolvePolicy(
  options: Readonly<FlowingContoursCurveFittingOptions>,
): Readonly<FittingPolicy> | null {
  try {
    if (options === null || typeof options !== 'object') return null
    const limits = options.limits ?? FLOWING_CONTOURS_LIMITS
    if (limits === null || typeof limits !== 'object') return null
    const fittedPointLimit = ownDataNumber(
      limits,
      'fitted-curve-point-count',
    )
    const currentFittedPointCount =
      options.currentFittedPointCount ?? 0
    const maximumValidationSamples =
      options.maximumValidationSamples ??
      FLOWING_CONTOURS_TUBE_MAX_VALIDATION_SAMPLES
    if (
      fittedPointLimit === null ||
      !Number.isSafeInteger(fittedPointLimit) ||
      fittedPointLimit < 0 ||
      fittedPointLimit >
        FLOWING_CONTOURS_LIMITS['fitted-curve-point-count'] ||
      !Number.isSafeInteger(currentFittedPointCount) ||
      currentFittedPointCount < 0 ||
      currentFittedPointCount > fittedPointLimit ||
      !Number.isSafeInteger(maximumValidationSamples) ||
      maximumValidationSamples < 1 ||
      maximumValidationSamples >
        FLOWING_CONTOURS_TUBE_MAX_VALIDATION_SAMPLES
    ) {
      return null
    }
    return Object.freeze({
      limits,
      fittedPointLimit,
      currentFittedPointCount,
      maximumValidationSamples,
    })
  } catch {
    return null
  }
}

function distanceToSegment(
  point: Readonly<Point>,
  start: Readonly<Point>,
  end: Readonly<Point>,
): number {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  if (
    !Number.isFinite(lengthSquared) ||
    lengthSquared <= GEOMETRY_EPSILON
  ) {
    return Infinity
  }
  const amount = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - start[0]) * dx +
        (point[1] - start[1]) * dy) /
        lengthSquared,
    ),
  )
  return Math.hypot(
    point[0] - (start[0] + dx * amount),
    point[1] - (start[1] + dy * amount),
  )
}

function compareCandidates(
  first: Readonly<RemovalCandidate>,
  second: Readonly<RemovalCandidate>,
): number {
  return (
    first.requiredSmoothing - second.requiredSmoothing ||
    first.sourceSampleIndex - second.sourceSampleIndex ||
    first.generation - second.generation
  )
}

class CandidateHeap {
  private readonly values: RemovalCandidate[] = []

  get size(): number {
    return this.values.length
  }

  push(candidate: Readonly<RemovalCandidate>): void {
    this.values.push(candidate)
    let index = this.values.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (
        compareCandidates(this.values[parent]!, this.values[index]!) <= 0
      ) {
        break
      }
      const value = this.values[parent]!
      this.values[parent] = this.values[index]!
      this.values[index] = value
      index = parent
    }
  }

  pop(): Readonly<RemovalCandidate> | null {
    const first = this.values[0]
    const last = this.values.pop()
    if (first === undefined || last === undefined) return null
    if (this.values.length > 0) {
      this.values[0] = last
      let index = 0
      while (true) {
        const left = index * 2 + 1
        const right = left + 1
        let best = index
        if (
          left < this.values.length &&
          compareCandidates(this.values[left]!, this.values[best]!) < 0
        ) {
          best = left
        }
        if (
          right < this.values.length &&
          compareCandidates(this.values[right]!, this.values[best]!) < 0
        ) {
          best = right
        }
        if (best === index) break
        const value = this.values[index]!
        this.values[index] = this.values[best]!
        this.values[best] = value
        index = best
      }
    }
    return first
  }
}

function candidateFor(
  nodes: readonly SimplificationNode[],
  points: readonly Readonly<Point>[],
  sourceSampleIndex: number,
  tubeRadius: number,
): Readonly<RemovalCandidate> | null {
  const node = nodes[sourceSampleIndex]
  if (
    node === undefined ||
    !node.present ||
    node.previous < 0 ||
    node.next < 0
  ) {
    return null
  }
  const deviation = distanceToSegment(
    points[sourceSampleIndex]!,
    points[node.previous]!,
    points[node.next]!,
  )
  const requiredSmoothing =
    deviation /
    Math.max(
      GEOMETRY_EPSILON,
      tubeRadius * MAX_SIMPLIFICATION_DEVIATION_FRACTION,
    )
  return Number.isFinite(requiredSmoothing)
    ? Object.freeze({
        sourceSampleIndex,
        generation: node.generation,
        requiredSmoothing,
      })
    : null
}

function simplificationSurvivors(
  field: Readonly<FlowingContoursField>,
  tube: NonNullable<
    ReturnType<typeof createFlowingContoursEvidenceTube>
  >,
  source: readonly Readonly<Point>[],
  flowSmoothing: number,
  maximumValidationSamples: number,
): {
  readonly points: readonly MutableCurvePoint[]
  readonly workCount: number
} | null {
  const nodes = source.map(
    (_point, sourceSampleIndex): SimplificationNode => ({
      sourceSampleIndex,
      previous: sourceSampleIndex - 1,
      next:
        sourceSampleIndex + 1 < source.length
          ? sourceSampleIndex + 1
          : -1,
      generation: 0,
      present: true,
    }),
  )
  const removalThresholds = new Array<number>(source.length).fill(Infinity)
  const attempts = new Array<number>(source.length).fill(0)
  const heap = new CandidateHeap()
  for (let index = 1; index < source.length - 1; index += 1) {
    const candidate = candidateFor(
      nodes,
      source,
      index,
      tube.evidenceTubeRadius,
    )
    if (candidate !== null) heap.push(candidate)
  }

  let workCount = 0
  let cumulativeThreshold = 0
  while (heap.size > 0) {
    const candidate = heap.pop()!
    const node = nodes[candidate.sourceSampleIndex]!
    if (
      !node.present ||
      candidate.generation !== node.generation ||
      node.previous < 0 ||
      node.next < 0
    ) {
      continue
    }
    const refreshed = candidateFor(
      nodes,
      source,
      candidate.sourceSampleIndex,
      tube.evidenceTubeRadius,
    )
    if (refreshed === null) continue
    if (
      Math.abs(
        refreshed.requiredSmoothing - candidate.requiredSmoothing,
      ) > GEOMETRY_EPSILON
    ) {
      heap.push(refreshed)
      continue
    }
    if (
      refreshed.requiredSmoothing > 1 ||
      attempts[node.sourceSampleIndex]! >=
        MAX_SIMPLIFICATION_ATTEMPTS_PER_SOURCE_POINT
    ) {
      continue
    }
    attempts[node.sourceSampleIndex]! += 1
    workCount += 1
    const shortcut = validateFlowingContoursTubeSegment(
      field,
      tube,
      {
        start: {
          point: source[node.previous]!,
          sourceSampleIndex: node.previous,
        },
        end: {
          point: source[node.next]!,
          sourceSampleIndex: node.next,
        },
      },
      { maximumValidationSamples },
    )
    if (shortcut === null) continue

    cumulativeThreshold = Math.max(
      cumulativeThreshold,
      refreshed.requiredSmoothing,
    )
    removalThresholds[node.sourceSampleIndex] = cumulativeThreshold
    node.present = false
    const previous = nodes[node.previous]!
    const next = nodes[node.next]!
    previous.next = node.next
    next.previous = node.previous
    previous.generation += 1
    next.generation += 1
    for (const index of [previous.sourceSampleIndex, next.sourceSampleIndex]) {
      const replacement = candidateFor(
        nodes,
        source,
        index,
        tube.evidenceTubeRadius,
      )
      if (replacement !== null) heap.push(replacement)
    }
  }

  const points: MutableCurvePoint[] = []
  for (let index = 0; index < source.length; index += 1) {
    if (removalThresholds[index]! > flowSmoothing) {
      points.push({
        point: frozenPoint(source[index]!),
        sourceSampleIndex: index,
      })
    }
  }
  return points.length >= 2
    ? { points: Object.freeze(points), workCount }
    : null
}

function localRoughness(
  previous: Readonly<Point>,
  point: Readonly<Point>,
  next: Readonly<Point>,
): number {
  return Math.hypot(
    previous[0] - 2 * point[0] + next[0],
    previous[1] - 2 * point[1] + next[1],
  )
}

function fairCurve(
  field: Readonly<FlowingContoursField>,
  tube: NonNullable<
    ReturnType<typeof createFlowingContoursEvidenceTube>
  >,
  source: readonly MutableCurvePoint[],
  flowSmoothing: number,
  maximumValidationSamples: number,
): {
  readonly points: readonly MutableCurvePoint[]
  readonly workCount: number
} | null {
  let current = source.map((entry) => ({
    point: frozenPoint(entry.point),
    sourceSampleIndex: entry.sourceSampleIndex,
  }))
  let workCount = 0
  const passCount = Math.min(
    MAX_FAIRING_PASSES,
    Math.floor(flowSmoothing * MAX_FAIRING_PASSES + GEOMETRY_EPSILON),
  )

  for (let pass = 0; pass < passCount; pass += 1) {
    for (let index = 1; index < current.length - 1; index += 1) {
      const previous = current[index - 1]!
      const original = current[index]!
      const next = current[index + 1]!
      const midpoint = frozenPoint([
        (previous.point[0] + next.point[0]) / 2,
        (previous.point[1] + next.point[1]) / 2,
      ])
      const before = localRoughness(
        previous.point,
        original.point,
        next.point,
      )
      let amount = FAIRING_PASS_AMOUNT
      for (
        let attempt = 0;
        attempt < FAIRING_BACKOFF_ATTEMPTS;
        attempt += 1
      ) {
        workCount += 1
        const proposed = frozenPoint([
          original.point[0] +
            (midpoint[0] - original.point[0]) * amount,
          original.point[1] +
            (midpoint[1] - original.point[1]) * amount,
        ])
        if (
          localRoughness(
            previous.point,
            proposed,
            next.point,
          ) <
            before - ROUGHNESS_TOLERANCE &&
          validateFlowingContoursTubePoint(
            field,
            tube,
            {
              point: proposed,
              sourceSampleIndex: original.sourceSampleIndex,
            },
            { maximumValidationSamples },
          ) !== null &&
          validateFlowingContoursTubeSegment(
            field,
            tube,
            {
              start: previous,
              end: {
                point: proposed,
                sourceSampleIndex: original.sourceSampleIndex,
              },
            },
            { maximumValidationSamples },
          ) !== null &&
          validateFlowingContoursTubeSegment(
            field,
            tube,
            {
              start: {
                point: proposed,
                sourceSampleIndex: original.sourceSampleIndex,
              },
              end: next,
            },
            { maximumValidationSamples },
          ) !== null
        ) {
          current[index] = {
            point: proposed,
            sourceSampleIndex: original.sourceSampleIndex,
          }
          break
        }
        amount /= 2
      }
    }
    const passValidation = validateFlowingContoursTubeCurve(
      field,
      tube,
      {
        points: current.map((entry) => entry.point),
        sourceSampleIndices: current.map(
          (entry) => entry.sourceSampleIndex,
        ),
      },
      { maximumValidationSamples },
    )
    workCount += 1
    if (passValidation === null) return null
  }
  return { points: Object.freeze(current), workCount }
}

/**
 * Fit one accepted trajectory transactionally.
 *
 * `limit-reached` is distinct from malformed or unprovable input so FC14 can
 * stop before an aggregate output cap without discarding earlier diagnostics.
 */
function fitFlowingContoursCurveUnsafe(
  field: Readonly<FlowingContoursField>,
  trajectory: Readonly<AcceptedFlowingTrajectory>,
  flowSmoothing: number,
  options: Readonly<FlowingContoursCurveFittingOptions> = {},
): FlowingContoursCurveFitResult {
  const policy = resolvePolicy(options)
  if (
    policy === null ||
    !Number.isFinite(flowSmoothing) ||
    flowSmoothing < 0 ||
    flowSmoothing > 1
  ) {
    return invalid()
  }
  if (
    policy.fittedPointLimit - policy.currentFittedPointCount < 2
  ) {
    return limited()
  }

  const tube = createFlowingContoursEvidenceTube(field, trajectory, {
    maximumValidationSamples: policy.maximumValidationSamples,
  })
  if (tube === null) return invalid()
  const source = trajectory.samples.map((sample) => sample.point)
  const simplified = simplificationSurvivors(
    field,
    tube,
    source,
    flowSmoothing,
    policy.maximumValidationSamples,
  )
  if (simplified === null) return invalid()
  if (
    simplified.workCount >
      source.length *
        MAX_SIMPLIFICATION_ATTEMPTS_PER_SOURCE_POINT
  ) {
    return invalid(simplified.workCount)
  }
  const faired = fairCurve(
    field,
    tube,
    simplified.points,
    flowSmoothing,
    policy.maximumValidationSamples,
  )
  const workCount =
    simplified.workCount + (faired?.workCount ?? 0)
  if (
    faired === null ||
    workCount >
      source.length *
        FLOWING_CONTOURS_CURVE_MAX_WORK_PER_SOURCE_POINT
  ) {
    return invalid(workCount)
  }

  const points = Object.freeze(
    faired.points.map((entry) => frozenPoint(entry.point)),
  )
  if (
    policy.currentFittedPointCount + points.length >
    policy.fittedPointLimit
  ) {
    return limited(workCount)
  }
  const validation = validateFlowingContoursTubeCurve(
    field,
    tube,
    {
      points,
      sourceSampleIndices: faired.points.map(
        (entry) => entry.sourceSampleIndex,
      ),
    },
    { maximumValidationSamples: policy.maximumValidationSamples },
  )
  if (validation === null) return invalid(workCount)

  const curve = Object.freeze({
    points,
    provenance: Object.freeze({
      sourceTrajectoryId: validation.sourceTrajectoryId,
      sourceSampleIndices: validation.sourceSampleIndices,
      evidenceTubeRadius: validation.evidenceTubeRadius,
      maximumDeviation: validation.maximumDeviation,
    }),
  })
  return Object.freeze({
    status: 'fitted',
    curve,
    fittedPointCount: points.length,
    workCount,
  })
}

export function fitFlowingContoursCurve(
  field: Readonly<FlowingContoursField>,
  trajectory: Readonly<AcceptedFlowingTrajectory>,
  flowSmoothing: number,
  options: Readonly<FlowingContoursCurveFittingOptions> = {},
): FlowingContoursCurveFitResult {
  try {
    return fitFlowingContoursCurveUnsafe(
      field,
      trajectory,
      flowSmoothing,
      options,
    )
  } catch {
    return invalid()
  }
}

/**
 * Fit a complete accepted-order batch. Any failure returns no partial curves.
 */
export function fitFlowingContoursCurves(
  field: Readonly<FlowingContoursField>,
  trajectories: readonly Readonly<AcceptedFlowingTrajectory>[],
  flowSmoothing: number,
  options: Readonly<FlowingContoursCurveFittingOptions> = {},
): FlowingContoursCurvesFitResult {
  try {
    if (
      !Array.isArray(trajectories) ||
      !Number.isFinite(flowSmoothing) ||
      flowSmoothing < 0 ||
      flowSmoothing > 1
    ) {
      return Object.freeze({
        status: 'invalid-input',
        curves: Object.freeze([]),
        fittedPointCount: 0,
        workCount: 0,
      })
    }
    const policy = resolvePolicy(options)
    if (policy === null) {
      return Object.freeze({
        status: 'invalid-input',
        curves: Object.freeze([]),
        fittedPointCount: 0,
        workCount: 0,
      })
    }
    const curves: Readonly<FittedFlowingCurve>[] = []
    let fittedPointCount = policy.currentFittedPointCount
    let workCount = 0
    for (const trajectory of trajectories) {
      const result = fitFlowingContoursCurve(
        field,
        trajectory,
        flowSmoothing,
        {
          limits: policy.limits,
          currentFittedPointCount: fittedPointCount,
          maximumValidationSamples: policy.maximumValidationSamples,
        },
      )
      workCount += result.workCount
      if (result.status !== 'fitted') {
        return result.status === 'limit-reached'
          ? Object.freeze({
              status: 'limit-reached',
              limitedBy: 'fitted-curve-point-count',
              curves: Object.freeze([]),
              fittedPointCount: 0,
              workCount,
            })
          : Object.freeze({
              status: 'invalid-input',
              curves: Object.freeze([]),
              fittedPointCount: 0,
              workCount,
            })
      }
      curves.push(result.curve)
      fittedPointCount += result.fittedPointCount
    }
    return Object.freeze({
      status: 'fitted',
      curves: Object.freeze(curves),
      fittedPointCount:
        fittedPointCount - policy.currentFittedPointCount,
      workCount,
    })
  } catch {
    return Object.freeze({
      status: 'invalid-input',
      curves: Object.freeze([]),
      fittedPointCount: 0,
      workCount: 0,
    })
  }
}
