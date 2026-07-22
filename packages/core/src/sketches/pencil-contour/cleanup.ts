/**
 * Permission-aware cleanup for traced Pencil Contour geometry.
 *
 * All work remains in analysis-lattice coordinates. Topology and provenance
 * are explicit inputs: open paths keep their endpoints, while closed paths use
 * wrapped neighbours and never acquire a duplicated terminal point.
 */

import type { Point } from '../../types'
import type {
  EdgeProvenance,
  LocalizedEdgeGraph,
  TracedContourPath,
} from './types'

const MIN_FRAGMENT_LENGTH = 0.5
const MAX_FRAGMENT_LENGTH = 2.5
const MAX_ANALYSIS_DIMENSION = 256
const POINT_EPSILON_SQUARED = 1e-18
const ISOVALUE = 0.5
const ISOVALUE_TOLERANCE = 1e-7
const PARAMETER_EPSILON = 1e-12
const METRIC_EPSILON = 1e-12
const SMOOTHING_LEVELS = 100
const LUMINANCE_PROVENANCE: Readonly<EdgeProvenance> = Object.freeze({
  kind: 'luminance',
})
const ALPHA_BOUNDARY_PROVENANCE: Readonly<EdgeProvenance> = Object.freeze({
  kind: 'alpha-boundary',
})

export interface PencilContourCleanupInput {
  readonly paths: readonly Readonly<TracedContourPath>[]
  readonly graph: Readonly<LocalizedEdgeGraph>
  /** Already-normalized Contour detail in `[0, 1]`. */
  readonly detail: number
  /** Already-normalized Contour smoothing in `[0, 1]`. */
  readonly smoothing: number
}

interface AlphaSample {
  readonly value: number
}

interface RemovalCandidate {
  readonly index: number
  readonly priority: number
}

function finitePoint(value: unknown): value is Readonly<Point> {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  )
}

function provenance(value: unknown): value is Readonly<EdgeProvenance> {
  if (value === null || typeof value !== 'object') return false
  const kind = (value as { readonly kind?: unknown }).kind
  return kind === 'luminance' || kind === 'alpha-boundary'
}

function canonicalProvenance(
  value: Readonly<EdgeProvenance>,
): Readonly<EdgeProvenance> {
  return value.kind === 'luminance'
    ? LUMINANCE_PROVENANCE
    : ALPHA_BOUNDARY_PROVENANCE
}

function validGraph(graph: Readonly<LocalizedEdgeGraph>): boolean {
  if (
    graph === null ||
    typeof graph !== 'object' ||
    !Number.isSafeInteger(graph.width) ||
    !Number.isSafeInteger(graph.height) ||
    graph.width < 1 ||
    graph.height < 1 ||
    graph.width > MAX_ANALYSIS_DIMENSION ||
    graph.height > MAX_ANALYSIS_DIMENSION
  ) {
    return false
  }

  const sampleCount = graph.width * graph.height
  if (
    !Number.isSafeInteger(sampleCount) ||
    !Array.isArray(graph.alpha) ||
    !Array.isArray(graph.positiveSupport) ||
    graph.alpha.length !== sampleCount ||
    graph.positiveSupport.length !== sampleCount
  ) {
    return false
  }

  for (let index = 0; index < sampleCount; index += 1) {
    if (
      !Object.prototype.hasOwnProperty.call(graph.alpha, index) ||
      !Object.prototype.hasOwnProperty.call(graph.positiveSupport, index)
    ) {
      return false
    }
    const alpha = graph.alpha[index]
    if (
      typeof alpha !== 'number' ||
      !Number.isFinite(alpha) ||
      alpha < 0 ||
      alpha > 1 ||
      typeof graph.positiveSupport[index] !== 'boolean'
    ) {
      return false
    }
  }
  return true
}

function inBounds(
  point: Readonly<Point>,
  graph: Readonly<LocalizedEdgeGraph>,
): boolean {
  return (
    point[0] >= 0 &&
    point[1] >= 0 &&
    point[0] <= graph.width - 1 &&
    point[1] <= graph.height - 1
  )
}

