import { fbm } from '../../fbm'
import { createRandom } from '../../random'
import type { Seed } from '../../sketch'

/** Parameters that shape the shared terrain field sampled by every ridge. */
export interface TerrainFieldOptions {
  /** Horizontal frequency across the canvas-normalized x axis. */
  ridgeScale: number
  /** Distance travelled through the field from the nearest to farthest ridge. */
  terrainDrift: number
  /** fBm octave count; defaults to the fbm module's own 4. */
  terrainOctaves?: number
  /** fBm per-octave gain; defaults to the fbm module's own 0.5. */
  terrainRoughness?: number
  /** Sign-preserving post-fBm power curve; the default 1 changes nothing. */
  terrainContrast?: number
  /** Blend toward the ridged fold `1 - 2|h|`; the default 0 skips the fold. */
  terrainSharpness?: number
}

/** A deterministic terrain-height sampler over canvas-normalized coordinates. */
export type TerrainField = (
  normalizedX: number,
  normalizedDepth: number,
) => number

/**
 * Prepare the seeded 2D fBm field shared by all grass-hills ridges.
 *
 * Callers supply canvas-normalized x and perspective-normalized depth. Depth is
 * scaled by `terrainDrift`, so zero samples one identical horizontal profile at
 * every ridge while larger values move consecutive ridges farther through the
 * same coherent field. Noise comes from `Random.noise2D`, whose stream is
 * independent of the sequential value/gaussian RNG used by sketch geometry.
 *
 * SHAPING: `terrainOctaves` and `terrainRoughness` pass straight through as
 * fbm octaves and gain, then two sketch-local steps reshape each sampled
 * height before the existing clamp: `terrainSharpness` blends toward the
 * ridged fold `1 - 2|h|` (creasing smooth rolls into sharp crests) and
 * `terrainContrast` applies a sign-preserving power curve (fixing 0 and ±1
 * while steepening or softening the relief between them). Lacunarity is
 * deliberately not exposed — it trades against `ridgeScale` almost
 * one-for-one here and would only dilute the knob set. Byte-identity at
 * defaults is structural, not coincidental: explicit `{octaves: 4, gain: 0.5}`
 * merges bit-identically with fbm's own defaults, and sharpness 0 / contrast 1
 * short-circuit past both shaping steps onto today's exact code path.
 */
export function createTerrainField(
  seed: Seed,
  {
    ridgeScale,
    terrainDrift,
    terrainOctaves = 4,
    terrainRoughness = 0.5,
    terrainContrast = 1,
    terrainSharpness = 0,
  }: TerrainFieldOptions,
): TerrainField {
  const noise2D = createRandom(seed).noise2D

  return (normalizedX, normalizedDepth) => {
    const height = fbm(
      noise2D,
      normalizedX * ridgeScale,
      normalizedDepth * terrainDrift,
      { octaves: terrainOctaves, gain: terrainRoughness },
    )
    const blended =
      terrainSharpness === 0
        ? height
        : height + terrainSharpness * (1 - 2 * Math.abs(height) - height)
    const shaped =
      terrainContrast === 1
        ? blended
        : Math.sign(blended) * Math.abs(blended) ** terrainContrast
    return Math.max(-1, Math.min(1, shaped))
  }
}
