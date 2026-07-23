/**
 * Independent bounded curve fitting for selected Watercolor Forms boundaries.
 *
 * The selected boundary paths are already topology: this stage may simplify
 * and round each arc, but it never joins paths or searches for nearby
 * endpoints. Simplification follows one deterministic nested removal order so
 * increasing smoothing cannot increase point complexity. Every replacement
 * segment is checked against its own source sub-arc, a fixed fraction-of-cell
 * tube, and (when supplied) the raster's positive-support permission.
 */

import type { Point } from '../../types'
import { WATERCOLOR_FORMS_LIMITS } from './limits'
import type { WatercolorBoundaryPath } from './types'

/** Maximum geometric departure in analysis-lattice cell units. */
export const WATERCOLOR_BOUNDARY_MAX_DEVIATION = 0.45

const COORDINATE_EPSILON = 1e-9
const ROUNDING_PASSES = 2
const MAX_LOCAL_ROUNDING_AMOUNT = 0.5
const BACKOFF_ATTEMPTS = 8
const MAX_SHORTCUT_SOURCE_SEGMENTS = 32
const WORK_UNITS_PER_POINT = 128

export interface WatercolorBoundaryCurveOptions {
  /**
   * Analysis dimensions; vertices live in `[0, width] × [0, height]`.
   */
  readonly latticeWidth: number
  readonly latticeHeight: number
  /**
   * Optional row-major exact-zero permission for analysis samples.
   *
   * A curve point on a sample boundary is permitted when either adjacent
   * sample is supported, which keeps meaningful alpha silhouettes eligible.
   */
  readonly positiveSupport?: readonly boolean[]
  /** Testable lower cap; production callers normally use the global policy. */
  readonly maxPointCount?: number
}

interface RemovalCandidate {
  readonly index: number
  readonly generation: number
  readonly priority: number
}

interface GeometryBudget {
  remaining: number
}

interface CurvePoint {
  readonly point: Readonly<Point>
  readonly sourceIndex: number
}

function finitePoint(point: unknown): point is Readonly<Point> {
  return (
    Array.isArray(point) &&
    point.length === 2 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1])
  )
}

function samePoint(
  first: Readonly<Point>,
  second: Readonly<Point>,
): boolean {
  return (
    Math.abs(first[0] - second[0]) <= COORDINATE_EPSILON &&
    Math.abs(first[1] - second[1]) <= COORDINATE_EPSILON
  )
}

function squaredDistance(
  first: Readonly<Point>,
  second: Readonly<Point>,
): number {
  const dx = first[0] - second[0]
  const dy = first[1] - second[1]
  return dx * dx + dy * dy
}

function pointSegmentDistance(
  point: Readonly<Point>,
  start: Readonly<Point>,
  end: Readonly<Point>,
): number {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= COORDINATE_EPSILON * COORDINATE_EPSILON) {
    return Math.sqrt(squaredDistance(point, start))
  }
  const amount = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) /
        lengthSquared,
    ),
  )
  return Math.hypot(
    point[0] - (start[0] + dx * amount),
    point[1] - (start[1] + dy * amount),
  )
}

function interpolate(
  start: Readonly<Point>,
  end: Readonly<Point>,
  amount: number,
): Point {
  return [
    start[0] + (end[0] - start[0]) * amount,
    start[1] + (end[1] - start[1]) * amount,
  ]
}

function inLattice(
  point: Readonly<Point>,
  options: Readonly<WatercolorBoundaryCurveOptions>,
): boolean {
  return (
    point[0] >= -COORDINATE_EPSILON &&
    point[1] >= -COORDINATE_EPSILON &&
    point[0] <= options.latticeWidth + COORDINATE_EPSILON &&
    point[1] <= options.latticeHeight + COORDINATE_EPSILON
  )
}

function pointHasPositiveSupport(
  point: Readonly<Point>,
  options: Readonly<WatercolorBoundaryCurveOptions>,
): boolean {
  const support = options.positiveSupport
  if (support === undefined) return true
  const adjacentSamples = (coordinate: number) =>
    Number.isInteger(coordinate)
      ? [coordinate - 1, coordinate]
      : [Math.floor(coordinate)]
  const xCandidates = adjacentSamples(point[0])
  const yCandidates = adjacentSamples(point[1])
  for (const y of yCandidates) {
    if (y < 0 || y >= options.latticeHeight) continue
    for (const x of xCandidates) {
      if (x < 0 || x >= options.latticeWidth) continue
      if (support[y * options.latticeWidth + x] === true) return true
    }
  }
  return false
}

