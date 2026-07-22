import {
  sampleShadingMask,
  sampleToneField,
} from '../shadingFields'
import type { Point, Random } from '../types'
import { isMaskPermittedStipple } from './mask'
import type { StippleMark, StipplingModel } from './types'

const DEFAULT_ATTEMPTS_PER_TARGET = 80
const MINIMUM_DEFAULT_ATTEMPTS = 256
const MAXIMUM_PLACEMENT_ATTEMPTS = 1_000_000

/** Optional deterministic work bound for initial placement. */
export interface StipplingPlacementOptions {
  /** Inclusive candidate-attempt ceiling. Must be a safe integer in `[0, 1e6]`. */
  readonly maxAttempts?: number
}

/** Bounded result of one deterministic initial blue-noise placement pass. */
export interface StipplingPlacementOutcome {
  /** Accepted marks in their original seeded acceptance order. */
  readonly marks: readonly Readonly<StippleMark>[]
  /** Candidate attempts consumed, including rejected candidates. */
  readonly attemptsUsed: number
  /** Whether placement produced the model's complete requested count. */
  readonly requestedCountReached: boolean
}

function resolveAttemptLimit(
  targetCount: number,
  averageDemand: number,
  options: StipplingPlacementOptions,
): number {
  const requested = options.maxAttempts
  if (requested !== undefined) {
    if (
      !Number.isSafeInteger(requested) ||
      requested < 0 ||
      requested > MAXIMUM_PLACEMENT_ATTEMPTS
    ) {
      throw new RangeError(
        `maxAttempts must be a safe integer in [0, ${MAXIMUM_PLACEMENT_ATTEMPTS}], got ${requested}`,
      )
    }
    return requested
  }

  if (targetCount === 0) return 0
  // Target count already falls linearly with average demand, while uniform
  // darts are independently thinned by that same probability. Restore the
  // corresponding work here so soft permission changes abundance rather than
  // silently turning routine placement into budget exhaustion.
  const demandAdjustedAttempts =
    averageDemand > 0
      ? Math.ceil(
          (targetCount * DEFAULT_ATTEMPTS_PER_TARGET) / averageDemand,
        )
      : MAXIMUM_PLACEMENT_ATTEMPTS
  return Math.min(
    MAXIMUM_PLACEMENT_ATTEMPTS,
    Math.max(
      MINIMUM_DEFAULT_ATTEMPTS,
      demandAdjustedAttempts,
    ),
  )
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`
}

/** Incremental fixed-radius center index for exact nearby-distance checks. */
class StippleCenterIndex {
  private readonly cells = new Map<string, number[]>()
  private readonly centers: Readonly<Point>[] = []
  private readonly minimumDistanceSquared: number

  constructor(private readonly cellSize: number) {
    this.minimumDistanceSquared = cellSize * cellSize
  }

  isSeparated(center: Readonly<Point>): boolean {
    const cellX = Math.floor(center[0] / this.cellSize)
    const cellY = Math.floor(center[1] / this.cellSize)

    for (let y = cellY - 1; y <= cellY + 1; y++) {
      for (let x = cellX - 1; x <= cellX + 1; x++) {
        const bucket = this.cells.get(cellKey(x, y))
        if (bucket === undefined) continue
        for (const index of bucket) {
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

  add(center: Readonly<Point>): void {
    const index = this.centers.length
    this.centers.push(center)
    const cellX = Math.floor(center[0] / this.cellSize)
    const cellY = Math.floor(center[1] / this.cellSize)
    const key = cellKey(cellX, cellY)
    const bucket = this.cells.get(key)
    if (bucket === undefined) this.cells.set(key, [index])
    else bucket.push(index)
  }
}

function effectiveDemandAt(
  model: Readonly<StipplingModel>,
  point: Readonly<Point>,
): number {
  const permission = sampleShadingMask(model.source.shadingMask, point)
  if (permission === 0) return 0
  return sampleToneField(model.source.toneField, point) * permission
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
 * Place a deterministic permission- and tone-weighted blue-noise draft.
 *
 * Candidate centers are uniform darts whose acceptance probability is exactly
 * `tone * permission`. Accepted centers must satisfy the density-derived fixed
 * separation and their complete fixed-length Stipple must pass the declared
 * mask working resolution. All randomness advances the supplied mutable stream;
 * no fidelity-specific random stream is created here, so refinement can continue
 * from the exact state left by placement.
 */
export function placeInitialStipples(
  model: Readonly<StipplingModel>,
  rng: Random,
  options: StipplingPlacementOptions = {},
): Readonly<StipplingPlacementOutcome> {
  const { frame, scales } = model
  const attemptLimit = resolveAttemptLimit(
    scales.targetCount,
    model.lattice.averageDemand,
    options,
  )
  const centerIndex = new StippleCenterIndex(scales.minimumSpacing)
  const marks: Readonly<StippleMark>[] = []
  let attemptsUsed = 0

  while (
    attemptsUsed < attemptLimit &&
    marks.length < scales.targetCount
  ) {
    attemptsUsed++
    const center: Point = [
      rng.range(0, frame.width),
      rng.range(0, frame.height),
    ]
    const acceptance = rng.value()
    if (acceptance >= effectiveDemandAt(model, center)) continue
    if (!centerIndex.isSeparated(center)) continue

    const orientation = rng.range(0, Math.PI)
    const [start, end] = endpointsFor(
      center,
      orientation,
      scales.stippleLength,
    )
    if (
      !isMaskPermittedStipple(
        model.source.shadingMask,
        frame,
        start,
        end,
        scales.maskCheckSpacing,
      )
    ) {
      continue
    }

    const frozenCenter = Object.freeze(center)
    marks.push(Object.freeze({ center: frozenCenter, orientation }))
    centerIndex.add(frozenCenter)
  }

  return Object.freeze({
    marks: Object.freeze(marks),
    attemptsUsed,
    requestedCountReached: marks.length === scales.targetCount,
  })
}
