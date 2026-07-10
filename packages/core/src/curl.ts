import {
  fbm,
  prepareFbm3D,
  prepareFbm4D,
  type FbmOptions,
  type Noise2DFn,
  type Noise3DFn,
  type Noise4DFn,
} from './fbm'
import type { Random, Vec2 } from './types'

/** Tunables for {@link curl}. Extends {@link FbmOptions} with the finite-difference step. */
export interface CurlOptions extends FbmOptions {
  /**
   * Step used for the central finite-difference gradient of the fbm potential.
   * Smaller = more accurate but more sensitive to floating-point noise. The
   * default scales inversely with `scale` (the field's base frequency) so the
   * step stays small relative to the features it samples. Default `1e-4 / scale`.
   */
  epsilon?: number
}

/**
 * Resolve the finite-difference step. It defaults relative to `scale` so a
 * zoomed-in (large-scale) field still differentiates over a small fraction of a
 * feature. `scale` defaults to fbm's own default of 1.
 *
 * An explicit `epsilon` is honoured only when it is finite and nonzero; a
 * zero or non-finite (NaN/Infinity) value would collapse the central
 * finite-difference `/(2*eps)` into Infinity/NaN, so it degrades to the
 * scale-derived default step rather than throwing — mirroring the degenerate
 * `scale === 0` fallback below. A negative finite epsilon is returned as-is.
 */
function resolveEpsilon({ epsilon, scale = 1 }: CurlOptions): number {
  if (epsilon !== undefined && Number.isFinite(epsilon) && epsilon !== 0) return epsilon
  // Guard against a zero/degenerate scale collapsing the step to Infinity.
  return scale === 0 ? 1e-4 : 1e-4 / Math.abs(scale)
}

/** A prepared 3D curl field sampled directly as its in-plane angle. */
export type CurlAngle3DFn = (x: number, y: number, z: number) => number

/**
 * Prepare the fixed source/options of a 3D curl field for repeated angle samples.
 *
 * Leaf-like callers usually consume `curl(...)` only through
 * `atan2(flow[1], flow[0])`. Returning that angle directly avoids a Vec2 allocation
 * per sample, while the prepared fBm scalar retains the exact frequency,
 * amplitude, normalization, finite-difference, and `atan2` operation order of the
 * generic public path.
 */
export function prepareCurlAngle3D(
  source: Random | Noise3DFn,
  options: CurlOptions = {},
): CurlAngle3DFn {
  const psi = prepareFbm3D(source, options)
  const eps = resolveEpsilon(options)

  return (x, y, z) => {
    const dPsiDx = (psi(x + eps, y, z) - psi(x - eps, y, z)) / (2 * eps)
    const dPsiDy = (psi(x, y + eps, z) - psi(x, y - eps, z)) / (2 * eps)
    return Math.atan2(-dPsiDx, dPsiDy)
  }
}

/** A prepared 4D curl field sampled directly as its in-plane angle. */
export type CurlAngle4DFn = (x: number, y: number, z: number, w: number) => number

/**
 * Prepare a 4D curl field for repeated in-plane angle samples.
 *
 * Only x and y are offset for the central differences. The z/w coordinates are
 * held fixed, so callers can move them around a circle to obtain a seamless
 * loop without changing the divergence-free x/y construction.
 */
export function prepareCurlAngle4D(
  source: Random | Noise4DFn,
  options: CurlOptions = {},
): CurlAngle4DFn {
  const psi = prepareFbm4D(source, options)
  const eps = resolveEpsilon(options)

  return (x, y, z, w) => {
    const dPsiDx = (psi(x + eps, y, z, w) - psi(x - eps, y, z, w)) / (2 * eps)
    const dPsiDy = (psi(x, y + eps, z, w) - psi(x, y - eps, z, w)) / (2 * eps)
    return Math.atan2(-dPsiDx, dPsiDy)
  }
}

/**
 * Seeded 2D curl noise: a divergence-free vector field derived from the fbm
 * scalar potential ψ. In 2D the curl of a scalar potential is
 * `(∂ψ/∂y, −∂ψ/∂x)`, which is incompressible by construction (no sources or
 * sinks), giving the swirling, current-like flow that oriented elements follow.
 *
 * The gradient of ψ = {@link fbm} is taken by central finite difference, so the
 * whole field flows from the passed sampler — no `Math.random`, no clock reads —
 * and the same `(seed, coords, options)` always yields the same {@link Vec2}
 * (ADR-0002).
 *
 * @param source A {@link Random} instance or a bare 2D noise function, threaded
 *   into fbm.
 * @param x World x coordinate.
 * @param y World y coordinate.
 * @param options {@link CurlOptions} (fbm's octaves/lacunarity/gain/scale plus
 *   the finite-difference `epsilon`).
 * @returns A divergence-free velocity vector at `(x, y)`.
 */
export function curl(
  source: Random | Noise2DFn,
  x: number,
  y: number,
  options?: CurlOptions,
): Vec2
/**
 * Seeded 3D curl noise. Threading a `z` (e.g. time) animates the divergence-free
 * field while preserving determinism for any fixed `(seed, coords, options)`.
 *
 * The returned 2D vector is the curl in the x/y plane at the given `z` slice:
 * `(∂ψ/∂y, −∂ψ/∂x)` with ψ = {@link fbm}`(x, y, z)`. `z` is held fixed across the
 * finite-difference samples, so incompressibility in the plane is preserved.
 *
 * @param source A {@link Random} instance or a bare 3D noise function.
 * @param x World x coordinate.
 * @param y World y coordinate.
 * @param z World z coordinate (often time).
 * @param options {@link CurlOptions}.
 * @returns A divergence-free velocity vector in the x/y plane at slice `z`.
 */
export function curl(
  source: Random | Noise3DFn,
  x: number,
  y: number,
  z: number,
  options?: CurlOptions,
): Vec2
export function curl(
  source: Random | Noise2DFn | Noise3DFn,
  x: number,
  y: number,
  zOrOptions?: number | CurlOptions,
  maybeOptions?: CurlOptions,
): Vec2 {
  const is3D = typeof zOrOptions === 'number'
  const options = (is3D ? maybeOptions : (zOrOptions as CurlOptions | undefined)) ?? {}
  const eps = resolveEpsilon(options)

  // Sample ψ = fbm at an (x, y) offset. On the 3D path z is held fixed so the
  // gradient — and thus the curl — stays within the x/y plane.
  const psi = is3D
    ? (px: number, py: number): number =>
        fbm(source as Random | Noise3DFn, px, py, zOrOptions, options)
    : (px: number, py: number): number =>
        fbm(source as Random | Noise2DFn, px, py, options)

  // Central finite differences of the potential.
  const dPsiDx = (psi(x + eps, y) - psi(x - eps, y)) / (2 * eps)
  const dPsiDy = (psi(x, y + eps) - psi(x, y - eps)) / (2 * eps)

  // curl(ψ) = (∂ψ/∂y, −∂ψ/∂x)
  return [dPsiDy, -dPsiDx]
}
