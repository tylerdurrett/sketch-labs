import { clamp } from '../../math'
import type { HillBandDepth } from './depth'
import type { TerrainField } from './terrain'

/**
 * Survival probability for the grass-exclusion pass (treeline and slope).
 *
 * MODULE-PRIVATE: the grass-hills sketch consumes this module through a
 * relative import. It is intentionally absent from the package's public barrel.
 *
 * Composition compares each root's unconditional fifth roll against the
 * probability returned here, before painter sorting and foreground zoom.
 * Exclusion therefore only decides which blades appear; every survivor keeps
 * its exact descriptor, and the pass consumes no RNG of its own.
 *
 * ELEVATION is band-relative: `(baselineY - projectedY) / localBandHeight`,
 * the same unit ridge relief uses, so `treelineHeight` reads directly against
 * `ridgeAmplitude` at every depth.
 *
 * SLOPE is depth-invariant by construction: a central difference of the shared
 * terrain field along normalized x, scaled by `ridgeAmplitude` only — never by
 * the band's screen-space height. A hill shared across `hillCount` changes
 * keeps the same bare patches. RAMP CONSTANTS: the ramp is pinned to start at
 * slope 1 and saturate at 3 (band-relative rise per unit of normalized x). At
 * the default `ridgeAmplitude` 0.8, a typical four-octave fBm profile at
 * `ridgeScale` 3.5 swings its |dh/du| across roughly this range: below 1 reads
 * as gentle rolling grassland, past 3 as an escarpment face. `ridgeAmplitude`
 * scales the slope, so exaggerated relief bares its steep faces automatically.
 */

/** Grass-exclusion knobs shared by every hill band in one preparation. */
export interface GrassExclusionKnobs {
  /** Elevation (band-height fraction) where the treeline fade begins. */
  treelineHeight: number
  /** Elevation span of the treeline fade; zero yields a hard cut. */
  treelineFalloff: number
  /** Fraction of blades culled above the treeline; zero disables it. */
  treelineStrength: number
  /** Fraction of blades culled on steep slopes; zero disables it. */
  slopeBareness: number
}

/** Inputs for one hill band's survival-probability sampler. */
export interface GrassSurvivalOptions {
  /** The band whose roots are being scored. */
  band: Pick<HillBandDepth, 'baselineY' | 'localBandHeight' | 'depth'>
  /** Shared coherent terrain field sampled by every band. */
  terrainAt: TerrainField
  /** Nominal relief as a fraction of each band's local height. */
  ridgeAmplitude: number
  knobs: GrassExclusionKnobs
}

/** A per-band sampler of survival probability at one projected root. */
export type GrassSurvivalField = (u: number, projectedY: number) => number

/** Central-difference half-step in normalized x; well below one ridge sample. */
const SLOPE_EPSILON = 1 / 1024

/** Band-relative |dh/du| where slope bareness begins. */
const SLOPE_RAMP_START = 1

/** Band-relative |dh/du| where slope bareness saturates. */
const SLOPE_RAMP_END = 3

/**
 * Build the survival-probability sampler for one hill band.
 *
 * Each active term maps onto [0, 1] through its own ramp and scales survival
 * multiplicatively, so treeline and slope compose without ordering effects.
 * An inactive term (its strength knob at zero) is skipped structurally: the
 * elevation ramp is never evaluated without `treelineStrength`, and the two
 * epsilon-offset terrain samples are never paid without `slopeBareness`.
 */
export function createGrassSurvival({
  band,
  terrainAt,
  ridgeAmplitude,
  knobs,
}: GrassSurvivalOptions): GrassSurvivalField {
  const { treelineHeight, treelineFalloff, treelineStrength, slopeBareness } =
    knobs
  const treelineActive = treelineStrength > 0
  const slopeActive = slopeBareness > 0

  return (u, projectedY) => {
    let survival = 1

    if (treelineActive) {
      const elevation = (band.baselineY - projectedY) / band.localBandHeight
      const rampElevation =
        treelineFalloff <= 0
          ? elevation >= treelineHeight
            ? 1
            : 0
          : clamp((elevation - treelineHeight) / treelineFalloff, 0, 1)
      survival *= 1 - treelineStrength * rampElevation
    }

    if (slopeActive) {
      const slope =
        (ridgeAmplitude *
          Math.abs(
            terrainAt(u + SLOPE_EPSILON, band.depth) -
              terrainAt(u - SLOPE_EPSILON, band.depth),
          )) /
        (2 * SLOPE_EPSILON)
      const rampSlope = clamp(
        (slope - SLOPE_RAMP_START) / (SLOPE_RAMP_END - SLOPE_RAMP_START),
        0,
        1,
      )
      survival *= 1 - slopeBareness * rampSlope
    }

    return survival
  }
}
