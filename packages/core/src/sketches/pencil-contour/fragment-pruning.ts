/**
 * Immutable-topology fragment selection for Pencil Contour.
 *
 * The full luminance evidence universe is partitioned once into edge-disjoint
 * trails. Detail only admits evidence IDs; smoothing only consumes a prefix of
 * the removable trail ranking. Neither control can therefore change a trail's
 * identity or rank.
 */

import type { Point } from '../../types'
import type {
  LocalizedEdge,
  LocalizedEdgeGraph,
  LocalizedLuminanceEdgeEvidence,
} from './types'

const MIN_FRAGMENT_LENGTH = 0.5
const MAX_FRAGMENT_LENGTH = 2.5

// Qualification is deliberately conservative: only short trails whose
// strongest sample is still secondary evidence can enter the smoothing prefix.
const MAX_REMOVABLE_SPUR_LENGTH = 6.5
const MAX_REMOVABLE_ISOLATED_LENGTH = 7.5
const MAX_REMOVABLE_SPUR_STRENGTH = 0.285
const MAX_REMOVABLE_ISOLATED_STRENGTH = 0.27

export type PencilContourTrailDisposition =
  | 'protected-cycle'
  | 'protected-through'
  | 'removable-spur'
  | 'removable-isolated'
  | 'protected'

export interface PencilContourEvidenceTrail {
  readonly edgeIds: readonly string[]
  readonly canonicalEdgeId: string
  readonly length: number
  readonly maximumStrength: number
  readonly meanStrength: number
  readonly disposition: PencilContourTrailDisposition
}

export interface PencilContourFragmentClassification {
  readonly trails: readonly Readonly<PencilContourEvidenceTrail>[]
  readonly protectedEdgeIds: ReadonlySet<string>
  readonly removableEdgeIds: ReadonlySet<string>
  readonly removableTrails: readonly Readonly<PencilContourEvidenceTrail>[]
}

export interface PencilContourFragmentMasks {
  readonly baseRemovalEdgeIds: ReadonlySet<string>
  readonly additionalRemovalEdgeIds: ReadonlySet<string>
  readonly protectedEdgeIds: ReadonlySet<string>
}

function pointKey(point: Readonly<Point>): string {
  return `${point[0]},${point[1]}`
}

function compareIds(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0
}

function finitePoint(point: unknown): point is Readonly<Point> {
  return (
    Array.isArray(point) &&
    point.length === 2 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1])
  )
}

function edgeLength(edge: {
  readonly start: Readonly<Point>
  readonly end: Readonly<Point>
}): number {
  return Math.hypot(
    edge.end[0] - edge.start[0],
    edge.end[1] - edge.start[1],
  )
}

function validEvidence(
  value: unknown,
): value is Readonly<LocalizedLuminanceEdgeEvidence> {
  if (value === null || typeof value !== 'object') return false
  const evidence = value as Readonly<LocalizedLuminanceEdgeEvidence>
  return (
    typeof evidence.id === 'string' &&
    evidence.id.length > 0 &&
    Number.isFinite(evidence.strength) &&
    evidence.strength >= 0 &&
    finitePoint(evidence.start) &&
    finitePoint(evidence.end) &&
    pointKey(evidence.start) !== pointKey(evidence.end) &&
    Array.isArray(evidence.adjacentEdgeIds) &&
    evidence.adjacentEdgeIds.every((id) => typeof id === 'string')
  )
}

function emptyClassification(): Readonly<PencilContourFragmentClassification> {
  return Object.freeze({
    trails: Object.freeze([]),
    protectedEdgeIds: new Set<string>(),
    removableEdgeIds: new Set<string>(),
    removableTrails: Object.freeze([]),
  })
}

function sharedEndpoint(
  first: Readonly<LocalizedLuminanceEdgeEvidence>,
  second: Readonly<LocalizedLuminanceEdgeEvidence>,
): boolean {
  const firstStart = pointKey(first.start)
  const firstEnd = pointKey(first.end)
  const secondStart = pointKey(second.start)
  const secondEnd = pointKey(second.end)
  return (
    firstStart === secondStart ||
    firstStart === secondEnd ||
    firstEnd === secondStart ||
    firstEnd === secondEnd
  )
}

function compareRemovableTrails(
  first: Readonly<PencilContourEvidenceTrail>,
  second: Readonly<PencilContourEvidenceTrail>,
): number {
  const firstKind = first.disposition === 'removable-isolated' ? 0 : 1
  const secondKind = second.disposition === 'removable-isolated' ? 0 : 1
  return (
    firstKind - secondKind ||
    first.length - second.length ||
    first.maximumStrength - second.maximumStrength ||
    first.meanStrength - second.meanStrength ||
    compareIds(first.canonicalEdgeId, second.canonicalEdgeId)
  )
}

