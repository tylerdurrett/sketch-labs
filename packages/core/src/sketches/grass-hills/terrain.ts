import { fbm } from '../../fbm'
import { createRandom } from '../../random'
import type { Seed } from '../../sketch'

/** Parameters that shape the shared terrain field sampled by every ridge. */
export interface TerrainFieldOptions {
  /** Horizontal frequency across the canvas-normalized x axis. */
  ridgeScale: number
  /** Distance travelled through the field from the nearest to farthest ridge. */
  terrainDrift: number
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
 */
export function createTerrainField(
  seed: Seed,
  { ridgeScale, terrainDrift }: TerrainFieldOptions,
): TerrainField {
  const noise2D = createRandom(seed).noise2D

  return (normalizedX, normalizedDepth) => {
    const height = fbm(
      noise2D,
      normalizedX * ridgeScale,
      normalizedDepth * terrainDrift,
    )
    return Math.max(-1, Math.min(1, height))
  }
}
