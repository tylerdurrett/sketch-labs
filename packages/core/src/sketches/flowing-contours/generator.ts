/**
 * Pure headless composition for Flowing Contours.
 *
 * Analysis and whole-curve search stay in their bounded source lattice until
 * this final boundary. Curves are then mapped through the generic raster
 * contain fit built from the original decoded dimensions. No Page Frame,
 * renderer, physical-output, or fragment-joining policy enters generation.
 */

import type { DecodedPixels } from '../../imageAssets'
import { createRasterContainFit } from '../../rasterSampling'
import type { CoordinateSpace, Primitive, Scene } from '../../scene'
import type { Point } from '../../types'
import {
  createFlowingContoursAccounting,
  snapshotFlowingContoursDiagnostics,
  type FlowingContoursAccounting,
} from './accounting'
import {
  defaultFlowingContoursControls,
  normalizeFlowingContoursControls,
  type FlowingContoursControlInput,
  type FlowingContoursControlName,
  type FlowingContoursControls,
} from './controls'
import { buildFlowingContoursFieldEnsemble } from './field'
import {
  FLOWING_CONTOURS_LIMITS,
  createFlowingContoursTestLimits,
  type FlowingContoursLimits,
} from './limits'
import {
  flowingContoursAcceptedTrajectorySourceField,
  runFlowingContoursFieldEnsemblePipeline,
} from './pipeline'
import {
  applyFlowingContoursToneControls,
  prepareFlowingContoursRaster,
} from './raster'
import {
  createFlowingContoursEvidenceTube,
  validateFlowingContoursTubeCurve,
} from './tube'
import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
  type AcceptedFlowingTrajectory,
  type FittedFlowingCurve,
  type FlowingContoursDiagnostics,
  type FlowingContoursEndpointReasonCounts,
  type FlowingContoursField,
  type FlowingContoursGeneratorResult,
  type FlowingContoursPipelineResult,
} from './types'

const STROKE = Object.freeze({ color: 'black', width: 1 })
const MAPPING_TOLERANCE = 1e-9
const LENGTH_TOLERANCE = 1e-9

/** Untrusted, synchronous inputs to the reusable headless generator. */
export interface FlowingContoursGeneratorInput {
  readonly pixels: Readonly<DecodedPixels>
  readonly frame: Readonly<CoordinateSpace>
  readonly controls:
    | FlowingContoursControlInput
    | Readonly<FlowingContoursControls>
    | null
  /**
   * Optional lower-only safety policy used by bounded-work tests and headless
   * hosts. Omitted keys retain their production ceilings.
   */
  readonly limits?: Readonly<Partial<FlowingContoursLimits>>
}

interface MappedCurve {
  readonly trajectory: Readonly<AcceptedFlowingTrajectory>
  readonly fittedCurve: Readonly<FittedFlowingCurve>
  readonly primitive: Readonly<Primitive>
}

function ownDataValue(source: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined
}

function snapshotFrame(input: unknown): Readonly<CoordinateSpace> | null {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return null
    }
    const width = ownDataValue(input, 'width')
    const height = ownDataValue(input, 'height')
    if (
      typeof width !== 'number' ||
      !Number.isFinite(width) ||
      width <= 0 ||
      typeof height !== 'number' ||
      !Number.isFinite(height) ||
      height <= 0
    ) {
      return null
    }
    return Object.freeze({ width, height })
  } catch {
    return null
  }
}

function snapshotControls(
  input: unknown,
): Readonly<FlowingContoursControls> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return defaultFlowingContoursControls
  }
  try {
    const names: readonly FlowingContoursControlName[] = Object.freeze([
      'gamma',
      'contrast',
      'pivot',
      'curveDetail',
      'continuity',
      'flowSmoothing',
      'minimumStrokeLength',
    ])
    const values: Partial<Record<FlowingContoursControlName, unknown>> = {}
    for (const name of names) values[name] = ownDataValue(input, name)
    return normalizeFlowingContoursControls(values)
  } catch {
    // A hostile control record follows the same per-control default policy as
    // any other malformed authored value.
    return defaultFlowingContoursControls
  }
}

function snapshotLimits(
  input: unknown,
): Readonly<FlowingContoursLimits> | null {
  if (input === undefined) return FLOWING_CONTOURS_LIMITS
  return createFlowingContoursTestLimits(input)
}

