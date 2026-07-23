import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import { createRasterContainFit } from '../rasterSampling'
import { createFlowingContoursAccounting } from '../sketches/flowing-contours/accounting'
import type { FlowingContoursControls } from '../sketches/flowing-contours/controls'
import { sampleFlowingContoursField } from '../sketches/flowing-contours/field'
import { generateFlowingContours } from '../sketches/flowing-contours/generator'
import { runFlowingContoursPipeline } from '../sketches/flowing-contours/pipeline'
import { searchFlowingContoursCandidate } from '../sketches/flowing-contours/search'
import { selectFlowingContoursCandidate } from '../sketches/flowing-contours/selection'
import {
  commitAcceptedFlowingTrajectorySuppression,
  createFlowingContoursSuppressionQuery,
  createFlowingContoursSuppressionState,
  isFlowingContoursAnchorSuppressed,
  registerAcceptedFlowingTrajectorySuppression,
} from '../sketches/flowing-contours/suppression'
import {
  createFlowingContoursEvidenceTube,
  validateFlowingContoursTubeCurve,
  type FlowingContoursTubeCurveValidation,
} from '../sketches/flowing-contours/tube'
import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
  type AcceptedFlowingTrajectory,
  type FittedFlowingCurve,
  type FlowingContoursAnchor,
  type FlowingContoursField,
  type FlowingContoursPipelineResult,
} from '../sketches/flowing-contours/types'
import type { Point } from '../types'

const FRAME = Object.freeze({ width: 960, height: 720 })
const PIPELINE_CONTROLS: Readonly<FlowingContoursControls> = Object.freeze({
  curveDetail: 1,
  continuity: 1,
  flowSmoothing: 0.8,
  minimumStrokeLength: 0.05,
})
const GENERATOR_CONTROLS: Readonly<FlowingContoursControls> = Object.freeze({
  curveDetail: 0.6,
  continuity: 0.7,
  flowSmoothing: 0.8,
  minimumStrokeLength: 0.04,
})

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function raster(
  width: number,
  height: number,
  at: (
    x: number,
    y: number,
  ) => readonly [number, number, number, number],
): DecodedPixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(at(x, y), (y * width + x) * 4)
    }
  }
  return { width, height, data }
}

function pathLength(points: readonly Readonly<Point>[]): number {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(
      points[index]![0] - points[index - 1]![0],
      points[index]![1] - points[index - 1]![1],
    )
  }
  return total
}

function segmentLength(
  trajectory: Readonly<AcceptedFlowingTrajectory>,
  start: number,
  end: number,
): number {
  let total = 0
  for (let index = start + 1; index <= end; index += 1) {
    const first = trajectory.samples[index - 1]!.point
    const second = trajectory.samples[index]!.point
    total += Math.hypot(second[0] - first[0], second[1] - first[1])
  }
  return total
}

function maximumSegmentLength(points: readonly Readonly<Point>[]): number {
  let maximum = 0
  for (let index = 1; index < points.length; index += 1) {
    maximum = Math.max(
      maximum,
      Math.hypot(
        points[index]![0] - points[index - 1]![0],
        points[index]![1] - points[index - 1]![1],
      ),
    )
  }
  return maximum
}

function extents(points: readonly Readonly<Point>[]) {
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return {
    minX,
    maxX,
    minY,
    maxY,
    xSpan: maxX - minX,
    ySpan: maxY - minY,
  }
}

function endpointCounts(
  trajectories: readonly Readonly<AcceptedFlowingTrajectory>[],
) {
  const counts = Object.fromEntries(
    FLOWING_CONTOURS_ENDPOINT_REASONS.map((reason) => [reason, 0]),
  ) as Record<(typeof FLOWING_CONTOURS_ENDPOINT_REASONS)[number], number>
  for (const trajectory of trajectories) {
    counts[trajectory.startEndpointReason] += 1
    counts[trajectory.endEndpointReason] += 1
  }
  return counts
}

function auditFittedProvenance(
  field: Readonly<FlowingContoursField>,
  trajectory: Readonly<AcceptedFlowingTrajectory>,
  curve: Readonly<FittedFlowingCurve>,
): Readonly<FlowingContoursTubeCurveValidation> | null {
  const tube = createFlowingContoursEvidenceTube(field, trajectory)
  if (tube === null) return null
  // This is the canonical auditable proof for both correspondence layers:
  // nearest raw-sample identity (lower index wins ties) and nearest raw-arc
  // validation within each monotonic source-index interval.
  const proof = validateFlowingContoursTubeCurve(field, tube, {
    points: curve.points,
    sourceSampleIndices: curve.provenance.sourceSampleIndices,
  })
  if (
    proof === null ||
    proof.sourceTrajectoryId !== curve.provenance.sourceTrajectoryId ||
    !Object.is(
      proof.evidenceTubeRadius,
      curve.provenance.evidenceTubeRadius,
    ) ||
    !Object.is(proof.maximumDeviation, curve.provenance.maximumDeviation) ||
    proof.sourceSampleIndices.length !==
      curve.provenance.sourceSampleIndices.length ||
    !proof.sourceSampleIndices.every(
      (sourceIndex, index) =>
        sourceIndex === curve.provenance.sourceSampleIndices[index],
    )
  ) {
    return null
  }
  return proof
}

