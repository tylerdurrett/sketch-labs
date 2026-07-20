/**
 * Resolution-independent local visual complexity over a Composition Frame.
 *
 * Detail is independent of tone and direction: `0` denotes a smooth area and
 * `1` denotes the strongest detail. Public sampling boundaries fail closed for
 * malformed points and scalar values so invalid analysis data cannot reach
 * consumers.
 */

import type { Point } from './types'

/** A callback that analytically samples local detail at one Composition Frame point. */
export type DetailFieldProducer = (point: Readonly<Point>) => number

/** Local visual complexity, bounded from smooth (`0`) to strongest detail (`1`). */
export interface DetailField {
  /** Runtime/type discriminant keeping detail independent from other scalar fields. */
  readonly kind: 'detail-field'
  /** Sample a Composition Frame point, always yielding a finite value in `[0, 1]`. */
  sample(point: Readonly<Point>): number
}

function isFinitePoint(point: unknown): point is Readonly<Point> {
  return (
    Array.isArray(point) &&
    point.length === 2 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1])
  )
}

function normalizeDetailSample(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/** Wrap an analytic producer in the finite, bounded Detail Field contract. */
export function createDetailField(producer: DetailFieldProducer): DetailField {
  return Object.freeze({
    kind: 'detail-field' as const,
    sample(point: Readonly<Point>): number {
      if (!isFinitePoint(point)) return 0
      return normalizeDetailSample(producer(point))
    },
  })
}

/** Defensively sample any Detail Field through the shared public invariants. */
export function sampleDetailField(
  field: DetailField,
  point: Readonly<Point>,
): number {
  if (!isFinitePoint(point)) return 0
  return normalizeDetailSample(field.sample(point))
}
