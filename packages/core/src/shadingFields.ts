/**
 * Resolution-independent source fields for reusable shading strategies.
 *
 * Both fields sample points expressed directly in a Sketch's Composition Frame.
 * Producers therefore know nothing about output pixels, physical paper, tool
 * widths, or rendering APIs. Constructors wrap producer callbacks at the public
 * boundary so malformed scalar values cannot leak into consumers: finite values
 * are clamped to `[0, 1]`, non-finite values become the safe paper/forbidden
 * value `0`, and an authored exact zero remains exactly zero.
 *
 * The fields are separate contracts because desired darkness and permission are
 * independent inputs (ADR-0013). In particular, a soft mask value may attenuate
 * a target while an exact mask zero remains available as a hard prohibition for
 * later strategies.
 */

import type { Point } from './types'

/** A callback that analytically samples one Composition Frame point. */
export type ShadingFieldProducer = (point: Readonly<Point>) => number

/** Desired relative ink darkness: `0` is paper and `1` is maximum darkness. */
export interface ToneField {
  /** Runtime/type discriminant keeping tone and permission fields distinct. */
  readonly kind: 'tone-field'
  /** Sample a Composition Frame point, always yielding a finite value in `[0, 1]`. */
  sample(point: Readonly<Point>): number
}

/** Ink permission: `1` is fully permitted and exact `0` is strictly forbidden. */
export interface ShadingMask {
  /** Runtime/type discriminant keeping permission and tone fields distinct. */
  readonly kind: 'shading-mask'
  /** Sample a Composition Frame point, always yielding a finite value in `[0, 1]`. */
  sample(point: Readonly<Point>): number
}

/** The source-side inputs consumed together by a Shading Strategy. */
export interface ToneSource {
  readonly toneField: ToneField
  readonly shadingMask: ShadingMask
}

/**
 * Normalize an untrusted field sample to the shared scalar domain.
 *
 * Non-finite values use zero rather than treating positive infinity as maximum
 * tone/permission. This fail-closed behavior is deliberate: invalid source data
 * must not authorize ink. The explicit lower-bound branch also preserves exact
 * zero without replacing it with an epsilon.
 */
export function normalizeShadingSample(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/** Wrap an analytic darkness producer in the bounded public Tone Field contract. */
export function createToneField(producer: ShadingFieldProducer): ToneField {
  return Object.freeze({
    kind: 'tone-field' as const,
    sample(point: Readonly<Point>): number {
      return normalizeShadingSample(producer(point))
    },
  })
}

/** Wrap an analytic permission producer in the bounded public Shading Mask contract. */
export function createShadingMask(producer: ShadingFieldProducer): ShadingMask {
  return Object.freeze({
    kind: 'shading-mask' as const,
    sample(point: Readonly<Point>): number {
      return normalizeShadingSample(producer(point))
    },
  })
}

/** Defensively sample a Tone Field through the shared bounded-value rule. */
export function sampleToneField(field: ToneField, point: Readonly<Point>): number {
  return normalizeShadingSample(field.sample(point))
}

/** Defensively sample a Shading Mask through the shared bounded-value rule. */
export function sampleShadingMask(mask: ShadingMask, point: Readonly<Point>): number {
  return normalizeShadingSample(mask.sample(point))
}

/**
 * Sample the canonical target seen by a Shading Strategy or Tone reference.
 *
 * Effective tone is desired darkness multiplied by ink permission. Sampling both
 * operands through the public helpers keeps the result finite and bounded, while
 * an exact zero permission produces an exact zero result.
 */
export function sampleEffectiveTone(
  source: ToneSource,
  point: Readonly<Point>,
): number {
  return (
    sampleToneField(source.toneField, point) *
    sampleShadingMask(source.shadingMask, point)
  )
}
