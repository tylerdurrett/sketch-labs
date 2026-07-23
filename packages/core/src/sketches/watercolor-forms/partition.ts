/**
 * Fine edge-preserving partition for Watercolor Forms.
 *
 * This stage deliberately uses fixed policy rather than authored controls.
 * Canonical right/down lattice adjacencies are processed by stable Kruskal
 * coalescing. Locally similar supported samples may join while the resulting
 * component remains at most 64 samples; strong color, luminance, and alpha
 * changes therefore survive into the hierarchy as shared-boundary evidence.
 */

import { WATERCOLOR_FORMS_LIMITS } from './limits'
import type {
  InitialRegionPartition,
  PreparedWatercolorRaster,
  SharedBoundarySegment,
  WatercolorRegionSummary,
} from './types'

const LOCAL_COHESION_THRESHOLD = 0.08
const INITIAL_REGION_MAX_AREA = 64
// OKLab-like distance occupies only part of the unit interval for ordinary
// photographs. Calibrate it before authored Boundary strength compares unit
// evidence, while still reserving one for the strongest visible transitions.
const PERCEPTUAL_BOUNDARY_DISTANCE_SCALE = 0.3
const NO_COLOR_REGION = -1

type PerceptualColor = readonly [number, number, number]
type EdgeOrientation = 'right' | 'down'

interface LatticeEdge {
  readonly id: number
  readonly firstSampleId: number
  readonly secondSampleId: number
  readonly orientation: EdgeOrientation
  readonly colorDistance: number
  readonly alphaDistance: number
  readonly dissimilarity: number
}

interface RegionAccumulator {
  sampleCount: number
  visibleSampleCount: number
  redSum: number
  greenSum: number
  blueSum: number
  luminanceSum: number
  alphaSum: number
}

const EMPTY_NUMBERS = Object.freeze([]) as readonly number[]
const EMPTY_REGIONS =
  Object.freeze([]) as readonly Readonly<WatercolorRegionSummary>[]
const EMPTY_BOUNDARIES =
  Object.freeze([]) as readonly Readonly<SharedBoundarySegment>[]

function emptyPartition(
  raster: Readonly<PreparedWatercolorRaster>,
): InitialRegionPartition {
  return Object.freeze({
    raster,
    regionBySample: EMPTY_NUMBERS,
    regions: EMPTY_REGIONS,
    sharedBoundarySegments: EMPTY_BOUNDARIES,
  })
}

function validUnitArray(
  value: unknown,
  expectedLength: number,
): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length === expectedLength &&
    value.every(
      (entry) =>
        typeof entry === 'number' &&
        Number.isFinite(entry) &&
        entry >= 0 &&
        entry <= 1,
    )
  )
}

function isValidRaster(
  value: unknown,
): value is Readonly<PreparedWatercolorRaster> {
  if (value === null || typeof value !== 'object') return false
  const raster = value as Partial<PreparedWatercolorRaster>
  if (
    !Number.isSafeInteger(raster.width) ||
    !Number.isSafeInteger(raster.height) ||
    raster.width! < 0 ||
    raster.height! < 0 ||
    raster.width! > WATERCOLOR_FORMS_LIMITS.analysisMaxDimension ||
    raster.height! > WATERCOLOR_FORMS_LIMITS.analysisMaxDimension
  ) {
    return false
  }

  const sampleCount = raster.width! * raster.height!
  if (
    sampleCount > WATERCOLOR_FORMS_LIMITS.maxSampleCount ||
    !validUnitArray(raster.linearRed, sampleCount) ||
    !validUnitArray(raster.linearGreen, sampleCount) ||
    !validUnitArray(raster.linearBlue, sampleCount) ||
    !validUnitArray(raster.luminance, sampleCount) ||
    !validUnitArray(raster.alpha, sampleCount) ||
    !Array.isArray(raster.positiveSupport) ||
    raster.positiveSupport.length !== sampleCount ||
    !raster.positiveSupport.every(
      (entry) => typeof entry === 'boolean',
    )
  ) {
    return false
  }

  return (
    (sampleCount === 0 && raster.width === 0 && raster.height === 0) ||
    (raster.width! > 0 && raster.height! > 0)
  )
}

