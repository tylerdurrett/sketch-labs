/** Internal fixed-band energy construction for image detail analysis. */

import {
  createScalarGrid,
  type AnalysisGrid,
  type ScalarGrid,
} from './grid'
import { gaussianSmooth, localStructureEnergy } from './scaleSpace'

interface EnergyBand {
  readonly innerSigma: number
  readonly outerSigma: number
  readonly aggregationSigma: number
  readonly weight: number
}

// These image-relative bands deliberately stop before broad illumination
// structure. They are analyzer policy, rather than authored controls.
const ENERGY_BANDS: readonly EnergyBand[] = Object.freeze([
  Object.freeze({
    innerSigma: 0.65,
    outerSigma: 1.3,
    aggregationSigma: 1,
    weight: 0.45,
  }),
  Object.freeze({
    innerSigma: 1.3,
    outerSigma: 2.6,
    aggregationSigma: 1.3,
    weight: 0.35,
  }),
  Object.freeze({
    innerSigma: 2.6,
    outerSigma: 5.2,
    aggregationSigma: 2.6,
    weight: 0.2,
  }),
])

const ALPHA_ENERGY_WEIGHT = 0.5

function sameDimensions(
  left: Readonly<ScalarGrid>,
  right: Readonly<ScalarGrid>,
): boolean {
  return left.width === right.width && left.height === right.height
}

function scaleNormalizedBand(
  grid: Readonly<ScalarGrid>,
  band: Readonly<EnergyBand>,
  smoothed: Map<number, ScalarGrid>,
): ScalarGrid | null {
  const smoothAt = (sigma: number): ScalarGrid | null => {
    const cached = smoothed.get(sigma)
    if (cached !== undefined) return cached
    const result = gaussianSmooth(grid, sigma)
    if (result !== null) smoothed.set(sigma, result)
    return result
  }
  const inner = smoothAt(band.innerSigma)
  const outer = smoothAt(band.outerSigma)
  if (inner === null || outer === null) return null

  // A first spatial derivative shrinks in proportion to scale. Multiplying
  // the band response by its inner sigma before taking gradients keeps a
  // comparable edge from disappearing merely because it lives in a wider
  // fixed band.
  const values = new Array<number>(inner.values.length)
  for (let index = 0; index < values.length; index += 1) {
    const value =
      (inner.values[index]! - outer.values[index]!) * band.innerSigma
    if (!Number.isFinite(value)) return null
    values[index] = value
  }
  return createScalarGrid(inner.width, inner.height, values)
}

function spatialEnergy(grid: Readonly<ScalarGrid>): ScalarGrid | null {
  let combined: number[] | null = null
  const smoothed = new Map<number, ScalarGrid>()

  for (const band of ENERGY_BANDS) {
    const response = scaleNormalizedBand(grid, band, smoothed)
    if (response === null) return null
    const energy = localStructureEnergy(response, band.aggregationSigma)
    if (energy === null) return null

    if (combined === null) {
      combined = new Array<number>(energy.values.length).fill(0)
    }
    for (let index = 0; index < combined.length; index += 1) {
      const value = combined[index]! + energy.values[index]! * band.weight
      if (!Number.isFinite(value)) return null
      combined[index] = value
    }
  }

  if (combined === null) return null
  return createScalarGrid(grid.width, grid.height, combined)
}

/**
 * Calculate unnormalized fine-to-medium detail energy.
 *
 * Luminance and alpha intentionally pass through the identical spatial
 * pipeline. Alpha then contributes with a fixed private weight, allowing
 * visible silhouettes to register without letting hidden RGB into the signal.
 * Noise-floor suppression and robust per-image normalization happen later.
 */
export function calculateDetailEnergy(
  analysis: Readonly<AnalysisGrid>,
): ScalarGrid | null {
  if (typeof analysis !== 'object' || analysis === null) return null

  const luminanceEnergy = spatialEnergy(analysis.luminance)
  const alphaEnergy = spatialEnergy(analysis.alpha)
  if (
    luminanceEnergy === null ||
    alphaEnergy === null ||
    !sameDimensions(luminanceEnergy, alphaEnergy)
  ) {
    return null
  }

  const values = new Array<number>(luminanceEnergy.values.length)
  for (let index = 0; index < values.length; index += 1) {
    const value =
      luminanceEnergy.values[index]! +
      alphaEnergy.values[index]! * ALPHA_ENERGY_WEIGHT
    if (!Number.isFinite(value) || value < 0) return null
    values[index] = value
  }
  return createScalarGrid(luminanceEnergy.width, luminanceEnergy.height, values)
}
