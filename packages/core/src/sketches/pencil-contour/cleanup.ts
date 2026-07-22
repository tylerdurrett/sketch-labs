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
const MAX_SIMPLIFICATION_TOLERANCE = 0.75
const MAX_SMOOTHING_WEIGHT = 0.5
const MAX_ANALYSIS_DIMENSION = 256
const POINT_EPSILON_SQUARED = 1e-18
const ISOVALUE = 0.5
const ISOVALUE_TOLERANCE = 1e-7
const PARAMETER_EPSILON = 1e-12
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
  readonly dx: number
  readonly dy: number
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
    return value === undefined ? undefined : { value, dx: 0, dy: 0 }
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
  return {
    value: topValue * (1 - vertical) + bottomValue * vertical,
    dx:
      (topRight - topLeft) * (1 - vertical) +
      (bottomRight - bottomLeft) * vertical,
    dy: bottomValue - topValue,
  }
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
    for (let boundary = 0; boundary < limit; boundary += 1) {
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

function simplifyOpenIndices(
  points: readonly Readonly<Point>[],
  sourceIndices: readonly number[],
  tolerance: number,
  canShortcut: (start: Readonly<Point>, end: Readonly<Point>) => boolean,
): number[] {
  if (sourceIndices.length <= 2 || tolerance <= 0) return [...sourceIndices]
  const keep = new Set<number>([0, sourceIndices.length - 1])
  const stack: Array<readonly [number, number]> = [
    [0, sourceIndices.length - 1],
  ]

  while (stack.length > 0) {
    const [start, end] = stack.pop()!
    let farthest = -1
    let maximumDistance = -1
    for (let index = start + 1; index < end; index += 1) {
      const distance = perpendicularDistance(
        points[sourceIndices[index]!]!,
        points[sourceIndices[start]!]!,
        points[sourceIndices[end]!]!,
      )
      if (distance > maximumDistance) {
        maximumDistance = distance
        farthest = index
      }
    }

    const shortcutSupported = canShortcut(
      points[sourceIndices[start]!]!,
      points[sourceIndices[end]!]!,
    )
    if (farthest >= 0 && (maximumDistance > tolerance || !shortcutSupported)) {
      keep.add(farthest)
      stack.push([start, farthest], [farthest, end])
    }
  }
  return [...keep].sort((first, second) => first - second).map(
    (index) => sourceIndices[index]!,
  )
}

function simplifyIndices(
  points: readonly Readonly<Point>[],
  closed: boolean,
  tolerance: number,
  canShortcut: (start: Readonly<Point>, end: Readonly<Point>) => boolean,
): number[] {
  if (!closed) {
    return simplifyOpenIndices(
      points,
      points.map((_, index) => index),
      tolerance,
      canShortcut,
    )
  }
  if (points.length <= 3 || tolerance <= 0) {
    return points.map((_, index) => index)
  }

  let opposite = 1
  for (let index = 2; index < points.length; index += 1) {
    if (
      squaredDistance(points[0]!, points[index]!) >
      squaredDistance(points[0]!, points[opposite]!)
    ) {
      opposite = index
    }
  }
  const firstArc = Array.from({ length: opposite + 1 }, (_, index) => index)
  const secondArc = [
    ...Array.from(
      { length: points.length - opposite },
      (_, index) => opposite + index,
    ),
    0,
  ]
  const first = simplifyOpenIndices(points, firstArc, tolerance, canShortcut)
  const second = simplifyOpenIndices(points, secondArc, tolerance, canShortcut)
  const retained = [...first.slice(0, -1), ...second.slice(0, -1)]

  if (retained.length < 3) {
    let third = -1
    let maximumDistance = -1
    for (let index = 1; index < points.length; index += 1) {
      if (index === opposite) continue
      const distance = perpendicularDistance(
        points[index]!,
        points[0]!,
        points[opposite]!,
      )
      if (distance > maximumDistance) {
        maximumDistance = distance
        third = index
      }
    }
    if (third >= 0) retained.push(third)
  }
  return [...new Set(retained)].sort((firstIndex, secondIndex) => {
    // Preserve ring traversal, not numeric sorting after the second arc wraps.
    const firstOrder = retained.indexOf(firstIndex)
    const secondOrder = retained.indexOf(secondIndex)
    return firstOrder - secondOrder
  })
}

function projectedAlphaBoundaryPoint(
  graph: Readonly<LocalizedEdgeGraph>,
  candidate: Readonly<Point>,
): Readonly<Point> | undefined {
  let x = Math.min(graph.width - 1, Math.max(0, candidate[0]))
  let y = Math.min(graph.height - 1, Math.max(0, candidate[1]))
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const sample = alphaSample(graph, [x, y])
    if (sample === undefined) return undefined
    const error = sample.value - ISOVALUE
    if (Math.abs(error) <= ISOVALUE_TOLERANCE) {
      const point = [x, y] as Point
      return pointHasPositiveSupport(graph, point) ? point : undefined
    }
    const gradientSquared = sample.dx * sample.dx + sample.dy * sample.dy
    if (gradientSquared <= POINT_EPSILON_SQUARED) return undefined
    x = Math.min(
      graph.width - 1,
      Math.max(0, x - (error * sample.dx) / gradientSquared),
    )
    y = Math.min(
      graph.height - 1,
      Math.max(0, y - (error * sample.dy) / gradientSquared),
    )
  }
  return undefined
}