function segmentHasPositiveSupport(
  start: Readonly<Point>,
  end: Readonly<Point>,
  options: Readonly<WatercolorBoundaryCurveOptions>,
  budget?: GeometryBudget,
): boolean {
  if (options.positiveSupport === undefined) return true

  /*
   * Between consecutive lattice-line crossings, the set of sample cells
   * adjacent to the segment is constant. Checking every such open interval is
   * therefore complete, including arbitrarily short clips through a cell that
   * fixed-distance sampling can miss.
   */
  const crossings = [0, 1]
  const addCrossings = (
    startCoordinate: number,
    endCoordinate: number,
    dimension: number,
  ) => {
    const delta = endCoordinate - startCoordinate
    if (Math.abs(delta) <= COORDINATE_EPSILON) return
    for (let line = 1; line < dimension; line += 1) {
      const amount = (line - startCoordinate) / delta
      if (
        amount > COORDINATE_EPSILON &&
        amount < 1 - COORDINATE_EPSILON
      ) {
        crossings.push(amount)
      }
    }
  }
  addCrossings(start[0], end[0], options.latticeWidth)
  addCrossings(start[1], end[1], options.latticeHeight)
  crossings.sort((first, second) => first - second)
  const distinctCrossings = crossings.filter(
    (amount, index) =>
      index === 0 ||
      amount !== crossings[index - 1],
  )
  const requiredWork = distinctCrossings.length + 1
  if (budget !== undefined) {
    if (budget.remaining < requiredWork) return false
    budget.remaining -= requiredWork
  }
  if (
    !pointHasPositiveSupport(start, options) ||
    !pointHasPositiveSupport(end, options)
  ) {
    return false
  }
  for (let index = 1; index < distinctCrossings.length; index += 1) {
    const amount =
      (distinctCrossings[index - 1]! + distinctCrossings[index]!) / 2
    if (!pointHasPositiveSupport(interpolate(start, end, amount), options)) {
      return false
    }
  }
  return true
}

function sourceChain(
  start: number,
  end: number,
  pointCount: number,
  closed: boolean,
): readonly number[] {
  const indices = [start]
  let current = start
  while (current !== end && indices.length <= MAX_SHORTCUT_SOURCE_SEGMENTS) {
    current = closed ? (current + 1) % pointCount : current + 1
    if (current < 0 || current >= pointCount) return []
    indices.push(current)
  }
  return current === end ? indices : []
}

function segmentFitsSourceTube(
  start: Readonly<Point>,
  end: Readonly<Point>,
  chain: readonly number[],
  source: readonly Readonly<Point>[],
  budget: GeometryBudget,
): boolean {
  if (chain.length < 2 || budget.remaining < chain.length) return false
  budget.remaining -= chain.length
  for (const index of chain) {
    if (
      pointSegmentDistance(source[index]!, start, end) >
      WATERCOLOR_BOUNDARY_MAX_DEVIATION + COORDINATE_EPSILON
    ) {
      return false
    }
  }

  const chordLength = Math.hypot(end[0] - start[0], end[1] - start[1])
  const sampleCount = Math.max(
    1,
    Math.ceil(chordLength / (WATERCOLOR_BOUNDARY_MAX_DEVIATION / 2)),
  )
  const requiredWork = (sampleCount + 1) * (chain.length - 1)
  if (budget.remaining < requiredWork) return false
  budget.remaining -= requiredWork
  for (let sample = 0; sample <= sampleCount; sample += 1) {
    const point = interpolate(start, end, sample / sampleCount)
    let nearest = Number.POSITIVE_INFINITY
    for (let index = 1; index < chain.length; index += 1) {
      nearest = Math.min(
        nearest,
        pointSegmentDistance(
          point,
          source[chain[index - 1]!]!,
          source[chain[index]!]!,
        ),
      )
    }
    if (
      nearest >
      WATERCOLOR_BOUNDARY_MAX_DEVIATION + COORDINATE_EPSILON
    ) {
      return false
    }
  }
  return true
}

