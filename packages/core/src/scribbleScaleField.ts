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

function normalizeScaleSample(value: number, fineAnchor: number): number {
  if (!Number.isFinite(value) || value < fineAnchor) return fineAnchor
  return value
}

/**
 * Wrap a local-scale producer using one eagerly validated fine-detail anchor.
 *
 * Invalid points resolve to the anchor without invoking source work. Valid
 * finite samples are intentionally not capped: the field contract only guards
 * its safe lower bound.
 */
export function createScribbleScaleField(
  fineAnchor: number,
  producer: ScribbleScaleFieldProducer,
): ScribbleScaleField {
  assertFineAnchor(fineAnchor, 'createScribbleScaleField')

  return Object.freeze({
    kind: 'scribble-scale-field' as const,
    sample(point: Readonly<Point>): number {
      if (!isFinitePoint(point)) return fineAnchor
      return normalizeScaleSample(producer(point), fineAnchor)
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
  return normalizeScaleSample(field.sample(point), fineAnchor)
}
