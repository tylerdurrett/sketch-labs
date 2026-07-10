import type { Random } from './types'

/**
 * A bare 2D simplex noise function (e.g. `Random.noise2D`).
 * Expected to return values in roughly [-1, 1].
 */
export type Noise2DFn = (x: number, y: number) => number

/**
 * A bare 3D simplex noise function (e.g. `Random.noise3D`).
 * Expected to return values in roughly [-1, 1].
 */
export type Noise3DFn = (x: number, y: number, z: number) => number

/**
 * A bare 4D simplex noise function (e.g. `Random.noise4D`).
 * Expected to return values in roughly [-1, 1].
 */
export type Noise4DFn = (x: number, y: number, z: number, w: number) => number

/** Tunables for {@link fbm}. All optional — see defaults below. */
export interface FbmOptions {
  /** Number of noise layers summed together. More octaves = more fine detail. Default 4. */
  octaves?: number
  /** Per-octave frequency multiplier. Each octave samples `lacunarity`× finer. Default 2. */
  lacunarity?: number
  /** Per-octave amplitude multiplier. Each octave contributes `gain`× as much. Default 0.5. */
  gain?: number
  /** Frequency of the first (base) octave — a global zoom on the field. Default 1. */
  scale?: number
}

/** Resolved defaults for {@link FbmOptions}. */
const DEFAULTS: Required<FbmOptions> = {
  octaves: 4,
  lacunarity: 2,
  gain: 0.5,
  scale: 1,
}

/**
 * Sum a stack of octaves of the supplied simplex-noise sampler into a single
 * fractal-Brownian-motion value. Generic over the sample function so the 2D and
 * 3D paths share the octave loop.
 *
 * The result is normalized by the total amplitude across octaves, so it stays
 * within the sampler's own output range (roughly [-1, 1] for simplex noise)
 * regardless of octave count or gain.
 */
function accumulate(
  sample: (freq: number) => number,
  { octaves, lacunarity, gain, scale }: Required<FbmOptions>,
): number {
  let frequency = scale
  let amplitude = 1
  let sum = 0
  let totalAmplitude = 0

  for (let i = 0; i < octaves; i++) {
    sum += sample(frequency) * amplitude
    totalAmplitude += amplitude
    frequency *= lacunarity
    amplitude *= gain
  }

  // totalAmplitude is 0 only when octaves <= 0; return a flat field in that case.
  return totalAmplitude === 0 ? 0 : sum / totalAmplitude
}

/** Extract a 2D sampler from either a Random instance or a bare noise fn. */
function toNoise2D(source: Random | Noise2DFn): Noise2DFn {
  return typeof source === 'function' ? source : source.noise2D
}

/** Extract a 3D sampler from either a Random instance or a bare noise fn. */
function toNoise3D(source: Random | Noise3DFn): Noise3DFn {
  return typeof source === 'function' ? source : source.noise3D
}

/** Extract a 4D sampler from either a Random instance or a bare noise fn. */
function toNoise4D(source: Random | Noise4DFn): Noise4DFn {
  return typeof source === 'function' ? source : source.noise4D
}

/**
 * Prepare a 3D fBm sampler whose source and options stay fixed across samples.
 *
 * This is the scalar counterpart to caller-owned Sketch frame preparation: it
 * resolves the generic overload and option merge once, then preserves
 * {@link fbm}'s exact octave-loop operation order for every `(x, y, z)` sample.
 * The public one-shot {@link fbm} path remains unchanged.
 */
export function prepareFbm3D(
  source: Random | Noise3DFn,
  options: FbmOptions = {},
): Noise3DFn {
  const noise3D = toNoise3D(source)
  const { octaves, lacunarity, gain, scale } = { ...DEFAULTS, ...options }

  return (x, y, z) => {
    let frequency = scale
    let amplitude = 1
    let sum = 0
    let totalAmplitude = 0

    for (let i = 0; i < octaves; i++) {
      sum += noise3D(x * frequency, y * frequency, z * frequency) * amplitude
      totalAmplitude += amplitude
      frequency *= lacunarity
      amplitude *= gain
    }

    return totalAmplitude === 0 ? 0 : sum / totalAmplitude
  }
}

/**
 * Prepare a 4D fBm sampler whose source and options stay fixed across samples.
 *
 * This follows {@link prepareFbm3D}'s exact octave and normalization structure,
 * adding a fourth coordinate for callers that need a periodic path through a
 * higher-dimensional field.
 */
export function prepareFbm4D(
  source: Random | Noise4DFn,
  options: FbmOptions = {},
): Noise4DFn {
  const noise4D = toNoise4D(source)
  const { octaves, lacunarity, gain, scale } = { ...DEFAULTS, ...options }

  return (x, y, z, w) => {
    let frequency = scale
    let amplitude = 1
    let sum = 0
    let totalAmplitude = 0

    for (let i = 0; i < octaves; i++) {
      sum +=
        noise4D(
          x * frequency,
          y * frequency,
          z * frequency,
          w * frequency,
        ) * amplitude
      totalAmplitude += amplitude
      frequency *= lacunarity
      amplitude *= gain
    }

    return totalAmplitude === 0 ? 0 : sum / totalAmplitude
  }
}

/**
 * Seeded 2D fractal Brownian motion: octave-summed simplex noise.
 *
 * @param source A {@link Random} instance or a bare 2D noise function. All
 *   randomness flows from this sampler — no `Math.random`, no clock reads — so
 *   the same `(seed, coords, options)` always yields the same value (ADR-0002).
 * @param x World x coordinate.
 * @param y World y coordinate.
 * @param options {@link FbmOptions} (octaves, lacunarity, gain, scale).
 * @returns A coherent-but-turbulent scalar, normalized to roughly [-1, 1].
 */
export function fbm(
  source: Random | Noise2DFn,
  x: number,
  y: number,
  options?: FbmOptions,
): number
/**
 * Seeded 3D fractal Brownian motion. Threading a `z` (e.g. time) animates the
 * field while preserving determinism for any fixed `(seed, coords, options)`.
 *
 * @param source A {@link Random} instance or a bare 3D noise function.
 * @param x World x coordinate.
 * @param y World y coordinate.
 * @param z World z coordinate (often time).
 * @param options {@link FbmOptions} (octaves, lacunarity, gain, scale).
 * @returns A coherent-but-turbulent scalar, normalized to roughly [-1, 1].
 */
export function fbm(
  source: Random | Noise3DFn,
  x: number,
  y: number,
  z: number,
  options?: FbmOptions,
): number
export function fbm(
  source: Random | Noise2DFn | Noise3DFn,
  x: number,
  y: number,
  zOrOptions?: number | FbmOptions,
  maybeOptions?: FbmOptions,
): number {
  const is3D = typeof zOrOptions === 'number'
  const options = (is3D ? maybeOptions : (zOrOptions as FbmOptions | undefined)) ?? {}
  const resolved: Required<FbmOptions> = { ...DEFAULTS, ...options }

  if (is3D) {
    const z = zOrOptions
    const noise3D = toNoise3D(source as Random | Noise3DFn)
    return accumulate((freq) => noise3D(x * freq, y * freq, z * freq), resolved)
  }

  const noise2D = toNoise2D(source as Random | Noise2DFn)
  return accumulate((freq) => noise2D(x * freq, y * freq), resolved)
}