function replacementIsSafe(
  start: Readonly<Point>,
  end: Readonly<Point>,
  chain: readonly number[],
  source: readonly Readonly<Point>[],
  options: Readonly<WatercolorBoundaryCurveOptions>,
  budget: GeometryBudget,
): boolean {
  return (
    !samePoint(start, end) &&
    inLattice(start, options) &&
    inLattice(end, options) &&
    segmentFitsSourceTube(start, end, chain, source, budget) &&
    segmentHasPositiveSupport(start, end, options, budget)
  )
}

function lessCandidate(
  first: Readonly<RemovalCandidate>,
  second: Readonly<RemovalCandidate>,
): boolean {
  return (
    first.priority < second.priority ||
    (first.priority === second.priority && first.index < second.index)
  )
}

function pushCandidate(
  heap: RemovalCandidate[],
  candidate: Readonly<RemovalCandidate>,
): void {
  heap.push(candidate)
  let index = heap.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (!lessCandidate(heap[index]!, heap[parent]!)) break
    ;[heap[index], heap[parent]] = [heap[parent]!, heap[index]!]
    index = parent
  }
}

function popCandidate(heap: RemovalCandidate[]): RemovalCandidate {
  const first = heap[0]!
  const last = heap.pop()!
  if (heap.length === 0) return first
  heap[0] = last
  let index = 0
  while (true) {
    const left = index * 2 + 1
    const right = left + 1
    let smallest = index
    if (left < heap.length && lessCandidate(heap[left]!, heap[smallest]!)) {
      smallest = left
    }
    if (right < heap.length && lessCandidate(heap[right]!, heap[smallest]!)) {
      smallest = right
    }
    if (smallest === index) break
    ;[heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!]
    index = smallest
  }
  return first
}

function removalPriority(
  source: readonly Readonly<Point>[],
  previous: number,
  index: number,
  next: number,
): number {
  return pointSegmentDistance(
    source[index]!,
    source[previous]!,
    source[next]!,
  )
}

function removalOrder(
  source: readonly Readonly<Point>[],
  closed: boolean,
  options: Readonly<WatercolorBoundaryCurveOptions>,
  budget: GeometryBudget,
): readonly number[] {
  const pointCount = source.length
  const minimumPointCount = closed ? 3 : 2
  const previous = new Int32Array(pointCount)
  const next = new Int32Array(pointCount)
  const alive = new Uint8Array(pointCount)
  const generation = new Int32Array(pointCount)
  const heap: RemovalCandidate[] = []

  const enqueue = (index: number) => {
    if (
      alive[index] !== 1 ||
      previous[index]! < 0 ||
      next[index]! < 0
    ) {
      return
    }
    pushCandidate(heap, {
      index,
      generation: generation[index]!,
      priority: removalPriority(
        source,
        previous[index]!,
        index,
        next[index]!,
      ),
    })
  }

  for (let index = 0; index < pointCount; index += 1) {
    previous[index] = index === 0 ? (closed ? pointCount - 1 : -1) : index - 1
    next[index] =
      index + 1 === pointCount ? (closed ? 0 : -1) : index + 1
    alive[index] = 1
  }
  for (let index = 0; index < pointCount; index += 1) enqueue(index)

  const order: number[] = []
  let retained = pointCount
  while (
    retained > minimumPointCount &&
    heap.length > 0 &&
    budget.remaining > 0
  ) {
    const candidate = popCandidate(heap)
    const index = candidate.index
    if (
      alive[index] !== 1 ||
      candidate.generation !== generation[index]
    ) {
      continue
    }
    const left = previous[index]!
    const right = next[index]!
    if (left < 0 || right < 0) continue
    const chain = sourceChain(left, right, pointCount, closed)
    if (
      !replacementIsSafe(
        source[left]!,
        source[right]!,
        chain,
        source,
        options,
        budget,
      )
    ) {
      continue
    }

    alive[index] = 0
    next[left] = right
    previous[right] = left
    retained -= 1
    order.push(index)
    for (const neighbor of [left, right]) {
      generation[neighbor] = generation[neighbor]! + 1
      enqueue(neighbor)
    }
  }
  return order
}

