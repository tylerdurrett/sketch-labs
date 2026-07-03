/**
 * The leaf-field's NEGATIVE SPACE — static, leaf-free "clearings" carved out of
 * the scatter so the field reads as figure-and-ground rather than an even wash.
 *
 * NAMING (ADR-0004): the canvas backdrop sense of "clear" (clearRect / the
 * paper fill) already owns that word, so this figure-ground sense is called
 * NEGATIVE SPACE at the module/type level to avoid the collision. The predicate
 * keeps the reader-facing name {@link NegativeSpaceField.insideAnyClearing} — a
 * clearing in the forest-floor sense — since that is how the field's holes are
 * described.
 *
 * SEEDED ORGANIC RIM (#132): a clearing's edge is no longer a hard circle. Each
 * region's effective radius is perturbed PER ANGLE by seeded simplex noise, so
 * the rim reads ragged / hand-cut (linocut idiom) rather than a perfect disc.
 * The noise is sampled ON A CIRCLE in noise space — `noise2D(offX + cos θ·freq,
 * offY + sin θ·freq)` — so θ and θ+2π map to the same coordinate and the rim
 * closes seamlessly; each clearing takes its own center as the noise-space
 * offset, so the two rims differ. The perturbation is STATIC (no clock / no t)
 * and a pure function of the noise field, which is itself a pure function of the
 * seed (ADR-0002) — bind it via {@link createNegativeSpaceField}.
 *
 * ONE MECHANISM: the field derives BOTH the radius multiplier and the
 * inside-predicate from the SAME perturbed-boundary test ({@link NEGATIVE_SPACES}
 * plus the shared rim perturbation) — one mechanism, no second code path.
 *
 * EDGE FALLOFF (#133): the multiplier is no longer a hard step. Just OUTSIDE the
 * rim it RAMPS from 1 up to {@link VOID_RADIUS_MULTIPLIER} across a falloff band
 * whose width `edgeFalloff` controls (a fraction of the clearing's base radius),
 * so density thins gradually approaching the rim and the void reads as a rounded,
 * spherical volume rather than a flat hole. At `edgeFalloff` 0 the band collapses
 * and the multiplier recovers the hard two-valued step (VOID inside / 1 outside).
 * The ramp NEVER drops below 1 (it only ramps 1 → VOID), so the multiplier only
 * ever RAISES the local Poisson spacing; the field minimum stays the
 * dense-outside base the sampler sizes its acceleration grid from.
 *
 * RIM INTRUSION (#133): `rimIntrusion` pulls the SAME boundary the predicate and
 * the multiplier are measured against INWARD by a fraction of the clearing's base
 * radius — one boundary ({@link signedClearance}'s effective rim), not a second
 * code path. Shrinking the exclusion boundary lets sample centers approach and
 * cross the perturbed rim so their tips break organically into the clearing
 * instead of stopping at a clean stamped edge; at `rimIntrusion` 0 the effective
 * rim is exactly the perturbed rim (the clean edge). It is pure geometry, adding
 * no rng draws.
 *
 * Moving centers remain out of scope here.
 */

import { lerp } from '../../math'
import { HEIGHT, WIDTH } from '../sketch-util'

/**
 * A seeded 2D noise sampler — the shape of {@link Random.noise2D}. Returns a
 * value in roughly [-1, 1] for any `(x, y)`; pass `createRandom(seed).noise2D`.
 */
export type Noise2D = (x: number, y: number) => number

/** A circular negative-space region in field space (the 1000×1000 canvas). */
export interface NegativeSpace {
  /** Center x in field space. */
  cx: number
  /** Center y in field space. */
  cy: number
  /** Base radius in field space; the seeded rim perturbs this per angle. */
  radius: number
}

/**
 * The static negative-space regions. Two clearings of differing size, placed off
 * the diagonal so the holes read as deliberate composition, not a centered
 * bullseye. Positions are fractions of the canvas extent so they track WIDTH /
 * HEIGHT. This is the SINGLE source of truth the perturbed-boundary test (and
 * hence both {@link NegativeSpaceField.insideAnyClearing} and
 * {@link NegativeSpaceField.radiusMultiplier}) reads from.
 */
export const NEGATIVE_SPACES: readonly NegativeSpace[] = [
  { cx: WIDTH * 0.34, cy: HEIGHT * 0.4, radius: Math.min(WIDTH, HEIGHT) * 0.18 },
  { cx: WIDTH * 0.7, cy: HEIGHT * 0.66, radius: Math.min(WIDTH, HEIGHT) * 0.11 },
]

/**
 * Radius multiplier applied INSIDE a negative space. Large enough that the local
 * Poisson spacing (base spacing × this) far exceeds the canvas, so no candidate
 * can ever satisfy the min-distance rule there — the field thins to zero. Beyond
 * the falloff band (see `edgeFalloff`) the multiplier is 1 (spacing unchanged);
 * within the band it ramps between 1 and this value.
 *
 * This ONLY ever raises the radius; the field minimum stays the dense-outside
 * base value, which the sampler relies on to size its acceleration grid.
 */
export const VOID_RADIUS_MULTIPLIER = 1000

/**
 * Angular frequency of the rim noise: the RADIUS of the circle traced through
 * noise space as θ sweeps 0→2π. Larger = more lobes / a wigglier rim; a low
 * value keeps the perturbation to a few broad, organic bulges rather than a
 * high-frequency crinkle.
 */
