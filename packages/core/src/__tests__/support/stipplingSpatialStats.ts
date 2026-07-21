import type { CoordinateSpace } from '../../scene'
import type { Point, Polyline } from '../../types'

export interface StipplingSpatialStats {
  /** Root-mean-square distance from a fixed probe lattice to its nearest mark. */
  readonly rmsVoid: number
  /** Largest distance from a fixed probe lattice to its nearest mark. */
  readonly maximumVoid: number
  /** Standard deviation of fixed-lattice nearest-mark distances. */
  readonly voidDispersion: number
  /** Coefficient of variation of mark-to-nearest-mark distances. */
  readonly nearestNeighborDispersion: number
  /** Second cosine moment: zero has no horizontal-versus-vertical preference. */
  readonly horizontalVerticalBias: number
  /** Second sine moment: zero has no preference between the two diagonals. */
  readonly diagonalBias: number
  /** Fourth cosine moment: zero has no axis-versus-diagonal preference. */
  readonly axisDiagonalBias: number
}

export interface StipplingBandStats {
  readonly counts: readonly number[]
  /** Mean within-band coefficient of variation of nearest-mark distances. */
  readonly spatialBalance: number
}

export function stippleCenters(
  polylines: readonly Readonly<Polyline>[],
): readonly Readonly<Point>[] {
  return polylines.map((polyline) => [
    (polyline[0]![0] + polyline[1]![0]) / 2,
    (polyline[0]![1] + polyline[1]![1]) / 2,
  ])
}

/** Smallest exact center-to-center distance; intended for modest test fixtures. */
export function minimumStippleSpacing(
  centers: readonly Readonly<Point>[],
): number {
  let minimumSquared = Number.POSITIVE_INFINITY
  for (let first = 0; first < centers.length; first++) {
    for (let second = first + 1; second < centers.length; second++) {
      const deltaX = centers[first]![0] - centers[second]![0]
      const deltaY = centers[first]![1] - centers[second]![1]
      minimumSquared = Math.min(
        minimumSquared,
        deltaX * deltaX + deltaY * deltaY,
      )
    }
  }
  return Math.sqrt(minimumSquared)
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function standardDeviation(values: readonly number[], average: number): number {
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      values.length,
  )
}

function nearestDistance(
  point: Readonly<Point>,
  centers: readonly Readonly<Point>[],
): number {
  let nearestSquared = Number.POSITIVE_INFINITY
  for (const center of centers) {
    const deltaX = point[0] - center[0]
    const deltaY = point[1] - center[1]
    nearestSquared = Math.min(nearestSquared, deltaX * deltaX + deltaY * deltaY)
  }
  return Math.sqrt(nearestSquared)
}

/** Summarize abundance and scale-neutral within-band void balance. */
export function summarizeStipplingBands(
  frame: Readonly<CoordinateSpace>,
  centers: readonly Readonly<Point>[],
  bandCount = 4,
  probesPerBand = 256,
): Readonly<StipplingBandStats> {
  if (!Number.isSafeInteger(bandCount) || bandCount < 1) {
    throw new RangeError('Band count must be a positive safe integer')
  }
  const counts = Array.from({ length: bandCount }, () => 0)
  for (const center of centers) {
    const band = Math.min(
      bandCount - 1,
      Math.max(0, Math.floor((center[0] / frame.width) * bandCount)),
    )
    counts[band] = counts[band]! + 1
  }

  const probeColumns = Math.max(1, Math.round(Math.sqrt(probesPerBand)))
  const probeRows = Math.max(1, Math.ceil(probesPerBand / probeColumns))
  const bandWidth = frame.width / bandCount
  const coefficients: number[] = []
  for (let band = 0; band < bandCount; band++) {
    const distances: number[] = []
    for (let row = 0; row < probeRows; row++) {
      for (let column = 0; column < probeColumns; column++) {
        distances.push(
          nearestDistance(
            [
              band * bandWidth + ((column + 0.5) * bandWidth) / probeColumns,
              ((row + 0.5) * frame.height) / probeRows,
            ],
            centers,
          ),
        )
      }
    }
    const average = mean(distances)
    coefficients.push(standardDeviation(distances, average) / average)
  }

  return Object.freeze({
    counts: Object.freeze(counts),
    spatialBalance: mean(coefficients),
  })
}

/**
 * Summarize deterministic, scale-independent spacing and direction evidence.
 *
 * Void metrics use cell centers from a fixed probe lattice. Direction metrics
 * use each mark's nearest-neighbor axis and are invariant to pair ordering.
 */
export function summarizeStipplingSpatialStats(
  frame: Readonly<CoordinateSpace>,
  centers: readonly Readonly<Point>[],
  probeColumns = 32,
  probeRows = 32,
): Readonly<StipplingSpatialStats> {
  if (centers.length < 2) {
    throw new RangeError('Spatial statistics require at least two centers')
  }
  if (
    !Number.isSafeInteger(probeColumns) ||
    probeColumns < 1 ||
    !Number.isSafeInteger(probeRows) ||
    probeRows < 1
  ) {
    throw new RangeError('Spatial-statistic probe dimensions must be positive')
  }

  const frameScale = Math.max(frame.width, frame.height)
  const voidDistances: number[] = []
  for (let row = 0; row < probeRows; row++) {
    for (let column = 0; column < probeColumns; column++) {
      const probe: Point = [
        ((column + 0.5) * frame.width) / probeColumns,
        ((row + 0.5) * frame.height) / probeRows,
      ]
      voidDistances.push(nearestDistance(probe, centers) / frameScale)
    }
  }

  const neighborDistances: number[] = []
  let secondCosine = 0
  let secondSine = 0
  let fourthCosine = 0
  for (let index = 0; index < centers.length; index++) {
    const center = centers[index]!
    let nearestSquared = Number.POSITIVE_INFINITY
    let nearestIndex = -1
    for (let otherIndex = 0; otherIndex < centers.length; otherIndex++) {
      if (otherIndex === index) continue
      const other = centers[otherIndex]!
      const deltaX = other[0] - center[0]
      const deltaY = other[1] - center[1]
      const distanceSquared = deltaX * deltaX + deltaY * deltaY
      if (distanceSquared < nearestSquared) {
        nearestSquared = distanceSquared
        nearestIndex = otherIndex
      }
    }
    const nearest = centers[nearestIndex]!
    const angle = Math.atan2(nearest[1] - center[1], nearest[0] - center[0])
    neighborDistances.push(Math.sqrt(nearestSquared) / frameScale)
    secondCosine += Math.cos(2 * angle)
    secondSine += Math.sin(2 * angle)
    fourthCosine += Math.cos(4 * angle)
  }

  const voidMean = mean(voidDistances)
  const neighborMean = mean(neighborDistances)
  return Object.freeze({
    rmsVoid: Math.sqrt(mean(voidDistances.map((distance) => distance ** 2))),
    maximumVoid: Math.max(...voidDistances),
    voidDispersion: standardDeviation(voidDistances, voidMean),
    nearestNeighborDispersion:
      standardDeviation(neighborDistances, neighborMean) / neighborMean,
    horizontalVerticalBias: Math.abs(secondCosine) / centers.length,
    diagonalBias: Math.abs(secondSine) / centers.length,
    axisDiagonalBias: Math.abs(fourthCosine) / centers.length,
  })
}
