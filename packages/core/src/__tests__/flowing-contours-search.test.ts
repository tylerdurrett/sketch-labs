import { describe, expect, it } from 'vitest'

import { createFlowingContoursAccounting } from '../sketches/flowing-contours/accounting'
import { buildFlowingContoursAnchorInventory } from '../sketches/flowing-contours/anchors'
import { sampleFlowingContoursField } from '../sketches/flowing-contours/field'
import { createFlowingContoursTestLimits } from '../sketches/flowing-contours/limits'
import {
  flowingContoursCandidateSourceField,
  searchFlowingContoursCandidate,
  searchFlowingContoursCandidateDetailed,
  type FlowingContoursSearchOptions,
} from '../sketches/flowing-contours/search'
import { selectFlowingContoursCandidate } from '../sketches/flowing-contours/selection'
import type {
  CorrectedFlowingRidgeSample,
  FlowingContoursAnchor,
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

function sampled(
  source: Readonly<FlowingContoursField>,
  point: Readonly<Point>,
): Readonly<CorrectedFlowingRidgeSample> {
  const result = sampleFlowingContoursField(source, point)
  if (result === null) throw new Error(`Expected field sample at ${point}`)
  return result
}

function anchor(
  source: Readonly<FlowingContoursField>,
  point: Readonly<Point>,
  id = 7,
): Readonly<FlowingContoursAnchor> {
  return Object.freeze({
    id,
    fieldSampleIndex:
      Math.round(point[1]) * source.width + Math.round(point[0]),
    sample: sampled(source, point),
  })
}

const OPTIONS = Object.freeze({
  continuity: 0.45,
  flowSmoothing: 0.7,
  ridgeStepOptions: Object.freeze({ stepLength: 1 }),
}) satisfies FlowingContoursSearchOptions

function limits(overrides: Record<string, number> = {}) {
  const result = createFlowingContoursTestLimits({
    'search-step-count': 96,
    ...overrides,
  })
  if (result === null) throw new Error('Expected valid test limits')
  return result
}

describe('Flowing Contours bidirectional whole-candidate search', () => {
  it('brands only the exact FC10 return with its exact field identity', () => {
    const source = field(21, 11, (_x, y) => ({
      evidence: gaussian(y - 5),
      tangent: [1, 0],
    }))
    const equivalentField = field(21, 11, (_x, y) => ({
      evidence: gaussian(y - 5),
      tangent: [1, 0],
    }))
    const candidate = searchFlowingContoursCandidate(
      source,
      anchor(source, [10, 5]),
      OPTIONS,
      limits(),
    )

    expect(candidate).not.toBeNull()
    expect(flowingContoursCandidateSourceField(candidate!)).toBe(source)
    expect(flowingContoursCandidateSourceField({ ...candidate! })).toBeNull()
    expect(flowingContoursCandidateSourceField(candidate!)).not.toBe(
      equivalentField,
    )
  })

  it.each([
    {
      name: 'straight',
      source: field(21, 11, (_x, y) => ({
        evidence: gaussian(y - 5),
        tangent: [1, 0],
      })),
      start: [10, 5] as const,
    },
    {
      name: 'diagonal',
      source: field(21, 21, (x, y) => ({
        evidence: gaussian((y - x) / Math.SQRT2, 0.7),
        tangent: [Math.SQRT1_2, Math.SQRT1_2],
      })),
      start: [10, 10] as const,
    },
    {
      name: 'curve',
      source: field(25, 25, (x, y) => {
        const dx = x - 12
        const dy = y - 12
        const radius = Math.hypot(dx, dy)
        return {
          evidence: gaussian(radius - 8, 0.7),
          tangent:
            radius === 0
              ? ([1, 0] as const)
              : ([-dy / radius, dx / radius] as const),
        }
      }),
      start: [20, 12] as const,
    },
  ])('assembles one complete $name candidate', ({ source, start }) => {
    const candidate = searchFlowingContoursCandidate(
      source,
      anchor(source, start),
      OPTIONS,
      limits(),
    )

    expect(candidate).not.toBeNull()
    expect(candidate!.samples.length).toBeGreaterThan(8)
    expect(candidate!.backward.samples[0]!.point).toEqual(start)
    expect(candidate!.forward.samples[0]!.point).toEqual(start)
    expect(candidate!.length).toBeGreaterThan(6)
    expect(Number.isFinite(candidate!.score.total)).toBe(true)
    expect(Object.isFrozen(candidate)).toBe(true)
    expect(Object.isFrozen(candidate!.samples)).toBe(true)
    expect(Object.isFrozen(candidate!.spanSupport)).toBe(true)
  })

  it('reverses backward samples and support while retaining the anchor once', () => {
    const source = field(17, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const start = [8, 4] as const
    const candidate = searchFlowingContoursCandidate(
      source,
      anchor(source, start),
      OPTIONS,
      limits(),
    )!
    const anchorIndices = candidate.samples.flatMap((sample, index) =>
      sample.point[0] === start[0] && sample.point[1] === start[1]
        ? [index]
        : [],
    )

    expect(anchorIndices).toEqual([candidate.backward.samples.length - 1])
    expect(candidate.samples[0]!.point).toEqual(
      candidate.backward.samples.at(-1)!.point,
    )
    expect(candidate.samples.at(-1)!.point).toEqual(
      candidate.forward.samples.at(-1)!.point,
    )
    expect(candidate.samples.every((sample) => sample.tangent[0] > 0)).toBe(
      true,
    )
    expect(candidate.spanSupport).toEqual([
      {
        ...candidate.backward.spanSupport[0],
        startSampleIndex: 0,
        endSampleIndex: candidate.backward.samples.length - 1,
        entryEvidence: candidate.backward.spanSupport[0]!.exitEvidence,
        exitEvidence: candidate.backward.spanSupport[0]!.entryEvidence,
      },
      {
        ...candidate.forward.spanSupport[0],
        startSampleIndex: candidate.backward.samples.length - 1,
        endSampleIndex: candidate.samples.length - 1,
      },
    ])
  })

  it('accepts an off-lattice anchor produced by FC06 ownership correction', () => {
    const source = field(17, 11, (_x, y) => ({
      evidence: gaussian(y - 5.3),
      tangent: [1, 0],
    }))
    const inventory = buildFlowingContoursAnchorInventory(
      source,
      createFlowingContoursAccounting(),
    )
    const owned = inventory.anchors[0]

    expect(owned).toBeDefined()
    expect(owned!.sample.point[1]).not.toBe(Math.round(owned!.sample.point[1]))
    expect(
      searchFlowingContoursCandidate(source, owned!, OPTIONS, limits()),
    ).not.toBeNull()
  })

  it('preserves interrupted supported-gap provenance after reversal', () => {
    const source = field(23, 9, (x, y) => ({
      evidence:
        x === 5 || x === 6 || x === 16 || x === 17
          ? 0.01 * gaussian(y - 4)
          : gaussian(y - 4),
      tangent: [1, 0],
    }))
    const candidate = searchFlowingContoursCandidate(
      source,
      anchor(source, [11, 4]),
      { ...OPTIONS, continuity: 1 },
      limits(),
    )!
    const gaps = candidate.spanSupport.filter(
      (span) => span.kind === 'bounded-gap',
    )

    expect(gaps).toHaveLength(2)
    expect(gaps[0]!.startSampleIndex).toBeLessThan(gaps[0]!.endSampleIndex)
    expect(gaps[0]!.entryEvidence).toBeGreaterThan(0.04)
    expect(gaps[0]!.exitEvidence).toBeGreaterThan(0.04)
    expect(gaps[1]!.startSampleIndex).toBeLessThan(gaps[1]!.endSampleIndex)
  })

  it('preserves crossing and branch endpoint reasons without repair', () => {
    const source = field(17, 13, (x, y) => {
      const onHorizontal = gaussian(y - 6)
      const onVertical = gaussian(x - 13)
      const ambiguous = Math.abs(x - 13) <= 1 && Math.abs(y - 6) <= 1
      return {
        evidence: Math.max(onHorizontal, onVertical),
        tangent: [1, 0],
        coherence: ambiguous ? 0.1 : 1,
        ambiguity: ambiguous ? 0.95 : 0,
      }
    })
    const candidate = searchFlowingContoursCandidate(
      source,
      anchor(source, [6, 6]),
      OPTIONS,
      limits(),
    )!

    expect(candidate.forward.endpointReason).toBe('ambiguity')
    expect(candidate.forward.samples.at(-1)!.point[0]).toBeLessThan(13)
    expect(candidate.samples.at(-1)!.point).toEqual(
      candidate.forward.samples.at(-1)!.point,
    )
  })

  it('closes only a densely supported meeting of its own two endpoints', () => {
    const source = field(25, 25, (x, y) => {
      const dx = x - 12
      const dy = y - 12
      const radius = Math.hypot(dx, dy)
      return {
        evidence: gaussian(radius - 7, 0.7),
        tangent:
          radius === 0
            ? ([1, 0] as const)
            : ([-dy / radius, dx / radius] as const),
      }
    })
    const candidate = searchFlowingContoursCandidate(
      source,
      anchor(source, [19, 12]),
      OPTIONS,
      limits({
        'search-step-count': 42,
        'raw-trajectory-point-count': 44,
      }),
    )!

    expect(candidate.samples.at(-1)!.point).toEqual(candidate.samples[0]!.point)
    expect(candidate.samples.length).toBeLessThanOrEqual(44)
    expect(candidate.spanSupport.at(-1)).toMatchObject({
      kind: 'direct-evidence',
      startSampleIndex: candidate.samples.length - 2,
      endSampleIndex: candidate.samples.length - 1,
    })
  })

  it('assembles one bounded supported loop when forward growth reaches its own prefix', () => {
    const source = field(31, 31, (x, y) => {
      const dx = x - 15
      const dy = y - 15
      const radius = Math.hypot(dx, dy)
      return {
        evidence: gaussian(radius - 9, 0.7),
        tangent:
          radius === 0
            ? ([1, 0] as const)
            : ([-dy / radius, dx / radius] as const),
      }
    })
    const search = searchFlowingContoursCandidateDetailed(
      source,
      anchor(source, [24, 15]),
      OPTIONS,
      limits({
        'search-step-count': 240,
        'raw-trajectory-point-count': 241,
      }),
    )!
    const candidate = search.candidate!

    expect(search.directionalTraceCount).toBe(1)
    expect(search.searchStepCount).toBe(candidate.forward.searchStepCount)
    expect(search.searchCapExhausted).toBe(false)
    expect(candidate.forward.endpointReason).toBe('represented-collision')
    expect(candidate.backward.endpointReason).toBe('represented-collision')
    expect(candidate.backward.searchStepCount).toBe(0)
    expect(candidate.forward.searchStepCount).toBeLessThan(120)
    expect(candidate.samples.at(-1)!.point).toEqual(candidate.samples[0]!.point)
    expect(candidate.length).toBeGreaterThan(45)
    expect(candidate.length).toBeLessThan(70)
    expect(
      candidate.forward.searchStepCount + candidate.backward.searchStepCount,
    ).toBeLessThanOrEqual(240)
    const loopSelection = selectFlowingContoursCandidate(
      candidate,
      {
        analysisWidth: source.width,
        analysisHeight: source.height,
        minimumStrokeLength: 0.1,
      },
      createFlowingContoursAccounting(),
      limits({
        'search-step-count': 240,
        'raw-trajectory-point-count': 241,
      }),
    )
    expect(loopSelection.kind).toBe('accepted')
  })

  it('does not treat a nearby parallel ridge as a supported self-loop', () => {
    const source = field(41, 13, (_x, y) => ({
      evidence: Math.max(gaussian(y - 5), gaussian(y - 7)),
      tangent: [1, 0],
    }))
    const candidate = searchFlowingContoursCandidate(
      source,
      anchor(source, [20, 5]),
      OPTIONS,
      limits({
        'search-step-count': 240,
        'raw-trajectory-point-count': 241,
      }),
    )!

    expect(candidate.samples.at(-1)!.point).not.toEqual(
      candidate.samples[0]!.point,
    )
    expect(candidate.forward.endpointReason).toBe('source-boundary')
    expect(candidate.backward.endpointReason).toBe('source-boundary')
  })

  it.each([
    {
      name: 'ambiguous near-loop',
      interrupted: (x: number, y: number) => x >= 22 && y <= 14,
      evidence: 1,
      coherence: 0,
      ambiguity: 1,
      continuity: 0.45,
    },
    {
      name: 'weak closure approach',
      interrupted: (x: number, y: number) => x >= 22 && y <= 14,
      evidence: 0.01,
      coherence: 1,
      ambiguity: 0,
      continuity: 1,
    },
  ])(
    'rejects a $name instead of bridging it into a loop',
    ({ interrupted, evidence, coherence, ambiguity, continuity }) => {
      const source = field(31, 31, (x, y) => {
        const dx = x - 15
        const dy = y - 15
        const radius = Math.hypot(dx, dy)
        const blocked = interrupted(x, y)
        return {
          evidence: (blocked ? evidence : 1) * gaussian(radius - 9, 0.7),
          tangent:
            radius === 0
              ? ([1, 0] as const)
              : ([-dy / radius, dx / radius] as const),
          coherence: blocked ? coherence : 1,
          ambiguity: blocked ? ambiguity : 0,
        }
      })
      const candidate = searchFlowingContoursCandidate(
        source,
        anchor(source, [24, 15]),
        { ...OPTIONS, continuity },
        limits({
          'search-step-count': 240,
          'raw-trajectory-point-count': 241,
        }),
      )!

      expect(candidate.samples.at(-1)!.point).not.toEqual(
        candidate.samples[0]!.point,
      )
      expect(candidate.forward.endpointReason).not.toBe(
        'represented-collision',
      )
    },
  )

  it('does not close across a zero-evidence unresolved bridge even with permissive ridge options', () => {
    const source = field(25, 25, (x, y) => {
      const dx = x - 12
      const dy = y - 12
      const radius = Math.hypot(dx, dy)
      const unresolved = (x === 5 || x === 6) && y === 12
      return {
        evidence: unresolved ? 0 : gaussian(radius - 7, 0.7),
        tangent:
          unresolved || radius === 0
            ? ([0, 0] as const)
            : ([-dy / radius, dx / radius] as const),
        coherence: unresolved ? 0 : 1,
        ambiguity: unresolved ? 1 : 0,
      }
    })
    const candidate = searchFlowingContoursCandidate(
      source,
      anchor(source, [19, 12]),
      {
        ...OPTIONS,
        ridgeStepOptions: {
          ...OPTIONS.ridgeStepOptions,
          minimumEvidence: 0,
          minimumCoherence: 0,
          maximumAmbiguity: 1,
        },
      },
      limits({
        'search-step-count': 42,
        'raw-trajectory-point-count': 44,
      }),
    )!

    expect(candidate.samples.at(-1)!.point).not.toEqual(
      candidate.samples[0]!.point,
    )
  })

  it('keeps a supported closure inside the shared raw-point cap', () => {
    const source = field(25, 25, (x, y) => {
      const dx = x - 12
      const dy = y - 12
      const radius = Math.hypot(dx, dy)
      return {
        evidence: gaussian(radius - 7, 0.7),
        tangent:
          radius === 0
            ? ([1, 0] as const)
            : ([-dy / radius, dx / radius] as const),
      }
    })
    const capped = searchFlowingContoursCandidate(
      source,
      anchor(source, [19, 12]),
      OPTIONS,
      limits({
        'search-step-count': 42,
        'raw-trajectory-point-count': 43,
      }),
    )!

    expect(capped.samples.length).toBeLessThanOrEqual(43)
    expect(capped.samples.at(-1)!.point).not.toEqual(capped.samples[0]!.point)
  })

  it.each([
    { reason: 'zero alpha', alpha: 0, ambiguity: 0, coherence: 1 },
    { reason: 'ambiguity', alpha: 1, ambiguity: 1, coherence: 0 },
  ])(
    'does not close nearby endpoints across $reason',
    ({ alpha, ambiguity, coherence }) => {
      const source = field(25, 25, (x, y) => {
        const dx = x - 12
        const dy = y - 12
        const radius = Math.hypot(dx, dy)
        const unsupported = x <= 6 && Math.abs(y - 12) <= 2
        return {
          evidence: gaussian(radius - 7, 0.7),
          tangent:
            radius === 0
              ? ([1, 0] as const)
              : ([-dy / radius, dx / radius] as const),
          alpha: unsupported ? alpha : 1,
          ambiguity: unsupported ? ambiguity : 0,
          coherence: unsupported ? coherence : 1,
        }
      })
      const candidate = searchFlowingContoursCandidate(
        source,
        anchor(source, [19, 12]),
        OPTIONS,
        limits({
          'search-step-count': 42,
          'raw-trajectory-point-count': 44,
        }),
      )!

      expect(candidate.samples.at(-1)!.point).not.toEqual(
        candidate.samples[0]!.point,
      )
    },
  )

  it('enforces one exact global search-step cap across both directions', () => {
    const source = field(101, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const candidate = searchFlowingContoursCandidate(
      source,
      anchor(source, [50, 4]),
      OPTIONS,
      limits({ 'search-step-count': 5 }),
    )!

    expect(candidate.forward.searchStepCount).toBe(3)
    expect(candidate.backward.searchStepCount).toBe(2)
    expect(
      candidate.forward.searchStepCount + candidate.backward.searchStepCount,
    ).toBe(5)
    expect(candidate.forward.endpointReason).toBe('safety-limit')
    expect(candidate.backward.endpointReason).toBe('safety-limit')
  })

  it('reports exact work and aggregate-cap exhaustion for valid attempts', () => {
    const source = field(101, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const result = searchFlowingContoursCandidateDetailed(
      source,
      anchor(source, [50, 4]),
      OPTIONS,
      limits({ 'search-step-count': 5 }),
    )

    expect(result).not.toBeNull()
    expect(result!.candidate).not.toBeNull()
    expect(result!.directionalTraceCount).toBe(2)
    expect(result!.searchStepCount).toBe(5)
    expect(result!.searchCapExhausted).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('accounts consumed work when a valid search fails after growth', () => {
    const source = field(31, 11, (_x, y) => ({
      evidence: gaussian(y - 5),
      tangent: [1, 0],
    }))
    let calls = 0
    const result = searchFlowingContoursCandidateDetailed(
      source,
      anchor(source, [15, 5]),
      {
        ...OPTIONS,
        representedOverlapSampler() {
          calls += 1
          return calls === 3 ? Number.NaN : 0
        },
      },
      limits({ 'search-step-count': 24 }),
    )

    expect(result).not.toBeNull()
    expect(result!.candidate).toBeNull()
    expect(result!.directionalTraceCount).toBe(1)
    expect(result!.searchStepCount).toBeGreaterThan(0)
    expect(result!.searchStepCount).toBeLessThanOrEqual(24)
    expect(result!.searchCapExhausted).toBe(false)
  })

  it('returns accounted null for an anchor-only two-sided assembly', () => {
    const source = field(17, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const sampledHeadings: number[] = []
    const searchOptions = {
      ...OPTIONS,
      representedOverlapSampler(
        _point: Readonly<Point>,
        travelTangent: Readonly<Point>,
      ) {
        sampledHeadings.push(Math.sign(travelTangent[0]))
        return travelTangent[0] < 0 ? 0.8 : 0
      },
    }
    const searchLimits = limits({ 'search-step-count': 24 })
    const result = searchFlowingContoursCandidateDetailed(
      source,
      anchor(source, [16, 4]),
      searchOptions,
      searchLimits,
    )

    expect(result).not.toBeNull()
    expect(result!.candidate).toBeNull()
    expect(result!.directionalTraceCount).toBe(2)
    expect(result!.searchStepCount).toBe(1)
    expect(result!.searchCapExhausted).toBe(false)
    expect(sampledHeadings).toContain(1)
    expect(sampledHeadings).toContain(-1)
    expect(
      searchFlowingContoursCandidate(
        source,
        anchor(source, [16, 4]),
        searchOptions,
        searchLimits,
      ),
    ).toBeNull()
  })

  it('leaves only invalid preflight unaccounted by the detailed API', () => {
    const source = field(17, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))

    expect(
      searchFlowingContoursCandidateDetailed(
        source,
        anchor(source, [8, 4]),
        { ...OPTIONS, continuity: Number.NaN },
        limits(),
      ),
    ).toBeNull()
  })

  it('shares a three-point raw trajectory cap across both directions', () => {
    const source = field(101, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const candidate = searchFlowingContoursCandidate(
      source,
      anchor(source, [50, 4]),
      OPTIONS,
      limits({
        'search-step-count': 20,
        'raw-trajectory-point-count': 3,
      }),
    )!

    expect(candidate.samples).toHaveLength(3)
    expect(candidate.forward.samples).toHaveLength(2)
    expect(candidate.backward.samples).toHaveLength(2)
    expect(
      candidate.samples.filter((sample) => sample.point[0] === 50),
    ).toHaveLength(1)
  })

  it('returns accounted null for anchor-only safety work at a zero budget', () => {
    const source = field(11, 7, (_x, y) => ({
      evidence: gaussian(y - 3),
      tangent: [1, 0],
    }))
    const result = searchFlowingContoursCandidateDetailed(
      source,
      anchor(source, [5, 3]),
      OPTIONS,
      limits({ 'search-step-count': 0 }),
    )

    expect(result).not.toBeNull()
    expect(result!.candidate).toBeNull()
    expect(result!.directionalTraceCount).toBe(2)
    expect(result!.searchStepCount).toBe(0)
    expect(result!.searchCapExhausted).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('measures whole length and every explicit score term including overlap', () => {
    const source = field(11, 7, (_x, y) => ({
      evidence: gaussian(y - 3),
      tangent: [1, 0],
    }))
    const candidate = searchFlowingContoursCandidate(
      source,
      anchor(source, [5, 3]),
      {
        ...OPTIONS,
        flowSmoothing: 0,
        representedOverlapSampler: () => 0.2,
      },
      limits(),
    )!
    const measuredLength = candidate.samples
      .slice(1)
      .reduce((sum, sample, index) => {
        const previous = candidate.samples[index]!
        return (
          sum +
          Math.hypot(
            sample.point[0] - previous.point[0],
            sample.point[1] - previous.point[1],
          )
        )
      }, 0)
    const evidence =
      candidate.samples.reduce((sum, sample) => sum + sample.evidence, 0) /
      candidate.samples.length
    const ambiguity =
      candidate.samples.reduce((sum, sample) => sum + sample.ambiguity, 0) /
      candidate.samples.length

    expect(candidate.length).toBeCloseTo(measuredLength, 12)
    expect(candidate.score.accumulatedEvidence).toBeCloseTo(4 * evidence, 12)
    expect(candidate.score.usefulLength).toBeCloseTo(
      3 * Math.min(1, measuredLength / Math.hypot(11, 7)),
      12,
    )
    expect(candidate.score.directionalCoherence).toBeCloseTo(2, 12)
    expect(candidate.score.curvaturePenalty).toBe(0)
    expect(candidate.score.unsupportedTravelPenalty).toBe(0)
    expect(candidate.score.ambiguityPenalty).toBeCloseTo(3 * ambiguity, 12)
    expect(candidate.score.representedOverlapPenalty).toBeCloseTo(1, 12)
  })

  it('resamples overlap scoring with exact geometric segment directions', () => {
    const source = field(13, 13, (x, y) => ({
      evidence: gaussian(y - (6 + 1.2 * (x - 6))),
      tangent: [1, 0],
    }))
    const start = anchor(source, [6, 6])
    const searchOptions = {
      ...OPTIONS,
      ridgeStepOptions: { stepLength: 0.125 },
    }
    const baseline = searchFlowingContoursCandidate(
      source,
      start,
      searchOptions,
      limits(),
    )
    expect(baseline).not.toBeNull()

    const expected: Array<{
      readonly point: Readonly<Point>
      readonly tangent: Readonly<Point>
    }> = []
    for (let index = 1; index < baseline!.samples.length; index += 1) {
      const first = baseline!.samples[index - 1]!.point
      const second = baseline!.samples[index]!.point
      const dx = second[0] - first[0]
      const dy = second[1] - first[1]
      const length = Math.hypot(dx, dy)
      const tangent = Object.freeze([dx / length, dy / length]) as Point
      if (index === 1) {
        expected.push({ point: first, tangent })
      }
      const intervalCount = Math.max(1, Math.ceil(length / 0.25))
      for (
        let sampleIndex = 1;
        sampleIndex <= intervalCount;
        sampleIndex += 1
      ) {
        const parameter = sampleIndex / intervalCount
        expected.push({
          point: Object.freeze([
            first[0] + dx * parameter,
            first[1] + dy * parameter,
          ]),
          tangent,
        })
      }
    }
    expect(
      expected.some(({ tangent }) => Math.abs(tangent[1]) > 0.1),
    ).toBe(true)

    const callbacks: Array<{
      readonly point: Readonly<Point>
      readonly tangent: Readonly<Point>
    }> = []
    const candidate = searchFlowingContoursCandidate(
      source,
      start,
      {
        ...searchOptions,
        representedOverlapSampler(point, travelTangent) {
          callbacks.push({ point, tangent: travelTangent })
          return 0
        },
      },
      limits(),
    )
    expect(candidate).not.toBeNull()
    const scoringCallbacks = callbacks.slice(-expected.length)

    expect(scoringCallbacks).toHaveLength(expected.length)
    for (let index = 0; index < expected.length; index += 1) {
      expect(scoringCallbacks[index]!.point).toEqual(expected[index]!.point)
      expect(scoringCallbacks[index]!.tangent).toEqual(
        expected[index]!.tangent,
      )
      expect(Object.isFrozen(scoringCallbacks[index]!.tangent)).toBe(true)
      expect(Math.hypot(...scoringCallbacks[index]!.tangent)).toBeCloseTo(
        1,
        12,
      )
    }
    expect(candidate!.score.representedOverlapPenalty).toBe(0)
    expect(candidate!.length).toBe(baseline!.length)
  })

  it('is deterministic, fails malformed inputs and sampler traps closed', () => {
    const source = field(13, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const start = anchor(source, [6, 4])
    const first = searchFlowingContoursCandidate(
      source,
      start,
      OPTIONS,
      limits(),
    )
    const second = searchFlowingContoursCandidate(
      source,
      start,
      OPTIONS,
      limits(),
    )
    const malformed = {
      ...source,
      tangentX: Object.freeze(
        source.tangentX.map((value, index) =>
          index === 0 ? Number.NaN : value,
        ),
      ),
    }

    expect(second).toEqual(first)
    expect(
      searchFlowingContoursCandidate(malformed, start, OPTIONS, limits()),
    ).toBeNull()
    expect(
      searchFlowingContoursCandidate(
        source,
        start,
        {
          ...OPTIONS,
          representedOverlapSampler: () => {
            throw new Error('trap')
          },
        },
        limits(),
      ),
    ).toBeNull()
    expect(
      searchFlowingContoursCandidate(
        source,
        { ...start, fieldSampleIndex: -1 },
        OPTIONS,
        limits(),
      ),
    ).toBeNull()
    expect(
      searchFlowingContoursCandidate(
        source,
        { ...start, fieldSampleIndex: start.fieldSampleIndex + 1 },
        OPTIONS,
        limits(),
      ),
    ).toBeNull()
    expect(
      searchFlowingContoursCandidate(
        source,
        {
          ...start,
          sample: {
            ...start.sample,
            evidence: start.sample.evidence * 0.5,
          },
        },
        OPTIONS,
        limits(),
      ),
    ).toBeNull()
  })

  it.each([
    {
      name: 'one-shot throw',
      sampler: (() => {
        let first = true
        return () => {
          if (first) {
            first = false
            throw new Error('one shot')
          }
          return 0
        }
      })(),
    },
    { name: 'NaN', sampler: () => Number.NaN },
    { name: 'negative', sampler: () => -0.1 },
    { name: 'above one', sampler: () => 1.1 },
  ])('remembers an invalid overlap sample after $name', ({ sampler }) => {
    const source = field(13, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))

    expect(
      searchFlowingContoursCandidate(
        source,
        anchor(source, [6, 4]),
        { ...OPTIONS, representedOverlapSampler: sampler },
        limits(),
      ),
    ).toBeNull()
  })

  it('rejects oversized alternatives before reading hostile elements', () => {
    const source = field(13, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    let elementRead = false
    const oversized = new Array<Readonly<Point>>(4)
    Object.defineProperty(oversized, 0, {
      get() {
        elementRead = true
        throw new Error('must not read')
      },
    })

    expect(
      searchFlowingContoursCandidate(
        source,
        anchor(source, [6, 4]),
        { ...OPTIONS, directionAlternatives: oversized },
        limits(),
      ),
    ).toBeNull()
    expect(elementRead).toBe(false)
  })

  it('exposes no endpoint-joining or nearest-endpoint API', async () => {
    const module = await import('../sketches/flowing-contours/search')
    expect(Object.keys(module)).toEqual([
      'flowingContoursCandidateSourceField',
      'searchFlowingContoursCandidateDetailed',
      'searchFlowingContoursCandidate',
    ])
  })
})
