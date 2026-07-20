import { sampleEffectiveTone } from '../shadingFields'
import type { Point, Random } from '../types'
import { isMaskPermittedStipple } from './mask'
import type { StippleMark, StipplingModel } from './types'

const DEFAULT_ATTEMPTS_PER_MARK = 20
const MAXIMUM_REFINEMENT_ATTEMPTS = 1_000_000

/** Resolve authored fidelity into exact bounded relocation work. */
export function resolveStipplingRefinementAttempts(
  markCount: number,
  distributionFidelity: number,
): number {
  if (!Number.isSafeInteger(markCount) || markCount < 0) {
    throw new RangeError('markCount must be a non-negative safe integer')
  }
  if (
    !Number.isFinite(distributionFidelity) ||
    distributionFidelity < 0 ||
    distributionFidelity > 1
  ) {
    throw new RangeError('distributionFidelity must be finite and within [0, 1]')
  }

  return Math.min(
    MAXIMUM_REFINEMENT_ATTEMPTS,
    Math.round(
      markCount * DEFAULT_ATTEMPTS_PER_MARK * distributionFidelity,
    ),
  )
}

/** Optional deterministic work bound for distribution refinement. */
export interface StipplingRefinementOptions {
  /** Exact relocation-attempt budget. Must be a safe integer in `[0, 1e6]`. */
  readonly maxAttempts?: number
}

/** Immutable result of one bounded distribution-refinement pass. */
export interface StipplingRefinementOutcome {
  /** Marks in their original order, with accepted centers replaced in place. */
  readonly marks: readonly Readonly<StippleMark>[]
  /** Final strategy-specific distribution error. */
  readonly error: number
  /** Relocation attempts consumed, including rejected candidates. */
  readonly attemptsUsed: number
  /** Whether the exact requested refinement-attempt budget was consumed. */
  readonly requestedRefinementReached: boolean
}

/** Evaluate the model's typed distribution metric and reject invalid results. */
export function computeStipplingDistributionError(
  model: Readonly<StipplingModel>,
  marks: readonly StippleMark[],
): number {
  const error = model.distributionError(marks)
  if (!Number.isFinite(error)) {
    throw new Error('Stippling distribution error must be finite')
  }
  return error
}

