/**
 * Deterministic tracing for the once-owned Watercolor Forms boundary network.
 *
 * Continuations are local and conservative. Two incidences may continue only
 * when they describe the same region interface, turn by at most 90 degrees,
 * and are each other's unique smoothest choice. Choices within one degree are
 * deliberately ambiguous: tracing stops instead of using an identity tie-break
 * to invent a bridge. Identities order already-supported geometry; they never
 * decide whether that geometry should connect.
 */

import type { Point } from '../../types'
import {
  WATERCOLOR_FORMS_LIMITS,
  type WatercolorFormsLimitName,
} from './limits'
import type {
  SharedBoundarySegment,
  WatercolorBoundaryPath,
  WatercolorFormsTermination,
} from './types'

const MAX_TURN_RADIANS = Math.PI / 2
const AMBIGUOUS_TURN_DELTA_RADIANS = Math.PI / 180
const ANGLE_EPSILON = 1e-12
// A canonical planar lattice vertex has at most four incident edge segments.
const MAX_VERTEX_DEGREE = 4

type TracingLimitName =
  | 'maxRetainedBoundarySegmentCount'
  | 'maxBoundaryPathCount'

export interface WatercolorBoundaryTracingLimits {
  readonly maxRetainedBoundarySegmentCount?: number
  readonly maxBoundaryPathCount?: number
}

/**
 * Stage-local accounting. `validSegmentCount` counts unique valid input
 * segments before output caps; `consumedSegmentCount` counts only segments in
 * the returned paths. They are equal exactly when tracing completes.
 */
export interface WatercolorBoundaryTracingDiagnostics {
  readonly termination: WatercolorFormsTermination
  readonly limitedBy: WatercolorFormsLimitName | null
  readonly inputSegmentCount: number
  readonly validSegmentCount: number
  readonly duplicateSegmentCount: number
  readonly invalidSegmentCount: number
  /** Vertices conservatively left unpaired because they exceeded lattice degree. */
  readonly overfullVertexCount: number
  readonly consumedSegmentCount: number
  readonly boundaryPathCount: number
}

export interface WatercolorBoundaryTracingResult {
  readonly paths: readonly Readonly<WatercolorBoundaryPath>[]
  readonly diagnostics: Readonly<WatercolorBoundaryTracingDiagnostics>
}

interface CanonicalSegment {
  readonly id: number
  readonly regionIds: readonly [number, number]
  readonly interfaceKey: string
  readonly start: Readonly<Point>
  readonly end: Readonly<Point>
  readonly startKey: string
  readonly endKey: string
  readonly strength: number
  readonly provenance: SharedBoundarySegment['provenance']
  readonly signature: string
  readonly geometryKey: string
}

interface TraceVertex {
  readonly key: string
  readonly point: Readonly<Point>
  readonly segmentIds: number[]
}

interface TraceGraph {
  readonly segments: ReadonlyMap<number, CanonicalSegment>
  readonly vertices: ReadonlyMap<string, TraceVertex>
  readonly pairings: ReadonlyMap<string, ReadonlyMap<number, number>>
  readonly overfullVertexCount: number
}

interface MutablePath {
  readonly points: Readonly<Point>[]
  readonly segmentIds: number[]
  readonly closed: boolean
}

interface ValidatedSegments {
  readonly segments: readonly CanonicalSegment[]
  readonly duplicateCount: number
  readonly invalidCount: number
}

function frozenPoint(point: Readonly<Point>): Readonly<Point> {
  const x = Object.is(point[0], -0) ? 0 : point[0]
  const y = Object.is(point[1], -0) ? 0 : point[1]
  return Object.freeze([x, y] as Point)
}

function comparePoints(
  first: Readonly<Point>,
  second: Readonly<Point>,
): number {
  return first[1] - second[1] || first[0] - second[0]
}

function pointKey(point: Readonly<Point>): string {
  // String normalizes -0 to 0, agreeing with JavaScript numeric equality.
  return `${point[0]},${point[1]}`
}

function validPoint(value: unknown): value is Readonly<Point> {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  )
}

