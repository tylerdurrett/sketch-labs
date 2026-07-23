import { describe, expect, it } from 'vitest'

import {
  createFlowingContoursAccounting,
  incrementFlowingContoursEndpointCount,
  recordFlowingContoursUnsupportedSpan,
  snapshotFlowingContoursDiagnostics,
  terminateFlowingContoursAtSafetyLimit,
} from '../sketches/flowing-contours/accounting'
import {
  canConsumeFlowingContoursLimit,
  createFlowingContoursTestLimits,
  FLOWING_CONTOURS_LIMITS,
  isWithinFlowingContoursLimit,
} from '../sketches/flowing-contours/limits'
import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
  FLOWING_CONTOURS_LIMIT_NAMES,
} from '../sketches/flowing-contours/types'

describe('Flowing Contours limits', () => {
  it('publishes a positive finite cap for every stable limit name', () => {
    expect(Object.keys(FLOWING_CONTOURS_LIMITS)).toEqual(
      FLOWING_CONTOURS_LIMIT_NAMES,
    )
    expect(Object.isFrozen(FLOWING_CONTOURS_LIMITS)).toBe(true)

    for (const name of FLOWING_CONTOURS_LIMIT_NAMES) {
      const cap = FLOWING_CONTOURS_LIMITS[name]
      expect(cap).toBeGreaterThan(0)
      expect(Number.isFinite(cap)).toBe(true)
      expect(isWithinFlowingContoursLimit(name, cap)).toBe(true)
      expect(
        isWithinFlowingContoursLimit(
          name,
          cap + (name === 'weak-span-distance' ? 0.25 : 1),
        ),
      ).toBe(false)
    }
  })

  it('makes the derived work and output relationships explicit', () => {
    const limits = FLOWING_CONTOURS_LIMITS
    expect(limits['analysis-dimension']).toBe(256)
    expect(limits['analysis-sample-count']).toBe(65_536)
    expect(limits['analysis-sample-count']).toBe(
      limits['analysis-dimension'] ** 2,
    )
    expect(limits['anchor-count']).toBeLessThanOrEqual(
      limits['analysis-sample-count'],
    )
    expect(limits['candidate-count']).toBe(limits['anchor-count'])
    expect(limits['accepted-curve-count']).toBeLessThan(
      limits['candidate-count'],
    )
    expect(limits['primitive-count']).toBe(limits['accepted-curve-count'])
    expect(limits['fitted-curve-point-count']).toBe(
      limits['raw-trajectory-point-count'],
    )
  })

  it('checks complete inventories and prospective increments at exact caps', () => {
    const name = 'anchor-count'
    const cap = FLOWING_CONTOURS_LIMITS[name]

    expect(isWithinFlowingContoursLimit(name, cap)).toBe(true)
    expect(isWithinFlowingContoursLimit(name, cap + 1)).toBe(false)
    expect(canConsumeFlowingContoursLimit(name, cap - 1)).toBe(true)
    expect(canConsumeFlowingContoursLimit(name, cap)).toBe(false)
    expect(canConsumeFlowingContoursLimit(name, 0, -1)).toBe(false)
    expect(canConsumeFlowingContoursLimit(name, 0, 0.5)).toBe(false)
    expect(isWithinFlowingContoursLimit(name, Number.NaN)).toBe(false)
  })

  it('allows bounded fractional weak distance but not fractional counts', () => {
    const limits = createFlowingContoursTestLimits({
      'weak-span-distance': 0.5,
      'weak-span-step-count': 2,
    })
    expect(limits).not.toBeNull()
    expect(
      canConsumeFlowingContoursLimit(
        'weak-span-distance',
        0.25,
        0.25,
        limits!,
      ),
    ).toBe(true)
    expect(
      canConsumeFlowingContoursLimit(
        'weak-span-step-count',
        0,
        0.5,
        limits!,
      ),
    ).toBe(false)
  })

  it('keeps test overrides bounded and fails malformed policies closed', () => {
    const lowered = createFlowingContoursTestLimits({
      'candidate-count': 2,
    })
    expect(lowered?.['candidate-count']).toBe(2)
    expect(Object.isFrozen(lowered)).toBe(true)
    expect(
      canConsumeFlowingContoursLimit('candidate-count', 2, 1, lowered!),
    ).toBe(false)

    expect(
      createFlowingContoursTestLimits({
        'candidate-count':
          FLOWING_CONTOURS_LIMITS['candidate-count'] + 1,
      }),
    ).toBeNull()
    expect(
      createFlowingContoursTestLimits({ 'candidate-count': Infinity }),
    ).toBeNull()
    expect(
      createFlowingContoursTestLimits({ 'candidate-count': Number.NaN }),
    ).toBeNull()
    expect(
      createFlowingContoursTestLimits({ 'candidate-count': 1.5 }),
    ).toBeNull()
    expect(createFlowingContoursTestLimits({ unknown: 1 })).toBeNull()
    expect(createFlowingContoursTestLimits(null)).toBeNull()
    expect(
      createFlowingContoursTestLimits({
        get ['candidate-count']() {
          return 1
        },
      }),
    ).toBeNull()

    const unchecked = {
      ...FLOWING_CONTOURS_LIMITS,
      'candidate-count': Infinity,
    }
    expect(
      isWithinFlowingContoursLimit('candidate-count', 1, unchecked),
    ).toBe(false)
  })

  it('never invokes hostile policy accessors and fails descriptor traps closed', () => {
    let statefulAccessCount = 0
    const statefulAccessor = {
      get ['candidate-count']() {
        statefulAccessCount += 1
        return statefulAccessCount === 1 ? 2 : Infinity
      },
    } as unknown as typeof FLOWING_CONTOURS_LIMITS
    const throwingAccessor = {
      get ['candidate-count'](): number {
        throw new Error('must not execute')
      },
    } as unknown as typeof FLOWING_CONTOURS_LIMITS
    const descriptorTrap = new Proxy(
      { ...FLOWING_CONTOURS_LIMITS },
      {
        getOwnPropertyDescriptor() {
          throw new Error('hostile descriptor trap')
        },
      },
    )

    for (const policy of [
      statefulAccessor,
      throwingAccessor,
      descriptorTrap,
    ]) {
      expect(
        isWithinFlowingContoursLimit('candidate-count', 1, policy),
      ).toBe(false)
      expect(
        canConsumeFlowingContoursLimit('candidate-count', 0, 1, policy),
      ).toBe(false)
    }
    expect(statefulAccessCount).toBe(0)
  })
})

