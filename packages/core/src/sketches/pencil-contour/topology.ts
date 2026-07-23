/**
 * Stable exact-endpoint contour adjacency shared by localization and tracing.
 * No proximity tolerance or inferred bridge participates in this topology.
 */

import type { Point } from '../../types'

export interface TopologyEdge {
  readonly start: Readonly<Point>
  readonly end: Readonly<Point>
}

export interface DirectionCompatibleTopology {
  readonly adjacency: readonly (readonly number[])[]
  readonly pairings: ReadonlyMap<string, ReadonlyMap<number, number>>
}

const MAX_STRAIGHT_THROUGH_DOT = -Math.SQRT1_2

function comparePoints(
  first: Readonly<Point>,
  second: Readonly<Point>,
): number {
  return first[1] - second[1] || first[0] - second[0]
}

function pointKey(point: Readonly<Point>): string {
  return `${point[0]},${point[1]}`
}

function compareCanonicalEdges(
  first: Readonly<TopologyEdge>,
  second: Readonly<TopologyEdge>,
): number {
  const firstStart =
    comparePoints(first.start, first.end) <= 0 ? first.start : first.end
  const firstEnd = firstStart === first.start ? first.end : first.start
  const secondStart =
    comparePoints(second.start, second.end) <= 0 ? second.start : second.end
  const secondEnd = secondStart === second.start ? second.end : second.start
  return (
    comparePoints(firstStart, secondStart) || comparePoints(firstEnd, secondEnd)
  )
}

interface Incidence {
  readonly edgeIndex: number
  readonly other: Readonly<Point>
}

/**
 * Return at most one continuation at each endpoint for every edge.
 *
 * Degree-two vertices preserve tracing's unconditional continuation. Higher
 * degree vertices use its canonical straight-through greedy pairing. The
 * canonical edge order makes the result independent of caller input order.
 */
export function directionCompatibleTopology(
  sourceEdges: readonly Readonly<TopologyEdge>[],
): Readonly<DirectionCompatibleTopology> {
  const canonical = sourceEdges
    .map((edge, sourceIndex) => ({ edge, sourceIndex }))
    .sort(
      (first, second) =>
        compareCanonicalEdges(first.edge, second.edge) ||
        first.sourceIndex - second.sourceIndex,
    )
  const canonicalIndexBySource = new Map<number, number>()
  canonical.forEach(({ sourceIndex }, canonicalIndex) => {
    canonicalIndexBySource.set(sourceIndex, canonicalIndex)
  })

  const incidences = new Map<string, Incidence[]>()
  const add = (
    point: Readonly<Point>,
    other: Readonly<Point>,
    canonicalIndex: number,
  ) => {
    const key = pointKey(point)
    const existing = incidences.get(key)
    const incidence = { edgeIndex: canonicalIndex, other }
    if (existing === undefined) incidences.set(key, [incidence])
    else existing.push(incidence)
  }
  canonical.forEach(({ edge }, canonicalIndex) => {
    add(edge.start, edge.end, canonicalIndex)
    add(edge.end, edge.start, canonicalIndex)
  })

  const adjacency = canonical.map(() => new Set<number>())
  const canonicalPairings = new Map<string, Map<number, number>>()
  const pair = (key: string, first: number, second: number) => {
    adjacency[first]!.add(second)
    adjacency[second]!.add(first)
    let pairings = canonicalPairings.get(key)
    if (pairings === undefined) {
      pairings = new Map<number, number>()
      canonicalPairings.set(key, pairings)
    }
    pairings.set(first, second)
    pairings.set(second, first)
  }
  for (const [key, vertexIncidences] of incidences) {
    vertexIncidences.sort(
      (first, second) =>
        comparePoints(first.other, second.other) ||
        first.edgeIndex - second.edgeIndex,
    )
    if (vertexIncidences.length === 2) {
      const first = vertexIncidences[0]!.edgeIndex
      const second = vertexIncidences[1]!.edgeIndex
      pair(key, first, second)
      continue
    }
    if (vertexIncidences.length <= 1) continue

    const [xText, yText] = key.split(',')
    const vertexX = Number(xText)
    const vertexY = Number(yText)
    const candidates: { first: number; second: number; dot: number }[] = []
    for (
      let firstIndex = 0;
      firstIndex < vertexIncidences.length;
      firstIndex += 1
    ) {
      const first = vertexIncidences[firstIndex]!
      const firstX = first.other[0] - vertexX
      const firstY = first.other[1] - vertexY
      const firstLength = Math.hypot(firstX, firstY)
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < vertexIncidences.length;
        secondIndex += 1
      ) {
        const second = vertexIncidences[secondIndex]!
        const secondX = second.other[0] - vertexX
        const secondY = second.other[1] - vertexY
        const secondLength = Math.hypot(secondX, secondY)
        const dot =
          (firstX * secondX + firstY * secondY) / (firstLength * secondLength)
        if (dot < MAX_STRAIGHT_THROUGH_DOT) {
          candidates.push({
            first: Math.min(first.edgeIndex, second.edgeIndex),
            second: Math.max(first.edgeIndex, second.edgeIndex),
            dot,
          })
        }
      }
    }
    candidates.sort(
      (first, second) =>
        first.dot - second.dot ||
        first.first - second.first ||
        first.second - second.second,
    )
    const paired = new Set<number>()
    for (const candidate of candidates) {
      if (paired.has(candidate.first) || paired.has(candidate.second)) continue
      paired.add(candidate.first)
      paired.add(candidate.second)
      pair(key, candidate.first, candidate.second)
    }
  }

  const sourceAdjacency = sourceEdges.map(() => [] as number[])
  canonical.forEach(({ sourceIndex }, canonicalIndex) => {
    sourceAdjacency[sourceIndex] = [...adjacency[canonicalIndex]!]
      .map(
        (adjacentCanonicalIndex) =>
          canonical[adjacentCanonicalIndex]!.sourceIndex,
      )
      .sort(
        (first, second) =>
          (canonicalIndexBySource.get(first) ?? 0) -
          (canonicalIndexBySource.get(second) ?? 0),
      )
  })
  const pairings = new Map<string, ReadonlyMap<number, number>>()
  for (const [key, canonicalVertexPairings] of canonicalPairings) {
    const sourcePairings = new Map<number, number>()
    for (const [first, second] of canonicalVertexPairings) {
      sourcePairings.set(
        canonical[first]!.sourceIndex,
        canonical[second]!.sourceIndex,
      )
    }
    pairings.set(key, sourcePairings)
  }
  return Object.freeze({
    adjacency: Object.freeze(
      sourceAdjacency.map((neighbours) => Object.freeze(neighbours)),
    ),
    pairings,
  })
}

export function directionCompatibleAdjacency(
  sourceEdges: readonly Readonly<TopologyEdge>[],
): readonly (readonly number[])[] {
  return directionCompatibleTopology(sourceEdges).adjacency
}
