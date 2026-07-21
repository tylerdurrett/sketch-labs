import Delaunator from 'delaunator'
import { incircle } from 'robust-predicates'

import type { Point } from '../types'
import type {
  StippleMark,
  StipplingDemandLattice,
  StipplingModel,
} from './types'

/** One weighted demand cell accumulated against an ordered Stipple site. */
export interface StipplingVoronoiCell {
  /** The corresponding index in the caller's ordered marks. */
  readonly siteIndex: number
  readonly weight: number
  /** Weighted demand-sample mean, or null for an empty cell. */
  readonly centroid: Readonly<Point> | null
}

/** Deterministic work performed by one assignment pass. */
export interface StipplingVoronoiWork {
  /** Bounded lattice cells considered, including exact-zero demand. */
  readonly sampleCount: number
  /** Positive-demand cells that received a nearest-site query. */
  readonly assignedSampleCount: number
  /** Exact site distances evaluated by Delaunay walks and local fallbacks. */
  readonly distanceEvaluationCount: number
  /** Adaptive spatial-index nodes probed while choosing query seeds. */
  readonly seedLookupCount: number
  /** Coordinate, sort-comparison, and adjacency work for regression guards. */
  readonly indexBuildOperationCount: number
}

/** Immutable weighted Voronoi assignment for one ordered mark set. */
export interface StipplingVoronoiAssignment {
  /** One ordered site index per lattice cell; zero demand is null. */
  readonly assignments: readonly (number | null)[]
  /** Cells remain in ordered-site identity, including empty cells. */
  readonly cells: readonly StipplingVoronoiCell[]
  readonly totalWeight: number
  /** Demand-weighted squared distance divided by the Frame diagonal squared. */
  readonly normalizedObjective: number
  readonly work: Readonly<StipplingVoronoiWork>
}

interface MutableCell {
  weight: number
  centroidX: number
  centroidY: number
}

interface NearestSite {
  siteIndex: number
  distanceSquared: number
  distanceEvaluationCount: number
}

interface SiteGraph {
  readonly x: Float64Array
  readonly y: Float64Array
  readonly offsets: Uint32Array
  readonly neighbours: Uint32Array
  readonly collinear: CollinearSiteIndex | null
  readonly seedIndex: AdaptiveSeedIndex
  readonly topologySites: Uint8Array
  readonly topologyAnchorSiteIndex: number
  readonly exactFallbackSiteIndices: Uint32Array
  readonly buildOperationCount: number
}

interface AdaptiveSeedIndex {
  readonly siteIndex: Uint32Array
  readonly left: Int32Array
  readonly right: Int32Array
  readonly splitOnX: Uint8Array
  readonly root: number
}

interface CollinearSiteIndex {
  readonly siteIndices: Uint32Array
  readonly projections: Float64Array
  readonly originX: number
  readonly originY: number
  readonly directionX: number
  readonly directionY: number
}

interface QueryScratch {
  generation: number
  readonly evaluatedGeneration: Uint32Array
  readonly distanceSquaredBySite: Float64Array
}

const DELAUNATOR_EPSILON = 2 ** -52
const MINIMUM_TOPOLOGY_SEPARATION = DELAUNATOR_EPSILON * 8
// Delaunator's construction uses squared distances and fourth-degree in-circle
// terms. 2^240 leaves more than sixty binary exponents of finite headroom for
// the latter, including subtraction and expansion overhead.
const MAXIMUM_TOPOLOGY_COORDINATE = 2 ** 240

interface TopologyScale {
  readonly scale: number
  readonly requiresExactFallback: boolean
  readonly operationCount: number
}