function expectExactPipelineProvenance(
  field: Readonly<FlowingContoursField>,
  output: Readonly<FlowingContoursPipelineResult>,
): void {
  const { acceptedTrajectories, fittedCurves, diagnostics } = output
  const rawPointCount = acceptedTrajectories.reduce(
    (sum, trajectory) => sum + trajectory.samples.length,
    0,
  )
  const fittedPointCount = fittedCurves.reduce(
    (sum, curve) => sum + curve.points.length,
    0,
  )
  let maximumUnsupported = 0
  let totalUnsupported = 0

  expect(diagnostics).toMatchObject({
    termination: 'complete',
    limitedBy: null,
    analysisWidth: field.width,
    analysisHeight: field.height,
    analysisSampleCount: field.width * field.height,
    acceptedCandidateCount: acceptedTrajectories.length,
    rawTrajectoryCount: acceptedTrajectories.length,
    rawTrajectoryPointCount: rawPointCount,
    fittedCurveCount: fittedCurves.length,
    fittedCurvePointCount: fittedPointCount,
    primitiveCount: fittedCurves.length,
  })
  expect(diagnostics.candidateCount).toBe(
    diagnostics.acceptedCandidateCount + diagnostics.rejectedCandidateCount,
  )
  expect(diagnostics.endpointReasonCounts).toEqual(
    endpointCounts(acceptedTrajectories),
  )
  expect(fittedCurves).toHaveLength(acceptedTrajectories.length)

  for (
    let trajectoryIndex = 0;
    trajectoryIndex < acceptedTrajectories.length;
    trajectoryIndex += 1
  ) {
    const trajectory = acceptedTrajectories[trajectoryIndex]!
    const curve = fittedCurves[trajectoryIndex]!
    let expectedStart = 0
    let trajectoryMaximumUnsupported = 0
    let trajectoryTotalUnsupported = 0

    expect(trajectory.id).toBe(trajectoryIndex)
    expect(trajectory.samples.length).toBeGreaterThanOrEqual(2)
    for (const span of trajectory.spanSupport) {
      expect(span.startSampleIndex).toBe(expectedStart)
      expect(span.endSampleIndex).toBeGreaterThan(span.startSampleIndex)
      expect(span.endSampleIndex).toBeLessThan(trajectory.samples.length)
      expect(span.length).toBe(
        segmentLength(
          trajectory,
          span.startSampleIndex,
          span.endSampleIndex,
        ),
      )
      expect(span.entryEvidence).toBe(
        trajectory.samples[span.startSampleIndex]!.evidence,
      )
      expect(span.exitEvidence).toBe(
        trajectory.samples[span.endSampleIndex]!.evidence,
      )
      if (span.kind === 'direct-evidence') {
        expect(
          trajectory.samples
            .slice(span.startSampleIndex, span.endSampleIndex + 1)
            .every((sample) => sample.evidence > 0),
        ).toBe(true)
      } else {
        expect(
          span.endSampleIndex - span.startSampleIndex,
        ).toBeGreaterThanOrEqual(2)
        trajectoryMaximumUnsupported = Math.max(
          trajectoryMaximumUnsupported,
          span.length,
        )
        trajectoryTotalUnsupported += span.length
      }
      expectedStart = span.endSampleIndex
    }
    expect(expectedStart).toBe(trajectory.samples.length - 1)
    expect(trajectory.maximumUnsupportedSpanLength).toBe(
      trajectoryMaximumUnsupported,
    )
    expect(trajectory.totalUnsupportedSpanLength).toBe(
      trajectoryTotalUnsupported,
    )
    maximumUnsupported = Math.max(
      maximumUnsupported,
      trajectoryMaximumUnsupported,
    )
    totalUnsupported += trajectoryTotalUnsupported

    const proof = auditFittedProvenance(field, trajectory, curve)
    expect(proof).not.toBeNull()
    if (proof === null) throw new Error('fitted provenance audit failed')
    expect(proof.sourceTrajectoryId).toBe(trajectory.id)
    expect(proof.sourceSampleIndices).toEqual(
      curve.provenance.sourceSampleIndices,
    )
    expect(curve.provenance.sourceSampleIndices).toHaveLength(curve.points.length)
    expect(curve.provenance.sourceSampleIndices[0]).toBe(0)
    expect(curve.provenance.sourceSampleIndices.at(-1)).toBe(
      trajectory.samples.length - 1,
    )
    expect(curve.points[0]).toEqual(trajectory.samples[0]!.point)
    expect(curve.points.at(-1)).toEqual(trajectory.samples.at(-1)!.point)
    for (
      let index = 0;
      index < curve.provenance.sourceSampleIndices.length;
      index += 1
    ) {
      const sourceIndex = curve.provenance.sourceSampleIndices[index]!
      expect(sourceIndex).toBeGreaterThanOrEqual(0)
      expect(sourceIndex).toBeLessThan(trajectory.samples.length)
      if (index > 0) {
        expect(sourceIndex).toBeGreaterThanOrEqual(
          curve.provenance.sourceSampleIndices[index - 1]!,
        )
      }
    }
  }

  expect(diagnostics.acceptedMaximumUnsupportedSpanLength).toBe(
    maximumUnsupported,
  )
  expect(diagnostics.acceptedTotalUnsupportedSpanLength).toBe(totalUnsupported)
}

