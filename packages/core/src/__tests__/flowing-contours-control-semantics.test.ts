import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import { createFlowingContoursAccounting } from '../sketches/flowing-contours/accounting'
import {
  admitFlowingContoursAnchors,
  buildFlowingContoursAnchorInventory,
} from '../sketches/flowing-contours/anchors'
import {
  defaultFlowingContoursControls,
  flowingContoursControlSchema,
  normalizeFlowingContoursControls,
  type FlowingContoursControls,
} from '../sketches/flowing-contours/controls'
import { fitFlowingContoursCurve } from '../sketches/flowing-contours/curves'
import {
  buildFlowingContoursField,
  sampleFlowingContoursField,
} from '../sketches/flowing-contours/field'
import { generateFlowingContours } from '../sketches/flowing-contours/generator'
import {
  growFlowingContoursDirection,
  measureFlowingContoursCurvatureChange,
} from '../sketches/flowing-contours/growth'
import { createFlowingContoursTestLimits } from '../sketches/flowing-contours/limits'
import {
  compareFlowingContoursCandidateScores,
  scoreFlowingContoursCandidate,
} from '../sketches/flowing-contours/objective'
import { runFlowingContoursPipeline } from '../sketches/flowing-contours/pipeline'
import { prepareFlowingContoursRaster } from '../sketches/flowing-contours/raster'
import { searchFlowingContoursCandidate } from '../sketches/flowing-contours/search'
import { selectFlowingContoursCandidate } from '../sketches/flowing-contours/selection'
import {
  createFlowingContoursEvidenceTube,
  validateFlowingContoursTubeCurve,
} from '../sketches/flowing-contours/tube'
import type {
  AcceptedFlowingTrajectory,
  CorrectedFlowingRidgeSample,
  FlowingContoursCandidateScore,
  FlowingContoursField,
  FlowingContoursPipelineResult,
  FlowingContoursSpanSupportProvenance,
} from '../sketches/flowing-contours/types'
import type { Point } from '../types'

interface FieldValue {
  readonly evidence?: number
  readonly tangent?: Readonly<Point>
  readonly coherence?: number
  readonly ambiguity?: number
  readonly scale?: number
  readonly alpha?: number
}

const CONTROL_NAMES = Object.freeze([
  'curveDetail',
  'continuity',
  'flowSmoothing',
  'minimumStrokeLength',
] as const)

const BASE_CONTROLS: Readonly<FlowingContoursControls> = Object.freeze({
  curveDetail: 1,
  continuity: 0.45,
  flowSmoothing: 0.7,
  minimumStrokeLength: 0.1,
})

const SCORE: Readonly<FlowingContoursCandidateScore> = Object.freeze({
  accumulatedEvidence: 4,
  usefulLength: 3,
  directionalCoherence: 2,
  curvaturePenalty: 0,
  unsupportedTravelPenalty: 0,
  ambiguityPenalty: 0,
  representedOverlapPenalty: 0,
  total: 9,
})

const SELECTION_LIMITS = createFlowingContoursTestLimits({
  'candidate-count': 8,
  'accepted-curve-count': 4,
  'raw-trajectory-point-count': 32,
})!

function field(
  width: number,
  height: number,
  valueAt: (x: number, y: number) => FieldValue,
): Readonly<FlowingContoursField> {
  const luminance: number[] = []
  const alpha: number[] = []
  const positiveSupport: boolean[] = []
  const contourEvidence: number[] = []
  const tangentX: number[] = []
  const tangentY: number[] = []
  const tangentCoherence: number[] = []
  const ambiguity: number[] = []
  const ridgeScale: number[] = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = valueAt(x, y)
      const sampledAlpha = value.alpha ?? 1
      const tangent = value.tangent ?? ([1, 0] as const)
      luminance.push(0.5)
      alpha.push(sampledAlpha)
      positiveSupport.push(sampledAlpha > 0)
      contourEvidence.push(value.evidence ?? 0)
      tangentX.push(tangent[0])
      tangentY.push(tangent[1])
      tangentCoherence.push(value.coherence ?? 1)
      ambiguity.push(value.ambiguity ?? 0)
      ridgeScale.push(value.scale ?? 1)
    }
  }
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze(luminance),
    alpha: Object.freeze(alpha),
    positiveSupport: Object.freeze(positiveSupport),
    contourEvidence: Object.freeze(contourEvidence),
    tangentX: Object.freeze(tangentX),
    tangentY: Object.freeze(tangentY),
    tangentCoherence: Object.freeze(tangentCoherence),
    ambiguity: Object.freeze(ambiguity),
    ridgeScale: Object.freeze(ridgeScale),
  })
}

function gaussian(distance: number, width = 0.55): number {
  return Math.exp(-(distance * distance) / (2 * width * width))
}