function emptyEndpointCounts(): FlowingContoursEndpointReasonCounts {
  return Object.freeze(
    Object.fromEntries(
      FLOWING_CONTOURS_ENDPOINT_REASONS.map((reason) => [reason, 0]),
    ),
  ) as FlowingContoursEndpointReasonCounts
}

function freezeScene(
  frame: Readonly<CoordinateSpace>,
  primitives: readonly Readonly<Primitive>[] = [],
): Scene {
  const space = Object.freeze({ width: frame.width, height: frame.height })
  const frozenPrimitives = Object.freeze([...primitives])
  return Object.freeze({
    space,
    primitives: frozenPrimitives,
  }) as unknown as Scene
}

function freezeResult(
  frame: Readonly<CoordinateSpace>,
  diagnostics: Readonly<FlowingContoursDiagnostics>,
  primitives: readonly Readonly<Primitive>[] = [],
): Readonly<FlowingContoursGeneratorResult> {
  return Object.freeze({
    scene: freezeScene(frame, primitives),
    diagnostics,
  })
}

function invalidDiagnostics(
  base: Readonly<FlowingContoursDiagnostics> | null = null,
): Readonly<FlowingContoursDiagnostics> {
  const accounting = createFlowingContoursAccounting()
  if (base !== null) {
    Object.assign(accounting, base)
    accounting.endpointReasonCounts = Object.fromEntries(
      FLOWING_CONTOURS_ENDPOINT_REASONS.map((reason) => [
        reason,
        base.endpointReasonCounts[reason],
      ]),
    ) as FlowingContoursAccounting['endpointReasonCounts']
  }
  accounting.termination = 'invalid-input'
  accounting.limitedBy = null
  accounting.acceptedCandidateCount = 0
  accounting.rejectedCandidateCount = accounting.candidateCount
  accounting.rawTrajectoryCount = 0
  accounting.rawTrajectoryPointCount = 0
  accounting.acceptedMaximumUnsupportedSpanLength = 0
  accounting.acceptedTotalUnsupportedSpanLength = 0
  accounting.fittedCurveCount = 0
  accounting.fittedCurvePointCount = 0
  accounting.primitiveCount = 0
  accounting.endpointReasonCounts = Object.fromEntries(
    FLOWING_CONTOURS_ENDPOINT_REASONS.map((reason) => [reason, 0]),
  ) as FlowingContoursAccounting['endpointReasonCounts']
  return snapshotFlowingContoursDiagnostics(accounting)
}

function inputParts(input: unknown): Readonly<{
  pixels: unknown
  frame: unknown
  controls: unknown
  limits: unknown
}> | null {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return null
    }
    return Object.freeze({
      pixels: ownDataValue(input, 'pixels'),
      frame: ownDataValue(input, 'frame'),
      controls: ownDataValue(input, 'controls'),
      limits: ownDataValue(input, 'limits'),
    })
  } catch {
    return null
  }
}

function pointEqual(
  first: Readonly<Point>,
  second: Readonly<Point>,
): boolean {
  return Object.is(first[0], second[0]) && Object.is(first[1], second[1])
}

function pathEndpointsAreClosed(
  points: readonly Readonly<Point>[],
): boolean {
  return (
    points.length >= 4 &&
    pointEqual(points[0]!, points[points.length - 1]!)
  )
}

/** Narrow test seam for the raw-loop to closed-Primitive decision. */
export function flowingContoursPathIsClosedForTest(
  points: readonly Readonly<Point>[],
): boolean {
  return pathEndpointsAreClosed(points)
}

function trajectoryIsClosed(
  trajectory: Readonly<AcceptedFlowingTrajectory>,
): boolean {
  return (
    trajectory.samples.length >= 4 &&
    pointEqual(
      trajectory.samples[0]!.point,
      trajectory.samples[trajectory.samples.length - 1]!.point,
    )
  )
}

function mappedPathLength(
  points: readonly Readonly<Point>[],
  closed: boolean,
): number | null {
  if (points.length < (closed ? 4 : 2)) return null
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(
      points[index]![0] - points[index - 1]![0],
      points[index]![1] - points[index - 1]![1],
    )
  }
  if (closed && !pointEqual(points[0]!, points[points.length - 1]!)) {
    length += Math.hypot(
      points[0]![0] - points[points.length - 1]![0],
      points[0]![1] - points[points.length - 1]![1],
    )
  }
  return Number.isFinite(length) ? length : null
}