function createTopologyScale(
  siteIndices: readonly number[],
  x: Float64Array,
  y: Float64Array,
): TopologyScale {
  let operationCount = 0
  const sortedCoordinate = (coordinate: Float64Array): number[] =>
    [...siteIndices].sort((first, second) => {
      operationCount++
      return coordinate[first]! - coordinate[second]! || first - second
    })
  let minimumPositiveGap = Number.POSITIVE_INFINITY
  for (const coordinate of [x, y]) {
    const ordered = sortedCoordinate(coordinate)
    for (let index = 1; index < ordered.length; index++) {
      operationCount++
      const gap = coordinate[ordered[index]!]! - coordinate[ordered[index - 1]!]!
      if (gap > 0 && gap < minimumPositiveGap) minimumPositiveGap = gap
    }
  }
  if (!Number.isFinite(minimumPositiveGap)) {
    return { scale: 1, requiresExactFallback: false, operationCount }
  }

  let maximumCoordinate = 0
  for (const siteIndex of siteIndices) {
    operationCount++
    maximumCoordinate = Math.max(
      maximumCoordinate,
      Math.abs(x[siteIndex]!),
      Math.abs(y[siteIndex]!),
    )
  }

  // Derive amplification from the minimum adjacent gap after an exact
  // power-of-two normalization. Combining those two exponents into the final
  // scale avoids a rounding translation that can erase a tiny local cluster
  // beside a distant outlier.
  const normalizationExponent =
    maximumCoordinate === 0 ? 0 : Math.ceil(Math.log2(maximumCoordinate))
  const minimumNormalizedGapLog2 =
    Math.log2(minimumPositiveGap) - normalizationExponent
  const amplificationExponent =
    Math.floor(
      Math.log2(MINIMUM_TOPOLOGY_SEPARATION) -
        minimumNormalizedGapLog2,
    ) + 1
  let requiredExponent = amplificationExponent - normalizationExponent
  requiredExponent = Math.max(-1_074, requiredExponent)
  while (
    requiredExponent <= 1_023 &&
    minimumPositiveGap * 2 ** requiredExponent <=
      MINIMUM_TOPOLOGY_SEPARATION
  ) {
    requiredExponent++
  }
  while (
    requiredExponent > -1_074 &&
    minimumPositiveGap * 2 ** (requiredExponent - 1) >
      MINIMUM_TOPOLOGY_SEPARATION
  ) {
    requiredExponent--
  }

  let maximumSafeExponent =
    maximumCoordinate === 0
      ? 1_023
      : Math.floor(
          Math.log2(MAXIMUM_TOPOLOGY_COORDINATE) -
            Math.log2(maximumCoordinate),
        )
  maximumSafeExponent = Math.max(
    -1_074,
    Math.min(1_023, maximumSafeExponent),
  )
  while (
    maximumCoordinate * 2 ** maximumSafeExponent >
    MAXIMUM_TOPOLOGY_COORDINATE
  ) {
    maximumSafeExponent--
  }
  while (
    maximumSafeExponent < 1_023 &&
    maximumCoordinate * 2 ** (maximumSafeExponent + 1) <=
      MAXIMUM_TOPOLOGY_COORDINATE
  ) {
    maximumSafeExponent++
  }

  const selectedExponent = Math.min(requiredExponent, maximumSafeExponent)
  return {
    scale: 2 ** selectedExponent,
    requiresExactFallback: requiredExponent > maximumSafeExponent,
    operationCount,
  }
}

function compareSeedSites(
  first: number,
  second: number,
  splitOnX: boolean,
  x: Float64Array,
  y: Float64Array,
): number {
  const primary = splitOnX ? x[first]! - x[second]! : y[first]! - y[second]!
  if (primary !== 0) return primary
  const secondary = splitOnX ? y[first]! - y[second]! : x[first]! - x[second]!
  return secondary !== 0 ? secondary : first - second
}