/**
 * Partition every immutable luminance evidence ID into one protected or
 * removable trail. Malformed or ambiguous topology fails safe to protection.
 */
export function classifyPencilContourFragments(
  graph: Readonly<LocalizedEdgeGraph>,
): Readonly<PencilContourFragmentClassification> {
  if (!Array.isArray(graph.luminanceEvidence)) return emptyClassification()
  const evidence: Readonly<LocalizedLuminanceEdgeEvidence>[] =
    graph.luminanceEvidence.slice().sort((first, second) =>
    compareIds(first.id, second.id),
    )
  if (
    evidence.some((edge) => !validEvidence(edge)) ||
    new Set(evidence.map(({ id }) => id)).size !== evidence.length
  ) {
    return emptyClassification()
  }

  const evidenceById = new Map(evidence.map((edge) => [edge.id, edge]))
  const adjacency = new Map<string, readonly string[]>()
  let topologyIsValid = true
  for (const edge of evidence) {
    const neighbours = [...new Set(edge.adjacentEdgeIds)].sort()
    if (
      neighbours.length > 2 ||
      neighbours.some((id) => {
        const neighbour = evidenceById.get(id)
        return (
          id === edge.id ||
          neighbour === undefined ||
          !neighbour.adjacentEdgeIds.includes(edge.id) ||
          !sharedEndpoint(edge, neighbour)
        )
      })
    ) {
      topologyIsValid = false
    }
    adjacency.set(edge.id, Object.freeze(neighbours))
  }
  if (!topologyIsValid) {
    const protectedEdgeIds = new Set(evidence.map(({ id }) => id))
    return Object.freeze({
      trails: Object.freeze(evidence.map((edge) => Object.freeze({
        edgeIds: Object.freeze([edge.id]),
        canonicalEdgeId: edge.id,
        length: edgeLength(edge),
        maximumStrength: edge.strength,
        meanStrength: edge.strength,
        disposition: 'protected' as const,
      }))),
      protectedEdgeIds,
      removableEdgeIds: new Set<string>(),
      removableTrails: Object.freeze([]),
    })
  }

  const vertexIncidence = new Map<string, string[]>()
  const addIncidence = (point: Readonly<Point>, id: string) => {
    const key = pointKey(point)
    const ids = vertexIncidence.get(key)
    if (ids === undefined) vertexIncidence.set(key, [id])
    else ids.push(id)
  }
  for (const edge of evidence) {
    addIncidence(edge.start, edge.id)
    addIncidence(edge.end, edge.id)
  }

  // Raw endpoint connectivity identifies whether an open trail is the whole
  // disconnected component or merely one arm attached at a junction.
  const rawAdjacency = new Map(evidence.map(({ id }) => [id, new Set<string>()]))
  for (const ids of vertexIncidence.values()) {
    for (const first of ids) {
      for (const second of ids) {
        if (first !== second) rawAdjacency.get(first)!.add(second)
      }
    }
  }
  const rawComponentById = new Map<string, ReadonlySet<string>>()
  for (const edge of evidence) {
    if (rawComponentById.has(edge.id)) continue
    const component = new Set<string>()
    const pending = [edge.id]
    while (pending.length > 0) {
      const id = pending.pop()!
      if (component.has(id)) continue
      component.add(id)
      for (const neighbour of rawAdjacency.get(id) ?? []) pending.push(neighbour)
    }
    for (const id of component) rawComponentById.set(id, component)
  }

  const visited = new Set<string>()
  const trailIds: string[][] = []
  const starts = evidence
    .filter(({ id }) => adjacency.get(id)!.length < 2)
    .map(({ id }) => id)
  const walk = (startId: string) => {
    if (visited.has(startId)) return
    const ids: string[] = []
    let previous: string | undefined
    let current: string | undefined = startId
    while (current !== undefined && !visited.has(current)) {
      visited.add(current)
      ids.push(current)
      const next: string | undefined = adjacency
        .get(current)!
        .find((id) => id !== previous)
      previous = current
      current = next
    }
    trailIds.push(ids)
  }
  for (const id of starts) walk(id)
  for (const { id } of evidence) walk(id)

  const trails: Readonly<PencilContourEvidenceTrail>[] = []
  const protectedEdgeIds = new Set<string>()
  const removableEdgeIds = new Set<string>()
  for (const ids of trailIds) {
    const edges = ids.map((id) => evidenceById.get(id)!)
    const idSet = new Set(ids)
    const subgraphIncidence = new Map<string, number>()
    for (const edge of edges) {
      for (const key of [pointKey(edge.start), pointKey(edge.end)]) {
        subgraphIncidence.set(key, (subgraphIncidence.get(key) ?? 0) + 1)
      }
    }
    const endpointKeys = [...subgraphIncidence]
      .filter(([, count]) => count === 1)
      .map(([key]) => key)
      .sort()
    const passesPairedJunction = [...subgraphIncidence].some(
      ([key, count]) =>
        count === 2 && (vertexIncidence.get(key)?.length ?? 0) > 2,
    )
    const length = edges.reduce((sum, edge) => sum + edgeLength(edge), 0)
    const maximumStrength = Math.max(...edges.map(({ strength }) => strength))
    const meanStrength =
      edges.reduce((sum, { strength }) => sum + strength, 0) / edges.length
    let disposition: PencilContourTrailDisposition = 'protected'

    if (endpointKeys.length === 0 && edges.every(({ id }) =>
      adjacency.get(id)!.length === 2,
    )) {
      disposition = 'protected-cycle'
    } else if (endpointKeys.length === 2) {
      const endpointDegrees = endpointKeys.map(
        (key) => vertexIncidence.get(key)?.length ?? 0,
      )
      if (
        passesPairedJunction ||
        endpointDegrees.every((degree) => degree > 1)
      ) {
        disposition = 'protected-through'
      } else if (
        endpointDegrees.includes(1) &&
        endpointDegrees.some((degree) => degree > 2)
      ) {
        if (
          length <= MAX_REMOVABLE_SPUR_LENGTH &&
          maximumStrength <= MAX_REMOVABLE_SPUR_STRENGTH
        ) {
          disposition = 'removable-spur'
        }
      } else if (endpointDegrees.every((degree) => degree === 1)) {
        const rawComponent = rawComponentById.get(ids[0]!)
        const isEntireComponent =
          rawComponent !== undefined &&
          rawComponent.size === idSet.size &&
          [...rawComponent].every((id) => idSet.has(id))
        if (
          isEntireComponent &&
          length <= MAX_REMOVABLE_ISOLATED_LENGTH &&
          maximumStrength <= MAX_REMOVABLE_ISOLATED_STRENGTH
        ) {
          disposition = 'removable-isolated'
        }
      }
    }

    const trail = Object.freeze({
      edgeIds: Object.freeze(ids.slice().sort()),
      canonicalEdgeId: ids.slice().sort()[0]!,
      length,
      maximumStrength,
      meanStrength,
      disposition,
    })
    trails.push(trail)
    const destination = disposition.startsWith('removable-')
      ? removableEdgeIds
      : protectedEdgeIds
    for (const id of ids) destination.add(id)
  }

  const removableTrails = trails
    .filter(({ disposition }) => disposition.startsWith('removable-'))
    .sort(compareRemovableTrails)
  trails.sort((first, second) =>
    compareIds(first.canonicalEdgeId, second.canonicalEdgeId),
  )
  return Object.freeze({
    trails: Object.freeze(trails),
    protectedEdgeIds,
    removableEdgeIds,
    removableTrails: Object.freeze(removableTrails),
  })
}

