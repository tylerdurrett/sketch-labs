/**
 * Pure headless composition for Watercolor Forms.
 *
 * Region analysis remains in lattice coordinates until the final guard. Those
 * boundary vertices are normalized against the analysis dimensions and mapped
 * through a contain fit built from the original decoded dimensions, preserving
 * the exact placement shared by every photo-backed Sketch.
 */

import { createRasterContainFit } from '../../rasterSampling'
import { createScene, type CoordinateSpace, type Primitive } from '../../scene'
import type { Point } from '../../types'
import { prepareWatercolorFormsRaster } from './analysis'
import { extractWatercolorSharedBoundaries } from './boundaries'
import {
  defaultWatercolorFormsControls,
  normalizeWatercolorFormsControls,
  type WatercolorFormsControls,
} from './controls'
import { fitWatercolorBoundaryCurves } from './curves'
import { selectWatercolorForms } from './forms'
import { buildWatercolorFormsHierarchyWithDiagnostics } from './hierarchy'
import { WATERCOLOR_FORMS_LIMITS } from './limits'
import { partitionWatercolorFormsRaster } from './partition'
import { traceWatercolorBoundaryNetwork } from './tracing'
import type {
  PreparedWatercolorRaster,
  WatercolorBoundaryPath,
  WatercolorFormsDiagnostics,
  WatercolorFormsGeneratorInput,
  WatercolorFormsGeneratorResult,
  WatercolorFormsTermination,
} from './types'

const STROKE = Object.freeze({ color: 'black', width: 1 })
const COORDINATE_EPSILON = 1e-9

interface MutableDiagnostics {
  termination: WatercolorFormsTermination
  limitedBy: WatercolorFormsDiagnostics['limitedBy']
  analysisWidth: number
  analysisHeight: number
  sampleCount: number
  initialRegionCount: number
  gridAdjacencyCount: number
  mergeCount: number
  mergeQueueEntryCount: number
  regionUpdateCount: number
  selectedRegionCount: number
  retainedBoundarySegmentCount: number
  boundaryPathCount: number
  curvePointCount: number
  primitiveCount: number
}

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

function controlsFrom(input: unknown): Partial<WatercolorFormsControls> {
  if (input === null || typeof input !== 'object') {
    return defaultWatercolorFormsControls
  }
  const controls = (input as { readonly controls?: unknown }).controls
  return controls !== null && typeof controls === 'object'
    ? (controls as Partial<WatercolorFormsControls>)
    : defaultWatercolorFormsControls
}

function pixelsFrom(input: unknown): WatercolorFormsGeneratorInput['pixels'] {
  if (input !== null && typeof input === 'object') {
    return (input as { readonly pixels?: unknown })
      .pixels as WatercolorFormsGeneratorInput['pixels']
  }
  return null as unknown as WatercolorFormsGeneratorInput['pixels']
}

function initialDiagnostics(): MutableDiagnostics {
  return {
    termination: 'complete',
    limitedBy: null,
    analysisWidth: 0,
    analysisHeight: 0,
    sampleCount: 0,
    initialRegionCount: 0,
    gridAdjacencyCount: 0,
    mergeCount: 0,
    mergeQueueEntryCount: 0,
    regionUpdateCount: 0,
    selectedRegionCount: 0,
    retainedBoundarySegmentCount: 0,
    boundaryPathCount: 0,
    curvePointCount: 0,
    primitiveCount: 0,
  }
}

function frozenDiagnostics(
  diagnostics: Readonly<MutableDiagnostics>,
): Readonly<WatercolorFormsDiagnostics> {
  return Object.freeze({ ...diagnostics })
}

function result(
  frame: Readonly<CoordinateSpace>,
  diagnostics: Readonly<MutableDiagnostics>,
  primitives: readonly Readonly<Primitive>[] = [],
): WatercolorFormsGeneratorResult {
  const builder = createScene(frame)
  for (const primitive of primitives) builder.add(primitive as Primitive)
  return Object.freeze({
    scene: builder.build(),
    diagnostics: frozenDiagnostics(diagnostics),
  })
}

function invalidResult(
  frame: Readonly<CoordinateSpace>,
  diagnostics: MutableDiagnostics,
): WatercolorFormsGeneratorResult {
  diagnostics.termination = 'invalid-input'
  diagnostics.limitedBy = null
  diagnostics.curvePointCount = 0
  diagnostics.primitiveCount = 0
  return result(frame, diagnostics)
}