function createAdaptiveSeedIndex(
  siteIndices: readonly number[],
  x: Float64Array,
  y: Float64Array,
): {
  readonly index: AdaptiveSeedIndex
  readonly operationCount: number
} {
  let operationCount = 0
  const sorted = (splitOnX: boolean): number[] =>
    [...siteIndices].sort((first, second) => {
      operationCount++
      return compareSeedSites(first, second, splitOnX, x, y)
    })
  const siteIndex = new Uint32Array(siteIndices.length)
  const left = new Int32Array(siteIndices.length).fill(-1)
  const right = new Int32Array(siteIndices.length).fill(-1)
  const splitOnX = new Uint8Array(siteIndices.length)
  const membership = new Uint32Array(x.length)
  let membershipGeneration = 0
  let nodeCount = 0

  const build = (orderedX: number[], orderedY: number[]): number => {
    if (orderedX.length === 0) return -1
    const minX = x[orderedX[0]!]!
    const maxX = x[orderedX[orderedX.length - 1]!]!
    const minY = y[orderedY[0]!]!
    const maxY = y[orderedY[orderedY.length - 1]!]!
    const useX = maxX - minX >= maxY - minY
    const splitOrder = useX ? orderedX : orderedY
    const middle = Math.floor(splitOrder.length / 2)
    const medianSiteIndex = splitOrder[middle]!
    const leftSplit = splitOrder.slice(0, middle)
    const rightSplit = splitOrder.slice(middle + 1)
    membershipGeneration++
    for (const member of leftSplit) membership[member] = membershipGeneration
    const leftOther: number[] = []
    const rightOther: number[] = []
    for (const member of useX ? orderedY : orderedX) {
      operationCount++
      if (member === medianSiteIndex) continue
      if (membership[member] === membershipGeneration) leftOther.push(member)
      else rightOther.push(member)
    }

    const node = nodeCount++
    siteIndex[node] = medianSiteIndex
    splitOnX[node] = useX ? 1 : 0
    left[node] = build(
      useX ? leftSplit : leftOther,
      useX ? leftOther : leftSplit,
    )
    right[node] = build(
      useX ? rightSplit : rightOther,
      useX ? rightOther : rightSplit,
    )
    return node
  }
  return {
    index: {
      siteIndex,
      left,
      right,
      splitOnX,
      root: build(sorted(true), sorted(false)),
    },
    operationCount,
  }
}

function adaptiveSeed(
  sampleX: number,
  sampleY: number,
  graph: SiteGraph,
): { readonly siteIndex: number; readonly lookupCount: number } {
  const index = graph.seedIndex
  let node = index.root
  let siteIndex = 0
  let lookupCount = 0
  while (node >= 0) {
    lookupCount++
    siteIndex = index.siteIndex[node]!
    const sampleCoordinate = index.splitOnX[node] === 1 ? sampleX : sampleY
    const siteCoordinate =
      index.splitOnX[node] === 1
        ? graph.x[siteIndex]!
        : graph.y[siteIndex]!
    node =
      sampleCoordinate < siteCoordinate
        ? index.left[node]!
        : index.right[node]!
  }
  return { siteIndex, lookupCount }
}

function validatePoint(
  point: Readonly<Point>,
  width: number,
  height: number,
  label: string,
): void {
  const [x, y] = point
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > width ||
    y < 0 ||
    y > height
  ) {
    throw new RangeError(`${label} must be a finite point inside the frame`)
  }
}

function nextHalfedge(edge: number): number {
  return edge % 3 === 2 ? edge - 2 : edge + 1
}

function robustlyLegalizedEdges(
  triangulation: Delaunator<Float64Array>,
): {
  readonly triangles: Uint32Array
  readonly halfedges: Int32Array
  readonly operationCount: number
} {
  const triangles = triangulation.triangles.slice()
  const halfedges = triangulation.halfedges.slice()
  const coordinates = triangulation.coords
  const pending = Array.from({ length: halfedges.length }, (_, edge) => edge)
  let operationCount = 0

  const link = (first: number, second: number): void => {
    halfedges[first] = second
    if (second >= 0) halfedges[second] = first
  }
  while (pending.length > 0) {
    const edge = pending.pop()!
    const twin = halfedges[edge]!
    if (twin < 0) continue
    operationCount++

    const triangle = edge - (edge % 3)
    const twinTriangle = twin - (twin % 3)
    const edgeRight = triangle + ((edge + 2) % 3)
    const edgeLeft = triangle + ((edge + 1) % 3)
    const twinLeft = twinTriangle + ((twin + 2) % 3)
    const first = triangles[edgeRight]!
    const right = triangles[edge]!
    const left = triangles[edgeLeft]!
    const opposite = triangles[twinLeft]!
    const illegal =
      incircle(
        coordinates[first * 2]!,
        coordinates[first * 2 + 1]!,
        coordinates[right * 2]!,
        coordinates[right * 2 + 1]!,
        coordinates[left * 2]!,
        coordinates[left * 2 + 1]!,
        coordinates[opposite * 2]!,
        coordinates[opposite * 2 + 1]!,
      ) < 0
    if (!illegal) continue

    triangles[edge] = opposite
    triangles[twin] = first
    const formerTwinLeft = halfedges[twinLeft]!
    link(edge, formerTwinLeft)
    link(twin, halfedges[edgeRight]!)
    link(edgeRight, twinLeft)
    for (let offset = 0; offset < 3; offset++) {
      pending.push(triangle + offset, twinTriangle + offset)
    }
  }

  return { triangles, halfedges, operationCount }
}