function smoothRetainedPoints(
  source: readonly Readonly<Point>[],
  retained: readonly number[],
  closed: boolean,
  pathProvenance: Readonly<EdgeProvenance>,
  smoothing: number,
  graph: Readonly<LocalizedEdgeGraph>,
): Point[] {
  const original = retained.map((index) => [
    source[index]![0],
    source[index]![1],
  ] as Point)
  if (smoothing <= 0) return original
  const weight = smoothing * MAX_SMOOTHING_WEIGHT
  const result = original.map((point) => [...point] as Point)

  const openTargets: readonly Readonly<Point>[] | undefined = closed
    ? undefined
    : (() => {
        // Put every source station on the endpoint chord at its cumulative
        // arclength fraction. Interpolation toward these ordered stations has
        // nonincreasing total length; dropping a station at a simplification
        // threshold also cannot add length (triangle inequality). Defining the
        // targets before selecting retained indices avoids transition jumps.
        const cumulative = new Array<number>(source.length).fill(0)
        for (let index = 1; index < source.length; index += 1) {
          cumulative[index] =
            cumulative[index - 1]! +
            Math.sqrt(squaredDistance(source[index - 1]!, source[index]!))
        }
        const total = cumulative.at(-1)!
        const start = source[0]!
        const end = source.at(-1)!
        return retained.map((sourceIndex) => {
          const amount = total > 0 ? cumulative[sourceIndex]! / total : 0
          return [
            start[0] + (end[0] - start[0]) * amount,
            start[1] + (end[1] - start[1]) * amount,
          ] as Point
        })
      })()

  for (let index = 0; index < original.length; index += 1) {
    if (!closed && (index === 0 || index === original.length - 1)) continue
    const current = original[index]!
    const target = closed
      ? (() => {
          const previous =
            original[(index - 1 + original.length) % original.length]!
          const next = original[(index + 1) % original.length]!
          return [
            (previous[0] + next[0]) / 2,
            (previous[1] + next[1]) / 2,
          ] as Point
        })()
      : openTargets![index]!
    const candidate: Point = [
      current[0] * (1 - weight) + target[0] * weight,
      current[1] * (1 - weight) + target[1] * weight,
    ]
    const accepted =
      pathProvenance.kind === 'alpha-boundary'
        ? projectedAlphaBoundaryPoint(graph, candidate)
        : pointHasPositiveSupport(graph, candidate)
          ? candidate
          : undefined
    if (accepted !== undefined) result[index] = [accepted[0], accepted[1]]
  }

  const segmentCount = closed ? result.length : result.length - 1
  // Candidate vertices are evaluated together above. If any moved pair creates
  // an invalid segment, deterministic endpoint rollback converges to the
  // already-validated original shortcut geometry.
  for (let pass = 0; pass < result.length; pass += 1) {
    let changed = false
    for (let index = 0; index < segmentCount; index += 1) {
      const next = (index + 1) % result.length
      if (!segmentHasPositiveSupport(graph, result[index]!, result[next]!)) {
        if (closed || index > 0) result[index] = [...original[index]!] as Point
        if (closed || next < result.length - 1) {
          result[next] = [...original[next]!] as Point
        }
        changed = true
      }
    }
    if (!changed) break
  }
  return result
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
  const tolerance = input.smoothing * MAX_SIMPLIFICATION_TOLERANCE
  const result: Readonly<TracedContourPath>[] = []

  for (const path of input.paths) {
    if (!validPath(path, input.graph)) continue
    const source = deduplicate(path.points, path.closed)
    const minimumPointCount = path.closed ? 3 : 2
    if (
      source.length < minimumPointCount ||
      pathLength(source, path.closed) < minimumLength ||
      !emittedSegmentsAreSupported(source, path.closed, input.graph)
    ) {
      continue
    }

    const retained = simplifyIndices(
      source,
      path.closed,
      tolerance,
      (start, end) => segmentHasPositiveSupport(input.graph, start, end),
    )
    const points = smoothRetainedPoints(
      source,
      retained,
      path.closed,
      path.provenance,
      input.smoothing,
      input.graph,
    )
    if (
      points.length < minimumPointCount ||
      !points.every((point) => finitePoint(point)) ||
      !emittedSegmentsAreSupported(points, path.closed, input.graph) ||
      pathLength(points, path.closed) <= Math.sqrt(POINT_EPSILON_SQUARED)
    ) {
      continue
    }

    const frozenPoints = Object.freeze(
      points.map((point) => Object.freeze([point[0], point[1]] as Point)),
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
