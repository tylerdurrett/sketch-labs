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
 * plus the shared rim perturbation) — one mechanism, no second code path. The
 * multiplier stays strictly {@link VOID_RADIUS_MULTIPLIER} inside / 1 outside, so
 * it only ever RAISES the local Poisson spacing; the field minimum stays the
 * dense-outside base the sampler sizes its acceleration grid from.
 *
 * Falloff / rim-intrusion knobs and moving centers remain out of scope here.
 */

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
 * can ever satisfy the min-distance rule there — the field thins to zero. Outside
 * every region the multiplier is 1 (spacing unchanged).
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
   * organic rim (boundary inclusive). Drives the sampler's domain predicate so
   * no sample center lands inside a clearing.
   */
  insideAnyClearing(x: number, y: number): boolean
  /**
   * Spacing multiplier at `(x, y)`: {@link VOID_RADIUS_MULTIPLIER} inside any
   * clearing, 1 everywhere else — strictly two-valued, so it only ever raises
   * the base spacing.
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
 */
export function createNegativeSpaceField(
  noise2D: Noise2D,
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
   * Shared perturbed-boundary test: is `(x, y)` within any clearing's seeded
   * rim? Both public members read ONLY this, so the multiplier field and the
   * domain predicate are derived from a single source and cannot diverge.
   */
  function insidePerturbed(x: number, y: number): boolean {
    return NEGATIVE_SPACES.some((space) => {
      const dx = x - space.cx
      const dy = y - space.cy
      const theta = Math.atan2(dy, dx)
      const r = perturbedRadius(space, theta)
      return dx * dx + dy * dy <= r * r
    })
  }

  return {
    insideAnyClearing: insidePerturbed,
    radiusMultiplier: (x, y) =>
      insidePerturbed(x, y) ? VOID_RADIUS_MULTIPLIER : 1,
  }
}