/**
 * Build exact-query adjacency from a deterministic Delaunay triangulation.
 *
 * Exact duplicates canonicalize to their lower ordered index because they can
 * never win the declared tie. Collinear inputs use an exact projected-order
 * query index; all other inputs use only robustly legalized Delaunay edges.
 */
function createSiteGraph(
  marks: readonly Readonly<StippleMark>[],
  width: number,
  height: number,
  frameScale: number,
): SiteGraph {
  const siteCount = marks.length
  const x = new Float64Array(siteCount)
  const y = new Float64Array(siteCount)
  const uniqueSiteIndices: number[] = []
  const sitesByX = new Map<number, Map<number, number>>()
  let buildOperationCount = 0

  for (let siteIndex = 0; siteIndex < siteCount; siteIndex++) {
    const mark = marks[siteIndex]!
    validatePoint(mark.center, width, height, `Voronoi site ${siteIndex}`)
    x[siteIndex] = mark.center[0]
    y[siteIndex] = mark.center[1]
    buildOperationCount++

    let sitesByY = sitesByX.get(x[siteIndex]!)
    if (sitesByY === undefined) {
      sitesByY = new Map<number, number>()
      sitesByX.set(x[siteIndex]!, sitesByY)
    }
    if (!sitesByY.has(y[siteIndex]!)) {
      sitesByY.set(y[siteIndex]!, siteIndex)
      uniqueSiteIndices.push(siteIndex)
    }
  }

  const triangulationCoordinates = new Float64Array(
    uniqueSiteIndices.length * 2,
  )
  const topologyScale = createTopologyScale(uniqueSiteIndices, x, y)
  buildOperationCount += topologyScale.operationCount
  for (
    let uniqueIndex = 0;
    uniqueIndex < uniqueSiteIndices.length;
    uniqueIndex++
  ) {
    const siteIndex = uniqueSiteIndices[uniqueIndex]!
    triangulationCoordinates[uniqueIndex * 2] =
      x[siteIndex]! * topologyScale.scale
    triangulationCoordinates[uniqueIndex * 2 + 1] =
      y[siteIndex]! * topologyScale.scale
  }

  const edgeStarts: number[] = []
  const edgeEnds: number[] = []
  const topologySites = new Uint8Array(siteCount)
  let collinearSites = uniqueSiteIndices.length <= 2
  const addEdge = (first: number, second: number): void => {
    if (first === second) return
    edgeStarts.push(first)
    edgeEnds.push(second)
    buildOperationCount++
  }

  if (uniqueSiteIndices.length >= 2) {
    const triangulation = new Delaunator(triangulationCoordinates)
    collinearSites = triangulation.triangles.length === 0
    const legalized = robustlyLegalizedEdges(triangulation)
    buildOperationCount += legalized.operationCount
    for (let edge = 0; edge < legalized.triangles.length; edge++) {
      topologySites[uniqueSiteIndices[legalized.triangles[edge]!]!] = 1
      const twin = legalized.halfedges[edge]!
      if (twin >= 0 && twin < edge) continue
      addEdge(
        uniqueSiteIndices[legalized.triangles[edge]!]!,
        uniqueSiteIndices[legalized.triangles[nextHalfedge(edge)]!]!,
      )
    }

    if (triangulation.triangles.length === 0) {
      for (let index = 1; index < triangulation.hull.length; index++) {
        addEdge(
          uniqueSiteIndices[triangulation.hull[index - 1]!]!,
          uniqueSiteIndices[triangulation.hull[index]!]!,
        )
      }
    }
  }

  if (collinearSites) {
    for (const siteIndex of uniqueSiteIndices) topologySites[siteIndex] = 1
  }
  const topologySiteIndices: number[] = []
  const omittedSiteIndices: number[] = []
  for (const siteIndex of uniqueSiteIndices) {
    buildOperationCount++
    if (topologySites[siteIndex] === 1) topologySiteIndices.push(siteIndex)
    else omittedSiteIndices.push(siteIndex)
  }
  // When the required amplification exceeds the finite-predicate cap,
  // Delaunator may coalesce a tiny local cluster. The represented sites still
  // form an exact Delaunay graph; exact-scanning only omitted cluster members
  // after that query restores the global answer. Every fallback evaluation is
  // included in distanceEvaluationCount, and query overhead is bounded by the
  // omitted local sites. Unexpected omissions take the same defensive path
  // even when the calculated amplification was sufficient.
  const exactFallbackSiteIndices =
    topologyScale.requiresExactFallback || omittedSiteIndices.length > 0
      ? Uint32Array.from(omittedSiteIndices)
      : new Uint32Array(0)

  uniqueSiteIndices.sort((first, second) => {
    buildOperationCount++
    const xOrder = x[first]! - x[second]!
    if (xOrder !== 0) return xOrder
    const yOrder = y[first]! - y[second]!
    return yOrder !== 0 ? yOrder : first - second
  })
  const adaptiveSeeds = createAdaptiveSeedIndex(
    topologySiteIndices,
    x,
    y,
  )
  buildOperationCount += adaptiveSeeds.operationCount

  let collinear: CollinearSiteIndex | null = null
  if (uniqueSiteIndices.length > 0 && collinearSites) {
    const firstSiteIndex = uniqueSiteIndices[0]!
    const lastSiteIndex = uniqueSiteIndices[uniqueSiteIndices.length - 1]!
    const extentX = (x[lastSiteIndex]! - x[firstSiteIndex]!) / frameScale
    const extentY = (y[lastSiteIndex]! - y[firstSiteIndex]!) / frameScale
    const extent = Math.hypot(extentX, extentY)
    const directionX = extent === 0 ? 1 : extentX / extent
    const directionY = extent === 0 ? 0 : extentY / extent
    collinear = {
      siteIndices: Uint32Array.from(uniqueSiteIndices),
      projections: Float64Array.from(uniqueSiteIndices, (siteIndex) => {
        const dx = (x[siteIndex]! - x[firstSiteIndex]!) / frameScale
        const dy = (y[siteIndex]! - y[firstSiteIndex]!) / frameScale
        return dx * directionX + dy * directionY
      }),
      originX: x[firstSiteIndex]!,
      originY: y[firstSiteIndex]!,
      directionX,
      directionY,
    }
  }

  const degrees = new Uint32Array(siteCount)
  for (let edge = 0; edge < edgeStarts.length; edge++) {
    const first = edgeStarts[edge]!
    const second = edgeEnds[edge]!
    degrees[first] = degrees[first]! + 1
    degrees[second] = degrees[second]! + 1
  }
  const offsets = new Uint32Array(siteCount + 1)
  for (let siteIndex = 0; siteIndex < siteCount; siteIndex++) {
    offsets[siteIndex + 1] = offsets[siteIndex]! + degrees[siteIndex]!
  }
  const neighbours = new Uint32Array(offsets[siteCount]!)
  const cursors = offsets.slice(0, siteCount)
  for (let edge = 0; edge < edgeStarts.length; edge++) {
    const first = edgeStarts[edge]!
    const second = edgeEnds[edge]!
    neighbours[cursors[first]!] = second
    cursors[first] = cursors[first]! + 1
    neighbours[cursors[second]!] = first
    cursors[second] = cursors[second]! + 1
  }

  return {
    x,
    y,
    offsets,
    neighbours,
    collinear,
    seedIndex: adaptiveSeeds.index,
    topologySites,
    topologyAnchorSiteIndex: topologySiteIndices[0] ?? 0,
    exactFallbackSiteIndices,
    buildOperationCount,
  }
}

