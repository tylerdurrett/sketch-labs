import {
  createRasterContainFit,
  type RasterContainFit,
} from '../../rasterSampling'
import type { CoordinateSpace } from '../../scene'
import type { Point } from '../../types'
import { extractWatercolorSharedBoundaries } from '../../sketches/watercolor-forms/boundaries'
import {
  normalizeWatercolorFormsControls,
  type WatercolorFormsControls,
} from '../../sketches/watercolor-forms/controls'
import { fitWatercolorBoundaryCurves } from '../../sketches/watercolor-forms/curves'
import { selectWatercolorForms } from '../../sketches/watercolor-forms/forms'
import { buildWatercolorFormsHierarchy } from '../../sketches/watercolor-forms/hierarchy'
import { WATERCOLOR_FORMS_LIMITS } from '../../sketches/watercolor-forms/limits'
import { partitionWatercolorFormsRaster } from '../../sketches/watercolor-forms/partition'
import { traceWatercolorBoundaryNetwork } from '../../sketches/watercolor-forms/tracing'
import type { PreparedWatercolorRaster } from '../../sketches/watercolor-forms/types'
import { cleanupPencilContourPaths } from '../../sketches/pencil-contour/cleanup'
import {
  normalizePencilContourControls,
  type PencilContourControls,
} from '../../sketches/pencil-contour/controls'
import { localizePencilContourEdges } from '../../sketches/pencil-contour/edges'
import { prunePencilContourGraph } from '../../sketches/pencil-contour/fragment-pruning'
import { tracePencilContourEdges } from '../../sketches/pencil-contour/tracing'
import type { AnalyzedRaster } from '../../sketches/pencil-contour/types'

/**
 * Reference-image comparison vocabulary.
 *
 * A path is short when its plotted length is at most one percent of the
 * contain-fitted image diagonal. A path is long when it is at least five
 * percent of that same diagonal. Paths between the thresholds belong to
 * neither category.
 */
export const REFERENCE_SHORT_PATH_MAXIMUM_NORMALIZED_LENGTH = 0.01
export const REFERENCE_LONG_PATH_MINIMUM_NORMALIZED_LENGTH = 0.05
export const REFERENCE_LENGTH_NORMALIZATION =
  'fitted-image-diagonal' as const

export interface ReferencePath {
  readonly points: readonly Readonly<Point>[]
  readonly closed: boolean
}

export interface ReferenceMetricDefinitions {
  readonly lengthNormalization: typeof REFERENCE_LENGTH_NORMALIZATION
  readonly fittedImageDiagonal: number
  readonly shortPathMaximumNormalizedLength: typeof REFERENCE_SHORT_PATH_MAXIMUM_NORMALIZED_LENGTH
  readonly longPathMinimumNormalizedLength: typeof REFERENCE_LONG_PATH_MINIMUM_NORMALIZED_LENGTH
}

/** The shared metric report used for Watercolor/Pencil visual review. */
export interface ReferenceMetrics {
  readonly definitions: Readonly<ReferenceMetricDefinitions>
  readonly pathCount: number
  readonly shortPathShare: number
  readonly medianNormalizedPathLength: number
  readonly longPathShareOfTotalGeometry: number
  readonly closedFormCount: number
  /** Sum of every open segment and every closed path's closing segment. */
  readonly totalPlottedLength: number
}

export interface WatercolorFormsReferenceInput {
  readonly raster: Readonly<PreparedWatercolorRaster>
  readonly controls: Readonly<WatercolorFormsControls>
  readonly frame: Readonly<CoordinateSpace>
}

export interface PencilContourReferenceInput {
  readonly raster: Readonly<AnalyzedRaster>
  readonly controls: Readonly<PencilContourControls>
  readonly frame: Readonly<CoordinateSpace>
}

function fittedImage(
  raster: Readonly<{ sourceWidth: number; sourceHeight: number }>,
  frame: Readonly<CoordinateSpace>,
): Readonly<RasterContainFit> {
  const fit = createRasterContainFit(
    { width: raster.sourceWidth, height: raster.sourceHeight },
    frame,
  )
  if (fit === null) {
    throw new Error(
      'Reference raster and frame must produce a finite contain fit',
    )
  }
  return fit
}

