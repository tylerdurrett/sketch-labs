import { sampleEffectiveTone } from '../shadingFields'
import type { Point } from '../types'
import { isMaskPermittedStipple } from './mask'
import type { StippleMark, StipplingModel } from './types'
import type { StipplingVoronoiAssignment } from './voronoi'

const MAXIMUM_BACKTRACK_STEPS = 24

export type StipplingRelocationReason =
  | 'accepted'
  | 'no-spatial-improvement'
  | 'distribution-error-worsened'

/** Immutable result of one fixed-assignment centroid relocation pass. */
export interface StipplingRelocationOutcome {
  /** Ordered marks, or the caller's exact array when the pass changes nothing. */
  readonly marks: readonly Readonly<StippleMark>[]
  /** Centers changed by an accepted pass. Always zero for a rejected pass. */
  readonly acceptedRelocationCount: number
  /** Fixed-assignment, demand-weighted squared-distance objective. */
  readonly normalizedObjective: number
  readonly distributionError: number
  readonly passAccepted: boolean
  readonly reason: StipplingRelocationReason
}

function assertCompatibleAssignment(
  model: Readonly<StipplingModel>,
  marks: readonly Readonly<StippleMark>[],
  assignment: Readonly<StipplingVoronoiAssignment>,
): void {
  if (assignment.assignments.length !== model.lattice.sampleCount) {
    throw new RangeError('Voronoi assignments must match the demand lattice')
  }
  if (assignment.cells.length !== marks.length) {
    throw new RangeError('Voronoi cells must match the ordered marks')
  }
  for (let siteIndex = 0; siteIndex < assignment.cells.length; siteIndex++) {
    if (assignment.cells[siteIndex]!.siteIndex !== siteIndex) {
      throw new RangeError('Voronoi cells must retain ordered-site identity')
    }
  }
  for (const siteIndex of assignment.assignments) {
    if (
      siteIndex !== null &&
      (!Number.isSafeInteger(siteIndex) ||
        siteIndex < 0 ||
        siteIndex >= marks.length)
    ) {
      throw new RangeError('Voronoi assignment contains an invalid site index')
    }
  }
}

function samePoint(first: Readonly<Point>, second: Readonly<Point>): boolean {
  return first[0] === second[0] && first[1] === second[1]
}

function backtrackedCenter(
  origin: Readonly<Point>,
  centroid: Readonly<Point>,
  step: number,
): Readonly<Point> {
  if (step > MAXIMUM_BACKTRACK_STEPS) return origin
  const progress = 2 ** -step
  return Object.freeze([
    origin[0] + (centroid[0] - origin[0]) * progress,
    origin[1] + (centroid[1] - origin[1]) * progress,
  ] as Point)
}

