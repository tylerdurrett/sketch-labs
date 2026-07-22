/**
 * Headless Pencil Contour composition.
 *
 * The generator joins the bounded analysis stages and is deliberately unaware
 * of Image Assets, Sketch registration, Seeds, shading, and rendering. Its only
 * output is ordinary Scene geometry in the supplied Composition Frame.
 */

import { createRasterContainFit } from '../../rasterSampling'
import { createScene, type CoordinateSpace, type Primitive } from '../../scene'
import type { Point } from '../../types'
import { analyzePencilContourRaster } from './analysis'
import { cleanupPencilContourPaths } from './cleanup'
import {
  defaultPencilContourControls,
  normalizePencilContourControls,
  type PencilContourControls,
} from './controls'
import { localizePencilContourEdges } from './edges'
import { tracePencilContourEdges } from './tracing'
import type {
  LocalizedEdgeGraph,
  PencilContourGeneratorInput,
  PencilContourGeneratorResult,
  TracedContourPath,
} from './types'

const STROKE = Object.freeze({ color: 'black', width: 1 })
const HALF_ALPHA = 0.5
const ISOVALUE_TOLERANCE = 1e-7
const PARAMETER_EPSILON = 1e-12
const POINT_EPSILON_SQUARED = 1e-18

function frameFrom(input: unknown): CoordinateSpace {
  if (input === null || typeof input !== 'object') {
    return { width: 0, height: 0 }
  }
  const frame = (input as { readonly frame?: unknown }).frame
  if (frame === null || typeof frame !== 'object') {
    return { width: 0, height: 0 }
  }
  const candidate = frame as {
    readonly width?: unknown
    readonly height?: unknown
  }
  return {
    width: typeof candidate.width === 'number' ? candidate.width : 0,
    height: typeof candidate.height === 'number' ? candidate.height : 0,
  }
}

function controlsFrom(input: unknown): Partial<PencilContourControls> {
  if (input === null || typeof input !== 'object') {
    return defaultPencilContourControls
  }
  const controls = (input as { readonly controls?: unknown }).controls
  return controls !== null && typeof controls === 'object'
    ? (controls as Partial<PencilContourControls>)
    : defaultPencilContourControls
}

function pixelsFrom(input: unknown): PencilContourGeneratorInput['pixels'] {
  if (input !== null && typeof input === 'object') {
    return (input as { readonly pixels?: unknown })
      .pixels as PencilContourGeneratorInput['pixels']
  }
  return null as unknown as PencilContourGeneratorInput['pixels']
}

function finiteLatticePoint(
  point: unknown,
  graph: Readonly<LocalizedEdgeGraph>,
): point is Readonly<Point> {
  return (
    Array.isArray(point) &&
    point.length === 2 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    point[0] >= 0 &&
    point[1] >= 0 &&
    point[0] <= graph.width - 1 &&
    point[1] <= graph.height - 1
  )
}

function sampleField(
  values: readonly number[],
  graph: Readonly<LocalizedEdgeGraph>,
  point: Readonly<Point>,
): number | undefined {
  if (!finiteLatticePoint(point, graph)) return undefined
  const left = Math.min(Math.floor(point[0]), graph.width - 1)
  const top = Math.min(Math.floor(point[1]), graph.height - 1)
  const right = Math.min(left + 1, graph.width - 1)
  const bottom = Math.min(top + 1, graph.height - 1)
  const horizontal = point[0] - left
  const vertical = point[1] - top
  const topValue =
    values[top * graph.width + left]! * (1 - horizontal) +
    values[top * graph.width + right]! * horizontal
  const bottomValue =
    values[bottom * graph.width + left]! * (1 - horizontal) +
    values[bottom * graph.width + right]! * horizontal
  return topValue * (1 - vertical) + bottomValue * vertical
}

function pointHasPositiveSupport(
  graph: Readonly<LocalizedEdgeGraph>,
  point: Readonly<Point>,
): boolean {
  const alpha = sampleField(graph.alpha, graph, point)
  if (alpha === undefined || alpha <= 0) return false
  if (!finiteLatticePoint(point, graph)) return false
  const left = Math.min(Math.floor(point[0]), graph.width - 1)
  const top = Math.min(Math.floor(point[1]), graph.height - 1)
  const right = Math.min(left + 1, graph.width - 1)
  const bottom = Math.min(top + 1, graph.height - 1)
  const horizontal = point[0] - left
  const vertical = point[1] - top
  const supportAt = (x: number, y: number) =>
    graph.positiveSupport[y * graph.width + x] === true ? 1 : 0
  const topSupport =
    supportAt(left, top) * (1 - horizontal) +
    supportAt(right, top) * horizontal
  const bottomSupport =
    supportAt(left, bottom) * (1 - horizontal) +
    supportAt(right, bottom) * horizontal
  const support = topSupport * (1 - vertical) + bottomSupport * vertical
  return support > 0
}