function clampUnit(value: number): number {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function linearRgbToPerceptual(
  red: number,
  green: number,
  blue: number,
): PerceptualColor {
  const long = Math.cbrt(
    0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue,
  )
  const medium = Math.cbrt(
    0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue,
  )
  const short = Math.cbrt(
    0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue,
  )

  return [
    0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  ]
}

function perceptualDistance(
  first: Readonly<PerceptualColor>,
  second: Readonly<PerceptualColor>,
): number {
  return Math.hypot(
    first[0] - second[0],
    first[1] - second[1],
    first[2] - second[2],
  )
}

function buildCanonicalEdges(
  raster: Readonly<PreparedWatercolorRaster>,
): readonly LatticeEdge[] {
  // Preparation has already tone-shaped these visible RGB channels. Keeping
  // the full OKLab distance therefore combines their transformed lightness
  // with chromatic evidence without a second, raw-lightness bypass.
  const perceptual = raster.linearRed.map((red, sampleId) =>
    linearRgbToPerceptual(
      red,
      raster.linearGreen[sampleId]!,
      raster.linearBlue[sampleId]!,
    ),
  )
  const edges: LatticeEdge[] = []

  const addEdge = (
    firstSampleId: number,
    secondSampleId: number,
    orientation: EdgeOrientation,
  ): void => {
    // Exact-zero support has no visible color. Hidden RGB must therefore
    // contribute neither merge evidence nor support-boundary strength.
    const colorDistance =
      raster.positiveSupport[firstSampleId] &&
      raster.positiveSupport[secondSampleId]
        ? perceptualDistance(
            perceptual[firstSampleId]!,
            perceptual[secondSampleId]!,
          )
        : 0
    const alphaDistance = Math.abs(
      raster.alpha[firstSampleId]! - raster.alpha[secondSampleId]!,
    )
    edges.push({
      id: edges.length,
      firstSampleId,
      secondSampleId,
      orientation,
      colorDistance,
      alphaDistance,
      dissimilarity: Math.max(colorDistance, alphaDistance),
    })
  }

  for (let row = 0; row < raster.height; row += 1) {
    for (let column = 0; column < raster.width; column += 1) {
      const sampleId = row * raster.width + column
      if (column + 1 < raster.width) {
        addEdge(sampleId, sampleId + 1, 'right')
      }
      if (row + 1 < raster.height) {
        addEdge(sampleId, sampleId + raster.width, 'down')
      }
    }
  }

  return edges
}

function isPermutation(
  order: readonly number[],
  expectedLength: number,
): boolean {
  if (order.length !== expectedLength) return false
  const seen = new Uint8Array(expectedLength)
  for (const index of order) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= expectedLength ||
      seen[index] === 1
    ) {
      return false
    }
    seen[index] = 1
  }
  return true
}

function stableCoalescingOrder(
  canonicalEdges: readonly LatticeEdge[],
  constructionOrder?: readonly number[],
): LatticeEdge[] {
  const edges =
    constructionOrder !== undefined &&
    isPermutation(constructionOrder, canonicalEdges.length)
      ? constructionOrder.map((index) => canonicalEdges[index]!)
      : [...canonicalEdges]

  edges.sort(
    (first, second) =>
      first.dissimilarity - second.dissimilarity ||
      first.firstSampleId - second.firstSampleId ||
      first.secondSampleId - second.secondSampleId ||
      first.id - second.id,
  )
  return edges
}

function findRoot(parents: number[], sampleId: number): number {
  let root = sampleId
  while (parents[root] !== root) root = parents[root]!
  while (parents[sampleId] !== sampleId) {
    const parent = parents[sampleId]!
    parents[sampleId] = root
    sampleId = parent
  }
  return root
}