function nearestCollinearSite(
  sampleX: number,
  sampleY: number,
  frameScale: number,
  graph: SiteGraph,
  index: CollinearSiteIndex,
): NearestSite {
  const queryX = (sampleX - index.originX) / frameScale
  const queryY = (sampleY - index.originY) / frameScale
  const queryProjection =
    queryX * index.directionX + queryY * index.directionY
  let lower = 0
  let upper = index.projections.length
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2)
    if (index.projections[middle]! < queryProjection) lower = middle + 1
    else upper = middle
  }

  let bestSiteIndex = index.siteIndices[Math.min(lower, index.siteIndices.length - 1)]!
  let dx = (sampleX - graph.x[bestSiteIndex]!) / frameScale
  let dy = (sampleY - graph.y[bestSiteIndex]!) / frameScale
  let bestDistanceSquared = dx * dx + dy * dy
  let distanceEvaluationCount = 1
  if (lower > 0) {
    const candidateIndex = index.siteIndices[lower - 1]!
    dx = (sampleX - graph.x[candidateIndex]!) / frameScale
    dy = (sampleY - graph.y[candidateIndex]!) / frameScale
    const candidateDistanceSquared = dx * dx + dy * dy
    distanceEvaluationCount++
    if (
      candidateDistanceSquared < bestDistanceSquared ||
      (candidateDistanceSquared === bestDistanceSquared &&
        candidateIndex < bestSiteIndex)
    ) {
      bestSiteIndex = candidateIndex
      bestDistanceSquared = candidateDistanceSquared
    }
  }

  return {
    siteIndex: bestSiteIndex,
    distanceSquared: bestDistanceSquared,
    distanceEvaluationCount,
  }
}