/** Check exact-zero permission on each open bilinear-cell interval. */
function segmentHasPositiveSupport(
  graph: Readonly<LocalizedEdgeGraph>,
  start: Readonly<Point>,
  end: Readonly<Point>,
): boolean {
  const parameters = [0, 1]
  const addLatticeCrossings = (first: number, second: number, limit: number) => {
    const delta = second - first
    if (delta === 0) return
    const firstBoundary = Math.max(0, Math.ceil(Math.min(first, second)))
    const lastBoundary = Math.min(limit - 1, Math.floor(Math.max(first, second)))
    for (let boundary = firstBoundary; boundary <= lastBoundary; boundary += 1) {
      const amount = (boundary - first) / delta
      if (amount > PARAMETER_EPSILON && amount < 1 - PARAMETER_EPSILON) {
        parameters.push(amount)
      }
    }
  }
  addLatticeCrossings(start[0], end[0], graph.width)
  addLatticeCrossings(start[1], end[1], graph.height)
  parameters.sort((first, second) => first - second)

  const unique = parameters.filter(
    (amount, index) =>
      index === 0 ||
      Math.abs(amount - parameters[index - 1]!) > PARAMETER_EPSILON,
  )
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

function validGraph(graph: Readonly<LocalizedEdgeGraph>): boolean {
  if (
    graph === null ||
    typeof graph !== 'object' ||
    !Number.isSafeInteger(graph.width) ||
    !Number.isSafeInteger(graph.height) ||
    graph.width < 1 ||
    graph.height < 1
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
    const alpha = graph.alpha[index]
    if (
      !Object.prototype.hasOwnProperty.call(graph.alpha, index) ||
      !Object.prototype.hasOwnProperty.call(graph.positiveSupport, index) ||
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

/** Last permission/topology guard before lattice coordinates leave the pipeline. */
function validFinalPath(
  path: Readonly<TracedContourPath>,
  graph: Readonly<LocalizedEdgeGraph>,
): boolean {
  const pathProvenance =
    path !== null && typeof path === 'object' ? path.provenance : undefined
  if (
    path === null ||
    typeof path !== 'object' ||
    typeof path.closed !== 'boolean' ||
    !Array.isArray(path.points) ||
    pathProvenance === null ||
    typeof pathProvenance !== 'object' ||
    (pathProvenance.kind !== 'luminance' &&
      pathProvenance.kind !== 'alpha-boundary')
  ) {
    return false
  }
  const minimumPointCount = path.closed ? 3 : 2
  if (path.points.length < minimumPointCount) return false

  for (let index = 0; index < path.points.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(path.points, index)) return false
    const point = path.points[index]
    if (
      !finiteLatticePoint(point, graph) ||
      !pointHasPositiveSupport(graph, point)
    ) {
      return false
    }
    if (path.provenance.kind === 'alpha-boundary') {
      const alpha = sampleField(graph.alpha, graph, point)
      if (
        alpha === undefined ||
        Math.abs(alpha - HALF_ALPHA) > ISOVALUE_TOLERANCE
      ) {
        return false
      }
    }
  }

  const segmentCount = path.closed ? path.points.length : path.points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = path.points[index]!
    const end = path.points[(index + 1) % path.points.length]!
    const dx = end[0] - start[0]
    const dy = end[1] - start[1]
    if (
      dx * dx + dy * dy <= POINT_EPSILON_SQUARED ||
      !segmentHasPositiveSupport(graph, start, end)
    ) {
      return false
    }
  }
  return true
}

function mappedPrimitive(
  path: Readonly<TracedContourPath>,
  graph: Readonly<LocalizedEdgeGraph>,
  fit: NonNullable<ReturnType<typeof createRasterContainFit>>,
): Primitive | undefined {
  const points = path.points.map((point) => {
    // Analysis samples are pixel centres. Reusing that normalized placement is
    // what makes this exactly the same contain fit as the source raster.
    const x = fit.left + ((point[0] + 0.5) / graph.width) * fit.fittedWidth
    const y = fit.top + ((point[1] + 0.5) / graph.height) * fit.fittedHeight
    return [x, y] as Point
  })
  if (
    points.some(
      (point) => !Number.isFinite(point[0]) || !Number.isFinite(point[1]),
    )
  ) {
    return undefined
  }
  return {
    points,
    closed: path.closed,
    stroke: { ...STROKE },
    hiddenLineRole: 'source',
  }
}

/**
 * Deterministically extract contain-fitted contour geometry from decoded RGBA8.
 *
 * Untrusted controls are normalized once at this orchestration boundary. Any
 * malformed, empty, or permission-invalid result fails closed to an empty Scene
 * whose coordinate space is the exact supplied frame value.
 */
export function generatePencilContour(
  input: Readonly<PencilContourGeneratorInput>,
): PencilContourGeneratorResult {
  const frame = frameFrom(input)
  const empty = () => ({ scene: createScene(frame).build() })
  const controls = normalizePencilContourControls(controlsFrom(input))
  const analyzed = analyzePencilContourRaster(pixelsFrom(input), frame, controls)
  const fit = createRasterContainFit(
    { width: analyzed.sourceWidth, height: analyzed.sourceHeight },
    frame,
  )
  if (fit === null) return empty()

  const graph = localizePencilContourEdges(analyzed, controls.contourDetail)
  if (!validGraph(graph)) return empty()
  const traced = tracePencilContourEdges(graph)
  const cleaned = cleanupPencilContourPaths({
    paths: traced,
    graph,
    detail: controls.contourDetail,
    smoothing: controls.contourSmoothing,
  })
  if (
    cleaned.length === 0 ||
    !cleaned.every((path) => validFinalPath(path, graph))
  ) {
    return empty()
  }

  const primitives = cleaned.map((path) => mappedPrimitive(path, graph, fit))
  if (
    !primitives.every(
      (primitive): primitive is Primitive => primitive !== undefined,
    )
  ) {
    return empty()
  }
  const scene = createScene(frame)
  for (const primitive of primitives) scene.add(primitive)
  return { scene: scene.build() }
}
