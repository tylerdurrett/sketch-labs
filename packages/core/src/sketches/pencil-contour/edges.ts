/**
 * Deterministic edge localization for Pencil Contour.
 *
 * Luminance and alpha deliberately remain separate signals. Luminance edges
 * are admitted only between two positively supported samples. Alpha boundaries
 * are interpolated at one private isovalue by marching squares, without
 * inventing samples beyond the analyzed raster. This means a flat opaque image
 * has no fitted perimeter while a real internal alpha transition remains
 * available to tracing.
 */

import type { Point } from '../../types'
import type {
  AnalyzedRaster,
  EdgeProvenance,
  LocalizedEdge,
  LocalizedEdgeGraph,
} from './types'

// A stable half-coverage boundary represents meaningful continuous opacity;
// exact alpha > 0 remains the separate permission policy in positiveSupport.
const ALPHA_BOUNDARY_ISOVALUE = 0.5
const MIN_LUMINANCE_EDGE_STRENGTH = 0.03
const MAX_LUMINANCE_EDGE_STRENGTH = 0.3
const MAX_SELECTION_FRACTION = 0.5
const MIN_EDGE_LENGTH = 1e-9
const MIN_EDGE_LENGTH_SQUARED = MIN_EDGE_LENGTH * MIN_EDGE_LENGTH
const QEF_RELATIVE_EPSILON = 1e-9
const DUAL_VERTEX_CELL_INSET = 1e-6
const PARAMETER_EPSILON = 1e-12

const LUMINANCE_PROVENANCE: Readonly<EdgeProvenance> = Object.freeze({
  kind: 'luminance',
})
const ALPHA_BOUNDARY_PROVENANCE: Readonly<EdgeProvenance> = Object.freeze({
  kind: 'alpha-boundary',
})

interface LuminanceCandidate {
  readonly orientation: 'horizontal-pair' | 'vertical-pair'
  readonly x: number
  readonly y: number
  readonly strength: number
  readonly order: number
  readonly hermite: HermiteSample
}

/** @internal Stable read-only identity for reference-fixture diagnostics. */
export interface PencilContourLuminanceCandidateDiagnostic {
  readonly id: string
  readonly strength: number
}

/**
 * @internal Selection inventory exposed only so downstream reference fixtures
 * can pin the real edge-admission inputs without copying this implementation.
 */
export interface PencilContourLuminanceSelectionDiagnostics {
  readonly beforeNms: number
  readonly afterNms: number
  readonly afterStrengthFloor: number
  readonly afterSelectionLimit: number
  readonly afterDetailSelection: number
  readonly selected: readonly Readonly<PencilContourLuminanceCandidateDiagnostic>[]
  readonly unselected: readonly Readonly<PencilContourLuminanceCandidateDiagnostic>[]
}