function roundedPoints(
  points: readonly Readonly<CurvePoint>[],
  source: readonly Readonly<Point>[],
  closed: boolean,
  smoothing: number,
  options: Readonly<WatercolorBoundaryCurveOptions>,
): readonly Readonly<Point>[] {
  const current = points.map(({ point }): Readonly<Point> => point)
  const budget = {
    remaining: Math.max(1, source.length * WORK_UNITS_PER_POINT),
  }
  /*
   * Back off each vertex independently. One tight junction or alpha-support
   * corner must not force a thousand-point organic boundary back onto integer
   * lattice vertices. Canonical traversal makes the local updates stable, and
   * validating both incident source sub-arcs keeps every accepted move inside
   * the same global tube and positive-support contract.
   */
  for (let pass = 0; pass < ROUNDING_PASSES; pass += 1) {
    for (let index = 0; index < current.length; index += 1) {
      if (
        budget.remaining <= 0 ||
        (!closed && (index === 0 || index + 1 === current.length))
      ) {
        continue
      }
      const previousIndex =
        (index - 1 + current.length) % current.length
      const nextIndex = (index + 1) % current.length
      const previous = current[previousIndex]!
      const point = current[index]!
      const next = current[nextIndex]!
      const previousChain = sourceChain(
        points[previousIndex]!.sourceIndex,
        points[index]!.sourceIndex,
        source.length,
        closed,
      )
      const nextChain = sourceChain(
        points[index]!.sourceIndex,
        points[nextIndex]!.sourceIndex,
        source.length,
        closed,
      )
      if (previousChain.length < 2 || nextChain.length < 2) continue
      const target: Point = [
        (previous[0] + next[0]) / 2,
        (previous[1] + next[1]) / 2,
      ]

      for (let attempt = 0; attempt <= BACKOFF_ATTEMPTS; attempt += 1) {
        const candidate = interpolate(
          point,
          target,
          (MAX_LOCAL_ROUNDING_AMOUNT * smoothing) / 2 ** attempt,
        )
        if (
          replacementIsSafe(
            previous,
            candidate,
            previousChain,
            source,
            options,
            budget,
          ) &&
          replacementIsSafe(
            candidate,
            next,
            nextChain,
            source,
            options,
            budget,
          )
        ) {
          current[index] = candidate
          break
        }
      }
    }
  }
  return current
}

function fitPath(
  source: readonly Readonly<Point>[],
  closed: boolean,
  smoothing: number,
  options: Readonly<WatercolorBoundaryCurveOptions>,
): readonly Readonly<Point>[] {
  if (!sourceCurveIsSafe(source, closed, options)) return []
  if (smoothing === 0) return source

  const removalBudget = {
    remaining: Math.max(1, source.length * WORK_UNITS_PER_POINT),
  }

  const order = removalOrder(source, closed, options, removalBudget)
  const removalCount = Math.floor(order.length * smoothing)
  const removed = new Set(order.slice(0, removalCount))
  const retained = source
    .map((point, sourceIndex): CurvePoint => ({ point, sourceIndex }))
    .filter(({ sourceIndex }) => !removed.has(sourceIndex))

  return roundedPoints(retained, source, closed, smoothing, options)
}

function sourceCurveIsSafe(
  source: readonly Readonly<Point>[],
  closed: boolean,
  options: Readonly<WatercolorBoundaryCurveOptions>,
): boolean {
  const segmentCount = closed ? source.length : source.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = source[index]!
    const end = source[(index + 1) % source.length]!
    if (
      !inLattice(start, options) ||
      !inLattice(end, options) ||
      samePoint(start, end) ||
      !segmentHasPositiveSupport(start, end, options)
    ) {
      return false
    }
  }
  return true
}

function validOptions(
  options: Readonly<WatercolorBoundaryCurveOptions>,
): boolean {
  if (
    options === null ||
    typeof options !== 'object' ||
    !Number.isInteger(options.latticeWidth) ||
    !Number.isInteger(options.latticeHeight) ||
    options.latticeWidth < 1 ||
    options.latticeHeight < 1 ||
    options.latticeWidth > WATERCOLOR_FORMS_LIMITS.analysisMaxDimension ||
    options.latticeHeight > WATERCOLOR_FORMS_LIMITS.analysisMaxDimension
  ) {
    return false
  }
  if (
    options.positiveSupport !== undefined &&
    (!Array.isArray(options.positiveSupport) ||
      options.positiveSupport.length !==
        options.latticeWidth * options.latticeHeight ||
      options.positiveSupport.some((supported) => typeof supported !== 'boolean'))
  ) {
    return false
  }
  return (
    options.maxPointCount === undefined ||
    (Number.isInteger(options.maxPointCount) && options.maxPointCount >= 0)
  )
}