function canonicalSegment(value: unknown): CanonicalSegment | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const segment = value as Readonly<SharedBoundarySegment>
  if (
    !Number.isSafeInteger(segment.id) ||
    segment.id < 0 ||
    !Array.isArray(segment.regionIds) ||
    segment.regionIds.length !== 2 ||
    !Number.isSafeInteger(segment.regionIds[0]) ||
    !Number.isSafeInteger(segment.regionIds[1]) ||
    segment.regionIds[0] < 0 ||
    segment.regionIds[0] >= segment.regionIds[1] ||
    !validPoint(segment.start) ||
    !validPoint(segment.end) ||
    (segment.start[0] === segment.end[0] &&
      segment.start[1] === segment.end[1]) ||
    typeof segment.strength !== 'number' ||
    !Number.isFinite(segment.strength) ||
    segment.strength < 0 ||
    segment.strength > 1 ||
    (segment.provenance !== 'visible-color' &&
      segment.provenance !== 'alpha-boundary')
  ) {
    return undefined
  }

  const inputStart = frozenPoint(segment.start)
  const inputEnd = frozenPoint(segment.end)
  const start =
    comparePoints(inputStart, inputEnd) <= 0 ? inputStart : inputEnd
  const end = start === inputStart ? inputEnd : inputStart
  const startKey = pointKey(start)
  const endKey = pointKey(end)
  const interfaceKey = `${segment.regionIds[0]}:${segment.regionIds[1]}`
  const geometryKey = `${startKey}|${endKey}`
  const signature = [
    interfaceKey,
    geometryKey,
    segment.strength,
    segment.provenance,
  ].join('|')

  return {
    id: segment.id,
    regionIds: Object.freeze([
      segment.regionIds[0],
      segment.regionIds[1],
    ]) as readonly [number, number],
    interfaceKey,
    start,
    end,
    startKey,
    endKey,
    strength: segment.strength,
    provenance: segment.provenance,
    signature,
    geometryKey,
  }
}

/**
 * Exact repeats collapse to one segment. Conflicting uses of either a segment
 * identity or a geometric lattice edge are all rejected, so input order can
 * never choose which incompatible record survives.
 */
function validateSegments(values: readonly unknown[]): ValidatedSegments {
  const valid: CanonicalSegment[] = []
  let invalidCount = 0
  for (const value of values) {
    const segment = canonicalSegment(value)
    if (segment === undefined) invalidCount += 1
    else valid.push(segment)
  }
  valid.sort(
    (first, second) =>
      first.id - second.id ||
      (first.signature < second.signature
        ? -1
        : first.signature > second.signature
          ? 1
          : 0),
  )

  let duplicateCount = 0
  const identityUnique: CanonicalSegment[] = []
  for (let index = 0; index < valid.length; ) {
    let end = index + 1
    while (end < valid.length && valid[end]!.id === valid[index]!.id) end += 1
    const group = valid.slice(index, end)
    const signature = group[0]!.signature
    if (group.every((candidate) => candidate.signature === signature)) {
      identityUnique.push(group[0]!)
      duplicateCount += group.length - 1
    } else {
      invalidCount += group.length
    }
    index = end
  }

  const byGeometry = new Map<string, CanonicalSegment[]>()
  for (const segment of identityUnique) {
    const group = byGeometry.get(segment.geometryKey)
    if (group === undefined) byGeometry.set(segment.geometryKey, [segment])
    else group.push(segment)
  }

  const unique: CanonicalSegment[] = []
  for (const group of byGeometry.values()) {
    group.sort((first, second) => first.id - second.id)
    const signatureWithoutIdentity = group[0]!.signature
    if (
      group.every(
        (candidate) => candidate.signature === signatureWithoutIdentity,
      )
    ) {
      unique.push(group[0]!)
      duplicateCount += group.length - 1
    } else {
      invalidCount += group.length
    }
  }
  unique.sort((first, second) => first.id - second.id)
  return { segments: unique, duplicateCount, invalidCount }
}

function otherPoint(
  segment: CanonicalSegment,
  vertexKey: string,
): Readonly<Point> {
  return segment.startKey === vertexKey ? segment.end : segment.start
}

function otherVertexKey(
  segment: CanonicalSegment,
  vertexKey: string,
): string {
  return segment.startKey === vertexKey ? segment.endKey : segment.startKey
}

function turnDeviation(
  vertex: Readonly<Point>,
  firstOther: Readonly<Point>,
  secondOther: Readonly<Point>,
): number {
  const firstX = firstOther[0] - vertex[0]
  const firstY = firstOther[1] - vertex[1]
  const secondX = secondOther[0] - vertex[0]
  const secondY = secondOther[1] - vertex[1]
  const denominator =
    Math.hypot(firstX, firstY) * Math.hypot(secondX, secondY)
  const cosine = Math.max(
    -1,
    Math.min(1, (firstX * secondX + firstY * secondY) / denominator),
  )
  // Opposite outward rays are a straight traversal through the vertex.
  return Math.PI - Math.acos(cosine)
}