function nearestSite(
  sampleX: number,
  sampleY: number,
  frameScale: number,
  graph: SiteGraph,
  previousSiteIndex: number,
  seedSiteIndex: number,
  scratch: QueryScratch,
): NearestSite {
  scratch.generation++
  const generation = scratch.generation
  let distanceEvaluationCount = 0
  const distanceSquared = (siteIndex: number): number => {
    if (scratch.evaluatedGeneration[siteIndex] !== generation) {
      const dx = (sampleX - graph.x[siteIndex]!) / frameScale
      const dy = (sampleY - graph.y[siteIndex]!) / frameScale
      scratch.distanceSquaredBySite[siteIndex] = dx * dx + dy * dy
      scratch.evaluatedGeneration[siteIndex] = generation
      distanceEvaluationCount++
    }
    return scratch.distanceSquaredBySite[siteIndex]!
  }
  const improves = (
    candidateIndex: number,
    candidateDistance: number,
    incumbentIndex: number,
    incumbentDistance: number,
  ): boolean =>
    candidateDistance < incumbentDistance ||
    (candidateDistance === incumbentDistance &&
      candidateIndex < incumbentIndex)

  let currentSiteIndex = graph.topologyAnchorSiteIndex
  let currentDistanceSquared = distanceSquared(currentSiteIndex)
  if (graph.topologySites[previousSiteIndex] === 1) {
    const previousDistanceSquared = distanceSquared(previousSiteIndex)
    if (
      improves(
        previousSiteIndex,
        previousDistanceSquared,
        currentSiteIndex,
        currentDistanceSquared,
      )
    ) {
      currentSiteIndex = previousSiteIndex
      currentDistanceSquared = previousDistanceSquared
    }
  }
  const seedDistanceSquared = distanceSquared(seedSiteIndex)
  if (
    improves(
      seedSiteIndex,
      seedDistanceSquared,
      currentSiteIndex,
      currentDistanceSquared,
    )
  ) {
    currentSiteIndex = seedSiteIndex
    currentDistanceSquared = seedDistanceSquared
  }

  while (true) {
    let nextSiteIndex = currentSiteIndex
    let nextDistanceSquared = currentDistanceSquared
    for (
      let offset = graph.offsets[currentSiteIndex]!;
      offset < graph.offsets[currentSiteIndex + 1]!;
      offset++
    ) {
      const candidateIndex = graph.neighbours[offset]!
      const candidateDistance = distanceSquared(candidateIndex)
      if (
        improves(
          candidateIndex,
          candidateDistance,
          nextSiteIndex,
          nextDistanceSquared,
        )
      ) {
        nextSiteIndex = candidateIndex
        nextDistanceSquared = candidateDistance
      }
    }
    if (nextSiteIndex === currentSiteIndex) {
      if (currentSiteIndex > 0) {
        const plateau = [currentSiteIndex]
        const seen = new Set<number>(plateau)
        let plateauSiteIndex = currentSiteIndex
        let descentSiteIndex = -1
        let descentDistanceSquared = currentDistanceSquared
        for (
          let plateauOffset = 0;
          plateauOffset < plateau.length;
          plateauOffset++
        ) {
          const plateauIndex = plateau[plateauOffset]!
          for (
            let offset = graph.offsets[plateauIndex]!;
            offset < graph.offsets[plateauIndex + 1]!;
            offset++
          ) {
            const candidateIndex = graph.neighbours[offset]!
            const candidateDistance = distanceSquared(candidateIndex)
            if (candidateDistance < currentDistanceSquared) {
              if (
                descentSiteIndex < 0 ||
                improves(
                  candidateIndex,
                  candidateDistance,
                  descentSiteIndex,
                  descentDistanceSquared,
                )
              ) {
                descentSiteIndex = candidateIndex
                descentDistanceSquared = candidateDistance
              }
            } else if (candidateDistance === currentDistanceSquared) {
              plateauSiteIndex = Math.min(plateauSiteIndex, candidateIndex)
              if (!seen.has(candidateIndex)) {
                seen.add(candidateIndex)
                plateau.push(candidateIndex)
              }
            }
          }
        }
        if (descentSiteIndex >= 0) {
          currentSiteIndex = descentSiteIndex
          currentDistanceSquared = descentDistanceSquared
          continue
        }
        currentSiteIndex = plateauSiteIndex
      }
      return {
        siteIndex: currentSiteIndex,
        distanceSquared: currentDistanceSquared,
        distanceEvaluationCount,
      }
    }
    currentSiteIndex = nextSiteIndex
    currentDistanceSquared = nextDistanceSquared
  }
}

