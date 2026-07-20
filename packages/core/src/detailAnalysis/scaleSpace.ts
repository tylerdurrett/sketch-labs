/** Internal deterministic scalar scale-space operations for image detail. */

import { createScalarGrid, type ScalarGrid } from './grid'

const GAUSSIAN_TRUNCATION_SIGMAS = 3
const MAX_GAUSSIAN_RADIUS = 128
const SCHARR_AXIS_WEIGHT = 10
const SCHARR_DIAGONAL_WEIGHT = 3
const SCHARR_NORMALIZATION = 32

function isValidScalarGrid(grid: Readonly<ScalarGrid>): boolean {
  if (
    typeof grid !== 'object' ||
    grid === null ||
    !Number.isSafeInteger(grid.width) ||
    grid.width <= 0 ||
    !Number.isSafeInteger(grid.height) ||
    grid.height <= 0 ||
    !Number.isSafeInteger(grid.width * grid.height) ||
    typeof grid.values !== 'object' ||
    grid.values === null ||
    grid.values.length !== grid.width * grid.height
  ) {
    return false
  }

  for (const value of grid.values) {
    if (!Number.isFinite(value)) return false
  }
  return true
}

/** Half-sample symmetric reflection: -1 -> 0 and length -> length - 1. */
function reflectIndex(index: number, length: number): number {
  if (length === 1) return 0
  const period = length * 2
  const wrapped = ((index % period) + period) % period
  return wrapped < length ? wrapped : period - wrapped - 1
}

function gaussianKernel(sigma: number): readonly number[] | null {
  if (!Number.isFinite(sigma) || sigma <= 0) return null
  const radius = Math.ceil(sigma * GAUSSIAN_TRUNCATION_SIGMAS)
  if (!Number.isSafeInteger(radius) || radius > MAX_GAUSSIAN_RADIUS) {
    return null
  }

  const weights = new Array<number>(radius * 2 + 1)
  let total = 0
  for (let offset = -radius; offset <= radius; offset += 1) {
    const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma))
    weights[offset + radius] = weight
    total += weight
  }
  for (let index = 0; index < weights.length; index += 1) {
    weights[index] = weights[index]! / total
  }
  return weights
}

/** Separable Gaussian convolution with deterministic reflected borders. */
export function gaussianSmooth(
  grid: Readonly<ScalarGrid>,
  sigma: number,
): ScalarGrid | null {
  if (!isValidScalarGrid(grid)) return null
  const kernel = gaussianKernel(sigma)
  if (kernel === null) return null
  const radius = (kernel.length - 1) / 2
  const horizontal = new Array<number>(grid.values.length)
  const output = new Array<number>(grid.values.length)

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      let sum = 0
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sourceX = reflectIndex(x + offset, grid.width)
        sum +=
          grid.values[y * grid.width + sourceX]! * kernel[offset + radius]!
      }
      horizontal[y * grid.width + x] = sum
    }
  }

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      let sum = 0
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sourceY = reflectIndex(y + offset, grid.height)
        sum +=
          horizontal[sourceY * grid.width + x]! * kernel[offset + radius]!
      }
      output[y * grid.width + x] = sum
    }
  }

  return createScalarGrid(grid.width, grid.height, output)
}

function scalarAt(grid: Readonly<ScalarGrid>, x: number, y: number): number {
  const reflectedX = reflectIndex(x, grid.width)
  const reflectedY = reflectIndex(y, grid.height)
  return grid.values[reflectedY * grid.width + reflectedX]!
}

function scharrEnergyAt(
  grid: Readonly<ScalarGrid>,
  x: number,
  y: number,
): number {
  const upperLeft = scalarAt(grid, x - 1, y - 1)
  const upperRight = scalarAt(grid, x + 1, y - 1)
  const middleLeft = scalarAt(grid, x - 1, y)
  const middleRight = scalarAt(grid, x + 1, y)
  const lowerLeft = scalarAt(grid, x - 1, y + 1)
  const lowerRight = scalarAt(grid, x + 1, y + 1)
  const upperMiddle = scalarAt(grid, x, y - 1)
  const lowerMiddle = scalarAt(grid, x, y + 1)

  const gradientX =
    (SCHARR_DIAGONAL_WEIGHT * (upperRight - upperLeft) +
      SCHARR_AXIS_WEIGHT * (middleRight - middleLeft) +
      SCHARR_DIAGONAL_WEIGHT * (lowerRight - lowerLeft)) /
    SCHARR_NORMALIZATION
  const gradientY =
    (SCHARR_DIAGONAL_WEIGHT * (lowerLeft - upperLeft) +
      SCHARR_AXIS_WEIGHT * (lowerMiddle - upperMiddle) +
      SCHARR_DIAGONAL_WEIGHT * (lowerRight - upperRight)) /
    SCHARR_NORMALIZATION
  return gradientX * gradientX + gradientY * gradientY
}

/**
 * Locally aggregate the trace of the gradient structure tensor.
 *
 * Only the rotationally stable scalar energy leaves this function; neither
 * orientation nor coherence becomes part of the analyzer's internal contract.
 */
export function localStructureEnergy(
  grid: Readonly<ScalarGrid>,
  aggregationSigma: number,
): ScalarGrid | null {
  if (!isValidScalarGrid(grid)) return null
  const pointEnergy = new Array<number>(grid.values.length)
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      pointEnergy[y * grid.width + x] = scharrEnergyAt(grid, x, y)
    }
  }

  const energyGrid = createScalarGrid(grid.width, grid.height, pointEnergy)
  if (energyGrid === null) return null
  return gaussianSmooth(energyGrid, aggregationSigma)
}