describe('Flowing Contours accounting', () => {
  it('initializes the complete diagnostic inventory to a valid empty result', () => {
    const accounting = createFlowingContoursAccounting()

    expect(accounting.termination).toBe('complete')
    expect(accounting.limitedBy).toBeNull()
    expect(Object.keys(accounting.endpointReasonCounts)).toEqual(
      FLOWING_CONTOURS_ENDPOINT_REASONS,
    )
    expect(Object.values(accounting.endpointReasonCounts)).toEqual(
      FLOWING_CONTOURS_ENDPOINT_REASONS.map(() => 0),
    )
    expect(accounting).toEqual({
      ...accounting,
      analysisWidth: 0,
      analysisHeight: 0,
      analysisSampleCount: 0,
      contourEvidenceSampleCount: 0,
      correctedRidgeSampleCount: 0,
      eligibleAnchorCount: 0,
      processedAnchorCount: 0,
      directionalTraceCount: 0,
      searchStepCount: 0,
      candidateCount: 0,
      acceptedCandidateCount: 0,
      rejectedCandidateCount: 0,
      suppressedAnchorCount: 0,
      suppressedEvidenceSampleCount: 0,
      rawTrajectoryCount: 0,
      rawTrajectoryPointCount: 0,
      acceptedMaximumUnsupportedSpanLength: 0,
      acceptedTotalUnsupportedSpanLength: 0,
      fittedCurveCount: 0,
      fittedCurvePointCount: 0,
      primitiveCount: 0,
    })
  })

  it('increments exact endpoint counts monotonically without partial failure', () => {
    const accounting = createFlowingContoursAccounting()

    expect(
      incrementFlowingContoursEndpointCount(
        accounting,
        'source-boundary',
        2,
      ),
    ).toBe(true)
    expect(
      incrementFlowingContoursEndpointCount(accounting, 'ambiguity'),
    ).toBe(true)
    expect(accounting.endpointReasonCounts['source-boundary']).toBe(2)
    expect(accounting.endpointReasonCounts.ambiguity).toBe(1)

    expect(
      incrementFlowingContoursEndpointCount(
        accounting,
        'source-boundary',
        -1,
      ),
    ).toBe(false)
    expect(
      incrementFlowingContoursEndpointCount(
        accounting,
        'source-boundary',
        Number.POSITIVE_INFINITY,
      ),
    ).toBe(false)
    expect(accounting.endpointReasonCounts['source-boundary']).toBe(2)
  })

  it('aggregates maximum and total accepted unsupported travel exactly', () => {
    const accounting = createFlowingContoursAccounting()

    expect(recordFlowingContoursUnsupportedSpan(accounting, 1.25)).toBe(true)
    expect(recordFlowingContoursUnsupportedSpan(accounting, 0.5)).toBe(true)
    expect(recordFlowingContoursUnsupportedSpan(accounting, 2)).toBe(true)
    expect(accounting.acceptedMaximumUnsupportedSpanLength).toBe(2)
    expect(accounting.acceptedTotalUnsupportedSpanLength).toBe(3.75)

    expect(
      recordFlowingContoursUnsupportedSpan(accounting, Number.NaN),
    ).toBe(false)
    expect(recordFlowingContoursUnsupportedSpan(accounting, -1)).toBe(false)
    expect(accounting.acceptedMaximumUnsupportedSpanLength).toBe(2)
    expect(accounting.acceptedTotalUnsupportedSpanLength).toBe(3.75)
  })

  it('returns detached immutable snapshots', () => {
    const accounting = createFlowingContoursAccounting()
    accounting.analysisWidth = 12
    incrementFlowingContoursEndpointCount(accounting, 'curvature')
    const snapshot = snapshotFlowingContoursDiagnostics(accounting)

    accounting.analysisWidth = 24
    incrementFlowingContoursEndpointCount(accounting, 'curvature')

    expect(snapshot.analysisWidth).toBe(12)
    expect(snapshot.endpointReasonCounts.curvature).toBe(1)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.endpointReasonCounts)).toBe(true)
  })

  it('terminates at the first safety cap and counts exact safety endpoints', () => {
    const accounting = createFlowingContoursAccounting()

    expect(
      terminateFlowingContoursAtSafetyLimit(
        accounting,
        'search-step-count',
        2,
      ),
    ).toBe(true)
    expect(accounting.termination).toBe('limit-reached')
    expect(accounting.limitedBy).toBe('search-step-count')
    expect(accounting.endpointReasonCounts['safety-limit']).toBe(2)

    expect(
      terminateFlowingContoursAtSafetyLimit(
        accounting,
        'search-step-count',
        1,
      ),
    ).toBe(true)
    expect(accounting.endpointReasonCounts['safety-limit']).toBe(3)

    expect(
      terminateFlowingContoursAtSafetyLimit(
        accounting,
        'candidate-count',
        4,
      ),
    ).toBe(false)
    expect(accounting.limitedBy).toBe('search-step-count')
    expect(accounting.endpointReasonCounts['safety-limit']).toBe(3)
  })

  it('does not replace invalid-input termination with a safety result', () => {
    const accounting = createFlowingContoursAccounting()
    accounting.termination = 'invalid-input'

    expect(
      terminateFlowingContoursAtSafetyLimit(
        accounting,
        'analysis-dimension',
        1,
      ),
    ).toBe(false)
    expect(accounting.termination).toBe('invalid-input')
    expect(accounting.limitedBy).toBeNull()
    expect(accounting.endpointReasonCounts['safety-limit']).toBe(0)
  })
})