function mappedCurve(
  field: Readonly<FlowingContoursField>,
  trajectory: Readonly<AcceptedFlowingTrajectory>,
  curve: Readonly<FittedFlowingCurve>,
  fit: NonNullable<ReturnType<typeof createRasterContainFit>>,
  frame: Readonly<CoordinateSpace>,
  minimumStrokeLength: number,
): Readonly<MappedCurve> | null {
  if (
    curve.provenance.sourceTrajectoryId !== trajectory.id ||
    curve.points.length !== curve.provenance.sourceSampleIndices.length
  ) {
    return null
  }

  // Re-run the exact evidence-tube proof at the final generator boundary.
  // The contain transform is affine, so this also proves mapped segment
  // support while extent checks below guard the resulting coordinates.
  const tube = createFlowingContoursEvidenceTube(field, trajectory)
  if (
    tube === null ||
    validateFlowingContoursTubeCurve(field, tube, {
      points: curve.points,
      sourceSampleIndices: curve.provenance.sourceSampleIndices,
    }) === null
  ) {
    return null
  }

  const points: Readonly<Point>[] = []
  for (const point of curve.points) {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      point[0] < 0 ||
      point[0] > field.width - 1 ||
      point[1] < 0 ||
      point[1] > field.height - 1
    ) {
      return null
    }
    const mapped = Object.freeze([
      fit.left + ((point[0] + 0.5) / field.width) * fit.fittedWidth,
      fit.top + ((point[1] + 0.5) / field.height) * fit.fittedHeight,
    ] as Point)
    if (
      !Number.isFinite(mapped[0]) ||
      !Number.isFinite(mapped[1]) ||
      mapped[0] < fit.left - MAPPING_TOLERANCE ||
      mapped[0] > fit.right + MAPPING_TOLERANCE ||
      mapped[1] < fit.top - MAPPING_TOLERANCE ||
      mapped[1] > fit.bottom + MAPPING_TOLERANCE ||
      mapped[0] < -MAPPING_TOLERANCE ||
      mapped[0] > frame.width + MAPPING_TOLERANCE ||
      mapped[1] < -MAPPING_TOLERANCE ||
      mapped[1] > frame.height + MAPPING_TOLERANCE
    ) {
      return null
    }
    points.push(mapped)
  }

  const closed = trajectoryIsClosed(trajectory)
  const frozenPoints = Object.freeze(points)
  const length = mappedPathLength(frozenPoints, closed)
  const minimumLength =
    minimumStrokeLength * Math.hypot(fit.fittedWidth, fit.fittedHeight)
  if (
    length === null ||
    !Number.isFinite(minimumLength) ||
    length + LENGTH_TOLERANCE < minimumLength
  ) {
    return null
  }

  const primitive = Object.freeze({
    points: frozenPoints,
    closed,
    stroke: Object.freeze({ ...STROKE }),
    hiddenLineRole: 'source' as const,
  }) as unknown as Readonly<Primitive>
  return Object.freeze({ trajectory, fittedCurve: curve, primitive })
}

function reconciledDiagnostics(
  source: Readonly<FlowingContoursDiagnostics>,
  mapped: readonly Readonly<MappedCurve>[],
): Readonly<FlowingContoursDiagnostics> | null {
  let rawPointCount = 0
  let fittedPointCount = 0
  let maximumUnsupported = 0
  let totalUnsupported = 0
  const endpointReasonCounts = {
    ...emptyEndpointCounts(),
  } as Record<keyof FlowingContoursEndpointReasonCounts, number>

  for (const item of mapped) {
    rawPointCount += item.trajectory.samples.length
    fittedPointCount += item.fittedCurve.points.length
    maximumUnsupported = Math.max(
      maximumUnsupported,
      item.trajectory.maximumUnsupportedSpanLength,
    )
    totalUnsupported += item.trajectory.totalUnsupportedSpanLength
    endpointReasonCounts[item.trajectory.startEndpointReason] += 1
    endpointReasonCounts[item.trajectory.endEndpointReason] += 1
  }
  const rejectedCandidateCount = source.candidateCount - mapped.length
  if (
    !Number.isSafeInteger(rawPointCount) ||
    !Number.isSafeInteger(fittedPointCount) ||
    !Number.isSafeInteger(rejectedCandidateCount) ||
    rejectedCandidateCount < 0 ||
    !Number.isFinite(maximumUnsupported) ||
    !Number.isFinite(totalUnsupported)
  ) {
    return null
  }

  return Object.freeze({
    ...source,
    acceptedCandidateCount: mapped.length,
    rejectedCandidateCount,
    endpointReasonCounts: Object.freeze(endpointReasonCounts),
    rawTrajectoryCount: mapped.length,
    rawTrajectoryPointCount: rawPointCount,
    acceptedMaximumUnsupportedSpanLength: maximumUnsupported,
    acceptedTotalUnsupportedSpanLength: totalUnsupported,
    fittedCurveCount: mapped.length,
    fittedCurvePointCount: fittedPointCount,
    primitiveCount: mapped.length,
  })
}