function resolveAttemptLimit(
  model: Readonly<StipplingModel>,
  markCount: number,
  options: StipplingRefinementOptions,
): number {
  const requested = options.maxAttempts
  if (requested !== undefined) {
    if (
      !Number.isSafeInteger(requested) ||
      requested < 0 ||
      requested > MAXIMUM_REFINEMENT_ATTEMPTS
    ) {
      throw new RangeError(
        `maxAttempts must be a safe integer in [0, ${MAXIMUM_REFINEMENT_ATTEMPTS}], got ${requested}`,
      )
    }
    return requested
  }

  return resolveStipplingRefinementAttempts(
    markCount,
    model.controls.distributionFidelity,
  )
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`
}

/** Mutable fixed-radius index supporting one-for-one center relocation. */
class RefinementCenterIndex {
  private readonly cells = new Map<string, Set<number>>()
  private readonly centers: Readonly<Point>[]
  private readonly minimumDistanceSquared: number

  constructor(
    marks: readonly StippleMark[],
    private readonly cellSize: number,
  ) {
    this.centers = marks.map(({ center }) => center)
    this.minimumDistanceSquared = cellSize * cellSize
    for (let index = 0; index < marks.length; index++) {
      this.add(index, marks[index]!.center)
    }
  }

  private coordinates(center: Readonly<Point>): readonly [number, number] {
    return [
      Math.floor(center[0] / this.cellSize),
      Math.floor(center[1] / this.cellSize),
    ]
  }

  private add(index: number, center: Readonly<Point>): void {
    const [cellX, cellY] = this.coordinates(center)
    const key = cellKey(cellX, cellY)
    const bucket = this.cells.get(key)
    if (bucket === undefined) this.cells.set(key, new Set([index]))
    else bucket.add(index)
  }

  private remove(index: number, center: Readonly<Point>): void {
    const [cellX, cellY] = this.coordinates(center)
    const key = cellKey(cellX, cellY)
    const bucket = this.cells.get(key)
    bucket?.delete(index)
    if (bucket?.size === 0) this.cells.delete(key)
  }

  isSeparated(center: Readonly<Point>, excludedIndex: number): boolean {
    const [cellX, cellY] = this.coordinates(center)

    for (let y = cellY - 1; y <= cellY + 1; y++) {
      for (let x = cellX - 1; x <= cellX + 1; x++) {
        const bucket = this.cells.get(cellKey(x, y))
        if (bucket === undefined) continue
        for (const index of bucket) {
          if (index === excludedIndex) continue
          const existing = this.centers[index]!
          const deltaX = center[0] - existing[0]
          const deltaY = center[1] - existing[1]
          if (
            deltaX * deltaX + deltaY * deltaY <
            this.minimumDistanceSquared
          ) {
            return false
          }
        }
      }
    }

    return true
  }

  replace(
    index: number,
    previous: Readonly<Point>,
    replacement: Readonly<Point>,
  ): void {
    this.remove(index, previous)
    this.centers[index] = replacement
    this.add(index, replacement)
  }
}

function candidateCenter(
  model: Readonly<StipplingModel>,
  cellDraw: number,
  xDraw: number,
  yDraw: number,
): Point | undefined {
  if (model.lattice.sampleCount === 0) return undefined
  const index = Math.min(
    model.lattice.sampleCount - 1,
    Math.floor(cellDraw * model.lattice.sampleCount),
  )

  const column = index % model.lattice.columns
  const row = Math.floor(index / model.lattice.columns)
  return [
    (column + xDraw) * model.lattice.cellWidth,
    (row + yDraw) * model.lattice.cellHeight,
  ]
}

function endpointsFor(
  center: Readonly<Point>,
  orientation: number,
  length: number,
): readonly [Readonly<Point>, Readonly<Point>] {
  const halfDeltaX = (Math.cos(orientation) * length) / 2
  const halfDeltaY = (Math.sin(orientation) * length) / 2
  return [
    [center[0] - halfDeltaX, center[1] - halfDeltaY],
    [center[0] + halfDeltaX, center[1] + halfDeltaY],
  ]
}

/**
 * Improve an ordered Stipple draft with bounded demand-weighted relocations.
 *
 * Every attempt consumes exactly five values from the supplied mutable random
 * stream, regardless of rejection. Equal-area proposals are accepted linearly
 * by effective demand sampled at their actual center, so off-lattice zero-tone
 * holes remain empty. Consequently a larger attempt budget is a strict prefix
 * extension of a smaller run from the same state. Candidates keep their selected
 * mark's index and orientation, and are committed only when the complete
 * fixed-length segment is mask-safe, its center remains blue-noise separated,
 * and the model reports a strictly lower finite distribution error.
 */
export function refineStipples(
  model: Readonly<StipplingModel>,
  rng: Random,
  marks: readonly StippleMark[],
  options: StipplingRefinementOptions = {},
): Readonly<StipplingRefinementOutcome> {
  const attemptLimit = resolveAttemptLimit(model, marks.length, options)
  const originalMarks: readonly Readonly<StippleMark>[] = Object.isFrozen(marks)
    ? marks
    : Object.freeze([...marks])
  let currentMarks = originalMarks
  let currentError = computeStipplingDistributionError(model, currentMarks)
  const centerIndex = new RefinementCenterIndex(
    currentMarks,
    model.scales.minimumSpacing,
  )

  for (let attempt = 0; attempt < attemptLimit; attempt++) {
    const markDraw = rng.value()
    const cellDraw = rng.value()
    const xDraw = rng.value()
    const yDraw = rng.value()
    const acceptanceDraw = rng.value()

    if (currentMarks.length === 0) continue
    const markIndex = Math.min(
      currentMarks.length - 1,
      Math.floor(markDraw * currentMarks.length),
    )
    const previous = currentMarks[markIndex]!
    const center = candidateCenter(
      model,
      cellDraw,
      xDraw,
      yDraw,
    )
    if (center === undefined) continue
    if (acceptanceDraw >= sampleEffectiveTone(model.source, center)) continue
    if (!centerIndex.isSeparated(center, markIndex)) continue

    const [start, end] = endpointsFor(
      center,
      previous.orientation,
      model.scales.stippleLength,
    )
    if (
      !isMaskPermittedStipple(
        model.source.shadingMask,
        model.frame,
        start,
        end,
        model.scales.maskCheckSpacing,
      )
    ) {
      continue
    }

    const replacement = Object.freeze({
      center: Object.freeze(center),
      orientation: previous.orientation,
    })
    const candidateMarks = [...currentMarks]
    candidateMarks[markIndex] = replacement
    const candidateError = model.distributionError(candidateMarks)
    if (!Number.isFinite(candidateError) || candidateError >= currentError) {
      continue
    }

    currentMarks = Object.freeze(candidateMarks)
    currentError = candidateError
    centerIndex.replace(markIndex, previous.center, replacement.center)
  }

  return Object.freeze({
    marks: currentMarks,
    error: currentError,
    attemptsUsed: attemptLimit,
    requestedRefinementReached: true,
  })
}
