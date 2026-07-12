/**
 * Pure Composition Frame → physical paper mapping for plot output.
 *
 * A Sketch authors geometry in a unitless {@link CoordinateSpace}. Plot export
 * keeps that source geometry untouched and applies this descriptor while
 * serializing it into the selected {@link PlotProfile}'s millimeter coordinate
 * system. The mapping is uniform and positions the frame inside the physical
 * drawable rectangle; it carries no rendering or SVG concerns of its own.
 */

import {
  plotDrawableAspectsEquivalent,
  plotDrawableRectangle,
  type PlotProfile,
} from './plotProfile'
import type { CoordinateSpace } from './scene'

/** A uniform Scene-space → paper-millimeter transform. */
export interface PlotMapping {
  /** Uniform millimeters per Scene coordinate unit. */
  scale: number
  /** Horizontal paper-space translation, in millimeters. */
  offsetX: number
  /** Vertical paper-space translation, in millimeters. */
  offsetY: number
}

/**
 * Compute the physical transform for a Composition Frame and Plot Profile.
 *
 * The frame and drawable rectangle must describe the same composition aspect.
 * Machine-scale quotient noise is accepted through
 * {@link plotDrawableAspectsEquivalent}; a material mismatch is rejected rather
 * than silently letterboxing geometry authored for another composition. The
 * minimum axis scale keeps the mapping numerically contain-safe, and any tiny
 * residual is split equally so the result remains centered within the drawable
 * rectangle.
 *
 * Neither input is mutated. The returned plain-data descriptor depends only on
 * its arguments and is safe for renderers to consume directly.
 */
export function computePlotMapping(
  space: CoordinateSpace,
  profile: PlotProfile,
): PlotMapping {
  // This is intentionally the validation boundary for the profile. Besides
  // deriving the target extent, it ensures invalid paper/insets fail with the
  // Plot Profile domain's own diagnostic.
  const drawable = plotDrawableRectangle(profile)

  if (!Number.isFinite(space.width) || space.width <= 0) {
    throw new Error(
      `computePlotMapping: space width must be a finite positive number, got ${space.width}`,
    )
  }
  if (!Number.isFinite(space.height) || space.height <= 0) {
    throw new Error(
      `computePlotMapping: space height must be a finite positive number, got ${space.height}`,
    )
  }

  const spaceAspect = space.width / space.height
  const drawableAspect = drawable.width / drawable.height
  if (!plotDrawableAspectsEquivalent(spaceAspect, drawableAspect)) {
    throw new Error(
      `computePlotMapping: Composition Frame aspect ${spaceAspect} does not match drawable aspect ${drawableAspect}`,
    )
  }

  const scale = Math.min(
    drawable.width / space.width,
    drawable.height / space.height,
  )
  const residualX = drawable.width - space.width * scale
  const residualY = drawable.height - space.height * scale

  return {
    scale,
    offsetX: profile.insets.left + residualX / 2,
    offsetY: profile.insets.top + residualY / 2,
  }
}