const RIM_NOISE_FREQUENCY = 1.6

/**
 * Rim perturbation amplitude as a FRACTION of a clearing's base radius. The
 * effective radius ranges over `radius · (1 ± RIM_NOISE_AMPLITUDE)` as the noise
 * swings across [-1, 1]; big enough to read as clearly non-circular, small
 * enough that the clearings keep their identity and don't collide.
 */
const RIM_NOISE_AMPLITUDE = 0.2

/**
 * The seeded negative-space field: the inside-predicate and the radius
 * multiplier, both derived from the SAME perturbed-boundary test so they can
 * never disagree (one mechanism, no second code path).
 */
export interface NegativeSpaceField {
  /**
   * True when `(x, y)` lies within any negative-space region under its seeded
   * organic rim, pulled inward by `rimIntrusion` (boundary inclusive). Drives the
   * sampler's domain predicate: no sample center lands inside the effective rim,
   * so with intrusion > 0 centers may sit between the effective and perturbed rims
   * and their leaf tips intrude into the clearing.
   */
  insideAnyClearing(x: number, y: number): boolean
  /**
   * Spacing multiplier at `(x, y)`: {@link VOID_RADIUS_MULTIPLIER} inside any
   * clearing, 1 beyond every clearing's falloff band, and a ramp between the two
   * within the band (see `edgeFalloff`). Always >= 1, so it only ever raises the
   * base spacing.
   */
  radiusMultiplier(x: number, y: number): number
}

/**
 * Build a {@link NegativeSpaceField} bound to a seeded 2D noise function. The
 * rim of every clearing is perturbed per angle by `noise2D` sampled on a circle
 * (seamless closure) offset by the clearing's own center (so rims differ). Pass
 * `createRandom(seed).noise2D` — the field is then a pure function of the seed
 * (ADR-0002); the same seed reproduces the same rims, a different seed reshapes
 * them.
 *
 * `edgeFalloff` (fraction of a clearing's base radius, >= 0) widens the band just
 * OUTSIDE the rim over which {@link NegativeSpaceField.radiusMultiplier} ramps
 * 1 → {@link VOID_RADIUS_MULTIPLIER}, feathering the void into a spherical volume;
 * 0 recovers the hard two-valued step. `rimIntrusion` (also a fraction of the base
 * radius, >= 0) pulls the effective exclusion rim INWARD so leaf centers may cross
 * the perturbed rim and their tips intrude into the clearing; 0 keeps the clean
 * edge. Both are pure geometric parameters — they add NO rng draws, so determinism
 * (ADR-0002) is untouched.
 */
export function createNegativeSpaceField(
  noise2D: Noise2D,
  edgeFalloff = 0,
  rimIntrusion = 0,
): NegativeSpaceField {
  /**
   * The seeded effective radius of `space` at angle `θ` (radians). Sampling
   * noise ON A CIRCLE means θ and θ+2π hit the same noise coordinate, so the
   * perturbed rim closes seamlessly; the clearing's center is the noise-space
   * offset, giving each region a distinct rim.
   */
  function perturbedRadius(space: NegativeSpace, theta: number): number {
    const n = noise2D(
      space.cx + Math.cos(theta) * RIM_NOISE_FREQUENCY,
      space.cy + Math.sin(theta) * RIM_NOISE_FREQUENCY,
    )
    return space.radius * (1 + RIM_NOISE_AMPLITUDE * n)
  }

  /**
   * Shared perturbed-boundary measure: the signed radial clearance of `(x, y)`
   * from `space`'s EFFECTIVE rim — the seeded perturbed rim pulled inward by
   * `rimIntrusion · base radius`. Negative inside the (intruded) clearing, 0 on
   * the effective rim, positive outside. Both public members derive from ONLY
   * this, so the multiplier field and the domain predicate read a single boundary
   * and cannot diverge (one mechanism, no second code path).
   */
  function signedClearance(space: NegativeSpace, x: number, y: number): number {
    const dx = x - space.cx
    const dy = y - space.cy
    const theta = Math.atan2(dy, dx)
    const effectiveRadius =
      perturbedRadius(space, theta) - rimIntrusion * space.radius
    return Math.hypot(dx, dy) - effectiveRadius
  }

  /**
   * The multiplier contribution of a single clearing at signed `clearance`:
   * {@link VOID_RADIUS_MULTIPLIER} inside (clearance <= 0), 1 beyond the falloff
   * band, and a linear ramp VOID → 1 across the band (width `edgeFalloff · base
   * radius`) in between. Stays >= 1 everywhere so the sampler's minRadius (pinned
   * to the dense-outside base) is never under-cut.
   */
  function falloffMultiplier(space: NegativeSpace, clearance: number): number {
    if (clearance <= 0) return VOID_RADIUS_MULTIPLIER
    const band = edgeFalloff * space.radius
    if (band <= 0 || clearance >= band) return 1
    return lerp(VOID_RADIUS_MULTIPLIER, 1, clearance / band)
  }

  return {
    insideAnyClearing: (x, y) =>
      NEGATIVE_SPACES.some((space) => signedClearance(space, x, y) <= 0),
    radiusMultiplier: (x, y) => {
      let multiplier = 1
      for (const space of NEGATIVE_SPACES) {
        multiplier = Math.max(
          multiplier,
          falloffMultiplier(space, signedClearance(space, x, y)),
        )
      }
      return multiplier
    },
  }
}