function runExactPipeline(
  field: Readonly<FlowingContoursField>,
  controls: Partial<FlowingContoursControls> = {},
) {
  const resolved = Object.freeze({ ...PIPELINE_CONTROLS, ...controls })
  const first = runFlowingContoursPipeline(field, resolved)
  const second = runFlowingContoursPipeline(field, resolved)
  expect(second).toEqual(first)
  expectExactPipelineProvenance(field, first)
  return first
}

function expectExactGeneratorAccounting(
  pixels: DecodedPixels,
  controls: Readonly<FlowingContoursControls>,
  result: ReturnType<typeof generateFlowingContours>,
): void {
  const primitiveCount = result.scene.primitives.length
  const endpointTotal = Object.values(
    result.diagnostics.endpointReasonCounts,
  ).reduce((sum, count) => sum + count, 0)
  const fit = createRasterContainFit(pixels, FRAME)!
  const minimumLength =
    controls.minimumStrokeLength *
    Math.hypot(fit.fittedWidth, fit.fittedHeight)

  expect(result.diagnostics).toMatchObject({
    termination: 'complete',
    limitedBy: null,
    analysisWidth: pixels.width,
    analysisHeight: pixels.height,
    acceptedCandidateCount: primitiveCount,
    rawTrajectoryCount: primitiveCount,
    fittedCurveCount: primitiveCount,
    primitiveCount,
  })
  expect(result.diagnostics.candidateCount).toBe(
    primitiveCount + result.diagnostics.rejectedCandidateCount,
  )
  expect(endpointTotal).toBe(primitiveCount * 2)
  for (const primitive of result.scene.primitives) {
    expect(pathLength(primitive.points)).toBeGreaterThanOrEqual(
      minimumLength - 1e-8,
    )
  }
}

function generateExact(
  pixels: DecodedPixels,
  controls: Partial<FlowingContoursControls> = {},
) {
  const resolved = Object.freeze({ ...GENERATOR_CONTROLS, ...controls })
  const input = Object.freeze({ pixels, frame: FRAME, controls: resolved })
  const first = generateFlowingContours(input)
  const second = generateFlowingContours(input)
  expect(second).toEqual(first)
  expectExactGeneratorAccounting(pixels, resolved, first)
  return first
}

function prescribedHorizontalField(
  strengthAt: (x: number) => number,
  options: Readonly<{
    centerAt?: (x: number) => number
    alphaAt?: (x: number) => number
  }> = {},
): Readonly<FlowingContoursField> {
  const width = 49
  const height = 15
  const centerAt = options.centerAt ?? (() => 7)
  const alphaAt = options.alphaAt ?? (() => 1)
  const count = width * height
  const alpha: number[] = []
  const contourEvidence: number[] = []
  for (let index = 0; index < count; index += 1) {
    const x = index % width
    const y = Math.floor(index / width)
    const support = alphaAt(x)
    alpha.push(support)
    contourEvidence.push(
      support > 0
        ? strengthAt(x) *
            Math.exp(-((y - centerAt(x)) ** 2) / (2 * 0.55 ** 2))
        : 0,
    )
  }
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze(new Array<number>(count).fill(0.5)),
    alpha: Object.freeze(alpha),
    positiveSupport: Object.freeze(alpha.map((value) => value > 0)),
    contourEvidence: Object.freeze(contourEvidence),
    tangentX: Object.freeze(new Array<number>(count).fill(1)),
    tangentY: Object.freeze(new Array<number>(count).fill(0)),
    tangentCoherence: Object.freeze(new Array<number>(count).fill(1)),
    ambiguity: Object.freeze(new Array<number>(count).fill(0)),
    ridgeScale: Object.freeze(new Array<number>(count).fill(1)),
  })
}

