import { describe, expect, it } from 'vitest'

import { sampleFlowingContoursField } from '../sketches/flowing-contours/field'
import {
  growFlowingContoursDirection,
  measureFlowingContoursCurvatureChange,
  type FlowingContoursDirectionalGrowthOptions,
} from '../sketches/flowing-contours/growth'
import { createFlowingContoursTestLimits } from '../sketches/flowing-contours/limits'
import type {
  CorrectedFlowingRidgeSample,
  FlowingContoursField,
} from '../sketches/flowing-contours/types'
import type { Point } from '../types'

interface FieldValue {
  readonly evidence: number
  readonly tangent: Readonly<Point>
  readonly coherence?: number
  readonly ambiguity?: number
  readonly alpha?: number
}

function field(
  width: number,
  height: number,
  valueAt: (x: number, y: number) => FieldValue,
): FlowingContoursField {
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
      const sampleAlpha = value.alpha ?? 1
      luminance.push(0.5)
      alpha.push(sampleAlpha)
      positiveSupport.push(sampleAlpha > 0)
      contourEvidence.push(value.evidence)
      tangentX.push(value.tangent[0])
      tangentY.push(value.tangent[1])
      tangentCoherence.push(value.coherence ?? 1)
      ambiguity.push(value.ambiguity ?? 0)
      ridgeScale.push(1)
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

function at(
  source: Readonly<FlowingContoursField>,
  point: Readonly<Point>,
): Readonly<CorrectedFlowingRidgeSample> {
  const sample = sampleFlowingContoursField(source, point)
  if (sample === null) throw new Error(`Expected sample at ${point}`)
  return sample
}

const OPTIONS = Object.freeze({
  continuity: 0.45,
  flowSmoothing: 0.7,
  ridgeStepOptions: Object.freeze({ stepLength: 1 }),
}) satisfies FlowingContoursDirectionalGrowthOptions

function grow(
  source: Readonly<FlowingContoursField>,
  start: Readonly<Point>,
  options: Readonly<FlowingContoursDirectionalGrowthOptions> = OPTIONS,
  limits = createFlowingContoursTestLimits({
    'search-step-count': 64,
  })!,
) {
  return growFlowingContoursDirection(
    source,
    at(source, start),
    [1, 0],
    'forward',
    options,
    limits,
  )
}

describe('Flowing Contours directional growth', () => {
  it('grows a continuous straight ridge to its exact source endpoint', () => {
    const straight = field(13, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const trace = grow(straight, [2, 4])

    expect(trace.endpointReason).toBe('source-boundary')
    expect(trace.samples.length).toBeGreaterThan(8)
    expect(trace.samples[0]!.point).toEqual([2, 4])
    expect(trace.samples.filter((sample) => sample.point[0] === 2)).toHaveLength(
      1,
    )
    expect(trace.samples.every((sample) => Math.abs(sample.point[1] - 4) < 0.05))
      .toBe(true)
    expect(trace.spanSupport).toHaveLength(1)
    expect(trace.spanSupport[0]).toMatchObject({
      kind: 'direct-evidence',
      startSampleIndex: 0,
      endSampleIndex: trace.samples.length - 1,
    })
  })

  it('follows a smooth curve without quantizing it into lattice turns', () => {
    const center = [10, 10] as const
    const radius = 6
    const arc = field(21, 21, (x, y) => {
      const dx = x - center[0]
      const dy = y - center[1]
      const radial = Math.hypot(dx, dy)
      return {
        evidence: gaussian(radial - radius, 0.7),
        tangent:
          radial === 0
            ? ([1, 0] as const)
            : ([-dy / radial, dx / radial] as const),
      }
    })
    const trace = growFlowingContoursDirection(
      arc,
      at(arc, [16, 10]),
      [0, 1],
      'forward',
      OPTIONS,
      createFlowingContoursTestLimits({ 'search-step-count': 10 })!,
    )

    expect(trace.samples).toHaveLength(11)
    expect(trace.endpointReason).toBe('safety-limit')
    expect(
      trace.samples.some(
        (sample) =>
          Math.abs(sample.tangent[0]) > 0.15 &&
          Math.abs(sample.tangent[1]) > 0.15,
      ),
    ).toBe(true)
    for (const sample of trace.samples) {
      expect(
        Math.abs(
          Math.hypot(
            sample.point[0] - center[0],
            sample.point[1] - center[1],
          ) - radius,
        ),
      ).toBeLessThan(0.45)
    }
  })

  it('commits a short supported weak gap only after far-side evidence', () => {
    const interrupted = field(12, 9, (x, y) => ({
      evidence: (x === 5 ? 0.01 : 1) * gaussian(y - 4),
      tangent: [1, 0],
    }))
    const trace = grow(interrupted, [3, 4], {
      ...OPTIONS,
      continuity: 0.2,
    })
    const gap = trace.spanSupport.find((span) => span.kind === 'bounded-gap')

    expect(trace.samples.some((sample) => sample.point[0] === 5)).toBe(true)
    expect(trace.samples.some((sample) => sample.point[0] === 6)).toBe(true)
    expect(gap).toMatchObject({
      kind: 'bounded-gap',
      startSampleIndex: 1,
      endSampleIndex: 3,
      length: 2,
      entryEvidence: 1,
      exitEvidence: 1,
      directionalAlignment: 1,
    })
    expect(Object.isFrozen(gap)).toBe(true)
  })

  it('rolls back a gap that exceeds the Continuity allowance', () => {
    const longGap = field(14, 9, (x, y) => ({
      evidence: (x >= 5 && x <= 7 ? 0.01 : 1) * gaussian(y - 4),
      tangent: [1, 0],
    }))
    const trace = grow(longGap, [3, 4], {
      ...OPTIONS,
      continuity: 0.1,
    })

    expect(trace.endpointReason).toBe('evidence-exhausted')
    expect(trace.samples.map((sample) => sample.point[0])).toEqual([3, 4])
    expect(trace.spanSupport).toHaveLength(1)
    expect(trace.spanSupport.some((span) => span.kind === 'bounded-gap')).toBe(
      false,
    )
    expect(trace.searchStepCount).toBe(3)
  })

  it('never commits one-sided weak samples when evidence is not reacquired', () => {
    const oneSided = field(9, 9, (x, y) => ({
      evidence: (x < 5 ? 1 : 0.01) * gaussian(y - 4),
      tangent: [1, 0],
    }))
    const trace = grow(oneSided, [3, 4], {
      ...OPTIONS,
      continuity: 1,
    })

    expect(trace.endpointReason).toBe('source-boundary')
    expect(trace.samples.map((sample) => sample.point[0])).toEqual([3, 4])
    expect(trace.spanSupport.some((span) => span.kind === 'bounded-gap')).toBe(
      false,
    )
    expect(trace.searchStepCount).toBeGreaterThan(trace.samples.length)
  })

  it('maps transparent and unresolved-orientation stops exactly and rolls back', () => {
    const transparent = field(10, 9, (x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
      alpha: x === 6 ? 0 : 1,
    }))
    const unresolved = field(10, 9, (x, y) => ({
      evidence: (x === 5 ? 0.01 : 1) * gaussian(y - 4),
      tangent: [1, 0],
      coherence: x === 6 ? 0 : 1,
      ambiguity: x === 6 ? 1 : 0,
    }))

    const transparentTrace = grow(transparent, [4, 4])
    const unresolvedTrace = grow(unresolved, [4, 4], {
      ...OPTIONS,
      continuity: 0.5,
    })

    expect(transparentTrace.endpointReason).toBe('alpha-boundary')
    expect(transparentTrace.samples.map((sample) => sample.point[0])).toEqual([
      4,
      5,
    ])
    expect(unresolvedTrace.endpointReason).toBe('ambiguity')
    expect(unresolvedTrace.samples.map((sample) => sample.point[0])).toEqual([
      4,
    ])
  })

  it('maps excessive curvature exactly without appending the rejected step', () => {
    const turn = (70 * Math.PI) / 180
    const corner = field(10, 9, (x, y) => ({
      evidence: gaussian(y - 4),
      tangent: x < 6 ? [1, 0] : [Math.cos(turn), Math.sin(turn)],
    }))
    const trace = grow(corner, [4, 4])

    expect(trace.endpointReason).toBe('curvature')
    expect(trace.samples.map((sample) => sample.point[0])).toEqual([4, 5])
    expect(trace.searchStepCount).toBe(2)
  })

  it('stops and rolls back at a branch instead of selecting a side', () => {
    const branch = field(12, 13, (x, y) => {
      const straight = gaussian(y - 6, 0.35)
      const split =
        x < 6
          ? straight
          : Math.max(gaussian(y - 5, 0.3), gaussian(y - 7, 0.3))
      return {
        evidence: x === 5 ? 0.01 * straight : split,
        tangent: [1, 0],
      }
    })
    const trace = grow(branch, [4, 6], {
      ...OPTIONS,
      continuity: 0.5,
      ridgeStepOptions: { stepLength: 1, ambiguityMargin: 0.3 },
    })

    expect(trace.endpointReason).toBe('ambiguity')
    expect(trace.samples.map((sample) => sample.point)).toEqual([[4, 6]])
    expect(trace.spanSupport).toEqual([])
  })

  it('makes Continuity monotonic while retaining exact weak hard caps', () => {
    const interrupted = field(14, 9, (x, y) => ({
      evidence: (x >= 5 && x <= 6 ? 0.01 : 1) * gaussian(y - 4),
      tangent: [1, 0],
    }))
    const limits = createFlowingContoursTestLimits({
      'search-step-count': 32,
      'weak-span-step-count': 2,
      'weak-span-distance': 3,
    })!

    const low = grow(
      interrupted,
      [4, 4],
      { ...OPTIONS, continuity: 0.05 },
      limits,
    )
    const high = grow(
      interrupted,
      [4, 4],
      { ...OPTIONS, continuity: 1 },
      limits,
    )

    expect(low.endpointReason).toBe('evidence-exhausted')
    expect(low.samples).toHaveLength(1)
    expect(high.samples.some((sample) => sample.point[0] === 7)).toBe(true)
    expect(
      high.spanSupport.find((span) => span.kind === 'bounded-gap')?.length,
    ).toBe(3)

    const beyondHardCap = field(16, 9, (x, y) => ({
      evidence: (x >= 5 && x <= 7 ? 0.01 : 1) * gaussian(y - 4),
      tangent: [1, 0],
    }))
    const capped = grow(
      beyondHardCap,
      [4, 4],
      { ...OPTIONS, continuity: 1 },
      limits,
    )
    expect(capped.endpointReason).toBe('evidence-exhausted')
    expect(capped.samples).toHaveLength(1)
  })

  it('stops before represented occupancy and bounds overlap sampling', () => {
    const straight = field(15, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const sampled: Point[] = []
    const trace = grow(straight, [3, 4], {
      ...OPTIONS,
      representedOverlapSampler(point) {
        sampled.push([point[0], point[1]])
        return point[0] >= 7 ? 0.8 : point[0] / 20
      },
    })

    expect(trace.endpointReason).toBe('represented-collision')
    expect(trace.samples.at(-1)!.point[0]).toBe(6)
    expect(trace.samples.some((sample) => sample.point[0] === 7)).toBe(false)
    expect(sampled.length).toBeGreaterThan(trace.searchStepCount + 1)
    expect(sampled.length).toBeLessThanOrEqual(
      trace.searchStepCount * 64 + 1,
    )
  })

  it('detects a thin represented barrier crossed inside a candidate segment', () => {
    const straight = field(15, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const sampledX: number[] = []
    const trace = grow(straight, [3, 4], {
      ...OPTIONS,
      ridgeStepOptions: { stepLength: 2.4 },
      representedOverlapSampler(point) {
        sampledX.push(point[0])
        return Math.abs(point[0] - 5) < 1e-12 ? 0.9 : 0
      },
    })

    expect(trace.endpointReason).toBe('represented-collision')
    expect(trace.samples).toHaveLength(1)
    expect(trace.searchStepCount).toBe(1)
    expect(sampledX).toContain(5)
  })

  it('enforces exact search-step, breadth, and weak-step caps', () => {
    const straight = field(15, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const stepLimited = grow(
      straight,
      [3, 4],
      OPTIONS,
      createFlowingContoursTestLimits({ 'search-step-count': 2 })!,
    )
    expect(stepLimited.endpointReason).toBe('safety-limit')
    expect(stepLimited.searchStepCount).toBe(2)
    expect(stepLimited.samples).toHaveLength(3)

    const breadthLimited = grow(
      straight,
      [3, 4],
      {
        ...OPTIONS,
        directionAlternatives: [[1, 0.1]],
      },
      createFlowingContoursTestLimits({
        'search-breadth': 1,
        'search-step-count': 8,
      })!,
    )
    expect(breadthLimited.endpointReason).toBe('safety-limit')
    expect(breadthLimited.searchStepCount).toBe(0)
    expect(breadthLimited.samples).toHaveLength(1)

    const weak = field(12, 9, (x, y) => ({
      evidence: (x >= 5 && x <= 6 ? 0.01 : 1) * gaussian(y - 4),
      tangent: [1, 0],
    }))
    const weakLimited = grow(
      weak,
      [4, 4],
      { ...OPTIONS, continuity: 1 },
      createFlowingContoursTestLimits({
        'search-step-count': 8,
        'weak-span-step-count': 1,
      })!,
    )
    expect(weakLimited.endpointReason).toBe('evidence-exhausted')
    expect(weakLimited.searchStepCount).toBe(2)
    expect(weakLimited.samples).toHaveLength(1)

    const distanceLimited = grow(
      weak,
      [4, 4],
      { ...OPTIONS, continuity: 1 },
      createFlowingContoursTestLimits({
        'search-step-count': 8,
        'weak-span-distance': 1.5,
      })!,
    )
    expect(distanceLimited.endpointReason).toBe('evidence-exhausted')
    expect(distanceLimited.searchStepCount).toBe(2)
    expect(distanceLimited.samples).toHaveLength(1)

    const pointLimited = grow(
      straight,
      [3, 4],
      OPTIONS,
      createFlowingContoursTestLimits({
        'search-step-count': 32,
        'raw-trajectory-point-count': 4,
      })!,
    )
    expect(pointLimited.endpointReason).toBe('safety-limit')
    expect(pointLimited.searchStepCount).toBe(3)
    expect(pointLimited.samples).toHaveLength(4)
  })

  it('uses overlap penalty to order bounded directional alternatives', () => {
    const vertical = field(9, 15, (x, _y) => ({
      evidence: gaussian(x - 4),
      tangent: [0, 1],
    }))
    const trace = growFlowingContoursDirection(
      vertical,
      at(vertical, [4, 7]),
      [1, 0],
      'forward',
      {
        ...OPTIONS,
        directionAlternatives: [
          [0.1, 1],
          [0.1, -1],
        ],
        representedOverlapSampler(point) {
          return point[1] > 7 ? 0.6 : 0
        },
      },
      createFlowingContoursTestLimits({
        'search-breadth': 3,
        'search-step-count': 9,
      })!,
    )

    expect(trace.endpointReason).toBe('safety-limit')
    expect(trace.searchStepCount).toBe(9)
    expect(trace.samples.length).toBeGreaterThan(2)
    expect(trace.samples.at(-1)!.point[1]).toBeLessThan(7)
  })

  it('accounts total deterministic beam work and resolves exact ties stably', () => {
    const straight = field(15, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const options = {
      ...OPTIONS,
      directionAlternatives: [
        [1, 0.1],
        [1, -0.1],
      ],
    } satisfies FlowingContoursDirectionalGrowthOptions
    const limits = createFlowingContoursTestLimits({
      'search-breadth': 3,
      'search-step-count': 6,
    })!
    const first = grow(straight, [3, 4], options, limits)
    const second = grow(straight, [3, 4], options, limits)

    expect(first).toEqual(second)
    expect(first.searchStepCount).toBe(6)
    expect(first.endpointReason).toBe('safety-limit')
    expect(first.samples).toHaveLength(3)
  })

  it('does useful distinct beam work from an aligned anchor and deduplicates successors', () => {
    const straight = field(15, 9, (_x, y) => ({
      evidence: gaussian(y - 4, 0.8),
      tangent: [1, 0],
    }))
    const sampled: Point[] = []
    const trace = grow(
      straight,
      [3, 4],
      {
        ...OPTIONS,
        directionAlternatives: [
          [1, 0.35],
          [1, -0.35],
          [2, 0],
        ],
        representedOverlapSampler(point) {
          sampled.push([point[0], point[1]])
          return 0
        },
      },
      createFlowingContoursTestLimits({
        'search-breadth': 3,
        'search-step-count': 6,
      })!,
    )

    const firstAttemptSamples = sampled.filter(
      (point) => point[0] > 3 && point[0] < 4.1,
    )
    expect(trace.searchStepCount).toBeLessThanOrEqual(6)
    expect(trace.searchStepCount).toBeGreaterThanOrEqual(4)
    expect(trace.samples.length).toBeGreaterThan(1)
    expect(
      new Set(firstAttemptSamples.map((point) => point[1].toFixed(8))).size,
    ).toBeGreaterThan(1)
  })

  it('deduplicates numerically identical successors before the next beam wave', () => {
    const straight = field(20, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const trace = grow(
      straight,
      [3, 4],
      {
        ...OPTIONS,
        directionAlternatives: [
          [1, 1e-16],
          [1, -1e-16],
        ],
      },
      createFlowingContoursTestLimits({
        'search-breadth': 3,
        'search-step-count': 6,
      })!,
    )

    expect(trace.searchStepCount).toBe(6)
    expect(trace.samples).toHaveLength(5)
    expect(trace.endpointReason).toBe('safety-limit')
  })

  it('keeps reconverged weak histories until the compatible entry can commit', () => {
    const branchX = Math.cos((25 * Math.PI) / 180)
    const branchY = Math.sin((25 * Math.PI) / 180)
    const funnel = field(13, 9, (x, y) => {
      if (x <= 4) {
        return {
          evidence: Math.max(gaussian(y - 3, 0.4), gaussian(y - 5, 0.4)),
          tangent:
            y < 4
              ? ([branchX, branchY] as const)
              : ([branchX, -branchY] as const),
        }
      }
      if (x <= 6) {
        return {
          evidence: 0.01 * gaussian(y - 4, 0.8),
          tangent: [1, 0],
        }
      }
      return {
        evidence: gaussian(y - 4, 0.8),
        // Only the lower entry has this far-side orientation.
        tangent: [branchX, branchY],
      }
    })
    const anchor = {
      ...at(funnel, [3, 4]),
      tangent: [1, 0] as Point,
    }
    const trace = growFlowingContoursDirection(
      funnel,
      anchor,
      [1, 0],
      'forward',
      {
        ...OPTIONS,
        continuity: 1,
        ridgeStepOptions: {
          stepLength: 1.3,
          ambiguityMargin: 0.01,
        },
        directionAlternatives: [
          [1, 0.6],
          [1, -0.6],
        ],
      },
      createFlowingContoursTestLimits({
        'search-breadth': 3,
        'search-step-count': 24,
        'normal-search-sample-count': 1,
      })!,
    )

    const gap = trace.spanSupport.find((span) => span.kind === 'bounded-gap')
    expect(gap).toBeDefined()
    expect(gap!.directionalAlignment).toBeGreaterThanOrEqual(0.75)
    expect(trace.samples.some((sample) => sample.point[0] > 7)).toBe(true)
    expect(gap!.exitEvidence).toBeGreaterThan(gap!.entryEvidence)
  })

  it('bounds a long smooth loop by raw points with linear attempted work', () => {
    const center = [16, 16] as const
    const radius = 9
    const loop = field(33, 33, (x, y) => {
      const dx = x - center[0]
      const dy = y - center[1]
      const radial = Math.hypot(dx, dy)
      return {
        evidence: gaussian(radial - radius, 0.7),
        tangent:
          radial === 0
            ? ([1, 0] as const)
            : ([-dy / radial, dx / radial] as const),
      }
    })
    let overlapCalls = 0
    const trace = growFlowingContoursDirection(
      loop,
      at(loop, [25, 16]),
      [0, 1],
      'forward',
      {
        ...OPTIONS,
        representedOverlapSampler() {
          overlapCalls += 1
          return 0
        },
      },
      createFlowingContoursTestLimits({
        'search-step-count': 100,
        'raw-trajectory-point-count': 8,
      })!,
    )

    expect(trace.endpointReason).toBe('safety-limit')
    expect(trace.samples).toHaveLength(8)
    expect(trace.searchStepCount).toBe(7)
    expect(overlapCalls).toBeLessThanOrEqual(1 + trace.searchStepCount * 64)
  })

  it('penalizes signed zigzag turn changes more than a matched smooth arc', () => {
    const smooth = [0, 1, 2, 3, 4].map((index) => {
      const angle = (index * Math.PI) / 12
      return [Math.cos(angle), Math.sin(angle)] as Point
    })
    const zigzag = [
      [0, 0] as Point,
      [1, 0.3] as Point,
      [2, -0.3] as Point,
      [3, 0.3] as Point,
      [4, -0.3] as Point,
    ]

    expect(measureFlowingContoursCurvatureChange(smooth)).toBeLessThan(0.01)
    expect(measureFlowingContoursCurvatureChange(zigzag)).toBeGreaterThan(0.5)
  })

  it('discards provisional overlap when competing terminal gaps roll back', () => {
    const oneSided = field(10, 9, (x, y) => ({
      evidence: (x < 5 ? 1 : 0.01) * gaussian(y - 4),
      tangent: [1, 0],
    }))
    const withoutOverlap = grow(oneSided, [4, 4], {
      ...OPTIONS,
      continuity: 1,
      directionAlternatives: [[1, 0.2]],
    })
    const withProvisionalOverlap = grow(oneSided, [4, 4], {
      ...OPTIONS,
      continuity: 1,
      directionAlternatives: [[1, 0.2]],
      representedOverlapSampler(point) {
        return point[0] > 4 ? 0.6 : 0
      },
    })

    expect(withProvisionalOverlap).toEqual(withoutOverlap)
    expect(withProvisionalOverlap.samples).toHaveLength(1)
    expect(withProvisionalOverlap.endpointReason).toBe('source-boundary')
  })

  it('uses Flow smoothing only for beam curvature preference', () => {
    const straight = field(15, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const low = grow(straight, [3, 4], {
      ...OPTIONS,
      flowSmoothing: 0,
    })
    const high = grow(straight, [3, 4], {
      ...OPTIONS,
      flowSmoothing: 1,
    })

    expect(high).toEqual(low)
  })

  it('fails malformed controls, options, samplers, and policies closed', () => {
    const straight = field(15, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const malformed = [
      { ...OPTIONS, continuity: Number.NaN },
      { ...OPTIONS, continuity: 2 },
      { ...OPTIONS, flowSmoothing: Number.POSITIVE_INFINITY },
      {
        ...OPTIONS,
        directionAlternatives: [[-1, 0]],
      },
      {
        ...OPTIONS,
        representedOverlapSampler: (() => Number.NaN),
      },
      {
        ...OPTIONS,
        representedOverlapSampler: (() => {
          throw new Error('hostile sampler')
        }),
      },
      {
        ...OPTIONS,
        representedCollisionThreshold: Number.NaN,
      },
      {
        ...OPTIONS,
        ridgeStepOptions: { stepLength: -1 },
      },
      {
        ...OPTIONS,
        ridgeStepOptions: { stepLength: 0.01 },
      },
    ] as readonly FlowingContoursDirectionalGrowthOptions[]

    for (const options of malformed) {
      const trace = grow(straight, [3, 4], options)
      expect(trace.endpointReason, JSON.stringify(options)).toBe('safety-limit')
      expect(trace.samples, JSON.stringify(options)).toHaveLength(1)
      expect(Object.isFrozen(trace)).toBe(true)
      expect(Object.isFrozen(trace.samples)).toBe(true)
    }
  })

  it('preserves exact stop reason, total work, provenance, and immutability', () => {
    const straight = field(8, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const trace = grow(straight, [4, 4])

    expect(trace.endpointReason).toBe('source-boundary')
    expect(trace.searchStepCount).toBe(4)
    expect(trace.samples.map((sample) => sample.point[0])).toEqual([4, 5, 6, 7])
    expect(trace.spanSupport[0]!.length).toBe(3)
    expect(Object.isFrozen(trace)).toBe(true)
    expect(Object.isFrozen(trace.samples)).toBe(true)
    expect(Object.isFrozen(trace.samples[0])).toBe(true)
    expect(Object.isFrozen(trace.samples[0]!.point)).toBe(true)
    expect(Object.isFrozen(trace.spanSupport)).toBe(true)
    expect(Object.isFrozen(trace.spanSupport[0])).toBe(true)
  })
})
