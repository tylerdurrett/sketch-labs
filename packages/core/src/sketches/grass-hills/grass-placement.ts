import type { CoordinateSpace, Primitive } from '../../scene'
import type { Point } from '../../types'
import {
  grassScaleAtY,
  type HillBandDepth,
  type HillDepthProjection,
} from './depth'

/** Number of equal y intervals used by the deterministic density CDF. */
const CDF_STEPS = 64
const COLLAPSE_EPSILON = 1e-12

/** A ridge ring, as emitted by {@link buildRidgeBands}. */
export type RidgeProfile = Pick<Primitive, 'points'>

/** The canonical part of a seeded grass-root descriptor. */
export interface CanonicalGrassRoot {
  /** Horizontal position in the hill-local unit square. */
  readonly u: number
  /** Density quantile in the hill-local unit square. */
  readonly v: number
}

/** Physical root limits at one screen-space x coordinate. */
export interface GrassRootBounds {
  /** The hill's own visible ridgeline. */
  readonly upperY: number
  /** The deepest root that can remain visible or reach above nearer terrain. */
  readonly lowerY: number
}

/** Inputs used to construct one hill's physical grass mask. */
export interface GrassHillMaskOptions {
  frame: CoordinateSpace
  projection: HillDepthProjection
  band: Pick<HillBandDepth, 'lowerClearance'>
  ridge: RidgeProfile
  /** Omitted for the nearest hill, whose lower boundary is the frame bottom. */
  nextNearerRidge?: RidgeProfile
  /** Maximum already-clamped blade length before perspective scaling. */
  maxUnscaledBladeLength: number
}

/** A count-dependent terrain mask onto which canonical roots are projected. */
export interface GrassHillMask {
  readonly frame: CoordinateSpace
  readonly projection: HillDepthProjection
  boundsAtX(x: number): GrassRootBounds
}

function isSamePoint(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

/**
 * Return only the monotonic ridgeline prefix of a filled ridge ring.
 *
 * Ridge rings append right-bottom, left-bottom, and a repeated first point.
 * Those three fill-closure points must never participate in interpolation.
 */
function ridgelinePoints(ridge: RidgeProfile): readonly Point[] {
  const points = ridge.points
  if (points.length >= 5) {
    const first = points[0]!
    const repeatedFirst = points.at(-1)!
    const rightBottom = points.at(-3)!
    const leftBottom = points.at(-2)!
    const lastRidgePoint = points.at(-4)!
    if (
      isSamePoint(first, repeatedFirst) &&
      rightBottom[0] === lastRidgePoint[0] &&
      leftBottom[0] === first[0] &&
      rightBottom[1] === leftBottom[1]
    ) {
      return points.slice(0, -3)
    }
  }
  return points
}

/** Interpolate the actual sampled ridgeline at a screen-space x coordinate. */
export function ridgelineYAtX(ridge: RidgeProfile, x: number): number {
  const points = ridgelinePoints(ridge)
  if (points.length === 0) return 0
  if (points.length === 1) return finiteOr(points[0]![1], 0)

  const first = points[0]!
  const last = points.at(-1)!
  const boundedX = clampFinite(x, first[0], last[0])
  if (boundedX <= first[0]) return finiteOr(first[1], 0)
  if (boundedX >= last[0]) return finiteOr(last[1], first[1])

  let low = 0
  let high = points.length - 1
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (points[middle]![0] <= boundedX) low = middle
    else high = middle
  }

  const start = points[low]!
  const end = points[high]!
  const width = end[0] - start[0]
  if (!(width > COLLAPSE_EPSILON)) return finiteOr(start[1], 0)
  const t = (boundedX - start[0]) / width
  return finiteOr(start[1] + (end[1] - start[1]) * t, start[1])
}

/**
 * Build the physical root mask for one hill.
 *
 * A non-nearest mask extends behind the next ridge by at most one maximum
 * perspective-scaled blade length, so potentially visible tips are retained.
 * The extension is bounded by the band's nominal lower clearance. Relief can
 * make ridges cross or leave the frame; clipping and a final ordered clamp turn
 * those cases into finite, possibly collapsed, domains.
 */