function validPreparedRaster(
  raster: Readonly<PreparedWatercolorRaster>,
): boolean {
  if (
    raster === null ||
    typeof raster !== 'object' ||
    !Number.isSafeInteger(raster.sourceWidth) ||
    raster.sourceWidth < 1 ||
    !Number.isSafeInteger(raster.sourceHeight) ||
    raster.sourceHeight < 1 ||
    !Number.isSafeInteger(raster.width) ||
    raster.width < 1 ||
    raster.width > WATERCOLOR_FORMS_LIMITS.analysisMaxDimension ||
    !Number.isSafeInteger(raster.height) ||
    raster.height < 1 ||
    raster.height > WATERCOLOR_FORMS_LIMITS.analysisMaxDimension
  ) {
    return false
  }
  const sampleCount = raster.width * raster.height
  if (
    !Number.isSafeInteger(sampleCount) ||
    sampleCount > WATERCOLOR_FORMS_LIMITS.maxSampleCount
  ) {
    return false
  }
  const numericFields = [
    raster.linearRed,
    raster.linearGreen,
    raster.linearBlue,
    raster.luminance,
    raster.alpha,
  ]
  if (
    numericFields.some(
      (values) =>
        !Array.isArray(values) ||
        values.length !== sampleCount ||
        values.some(
          (value) =>
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            value < 0 ||
            value > 1,
        ),
    ) ||
    !Array.isArray(raster.positiveSupport) ||
    raster.positiveSupport.length !== sampleCount ||
    raster.positiveSupport.some((value) => typeof value !== 'boolean')
  ) {
    return false
  }
  return true
}

function finiteLatticePoint(
  point: unknown,
  raster: Readonly<PreparedWatercolorRaster>,
): point is Readonly<Point> {
  return (
    Array.isArray(point) &&
    point.length === 2 &&
    typeof point[0] === 'number' &&
    typeof point[1] === 'number' &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    point[0] >= -COORDINATE_EPSILON &&
    point[1] >= -COORDINATE_EPSILON &&
    point[0] <= raster.width + COORDINATE_EPSILON &&
    point[1] <= raster.height + COORDINATE_EPSILON
  )
}

function pointHasPositiveSupport(
  point: Readonly<Point>,
  raster: Readonly<PreparedWatercolorRaster>,
): boolean {
  const adjacent = (coordinate: number): readonly number[] =>
    Number.isInteger(coordinate)
      ? [coordinate - 1, coordinate]
      : [Math.floor(coordinate)]
  for (const row of adjacent(point[1])) {
    if (row < 0 || row >= raster.height) continue
    for (const column of adjacent(point[0])) {
      if (column < 0 || column >= raster.width) continue
      if (raster.positiveSupport[row * raster.width + column] === true) {
        return true
      }
    }
  }
  return false
}

function segmentHasPositiveSupport(
  start: Readonly<Point>,
  end: Readonly<Point>,
  raster: Readonly<PreparedWatercolorRaster>,
): boolean {
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
  addCrossings(start[0], end[0], raster.width)
  addCrossings(start[1], end[1], raster.height)
  crossings.sort((first, second) => first - second)
  const distinct = crossings.filter(
    (amount, index) => index === 0 || amount !== crossings[index - 1],
  )
  for (let index = 0; index < distinct.length; index += 1) {
    const amount = distinct[index]!
    if (
      !pointHasPositiveSupport(
        [
          start[0] + (end[0] - start[0]) * amount,
          start[1] + (end[1] - start[1]) * amount,
        ],
        raster,
      )
    ) {
      return false
    }
    if (index === 0) continue
    const midpoint = (distinct[index - 1]! + amount) / 2
    if (
      !pointHasPositiveSupport(
        [
          start[0] + (end[0] - start[0]) * midpoint,
          start[1] + (end[1] - start[1]) * midpoint,
        ],
        raster,
      )
    ) {
      return false
    }
  }
  return true
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

function validFinalPath(
  path: Readonly<WatercolorBoundaryPath>,
  raster: Readonly<PreparedWatercolorRaster>,
): boolean {
  if (
    path === null ||
    typeof path !== 'object' ||
    !Array.isArray(path.points) ||
    typeof path.closed !== 'boolean' ||
    !Array.isArray(path.boundarySegmentIds)
  ) {
    return false
  }
  const explicitlyClosed =
    path.closed &&
    path.points.length > 1 &&
    finiteLatticePoint(path.points[0], raster) &&
    finiteLatticePoint(path.points.at(-1), raster) &&
    samePoint(path.points[0], path.points.at(-1)!)
  const pointCount = path.points.length - (explicitlyClosed ? 1 : 0)
  if (pointCount < (path.closed ? 3 : 2)) return false
  const points = path.points.slice(0, pointCount)
  if (
    points.some(
      (point) =>
        !finiteLatticePoint(point, raster) ||
        !pointHasPositiveSupport(point, raster),
    )
  ) {
    return false
  }
  const segmentCount = path.closed ? points.length : points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index]!
    const end = points[(index + 1) % points.length]!
    if (
      samePoint(start, end) ||
      !segmentHasPositiveSupport(start, end, raster)
    ) {
      return false
    }
  }
  return true
}