function validPath(
  path: Readonly<WatercolorBoundaryPath>,
  options: Readonly<WatercolorBoundaryCurveOptions>,
): boolean {
  if (
    path === null ||
    typeof path !== 'object' ||
    !Array.isArray(path.points) ||
    path.points.length > WATERCOLOR_FORMS_LIMITS.maxCurvePointCount + 1 ||
    typeof path.closed !== 'boolean' ||
    !Array.isArray(path.boundarySegmentIds) ||
    path.boundarySegmentIds.length >
      WATERCOLOR_FORMS_LIMITS.maxRetainedBoundarySegmentCount ||
    path.boundarySegmentIds.some(
      (id) => !Number.isInteger(id) || id < 0,
    )
  ) {
    return false
  }
  const explicitlyClosed =
    path.closed &&
    path.points.length > 1 &&
    finitePoint(path.points[0]) &&
    finitePoint(path.points.at(-1)) &&
    samePoint(path.points[0], path.points.at(-1)!)
  const pointCount = path.points.length - (explicitlyClosed ? 1 : 0)
  if (pointCount < (path.closed ? 3 : 2)) return false
  const points = path.points.slice(0, pointCount)
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    if (!finitePoint(point) || !inLattice(point, options)) return false
    const next =
      index + 1 < points.length
        ? points[index + 1]
        : path.closed
          ? points[0]
          : undefined
    if (next !== undefined && finitePoint(next) && samePoint(point, next)) {
      return false
    }
  }
  return true
}

function frozenPoint(point: Readonly<Point>): Readonly<Point> {
  return Object.freeze([point[0], point[1]]) as Readonly<Point>
}

/**
 * Fit every selected boundary independently and return the complete path prefix
 * that fits the deterministic point cap.
 */
export function fitWatercolorBoundaryCurves(
  paths: readonly Readonly<WatercolorBoundaryPath>[],
  smoothing: number,
  options: Readonly<WatercolorBoundaryCurveOptions>,
): readonly Readonly<WatercolorBoundaryPath>[] {
  if (
    !Array.isArray(paths) ||
    !Number.isFinite(smoothing) ||
    smoothing < 0 ||
    smoothing > 1 ||
    !validOptions(options)
  ) {
    return Object.freeze([])
  }
  const requestedLimit =
    options.maxPointCount ?? WATERCOLOR_FORMS_LIMITS.maxCurvePointCount
  const pointLimit = Math.min(
    requestedLimit,
    WATERCOLOR_FORMS_LIMITS.maxCurvePointCount,
  )
  const fitted: Readonly<WatercolorBoundaryPath>[] = []
  let reservedSourcePointCount = 0

  for (
    let pathIndex = 0;
    pathIndex <
    Math.min(paths.length, WATERCOLOR_FORMS_LIMITS.maxBoundaryPathCount);
    pathIndex += 1
  ) {
    const path = paths[pathIndex]!
    if (!validPath(path, options)) continue
    const explicitlyClosed =
      path.closed && samePoint(path.points[0]!, path.points.at(-1)!)
    const source = path.points.slice(
      0,
      path.points.length - (explicitlyClosed ? 1 : 0),
    )
    const sourcePointCount = source.length + (explicitlyClosed ? 1 : 0)
    if (reservedSourcePointCount + sourcePointCount > pointLimit) break
    const curve = fitPath(source, path.closed, smoothing, options)
    if (curve.length === 0) continue
    const points = curve.map(frozenPoint)
    if (explicitlyClosed) points.push(points[0]!)
    fitted.push(Object.freeze({
      points: Object.freeze(points),
      closed: path.closed,
      boundarySegmentIds: Object.freeze([...path.boundarySegmentIds]),
    }))
    reservedSourcePointCount += sourcePointCount
  }
  return Object.freeze(fitted)
}