function prescribedForkField(): Readonly<FlowingContoursField> {
  const width = 49
  const height = 31
  const centerY = 15
  const forkX = 24
  const slope = 0.42
  const branchLength = Math.hypot(1, slope)
  const count = width * height
  const contourEvidence: number[] = []
  const tangentX: number[] = []
  const tangentY: number[] = []
  const ambiguity: number[] = []
  for (let index = 0; index < count; index += 1) {
    const x = index % width
    const y = Math.floor(index / width)
    if (x <= forkX) {
      contourEvidence.push(
        Math.exp(-((y - centerY) ** 2) / (2 * 0.55 ** 2)),
      )
      tangentX.push(1)
      tangentY.push(0)
    } else {
      const spread = (x - forkX) * slope
      const upperDistance = Math.abs(y - (centerY - spread)) / branchLength
      const lowerDistance = Math.abs(y - (centerY + spread)) / branchLength
      const upper = Math.exp(-(upperDistance ** 2) / (2 * 0.55 ** 2))
      const lower = Math.exp(-(lowerDistance ** 2) / (2 * 0.55 ** 2))
      contourEvidence.push(Math.max(upper, lower))
      tangentX.push(1 / branchLength)
      tangentY.push((upper >= lower ? -slope : slope) / branchLength)
    }
    ambiguity.push(
      Math.abs(x - forkX) <= 1 && Math.abs(y - centerY) <= 2 ? 1 : 0,
    )
  }
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze(new Array<number>(count).fill(0.5)),
    alpha: Object.freeze(new Array<number>(count).fill(1)),
    positiveSupport: Object.freeze(new Array<boolean>(count).fill(true)),
    contourEvidence: Object.freeze(contourEvidence),
    tangentX: Object.freeze(tangentX),
    tangentY: Object.freeze(tangentY),
    tangentCoherence: Object.freeze(new Array<number>(count).fill(1)),
    ambiguity: Object.freeze(ambiguity),
    ridgeScale: Object.freeze(new Array<number>(count).fill(1)),
  })
}

function prescribedParallelField(): Readonly<FlowingContoursField> {
  const width = 49
  const height = 17
  const centers = [7, 10]
  const count = width * height
  const contourEvidence = Array.from({ length: count }, (_value, index) => {
    const y = Math.floor(index / width)
    const distance = Math.min(...centers.map((center) => Math.abs(y - center)))
    return Math.exp(-(distance ** 2) / (2 * 0.45 ** 2))
  })
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze(new Array<number>(count).fill(0.5)),
    alpha: Object.freeze(new Array<number>(count).fill(1)),
    positiveSupport: Object.freeze(new Array<boolean>(count).fill(true)),
    contourEvidence: Object.freeze(contourEvidence),
    tangentX: Object.freeze(new Array<number>(count).fill(1)),
    tangentY: Object.freeze(new Array<number>(count).fill(0)),
    tangentCoherence: Object.freeze(new Array<number>(count).fill(1)),
    ambiguity: Object.freeze(new Array<number>(count).fill(0)),
    ridgeScale: Object.freeze(new Array<number>(count).fill(1)),
  })
}

function prescribedWeakNeighborField(): Readonly<FlowingContoursField> {
  const width = 19
  const height = 49
  const count = width * height
  const contourEvidence = Array.from({ length: count }, (_value, index) => {
    const x = index % width
    const y = Math.floor(index / width)
    const weakStrength = y <= 23 ? 1 : 0.02
    const weak =
      weakStrength * Math.exp(-((x - 7) ** 2) / (2 * 0.45 ** 2))
    const strong = 0.8 * Math.exp(-((x - 10) ** 2) / (2 * 0.45 ** 2))
    return Math.max(weak, strong)
  })
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze(new Array<number>(count).fill(0.5)),
    alpha: Object.freeze(new Array<number>(count).fill(1)),
    positiveSupport: Object.freeze(new Array<boolean>(count).fill(true)),
    contourEvidence: Object.freeze(contourEvidence),
    tangentX: Object.freeze(new Array<number>(count).fill(0)),
    tangentY: Object.freeze(new Array<number>(count).fill(1)),
    tangentCoherence: Object.freeze(new Array<number>(count).fill(1)),
    ambiguity: Object.freeze(new Array<number>(count).fill(0)),
    ridgeScale: Object.freeze(new Array<number>(count).fill(1)),
  })
}