/**
 * Build contain-fitted, renderer-neutral whole curves from decoded RGBA8.
 *
 * A final rejection removes the matched raw trajectory, fitted curve, and
 * Primitive from public accounting as one transaction. This keeps generation
 * diagnostics truthful even when contain mapping makes an otherwise valid
 * analysis-space curve shorter than the authored minimum.
 */
export function generateFlowingContours(
  input: Readonly<FlowingContoursGeneratorInput>,
): Readonly<FlowingContoursGeneratorResult> {
  const zeroFrame: Readonly<CoordinateSpace> = Object.freeze({
    width: 0,
    height: 0,
  })
  let resultFrame: Readonly<CoordinateSpace> = zeroFrame
  try {
    const parts = inputParts(input)
    if (parts === null) {
      return freezeResult(zeroFrame, invalidDiagnostics())
    }
    const frame = snapshotFrame(parts.frame)
    if (frame === null) {
      return freezeResult(zeroFrame, invalidDiagnostics())
    }
    resultFrame = frame
    const controls = snapshotControls(parts.controls)
    const limits = snapshotLimits(parts.limits)
    if (limits === null) {
      return freezeResult(frame, invalidDiagnostics())
    }

    const accounting = createFlowingContoursAccounting()
    const raster = prepareFlowingContoursRaster(
      parts.pixels as Readonly<DecodedPixels>,
      accounting,
      limits,
    )
    if (accounting.termination !== 'complete') {
      return freezeResult(
        frame,
        snapshotFlowingContoursDiagnostics(accounting),
      )
    }
    const analysisRaster = applyFlowingContoursToneControls(raster, controls)
    const ensemble = buildFlowingContoursFieldEnsemble(
      analysisRaster,
      accounting,
      limits,
    )
    if (accounting.termination !== 'complete') {
      return freezeResult(
        frame,
        snapshotFlowingContoursDiagnostics(accounting),
      )
    }
    const fit = createRasterContainFit(
      { width: raster.sourceWidth, height: raster.sourceHeight },
      frame,
    )
    if (fit === null) {
      return freezeResult(
        frame,
        invalidDiagnostics(snapshotFlowingContoursDiagnostics(accounting)),
      )
    }

    const pipeline: Readonly<FlowingContoursPipelineResult> =
      runFlowingContoursFieldEnsemblePipeline(ensemble, controls, limits)
    if (pipeline.diagnostics.termination === 'invalid-input') {
      return freezeResult(frame, pipeline.diagnostics)
    }
    if (
      pipeline.acceptedTrajectories.length !== pipeline.fittedCurves.length
    ) {
      return freezeResult(
        frame,
        invalidDiagnostics(pipeline.diagnostics),
      )
    }

    const mapped: Readonly<MappedCurve>[] = []
    for (let index = 0; index < pipeline.fittedCurves.length; index += 1) {
      const field = flowingContoursAcceptedTrajectorySourceField(
        pipeline.acceptedTrajectories[index]!,
      )
      if (field === null) {
        return freezeResult(
          frame,
          invalidDiagnostics(pipeline.diagnostics),
        )
      }
      const item = mappedCurve(
        field,
        pipeline.acceptedTrajectories[index]!,
        pipeline.fittedCurves[index]!,
        fit,
        frame,
        controls.minimumStrokeLength,
      )
      // Mapping rejection is an ordinary whole-curve rejection. It never
      // emits a shortened fragment and never leaves accepted diagnostics.
      if (item !== null) mapped.push(item)
    }
    if (mapped.length > limits['primitive-count']) {
      return freezeResult(
        frame,
        invalidDiagnostics(pipeline.diagnostics),
      )
    }
    const diagnostics = reconciledDiagnostics(
      pipeline.diagnostics,
      mapped,
    )
    if (diagnostics === null) {
      return freezeResult(
        frame,
        invalidDiagnostics(pipeline.diagnostics),
      )
    }
    return freezeResult(
      frame,
      diagnostics,
      mapped.map((item) => item.primitive),
    )
  } catch {
    return freezeResult(resultFrame, invalidDiagnostics())
  }
}
