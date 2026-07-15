import type { CoordinateSpace } from '../../scene'

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
    const depth = (hillCount - index) / (hillCount + 1)
    return { depth, baselineY: depthToY(depth, projection) }
  })
  const horizon = horizonY(projection)

  return baselines.map(({ depth, baselineY }, index) => {
    const upperBoundary = index === 0 ? horizon : baselines[index - 1]!.baselineY
    const lowerBoundary =
      index === baselines.length - 1
        ? projection.frame.height
        : baselines[index + 1]!.baselineY
    const lowerClearance = lowerBoundary - baselineY

    return {
      depth,
      baselineY,
      upperClearance: baselineY - upperBoundary,
      lowerClearance,
      localBandHeight: lowerClearance,
    }
  })
}