function flowingCurveField(): Readonly<FlowingContoursField> {
  return field(48, 25, (x, y) => {
    const center = 12 + 3 * Math.sin(x / 8)
    const slope = (3 / 8) * Math.cos(x / 8)
    const tangentLength = Math.hypot(1, slope)
    const distance = Math.abs(y - center) / tangentLength
    return {
      evidence: gaussian(distance, 0.6),
      tangent: [1 / tangentLength, slope / tangentLength],
      scale: 2,
    }
  })
}

function sample(
  source: Readonly<FlowingContoursField>,
  point: Readonly<Point>,
): Readonly<CorrectedFlowingRidgeSample> {
  const result = sampleFlowingContoursField(source, point)
  if (result === null) throw new Error(`Expected field sample at ${point}`)
  return result
}

function pathLength(points: readonly Readonly<Point>[]): number {
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(
      points[index]![0] - points[index - 1]![0],
      points[index]![1] - points[index - 1]![1],
    )
  }
  return length
}

function support(
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  kind: 'direct-evidence' | 'bounded-gap',
  startSampleIndex: number,
  endSampleIndex: number,
): Readonly<FlowingContoursSpanSupportProvenance> {
  return Object.freeze({
    kind,
    startSampleIndex,
    endSampleIndex,
    length: pathLength(
      samples
        .slice(startSampleIndex, endSampleIndex + 1)
        .map((entry) => entry.point),
    ),
    entryEvidence: samples[startSampleIndex]!.evidence,
    exitEvidence: samples[endSampleIndex]!.evidence,
    directionalAlignment: 1,
  })
}

function trajectory(
  source: Readonly<FlowingContoursField>,
  points: readonly Readonly<Point>[],
): Readonly<AcceptedFlowingTrajectory> {
  const samples = Object.freeze(points.map((point) => sample(source, point)))
  const spanSupport = Object.freeze([
    support(samples, 'direct-evidence', 0, samples.length - 1),
  ])
  return Object.freeze({
    id: 7,
    anchorId: 17,
    samples,
    spanSupport,
    startEndpointReason: 'source-boundary',
    endEndpointReason: 'evidence-exhausted',
    length: pathLength(points),
    maximumUnsupportedSpanLength: 0,
    totalUnsupportedSpanLength: 0,
    score: SCORE,
  })
}

function selectionFixture() {
  const source = field(32, 15, (x, y) => ({
    evidence: x >= 14 && x <= 18 ? gaussian(y - 7) : 0,
    tangent: [1, 0],
  }))
  const accounting = createFlowingContoursAccounting()
  const inventory = buildFlowingContoursAnchorInventory(source, accounting)
  const admission = admitFlowingContoursAnchors(inventory, 1, accounting)
  const anchor = admission.anchors[0]
  if (anchor === undefined) throw new Error('Expected short-ridge anchor')
  const candidate = searchFlowingContoursCandidate(source, anchor, {
    continuity: 0.45,
    flowSmoothing: 0.7,
  })
  if (candidate === null) throw new Error('Expected short-ridge candidate')
  return Object.freeze({
    source,
    candidate,
    diagonal: Math.hypot(source.width, source.height),
    threshold:
      candidate.length / Math.hypot(source.width, source.height),
  })
}

const SELECTION_FIXTURE = selectionFixture()

function grow(
  source: Readonly<FlowingContoursField>,
  continuity: number,
  flowSmoothing: number,
) {
  return growFlowingContoursDirection(
    source,
    sample(source, [4, 4]),
    [1, 0],
    'forward',
    {
      continuity,
      flowSmoothing,
      ridgeStepOptions: { stepLength: 1 },
    },
    createFlowingContoursTestLimits({
      'search-step-count': 32,
      'weak-span-step-count': 2,
      'weak-span-distance': 3,
    })!,
  )
}

function resample(
  points: readonly Readonly<Point>[],
  spacing = 0.25,
): readonly Readonly<Point>[] {
  const length = pathLength(points)
  if (length === 0) return points
  const result: Readonly<Point>[] = []
  let segmentIndex = 0
  let segmentStartDistance = 0
  for (let distance = 0; distance < length; distance += spacing) {
    while (segmentIndex + 1 < points.length - 1) {
      const segmentLength = Math.hypot(
        points[segmentIndex + 1]![0] - points[segmentIndex]![0],
        points[segmentIndex + 1]![1] - points[segmentIndex]![1],
      )
      if (segmentStartDistance + segmentLength >= distance) break
      segmentStartDistance += segmentLength
      segmentIndex += 1
    }
    const start = points[segmentIndex]!
    const end = points[segmentIndex + 1]!
    const segmentLength = Math.hypot(
      end[0] - start[0],
      end[1] - start[1],
    )
    const amount =
      segmentLength === 0
        ? 0
        : (distance - segmentStartDistance) / segmentLength
    result.push([
      start[0] + (end[0] - start[0]) * amount,
      start[1] + (end[1] - start[1]) * amount,
    ])
  }
  result.push(points.at(-1)!)
  return result
}

