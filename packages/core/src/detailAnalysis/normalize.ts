/** Internal robust normalization for image-detail energy. */

import { createScalarGrid, type ScalarGrid } from './grid'

// Energy at or below this absolute floor is attributable to quantization,
// resampling, or broad-ramp residuals rather than useful image structure.
const ABSOLUTE_ENERGY_FLOOR = 2e-5

// A lower-rank percentile deliberately excludes the upper tail. Unlike an
// interpolated quantile, it also remains robust when meaningful structure is
// sparse: two samples use the lower one, while one sample remains usable.
const ROBUST_CEILING_PERCENTILE = 0.95

function hasValidEnergyShape(grid: Readonly<ScalarGrid>): boolean {
  if (typeof grid !== 'object' || grid === null) return false
  if (
    !Number.isSafeInteger(grid.width) ||
    grid.width <= 0 ||
    !Number.isSafeInteger(grid.height) ||
    grid.height <= 0
  ) {
    return false
  }

  const length = grid.width * grid.height
  return (
    Number.isSafeInteger(length) &&
    typeof grid.values === 'object' &&
    grid.values !== null &&
    grid.values.length === length
  )
}

/**
 * Map absolute detail energy to a finite immutable `0..1` scalar grid.
 *
 * The absolute floor is applied before the relative mapping, so suppressed
 * energy is exactly zero. The lower-rank 95th percentile of the remaining
 * values supplies a deterministic per-image ceiling; values in its upper tail
 * clamp to one instead of flattening ordinary structure.
 */
export function normalizeDetailEnergy(
  energy: Readonly<ScalarGrid>,
): ScalarGrid | null {
  if (!hasValidEnergyShape(energy)) return null

  const meaningful: number[] = []
  for (let index = 0; index < energy.values.length; index += 1) {
    const value = energy.values[index]
    if (value === undefined || !Number.isFinite(value) || value < 0) {
      return null
    }
    if (value > ABSOLUTE_ENERGY_FLOOR) meaningful.push(value)
  }

  if (meaningful.length === 0) {
    return createScalarGrid(
      energy.width,
      energy.height,
      new Array<number>(energy.values.length).fill(0),
    )
  }

  meaningful.sort((left, right) => left - right)
  const ceilingIndex = Math.floor(
    (meaningful.length - 1) * ROBUST_CEILING_PERCENTILE,
  )
  const ceiling = meaningful[ceilingIndex]!
  const range = ceiling - ABSOLUTE_ENERGY_FLOOR
  if (!Number.isFinite(range) || range <= 0) return null

  const normalized = new Array<number>(energy.values.length)
  for (let index = 0; index < energy.values.length; index += 1) {
    const value = energy.values[index]!
    if (value <= ABSOLUTE_ENERGY_FLOOR) {
      normalized[index] = 0
    } else if (value >= ceiling) {
      normalized[index] = 1
    } else {
      normalized[index] = (value - ABSOLUTE_ENERGY_FLOOR) / range
    }
  }

  return createScalarGrid(energy.width, energy.height, normalized)
}