function includeExactFallbackSites(
  sampleX: number,
  sampleY: number,
  frameScale: number,
  graph: SiteGraph,
  representedNearest: NearestSite,
): NearestSite {
  let siteIndex = representedNearest.siteIndex
  let distanceSquared = representedNearest.distanceSquared
  let distanceEvaluationCount = representedNearest.distanceEvaluationCount
  for (const candidateIndex of graph.exactFallbackSiteIndices) {
    const dx = (sampleX - graph.x[candidateIndex]!) / frameScale
    const dy = (sampleY - graph.y[candidateIndex]!) / frameScale
    const candidateDistanceSquared = dx * dx + dy * dy
    distanceEvaluationCount++
    if (
      candidateDistanceSquared < distanceSquared ||
      (candidateDistanceSquared === distanceSquared &&
        candidateIndex < siteIndex)
    ) {
      siteIndex = candidateIndex
      distanceSquared = candidateDistanceSquared
    }
  }
  return { siteIndex, distanceSquared, distanceEvaluationCount }
}

function validateLattice(
  lattice: Readonly<StipplingDemandLattice>,
  width: number,
  height: number,
): void {
  if (
    !Number.isSafeInteger(lattice.sampleCount) ||
    lattice.sampleCount < 0 ||
    lattice.sampleCount !== lattice.samples.length
  ) {
    throw new RangeError('Voronoi lattice sample count must match its samples')
  }
  for (let sampleIndex = 0; sampleIndex < lattice.samples.length; sampleIndex++) {
    const sample = lattice.samples[sampleIndex]!
    validatePoint(sample.point, width, height, `Voronoi sample ${sampleIndex}`)
    if (
      !Number.isFinite(sample.demand) ||
      sample.demand < 0 ||
      sample.demand > 1
    ) {
      throw new RangeError(
        `Voronoi sample ${sampleIndex} demand must be finite and between 0 and 1`,
      )
    }
  }
}

