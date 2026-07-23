import { describe, expect, it } from 'vitest'

import { createFlowingContoursAccounting } from '../sketches/flowing-contours/accounting'
import {
  admitFlowingContoursAnchors,
  buildFlowingContoursAnchorInventory,
} from '../sketches/flowing-contours/anchors'
import {
  createFlowingContoursTestLimits,
  type FlowingContoursLimits,
} from '../sketches/flowing-contours/limits'
import { runFlowingContoursPipeline } from '../sketches/flowing-contours/pipeline'
import { searchFlowingContoursCandidate } from '../sketches/flowing-contours/search'
import { selectFlowingContoursCandidate } from '../sketches/flowing-contours/selection'
import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
  type FlowingContoursField,
  type FlowingContoursLimitName,
} from '../sketches/flowing-contours/types'

function field(
  width = 32,
  height = 15,
  ridgeRows: readonly number[] = [7],
): Readonly<FlowingContoursField> {
  const count = width * height
  const evidence = Array.from({ length: count }, (_value, index) => {
    const y = Math.floor(index / width)
    const distance = Math.min(
      ...ridgeRows.map((ridge) => Math.abs(y - ridge)),
    )
    return Math.exp(-(distance * distance) / (2 * 0.55 * 0.55))
  })
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze(new Array<number>(count).fill(0.5)),
    alpha: Object.freeze(new Array<number>(count).fill(1)),
    positiveSupport: Object.freeze(new Array<boolean>(count).fill(true)),
    contourEvidence: Object.freeze(evidence),
    tangentX: Object.freeze(new Array<number>(count).fill(1)),
    tangentY: Object.freeze(new Array<number>(count).fill(0)),
    tangentCoherence: Object.freeze(new Array<number>(count).fill(1)),
    ambiguity: Object.freeze(new Array<number>(count).fill(0)),
    ridgeScale: Object.freeze(new Array<number>(count).fill(1)),
  })
}

function centerlineField(
  width: number,
  height: number,
  centerline: (x: number) => number,
  slope: (x: number) => number,
): Readonly<FlowingContoursField> {
  const count = width * height
  const evidence = new Array<number>(count)
  const tangentX = new Array<number>(count)
  const tangentY = new Array<number>(count)
  for (let index = 0; index < count; index += 1) {
    const x = index % width
    const y = Math.floor(index / width)
    const derivative = slope(x)
    const length = Math.hypot(1, derivative)
    tangentX[index] = 1 / length
    tangentY[index] = derivative / length
    const distance = Math.abs(y - centerline(x)) / length
    evidence[index] = Math.exp(
      -(distance * distance) / (2 * 0.6 * 0.6),
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
    contourEvidence: Object.freeze(evidence),
    tangentX: Object.freeze(tangentX),
    tangentY: Object.freeze(tangentY),
    tangentCoherence: Object.freeze(new Array<number>(count).fill(1)),
    ambiguity: Object.freeze(new Array<number>(count).fill(0)),
    ridgeScale: Object.freeze(new Array<number>(count).fill(1)),
  })
}

function controls(overrides: Record<string, unknown> = {}) {
  return {
    curveDetail: 1,
    continuity: 0.5,
    flowSmoothing: 0.8,
    minimumStrokeLength: 0.02,
    ...overrides,
  }
}

function shortRidgeField(): Readonly<FlowingContoursField> {
  const source = field()
  const contourEvidence = source.contourEvidence.map((value, index) => {
    const x = index % source.width
    return x >= 14 && x <= 18 ? value : 0
  })
  return Object.freeze({
    ...source,
    contourEvidence: Object.freeze(contourEvidence),
  })
}

function limits(
  overrides: Partial<Record<FlowingContoursLimitName, number>>,
): Readonly<FlowingContoursLimits> {
  const result = createFlowingContoursTestLimits(overrides)
  if (result === null) throw new Error('fixture limits must be valid')
  return result
}

function endpointTotal(
  source: Readonly<Record<string, number>>,
): number {
  return FLOWING_CONTOURS_ENDPOINT_REASONS.reduce(
    (sum, reason) => sum + source[reason]!,
    0,
  )
}

