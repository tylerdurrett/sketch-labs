/**
 * Shared internal helpers every Sketch reaches for when baking its Scene: the
 * coordinate-space extent, the schema-default param lookup, and the axis-aligned
 * bounding box walk. Kept internal to `@harness/core` — NOT re-exported through
 * the public barrel — so Sketches share one implementation without widening the
 * package's surface.
 */

import type {
  ChoiceParamSpec,
  ColorParamSpec,
  ImageAssetParamSpec,
  NumberParamSpec,
  Params,
  ParamSpec,
} from '../sketch'
import {
  validateChoiceParamSpec,
  validateChoiceParamValue,
} from '../sketch'
import type { Point } from '../types'

// The fixed 1000×1000 WIDTH/HEIGHT extent was retired in issue #252: every Sketch
// now composes into the Composition Frame supplied to generate/prepare
// (`frame.width` / `frame.height`) rather than a self-owned constant, so no
// hardcoded normalization constant lives here anymore.

/**
 * The keys of a frozen schema `S` whose spec is the {@link ParamSpec} member
 * with discriminant `K` — the type-level filter behind {@link numberParam},
 * {@link colorParam}, {@link imageAssetParam}, and {@link choiceParam}.
 *
 * Since non-numeric members joined the union, a schema may MIX kinds (e.g.
 * numeric controls plus color and Image Asset selections), so a helper
 * constrained to `Record<string, NumberParamSpec>` would reject the whole
 * schema. Instead each helper takes any `Record<string, ParamSpec>` schema and
 * narrows its `key` to just the keys of the RIGHT kind: a mapped conditional
 * keeps each matching key and drops the rest to `never`, so e.g.
 * `colorParam(params, schema, 'density')` on leaf-field is a compile error while
 * `'discColor'` is accepted. A `satisfies`-frozen schema preserves each spec's
 * literal `kind`, which is what makes the filter precise.
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

/**
 * Read a stable Image Asset ID, falling back to the schema default when the
 * caller left the knob unset (or set it to a non-string). The ID is preserved as
 * authored: this helper neither resolves nor validates it, so an unavailable ID
 * cannot be silently replaced with different image bytes.
 */
export function imageAssetParam<S extends Record<string, ParamSpec>>(
  params: Params,
  schema: S,
  key: KeysOfKind<S, 'image-asset'>,
): string {
  const value = params[key as string]
  if (typeof value === 'string') return value
  return (schema[key]! as ImageAssetParamSpec).default
}

/** The exact declared string-value union of one Choice spec. */
type ChoiceValue<Spec> = Spec extends ChoiceParamSpec
  ? Spec['options'][number]['value']
  : never

/**
 * Read a Choice value while preserving the schema's exact declared value union.
 *
 * An absent key falls back to the validated schema default, matching the other
 * typed param helpers. A present value is different: it must be a declared
 * string value, so malformed authored or persisted state fails loudly instead
 * of silently selecting a different strategy.
 */
export function choiceParam<
  S extends Record<string, ParamSpec>,
  K extends KeysOfKind<S, 'choice'>,
>(params: Params, schema: S, key: K): ChoiceValue<S[K]> {
  const stringKey = key as string
  const spec = schema[key]! as ChoiceParamSpec

  if (!Object.prototype.hasOwnProperty.call(params, stringKey)) {
    validateChoiceParamSpec(spec, stringKey)
    return spec.default as ChoiceValue<S[K]>
  }

  const value = validateChoiceParamValue(spec, params[stringKey], stringKey)
  return value as ChoiceValue<S[K]>
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
