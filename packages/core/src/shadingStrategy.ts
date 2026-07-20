/**
 * Minimal execution boundary shared by reusable shading strategies.
 *
 * A strategy receives only the authored tonal source, Composition Frame,
 * strategy-specific controls, and explicit Seed. Output-profile, physical-tool,
 * renderer, and clock concerns deliberately stay outside this contract.
 */

import type { CoordinateSpace } from './scene'
import type { ToneSource } from './shadingFields'
import type { Seed } from './sketch'
import type { Polyline } from './types'

/** The truthful reason a shading strategy stopped producing geometry. */
export type ShadingTermination =
  | 'completed'
  | 'stopped-early'
  | 'budget-exhausted'

/** Immutable, serialization-friendly progress from one Shading preparation. */
export interface ShadingProgress {
  /** Completed strategy work units, whether productive or stagnant. */
  readonly completedWorkUnits: number
  /** Stable upper bound for the strategy's current preparation pass. */
  readonly totalWorkUnits: number
  /**
   * Normalized progress toward the strategy's authored completion target.
   * Optional because not every strategy has a meaningful convergence measure.
   */
  readonly convergence?: number
  /** True only when the strategy has stopped. */
  readonly terminal: boolean
}

/** Optional observation hook for deterministic Shading progress snapshots. */
export type ShadingObserver = (progress: ShadingProgress) => void

/** Geometry and stop condition produced by a shading strategy. */
export interface ShadingResult {
  readonly polylines: Polyline[]
  readonly termination: ShadingTermination
}

/** The complete, intentionally narrow input to a shading strategy. */
export interface ShadingStrategyInput<Controls> {
  readonly source: ToneSource
  readonly frame: CoordinateSpace
  readonly controls: Controls
  readonly seed: Seed
}

/** A deterministic geometry generator for one strategy-specific control set. */
export type ShadingStrategy<Controls> = (
  input: ShadingStrategyInput<Controls>,
) => ShadingResult

/** Sum the Euclidean lengths of every consecutive segment in every polyline. */
export function totalPathLength(polylines: readonly Polyline[]): number {
  let total = 0

  for (const polyline of polylines) {
    for (let i = 1; i < polyline.length; i++) {
      const previous = polyline[i - 1]!
      const current = polyline[i]!
      total += Math.hypot(current[0] - previous[0], current[1] - previous[1])
    }
  }

  return total
}

/** Count emitted polylines independently of their point or segment counts. */
export function polylineCount(polylines: readonly Polyline[]): number {
  return polylines.length
}

/** Count pen lifts required between consecutive emitted polylines. */
export function penLiftCount(polylines: readonly Polyline[]): number {
  return Math.max(0, polylines.length - 1)
}