function sampleField(
  values: readonly number[],
  width: number,
  height: number,
  point: Readonly<Point>,
): number | undefined {
  if (
    point[0] < 0 ||
    point[1] < 0 ||
    point[0] > width - 1 ||
    point[1] > height - 1
  ) {
    return undefined
  }

  const left = Math.min(Math.floor(point[0]), width - 1)
  const top = Math.min(Math.floor(point[1]), height - 1)
  const right = Math.min(left + 1, width - 1)
  const bottom = Math.min(top + 1, height - 1)
  const horizontal = point[0] - left
  const vertical = point[1] - top
  const topValue =
    values[top * width + left]! * (1 - horizontal) +
    values[top * width + right]! * horizontal
  const bottomValue =
    values[bottom * width + left]! * (1 - horizontal) +
    values[bottom * width + right]! * horizontal
  return topValue * (1 - vertical) + bottomValue * vertical
}

function alphaSample(
  graph: Readonly<LocalizedEdgeGraph>,
  point: Readonly<Point>,
): AlphaSample | undefined {
  if (!inBounds(point, graph)) return undefined
  if (graph.width < 2 || graph.height < 2) {
    const value = sampleField(
      graph.alpha,
      graph.width,
      graph.height,
      point,
    )
    return value === undefined ? undefined : { value }
  }

  const left = Math.min(Math.floor(point[0]), graph.width - 2)
  const top = Math.min(Math.floor(point[1]), graph.height - 2)
  const horizontal = point[0] - left
  const vertical = point[1] - top
  const topLeft = graph.alpha[top * graph.width + left]!
  const topRight = graph.alpha[top * graph.width + left + 1]!
  const bottomLeft = graph.alpha[(top + 1) * graph.width + left]!
  const bottomRight = graph.alpha[(top + 1) * graph.width + left + 1]!
  const topValue = topLeft * (1 - horizontal) + topRight * horizontal
  const bottomValue =
    bottomLeft * (1 - horizontal) + bottomRight * horizontal
  return { value: topValue * (1 - vertical) + bottomValue * vertical }
}

function sampleSupport(
  graph: Readonly<LocalizedEdgeGraph>,
  point: Readonly<Point>,
): number | undefined {
  if (!inBounds(point, graph)) return undefined
  const left = Math.min(Math.floor(point[0]), graph.width - 1)
  const top = Math.min(Math.floor(point[1]), graph.height - 1)
  const right = Math.min(left + 1, graph.width - 1)
  const bottom = Math.min(top + 1, graph.height - 1)
  const horizontal = point[0] - left
  const vertical = point[1] - top
  const value = (x: number, y: number) =>
    graph.positiveSupport[y * graph.width + x] === true ? 1 : 0
  const topValue =
    value(left, top) * (1 - horizontal) +
    value(right, top) * horizontal
  const bottomValue =
    value(left, bottom) * (1 - horizontal) +
    value(right, bottom) * horizontal
  return topValue * (1 - vertical) + bottomValue * vertical
}

function pointHasPositiveSupport(
  graph: Readonly<LocalizedEdgeGraph>,
  point: Readonly<Point>,
): boolean {
  const alpha = sampleField(graph.alpha, graph.width, graph.height, point)
  if (alpha === undefined || alpha <= 0) return false
  const support = sampleSupport(graph, point)
  return support !== undefined && support > 0
}

/**
 * Split the segment at every lattice line. Within each resulting open cell
 * interval all bilinear weights are positive, so endpoints plus one midpoint
 * exactly detect entry into the zero-support set without resolution guesses.
 */
function segmentHasPositiveSupport(
  graph: Readonly<LocalizedEdgeGraph>,
  start: Readonly<Point>,
  end: Readonly<Point>,
): boolean {
  const parameters = [0, 1]
  const addCrossings = (first: number, second: number, limit: number) => {
    const delta = second - first
    if (delta === 0) return
    const firstBoundary = Math.max(0, Math.ceil(Math.min(first, second)))
    const lastBoundary = Math.min(
      limit - 1,
      Math.floor(Math.max(first, second)),
    )
    for (
      let boundary = firstBoundary;
      boundary <= lastBoundary;
      boundary += 1
    ) {
      const amount = (boundary - first) / delta
      if (amount > PARAMETER_EPSILON && amount < 1 - PARAMETER_EPSILON) {
        parameters.push(amount)
      }
    }
  }
  addCrossings(start[0], end[0], graph.width)
  addCrossings(start[1], end[1], graph.height)
  parameters.sort((first, second) => first - second)

  const unique: number[] = []
  for (const amount of parameters) {
    if (
      unique.length === 0 ||
      Math.abs(amount - unique[unique.length - 1]!) > PARAMETER_EPSILON
    ) {
      unique.push(amount)
    }
  }
  const supportedAt = (amount: number) =>
    pointHasPositiveSupport(graph, [
      start[0] + (end[0] - start[0]) * amount,
      start[1] + (end[1] - start[1]) * amount,
    ])

  for (let index = 0; index < unique.length; index += 1) {
    if (!supportedAt(unique[index]!)) return false
    if (
      index + 1 < unique.length &&
      !supportedAt((unique[index]! + unique[index + 1]!) / 2)
    ) {
      return false
    }
  }
  return true
}

