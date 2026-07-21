import type { CoordinateSpace } from '../../scene'
import type { Point } from '../../types'

/**
 * Exhaustive reference work is intentionally limited to small deterministic
 * fixtures. Production-sized lattices must use the production spatial index.
 */
export const STIPPLING_VORONOI_REFERENCE_MAX_PAIR_CHECKS = 16_384

export interface StipplingVoronoiReferenceSample {
  readonly point: Readonly<Point>
  /** Effective demand (`tone * permission`) represented by this sample. */
  readonly weight: number
}

export interface StipplingVoronoiReferenceCell {
  /** The corresponding index in the caller's ordered sites. */
  readonly siteIndex: number
  readonly weight: number
  /** Weighted sample mean, or null when the cell has no positive demand. */
  readonly centroid: Readonly<Point> | null
}

export interface StipplingVoronoiReferenceResult {
  /** One site index per sample; zero-weight and unassignable samples are null. */
  readonly assignments: readonly (number | null)[]
  /** Cells remain in the caller's stable site order, including empty cells. */
  readonly cells: readonly StipplingVoronoiReferenceCell[]
  /** Sum of all positive input effective-demand weights. */
  readonly totalWeight: number
  /**
   * Mean demand-weighted squared site distance, divided by frame diagonal².
   * Empty demand and an empty site set both use the finite convention zero.
   */
  readonly normalizedObjective: number
}

interface MutableCell {
  weight: number
  centroidX: number
  centroidY: number
}

function validateFrame(frame: Readonly<CoordinateSpace>): number {
  if (
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    throw new RangeError(
      'Voronoi reference frame must have finite positive dimensions',
    )
  }
  return Math.max(frame.width, frame.height)
}

function validatePoint(
  point: Readonly<Point>,
  frame: Readonly<CoordinateSpace>,
  label: string,
): void {
  const [x, y] = point
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > frame.width ||
    y < 0 ||
    y > frame.height
  ) {
    throw new RangeError(`${label} must be a finite point inside the frame`)
  }
}

/**
 * Test-only weighted Voronoi oracle for small fixtures.
 *
 * Every positive-demand sample scans every ordered site. Equal squared
 * distances retain the lower site index. Centroids use an online weighted mean
 * to avoid overflowing at large finite frame scales. Distance arithmetic is
 * divided by a common frame scale before squaring; this preserves nearest-site
 * ordering while keeping the declared objective finite and invariant under
 * proportional frame scaling.
 */
export function stipplingVoronoiReference(
  frame: Readonly<CoordinateSpace>,
  sites: readonly Readonly<Point>[],
  samples: readonly Readonly<StipplingVoronoiReferenceSample>[],
): StipplingVoronoiReferenceResult {
  const frameScale = validateFrame(frame)
  const normalizedDiagonalSquared =
    (frame.width / frameScale) ** 2 + (frame.height / frameScale) ** 2

  for (let siteIndex = 0; siteIndex < sites.length; siteIndex++) {
    validatePoint(sites[siteIndex]!, frame, `Voronoi site ${siteIndex}`)
  }

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    const sample = samples[sampleIndex]!
    validatePoint(sample.point, frame, `Voronoi sample ${sampleIndex}`)
    if (
      !Number.isFinite(sample.weight) ||
      sample.weight < 0 ||
      sample.weight > 1
    ) {
      throw new RangeError(
        `Voronoi sample ${sampleIndex} weight must be finite and between 0 and 1`,
      )
    }
  }

  if (
    sites.length > 0 &&
    samples.length >
      Math.floor(STIPPLING_VORONOI_REFERENCE_MAX_PAIR_CHECKS / sites.length)
  ) {
    throw new RangeError(
      `Voronoi reference fixtures are limited to ${STIPPLING_VORONOI_REFERENCE_MAX_PAIR_CHECKS} site/sample pair checks`,
    )
  }

  const assignments: Array<number | null> = new Array(samples.length).fill(null)
  const mutableCells: MutableCell[] = sites.map(() => ({
    weight: 0,
    centroidX: 0,
    centroidY: 0,
  }))
  let totalWeight = 0
  let normalizedDistanceSum = 0

  if (sites.length > 0) {
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
      const sample = samples[sampleIndex]!
      if (sample.weight === 0) continue

      let nearestSiteIndex = 0
      let nearestDistanceSquared = Number.POSITIVE_INFINITY
      for (let siteIndex = 0; siteIndex < sites.length; siteIndex++) {
        const site = sites[siteIndex]!
        const dx = (sample.point[0] - site[0]) / frameScale
        const dy = (sample.point[1] - site[1]) / frameScale
        const distanceSquared = dx * dx + dy * dy
        if (distanceSquared < nearestDistanceSquared) {
          nearestDistanceSquared = distanceSquared
          nearestSiteIndex = siteIndex
        }
      }

      assignments[sampleIndex] = nearestSiteIndex
      totalWeight += sample.weight
      normalizedDistanceSum += sample.weight * nearestDistanceSquared

      const cell = mutableCells[nearestSiteIndex]!
      const nextWeight = cell.weight + sample.weight
      const interpolation = sample.weight / nextWeight
      cell.centroidX += (sample.point[0] - cell.centroidX) * interpolation
      cell.centroidY += (sample.point[1] - cell.centroidY) * interpolation
      cell.weight = nextWeight
    }
  } else {
    for (const sample of samples) totalWeight += sample.weight
  }

  const cells = mutableCells.map((cell, siteIndex) =>
    Object.freeze({
      siteIndex,
      weight: cell.weight,
      centroid:
        cell.weight === 0
          ? null
          : Object.freeze([cell.centroidX, cell.centroidY] as Point),
    }),
  )
  const normalizedObjective =
    totalWeight === 0 || sites.length === 0
      ? 0
      : normalizedDistanceSum / totalWeight / normalizedDiagonalSquared

  return Object.freeze({
    assignments: Object.freeze(assignments),
    cells: Object.freeze(cells),
    totalWeight,
    normalizedObjective,
  })
}