function prescribedFlatFlowField(): Readonly<FlowingContoursField> {
  const width = 49
  const height = 17
  const count = width * height
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze(new Array<number>(count).fill(0.5)),
    alpha: Object.freeze(new Array<number>(count).fill(1)),
    positiveSupport: Object.freeze(new Array<boolean>(count).fill(true)),
    contourEvidence: Object.freeze(new Array<number>(count).fill(1)),
    tangentX: Object.freeze(new Array<number>(count).fill(1)),
    tangentY: Object.freeze(new Array<number>(count).fill(0)),
    tangentCoherence: Object.freeze(new Array<number>(count).fill(1)),
    ambiguity: Object.freeze(new Array<number>(count).fill(0)),
    ridgeScale: Object.freeze(new Array<number>(count).fill(1)),
  })
}

function prescribedInterruptedLoopField(): Readonly<FlowingContoursField> {
  const size = 49
  const center = 24
  const radius = 15
  const count = size * size
  const alpha: number[] = []
  const contourEvidence: number[] = []
  const tangentX: number[] = []
  const tangentY: number[] = []
  for (let index = 0; index < count; index += 1) {
    const x = index % size
    const y = Math.floor(index / size)
    const dx = x - center
    const dy = y - center
    const distance = Math.hypot(dx, dy)
    const angle = Math.atan2(dy, dx)
    const angleFromTop = Math.atan2(
      Math.sin(angle + Math.PI / 2),
      Math.cos(angle + Math.PI / 2),
    )
    const supported = Math.abs(angleFromTop) >= 0.34
    const tangentLength = distance > 0 ? distance : 1
    alpha.push(supported ? 1 : 0)
    contourEvidence.push(
      supported
        ? Math.exp(-((distance - radius) ** 2) / (2 * 0.5 ** 2))
        : 0,
    )
    tangentX.push(distance > 0 ? -dy / tangentLength : 1)
    tangentY.push(distance > 0 ? dx / tangentLength : 0)
  }
  return Object.freeze({
    sourceWidth: size,
    sourceHeight: size,
    width: size,
    height: size,
    luminance: Object.freeze(new Array<number>(count).fill(0.5)),
    alpha: Object.freeze(alpha),
    positiveSupport: Object.freeze(alpha.map((value) => value > 0)),
    contourEvidence: Object.freeze(contourEvidence),
    tangentX: Object.freeze(tangentX),
    tangentY: Object.freeze(tangentY),
    tangentCoherence: Object.freeze(new Array<number>(count).fill(1)),
    ambiguity: Object.freeze(new Array<number>(count).fill(0)),
    ridgeScale: Object.freeze(new Array<number>(count).fill(1)),
  })
}

function acceptedFlowSelection(
  field: Readonly<FlowingContoursField>,
  y: number,
  id: number,
  accounting: ReturnType<typeof createFlowingContoursAccounting>,
) {
  const sample = sampleFlowingContoursField(field, [24, y])
  if (sample === null) throw new Error('fixture sample must be supported')
  const anchor: Readonly<FlowingContoursAnchor> = Object.freeze({
    id,
    fieldSampleIndex: y * field.width + 24,
    sample,
  })
  const candidate = searchFlowingContoursCandidate(field, anchor, {
    continuity: 0,
    flowSmoothing: 0.8,
  })
  if (candidate === null) throw new Error('fixture candidate must exist')
  const selection = selectFlowingContoursCandidate(
    candidate,
    {
      analysisWidth: field.width,
      analysisHeight: field.height,
      minimumStrokeLength: 0.05,
    },
    accounting,
  )
  if (selection.kind !== 'accepted') {
    throw new Error(`fixture selection rejected: ${selection.reason}`)
  }
  return Object.freeze({ anchor, selection })
}

