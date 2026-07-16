import { grassScaleAtDepth } from './depth'
import type { GrassRootCandidate } from './grass-scatter'

/** Adopted full-composition blade count from the issue-305 decision. */
export const ADOPTED_BLADE_COUNT = 10_000

/** Relative-density value that maps to the adopted blade count. */
export const ADOPTED_BLADE_DENSITY = 2

/** Public relative-density ceiling for higher-density exploration. */
export const MAX_BLADE_DENSITY = 10

/** Inputs that select one nested canonical prefix. */
export interface GrassRootSelectionOptions {
  /** Count already apportioned to this hill before terrain reprojection. */
  count: number
  /** The completed, deterministic canonical scatter for this hill. */
  candidates: readonly GrassRootCandidate[]
}

/** The perspective scale used for continuous depth weighting. */
export function canonicalScale(depth: number): number {
  return grassScaleAtDepth(depth)
}

/** Map the public relative scalar onto the adopted full-composition target. */
export function bladeCountForDensity(bladeDensity: number): number {
  if (
    !Number.isFinite(bladeDensity) ||
    bladeDensity < 0 ||
    bladeDensity > MAX_BLADE_DENSITY
  ) {
    throw new RangeError(
      `bladeDensity must be between 0 and ${MAX_BLADE_DENSITY}`,
    )
  }
  return Math.round(
    (bladeDensity / ADOPTED_BLADE_DENSITY) * ADOPTED_BLADE_COUNT,
  )
}

/**
 * Apportion the full-composition count by continuous inverse-scale-squared depth
 * weight.
 *
 * Sequential highest averages (D'Hondt) is deliberate. It emits an exact total
 * and is house-monotone: increasing density awards one additional root at a
 * time without taking roots away from another hill. Far-to-near input order is
 * the stable final tie-break.
 */
export function allocateGrassRootCounts(
  depths: readonly number[],
  bladeDensity: number,
): readonly number[] {
  const targetCount = bladeCountForDensity(bladeDensity)
  if (depths.length === 0 || targetCount === 0) {
    return Object.freeze(depths.map(() => 0))
  }

  const weights = depths.map((depth) => 1 / canonicalScale(depth) ** 2)
  const counts = depths.map(() => 0)

  for (let awarded = 0; awarded < targetCount; awarded++) {
    let winner = 0
    let bestQuotient = weights[0]! / (counts[0]! + 1)
    for (let index = 1; index < weights.length; index++) {
      const quotient = weights[index]! / (counts[index]! + 1)
      if (quotient > bestQuotient) {
        winner = index
        bestQuotient = quotient
      }
    }
    counts[winner] = counts[winner]! + 1
  }

  return Object.freeze(counts)
}

/** Select the already-prioritized prefix allocated to one hill. */
export function selectGrassRoots({
  count,
  candidates,
}: GrassRootSelectionOptions): readonly GrassRootCandidate[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError('root count must be a non-negative integer')
  }
  if (count > candidates.length) {
    throw new RangeError(
      `root count ${count} exceeds canonical capacity ${candidates.length}`,
    )
  }
  return Object.freeze(candidates.slice(0, count))
}