interface HermiteSample {
  readonly point: Readonly<Point>
  readonly normal: Readonly<Point>
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

function rasterIndex(width: number, x: number, y: number): number {
  return y * width + x
}

function freezePoint(x: number, y: number): Readonly<Point> {
  return Object.freeze([x, y] as Point)
}

function createEdge(
  start: Readonly<Point>,
  end: Readonly<Point>,
  provenance: Readonly<EdgeProvenance>,
): Readonly<LocalizedEdge> | undefined {
  const horizontal = end[0] - start[0]
  const vertical = end[1] - start[1]
  if (
    horizontal * horizontal + vertical * vertical <=
    MIN_EDGE_LENGTH_SQUARED
  ) {
    return undefined
  }
  return Object.freeze({ start, end, provenance })
}

function quantizedPoint(point: Readonly<Point>): readonly [number, number] {
  return [
    Math.round(point[0] / MIN_EDGE_LENGTH),
    Math.round(point[1] / MIN_EDGE_LENGTH),
  ]
}

/** Orientation-independent identity under the same epsilon as edge validity. */
function canonicalEdgeKey(edge: Readonly<LocalizedEdge>): string {
  const start = quantizedPoint(edge.start)
  const end = quantizedPoint(edge.end)
  const startsFirst =
    start[0] < end[0] || (start[0] === end[0] && start[1] <= end[1])
  const first = startsFirst ? start : end
  const second = startsFirst ? end : start
  return `${first[0]},${first[1]}:${second[0]},${second[1]}`
}

function supportedDifference(
  raster: Readonly<AnalyzedRaster>,
  firstIndex: number,
  secondIndex: number,
): number {
  if (
    raster.positiveSupport[firstIndex] !== true ||
    raster.positiveSupport[secondIndex] !== true
  ) {
    return 0
  }
  return Math.abs(
    (raster.luminance[secondIndex] ?? 0) -
      (raster.luminance[firstIndex] ?? 0),
  )
}

function horizontalDifference(
  raster: Readonly<AnalyzedRaster>,
  x: number,
  y: number,
): number {
  return supportedDifference(
    raster,
    rasterIndex(raster.width, x, y),
    rasterIndex(raster.width, x + 1, y),
  )
}

function verticalDifference(
  raster: Readonly<AnalyzedRaster>,
  x: number,
  y: number,
): number {
  return supportedDifference(
    raster,
    rasterIndex(raster.width, x, y),
    rasterIndex(raster.width, x, y + 1),
  )
}

function supportedPairDifference(
  raster: Readonly<AnalyzedRaster>,
  firstX: number,
  firstY: number,
  secondX: number,
  secondY: number,
): number | undefined {
  if (
    firstX < 0 ||
    firstY < 0 ||
    secondX < 0 ||
    secondY < 0 ||
    firstX >= raster.width ||
    secondX >= raster.width ||
    firstY >= raster.height ||
    secondY >= raster.height
  ) {
    return undefined
  }
  const firstIndex = rasterIndex(raster.width, firstX, firstY)
  const secondIndex = rasterIndex(raster.width, secondX, secondY)
  if (
    raster.positiveSupport[firstIndex] !== true ||
    raster.positiveSupport[secondIndex] !== true
  ) {
    return undefined
  }
  return Math.abs(
    (raster.luminance[secondIndex] ?? 0) -
      (raster.luminance[firstIndex] ?? 0),
  )
}

function parabolicPeakOffset(
  previous: number | undefined,
  center: number,
  next: number | undefined,
): number {
  // A missing or unsupported response is unknown, not a zero sample. Keeping
  // the discrete peak in that case prevents alpha holes from pulling it.
  if (previous === undefined || next === undefined) return 0
  const curvature = previous - 2 * center + next
  const curvatureEpsilon =
    16 * Number.EPSILON * Math.max(1, previous, center, next)
  if (curvature >= -curvatureEpsilon) return 0
  const offset = (0.5 * (previous - next)) / curvature
  return Math.min(0.5, Math.max(-0.5, offset))
}

function luminanceAt(
  raster: Readonly<AnalyzedRaster>,
  x: number,
  y: number,
): number | undefined {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) {
    return undefined
  }
  const index = rasterIndex(raster.width, x, y)
  return raster.positiveSupport[index] === true
    ? raster.luminance[index]
    : undefined
}

function sampleGradient(
  raster: Readonly<AnalyzedRaster>,
  x: number,
  y: number,
): Readonly<Point> {
  const center = luminanceAt(raster, x, y) ?? 0
  const left = luminanceAt(raster, x - 1, y)
  const right = luminanceAt(raster, x + 1, y)
  const top = luminanceAt(raster, x, y - 1)
  const bottom = luminanceAt(raster, x, y + 1)
  const dx =
    left !== undefined && right !== undefined
      ? (right - left) / 2
      : right !== undefined
        ? right - center
        : left !== undefined
          ? center - left
          : 0
  const dy =
    top !== undefined && bottom !== undefined
      ? (bottom - top) / 2
      : bottom !== undefined
        ? bottom - center
        : top !== undefined
          ? center - top
          : 0
  return [dx, dy]
}