function mappedPrimitive(
  path: Readonly<WatercolorBoundaryPath>,
  raster: Readonly<PreparedWatercolorRaster>,
  fit: NonNullable<ReturnType<typeof createRasterContainFit>>,
  frame: Readonly<CoordinateSpace>,
): Primitive | undefined {
  const points = path.points.map(
    (point): Point => [
      fit.left + (point[0] / raster.width) * fit.fittedWidth,
      fit.top + (point[1] / raster.height) * fit.fittedHeight,
    ],
  )
  if (
    points.some(
      ([x, y]) =>
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < -COORDINATE_EPSILON ||
        y < -COORDINATE_EPSILON ||
        x > frame.width + COORDINATE_EPSILON ||
        y > frame.height + COORDINATE_EPSILON ||
        x < fit.left - COORDINATE_EPSILON ||
        y < fit.top - COORDINATE_EPSILON ||
        x > fit.right + COORDINATE_EPSILON ||
        y > fit.bottom + COORDINATE_EPSILON,
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

function samePathIdentity(
  source: Readonly<WatercolorBoundaryPath>,
  fitted: Readonly<WatercolorBoundaryPath>,
): boolean {
  return (
    source.closed === fitted.closed &&
    source.boundarySegmentIds.length === fitted.boundarySegmentIds.length &&
    source.boundarySegmentIds.every(
      (segmentId, index) =>
        segmentId === fitted.boundarySegmentIds[index],
    )
  )
}

/**
 * Deterministically compose decoded pixels into ordinary stroke-only geometry.
 *
 * Malformed inputs or stage output fail closed. Safety-limited hierarchy or
 * geometry stages keep their completed deterministic prefix and report the cap.
 */
export function generateWatercolorForms(
  input: Readonly<WatercolorFormsGeneratorInput>,
): WatercolorFormsGeneratorResult {
  const frame = frameFrom(input)
  const diagnostics = initialDiagnostics()
  const controls = normalizeWatercolorFormsControls(controlsFrom(input))
  const raster = prepareWatercolorFormsRaster(
    pixelsFrom(input),
    frame,
    controls,
  )
  if (!validPreparedRaster(raster)) return invalidResult(frame, diagnostics)

  diagnostics.analysisWidth = raster.width
  diagnostics.analysisHeight = raster.height
  diagnostics.sampleCount = raster.width * raster.height
  diagnostics.gridAdjacencyCount =
    raster.width * Math.max(0, raster.height - 1) +
    raster.height * Math.max(0, raster.width - 1)

  const fit = createRasterContainFit(
    { width: raster.sourceWidth, height: raster.sourceHeight },
    frame,
  )
  if (fit === null) return invalidResult(frame, diagnostics)

  const partition = partitionWatercolorFormsRaster(raster)
  diagnostics.initialRegionCount = partition.regions.length
  if (
    partition.raster !== raster ||
    !Array.isArray(partition.regionBySample) ||
    partition.regionBySample.length !== diagnostics.sampleCount ||
    !Array.isArray(partition.regions) ||
    partition.regions.length > WATERCOLOR_FORMS_LIMITS.maxInitialRegionCount ||
    !Array.isArray(partition.sharedBoundarySegments) ||
    partition.sharedBoundarySegments.length >
      WATERCOLOR_FORMS_LIMITS.maxGridAdjacencyCount
  ) {
    return invalidResult(frame, diagnostics)
  }

  const hierarchyResult = buildWatercolorFormsHierarchyWithDiagnostics(
    partition,
    controls.colorSensitivity,
  )
  const hierarchy = hierarchyResult.hierarchy
  diagnostics.mergeCount = hierarchy.merges.length
  diagnostics.mergeQueueEntryCount =
    hierarchyResult.diagnostics.mergeQueueEntryCount
  diagnostics.regionUpdateCount =
    hierarchyResult.diagnostics.regionUpdateCount
  if (
    hierarchy.partition !== partition ||
    !Array.isArray(hierarchy.regions) ||
    !Array.isArray(hierarchy.merges) ||
    typeof hierarchy.complete !== 'boolean' ||
    hierarchyResult.diagnostics.mergeQueueEntryCount < 0 ||
    hierarchyResult.diagnostics.regionUpdateCount < 0 ||
    (hierarchy.complete &&
      hierarchyResult.diagnostics.limitedBy !== null) ||
    (!hierarchy.complete &&
      hierarchyResult.diagnostics.limitedBy === null)
  ) {
    return invalidResult(frame, diagnostics)
  }
  if (!hierarchy.complete) {
    diagnostics.termination = 'limit-reached'
    diagnostics.limitedBy = hierarchyResult.diagnostics.limitedBy
  }

  const selection = selectWatercolorForms(hierarchy, controls.formDetail)
  diagnostics.selectedRegionCount = selection.regionIds.length
  if (
    selection.hierarchy !== hierarchy ||
    !Array.isArray(selection.regionIds) ||
    !Array.isArray(selection.regionBySample) ||
    selection.regionBySample.length !== diagnostics.sampleCount
  ) {
    return invalidResult(frame, diagnostics)
  }

  const selected = extractWatercolorSharedBoundaries(
    selection,
    controls.boundaryStrength,
  )
  diagnostics.retainedBoundarySegmentCount =
    selected.sharedBoundarySegments.length
  if (
    selected.hierarchy !== hierarchy ||
    !Array.isArray(selected.sharedBoundarySegments) ||
    selected.sharedBoundarySegments.length >
      WATERCOLOR_FORMS_LIMITS.maxRetainedBoundarySegmentCount
  ) {
    return invalidResult(frame, diagnostics)
  }

  const traced = traceWatercolorBoundaryNetwork(
    selected.sharedBoundarySegments,
  )
  diagnostics.boundaryPathCount = traced.paths.length
  if (
    traced.diagnostics.termination === 'invalid-input' ||
    traced.diagnostics.invalidSegmentCount !== 0 ||
    traced.diagnostics.duplicateSegmentCount !== 0
  ) {
    return invalidResult(frame, diagnostics)
  }
  if (
    diagnostics.termination === 'complete' &&
    traced.diagnostics.termination === 'limit-reached'
  ) {
    diagnostics.termination = 'limit-reached'
    diagnostics.limitedBy = traced.diagnostics.limitedBy
  }

  const curves = fitWatercolorBoundaryCurves(
    traced.paths,
    controls.boundarySmoothing,
    {
      latticeWidth: raster.width,
      latticeHeight: raster.height,
      positiveSupport: raster.positiveSupport,
    },
  )
  if (
    curves.some(
      (curve, index) =>
        !samePathIdentity(traced.paths[index]!, curve) ||
        !validFinalPath(curve, raster),
    )
  ) {
    return invalidResult(frame, diagnostics)
  }
  if (curves.length < traced.paths.length) {
    const reservedSourcePointCount = traced.paths
      .slice(0, curves.length)
      .reduce((total, path) => total + path.points.length, 0)
    const next = traced.paths[curves.length]
    if (
      next === undefined ||
      reservedSourcePointCount + next.points.length <=
        WATERCOLOR_FORMS_LIMITS.maxCurvePointCount
    ) {
      return invalidResult(frame, diagnostics)
    }
    if (diagnostics.termination === 'complete') {
      diagnostics.termination = 'limit-reached'
      diagnostics.limitedBy = 'maxCurvePointCount'
    }
  }
  diagnostics.curvePointCount = curves.reduce(
    (total, path) => total + path.points.length,
    0,
  )

  const retainedCurves = curves.slice(
    0,
    WATERCOLOR_FORMS_LIMITS.maxPrimitiveCount,
  )
  if (
    retainedCurves.length < curves.length &&
    diagnostics.termination === 'complete'
  ) {
    diagnostics.termination = 'limit-reached'
    diagnostics.limitedBy = 'maxPrimitiveCount'
  }
  const primitives = retainedCurves.map((path) =>
    mappedPrimitive(path, raster, fit, frame),
  )
  if (
    !primitives.every(
      (primitive): primitive is Primitive => primitive !== undefined,
    )
  ) {
    return invalidResult(frame, diagnostics)
  }
  diagnostics.primitiveCount = primitives.length
  return result(frame, diagnostics, primitives)
}
