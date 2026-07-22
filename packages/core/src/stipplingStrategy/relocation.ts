import { sampleEffectiveTone } from '../shadingFields'
import type { Point } from '../types'
import { isMaskPermittedStipple } from './mask'
import {
  computeStipplingDistributionErrorForCenters,
  hasNativeStipplingDistributionError,
} from './model'
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

/** Flag both sides of every too-close pair without ordered acceptance bias. */
function spacingConflicts(
  centers: readonly Readonly<Point>[],
  minimumSpacing: number,
): Uint8Array {
  const conflicts = new Uint8Array(centers.length)
  const rows = new Map<number, Map<number, number[]>>()
  const minimumSpacingSquared = minimumSpacing * minimumSpacing

  for (let index = 0; index < centers.length; index++) {
    const center = centers[index]!
    if (!Number.isFinite(center[0]) || !Number.isFinite(center[1])) continue
    const cellX = Math.floor(center[0] / minimumSpacing)
    const cellY = Math.floor(center[1] / minimumSpacing)
    for (let y = cellY - 1; y <= cellY + 1; y++) {
      const row = rows.get(y)
      if (row === undefined) continue
      for (let x = cellX - 1; x <= cellX + 1; x++) {
        for (const otherIndex of row.get(x) ?? []) {
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
    let row = rows.get(cellY)
    if (row === undefined) {
      row = new Map<number, number[]>()
      rows.set(cellY, row)
    }
    const bucket = row.get(cellX)
    if (bucket === undefined) row.set(cellX, [index])
    else bucket.push(index)
  }

  return conflicts
}

class IncrementalSpacingConflicts {
  readonly degrees: Uint32Array

  private readonly rows = new Map<number, Map<number, number[]>>()
  private readonly minimumSpacingSquared: number

  constructor(
    private readonly centers: Readonly<Point>[],
    private readonly minimumSpacing: number,
  ) {
    this.degrees = new Uint32Array(centers.length)
    this.minimumSpacingSquared = minimumSpacing * minimumSpacing
    for (let index = 0; index < centers.length; index++) this.insert(index)
  }

  replaceCenters(
    replacements: readonly (readonly [number, Readonly<Point>])[],
  ): void {
    const ordered = [...replacements].sort(
      ([firstIndex], [secondIndex]) => firstIndex - secondIndex,
    )
    for (
      let replacementIndex = 1;
      replacementIndex < ordered.length;
      replacementIndex++
    ) {
      if (ordered[replacementIndex - 1]![0] === ordered[replacementIndex]![0]) {
        throw new RangeError('Spacing-conflict replacements must be unique')
      }
    }
    for (const [index] of ordered) this.remove(index)
    for (const [index, center] of ordered) this.centers[index] = center
    for (const [index] of ordered) this.insert(index)
  }

  private forEachNeighbor(
    index: number,
    visit: (otherIndex: number) => void,
  ): void {
    const center = this.centers[index]!
    if (!Number.isFinite(center[0]) || !Number.isFinite(center[1])) return
    const cellX = Math.floor(center[0] / this.minimumSpacing)
    const cellY = Math.floor(center[1] / this.minimumSpacing)
    for (let y = cellY - 1; y <= cellY + 1; y++) {
      const row = this.rows.get(y)
      if (row === undefined) continue
      for (let x = cellX - 1; x <= cellX + 1; x++) {
        for (const otherIndex of row.get(x) ?? []) {
          if (otherIndex === index) continue
          const other = this.centers[otherIndex]!
          const deltaX = center[0] - other[0]
          const deltaY = center[1] - other[1]
          if (
            deltaX * deltaX + deltaY * deltaY <
            this.minimumSpacingSquared
          ) {
            visit(otherIndex)
          }
        }
      }
    }
  }

  private insert(index: number): void {
    const center = this.centers[index]!
    if (!Number.isFinite(center[0]) || !Number.isFinite(center[1])) return
    this.forEachNeighbor(index, (otherIndex) => {
      this.degrees[index] = this.degrees[index]! + 1
      this.degrees[otherIndex] = this.degrees[otherIndex]! + 1
    })
    const cellX = Math.floor(center[0] / this.minimumSpacing)
    const cellY = Math.floor(center[1] / this.minimumSpacing)
    let row = this.rows.get(cellY)
    if (row === undefined) {
      row = new Map<number, number[]>()
      this.rows.set(cellY, row)
    }
    const bucket = row.get(cellX)
    if (bucket === undefined) row.set(cellX, [index])
    else bucket.push(index)
  }

  private remove(index: number): void {
    const center = this.centers[index]!
    if (!Number.isFinite(center[0]) || !Number.isFinite(center[1])) return
    this.forEachNeighbor(index, (otherIndex) => {
      this.degrees[index] = this.degrees[index]! - 1
      this.degrees[otherIndex] = this.degrees[otherIndex]! - 1
    })
    const cellX = Math.floor(center[0] / this.minimumSpacing)
    const cellY = Math.floor(center[1] / this.minimumSpacing)
    const row = this.rows.get(cellY)!
    const bucket = row.get(cellX)!
    bucket.splice(bucket.indexOf(index), 1)
    if (bucket.length === 0) row.delete(cellX)
    if (row.size === 0) this.rows.delete(cellY)
  }
}

/** @internal Direct-module seam for exact spatial-index equivalence tests. */
export function findStipplingSpacingConflictsForTesting(
  centers: readonly Readonly<Point>[],
  minimumSpacing: number,
): Uint8Array {
  return spacingConflicts(centers, minimumSpacing)
}

/** @internal Trace incremental conflict degrees after simultaneous move batches. */
export function traceStipplingSpacingConflictDegreesForTesting(
  initialCenters: readonly Readonly<Point>[],
  minimumSpacing: number,
  batches: readonly (readonly (readonly [number, Readonly<Point>])[])[],
): readonly Uint32Array[] {
  const centers = [...initialCenters]
  const conflicts = new IncrementalSpacingConflicts(centers, minimumSpacing)
  const snapshots = [conflicts.degrees.slice()]
  for (const batch of batches) {
    conflicts.replaceCenters(batch)
    snapshots.push(conflicts.degrees.slice())
  }
  return snapshots
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
  const conflicts = new IncrementalSpacingConflicts(
    centers,
    model.scales.minimumSpacing,
  )

  while (true) {
    const replacements: (readonly [number, Readonly<Point>])[] = []

    for (let siteIndex = 0; siteIndex < marks.length; siteIndex++) {
      const mark = marks[siteIndex]!
      const centroid = assignment.cells[siteIndex]!.centroid
      const center = centers[siteIndex]!
      if (
        centroid === null ||
        samePoint(center, mark.center) ||
        (conflicts.degrees[siteIndex] === 0 &&
          isCandidatePermitted(model, center, mark.orientation))
      ) {
        continue
      }

      steps[siteIndex] = steps[siteIndex]! + 1
      replacements.push([
        siteIndex,
        backtrackedCenter(mark.center, centroid, steps[siteIndex]!),
      ])
    }

    if (replacements.length === 0) return centers
    conflicts.replaceCenters(replacements)
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

function materializeRelocatedMarks(
  marks: readonly Readonly<StippleMark>[],
  candidates: readonly Readonly<Point>[],
): readonly Readonly<StippleMark>[] {
  return Object.freeze(
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
}

function candidateDistributionError(
  model: Readonly<StipplingModel>,
  marks: readonly Readonly<StippleMark>[],
  candidates: readonly Readonly<Point>[],
): number {
  return hasNativeStipplingDistributionError(model)
    ? computeStipplingDistributionErrorForCenters(model, candidates)
    : model.distributionError(materializeRelocatedMarks(marks, candidates))
}

function candidateSetIsSafe(
  model: Readonly<StipplingModel>,
  marks: readonly Readonly<StippleMark>[],
  candidates: readonly Readonly<Point>[],
): boolean {
  if (
    spacingConflicts(candidates, model.scales.minimumSpacing).some(
      (conflict) => conflict !== 0,
    )
  ) {
    return false
  }
  return candidates.every(
    (center, siteIndex) =>
      samePoint(center, marks[siteIndex]!.center) ||
      isCandidatePermitted(
        model,
        center,
        marks[siteIndex]!.orientation,
      ),
  )
}

/**
 * Propose one simultaneous weighted-centroid move from a completed assignment.
 *
 * Every site uses the same frozen assignment. Invalid proposals deterministically
 * halve their displacement until safe, or return exactly to their old center.
 * The pass preserves ordered identity and orientation and commits only strict
 * fixed-cell spatial improvements. If the full safe proposal worsens the
 * Distribution metric, the simultaneous displacement is deterministically
 * halved until both metrics are preserved, or rolled back if none survives.
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

  let retainedCandidates = candidates
  let distributionError = candidateDistributionError(
    model,
    marks,
    retainedCandidates,
  )
  let backtracked: Point[] | undefined
  for (
    let step = 1;
    !Number.isFinite(distributionError) ||
    distributionError > preRelaxationDistributionError;
    step++
  ) {
    if (step > MAXIMUM_BACKTRACK_STEPS) {
      return rejectedOutcome(
        marks,
        assignment,
        preRelaxationDistributionError,
        'distribution-error-worsened',
      )
    }

    backtracked ??= candidates.map(([x, y]) => [x, y])
    const progress = 2 ** -step
    for (let siteIndex = 0; siteIndex < backtracked.length; siteIndex++) {
      const origin = marks[siteIndex]!.center
      const candidate = candidates[siteIndex]!
      backtracked[siteIndex]![0] =
        origin[0] + (candidate[0] - origin[0]) * progress
      backtracked[siteIndex]![1] =
        origin[1] + (candidate[1] - origin[1]) * progress
    }
    const backtrackedDistributionError = candidateDistributionError(
      model,
      marks,
      backtracked,
    )
    if (
      !Number.isFinite(backtrackedDistributionError) ||
      backtrackedDistributionError > preRelaxationDistributionError
    ) {
      continue
    }
    if (!candidateSetIsSafe(model, marks, backtracked)) continue

    const backtrackedObjective = summarizeObjective(
      model,
      marks,
      backtracked,
      assignment,
    )
    if (
      !(backtrackedObjective.normalizedObjective <
        assignment.normalizedObjective)
    ) {
      continue
    }

    retainedCandidates = backtracked
    objective = backtrackedObjective
    distributionError = backtrackedDistributionError
  }

  acceptedRelocationCount = retainedCandidates.reduce(
    (count, candidate, siteIndex) =>
      count + (samePoint(candidate, marks[siteIndex]!.center) ? 0 : 1),
    0,
  )
  if (acceptedRelocationCount === 0) {
    return rejectedOutcome(
      marks,
      assignment,
      preRelaxationDistributionError,
      'no-spatial-improvement',
    )
  }
  const relocated = materializeRelocatedMarks(marks, retainedCandidates)

  return Object.freeze({
    marks: relocated,
    acceptedRelocationCount,
    normalizedObjective: objective.normalizedObjective,
    distributionError,
    passAccepted: true,
    reason: 'accepted',
  })
}