function componentRemovalIndices(
  graph: Readonly<LocalizedEdgeGraph>,
  detail: number,
): ReadonlySet<number> {
  const minimumLength =
    MAX_FRAGMENT_LENGTH -
    detail * (MAX_FRAGMENT_LENGTH - MIN_FRAGMENT_LENGTH)
  const incidence = new Map<string, number[]>()
  const lengths: number[] = []
  const validIndices: number[] = []
  const add = (key: string, index: number) => {
    const indices = incidence.get(key)
    if (indices === undefined) incidence.set(key, [index])
    else indices.push(index)
  }
  graph.edges.forEach((edge, index) => {
    if (
      !finitePoint(edge?.start) ||
      !finitePoint(edge?.end) ||
      (edge?.provenance?.kind !== 'luminance' &&
        edge?.provenance?.kind !== 'alpha-boundary')
    ) {
      return
    }
    const length = edgeLength(edge)
    if (!(length > 0)) return
    lengths[index] = length
    validIndices.push(index)
    const prefix = edge.provenance.kind
    add(`${prefix}:${pointKey(edge.start)}`, index)
    add(`${prefix}:${pointKey(edge.end)}`, index)
  })

  const visited = new Set<number>()
  const removed = new Set<number>()
  for (const start of validIndices) {
    if (visited.has(start)) continue
    const component: number[] = []
    const pending = [start]
    let totalLength = 0
    while (pending.length > 0) {
      const index = pending.pop()!
      if (visited.has(index)) continue
      visited.add(index)
      component.push(index)
      totalLength += lengths[index]!
      const edge = graph.edges[index]!
      const prefix = edge.provenance.kind
      for (const key of [
        `${prefix}:${pointKey(edge.start)}`,
        `${prefix}:${pointKey(edge.end)}`,
      ]) {
        for (const neighbour of incidence.get(key) ?? []) pending.push(neighbour)
      }
    }
    if (totalLength < minimumLength) {
      for (const index of component) removed.add(index)
    }
  }
  return removed
}