function turnMetrics(points: readonly Readonly<Point>[]) {
  const spaced = resample(points)
  let energy = 0
  let maximum = 0
  let moderate = 0
  let abrupt = 0
  for (let index = 1; index < spaced.length - 1; index += 1) {
    const previous = spaced[index - 1]!
    const point = spaced[index]!
    const next = spaced[index + 1]!
    const first = Math.atan2(
      point[1] - previous[1],
      point[0] - previous[0],
    )
    const second = Math.atan2(
      next[1] - point[1],
      next[0] - point[0],
    )
    const turn = Math.abs(
      Math.atan2(Math.sin(second - first), Math.cos(second - first)),
    )
    energy += turn * turn
    maximum = Math.max(maximum, turn)
    if (turn > (25 * Math.PI) / 180 + 1e-9) moderate += 1
    if (turn > (45 * Math.PI) / 180 + 1e-9) abrupt += 1
  }
  return { energy, maximum, moderate, abrupt }
}

function omitDiagnostics(
  source: Readonly<Record<string, unknown>>,
  names: readonly string[],
): Readonly<Record<string, unknown>> {
  const result = { ...source }
  for (const name of names) delete result[name]
  return result
}

function expectValidFittedTubes(
  source: Readonly<FlowingContoursField>,
  result: Readonly<FlowingContoursPipelineResult>,
): void {
  expect(result.fittedCurves).toHaveLength(
    result.acceptedTrajectories.length,
  )
  for (let index = 0; index < result.fittedCurves.length; index += 1) {
    const raw = result.acceptedTrajectories[index]!
    const curve = result.fittedCurves[index]!
    const tube = createFlowingContoursEvidenceTube(source, raw)
    expect(tube).not.toBeNull()
    if (tube === null) continue
    expect(
      validateFlowingContoursTubeCurve(source, tube, {
        points: curve.points,
        sourceSampleIndices: curve.provenance.sourceSampleIndices,
      }),
    ).not.toBeNull()
  }
}

function axisAlternationCount(
  points: readonly Readonly<Point>[],
): number {
  let count = 0
  for (let index = 2; index < points.length; index += 1) {
    const a = points[index - 2]!
    const b = points[index - 1]!
    const c = points[index]!
    const firstAxis =
      Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? 'x' : 'y'
    const secondAxis =
      Math.abs(c[0] - b[0]) > Math.abs(c[1] - b[1]) ? 'x' : 'y'
    if (firstAxis !== secondAxis) count += 1
  }
  return count
}

function segmentObliqueness(
  points: readonly Readonly<Point>[],
): readonly number[] {
  return points.slice(1).map((point, index) => {
    const previous = points[index]!
    const dx = Math.abs(point[0] - previous[0])
    const dy = Math.abs(point[1] - previous[1])
    const length = Math.hypot(dx, dy)
    return length === 0 ? 0 : Math.min(dx, dy) / length
  })
}

function smoothingInvariantTrajectory(
  source: Readonly<AcceptedFlowingTrajectory>,
) {
  return {
    ...source,
    score: {
      ...source.score,
      curvaturePenalty: 0,
      total: 0,
    },
  }
}

function raster(
  width: number,
  height: number,
  valueAt: (
    x: number,
    y: number,
  ) => readonly [number, number, number, number],
): DecodedPixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(valueAt(x, y), (y * width + x) * 4)
    }
  }
  return { width, height, data }
}