function squaredDistance(
  first: Readonly<Point>,
  second: Readonly<Point>,
): number {
  const dx = second[0] - first[0]
  const dy = second[1] - first[1]
  return dx * dx + dy * dy
}

function pathLength(points: readonly Readonly<Point>[], closed: boolean): number {
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    length += Math.sqrt(squaredDistance(points[index - 1]!, points[index]!))
  }
  if (closed && points.length > 1) {
    length += Math.sqrt(squaredDistance(points.at(-1)!, points[0]!))
  }
  return length
}

function deduplicate(
  points: readonly Readonly<Point>[],
  closed: boolean,
): Readonly<Point>[] {
  const unique: Readonly<Point>[] = []
  for (const point of points) {
    if (
      unique.length === 0 ||
      squaredDistance(unique.at(-1)!, point) > POINT_EPSILON_SQUARED
    ) {
      unique.push(point)
    }
  }
  if (
    closed &&
    unique.length > 1 &&
    squaredDistance(unique[0]!, unique.at(-1)!) <= POINT_EPSILON_SQUARED
  ) {
    unique.pop()
  }
  return unique
}

function perpendicularDistance(
  point: Readonly<Point>,
  start: Readonly<Point>,
  end: Readonly<Point>,
): number {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.sqrt(squaredDistance(point, start))
  return (
    Math.abs(dx * (point[1] - start[1]) - dy * (point[0] - start[0])) /
    Math.sqrt(lengthSquared)
  )
}

function validPath(
  path: Readonly<TracedContourPath>,
  graph: Readonly<LocalizedEdgeGraph>,
): boolean {
  if (
    path === null ||
    typeof path !== 'object' ||
    typeof path.closed !== 'boolean' ||
    !provenance(path.provenance) ||
    !Array.isArray(path.points)
  ) {
    return false
  }
  for (let index = 0; index < path.points.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(path.points, index)) return false
    const point = path.points[index]
    if (!finitePoint(point) || !inBounds(point, graph)) return false
  }
  return true
}

function emittedSegmentsAreSupported(
  points: readonly Readonly<Point>[],
  closed: boolean,
  graph: Readonly<LocalizedEdgeGraph>,
): boolean {
  const segmentCount = closed ? points.length : points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    if (
      !segmentHasPositiveSupport(
        graph,
        points[index]!,
        points[(index + 1) % points.length]!,
      )
    ) {
      return false
    }
  }
  return true
}

function nondegenerateSegments(
  points: readonly Readonly<Point>[],
  closed: boolean,
): boolean {
  const segmentCount = closed ? points.length : points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    if (
      squaredDistance(
        points[index]!,
        points[(index + 1) % points.length]!,
      ) <= POINT_EPSILON_SQUARED
    ) {
      return false
    }
  }
  return true
}

function alphaBoundaryPointsStayOnIsovalue(
  points: readonly Readonly<Point>[],
  pathProvenance: Readonly<EdgeProvenance>,
  graph: Readonly<LocalizedEdgeGraph>,
): boolean {
  if (pathProvenance.kind !== 'alpha-boundary') return true
  return points.every((point) => {
    const sample = alphaSample(graph, point)
    return (
      sample !== undefined &&
      Math.abs(sample.value - ISOVALUE) <= ISOVALUE_TOLERANCE
    )
  })
}

