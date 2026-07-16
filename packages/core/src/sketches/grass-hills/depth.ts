import type { CoordinateSpace } from '../../scene'

const MIN_GRASS_SCALE = 0.2

/** The frame and knobs that define the grass-hills perspective projection. */
export interface HillDepthProjection {
  /** Only vertical extent participates; a full Composition Frame is accepted. */
  frame: Pick<CoordinateSpace, 'height'>
  /** Horizon y as a top-origin fraction of frame height. */
  horizonHeight: number
  /** Exponent applied to normalized horizon-to-bottom distance. */
  depthFalloff: number
}

/** Perspective information for one ridge band, ordered far-to-near. */
export interface HillBandDepth {
  /** Reduced rational identity for this canonical depth (for example, `3/4`). */
  hillKey: string
  /** Normalized depth: 0 is the foreground/bottom and 1 is the horizon. */
  depth: number
  /** Screen-space y coordinate of the ridge's unperturbed baseline. */
  baselineY: number
  /** Space from this baseline to the preceding baseline or horizon. */
  upperClearance: number
  /** Space from this baseline to the following baseline or frame bottom. */
  lowerClearance: number
  /** Nominal terrain scale for this band; equal to its lower clearance. */
  localBandHeight: number
}

/** Resolve the normalized, top-origin horizon knob into frame coordinates. */
export function horizonY({ frame, horizonHeight }: HillDepthProjection): number {
  return frame.height * horizonHeight
}

/**
 * Project normalized depth into screen y.
 *
 * Depth runs opposite screen y: 0 is the foreground at frame bottom and 1 is
 * the background at the horizon. Raising falloff above 1 compresses distant
 * ridge spacing while preserving both endpoints.
 */
export function depthToY(depth: number, projection: HillDepthProjection): number {
  const horizon = horizonY(projection)
  const span = projection.frame.height - horizon
  return horizon + span * (1 - depth) ** projection.depthFalloff
}

/** Invert {@link depthToY} for a screen-space y coordinate. */
export function yToDepth(y: number, projection: HillDepthProjection): number {
  const horizon = horizonY(projection)
  const normalizedY = (y - horizon) / (projection.frame.height - horizon)
  return 1 - normalizedY ** (1 / projection.depthFalloff)
}

/** Resolve a canonical depth into the continuous perspective scale for grass. */
export function grassScaleAtDepth(depth: number): number {
  const boundedDepth = clampFinite(depth, 0, 1)

  return MIN_GRASS_SCALE + (1 - MIN_GRASS_SCALE) * (1 - boundedDepth)
}

/** Resolve a screen-space root y into the continuous perspective scale for grass. */
export function grassScaleAtY(
  y: number,
  projection: HillDepthProjection,
): number {
  const horizon = horizonY(projection)
  const boundedY = clampFinite(y, horizon, projection.frame.height)

  return grassScaleAtDepth(yToDepth(boundedY, projection))
}

function clampFinite(value: number, min: number, max: number): number {
  return Number.isNaN(value) ? min : Math.max(min, Math.min(max, value))
}

function greatestCommonDivisor(a: number, b: number): number {
  while (b !== 0) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}

function hillKey(numerator: number, denominator: number): string {
  const divisor = greatestCommonDivisor(numerator, denominator)
  return `${numerator / divisor}/${denominator / divisor}`
}

/**
 * Place evenly sampled depth values strictly between horizon and foreground.
 *
 * The returned array is in painter-friendly far-to-near order. Clearances are
 * measured against adjacent baselines, with the horizon and frame bottom acting
 * as the outer neighbors. Ridge relief uses `localBandHeight`, deliberately the
 * lower clearance, so its amplitude contracts under the same perspective cue.
 */
export function layoutHillBands(
  hillCount: number,
  projection: HillDepthProjection,
): HillBandDepth[] {
  const baselines = Array.from({ length: hillCount }, (_, index) => {
    const numerator = hillCount - index
    const denominator = hillCount + 1
    const depth = numerator / denominator
    return {
      hillKey: hillKey(numerator, denominator),
      depth,
      baselineY: depthToY(depth, projection),
    }
  })
  const horizon = horizonY(projection)

  return baselines.map(({ hillKey, depth, baselineY }, index) => {
    const upperBoundary = index === 0 ? horizon : baselines[index - 1]!.baselineY
    const lowerBoundary =
      index === baselines.length - 1
        ? projection.frame.height
        : baselines[index + 1]!.baselineY
    const lowerClearance = lowerBoundary - baselineY

    return {
      hillKey,
      depth,
      baselineY,
      upperClearance: baselineY - upperBoundary,
      lowerClearance,
      localBandHeight: lowerClearance,
    }
  })
}