function buildPairings(
  segments: ReadonlyMap<number, CanonicalSegment>,
  vertices: ReadonlyMap<string, TraceVertex>,
): Readonly<{
  readonly pairings: ReadonlyMap<string, ReadonlyMap<number, number>>
  readonly overfullVertexCount: number
}> {
  const pairings = new Map<string, ReadonlyMap<number, number>>()
  let overfullVertexCount = 0

  for (const vertex of vertices.values()) {
    // Do not let malformed non-lattice fan-outs turn mutual-best selection into
    // quadratic work. Stopping every incidence is the conservative topology.
    if (vertex.segmentIds.length > MAX_VERTEX_DEGREE) {
      overfullVertexCount += 1
      continue
    }
    const best = new Map<number, number>()
    for (const segmentId of vertex.segmentIds) {
      const segment = segments.get(segmentId)!
      const candidates = vertex.segmentIds
        .filter((candidateId) => {
          if (candidateId === segmentId) return false
          return (
            segments.get(candidateId)!.interfaceKey === segment.interfaceKey
          )
        })
        .map((candidateId) => ({
          id: candidateId,
          turn: turnDeviation(
            vertex.point,
            otherPoint(segment, vertex.key),
            otherPoint(segments.get(candidateId)!, vertex.key),
          ),
        }))
        .filter(({ turn }) => turn <= MAX_TURN_RADIANS + ANGLE_EPSILON)
        .sort(
          (first, second) => first.turn - second.turn || first.id - second.id,
        )
      if (candidates.length === 0) continue
      if (
        candidates.length > 1 &&
        candidates[1]!.turn - candidates[0]!.turn <=
          AMBIGUOUS_TURN_DELTA_RADIANS + ANGLE_EPSILON
      ) {
        continue
      }
      best.set(segmentId, candidates[0]!.id)
    }

    const mutual = new Map<number, number>()
    for (const [segmentId, candidateId] of best) {
      if (best.get(candidateId) === segmentId) {
        mutual.set(segmentId, candidateId)
      }
    }
    if (mutual.size > 0) pairings.set(vertex.key, mutual)
  }
  return { pairings, overfullVertexCount }
}

function graphParts(source: readonly CanonicalSegment[]): Readonly<{
  readonly segments: ReadonlyMap<number, CanonicalSegment>
  readonly vertices: ReadonlyMap<string, TraceVertex>
}> {
  const segments = new Map<number, CanonicalSegment>()
  const vertices = new Map<string, TraceVertex>()
  const vertexFor = (
    key: string,
    point: Readonly<Point>,
  ): TraceVertex => {
    const existing = vertices.get(key)
    if (existing !== undefined) return existing
    const created = { key, point, segmentIds: [] }
    vertices.set(key, created)
    return created
  }

  for (const segment of source) {
    segments.set(segment.id, segment)
    vertexFor(segment.startKey, segment.start).segmentIds.push(segment.id)
    vertexFor(segment.endKey, segment.end).segmentIds.push(segment.id)
  }
  for (const vertex of vertices.values()) {
    vertex.segmentIds.sort((first, second) => first - second)
  }
  return { segments, vertices }
}

function buildGraph(
  retained: readonly CanonicalSegment[],
  topologySource: readonly CanonicalSegment[],
): TraceGraph {
  const traced = graphParts(retained)
  const topology = graphParts(topologySource)
  const junctions = buildPairings(topology.segments, topology.vertices)
  return {
    segments: traced.segments,
    vertices: traced.vertices,
    pairings: junctions.pairings,
    overfullVertexCount: junctions.overfullVertexCount,
  }
}

function continuation(
  graph: TraceGraph,
  vertexKey: string,
  incomingSegmentId: number,
): number | undefined {
  return graph.pairings.get(vertexKey)?.get(incomingSegmentId)
}

function traceFrom(
  graph: TraceGraph,
  start: TraceVertex,
  firstSegmentId: number,
  visited: Set<number>,
): MutablePath {
  const points: Readonly<Point>[] = [start.point]
  const segmentIds: number[] = []
  let current = start
  let segmentId: number | undefined = firstSegmentId
  let closed = false

  // Every iteration permanently consumes a segment, so even an accidentally
  // malformed pairing table cannot exceed the retained-segment budget.
  for (
    let consumed = 0;
    segmentId !== undefined && consumed < graph.segments.size;
    consumed += 1
  ) {
    if (visited.has(segmentId)) break
    const segment = graph.segments.get(segmentId)
    if (segment === undefined) break
    visited.add(segmentId)
    segmentIds.push(segmentId)
    const nextKey = otherVertexKey(segment, current.key)
    current = graph.vertices.get(nextKey)!
    points.push(current.point)

    const nextSegmentId = continuation(graph, current.key, segmentId)
    if (
      current.key === start.key &&
      nextSegmentId === firstSegmentId
    ) {
      closed = true
      points.pop()
      break
    }
    if (nextSegmentId === undefined || visited.has(nextSegmentId)) break
    segmentId = nextSegmentId
  }

  return { points, segmentIds, closed }
}