function coalesceSamples(
  raster: Readonly<PreparedWatercolorRaster>,
  canonicalEdges: readonly LatticeEdge[],
  constructionOrder?: readonly number[],
): number[] {
  const sampleCount = raster.width * raster.height
  const parents = Array.from({ length: sampleCount }, (_, index) => index)
  const areas: number[] = raster.positiveSupport.map((supported) =>
    supported ? 1 : 0,
  )

  for (const edge of stableCoalescingOrder(
    canonicalEdges,
    constructionOrder,
  )) {
    if (edge.dissimilarity >= LOCAL_COHESION_THRESHOLD) break
    if (
      !raster.positiveSupport[edge.firstSampleId] ||
      !raster.positiveSupport[edge.secondSampleId]
    ) {
      continue
    }

    const firstRoot = findRoot(parents, edge.firstSampleId)
    const secondRoot = findRoot(parents, edge.secondSampleId)
    if (firstRoot === secondRoot) continue
    if (
      areas[firstRoot]! + areas[secondRoot]! >
      INITIAL_REGION_MAX_AREA
    ) {
      continue
    }

    // The lower row-major root owns every tie, independent of tree depth.
    const root = Math.min(firstRoot, secondRoot)
    const absorbed = Math.max(firstRoot, secondRoot)
    parents[absorbed] = root
    areas[root] = areas[firstRoot]! + areas[secondRoot]!
    areas[absorbed] = 0
  }

  return parents
}

function summarizeRegions(
  raster: Readonly<PreparedWatercolorRaster>,
  parents: number[],
): Readonly<{
  regionBySample: readonly number[]
  regions: readonly Readonly<WatercolorRegionSummary>[]
}> {
  const sampleCount = raster.width * raster.height
  const rootBySample = new Array<number>(sampleCount).fill(NO_COLOR_REGION)
  const roots = new Set<number>()

  for (let sampleId = 0; sampleId < sampleCount; sampleId += 1) {
    if (!raster.positiveSupport[sampleId]) continue
    const root = findRoot(parents, sampleId)
    rootBySample[sampleId] = root
    roots.add(root)
  }

  const ascendingRoots = [...roots].sort((first, second) => first - second)
  const regionIdByRoot = new Map(
    ascendingRoots.map((root, regionId) => [root, regionId]),
  )
  const accumulators = ascendingRoots.map<RegionAccumulator>(() => ({
    sampleCount: 0,
    visibleSampleCount: 0,
    redSum: 0,
    greenSum: 0,
    blueSum: 0,
    luminanceSum: 0,
    alphaSum: 0,
  }))
  const regionBySample = rootBySample.map((root, sampleId) => {
    if (root === NO_COLOR_REGION) return NO_COLOR_REGION
    const regionId = regionIdByRoot.get(root)!
    const accumulator = accumulators[regionId]!
    accumulator.sampleCount += 1
    accumulator.visibleSampleCount +=
      raster.positiveSupport[sampleId] ? 1 : 0
    accumulator.redSum += raster.linearRed[sampleId]!
    accumulator.greenSum += raster.linearGreen[sampleId]!
    accumulator.blueSum += raster.linearBlue[sampleId]!
    accumulator.luminanceSum += raster.luminance[sampleId]!
    accumulator.alphaSum += raster.alpha[sampleId]!
    return regionId
  })
  const regions = accumulators.map<WatercolorRegionSummary>(
    (accumulator, id) => {
      const divisor = accumulator.visibleSampleCount
      return Object.freeze({
        id,
        sampleCount: accumulator.sampleCount,
        visibleSampleCount: accumulator.visibleSampleCount,
        meanLinearRed: accumulator.redSum / divisor,
        meanLinearGreen: accumulator.greenSum / divisor,
        meanLinearBlue: accumulator.blueSum / divisor,
        meanLuminance: accumulator.luminanceSum / divisor,
        meanAlpha: accumulator.alphaSum / divisor,
      })
    },
  )

  return {
    regionBySample: Object.freeze(regionBySample),
    regions: Object.freeze(regions),
  }
}

