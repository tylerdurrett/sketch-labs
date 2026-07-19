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

/**
 * The truthful reason a shading strategy stopped producing geometry.
 *
 * `completed` means the strategy satisfied its convergence condition,
 * `stopped-early` is an intentional authored partial result, and
 * `budget-exhausted` means a deterministic safety guard bounded the work.
 */
export type ShadingTermination =
  | 'completed'
  | 'stopped-early'
  | 'budget-exhausted'

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