describe('Flowing Contours artist-control semantics', () => {
  it('exposes exactly four ordered controls and normalizes each boundary independently', () => {
    expect(Object.keys(flowingContoursControlSchema)).toEqual(CONTROL_NAMES)
    expect(Object.keys(defaultFlowingContoursControls)).toEqual(CONTROL_NAMES)

    expect(
      normalizeFlowingContoursControls({
        curveDetail: Number.NaN,
        continuity: Number.POSITIVE_INFINITY,
        flowSmoothing: 'smooth',
        minimumStrokeLength: null,
      }),
    ).toEqual(defaultFlowingContoursControls)
    expect(
      normalizeFlowingContoursControls({
        curveDetail: -1,
        continuity: 2,
        flowSmoothing: -2,
        minimumStrokeLength: 2,
      }),
    ).toEqual({
      curveDetail: 0,
      continuity: 1,
      flowSmoothing: 0,
      minimumStrokeLength: 0.25,
    })
    expect(
      normalizeFlowingContoursControls({
        curveDetail: 1,
        continuity: 0,
        flowSmoothing: 1,
        minimumStrokeLength: 0.005,
      }),
    ).toEqual({
      curveDetail: 1,
      continuity: 0,
      flowSmoothing: 1,
      minimumStrokeLength: 0.005,
    })

    for (const name of CONTROL_NAMES) {
      const changed = normalizeFlowingContoursControls({
        ...defaultFlowingContoursControls,
        [name]: flowingContoursControlSchema[name].min,
      })
      for (const other of CONTROL_NAMES) {
        if (other === name) continue
        expect(changed[other]).toBe(defaultFlowingContoursControls[other])
      }
    }
    expect(
      normalizeFlowingContoursControls(BASE_CONTROLS),
    ).toEqual(normalizeFlowingContoursControls(BASE_CONTROLS))
  })

  it('uses Curve detail only to append weaker eligible anchors', () => {
    const strengths = new Map([
      ['4,4', 0.95],
      ['12,4', 0.75],
      ['20,4', 0.5],
      ['4,12', 0.3],
      ['12,12', 0.18],
      ['20,12', 0.08],
    ])
    const source = field(25, 17, (x, y) => ({
      evidence: strengths.get(`${x},${y}`) ?? 0,
    }))
    const inventoryAccounting = createFlowingContoursAccounting()
    const inventory = buildFlowingContoursAnchorInventory(
      source,
      inventoryAccounting,
    )
    const admissions = [0, 0.2, 0.4, 0.6, 0.8, 1].map((curveDetail) =>
      admitFlowingContoursAnchors(
        inventory,
        curveDetail,
        createFlowingContoursAccounting(),
      ),
    )

    expect(admissions[0]!.anchors).toEqual([])
    expect(admissions.at(-1)!.anchors.at(-1)!.strength).toBe('secondary')
    for (let index = 1; index < admissions.length; index += 1) {
      const previous = admissions[index - 1]!.anchors
      const current = admissions[index]!.anchors
      expect(current.slice(0, previous.length)).toEqual(previous)
      expect(admissions[index]!.minimumSelectionScore).toBeLessThanOrEqual(
        admissions[index - 1]!.minimumSelectionScore,
      )
    }
    const lowPipeline = runFlowingContoursPipeline(source, {
      ...BASE_CONTROLS,
      curveDetail: 0.2,
      minimumStrokeLength: 0.005,
    })
    const highPipeline = runFlowingContoursPipeline(source, {
      ...BASE_CONTROLS,
      curveDetail: 1,
      minimumStrokeLength: 0.005,
    })
    const detailOwnedDeltas = [
      'eligibleAnchorCount',
      'processedAnchorCount',
      'directionalTraceCount',
      'searchStepCount',
      'candidateCount',
      'acceptedCandidateCount',
      'endpointReasonCounts',
      'rawTrajectoryCount',
      'rawTrajectoryPointCount',
      'suppressedEvidenceSampleCount',
      'fittedCurveCount',
      'fittedCurvePointCount',
      'primitiveCount',
    ] as const
    expect(
      omitDiagnostics(lowPipeline.diagnostics, detailOwnedDeltas),
    ).toEqual(
      omitDiagnostics(highPipeline.diagnostics, detailOwnedDeltas),
    )
    expect(highPipeline.diagnostics.eligibleAnchorCount).toBeGreaterThan(
      lowPipeline.diagnostics.eligibleAnchorCount,
    )
    expect(highPipeline.acceptedTrajectories.length).toBeGreaterThan(
      lowPipeline.acceptedTrajectories.length,
    )
    expect(
      highPipeline.acceptedTrajectories.slice(
        0,
        lowPipeline.acceptedTrajectories.length,
      ),
    ).toEqual(lowPipeline.acceptedTrajectories)
    expect(
      highPipeline.fittedCurves.slice(0, lowPipeline.fittedCurves.length),
    ).toEqual(lowPipeline.fittedCurves)
    expect(
      highPipeline.acceptedTrajectories.every(
        (raw) =>
          raw.length >=
          0.005 * Math.hypot(source.width, source.height),
      ),
    ).toBe(true)
    expectValidFittedTubes(source, lowPipeline)
    expectValidFittedTubes(source, highPipeline)

    const coherent = field(18, 12, () => ({
      evidence: 1,
      tangent: [1, 0],
      scale: 4,
    }))
    const raw = trajectory(coherent, [
      [2, 5],
      [4, 5.25],
      [6, 5.5],
      [8, 5.75],
      [10, 6],
    ])
    const tube = createFlowingContoursEvidenceTube(coherent, raw)
    const fit = fitFlowingContoursCurve(coherent, raw, 0.7)
    expect(tube).not.toBeNull()
    expect(fit.status).toBe('fitted')
    if (tube === null || fit.status !== 'fitted') return
    expect(
      validateFlowingContoursTubeCurve(coherent, tube, {
        points: fit.curve.points,
        sourceSampleIndices: fit.curve.provenance.sourceSampleIndices,
      }),
    ).not.toBeNull()

    const candidate = SELECTION_FIXTURE.candidate
    for (const curveDetail of [0, 0.25, 0.5, 0.75, 1]) {
      const controls = { ...BASE_CONTROLS, curveDetail }
      expect(
        selectFlowingContoursCandidate(
          candidate,
          {
            analysisWidth: SELECTION_FIXTURE.source.width,
            analysisHeight: SELECTION_FIXTURE.source.height,
            minimumStrokeLength: SELECTION_FIXTURE.threshold,
          },
          createFlowingContoursAccounting(),
          SELECTION_LIMITS,
        ).kind,
      ).toBe('accepted')
      expect(grow(coherent, controls.continuity, controls.flowSmoothing)).toEqual(
        grow(coherent, BASE_CONTROLS.continuity, BASE_CONTROLS.flowSmoothing),
      )
    }
  })

  it('uses Continuity only for bounded weak travel under unchanged hard policy', () => {
    const interrupted = field(14, 9, (x, y) => ({
      evidence: (x >= 5 && x <= 6 ? 0.01 : 1) * gaussian(y - 4),
      tangent: [1, 0],
    }))
    const traces = [0, 0.05, 0.5, 1].map((continuity) =>
      grow(interrupted, continuity, 0.7),
    )
    const gapLengths = traces.map(
      (trace) =>
        trace.spanSupport.find((span) => span.kind === 'bounded-gap')
          ?.length ?? 0,
    )
    expect(gapLengths).toEqual([...gapLengths].sort((a, b) => a - b))
    expect(gapLengths[0]).toBe(0)
    expect(gapLengths.at(-1)).toBe(3)
    const lowPipeline = runFlowingContoursPipeline(interrupted, {
      ...BASE_CONTROLS,
      continuity: 0,
      minimumStrokeLength: 0.005,
    })
    const highPipeline = runFlowingContoursPipeline(interrupted, {
      ...BASE_CONTROLS,
      continuity: 1,
      minimumStrokeLength: 0.005,
    })
    const continuityOwnedDeltas = [
      'searchStepCount',
      'candidateCount',
      'acceptedCandidateCount',
      'endpointReasonCounts',
      'rawTrajectoryCount',
      'rawTrajectoryPointCount',
      'acceptedMaximumUnsupportedSpanLength',
      'acceptedTotalUnsupportedSpanLength',
      'suppressedEvidenceSampleCount',
      'fittedCurveCount',
      'fittedCurvePointCount',
      'primitiveCount',
    ] as const
    expect(
      omitDiagnostics(lowPipeline.diagnostics, continuityOwnedDeltas),
    ).toEqual(
      omitDiagnostics(highPipeline.diagnostics, continuityOwnedDeltas),
    )
    expect(lowPipeline.acceptedTrajectories).toHaveLength(2)
    expect(highPipeline.acceptedTrajectories).toHaveLength(1)
    expect(
      lowPipeline.diagnostics.acceptedTotalUnsupportedSpanLength,
    ).toBe(0)
    expect(
      highPipeline.diagnostics.acceptedTotalUnsupportedSpanLength,
    ).toBeGreaterThan(0)
    expect(
      highPipeline.acceptedTrajectories[0]!.spanSupport.some(
        (span) => span.kind === 'bounded-gap',
      ),
    ).toBe(true)
    for (const result of [lowPipeline, highPipeline]) {
      expect(
        result.acceptedTrajectories.every(
          (raw) =>
            raw.length >=
            0.005 * Math.hypot(interrupted.width, interrupted.height),
        ),
      ).toBe(true)
      expectValidFittedTubes(interrupted, result)
    }

    const beyondHardCap = field(16, 9, (x, y) => ({
      evidence: (x >= 5 && x <= 7 ? 0.01 : 1) * gaussian(y - 4),
      tangent: [1, 0],
    }))
    const capped = grow(beyondHardCap, 1, 0.7)
    expect(capped.spanSupport.some((span) => span.kind === 'bounded-gap')).toBe(
      false,
    )
    expect(capped.samples).toHaveLength(1)

    const inventory = buildFlowingContoursAnchorInventory(
      interrupted,
      createFlowingContoursAccounting(),
    )
    const admitted = admitFlowingContoursAnchors(
      inventory,
      1,
      createFlowingContoursAccounting(),
    )
    for (const continuity of [0, 0.25, 0.5, 0.75, 1]) {
      expect(
        admitFlowingContoursAnchors(
          inventory,
          BASE_CONTROLS.curveDetail,
          createFlowingContoursAccounting(),
        ),
      ).toEqual(admitted)
      expect(
        selectFlowingContoursCandidate(
          SELECTION_FIXTURE.candidate,
          {
            analysisWidth: SELECTION_FIXTURE.source.width,
            analysisHeight: SELECTION_FIXTURE.source.height,
            minimumStrokeLength: SELECTION_FIXTURE.threshold,
          },
          createFlowingContoursAccounting(),
          SELECTION_LIMITS,
        ).kind,
        `Continuity ${continuity} must not alter minimum-length admission`,
      ).toBe('accepted')
    }

    const coherent = field(18, 12, () => ({
      evidence: 1,
      tangent: [1, 0],
      scale: 4,
    }))
    const raw = trajectory(coherent, [
      [2, 5],
      [4, 5.25],
      [6, 5.5],
      [8, 5.75],
      [10, 6],
    ])
    const tube = createFlowingContoursEvidenceTube(coherent, raw)
    const fitted = fitFlowingContoursCurve(coherent, raw, 0.7)
    expect(tube).not.toBeNull()
    expect(fitted.status).toBe('fitted')
    if (tube === null || fitted.status !== 'fitted') return
    for (const _continuity of [0, 0.25, 0.5, 0.75, 1]) {
      expect(
        validateFlowingContoursTubeCurve(coherent, tube, {
          points: fitted.curve.points,
          sourceSampleIndices: fitted.curve.provenance.sourceSampleIndices,
        }),
      ).not.toBeNull()
    }
  })

  it('uses Flow smoothing for curvature preference and monotonic fairing only', () => {
    const objective = {
      accumulatedEvidence: 0.8,
      usefulLength: 0.8,
      directionalCoherence: 0.9,
      curvatureChange: 0.4,
      unsupportedTravel: 0.2,
      ambiguity: 0.1,
      representedOverlap: 0.1,
    }
    const lowScore = scoreFlowingContoursCandidate(objective, 0)
    const highScore = scoreFlowingContoursCandidate(objective, 1)
    expect(highScore.curvaturePenalty).toBeGreaterThan(
      lowScore.curvaturePenalty,
    )
    expect({
      ...highScore,
      curvaturePenalty: lowScore.curvaturePenalty,
      total: lowScore.total,
    }).toEqual(lowScore)

    const roughLow = scoreFlowingContoursCandidate(
      {
        ...objective,
        accumulatedEvidence: 1,
        curvatureChange: 0.4,
      },
      0,
    )
    const roughHigh = scoreFlowingContoursCandidate(
      {
        ...objective,
        accumulatedEvidence: 1,
        curvatureChange: 0.4,
      },
      1,
    )
    const smoothLow = scoreFlowingContoursCandidate(
      {
        ...objective,
        accumulatedEvidence: 0.8,
        curvatureChange: 0,
      },
      0,
    )
    const smoothHigh = scoreFlowingContoursCandidate(
      {
        ...objective,
        accumulatedEvidence: 0.8,
        curvatureChange: 0,
      },
      1,
    )
    expect(
      compareFlowingContoursCandidateScores(roughLow, smoothLow),
    ).toBeLessThan(0)
    expect(
      compareFlowingContoursCandidateScores(smoothHigh, roughHigh),
    ).toBeLessThan(0)

    const source = field(24, 40, () => ({
      evidence: 1,
      tangent: [1, 0],
      scale: 1,
    }))
    const points: Readonly<Point>[] = [[3, 20]]
    let seed = 1234567
    for (let index = 0; index < 20; index += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const random = seed / 2 ** 32
      const previous = points.at(-1)!
      points.push([
        previous[0] + 0.75,
        previous[1] + (random * 2 - 1) * 0.5,
      ])
    }
    const raw = trajectory(source, points)
    const outputs = [0, 0.25, 0.5, 0.75, 1].map((flowSmoothing) => {
      const fitted = fitFlowingContoursCurve(
        source,
        raw,
        flowSmoothing,
      )
      expect(fitted.status).toBe('fitted')
      if (fitted.status !== 'fitted') throw new Error(fitted.status)
      return fitted.curve.points
    })
    let changed = false
    for (let index = 1; index < outputs.length; index += 1) {
      const previous = turnMetrics(outputs[index - 1]!)
      const current = turnMetrics(outputs[index]!)
      expect(current.energy).toBeLessThanOrEqual(previous.energy + 1e-10)
      expect(current.maximum).toBeLessThanOrEqual(previous.maximum + 1e-10)
      expect(current.moderate).toBeLessThanOrEqual(previous.moderate)
      expect(current.abrupt).toBeLessThanOrEqual(previous.abrupt)
      changed ||= JSON.stringify(outputs[index]) !== JSON.stringify(outputs[index - 1])
    }
    expect(changed).toBe(true)

    const flowing = flowingCurveField()
    const lowPipeline = runFlowingContoursPipeline(flowing, {
      ...BASE_CONTROLS,
      curveDetail: 1,
      continuity: 0.5,
      flowSmoothing: 0,
    })
    const highPipeline = runFlowingContoursPipeline(flowing, {
      ...BASE_CONTROLS,
      curveDetail: 1,
      continuity: 0.5,
      flowSmoothing: 1,
    })
    expect(
      lowPipeline.acceptedTrajectories.map(
        smoothingInvariantTrajectory,
      ),
    ).toEqual(
      highPipeline.acceptedTrajectories.map(
        smoothingInvariantTrajectory,
      ),
    )
    expect(
      highPipeline.acceptedTrajectories[0]!.score.curvaturePenalty,
    ).toBeGreaterThan(
      lowPipeline.acceptedTrajectories[0]!.score.curvaturePenalty,
    )
    expect(
      omitDiagnostics(lowPipeline.diagnostics, [
        'fittedCurvePointCount',
      ]),
    ).toEqual(
      omitDiagnostics(highPipeline.diagnostics, [
        'fittedCurvePointCount',
      ]),
    )
    expect(lowPipeline.fittedCurves).toHaveLength(1)
    expect(highPipeline.fittedCurves).toHaveLength(1)
    expect(highPipeline.fittedCurves[0]!.points).not.toEqual(
      lowPipeline.fittedCurves[0]!.points,
    )
    const lowPipelineTurns = turnMetrics(
      lowPipeline.fittedCurves[0]!.points,
    )
    const highPipelineTurns = turnMetrics(
      highPipeline.fittedCurves[0]!.points,
    )
    expect(highPipelineTurns.energy).toBeLessThanOrEqual(
      lowPipelineTurns.energy + 1e-10,
    )
    expect(highPipelineTurns.maximum).toBeLessThanOrEqual(
      lowPipelineTurns.maximum + 1e-10,
    )
    expect(highPipelineTurns.moderate).toBeLessThanOrEqual(
      lowPipelineTurns.moderate,
    )
    expect(highPipelineTurns.abrupt).toBeLessThanOrEqual(
      lowPipelineTurns.abrupt,
    )
    expect(
      highPipeline.fittedCurves[0]!.points.length,
    ).toBeLessThan(
      lowPipeline.fittedCurves[0]!.points.length,
    )
    expectValidFittedTubes(flowing, lowPipeline)
    expectValidFittedTubes(flowing, highPipeline)

    const interrupted = field(14, 9, (x, y) => ({
      evidence: (x >= 5 && x <= 6 ? 0.01 : 1) * gaussian(y - 4),
      tangent: [1, 0],
    }))
    const lowGrowth = grow(interrupted, 1, 0)
    const highGrowth = grow(interrupted, 1, 1)
    expect(
      lowGrowth.spanSupport.filter((span) => span.kind === 'bounded-gap'),
    ).toEqual(
      highGrowth.spanSupport.filter((span) => span.kind === 'bounded-gap'),
    )
    expect(
      selectFlowingContoursCandidate(
        SELECTION_FIXTURE.candidate,
        {
          analysisWidth: SELECTION_FIXTURE.source.width,
          analysisHeight: SELECTION_FIXTURE.source.height,
          minimumStrokeLength: SELECTION_FIXTURE.threshold,
        },
        createFlowingContoursAccounting(),
        SELECTION_LIMITS,
      ).kind,
    ).toBe('accepted')
  })

  it('uses Minimum stroke length as a strict analysis-diagonal admission fraction', () => {
    const { candidate, source, diagonal, threshold } = SELECTION_FIXTURE
    expect(candidate.length).toBeCloseTo(threshold * diagonal, 12)
    expect(threshold).toBeGreaterThan(0.005)
    expect(threshold).toBeLessThan(0.25)

    const results = [
      0.005,
      threshold / 2,
      threshold,
      threshold + Number.EPSILON,
      0.25,
    ].map(
      (minimumStrokeLength) =>
        selectFlowingContoursCandidate(
          candidate,
          {
            analysisWidth: source.width,
            analysisHeight: source.height,
            minimumStrokeLength,
          },
          createFlowingContoursAccounting(),
          SELECTION_LIMITS,
        ),
    )
    expect(results.map((result) => result.kind)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'rejected',
      'rejected',
    ])
    expect(results[3]).toEqual({
      kind: 'rejected',
      reason: 'below-minimum-length',
    })
    const oneCandidateLimits = createFlowingContoursTestLimits({
      'candidate-count': 1,
    })!
    const exactPipeline = runFlowingContoursPipeline(
      source,
      {
        ...BASE_CONTROLS,
        curveDetail: 1,
        minimumStrokeLength: threshold,
      },
      oneCandidateLimits,
    )
    const abovePipeline = runFlowingContoursPipeline(
      source,
      {
        ...BASE_CONTROLS,
        curveDetail: 1,
        minimumStrokeLength: threshold + Number.EPSILON,
      },
      oneCandidateLimits,
    )
    expect(exactPipeline.acceptedTrajectories).toHaveLength(1)
    expect(exactPipeline.fittedCurves).toHaveLength(1)
    expect(abovePipeline.acceptedTrajectories).toEqual([])
    expect(abovePipeline.fittedCurves).toEqual([])
    expect({
      analysisWidth: exactPipeline.diagnostics.analysisWidth,
      analysisHeight: exactPipeline.diagnostics.analysisHeight,
      analysisSampleCount: exactPipeline.diagnostics.analysisSampleCount,
      contourEvidenceSampleCount:
        exactPipeline.diagnostics.contourEvidenceSampleCount,
      correctedRidgeSampleCount:
        exactPipeline.diagnostics.correctedRidgeSampleCount,
      eligibleAnchorCount: exactPipeline.diagnostics.eligibleAnchorCount,
      directionalTraceCount:
        exactPipeline.diagnostics.directionalTraceCount,
      searchStepCount: exactPipeline.diagnostics.searchStepCount,
      candidateCount: exactPipeline.diagnostics.candidateCount,
    }).toEqual({
      analysisWidth: abovePipeline.diagnostics.analysisWidth,
      analysisHeight: abovePipeline.diagnostics.analysisHeight,
      analysisSampleCount: abovePipeline.diagnostics.analysisSampleCount,
      contourEvidenceSampleCount:
        abovePipeline.diagnostics.contourEvidenceSampleCount,
      correctedRidgeSampleCount:
        abovePipeline.diagnostics.correctedRidgeSampleCount,
      eligibleAnchorCount: abovePipeline.diagnostics.eligibleAnchorCount,
      directionalTraceCount:
        abovePipeline.diagnostics.directionalTraceCount,
      searchStepCount: abovePipeline.diagnostics.searchStepCount,
      candidateCount: abovePipeline.diagnostics.candidateCount,
    })
    expectValidFittedTubes(source, exactPipeline)

    const pixels = raster(80, 40, (x, y) =>
      x < 35 + y * 0.2
        ? [20, 20, 20, 255]
        : [235, 235, 235, 255],
    )
    const controls = {
      ...BASE_CONTROLS,
      minimumStrokeLength: 0.2,
    }
    const frames = [
      { width: 1000, height: 1000 },
      { width: 200, height: 500 },
      { width: 500, height: 200 },
    ]
    const generated = frames.map((frame) =>
      generateFlowingContours({
        pixels,
        frame,
        controls,
      }),
    )
    expect(generated[0]!.diagnostics.primitiveCount).toBeGreaterThan(0)
    expect(generated[1]!.diagnostics).toEqual(generated[0]!.diagnostics)
    expect(generated[2]!.diagnostics).toEqual(generated[0]!.diagnostics)

    const accounting = createFlowingContoursAccounting()
    const prepared = prepareFlowingContoursRaster(pixels, accounting)
    const imageField = buildFlowingContoursField(prepared, accounting)
    const baselineControls = normalizeFlowingContoursControls(controls)
    const baselinePipeline = runFlowingContoursPipeline(
      imageField,
      baselineControls,
    )
    const baselineGenerator = generateFlowingContours({
      pixels,
      frame: frames[0]!,
      controls: baselineControls,
    })
    const irrelevantSettings = [
      ['pageWidth', Number.NEGATIVE_INFINITY],
      ['pageWidth', Number.MAX_VALUE],
      ['toolWidth', Number.NaN],
      ['toolWidth', -Number.MAX_VALUE],
      ['outputScale', Number.POSITIVE_INFINITY],
      ['outputScale', Number.MAX_VALUE],
    ] as const
    for (const [name, value] of irrelevantSettings) {
      const withOneIrrelevantSetting = {
        ...controls,
        [name]: value,
      }
      expect(
        normalizeFlowingContoursControls(withOneIrrelevantSetting),
      ).toEqual(baselineControls)
      expect(
        runFlowingContoursPipeline(
          imageField,
          withOneIrrelevantSetting,
        ),
      ).toEqual(baselinePipeline)
      expect(
        generateFlowingContours({
          pixels,
          frame: frames[0]!,
          controls: withOneIrrelevantSetting,
        }),
      ).toEqual(baselineGenerator)
    }
  })

  it('keeps coherent curved output long, oblique, and free of grid-stump alternation', () => {
    const source = flowingCurveField()
    const controls = {
      curveDetail: 1,
      continuity: 0.5,
      flowSmoothing: 1,
      minimumStrokeLength: 0.1,
    }
    const first = runFlowingContoursPipeline(source, controls)
    const second = runFlowingContoursPipeline(source, controls)
    const diagonal = Math.hypot(source.width, source.height)

    expect(first).toEqual(second)
    expect(first.acceptedTrajectories).toHaveLength(1)
    expect(first.fittedCurves).toHaveLength(1)
    expect(
      first.acceptedTrajectories.every(
        (raw) =>
          raw.length >= controls.minimumStrokeLength * diagonal &&
          raw.length > source.width * 0.7,
      ),
    ).toBe(true)
    for (const curve of first.fittedCurves) {
      const metrics = turnMetrics(curve.points)
      expect(pathLength(curve.points)).toBeGreaterThan(source.width * 0.7)
      expect(
        segmentObliqueness(curve.points).every((ratio) => ratio > 0.02),
      ).toBe(true)
      expect(metrics.moderate).toBe(0)
      expect(metrics.abrupt).toBe(0)
      expect(metrics.maximum).toBeLessThan((25 * Math.PI) / 180)
      expect(
        Number.isFinite(
          measureFlowingContoursCurvatureChange(curve.points),
        ),
      ).toBe(true)
      expect(axisAlternationCount(curve.points)).toBeLessThanOrEqual(1)
    }
    expectValidFittedTubes(source, first)
  })

  it('has shape metrics that reject known stump and grid counterexamples', () => {
    const stump = [
      [0, 0],
      [1, 0],
    ] as const
    const grid = [
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
      [2, 2],
      [3, 2],
      [3, 3],
      [4, 3],
    ] as const

    expect(pathLength(stump)).toBeLessThan(48 * 0.7)
    expect(segmentObliqueness(stump)).toEqual([0])
    expect(segmentObliqueness(grid).every((ratio) => ratio === 0)).toBe(
      true,
    )
    expect(axisAlternationCount(grid)).toBe(grid.length - 2)
    expect(turnMetrics(grid).abrupt).toBeGreaterThan(0)
  })
})