function compareNumberArrays(
  first: readonly number[],
  second: readonly number[],
): number {
  const length = Math.min(first.length, second.length)
  for (let index = 0; index < length; index += 1) {
    const order = first[index]! - second[index]!
    if (order !== 0) return order
  }
  return first.length - second.length
}

function comparePointArrays(
  first: readonly Readonly<Point>[],
  second: readonly Readonly<Point>[],
): number {
  const length = Math.min(first.length, second.length)
  for (let index = 0; index < length; index += 1) {
    const order = comparePoints(first[index]!, second[index]!)
    if (order !== 0) return order
  }
  return first.length - second.length
}

function compareMutablePaths(first: MutablePath, second: MutablePath): number {
  return (
    comparePointArrays(first.points, second.points) ||
    Number(first.closed) - Number(second.closed) ||
    compareNumberArrays(first.segmentIds, second.segmentIds)
  )
}

function reverseOpenPath(path: MutablePath): MutablePath {
  return {
    points: [...path.points].reverse(),
    segmentIds: [...path.segmentIds].reverse(),
    closed: false,
  }
}

function canonicalOpenPath(path: MutablePath): MutablePath {
  const reversed = reverseOpenPath(path)
  return compareMutablePaths(path, reversed) <= 0 ? path : reversed
}

interface CycleStep {
  readonly point: Readonly<Point>
  readonly segmentId: number
}

function compareCycleSteps(first: CycleStep, second: CycleStep): number {
  return comparePoints(first.point, second.point) ||
    first.segmentId - second.segmentId
}

/** Booth's algorithm generalized to the point/segment lexicographic order. */
function minimalRotationIndex(values: readonly CycleStep[]): number {
  const length = values.length
  if (length < 2) return 0
  let first = 0
  let second = 1
  let offset = 0
  while (first < length && second < length && offset < length) {
    const order = compareCycleSteps(
      values[(first + offset) % length]!,
      values[(second + offset) % length]!,
    )
    if (order === 0) {
      offset += 1
      continue
    }
    if (order > 0) {
      first += offset + 1
      if (first === second) first += 1
    } else {
      second += offset + 1
      if (first === second) second += 1
    }
    offset = 0
  }
  return Math.min(first, second)
}

function rotatedCyclePath(steps: readonly CycleStep[]): MutablePath {
  const start = minimalRotationIndex(steps)
  const ordered = [
    ...steps.slice(start),
    ...steps.slice(0, start),
  ]
  return {
    points: ordered.map(({ point }) => point),
    segmentIds: ordered.map(({ segmentId }) => segmentId),
    closed: true,
  }
}

function canonicalClosedPath(path: MutablePath): MutablePath {
  if (path.points.length === 0) return path
  const forward = path.points.map((point, index) => ({
    point,
    segmentId: path.segmentIds[index]!,
  }))
  const reversed = path.points.map((_, offset) => {
    const pointIndex =
      (path.points.length - offset) % path.points.length
    const segmentIndex =
      (pointIndex - 1 + path.segmentIds.length) % path.segmentIds.length
    return {
      point: path.points[pointIndex]!,
      segmentId: path.segmentIds[segmentIndex]!,
    }
  })
  const canonicalForward = rotatedCyclePath(forward)
  const canonicalReversed = rotatedCyclePath(reversed)
  return compareMutablePaths(canonicalForward, canonicalReversed) <= 0
    ? canonicalForward
    : canonicalReversed
}

function freezePath(path: MutablePath): Readonly<WatercolorBoundaryPath> {
  return Object.freeze({
    points: Object.freeze([...path.points]),
    closed: path.closed,
    boundarySegmentIds: Object.freeze([...path.segmentIds]),
  })
}