/** Sum of each vertex's deviation from its immediate-neighbour chord. */
function pathJaggedness(
  points: readonly Readonly<Point>[],
  closed: boolean,
): number {
  if (points.length < 3) return 0
  let jaggedness = 0
  const start = closed ? 0 : 1
  const end = closed ? points.length : points.length - 1
  for (let index = start; index < end; index += 1) {
    jaggedness += perpendicularDistance(
      points[index]!,
      points[(index - 1 + points.length) % points.length]!,
      points[(index + 1) % points.length]!,
    )
  }
  return jaggedness
}

function metricDoesNotIncrease(candidate: number, previous: number): boolean {
  return candidate <= previous + METRIC_EPSILON * Math.max(1, previous)
}

function compareRemovalCandidates(
  first: Readonly<RemovalCandidate>,
  second: Readonly<RemovalCandidate>,
): number {
  return first.priority - second.priority || first.index - second.index
}

function pushRemovalCandidate(
  heap: RemovalCandidate[],
  candidate: Readonly<RemovalCandidate>,
): void {
  heap.push(candidate)
  let index = heap.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (compareRemovalCandidates(heap[parent]!, candidate) <= 0) break
    heap[index] = heap[parent]!
    index = parent
  }
  heap[index] = candidate
}

function popRemovalCandidate(heap: RemovalCandidate[]): RemovalCandidate {
  const first = heap[0]!
  const last = heap.pop()!
  if (heap.length === 0) return first
  let index = 0
  while (true) {
    const left = index * 2 + 1
    if (left >= heap.length) break
    const right = left + 1
    const child =
      right < heap.length &&
      compareRemovalCandidates(heap[right]!, heap[left]!) < 0
        ? right
        : left
    if (compareRemovalCandidates(last, heap[child]!) <= 0) break
    heap[index] = heap[child]!
    index = child
  }
  heap[index] = last
  return first
}

function effectiveArea(
  previous: Readonly<Point>,
  current: Readonly<Point>,
  next: Readonly<Point>,
): number {
  return Math.abs(
    (current[0] - previous[0]) * (next[1] - previous[1]) -
      (current[1] - previous[1]) * (next[0] - previous[0]),
  )
}

function linkedJaggednessContribution(
  points: readonly Readonly<Point>[],
  index: number,
  previous: number,
  next: number,
): number {
  if (previous < 0 || next < 0) return 0
  return perpendicularDistance(
    points[index]!,
    points[previous]!,
    points[next]!,
  )
}

/**
 * Consider one stable effective-area prefix and retain only monotonic removals.
 * Each source vertex is popped at most once, so the heap dominates at
 * `O(points log points)` and every smoothing level denotes a nested prefix.
 */
