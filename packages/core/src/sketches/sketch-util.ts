/**
 * Shared internal helpers every Sketch reaches for when baking its Scene: the
 * coordinate-space extent, the schema-default param lookup, and the axis-aligned
 * bounding box walk. Kept internal to `@harness/core` — NOT re-exported through
 * the public barrel — so Sketches share one implementation without widening the
 * package's surface.
 */

import type { NumberParamSpec, Params } from '../sketch'
import type { Point } from '../types'

/** Coordinate-space extent every Sketch bakes its Scene into (square, unitless). */
export const WIDTH = 1000
export const HEIGHT = 1000

/**
 * Read a numeric param value, falling back to the schema default when the caller
 * left the knob unset. `schema` is a frozen `NumberParamSpec` map, so the lookup
 * is typed by `keyof S` and the default is well-defined for every key. Keeps
 * `generate` total over partial `Params` — unset knobs resolve to their declared
 * default — without each Sketch re-implementing the fallback.
 */
export function numberParam<S extends Record<string, NumberParamSpec>>(
  params: Params,
  schema: S,
  key: keyof S,
): number {
  const value = params[key as string]
  if (typeof value === 'number') return value
  // `key: keyof S` is a real key of the frozen schema, so the spec is present;
  // the `!` narrows past `noUncheckedIndexedAccess`'s generic-index widening.
  return schema[key]!.default
}

/** Axis-aligned bounding box of a list of points. */
export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * Compute the axis-aligned bounding box of a list of points — the tightest
 * `[minX, maxX] × [minY, maxY]` rectangle containing every point. An empty
 * iterable yields the degenerate `Infinity`/`-Infinity` box.
 */
export function bbox(points: Iterable<Point>): BBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}