function traceGraph(graph: TraceGraph): readonly MutablePath[] {
  const visited = new Set<number>()
  const paths: MutablePath[] = []
  const vertices = [...graph.vertices.values()].sort(
    (first, second) =>
      comparePoints(first.point, second.point) ||
      (first.key < second.key ? -1 : first.key > second.key ? 1 : 0),
  )

  // An unpaired incidence is an authored endpoint of a maximal continuation.
  for (const vertex of vertices) {
    for (const segmentId of vertex.segmentIds) {
      if (
        !visited.has(segmentId) &&
        continuation(graph, vertex.key, segmentId) === undefined
      ) {
        paths.push(
          canonicalOpenPath(
            traceFrom(graph, vertex, segmentId, visited),
          ),
        )
      }
    }
  }

  // Remaining components have no endpoints and therefore are closed cycles.
  for (const vertex of vertices) {
    for (const segmentId of vertex.segmentIds) {
      if (!visited.has(segmentId)) {
        const path = traceFrom(graph, vertex, segmentId, visited)
        paths.push(
          path.closed ? canonicalClosedPath(path) : canonicalOpenPath(path),
        )
      }
    }
  }
  paths.sort(compareMutablePaths)
  return paths
}

function validLimit(
  value: number | undefined,
  maximum: number,
): value is number | undefined {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && value >= 0 && value <= maximum)
  )
}

function frozenResult(
  paths: readonly Readonly<WatercolorBoundaryPath>[],
  diagnostics: WatercolorBoundaryTracingDiagnostics,
): Readonly<WatercolorBoundaryTracingResult> {
  return Object.freeze({
    paths: Object.freeze([...paths]),
    diagnostics: Object.freeze(diagnostics),
  })
}

function invalidResult(inputSegmentCount: number): WatercolorBoundaryTracingResult {
  return frozenResult([], {
    termination: 'invalid-input',
    limitedBy: null,
    inputSegmentCount,
    validSegmentCount: 0,
    duplicateSegmentCount: 0,
    invalidSegmentCount: inputSegmentCount,
    overfullVertexCount: 0,
    consumedSegmentCount: 0,
    boundaryPathCount: 0,
  })
}

/**
 * Consume every valid unique shared-boundary segment exactly once into stable
 * maximal paths. Individual malformed entries fail locally; a malformed outer
 * collection or invalid cap policy fails closed.
 */
export function traceWatercolorBoundaryNetwork(
  input: readonly Readonly<SharedBoundarySegment>[],
  limits: Readonly<WatercolorBoundaryTracingLimits> = {},
): Readonly<WatercolorBoundaryTracingResult> {
  if (!Array.isArray(input)) return invalidResult(0)
  if (limits === null || typeof limits !== 'object') {
    return invalidResult(input.length)
  }
  const segmentLimit = limits.maxRetainedBoundarySegmentCount
  const pathLimit = limits.maxBoundaryPathCount
  if (
    !validLimit(
      segmentLimit,
      WATERCOLOR_FORMS_LIMITS.maxRetainedBoundarySegmentCount,
    ) ||
    !validLimit(
      pathLimit,
      WATERCOLOR_FORMS_LIMITS.maxBoundaryPathCount,
    )
  ) {
    return invalidResult(input.length)
  }

  const validated = validateSegments(input)
  const effectiveSegmentLimit =
    segmentLimit ??
    WATERCOLOR_FORMS_LIMITS.maxRetainedBoundarySegmentCount
  const retained = validated.segments.slice(0, effectiveSegmentLimit)
  // Junction choices see omitted valid incidences too. A safety prefix may
  // remove geometry, but it must never remove ambiguity and create a bridge.
  const graph = buildGraph(retained, validated.segments)
  const traced = traceGraph(graph)
  const effectivePathLimit =
    pathLimit ?? WATERCOLOR_FORMS_LIMITS.maxBoundaryPathCount
  const returned = traced.slice(0, effectivePathLimit).map(freezePath)

  let limitedBy: TracingLimitName | null = null
  if (retained.length < validated.segments.length) {
    limitedBy = 'maxRetainedBoundarySegmentCount'
  } else if (returned.length < traced.length) {
    limitedBy = 'maxBoundaryPathCount'
  }
  const consumedSegmentCount = returned.reduce(
    (total, path) => total + path.boundarySegmentIds.length,
    0,
  )
  return frozenResult(returned, {
    termination: limitedBy === null ? 'complete' : 'limit-reached',
    limitedBy,
    inputSegmentCount: input.length,
    validSegmentCount: validated.segments.length,
    duplicateSegmentCount: validated.duplicateCount,
    invalidSegmentCount: validated.invalidCount,
    overfullVertexCount: graph.overfullVertexCount,
    consumedSegmentCount,
    boundaryPathCount: returned.length,
  })
}