function nestedSimplification(
  source: readonly Readonly<Point>[],
  closed: boolean,
  smoothingLevel: number,
  graph: Readonly<LocalizedEdgeGraph>,
  fullySupported: boolean,
): readonly Readonly<Point>[] {
  if (smoothingLevel === 0) return source
  const pointCount = source.length
  const minimumPointCount = closed ? 3 : 2
  const removableCount = pointCount - minimumPointCount
  const candidatesToConsider = Math.floor(
    (removableCount * smoothingLevel) / SMOOTHING_LEVELS,
  )
  if (candidatesToConsider === 0) return source

  const previous = new Int32Array(pointCount)
  const next = new Int32Array(pointCount)
  const alive = new Uint8Array(pointCount)
  const heap: RemovalCandidate[] = []
  for (let index = 0; index < pointCount; index += 1) {
    previous[index] = index > 0 ? index - 1 : closed ? pointCount - 1 : -1
    next[index] = index + 1 < pointCount ? index + 1 : closed ? 0 : -1
    alive[index] = 1
    if (closed || (index > 0 && index + 1 < pointCount)) {
      pushRemovalCandidate(heap, {
        index,
        priority: effectiveArea(
          source[previous[index]!]!,
          source[index]!,
          source[next[index]!]!,
        ),
      })
    }
  }

  let retainedCount = pointCount
  let currentLength = pathLength(source, closed)
  let currentJaggedness = pathJaggedness(source, closed)
  for (
    let considered = 0;
    considered < candidatesToConsider && heap.length > 0;
    considered += 1
  ) {
    const { index } = popRemovalCandidate(heap)
    if (alive[index] !== 1 || retainedCount <= minimumPointCount) continue
    const left = previous[index]!
    const right = next[index]!
    if (left < 0 || right < 0) continue
    if (
      squaredDistance(source[left]!, source[right]!) <=
      POINT_EPSILON_SQUARED
    ) {
      continue
    }
    if (
      !fullySupported &&
      !segmentHasPositiveSupport(graph, source[left]!, source[right]!)
    ) {
      continue
    }

    const beforeLength =
      Math.sqrt(squaredDistance(source[left]!, source[index]!)) +
      Math.sqrt(squaredDistance(source[index]!, source[right]!))
    const afterLength = Math.sqrt(
      squaredDistance(source[left]!, source[right]!),
    )
    const candidateLength = currentLength - beforeLength + afterLength
    const beforeJaggedness =
      linkedJaggednessContribution(
        source,
        left,
        previous[left]!,
        index,
      ) +
      linkedJaggednessContribution(source, index, left, right) +
      linkedJaggednessContribution(source, right, index, next[right]!)
    const afterJaggedness =
      linkedJaggednessContribution(
        source,
        left,
        previous[left]!,
        right,
      ) +
      linkedJaggednessContribution(source, right, left, next[right]!)
    const candidateJaggedness =
      currentJaggedness - beforeJaggedness + afterJaggedness
    if (
      !metricDoesNotIncrease(candidateLength, currentLength) ||
      !metricDoesNotIncrease(candidateJaggedness, currentJaggedness)
    ) {
      continue
    }

    alive[index] = 0
    next[left] = right
    previous[right] = left
    retainedCount -= 1
    currentLength = candidateLength
    currentJaggedness = Math.max(0, candidateJaggedness)
  }

  const retained: Readonly<Point>[] = []
  let index = 0
  while (index < pointCount && alive[index] !== 1) index += 1
  if (index >= pointCount) return retained
  const start = index
  do {
    retained.push(source[index]!)
    index = next[index]!
  } while (index >= 0 && index !== start)
  return retained
}

/**
 * Remove short fragments, simplify permission-valid shortcuts, and smooth the
 * survivors without changing topology, provenance, or source inputs.
 */
export function cleanupPencilContourPaths(
  input: Readonly<PencilContourCleanupInput>,
): readonly Readonly<TracedContourPath>[] {
  if (
    input === null ||
    typeof input !== 'object' ||
    !Array.isArray(input.paths) ||
    !Number.isFinite(input.detail) ||
    input.detail < 0 ||
    input.detail > 1 ||
    !Number.isFinite(input.smoothing) ||
    input.smoothing < 0 ||
    input.smoothing > 1 ||
    !validGraph(input.graph)
  ) {
    return Object.freeze([])
  }

  const minimumLength =
    MAX_FRAGMENT_LENGTH -
    input.detail * (MAX_FRAGMENT_LENGTH - MIN_FRAGMENT_LENGTH)
  const requestedSmoothingLevel = Math.round(
    input.smoothing * SMOOTHING_LEVELS,
  )
  const fullySupported = input.graph.positiveSupport.every(
    (supported, index) => supported && input.graph.alpha[index]! > 0,
  )
  const result: Readonly<TracedContourPath>[] = []

  for (const path of input.paths) {
    if (!validPath(path, input.graph)) continue
    const source = deduplicate(path.points, path.closed)
    const minimumPointCount = path.closed ? 3 : 2
    if (
      source.length < minimumPointCount ||
      pathLength(source, path.closed) < minimumLength ||
      !nondegenerateSegments(source, path.closed) ||
      !emittedSegmentsAreSupported(source, path.closed, input.graph) ||
      !alphaBoundaryPointsStayOnIsovalue(
        source,
        path.provenance,
        input.graph,
      )
    ) {
      continue
    }

    const accepted = nestedSimplification(
      source,
      path.closed,
      requestedSmoothingLevel,
      input.graph,
      fullySupported,
    )
    if (
      accepted.length < minimumPointCount ||
      !nondegenerateSegments(accepted, path.closed)
    ) {
      continue
    }

    const frozenPoints = Object.freeze(
      accepted.map((point) =>
        Object.freeze([point[0], point[1]] as Point),
      ),
    )
    result.push(
      Object.freeze({
        points: frozenPoints,
        closed: path.closed,
        provenance: canonicalProvenance(path.provenance),
      }),
    )
  }
  return Object.freeze(result)
}
