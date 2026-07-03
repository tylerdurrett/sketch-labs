/**
 * The leaf-field's NEGATIVE SPACE — static, leaf-free "clearings" carved out of
 * the scatter so the field reads as figure-and-ground rather than an even wash.
 *
 * NAMING (ADR-0004): the canvas backdrop sense of "clear" (clearRect / the
 * paper fill) already owns that word, so this figure-ground sense is called
 * NEGATIVE SPACE at the module/type level to avoid the collision. The predicate
 * keeps the reader-facing name {@link insideAnyClearing} — a clearing in the
 * forest-floor sense — since that is how the field's holes are described.
 *
 * This module is PURE GEOMETRY of its params: static positions, no RNG, no
 * clock. It exposes exactly one set of region definitions ({@link NEGATIVE_SPACES})
 * and derives BOTH the radius multiplier and the inside-predicate from it — one
 * mechanism, no second code path. Live/organic knobs (moving centers, soft rims,
 * falloff) are out of scope here and land in a later task (#133); today the edge
 * is a hard circle.
 */

import { HEIGHT, WIDTH } from '../sketch-util'

/** A circular negative-space region in field space (the 1000×1000 canvas). */
export interface NegativeSpace {
  /** Center x in field space. */
  cx: number
  /** Center y in field space. */
  cy: number
  /** Hard-edge radius in field space; inside it the field is thinned to zero. */
  radius: number
}

/**
 * The static negative-space regions. Two clearings of differing size, placed off
 * the diagonal so the holes read as deliberate composition, not a centered
 * bullseye. Positions are fractions of the canvas extent so they track WIDTH /
 * HEIGHT. This is the SINGLE source of truth both {@link insideAnyClearing} and
 * {@link radiusMultiplier} read from.
 */
export const NEGATIVE_SPACES: readonly NegativeSpace[] = [
  { cx: WIDTH * 0.34, cy: HEIGHT * 0.4, radius: Math.min(WIDTH, HEIGHT) * 0.18 },
  { cx: WIDTH * 0.7, cy: HEIGHT * 0.66, radius: Math.min(WIDTH, HEIGHT) * 0.11 },
]

/**
 * Radius multiplier applied INSIDE a negative space. Large enough that the local
 * Poisson spacing (base spacing × this) far exceeds the canvas, so no candidate
 * can ever satisfy the min-distance rule there — the field thins to zero. Outside
 * every region the multiplier is 1 (spacing unchanged).
 *
 * This ONLY ever raises the radius; the field minimum stays the dense-outside
 * base value, which the sampler relies on to size its acceleration grid.
 */
export const VOID_RADIUS_MULTIPLIER = 1000

/**
 * True when `(x, y)` lies within any negative-space region (hard circular edge,
 * boundary inclusive). Drives the sampler's domain predicate so no sample center
 * lands inside a clearing.
 */
export function insideAnyClearing(x: number, y: number): boolean {
  return NEGATIVE_SPACES.some((space) => {
    const dx = x - space.cx
    const dy = y - space.cy
    return dx * dx + dy * dy <= space.radius * space.radius
  })
}

/**
 * Spacing multiplier at `(x, y)`: {@link VOID_RADIUS_MULTIPLIER} inside any
 * clearing, 1 everywhere else. Derived from the SAME regions as
 * {@link insideAnyClearing}, so the multiplier field and the domain predicate can
 * never disagree.
 */
export function radiusMultiplier(x: number, y: number): number {
  return insideAnyClearing(x, y) ? VOID_RADIUS_MULTIPLIER : 1
}