/**
 * Assign bounded effective-demand quadrature to ordered Stipple sites.
 *
 * Exact-zero demand does no nearest-site work. Positive samples walk a
 * deterministic exact Delaunay-neighbour graph rather than scanning every
 * mark. Equal squared distances always retain the lower ordered-site index.
 */
export function assignStipplingVoronoi(
  model: Readonly<Pick<StipplingModel, 'frame' | 'lattice'>>,
  marks: readonly Readonly<StippleMark>[],
): StipplingVoronoiAssignment {
  const { frame, lattice } = model
  if (
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    throw new RangeError('Voronoi frame must have finite positive dimensions')
  }
  validateLattice(lattice, frame.width, frame.height)

  const frameScale = Math.max(frame.width, frame.height)
  const normalizedDiagonalSquared =
    (frame.width / frameScale) ** 2 + (frame.height / frameScale) ** 2
  const graph = createSiteGraph(
    marks,
    frame.width,
    frame.height,
    frameScale,
  )
  const assignments: Array<number | null> = new Array(
    lattice.sampleCount,
  ).fill(null)
  const mutableCells: MutableCell[] = marks.map(() => ({
    weight: 0,
    centroidX: 0,
    centroidY: 0,
  }))
  let assignedSampleCount = 0
  let distanceEvaluationCount = 0
  let seedLookupCount = 0
  let totalWeight = 0
  let normalizedDistanceSum = 0
  let previousSiteIndex = 0
  const queryScratch: QueryScratch = {
    generation: 0,
    evaluatedGeneration: new Uint32Array(marks.length),
    distanceSquaredBySite: new Float64Array(marks.length),
  }

  if (marks.length > 0) {
    for (
      let sampleIndex = 0;
      sampleIndex < lattice.samples.length;
      sampleIndex++
    ) {
      const sample = lattice.samples[sampleIndex]!
      if (sample.demand === 0) continue

      let nearest: NearestSite
      if (graph.collinear === null) {
        const seed = adaptiveSeed(
          sample.point[0],
          sample.point[1],
          graph,
        )
        seedLookupCount += seed.lookupCount
        nearest = includeExactFallbackSites(
          sample.point[0],
          sample.point[1],
          frameScale,
          graph,
          nearestSite(
            sample.point[0],
            sample.point[1],
            frameScale,
            graph,
            previousSiteIndex,
            seed.siteIndex,
            queryScratch,
          ),
        )
      } else {
        nearest = nearestCollinearSite(
          sample.point[0],
          sample.point[1],
          frameScale,
          graph,
          graph.collinear,
        )
      }
      previousSiteIndex = nearest.siteIndex
      assignments[sampleIndex] = nearest.siteIndex
      assignedSampleCount++
      distanceEvaluationCount += nearest.distanceEvaluationCount
      totalWeight += sample.demand
      normalizedDistanceSum += sample.demand * nearest.distanceSquared

      const cell = mutableCells[nearest.siteIndex]!
      const nextWeight = cell.weight + sample.demand
      const interpolation = sample.demand / nextWeight
      cell.centroidX += (sample.point[0] - cell.centroidX) * interpolation
      cell.centroidY += (sample.point[1] - cell.centroidY) * interpolation
      cell.weight = nextWeight
    }
  } else {
    for (const sample of lattice.samples) totalWeight += sample.demand
  }

  const cells = mutableCells.map((cell, orderedSiteIndex) =>
    Object.freeze({
      siteIndex: orderedSiteIndex,
      weight: cell.weight,
      centroid:
        cell.weight === 0
          ? null
          : Object.freeze([cell.centroidX, cell.centroidY] as Point),
    }),
  )

  return Object.freeze({
    assignments: Object.freeze(assignments),
    cells: Object.freeze(cells),
    totalWeight,
    normalizedObjective:
      totalWeight === 0 || marks.length === 0
        ? 0
        : normalizedDistanceSum / totalWeight / normalizedDiagonalSquared,
    work: Object.freeze({
      sampleCount: lattice.sampleCount,
      assignedSampleCount,
      distanceEvaluationCount,
      seedLookupCount,
      indexBuildOperationCount: graph.buildOperationCount,
    }),
  })
}