describe('Flowing Contours synthetic ambiguity and gap integration', () => {
  it('commits one exact bounded gap only when far-side evidence is compatible', () => {
    const compatible = prescribedHorizontalField((x) =>
      x >= 22 && x <= 24 ? 0.02 : 1,
    )
    const output = runExactPipeline(compatible)
    const trajectory = output.acceptedTrajectories[0]!

    expect(output.acceptedTrajectories).toHaveLength(1)
    expect([
      trajectory.samples[0]!.point,
      trajectory.samples.at(-1)!.point,
    ]).toEqual([
      [0, 7],
      [48, 7],
    ])
    expect(trajectory.spanSupport).toEqual([
      expect.objectContaining({
        kind: 'direct-evidence',
        startSampleIndex: 0,
        endSampleIndex: 29,
        length: 21.75,
      }),
      expect.objectContaining({
        kind: 'bounded-gap',
        startSampleIndex: 29,
        endSampleIndex: 33,
        length: 3,
        entryEvidence: 0.265,
        exitEvidence: 0.755,
        directionalAlignment: 1,
      }),
      expect.objectContaining({
        kind: 'direct-evidence',
        startSampleIndex: 33,
        endSampleIndex: 64,
        length: 23.25,
      }),
    ])
    expect(trajectory.maximumUnsupportedSpanLength).toBe(3)
    expect(trajectory.totalUnsupportedSpanLength).toBe(3)
    expect([
      trajectory.startEndpointReason,
      trajectory.endEndpointReason,
    ]).toEqual(['source-boundary', 'source-boundary'])

    const curve = output.fittedCurves[0]!
    const allZeroMapping: Readonly<FittedFlowingCurve> = Object.freeze({
      points: curve.points,
      provenance: Object.freeze({
        ...curve.provenance,
        sourceSampleIndices: Object.freeze(
          new Array<number>(curve.points.length).fill(0),
        ),
      }),
    })
    expect(
      auditFittedProvenance(compatible, trajectory, allZeroMapping),
    ).toBeNull()
  })

  it('keeps both opaque sides of a long unsupported gap and rolls back provisional travel', () => {
    const field = prescribedHorizontalField((x) =>
      x >= 15 && x <= 33 ? 0.02 : 1,
    )
    const output = runExactPipeline(field)

    expect(output.acceptedTrajectories).toHaveLength(2)
    expect(
      output.acceptedTrajectories.map((trajectory) => ({
        endpoints: [
          trajectory.samples[0]!.point,
          trajectory.samples.at(-1)!.point,
        ],
        reasons: [
          trajectory.startEndpointReason,
          trajectory.endEndpointReason,
        ],
      })),
    ).toEqual([
      {
        endpoints: [
          [0, 7],
          [14.25, 7],
        ],
        reasons: ['source-boundary', 'evidence-exhausted'],
      },
      {
        endpoints: [
          [33.25, 7],
          [47.5, 7],
        ],
        reasons: ['evidence-exhausted', 'source-boundary'],
      },
    ])
    expect(
      output.acceptedTrajectories.every(
        (trajectory) =>
          trajectory.samples.every((sample) => sample.point[0] <= 14.25) ||
          trajectory.samples.every((sample) => sample.point[0] >= 33.25),
      ),
    ).toBe(true)
    expect(
      output.acceptedTrajectories.flatMap(
        (trajectory) => trajectory.spanSupport,
      ).every((span) => span.kind === 'direct-evidence'),
    ).toBe(true)
    expect(output.diagnostics.acceptedMaximumUnsupportedSpanLength).toBe(0)
    expect(output.diagnostics.acceptedTotalUnsupportedSpanLength).toBe(0)
  })

  it('keeps both transparent-gap sides nonempty without traversing zero alpha', () => {
    const field = prescribedHorizontalField(
      () => 1,
      { alphaAt: (x) => (x >= 22 && x <= 26 ? 0 : 1) },
    )
    const output = runExactPipeline(field)

    expect(output.acceptedTrajectories).toHaveLength(2)
    expect(
      output.acceptedTrajectories.map((trajectory) => ({
        endpoints: [
          trajectory.samples[0]!.point,
          trajectory.samples.at(-1)!.point,
        ],
        reasons: [
          trajectory.startEndpointReason,
          trajectory.endEndpointReason,
        ],
      })),
    ).toEqual([
      {
        endpoints: [
          [0, 7],
          [21.75, 7],
        ],
        reasons: ['source-boundary', 'alpha-boundary'],
      },
      {
        endpoints: [
          [26.25, 7],
          [48, 7],
        ],
        reasons: ['alpha-boundary', 'source-boundary'],
      },
    ])
    for (const trajectory of output.acceptedTrajectories) {
      expect(trajectory.length).toBeGreaterThan(20)
      expect(
        trajectory.samples.every((sample) => sample.alpha > 0),
      ).toBe(true)
      expect(
        trajectory.samples.every(
          (sample) => sample.point[0] <= 21.75,
        ) ||
          trajectory.samples.every(
            (sample) => sample.point[0] >= 26.25,
          ),
      ).toBe(true)
      expect(
        trajectory.spanSupport.every(
          (span) => span.kind === 'direct-evidence',
        ),
      ).toBe(true)
    }
    expect(output.diagnostics.acceptedMaximumUnsupportedSpanLength).toBe(0)
  })

  it('rejects a short gap when its far-side ridge is positionally incompatible', () => {
    const field = prescribedHorizontalField(
      (x) => (x >= 20 && x <= 28 ? 0.02 : 1),
      { centerAt: (x) => (x <= 24 ? 7 : 10) },
    )
    const output = runExactPipeline(field)

    expect(output.acceptedTrajectories).toHaveLength(2)
    expect(
      output.acceptedTrajectories.map((trajectory) => [
        trajectory.samples[0]!.point,
        trajectory.samples.at(-1)!.point,
      ]),
    ).toEqual([
      [
        [0, 7],
        [19.5, 7],
      ],
      [
        [28.25, 10],
        [47.75, 10],
      ],
    ])
    expect(
      output.acceptedTrajectories.every(
        (trajectory) =>
          trajectory.spanSupport.every(
            (span) => span.kind === 'direct-evidence',
          ),
      ),
    ).toBe(true)
    expect(output.diagnostics.endpointReasonCounts['evidence-exhausted']).toBe(
      2,
    )
    expect(output.diagnostics.acceptedTotalUnsupportedSpanLength).toBe(0)
  })

  it('pairs exact Y-fork endpoints with ambiguity without choosing a branch', () => {
    const field = prescribedForkField()
    const output = runExactPipeline(field)
    const trunk = output.acceptedTrajectories[0]!

    expect(output.acceptedTrajectories).toHaveLength(3)
    expect([
      trunk.samples[0]!.point,
      trunk.samples.at(-1)!.point,
      trunk.startEndpointReason,
      trunk.endEndpointReason,
      trunk.length,
    ]).toEqual([
      [0, 15],
      [22.5, 15],
      'source-boundary',
      'ambiguity',
      22.5,
    ])
    const ambiguityEndpoints = output.acceptedTrajectories.flatMap(
      (trajectory) => [
        ...(trajectory.startEndpointReason === 'ambiguity'
          ? [trajectory.samples[0]!.point]
          : []),
        ...(trajectory.endEndpointReason === 'ambiguity'
          ? [trajectory.samples.at(-1)!.point]
          : []),
      ],
    )
    expect(ambiguityEndpoints).toHaveLength(3)
    expect(
      ambiguityEndpoints.every(
        (point) =>
          Math.abs(point[0] - 24) <= 1.65 &&
          Math.abs(point[1] - 15) <= 1,
      ),
    ).toBe(true)
    expect(trunk.samples.every((sample) => sample.point[0] <= 22.5)).toBe(true)
    expect(
      output.acceptedTrajectories.slice(1).every(
        (trajectory) =>
          trajectory.samples.every((sample) => sample.point[0] >= 25.64),
      ),
    ).toBe(true)
    expect(
      output.acceptedTrajectories.some(
        (trajectory) =>
          trajectory.samples.some((sample) => sample.point[0] < 23) &&
          trajectory.samples.some((sample) => sample.point[0] > 25),
      ),
    ).toBe(false)
  })

  it('retains close pipeline ridges and one-pixel flows in stable order', () => {
    // Anchor inventory separation is three analysis pixels, so [7, 10] is
    // the closest pair that can be admitted end-to-end. The second half
    // exercises accepted-geometry suppression itself at one analysis pixel.
    const output = runExactPipeline(prescribedParallelField())
    expect(
      output.acceptedTrajectories.map((trajectory) => ({
        id: trajectory.id,
        meanY:
          trajectory.samples.reduce(
            (sum, sample) => sum + sample.point[1],
            0,
          ) / trajectory.samples.length,
      })),
    ).toEqual([
      { id: 0, meanY: 7 },
      { id: 1, meanY: 10 },
    ])
    expect(output.diagnostics.candidateCount).toBe(2)
    expect(output.diagnostics.suppressedAnchorCount).toBe(32)

    const field = prescribedFlatFlowField()
    const accounting = createFlowingContoursAccounting()
    const initial = createFlowingContoursSuppressionState({ field })
    if (initial === null) throw new Error('fixture suppression state failed')
    const flows = [
      acceptedFlowSelection(field, 7, 0, accounting),
      acceptedFlowSelection(field, 8, 1, accounting),
    ]
    expect(
      flows.map(({ selection }) => ({
        id: selection.trajectory.id,
        endpoints: [
          selection.trajectory.samples[0]!.point,
          selection.trajectory.samples.at(-1)!.point,
        ],
      })),
    ).toEqual([
      {
        id: 0,
        endpoints: [
          [0, 7],
          [48, 7],
        ],
      },
      {
        id: 1,
        endpoints: [
          [0, 8],
          [48, 8],
        ],
      },
    ])

    const firstRegistration = registerAcceptedFlowingTrajectorySuppression(
      initial,
      field,
      flows[0]!.selection,
    )
    if (firstRegistration === null) throw new Error('registration failed')
    const firstCommit = commitAcceptedFlowingTrajectorySuppression(
      initial,
      firstRegistration,
    )
    if (firstCommit.kind !== 'committed') {
      throw new Error(firstCommit.reason)
    }
    const query = createFlowingContoursSuppressionQuery(
      firstCommit.state,
      field,
    )
    if (query === null) throw new Error('suppression query failed')
    expect(isFlowingContoursAnchorSuppressed(query, flows[0]!.anchor)).toBe(
      true,
    )
    expect(isFlowingContoursAnchorSuppressed(query, flows[1]!.anchor)).toBe(
      false,
    )

    const secondRegistration = registerAcceptedFlowingTrajectorySuppression(
      firstCommit.state,
      field,
      flows[1]!.selection,
    )
    if (secondRegistration === null) throw new Error('registration failed')
    const secondCommit = commitAcceptedFlowingTrajectorySuppression(
      firstCommit.state,
      secondRegistration,
    )
    expect(secondCommit.kind).toBe('committed')
    if (secondCommit.kind !== 'committed') return
    expect(secondCommit.state.occupancySampleCount).toBeGreaterThan(
      firstCommit.state.occupancySampleCount,
    )
  })

  it('stops a weakening ridge without migrating to its stronger neighbor', () => {
    const output = runExactPipeline(prescribedWeakNeighborField())
    const weak = output.acceptedTrajectories[0]!
    const strong = output.acceptedTrajectories[1]!

    expect(output.acceptedTrajectories).toHaveLength(2)
    expect([
      weak.samples[0]!.point,
      weak.samples.at(-1)!.point,
      weak.startEndpointReason,
      weak.endEndpointReason,
    ]).toEqual([
      [7, 0],
      [7, 23.25],
      'source-boundary',
      'evidence-exhausted',
    ])
    expect(weak.samples.every((sample) => sample.point[0] === 7)).toBe(true)
    expect(weak.samples.every((sample) => sample.point[1] <= 23.25)).toBe(true)
    expect(strong.samples.every((sample) => sample.point[0] === 10)).toBe(true)
    expect([
      strong.samples[0]!.point,
      strong.samples.at(-1)!.point,
    ]).toEqual([
      [10, 0],
      [10, 48],
    ])
    expect(output.diagnostics.acceptedTotalUnsupportedSpanLength).toBe(0)
  })

  it('preserves a dominant raster crossing without grid turns or a fragment flood', () => {
    const pixels = raster(80, 64, (x, y) => {
      const vertical = 1 / (1 + Math.exp(-(x - 39.25) / 0.65))
      const horizontal = 1 / (1 + Math.exp(-(y - 31.4) / 0.65))
      const byte = clampByte(25 + 185 * vertical + 45 * horizontal)
      return [byte, byte, byte, 255]
    })
    const result = generateExact(pixels, {
      curveDetail: 1,
      continuity: 0.9,
    })
    const bounds = result.scene.primitives.map((primitive) =>
      extents(primitive.points),
    )

    expect(result.scene.primitives).toHaveLength(2)
    expect(
      bounds.some(
        (item) =>
          item.ySpan > FRAME.height * 0.9 &&
          item.xSpan < FRAME.width * 0.04,
      ),
    ).toBe(true)
    expect(
      bounds.some(
        (item) =>
          item.xSpan > FRAME.width * 0.2 &&
          item.ySpan < FRAME.height * 0.04,
      ),
    ).toBe(true)
    for (const item of bounds) {
      expect(Math.max(item.xSpan, item.ySpan)).toBeGreaterThan(
        Math.min(item.xSpan, item.ySpan) * 8,
      )
    }
    expect(
      result.scene.primitives.every(
        (primitive) => pathLength(primitive.points) > FRAME.height * 0.25,
      ),
    ).toBe(true)
  })

  it('leaves a prescribed interrupted loop open without an endpoint chord', () => {
    const field = prescribedInterruptedLoopField()
    const output = runExactPipeline(field)
    const trajectory = output.acceptedTrajectories[0]!
    const curve = output.fittedCurves[0]!
    const first = curve.points[0]!
    const last = curve.points.at(-1)!
    const endpointDistance = Math.hypot(
      last[0] - first[0],
      last[1] - first[1],
    )

    expect(output.acceptedTrajectories).toHaveLength(1)
    expect(output.fittedCurves).toHaveLength(1)
    expect(output.diagnostics.rejectedCandidateCount).toBe(1)
    expect([
      trajectory.samples[0]!.point,
      trajectory.samples.at(-1)!.point,
      trajectory.startEndpointReason,
      trajectory.endEndpointReason,
    ]).toEqual([
      [19.30664497196662, 9.924925841745436],
      [28.621636822565044, 9.914943750184856],
      'alpha-boundary',
      'alpha-boundary',
    ])
    expect(curve.points[0]).toEqual(trajectory.samples[0]!.point)
    expect(curve.points.at(-1)).toEqual(trajectory.samples.at(-1)!.point)
    expect(trajectory.samples.every((sample) => sample.alpha > 0)).toBe(true)
    expect(pathLength(curve.points)).toBeGreaterThan(endpointDistance * 7)
    expect(maximumSegmentLength(curve.points)).toBeLessThan(6)
    expect(first).not.toEqual(last)
  })
})