function normalizedGradient(
  dx: number,
  dy: number,
  fallback: Readonly<Point>,
): Readonly<Point> {
  const length = Math.hypot(dx, dy)
  return length > MIN_EDGE_LENGTH
    ? freezePoint(dx / length, dy / length)
    : freezePoint(fallback[0], fallback[1])
}

function horizontalHermiteSample(
  raster: Readonly<AnalyzedRaster>,
  x: number,
  y: number,
  strength: number,
): HermiteSample {
  const previous = supportedPairDifference(raster, x - 1, y, x, y)
  const next = supportedPairDifference(raster, x + 1, y, x + 2, y)
  const amount = 0.5 + parabolicPeakOffset(previous, strength, next)
  const firstGradient = sampleGradient(raster, x, y)
  const secondGradient = sampleGradient(raster, x + 1, y)
  return {
    point: freezePoint(x + amount, y),
    normal: normalizedGradient(
      (raster.luminance[rasterIndex(raster.width, x + 1, y)] ?? 0) -
        (raster.luminance[rasterIndex(raster.width, x, y)] ?? 0),
      firstGradient[1] + (secondGradient[1] - firstGradient[1]) * amount,
      [1, 0],
    ),
  }
}

function verticalHermiteSample(
  raster: Readonly<AnalyzedRaster>,
  x: number,
  y: number,
  strength: number,
): HermiteSample {
  const previous = supportedPairDifference(raster, x, y - 1, x, y)
  const next = supportedPairDifference(raster, x, y + 1, x, y + 2)
  const amount = 0.5 + parabolicPeakOffset(previous, strength, next)
  const firstGradient = sampleGradient(raster, x, y)
  const secondGradient = sampleGradient(raster, x, y + 1)
  return {
    point: freezePoint(x, y + amount),
    normal: normalizedGradient(
      firstGradient[0] + (secondGradient[0] - firstGradient[0]) * amount,
      (raster.luminance[rasterIndex(raster.width, x, y + 1)] ?? 0) -
        (raster.luminance[rasterIndex(raster.width, x, y)] ?? 0),
      [0, 1],
    ),
  }
}

/**
 * Keep one deterministic representative from a flat response plateau.
 *
 * Missing neighbours are not treated as zero-strength samples: source edges
 * simply have one fewer comparison. Ties keep the later pair in scan order.
 */
function isSuppressed(
  strength: number,
  previousStrength: number | undefined,
  nextStrength: number | undefined,
): boolean {
  if (previousStrength !== undefined && strength < previousStrength) return true
  if (nextStrength !== undefined && strength <= nextStrength) return true
  return false
}

function luminanceCandidates(
  raster: Readonly<AnalyzedRaster>,
): readonly LuminanceCandidate[] {
  const candidates: LuminanceCandidate[] = []
  let order = 0

  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x + 1 < raster.width; x += 1) {
      const strength = horizontalDifference(raster, x, y)
      const previous =
        x > 0 ? horizontalDifference(raster, x - 1, y) : undefined
      const next =
        x + 2 < raster.width
          ? horizontalDifference(raster, x + 1, y)
          : undefined

      if (strength > 0 && !isSuppressed(strength, previous, next)) {
        candidates.push({
          orientation: 'horizontal-pair',
          x,
          y,
          strength,
          order,
          hermite: horizontalHermiteSample(raster, x, y, strength),
        })
      }
      order += 1
    }
  }

  for (let y = 0; y + 1 < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const strength = verticalDifference(raster, x, y)
      const previous =
        y > 0 ? verticalDifference(raster, x, y - 1) : undefined
      const next =
        y + 2 < raster.height
          ? verticalDifference(raster, x, y + 1)
          : undefined

      if (strength > 0 && !isSuppressed(strength, previous, next)) {
        candidates.push({
          orientation: 'vertical-pair',
          x,
          y,
          strength,
          order,
          hermite: verticalHermiteSample(raster, x, y, strength),
        })
      }
      order += 1
    }
  }

  return candidates
}

