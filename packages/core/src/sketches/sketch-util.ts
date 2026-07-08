/**
 * Shared internal helpers every Sketch reaches for when baking its Scene: the
 * coordinate-space extent, the schema-default param lookup, and the axis-aligned
 * bounding box walk. Kept internal to `@harness/core` — NOT re-exported through
 * the public barrel — so Sketches share one implementation without widening the
 * package's surface.
 */

import type { ColorParamSpec, NumberParamSpec, Params, ParamSpec } from '../sketch'
import type { Point } from '../types'

/** Coordinate-space extent every Sketch bakes its Scene into (square, unitless). */
export const WIDTH = 1000
export const HEIGHT = 1000

/**
 * The keys of a frozen schema `S` whose spec is the {@link ParamSpec} member
 * with discriminant `K` — the type-level filter behind {@link numberParam} /
 * {@link colorParam}.
 *
 * Since {@link ColorParamSpec} joined the union, a schema may MIX kinds (e.g.
 * leaf-field's numeric knobs plus its two color knobs), so a helper constrained
 * to `Record<string, NumberParamSpec>` would reject the whole schema. Instead
 * each helper takes any `Record<string, ParamSpec>` schema and narrows its `key`
 * to just the keys of the RIGHT kind: a mapped conditional keeps each matching
 * key and drops the rest to `never`, so e.g. `colorParam(params, schema,
 * 'density')` on leaf-field is a compile error while `'discColor'` is accepted.
 * A `satisfies`-frozen schema preserves each spec's literal `kind`, which is
 * what makes the filter precise.
 */
type KeysOfKind<
  S extends Record<string, ParamSpec>,
  K extends ParamSpec['kind'],
> = { [P in keyof S]: S[P] extends { kind: K } ? P : never }[keyof S]

/**
 * Read a numeric param value, falling back to the schema default when the caller
 * left the knob unset (or set it to a non-number). `schema` is a frozen
 * {@link ParamSpec} map and `key` is narrowed to its `kind: 'number'` keys (see
 * {@link KeysOfKind}), so the default is a well-defined number for every legal
 * key. Keeps `generate` total over partial `Params` — unset knobs resolve to
 * their declared default — without each Sketch re-implementing the fallback.
 */
export function numberParam<S extends Record<string, ParamSpec>>(
  params: Params,
  schema: S,
  key: KeysOfKind<S, 'number'>,
): number {
  const value = params[key as string]
  if (typeof value === 'number') return value
  // `key` is a real key of the frozen schema (the `!` narrows past
  // `noUncheckedIndexedAccess`'s generic-index widening), and `KeysOfKind`
  // guarantees its spec is the `kind: 'number'` member — TS cannot carry that
  // proof through the generic index, hence the assertion.
  return (schema[key]! as NumberParamSpec).default
}

/**
 * Read a color param value (a hex CSS color string, see {@link ColorParamSpec}),
 * falling back to the schema default when the caller left the knob unset (or set
 * it to a non-string) — the color sibling of {@link numberParam}, with `key`
 * narrowed to the schema's `kind: 'color'` keys the same way.
 */
export function colorParam<S extends Record<string, ParamSpec>>(
  params: Params,
  schema: S,
  key: KeysOfKind<S, 'color'>,
): string {
  const value = params[key as string]
  if (typeof value === 'string') return value
  // Same proof as numberParam's: the key exists and KeysOfKind pins its spec to
  // the `kind: 'color'` member.
  return (schema[key]! as ColorParamSpec).default
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