function pathLength(path: Readonly<ReferencePath>): number {
  const segmentCount = path.closed
    ? path.points.length
    : Math.max(0, path.points.length - 1)
  let length = 0
  for (let index = 0; index < segmentCount; index += 1) {
    const first = path.points[index]!
    const second = path.points[(index + 1) % path.points.length]!
    length += Math.hypot(second[0] - first[0], second[1] - first[1])
  }
  return length
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

/**
 * Measure already contain-fitted paths with the exact reference definitions.
 *
 * Kept independent of either extraction algorithm so threshold inclusivity,
 * closing segments, normalization, and aggregate identities can be tested with
 * hand-authored geometry.
 */
export function measureReferenceGeometry(
  paths: readonly Readonly<ReferencePath>[],
  fittedImageDiagonal: number,
): Readonly<ReferenceMetrics> {
  if (!Number.isFinite(fittedImageDiagonal) || fittedImageDiagonal <= 0) {
    throw new Error(
      'Reference fitted-image diagonal must be finite and positive',
    )
  }
  const lengths = paths.map(pathLength)
  if (lengths.some((length) => !Number.isFinite(length) || length < 0)) {
    throw new Error('Reference geometry must contain only finite points')
  }
  const normalizedLengths = lengths.map(
    (length) => length / fittedImageDiagonal,
  )
  const totalPlottedLength = lengths.reduce(
    (total, length) => total + length,
    0,
  )
  const longPlottedLength = lengths.reduce(
    (total, length, index) =>
      normalizedLengths[index]! >=
      REFERENCE_LONG_PATH_MINIMUM_NORMALIZED_LENGTH
        ? total + length
        : total,
    0,
  )

  return Object.freeze({
    definitions: Object.freeze({
      lengthNormalization: REFERENCE_LENGTH_NORMALIZATION,
      fittedImageDiagonal,
      shortPathMaximumNormalizedLength:
        REFERENCE_SHORT_PATH_MAXIMUM_NORMALIZED_LENGTH,
      longPathMinimumNormalizedLength:
        REFERENCE_LONG_PATH_MINIMUM_NORMALIZED_LENGTH,
    }),
    pathCount: paths.length,
    shortPathShare:
      paths.length === 0
        ? 0
        : normalizedLengths.filter(
            (length) =>
              length <= REFERENCE_SHORT_PATH_MAXIMUM_NORMALIZED_LENGTH,
          ).length / paths.length,
    medianNormalizedPathLength: median(normalizedLengths),
    longPathShareOfTotalGeometry:
      totalPlottedLength === 0 ? 0 : longPlottedLength / totalPlottedLength,
    closedFormCount: paths.filter(({ closed }) => closed).length,
    totalPlottedLength,
  })
}

function watercolorFormsGeometry(
  input: Readonly<WatercolorFormsReferenceInput>,
  fit: Readonly<RasterContainFit>,
): readonly Readonly<ReferencePath>[] {
  const { raster } = input
  const controls = normalizeWatercolorFormsControls(input.controls)
  const partition = partitionWatercolorFormsRaster(raster)
  const hierarchy = buildWatercolorFormsHierarchy(
    partition,
    controls.colorSensitivity,
  )
  const forms = selectWatercolorForms(hierarchy, controls.formDetail)
  const boundaries = extractWatercolorSharedBoundaries(
    forms,
    controls.boundaryStrength,
  )
  const traced = traceWatercolorBoundaryNetwork(
    boundaries.sharedBoundarySegments,
  )
  const curves = fitWatercolorBoundaryCurves(
    traced.paths,
    controls.boundarySmoothing,
    {
      latticeWidth: raster.width,
      latticeHeight: raster.height,
      positiveSupport: raster.positiveSupport,
    },
  ).slice(0, WATERCOLOR_FORMS_LIMITS.maxPrimitiveCount)

  return curves.map((path) => ({
    closed: path.closed,
    points: path.points.map(
      ([x, y]): Point => [
        fit.left + (x / raster.width) * fit.fittedWidth,
        fit.top + (y / raster.height) * fit.fittedHeight,
      ],
    ),
  }))
}

function pencilContourGeometry(
  input: Readonly<PencilContourReferenceInput>,
  fit: Readonly<RasterContainFit>,
): readonly Readonly<ReferencePath>[] {
  const { raster } = input
  const controls = normalizePencilContourControls(input.controls)
  const localized = localizePencilContourEdges(
    raster,
    controls.contourDetail,
  )
  const graph = prunePencilContourGraph(
    localized,
    controls.contourDetail,
    controls.contourSmoothing,
  )
  const paths = cleanupPencilContourPaths({
    paths: tracePencilContourEdges(graph),
    graph,
    detail: controls.contourDetail,
    smoothing: controls.contourSmoothing,
    fragmentsPrunedBeforeTracing: true,
  })

  return paths.map((path) => ({
    closed: path.closed,
    points: path.points.map(
      ([x, y]): Point => [
        fit.left + ((x + 0.5) / graph.width) * fit.fittedWidth,
        fit.top + ((y + 0.5) / graph.height) * fit.fittedHeight,
      ],
    ),
  }))
}

/** Recompute the current Watercolor downstream pipeline from a prepared raster. */
export function watercolorFormsReferenceMetrics(
  input: Readonly<WatercolorFormsReferenceInput>,
): Readonly<ReferenceMetrics> {
  const fit = fittedImage(input.raster, input.frame)
  return measureReferenceGeometry(
    watercolorFormsGeometry(input, fit),
    Math.hypot(fit.fittedWidth, fit.fittedHeight),
  )
}

/** Recompute the current Pencil downstream pipeline from an analyzed raster. */
export function pencilContourReferenceMetrics(
  input: Readonly<PencilContourReferenceInput>,
): Readonly<ReferenceMetrics> {
  const fit = fittedImage(input.raster, input.frame)
  return measureReferenceGeometry(
    pencilContourGeometry(input, fit),
    Math.hypot(fit.fittedWidth, fit.fittedHeight),
  )
}