function positiveLuminancePairCount(
  raster: Readonly<AnalyzedRaster>,
): number {
  let count = 0
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x + 1 < raster.width; x += 1) {
      if (horizontalDifference(raster, x, y) > 0) count += 1
    }
  }
  for (let y = 0; y + 1 < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if (verticalDifference(raster, x, y) > 0) count += 1
    }
  }
  return count
}

function candidateDiagnostic(
  candidate: Readonly<LuminanceCandidate>,
): Readonly<PencilContourLuminanceCandidateDiagnostic> {
  const orientation =
    candidate.orientation === 'horizontal-pair' ? 'horizontal' : 'vertical'
  return Object.freeze({
    id: `${orientation}:${candidate.x},${candidate.y}`,
    strength: candidate.strength,
  })
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`
}

function candidateCells(
  raster: Readonly<AnalyzedRaster>,
  candidate: Readonly<LuminanceCandidate>,
): readonly (readonly [number, number])[] {
  const cells: (readonly [number, number])[] = []
  const add = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x + 1 < raster.width && y + 1 < raster.height) {
      cells.push([x, y])
    }
  }
  if (candidate.orientation === 'horizontal-pair') {
    add(candidate.x, candidate.y - 1)
    add(candidate.x, candidate.y)
  } else {
    add(candidate.x - 1, candidate.y)
    add(candidate.x, candidate.y)
  }
  return cells
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

interface QefVertexCandidate {
  readonly x: number
  readonly y: number
}

function qefEnergy(
  samples: readonly Readonly<HermiteSample>[],
  candidate: Readonly<QefVertexCandidate>,
): number {
  let energy = 0
  for (const { point, normal } of samples) {
    const residual =
      normal[0] * (candidate.x - point[0]) +
      normal[1] * (candidate.y - point[1])
    energy += residual * residual
  }
  return energy
}

/**
 * Closest-to-cell-centre box-constrained least-squares solution, including
 * rank-one QEFs. Exported only so the boundary active set can be regression
 * tested without coupling the fixture to raster candidate extraction.
 */
export function solveDualVertex(
  samples: readonly Readonly<HermiteSample>[],
  cellX: number,
  cellY: number,
): Readonly<Point> {
  const centerX = cellX + 0.5
  const centerY = cellY + 0.5
  const minimumX = cellX + DUAL_VERTEX_CELL_INSET
  const maximumX = cellX + 1 - DUAL_VERTEX_CELL_INSET
  const minimumY = cellY + DUAL_VERTEX_CELL_INSET
  const maximumY = cellY + 1 - DUAL_VERTEX_CELL_INSET
  let a00 = 0
  let a01 = 0
  let a11 = 0
  let b0 = 0
  let b1 = 0
  let averageX = 0
  let averageY = 0
  for (const { point, normal } of samples) {
    const [nx, ny] = normal
    const projection = nx * point[0] + ny * point[1]
    a00 += nx * nx
    a01 += nx * ny
    a11 += ny * ny
    b0 += nx * projection
    b1 += ny * projection
    averageX += point[0]
    averageY += point[1]
  }

  const trace = a00 + a11
  let x = centerX
  let y = centerY
  if (trace > MIN_EDGE_LENGTH) {
    const residualX = b0 - (a00 * centerX + a01 * centerY)
    const residualY = b1 - (a01 * centerX + a11 * centerY)
    const discriminant = Math.hypot(a00 - a11, 2 * a01)
    const eigenvalues = [(trace + discriminant) / 2, (trace - discriminant) / 2]
    const rotation = Math.atan2(2 * a01, a00 - a11) / 2
    const eigenvectors: readonly (readonly [number, number])[] = [
      [Math.cos(rotation), Math.sin(rotation)],
      [-Math.sin(rotation), Math.cos(rotation)],
    ]
    for (let index = 0; index < eigenvalues.length; index += 1) {
      const eigenvalue = eigenvalues[index]!
      if (eigenvalue <= trace * QEF_RELATIVE_EPSILON) continue
      const [eigenX, eigenY] = eigenvectors[index]!
      const amount =
        (eigenX * residualX + eigenY * residualY) / eigenvalue
      x += eigenX * amount
      y += eigenY * amount
    }
  } else if (samples.length > 0) {
    x = averageX / samples.length
    y = averageY / samples.length
  }

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    x = samples.length > 0 ? averageX / samples.length : centerX
    y = samples.length > 0 ? averageY / samples.length : centerY
  }

  const candidates: QefVertexCandidate[] = []
  if (
    x >= minimumX &&
    x <= maximumX &&
    y >= minimumY &&
    y <= maximumY
  ) {
    candidates.push({ x, y })
  }

  const solveY = (fixedX: number): number =>
    a11 > 0
      ? clamp((b1 - a01 * fixedX) / a11, minimumY, maximumY)
      : centerY
  const solveX = (fixedY: number): number =>
    a00 > 0
      ? clamp((b0 - a01 * fixedY) / a00, minimumX, maximumX)
      : centerX

  // Every minimizer of a convex quadratic over a rectangle is either the
  // unconstrained solution, a one-dimensional side optimum, or a corner.
  // Corners are listed explicitly so degenerate side objectives stay exact.
  candidates.push(
    { x: minimumX, y: solveY(minimumX) },
    { x: maximumX, y: solveY(maximumX) },
    { x: solveX(minimumY), y: minimumY },
    { x: solveX(maximumY), y: maximumY },
    { x: minimumX, y: minimumY },
    { x: minimumX, y: maximumY },
    { x: maximumX, y: minimumY },
    { x: maximumX, y: maximumY },
  )

  let best = candidates[0]!
  let bestEnergy = qefEnergy(samples, best)
  let bestCenterDistance =
    (best.x - centerX) ** 2 + (best.y - centerY) ** 2
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]!
    const energy = qefEnergy(samples, candidate)
    const energyTolerance =
      64 * Number.EPSILON * Math.max(1, Math.abs(bestEnergy), Math.abs(energy))
    const centerDistance =
      (candidate.x - centerX) ** 2 + (candidate.y - centerY) ** 2
    const centerTolerance =
      64 *
      Number.EPSILON *
      Math.max(1, bestCenterDistance, centerDistance)
    if (
      energy < bestEnergy - energyTolerance ||
      (Math.abs(energy - bestEnergy) <= energyTolerance &&
        centerDistance < bestCenterDistance - centerTolerance)
    ) {
      best = candidate
      bestEnergy = energy
      bestCenterDistance = centerDistance
    }
  }

  return freezePoint(best.x, best.y)
}

function dualVertices(
  raster: Readonly<AnalyzedRaster>,
  candidates: readonly Readonly<LuminanceCandidate>[],
): ReadonlyMap<string, Readonly<Point>> {
  const samplesByCell = new Map<string, HermiteSample[]>()
  for (const candidate of candidates) {
    for (const [cellX, cellY] of candidateCells(raster, candidate)) {
      const key = cellKey(cellX, cellY)
      const samples = samplesByCell.get(key)
      if (samples === undefined) samplesByCell.set(key, [candidate.hermite])
      else samples.push(candidate.hermite)
    }
  }

  const vertices = new Map<string, Readonly<Point>>()
  for (const [key, samples] of samplesByCell) {
    const [cellX, cellY] = key.split(',').map(Number) as [number, number]
    vertices.set(key, solveDualVertex(samples, cellX, cellY))
  }
  return vertices
}

function samplePositiveSupport(
  raster: Readonly<AnalyzedRaster>,
  point: Readonly<Point>,
): boolean {
  if (
    point[0] < 0 ||
    point[1] < 0 ||
    point[0] > raster.width - 1 ||
    point[1] > raster.height - 1
  ) {
    return false
  }
  const left = Math.min(Math.floor(point[0]), raster.width - 1)
  const top = Math.min(Math.floor(point[1]), raster.height - 1)
  const right = Math.min(left + 1, raster.width - 1)
  const bottom = Math.min(top + 1, raster.height - 1)
  const horizontal = point[0] - left
  const vertical = point[1] - top
  const support = (x: number, y: number) =>
    raster.positiveSupport[rasterIndex(raster.width, x, y)] === true &&
    (raster.alpha[rasterIndex(raster.width, x, y)] ?? 0) > 0
      ? 1
      : 0
  const topValue =
    support(left, top) * (1 - horizontal) +
    support(right, top) * horizontal
  const bottomValue =
    support(left, bottom) * (1 - horizontal) +
    support(right, bottom) * horizontal
  return topValue * (1 - vertical) + bottomValue * vertical > 0
}

function supportedSegment(
  raster: Readonly<AnalyzedRaster>,
  start: Readonly<Point>,
  end: Readonly<Point>,
): boolean {
  const parameters = [0, 1]
  const addLatticeCrossings = (first: number, second: number, limit: number) => {
    const delta = second - first
    if (delta === 0) return
    for (
      let boundary = Math.max(0, Math.ceil(Math.min(first, second)));
      boundary <= Math.min(limit - 1, Math.floor(Math.max(first, second)));
      boundary += 1
    ) {
      const amount = (boundary - first) / delta
      if (amount > PARAMETER_EPSILON && amount < 1 - PARAMETER_EPSILON) {
        parameters.push(amount)
      }
    }
  }
  addLatticeCrossings(start[0], end[0], raster.width)
  addLatticeCrossings(start[1], end[1], raster.height)
  parameters.sort((first, second) => first - second)
  const unique = parameters.filter(
    (amount, index) =>
      index === 0 ||
      Math.abs(amount - parameters[index - 1]!) > PARAMETER_EPSILON,
  )
  const supportedAt = (amount: number) =>
    samplePositiveSupport(raster, [
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

function luminanceEdge(
  raster: Readonly<AnalyzedRaster>,
  candidate: Readonly<LuminanceCandidate>,
  vertices: ReadonlyMap<string, Readonly<Point>>,
): Readonly<LocalizedEdge> | undefined {
  let start: Readonly<Point> | undefined
  let end: Readonly<Point> | undefined
  if (candidate.orientation === 'horizontal-pair') {
    start =
      candidate.y > 0
        ? vertices.get(cellKey(candidate.x, candidate.y - 1))
        : candidate.hermite.point
    end =
      candidate.y + 1 < raster.height
        ? vertices.get(cellKey(candidate.x, candidate.y))
        : candidate.hermite.point
  } else {
    start =
      candidate.x > 0
        ? vertices.get(cellKey(candidate.x - 1, candidate.y))
        : candidate.hermite.point
    end =
      candidate.x + 1 < raster.width
        ? vertices.get(cellKey(candidate.x, candidate.y))
        : candidate.hermite.point
  }
  if (
    start === undefined ||
    end === undefined ||
    !supportedSegment(raster, start, end)
  ) {
    return undefined
  }
  return createEdge(start, end, LUMINANCE_PROVENANCE)
}

function selectionLimit(raster: Readonly<AnalyzedRaster>): number {
  // A fixed ceiling keeps growth bounded without breaking a strong contour
  // into progressively longer fragments as detail changes.
  return Math.ceil(
    raster.width * raster.height * MAX_SELECTION_FRACTION,
  )
}

function candidateUniverse(
  raster: Readonly<AnalyzedRaster>,
  candidates: readonly Readonly<LuminanceCandidate>[],
): readonly Readonly<LuminanceCandidate>[] {
  return candidates
    .filter(({ strength }) => strength >= MIN_LUMINANCE_EDGE_STRENGTH)
    .sort((first, second) =>
      second.strength === first.strength
        ? first.order - second.order
        : second.strength - first.strength,
    )
    .slice(0, selectionLimit(raster))
}

function detailCandidates(
  universe: readonly Readonly<LuminanceCandidate>[],
  contourDetail: number,
): readonly Readonly<LuminanceCandidate>[] {
  const detail = clampUnit(contourDetail)
  const threshold =
    MAX_LUMINANCE_EDGE_STRENGTH -
    detail *
      (MAX_LUMINANCE_EDGE_STRENGTH - MIN_LUMINANCE_EDGE_STRENGTH)
  return universe
    .filter(({ strength }) => strength >= threshold)
    .sort((first, second) => first.order - second.order)
}

function selectLuminanceEdges(
  raster: Readonly<AnalyzedRaster>,
  contourDetail: number,
): readonly Readonly<LocalizedEdge>[] {
  const candidates = luminanceCandidates(raster)

  // Geometry is solved from the complete bounded universe that any detail can
  // admit. A candidate retained at multiple detail values therefore reuses
  // exactly the same endpoints and connectivity.
  const universe = candidateUniverse(raster, candidates)
  const vertices = dualVertices(raster, universe)
  const selected = detailCandidates(universe, contourDetail)
    .map((candidate) => luminanceEdge(raster, candidate, vertices))
    .filter(
      (edge): edge is Readonly<LocalizedEdge> => edge !== undefined,
    )

  return selected
}

/**
 * Inspect deterministic luminance admission for an exact downstream fixture.
 * This does not participate in generation and does not retain Hermite samples.
 */
export function inspectPencilContourLuminanceSelection(
  raster: Readonly<AnalyzedRaster>,
  contourDetail: number,
): Readonly<PencilContourLuminanceSelectionDiagnostics> {
  const candidates = luminanceCandidates(raster)
  const aboveFloor = candidates.filter(
    ({ strength }) => strength >= MIN_LUMINANCE_EDGE_STRENGTH,
  )
  const universe = candidateUniverse(raster, candidates)
  const selected = detailCandidates(universe, contourDetail)
  const selectedOrders = new Set(selected.map(({ order }) => order))

  return Object.freeze({
    beforeNms: positiveLuminancePairCount(raster),
    afterNms: candidates.length,
    afterStrengthFloor: aboveFloor.length,
    afterSelectionLimit: universe.length,
    afterDetailSelection: selected.length,
    selected: Object.freeze(selected.map(candidateDiagnostic)),
    unselected: Object.freeze(
      aboveFloor
        .filter(({ order }) => !selectedOrders.has(order))
        .map(candidateDiagnostic),
    ),
  })
}

type CellEdge = 'top' | 'right' | 'bottom' | 'left'

function interpolateIsovalue(
  start: Readonly<Point>,
  end: Readonly<Point>,
  startValue: number,
  endValue: number,
): Readonly<Point> {
  const amount =
    (ALPHA_BOUNDARY_ISOVALUE - startValue) / (endValue - startValue)
  return freezePoint(
    start[0] + (end[0] - start[0]) * amount,
    start[1] + (end[1] - start[1]) * amount,
  )
}

function alphaCellCrossings(
  raster: Readonly<AnalyzedRaster>,
  x: number,
  y: number,
): Readonly<Record<CellEdge, Readonly<Point> | undefined>> {
  const topLeftIndex = rasterIndex(raster.width, x, y)
  const topRightIndex = topLeftIndex + 1
  const bottomLeftIndex = topLeftIndex + raster.width
  const bottomRightIndex = bottomLeftIndex + 1
  const topLeft = raster.alpha[topLeftIndex] ?? 0
  const topRight = raster.alpha[topRightIndex] ?? 0
  const bottomRight = raster.alpha[bottomRightIndex] ?? 0
  const bottomLeft = raster.alpha[bottomLeftIndex] ?? 0
  const crosses = (first: number, second: number) =>
    (first >= ALPHA_BOUNDARY_ISOVALUE) !==
    (second >= ALPHA_BOUNDARY_ISOVALUE)

  return {
    top: crosses(topLeft, topRight)
      ? interpolateIsovalue(
          freezePoint(x, y),
          freezePoint(x + 1, y),
          topLeft,
          topRight,
        )
      : undefined,
    right: crosses(topRight, bottomRight)
      ? interpolateIsovalue(
          freezePoint(x + 1, y),
          freezePoint(x + 1, y + 1),
          topRight,
          bottomRight,
        )
      : undefined,
    bottom: crosses(bottomLeft, bottomRight)
      ? interpolateIsovalue(
          freezePoint(x, y + 1),
          freezePoint(x + 1, y + 1),
          bottomLeft,
          bottomRight,
        )
      : undefined,
    left: crosses(topLeft, bottomLeft)
      ? interpolateIsovalue(
          freezePoint(x, y),
          freezePoint(x, y + 1),
          topLeft,
          bottomLeft,
        )
      : undefined,
  }
}

const CELL_CONNECTIONS: Readonly<
  Record<number, readonly (readonly [CellEdge, CellEdge])[]>
> = Object.freeze({
  0: [],
  1: [['left', 'top']],
  2: [['top', 'right']],
  3: [['left', 'right']],
  4: [['right', 'bottom']],
  5: [
    ['left', 'top'],
    ['right', 'bottom'],
  ],
  6: [['top', 'bottom']],
  7: [['left', 'bottom']],
  8: [['bottom', 'left']],
  9: [['top', 'bottom']],
  10: [
    ['top', 'right'],
    ['bottom', 'left'],
  ],
  11: [['right', 'bottom']],
  12: [['left', 'right']],
  13: [['top', 'right']],
  14: [['left', 'top']],
  15: [],
})

function alphaBoundaryEdges(
  raster: Readonly<AnalyzedRaster>,
): readonly Readonly<LocalizedEdge>[] {
  const edges: Readonly<LocalizedEdge>[] = []
  const edgeKeys = new Set<string>()

  for (let y = 0; y + 1 < raster.height; y += 1) {
    for (let x = 0; x + 1 < raster.width; x += 1) {
      const topLeftIndex = rasterIndex(raster.width, x, y)
      const topRightIndex = topLeftIndex + 1
      const bottomLeftIndex = topLeftIndex + raster.width
      const bottomRightIndex = bottomLeftIndex + 1
      const cellCase =
        ((raster.alpha[topLeftIndex] ?? 0) >= ALPHA_BOUNDARY_ISOVALUE
          ? 1
          : 0) |
        ((raster.alpha[topRightIndex] ?? 0) >= ALPHA_BOUNDARY_ISOVALUE
          ? 2
          : 0) |
        ((raster.alpha[bottomRightIndex] ?? 0) >= ALPHA_BOUNDARY_ISOVALUE
          ? 4
          : 0) |
        ((raster.alpha[bottomLeftIndex] ?? 0) >= ALPHA_BOUNDARY_ISOVALUE
          ? 8
          : 0)
      const crossings = alphaCellCrossings(raster, x, y)

      for (const [startSide, endSide] of CELL_CONNECTIONS[cellCase] ?? []) {
        const start = crossings[startSide]
        const end = crossings[endSide]
        if (start !== undefined && end !== undefined) {
          const edge = createEdge(start, end, ALPHA_BOUNDARY_PROVENANCE)
          if (edge !== undefined) {
            const key = canonicalEdgeKey(edge)
            if (!edgeKeys.has(key)) {
              edgeKeys.add(key)
              edges.push(edge)
            }
          }
        }
      }
    }
  }

  return edges
}

/**
 * Localize a prepared raster into deterministic tracing-ready edge segments.
 *
 * Detail changes only luminance admission. The fixed alpha boundary signal and
 * retained permission fields are identical at every detail value.
 */
export function localizePencilContourEdges(
  raster: Readonly<AnalyzedRaster>,
  contourDetail: number,
): Readonly<LocalizedEdgeGraph> {
  const edges = Object.freeze([
    ...selectLuminanceEdges(raster, contourDetail),
    ...alphaBoundaryEdges(raster),
  ])

  return Object.freeze({
    width: raster.width,
    height: raster.height,
    alpha: raster.alpha,
    positiveSupport: raster.positiveSupport,
    edges,
  })
}