export function createGrassHillMask({
  frame,
  projection,
  band,
  ridge,
  nextNearerRidge,
  maxUnscaledBladeLength,
}: GrassHillMaskOptions): GrassHillMask {
  const frameHeight = Math.max(0, finiteOr(frame.height, 0))
  const frameWidth = Math.max(0, finiteOr(frame.width, 0))
  const safeFrame = { width: frameWidth, height: frameHeight }
  const maxLength = Math.max(0, finiteOr(maxUnscaledBladeLength, 0))
  const clearance = Math.max(0, finiteOr(band.lowerClearance, 0))

  return {
    frame: safeFrame,
    projection,
    boundsAtX(x) {
      const boundedX = clampFinite(x, 0, frameWidth)
      const upperY = clampFinite(ridgelineYAtX(ridge, boundedX), 0, frameHeight)
      if (nextNearerRidge === undefined) {
        return { upperY, lowerY: frameHeight }
      }

      const nearerY = ridgelineYAtX(nextNearerRidge, boundedX)
      const actualScale = clampFinite(grassScaleAtY(nearerY, projection), 0.2, 1)
      const margin = Math.min(clearance, maxLength * actualScale)
      const reachableLowerY = finiteOr(nearerY + margin, nearerY)
      const lowerY = clampFinite(reachableLowerY, upperY, frameHeight)
      return { upperY, lowerY }
    },
  }
}

/**
 * Map a canonical root onto its count-dependent physical hill mask.
 *
 * The vertical inverse CDF weights physical area by `1 / scale²`. Uniform
 * canonical candidates therefore become denser where perspective makes blades
 * smaller. Sixty-four trapezoids (65 scale evaluations) are pinned so identical
 * inputs remain byte-deterministic across composition and test paths.
 */
export function projectGrassRoot(
  root: CanonicalGrassRoot,
  mask: GrassHillMask,
): Point {
  const u = clampFinite(root.u, 0, 1)
  const x = u * mask.frame.width
  const { upperY, lowerY } = mask.boundsAtX(x)
  return [
    x,
    projectDensityQuantile(root.v, upperY, lowerY, mask.projection),
  ]
}

/** Project one vertical density quantile inside an already-resolved mask. */
export function projectDensityQuantile(
  v: number,
  upperY: number,
  lowerY: number,
  projection: HillDepthProjection,
): number {
  const upper = finiteOr(upperY, 0)
  const lower = Math.max(upper, finiteOr(lowerY, upper))
  const quantile = clampFinite(v, 0, 1)
  if (quantile === 0 || lower - upper <= COLLAPSE_EPSILON) return upper
  if (quantile === 1) return lower

  const cellHeight = (lower - upper) / CDF_STEPS
  const cumulative = new Array<number>(CDF_STEPS + 1)
  cumulative[0] = 0

  let previousWeight = densityWeightAtY(upper, projection)
  for (let node = 1; node <= CDF_STEPS; node++) {
    const y = upper + cellHeight * node
    const weight = densityWeightAtY(y, projection)
    cumulative[node] =
      cumulative[node - 1]! +
      ((previousWeight + weight) * cellHeight) / 2
    previousWeight = weight
  }

  const total = cumulative[CDF_STEPS]!
  if (!(total > COLLAPSE_EPSILON) || !Number.isFinite(total)) return upper
  const target = quantile * total

  let low = 0
  let high = CDF_STEPS
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (cumulative[middle]! < target) low = middle
    else high = middle
  }

  const intervalArea = cumulative[high]! - cumulative[low]!
  if (!(intervalArea > COLLAPSE_EPSILON)) return upper + cellHeight * low
  const fraction = (target - cumulative[low]!) / intervalArea
  return upper + cellHeight * (low + fraction)
}

function densityWeightAtY(y: number, projection: HillDepthProjection): number {
  const actualScale = clampFinite(grassScaleAtY(y, projection), 0.2, 1)
  return 1 / (actualScale * actualScale)
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function clampFinite(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    if (value === Number.POSITIVE_INFINITY) return max
    return min
  }
  return Math.max(min, Math.min(max, value))
}