function isCandidatePermitted(
  model: Readonly<StipplingModel>,
  center: Readonly<Point>,
  orientation: number,
): boolean {
  const [x, y] = center
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > model.frame.width ||
    y < 0 ||
    y > model.frame.height ||
    sampleEffectiveTone(model.source, center) <= 0
  ) {
    return false
  }

  const halfX = (Math.cos(orientation) * model.scales.stippleLength) / 2
  const halfY = (Math.sin(orientation) * model.scales.stippleLength) / 2
  return isMaskPermittedStipple(
    model.source.shadingMask,
    model.frame,
    [x - halfX, y - halfY],
    [x + halfX, y + halfY],
    model.scales.maskCheckSpacing,
  )
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`
}

/** Flag both sides of every too-close pair without ordered acceptance bias. */
function spacingConflicts(
  centers: readonly Readonly<Point>[],
  minimumSpacing: number,
): Uint8Array {
  const conflicts = new Uint8Array(centers.length)
  const cells = new Map<string, number[]>()
  const minimumSpacingSquared = minimumSpacing * minimumSpacing

  for (let index = 0; index < centers.length; index++) {
    const center = centers[index]!
    if (!Number.isFinite(center[0]) || !Number.isFinite(center[1])) continue
    const cellX = Math.floor(center[0] / minimumSpacing)
    const cellY = Math.floor(center[1] / minimumSpacing)
    for (let y = cellY - 1; y <= cellY + 1; y++) {
      for (let x = cellX - 1; x <= cellX + 1; x++) {
        for (const otherIndex of cells.get(cellKey(x, y)) ?? []) {
          const other = centers[otherIndex]!
          const deltaX = center[0] - other[0]
          const deltaY = center[1] - other[1]
          if (deltaX * deltaX + deltaY * deltaY < minimumSpacingSquared) {
            conflicts[index] = 1
            conflicts[otherIndex] = 1
          }
        }
      }
    }
    const key = cellKey(cellX, cellY)
    const bucket = cells.get(key)
    if (bucket === undefined) cells.set(key, [index])
    else bucket.push(index)
  }

  return conflicts
}

function settleCandidates(
  model: Readonly<StipplingModel>,
  marks: readonly Readonly<StippleMark>[],
  assignment: Readonly<StipplingVoronoiAssignment>,
): Readonly<Point>[] {
  const steps = new Uint8Array(marks.length)
  const centers = marks.map((mark, siteIndex) => {
    const centroid = assignment.cells[siteIndex]!.centroid
    return centroid === null
      ? mark.center
      : backtrackedCenter(mark.center, centroid, 0)
  })

  while (true) {
    const conflicts = spacingConflicts(
      centers,
      model.scales.minimumSpacing,
    )
    let changed = false

    for (let siteIndex = 0; siteIndex < marks.length; siteIndex++) {
      const mark = marks[siteIndex]!
      const centroid = assignment.cells[siteIndex]!.centroid
      const center = centers[siteIndex]!
      if (
        centroid === null ||
        samePoint(center, mark.center) ||
        (conflicts[siteIndex] === 0 &&
          isCandidatePermitted(model, center, mark.orientation))
      ) {
        continue
      }

      steps[siteIndex] = steps[siteIndex]! + 1
      centers[siteIndex] = backtrackedCenter(
        mark.center,
        centroid,
        steps[siteIndex]!,
      )
      changed = true
    }

    if (!changed) return centers
  }
}

interface ObjectiveSummary {
  readonly normalizedObjective: number
  readonly oldBySite: Float64Array
  readonly candidateBySite: Float64Array
}

function summarizeObjective(
  model: Readonly<StipplingModel>,
  marks: readonly Readonly<StippleMark>[],
  candidates: readonly Readonly<Point>[],
  assignment: Readonly<StipplingVoronoiAssignment>,
): ObjectiveSummary {
  const frameScale = Math.max(model.frame.width, model.frame.height)
  const normalizedDiagonalSquared =
    (model.frame.width / frameScale) ** 2 +
    (model.frame.height / frameScale) ** 2
  const oldBySite = new Float64Array(marks.length)
  const candidateBySite = new Float64Array(marks.length)
  let candidateDistanceSum = 0

  for (
    let sampleIndex = 0;
    sampleIndex < model.lattice.samples.length;
    sampleIndex++
  ) {
    const siteIndex = assignment.assignments[sampleIndex]
    if (siteIndex == null) continue
    const sample = model.lattice.samples[sampleIndex]!
    const oldCenter = marks[siteIndex]!.center
    const candidate = candidates[siteIndex]!
    const oldX = (sample.point[0] - oldCenter[0]) / frameScale
    const oldY = (sample.point[1] - oldCenter[1]) / frameScale
    const candidateX = (sample.point[0] - candidate[0]) / frameScale
    const candidateY = (sample.point[1] - candidate[1]) / frameScale
    const oldDistance = sample.demand * (oldX * oldX + oldY * oldY)
    const candidateDistance =
      sample.demand *
      (candidateX * candidateX + candidateY * candidateY)
    oldBySite[siteIndex] = oldBySite[siteIndex]! + oldDistance
    candidateBySite[siteIndex] =
      candidateBySite[siteIndex]! + candidateDistance
    candidateDistanceSum += candidateDistance
  }

  return {
    normalizedObjective:
      assignment.totalWeight === 0
        ? 0
        : candidateDistanceSum /
          assignment.totalWeight /
          normalizedDiagonalSquared,
    oldBySite,
    candidateBySite,
  }
}

function rejectedOutcome(
  marks: readonly Readonly<StippleMark>[],
  assignment: Readonly<StipplingVoronoiAssignment>,
  distributionError: number,
  reason: Exclude<StipplingRelocationReason, 'accepted'>,
): Readonly<StipplingRelocationOutcome> {
  return Object.freeze({
    marks,
    acceptedRelocationCount: 0,
    normalizedObjective: assignment.normalizedObjective,
    distributionError,
    passAccepted: false,
    reason,
  })
}

/**
 * Propose one simultaneous weighted-centroid move from a completed assignment.
 *
 * Every site uses the same frozen assignment. Invalid proposals deterministically
 * halve their displacement until safe, or return exactly to their old center.
 * The pass preserves ordered identity and orientation, commits only strict
 * fixed-cell spatial improvements, and rolls back atomically if it worsens the
 * distribution metric established before relaxation.
 */
export function relocateStipplesToVoronoiCentroids(
  model: Readonly<StipplingModel>,
  marks: readonly Readonly<StippleMark>[],
  assignment: Readonly<StipplingVoronoiAssignment>,
  preRelaxationDistributionError: number,
): Readonly<StipplingRelocationOutcome> {
  if (!Number.isFinite(preRelaxationDistributionError)) {
    throw new RangeError('Pre-relaxation distribution error must be finite')
  }
  assertCompatibleAssignment(model, marks, assignment)
  if (marks.length === 0 || assignment.totalWeight === 0) {
    return rejectedOutcome(
      marks,
      assignment,
      preRelaxationDistributionError,
      'no-spatial-improvement',
    )
  }

  const candidates = settleCandidates(model, marks, assignment)
  let objective = summarizeObjective(model, marks, candidates, assignment)
  let acceptedRelocationCount = 0
  for (let siteIndex = 0; siteIndex < marks.length; siteIndex++) {
    if (
      samePoint(candidates[siteIndex]!, marks[siteIndex]!.center) ||
      !(objective.candidateBySite[siteIndex]! < objective.oldBySite[siteIndex]!)
    ) {
      candidates[siteIndex] = marks[siteIndex]!.center
    } else {
      acceptedRelocationCount++
    }
  }

  if (acceptedRelocationCount === 0) {
    return rejectedOutcome(
      marks,
      assignment,
      preRelaxationDistributionError,
      'no-spatial-improvement',
    )
  }

  objective = summarizeObjective(model, marks, candidates, assignment)
  if (!(objective.normalizedObjective < assignment.normalizedObjective)) {
    return rejectedOutcome(
      marks,
      assignment,
      preRelaxationDistributionError,
      'no-spatial-improvement',
    )
  }

  const relocated = Object.freeze(
    marks.map((mark, siteIndex) =>
      samePoint(mark.center, candidates[siteIndex]!)
        ? mark
        : Object.freeze({
            center: Object.freeze([
              candidates[siteIndex]![0],
              candidates[siteIndex]![1],
            ] as Point),
            orientation: mark.orientation,
          }),
    ),
  )
  const distributionError = model.distributionError(relocated)
  if (
    !Number.isFinite(distributionError) ||
    distributionError > preRelaxationDistributionError
  ) {
    return rejectedOutcome(
      marks,
      assignment,
      preRelaxationDistributionError,
      'distribution-error-worsened',
    )
  }

  return Object.freeze({
    marks: relocated,
    acceptedRelocationCount,
    normalizedObjective: objective.normalizedObjective,
    distributionError,
    passAccepted: true,
    reason: 'accepted',
  })
}
