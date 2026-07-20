/**
 * Resolution-independent local scale for the Scribble Strategy.
 *
 * Values use the same dimensionless units as the authored `scribbleScale`
 * control. The authored scale is the fine-detail anchor: a field may broaden
 * geometry above it, but invalid or smaller samples resolve back to it.
 * Scribble Scale Fields are deliberately independent of tone and detail. A
 * caller may derive one from any source without coupling the strategy contract
 * to that source's meaning.
 */

import type { Point } from './types'

/** A callback that samples local Scribble scale at one Composition Frame point. */
export type ScribbleScaleFieldProducer = (
  point: Readonly<Point>,
) => number

/** Local characteristic scale consumed by the Scribble Strategy. */
export interface ScribbleScaleField {
  /** Runtime/type discriminant keeping local scale distinct from other fields. */
  readonly kind: 'scribble-scale-field'
  /** Optional finite upper bound in authored Scribble-scale units. */
  readonly maximumScale?: number
  /** Sample one Composition Frame point in authored Scribble-scale units. */
  sample(point: Readonly<Point>): number
}

function assertFineAnchor(fineAnchor: number, caller: string): void {
  if (!Number.isFinite(fineAnchor) || fineAnchor <= 0) {
    throw new Error(
      `${caller}: fine anchor must be finite and positive, got ${fineAnchor}`,
    )
  }
}

function isFinitePoint(point: Readonly<Point>): boolean {
  return (
    Array.isArray(point) &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1])
  )
}

function normalizeScaleSample(
  value: number,
  fineAnchor: number,
  maximumScale?: number,
): number {
  if (!Number.isFinite(value) || value < fineAnchor) return fineAnchor
  return maximumScale === undefined ? value : Math.min(value, maximumScale)
}

function normalizedMaximumScale(
  maximumScale: number | undefined,
  fineAnchor: number,
): number | undefined {
  return maximumScale !== undefined &&
    Number.isFinite(maximumScale) &&
    maximumScale >= fineAnchor
    ? maximumScale
    : undefined
}

/**
 * Wrap a local-scale producer using one eagerly validated fine-detail anchor
 * and, when supplied, an enforced finite upper bound.
 *
 * Invalid points resolve to the anchor without invoking source work. Fields
 * without a declared maximum retain the original uncapped behavior.
 */
export function createScribbleScaleField(
  fineAnchor: number,
  producer: ScribbleScaleFieldProducer,
  maximumScale?: number,
): ScribbleScaleField {
  assertFineAnchor(fineAnchor, 'createScribbleScaleField')
  if (
    maximumScale !== undefined &&
    normalizedMaximumScale(maximumScale, fineAnchor) === undefined
  ) {
    throw new Error(
      `createScribbleScaleField: maximum scale must be finite and at least the fine anchor, got ${maximumScale}`,
    )
  }

  return Object.freeze({
    kind: 'scribble-scale-field' as const,
    ...(maximumScale === undefined ? {} : { maximumScale }),
    sample(point: Readonly<Point>): number {
      if (!isFinitePoint(point)) return fineAnchor
      return normalizeScaleSample(producer(point), fineAnchor, maximumScale)
    },
  })
}

/**
 * Defensively sample a Scribble Scale Field against the caller's fine anchor.
 *
 * Revalidating here gives manually implemented fields the same boundary as
 * fields returned by {@link createScribbleScaleField}.
 */
export function sampleScribbleScaleField(
  field: ScribbleScaleField,
  point: Readonly<Point>,
  fineAnchor: number,
): number {
  assertFineAnchor(fineAnchor, 'sampleScribbleScaleField')
  if (!isFinitePoint(point)) return fineAnchor
  return normalizeScaleSample(
    field.sample(point),
    fineAnchor,
    normalizedMaximumScale(field.maximumScale, fineAnchor),
  )
}