/**
 * Return the legacy detail-dependent component mask and the independent,
 * smoothing-dependent removable-trail prefix for diagnostics and tests.
 */
export function pencilContourFragmentMasks(
  graph: Readonly<LocalizedEdgeGraph>,
  detail: number,
  smoothing: number,
): Readonly<PencilContourFragmentMasks> {
  const normalizedDetail = Math.max(0, Math.min(1, detail))
  const normalizedSmoothing = Math.max(0, Math.min(1, smoothing))
  const selectedIds = Array.isArray(graph.selectedLuminanceEdgeIds)
    ? graph.selectedLuminanceEdgeIds
    : []
  const baseIndices = componentRemovalIndices(graph, normalizedDetail)
  const baseRemovalEdgeIds = new Set<string>()
  for (const index of baseIndices) {
    const id = selectedIds[index]
    if (id !== undefined) baseRemovalEdgeIds.add(id)
  }

  const classification = classifyPencilContourFragments(graph)
  const prefixLength = Math.floor(
    classification.removableTrails.length * normalizedSmoothing,
  )
  const additionalRemovalEdgeIds = new Set<string>()
  for (let index = 0; index < prefixLength; index += 1) {
    for (const id of classification.removableTrails[index]!.edgeIds) {
      additionalRemovalEdgeIds.add(id)
    }
  }
  return Object.freeze({
    baseRemovalEdgeIds,
    additionalRemovalEdgeIds,
    protectedEdgeIds: classification.protectedEdgeIds,
  })
}

/** Apply both removal masks before tracing, retaining canonical source order. */
export function prunePencilContourGraph(
  graph: Readonly<LocalizedEdgeGraph>,
  detail: number,
  smoothing: number,
): Readonly<LocalizedEdgeGraph> {
  if (
    !Array.isArray(graph.edges) ||
    !Array.isArray(graph.selectedLuminanceEdgeIds) ||
    !Array.isArray(graph.luminanceEvidence)
  ) {
    return graph
  }
  const selectedIds = graph.selectedLuminanceEdgeIds
  const luminanceEdges = graph.edges.filter(
    ({ provenance }) => provenance.kind === 'luminance',
  )
  if (luminanceEdges.length !== selectedIds.length) return graph

  const masks = pencilContourFragmentMasks(graph, detail, smoothing)
  const removedIds = new Set([
    ...masks.baseRemovalEdgeIds,
    ...masks.additionalRemovalEdgeIds,
  ])
  const keptIds: string[] = []
  const keptEdges: Readonly<LocalizedEdge>[] = []
  for (const [index, id] of selectedIds.entries()) {
    if (!removedIds.has(id)) {
      keptIds.push(id)
      keptEdges.push(luminanceEdges[index]!)
    }
  }

  const alphaEdges = graph.edges.filter(
    ({ provenance }) => provenance.kind === 'alpha-boundary',
  )
  const baseIndices = componentRemovalIndices(
    graph,
    Math.max(0, Math.min(1, detail)),
  )
  const firstAlphaIndex = luminanceEdges.length
  alphaEdges.forEach((edge, alphaIndex) => {
    if (!baseIndices.has(firstAlphaIndex + alphaIndex)) keptEdges.push(edge)
  })

  return Object.freeze({
    ...graph,
    selectedLuminanceEdgeIds: Object.freeze(keptIds),
    edges: Object.freeze(keptEdges),
  })
}

/** Fixed policy exported only for transparent fixture diagnostics. */
export const pencilContourFragmentPolicy = Object.freeze({
  maximumSpurLength: MAX_REMOVABLE_SPUR_LENGTH,
  maximumIsolatedLength: MAX_REMOVABLE_ISOLATED_LENGTH,
  maximumSpurStrength: MAX_REMOVABLE_SPUR_STRENGTH,
  maximumIsolatedStrength: MAX_REMOVABLE_ISOLATED_STRENGTH,
})