describe('Flowing Contours pipeline', () => {
  it('composes stable whole trajectories, fitting, suppression, and exact diagnostics', () => {
    const source = field()
    const first = runFlowingContoursPipeline(source, controls())
    const second = runFlowingContoursPipeline(source, controls())

    expect(first).toEqual(second)
    expect(first.diagnostics.termination).toBe('complete')
    expect(first.acceptedTrajectories.length).toBeGreaterThan(0)
    expect(first.fittedCurves).toHaveLength(
      first.acceptedTrajectories.length,
    )
    expect(first.diagnostics.suppressedAnchorCount).toBeGreaterThan(0)
    expect(first.diagnostics.suppressedEvidenceSampleCount).toBeGreaterThan(0)
    expect(first.diagnostics.analysisWidth).toBe(source.width)
    expect(first.diagnostics.analysisHeight).toBe(source.height)
    expect(first.diagnostics.analysisSampleCount).toBe(
      source.width * source.height,
    )
    expect(first.diagnostics.directionalTraceCount).toBe(
      first.diagnostics.candidateCount * 2,
    )
    expect(first.diagnostics.rawTrajectoryCount).toBe(
      first.acceptedTrajectories.length,
    )
    expect(first.diagnostics.fittedCurveCount).toBe(
      first.fittedCurves.length,
    )
    expect(first.diagnostics.primitiveCount).toBe(first.fittedCurves.length)
    expect(endpointTotal(first.diagnostics.endpointReasonCounts)).toBe(
      first.acceptedTrajectories.length * 2,
    )
    const maximumUnsupported = Math.max(
      0,
      ...first.acceptedTrajectories.map(
        (trajectory) => trajectory.maximumUnsupportedSpanLength,
      ),
    )
    const totalUnsupported = first.acceptedTrajectories.reduce(
      (sum, trajectory) =>
        sum + trajectory.totalUnsupportedSpanLength,
      0,
    )
    expect(first.diagnostics.acceptedMaximumUnsupportedSpanLength).toBe(
      maximumUnsupported,
    )
    expect(first.diagnostics.acceptedTotalUnsupportedSpanLength).toBe(
      totalUnsupported,
    )
    expect(
      first.acceptedTrajectories.every(
        (trajectory) =>
          trajectory.length >=
          0.02 * Math.hypot(source.width, source.height),
      ),
    ).toBe(true)
    expect(
      first.fittedCurves.every((curve) => {
        let length = 0
        for (let index = 1; index < curve.points.length; index += 1) {
          length += Math.hypot(
            curve.points[index]![0] - curve.points[index - 1]![0],
            curve.points[index]![1] - curve.points[index - 1]![1],
          )
        }
        return length >= 0.02 * Math.hypot(source.width, source.height)
      }),
    ).toBe(true)
    expect(
      first.fittedCurves.every(
        (curve, index) =>
          curve.provenance.sourceTrajectoryId ===
          first.acceptedTrajectories[index]!.id,
      ),
    ).toBe(true)
  })

  it('keeps separate parallel ridges while suppressing repeat anchors on each ridge', () => {
    const source = field(36, 17, [5, 11])
    const output = runFlowingContoursPipeline(source, controls())
    const meanRows = output.acceptedTrajectories.map(
      (trajectory) =>
        trajectory.samples.reduce((sum, sample) => sum + sample.point[1], 0) /
        trajectory.samples.length,
    )

    expect(output.diagnostics.termination).toBe('complete')
    expect(meanRows.some((row) => Math.abs(row - 5) < 0.6)).toBe(true)
    expect(meanRows.some((row) => Math.abs(row - 11) < 0.6)).toBe(true)
    expect(output.diagnostics.suppressedAnchorCount).toBeGreaterThan(0)
  })

  it('retains long subpixel diagonal flow instead of lattice stumps', () => {
    const diagonal = centerlineField(
      21,
      21,
      (x) => x,
      () => 1,
    )

    for (const [name, source] of [['diagonal', diagonal]] as const) {
      const output = runFlowingContoursPipeline(
        source,
        controls({
          continuity: 0,
          minimumStrokeLength: 0.1,
        }),
      )
      expect(
        output.acceptedTrajectories.length,
        `${name}: ${JSON.stringify(output.diagnostics)}`,
      ).toBeGreaterThan(0)
      expect(
        output.acceptedTrajectories.every(
          (trajectory) =>
            trajectory.length >= 0.1 * Math.hypot(source.width, source.height),
        ),
      ).toBe(true)
      expect(
        output.fittedCurves.some((curve) =>
          curve.points.slice(1).some((point, index) => {
            const previous = curve.points[index]!
            return (
              Math.abs(point[0] - previous[0]) > 1e-3 &&
              Math.abs(point[1] - previous[1]) > 1e-3
            )
          }),
        ),
      ).toBe(true)
    }
  })

  it('accepts an authentic open curved path with reversed bounded-gap provenance', () => {
    const source = centerlineField(
      40,
      20,
      (x) => 10 + 2.5 * Math.sin(x / 7),
      (x) => (2.5 / 7) * Math.cos(x / 7),
    )
    const accounting = createFlowingContoursAccounting()
    const inventory = buildFlowingContoursAnchorInventory(source, accounting)
    const admission = admitFlowingContoursAnchors(inventory, 1, accounting)
    const anchor = admission.anchors[0]
    if (anchor === undefined) throw new Error('expected a curved-ridge anchor')
    const candidate = searchFlowingContoursCandidate(source, anchor, {
      continuity: 0.5,
      flowSmoothing: 0.8,
    })

    expect(candidate).not.toBeNull()
    expect(candidate!.length).toBeGreaterThan(30)
    expect(
      candidate!.spanSupport.some((span) => span.kind === 'bounded-gap'),
    ).toBe(true)
    const selection = selectFlowingContoursCandidate(
      candidate!,
      {
        analysisWidth: source.width,
        analysisHeight: source.height,
        minimumStrokeLength: 0.1,
      },
      accounting,
    )
    expect(selection.kind).toBe('accepted')
    if (selection.kind !== 'accepted') {
      throw new Error(`expected accepted selection, got ${selection.reason}`)
    }
    expect(selection.trajectory.samples).toHaveLength(candidate!.samples.length)
    expect(
      selection.trajectory.spanSupport.filter(
        (span) => span.kind === 'bounded-gap',
      ),
    ).toEqual(
      candidate!.spanSupport.filter((span) => span.kind === 'bounded-gap'),
    )

    const forgedSupport = candidate!.spanSupport.map((span) =>
      span.kind === 'bounded-gap'
        ? {
            ...span,
            directionalAlignment: span.directionalAlignment - 0.01,
          }
        : span,
    )
    expect(
      selectFlowingContoursCandidate(
        { ...candidate!, spanSupport: forgedSupport },
        {
          analysisWidth: source.width,
          analysisHeight: source.height,
          minimumStrokeLength: 0.1,
        },
        createFlowingContoursAccounting(),
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid-input' })
  })

  it('returns complete empty output for a flat valid field', () => {
    const source = field(20, 11, [100])
    const output = runFlowingContoursPipeline(source, controls())

    expect(output.acceptedTrajectories).toEqual([])
    expect(output.fittedCurves).toEqual([])
    expect(output.diagnostics.termination).toBe('complete')
    expect(output.diagnostics.limitedBy).toBeNull()
    expect(output.diagnostics.eligibleAnchorCount).toBe(0)
  })

  it('does not publish occupancy for a whole candidate rejected by minimum length', () => {
    const output = runFlowingContoursPipeline(
      shortRidgeField(),
      controls({ minimumStrokeLength: 0.25 }),
    )

    expect(output.diagnostics.candidateCount).toBeGreaterThan(0)
    expect(output.diagnostics.acceptedCandidateCount).toBe(0)
    expect(output.diagnostics.rejectedCandidateCount).toBe(
      output.diagnostics.candidateCount,
    )
    expect(output.acceptedTrajectories).toEqual([])
    expect(output.fittedCurves).toEqual([])
    expect(output.diagnostics.suppressedEvidenceSampleCount).toBe(0)
    expect(output.diagnostics.suppressedAnchorCount).toBe(0)
    expect(endpointTotal(output.diagnostics.endpointReasonCounts)).toBe(0)
  })

  it.each([
    ['analysis-dimension', { 'analysis-dimension': 31 }],
    ['analysis-sample-count', { 'analysis-sample-count': 479 }],
    ['scale-plane-count', { 'scale-plane-count': 0 }],
    ['anchor-count', { 'anchor-count': 0 }],
    ['normal-search-sample-count', { 'normal-search-sample-count': 2 }],
    ['search-breadth', { 'search-breadth': 0 }],
    ['search-step-count', { 'search-step-count': 0 }],
    ['candidate-count', { 'candidate-count': 0 }],
    ['accepted-curve-count', { 'accepted-curve-count': 0 }],
    ['raw-trajectory-point-count', { 'raw-trajectory-point-count': 1 }],
    ['fitted-curve-point-count', { 'fitted-curve-point-count': 1 }],
    ['primitive-count', { 'primitive-count': 0 }],
  ] as const)(
    'classifies a lowered %s cap without partial raw/fitted output',
    (limitedBy, override) => {
      const output = runFlowingContoursPipeline(
        field(),
        controls(),
        limits(override),
      )

      expect(output.diagnostics.termination).toBe('limit-reached')
      expect(output.diagnostics.limitedBy).toBe(limitedBy)
      expect(output.fittedCurves).toHaveLength(
        output.acceptedTrajectories.length,
      )
      expect(output.diagnostics.fittedCurveCount).toBe(
        output.fittedCurves.length,
      )
      expect(output.diagnostics.rawTrajectoryCount).toBe(
        output.acceptedTrajectories.length,
      )
    },
  )

  it('enforces zero weak-travel caps without preventing direct long flow', () => {
    const output = runFlowingContoursPipeline(
      field(),
      controls({ continuity: 1 }),
      limits({
        'weak-span-step-count': 0,
        'weak-span-distance': 0,
      }),
    )

    expect(output.acceptedTrajectories.length).toBeGreaterThan(0)
    expect(
      output.acceptedTrajectories.every(
        (trajectory) =>
          trajectory.maximumUnsupportedSpanLength === 0 &&
          trajectory.totalUnsupportedSpanLength === 0,
      ),
    ).toBe(true)
  })

  it('fails closed on malformed fields, limits, and hostile controls', () => {
    const unfrozen = { ...field() }
    const hostileControls = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile control')
        },
      },
    )
    const partialLimits = Object.freeze({
      'analysis-dimension': 2,
    }) as unknown as FlowingContoursLimits

    for (const output of [
      runFlowingContoursPipeline(
        unfrozen as FlowingContoursField,
        controls(),
      ),
      runFlowingContoursPipeline(field(), hostileControls),
      runFlowingContoursPipeline(field(), controls(), partialLimits),
    ]) {
      expect(output.acceptedTrajectories).toEqual([])
      expect(output.fittedCurves).toEqual([])
      expect(output.diagnostics.termination).toBe('invalid-input')
      expect(output.diagnostics.analysisSampleCount).toBe(0)
      expect(output.diagnostics.candidateCount).toBe(0)
    }
  })

  it('returns deeply frozen detached output', () => {
    const output = runFlowingContoursPipeline(field(), controls())

    expect(Object.isFrozen(output)).toBe(true)
    expect(Object.isFrozen(output.acceptedTrajectories)).toBe(true)
    expect(Object.isFrozen(output.fittedCurves)).toBe(true)
    expect(Object.isFrozen(output.diagnostics)).toBe(true)
    expect(Object.isFrozen(output.diagnostics.endpointReasonCounts)).toBe(true)
    for (const trajectory of output.acceptedTrajectories) {
      expect(Object.isFrozen(trajectory)).toBe(true)
      expect(Object.isFrozen(trajectory.samples)).toBe(true)
      expect(Object.isFrozen(trajectory.spanSupport)).toBe(true)
    }
    for (const curve of output.fittedCurves) {
      expect(Object.isFrozen(curve)).toBe(true)
      expect(Object.isFrozen(curve.points)).toBe(true)
      expect(Object.isFrozen(curve.provenance)).toBe(true)
    }
  })
})