function boundaryEndpoints(
  edge: Readonly<LatticeEdge>,
  width: number,
): readonly [readonly [number, number], readonly [number, number]] {
  const row = Math.floor(edge.firstSampleId / width)
  const column = edge.firstSampleId % width
  if (edge.orientation === 'right') {
    return [
      Object.freeze([column + 1, row] as [number, number]),
      Object.freeze([column + 1, row + 1] as [number, number]),
    ]
  }
  return [
    Object.freeze([column, row + 1] as [number, number]),
    Object.freeze([column + 1, row + 1] as [number, number]),
  ]
}

function collectSharedBoundaries(
  raster: Readonly<PreparedWatercolorRaster>,
  canonicalEdges: readonly LatticeEdge[],
  regionBySample: readonly number[],
): readonly Readonly<SharedBoundarySegment>[] {
  const segments: Readonly<SharedBoundarySegment>[] = []

  for (const edge of canonicalEdges) {
    const firstRegionId = regionBySample[edge.firstSampleId]!
    const secondRegionId = regionBySample[edge.secondSampleId]!
    if (
      firstRegionId === secondRegionId ||
      (firstRegionId === NO_COLOR_REGION &&
        secondRegionId === NO_COLOR_REGION)
    ) {
      continue
    }

    const regionIds = Object.freeze(
      [
        Math.min(firstRegionId, secondRegionId),
        Math.max(firstRegionId, secondRegionId),
      ] as [number, number],
    )
    const [start, end] = boundaryEndpoints(edge, raster.width)
    const hasSupportBoundary =
      firstRegionId === NO_COLOR_REGION ||
      secondRegionId === NO_COLOR_REGION
    segments.push(
      Object.freeze({
        id: edge.id,
        regionIds,
        start,
        end,
        strength: clampUnit(
          Math.max(
            edge.colorDistance / PERCEPTUAL_BOUNDARY_DISTANCE_SCALE,
            edge.alphaDistance,
          ),
        ),
        provenance:
          hasSupportBoundary ||
          edge.alphaDistance > edge.colorDistance
            ? 'alpha-boundary'
            : 'visible-color',
      }),
    )
  }

  return Object.freeze(segments)
}

function partitionRaster(
  raster: Readonly<PreparedWatercolorRaster>,
  constructionOrder?: readonly number[],
): InitialRegionPartition {
  if (!isValidRaster(raster)) {
    return emptyPartition(raster)
  }
  if (raster.width === 0 || raster.height === 0) {
    return emptyPartition(raster)
  }

  const canonicalEdges = buildCanonicalEdges(raster)
  if (
    canonicalEdges.length >
    WATERCOLOR_FORMS_LIMITS.maxGridAdjacencyCount
  ) {
    return emptyPartition(raster)
  }

  const parents = coalesceSamples(
    raster,
    canonicalEdges,
    constructionOrder,
  )
  const { regionBySample, regions } = summarizeRegions(raster, parents)
  const sharedBoundarySegments = collectSharedBoundaries(
    raster,
    canonicalEdges,
    regionBySample,
  )

  return Object.freeze({
    raster,
    regionBySample,
    regions,
    sharedBoundarySegments,
  })
}

/** Build the deterministic fine partition consumed by the merge hierarchy. */
export function partitionWatercolorFormsRaster(
  raster: Readonly<PreparedWatercolorRaster>,
): InitialRegionPartition {
  return partitionRaster(raster)
}

/**
 * @internal Test seam proving that caller/insertion order cannot affect the
 * stable Kruskal result. Invalid permutations deliberately fall back closed to
 * canonical construction order.
 */
export function partitionWatercolorFormsRasterWithEdgeOrderForTest(
  raster: Readonly<PreparedWatercolorRaster>,
  edgeOrder: readonly number[],
): InitialRegionPartition {
  return partitionRaster(raster, edgeOrder)
}
