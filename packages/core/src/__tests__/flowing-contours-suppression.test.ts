import { describe, expect, it } from 'vitest'

import { createFlowingContoursAccounting } from '../sketches/flowing-contours/accounting'
import { sampleFlowingContoursField } from '../sketches/flowing-contours/field'
import { growFlowingContoursDirection } from '../sketches/flowing-contours/growth'
import { createFlowingContoursTestLimits } from '../sketches/flowing-contours/limits'
import { searchFlowingContoursCandidate } from '../sketches/flowing-contours/search'
import {
  selectFlowingContoursCandidate,
  type FlowingContoursSelectionResult,
} from '../sketches/flowing-contours/selection'
import {
  commitAcceptedFlowingTrajectorySuppression,
  createFlowingContoursSuppressionQuery,
  createFlowingContoursSuppressionState,
  isFlowingContoursAnchorSuppressed,
  queryFlowingContoursSuppression,
  queryFlowingContoursSuppressionAlongTangent,
  registerAcceptedFlowingTrajectorySuppression,
} from '../sketches/flowing-contours/suppression'
import type {
  AcceptedFlowingTrajectory,
  CorrectedFlowingRidgeSample,
  FlowingContoursAnchor,
  FlowingContoursCandidate,
  FlowingContoursField,
  Point,
} from '../sketches/flowing-contours/types'

const SCORE = Object.freeze({
  accumulatedEvidence: 1,
  usefulLength: 1,
  directionalCoherence: 1,
  curvaturePenalty: 0,
  unsupportedTravelPenalty: 0,
  ambiguityPenalty: 0,
  representedOverlapPenalty: 0,
  total: 3,
})

function field(
  width = 12,
  height = 9,
  tangent: readonly [number, number] = [1, 0],
): FlowingContoursField {
  const count = width * height
  const ridgeRows = [2, Math.max(2, height - 3)]
  const contourEvidence = Array.from({ length: count }, (_value, index) => {
    const y = Math.floor(index / width)
    const distance = Math.min(...ridgeRows.map((ridge) => Math.abs(y - ridge)))
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
    contourEvidence: Object.freeze(contourEvidence),
    tangentX: Object.freeze(new Array<number>(count).fill(tangent[0])),
    tangentY: Object.freeze(new Array<number>(count).fill(tangent[1])),
    tangentCoherence: Object.freeze(new Array<number>(count).fill(1)),
    ambiguity: Object.freeze(new Array<number>(count).fill(0)),
    ridgeScale: Object.freeze(new Array<number>(count).fill(1)),
  })
}

function sample(
  source: FlowingContoursField,
  point: readonly [number, number],
): Readonly<CorrectedFlowingRidgeSample> {
  const result = sampleFlowingContoursField(source, point)
  if (result === null) throw new Error('fixture point must be sampleable')
  return result
}

function trajectory(
  source: FlowingContoursField,
  points: readonly (readonly [number, number])[],
  id = 0,
): AcceptedFlowingTrajectory {
  const samples = Object.freeze(points.map((point) => sample(source, point)))
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(
      points[index]![0] - points[index - 1]![0],
      points[index]![1] - points[index - 1]![1],
    )
  }
  return Object.freeze({
    id,
    anchorId: id,
    samples,
    spanSupport: Object.freeze([
      Object.freeze({
        kind: 'direct-evidence' as const,
        startSampleIndex: 0,
        endSampleIndex: samples.length - 1,
        length,
        entryEvidence: samples[0]!.evidence,
        exitEvidence: samples.at(-1)!.evidence,
        directionalAlignment: 1,
      }),
    ]),
    startEndpointReason: 'source-boundary',
    endEndpointReason: 'source-boundary',
    length,
    maximumUnsupportedSpanLength: 0,
    totalUnsupportedSpanLength: 0,
    score: SCORE,
  })
}

function anchor(
  source: FlowingContoursField,
  point: readonly [number, number],
  id = 0,
): FlowingContoursAnchor {
  return Object.freeze({
    id,
    fieldSampleIndex:
      Math.round(point[1]) * source.width + Math.round(point[0]),
    sample: sample(source, point),
  })
}

function commit(
  source: FlowingContoursField,
  selection: Extract<FlowingContoursSelectionResult, { kind: 'accepted' }>,
) {
  const initial = createFlowingContoursSuppressionState({ field: source })
  if (initial === null) throw new Error('fixture field must be valid')
  const registration = registerAcceptedFlowingTrajectorySuppression(
    initial,
    source,
    selection,
  )
  if (registration === null) throw new Error('fixture registration failed')
  const result = commitAcceptedFlowingTrajectorySuppression(
    initial,
    registration,
  )
  if (result.kind !== 'committed') {
    throw new Error(`fixture trajectory rejected: ${result.reason}`)
  }
  return { initial, result }
}

function queryFor(
  state: Parameters<typeof createFlowingContoursSuppressionQuery>[0],
  source: FlowingContoursField,
) {
  const query = createFlowingContoursSuppressionQuery(state, source)
  if (query === null) throw new Error('fixture query binding failed')
  return query
}

function register(
  state: Parameters<typeof registerAcceptedFlowingTrajectorySuppression>[0],
  source: FlowingContoursField,
  selection: Extract<FlowingContoursSelectionResult, { kind: 'accepted' }>,
) {
  const registration = registerAcceptedFlowingTrajectorySuppression(
    state,
    source,
    selection,
  )
  if (registration === null) throw new Error('fixture registration failed')
  return registration
}

function authenticSelection(
  source: FlowingContoursField,
  point: readonly [number, number],
): Extract<FlowingContoursSelectionResult, { kind: 'accepted' }> {
  const candidate = searchFlowingContoursCandidate(
    source,
    anchor(source, point),
    {
      continuity: 0,
      flowSmoothing: 0.5,
    },
  )
  if (candidate === null) throw new Error('fixture search failed')
  const result = selectFlowingContoursCandidate(
    candidate,
    {
      analysisWidth: source.width,
      analysisHeight: source.height,
      minimumStrokeLength: 0,
    },
    createFlowingContoursAccounting(),
  )
  if (result.kind !== 'accepted') {
    throw new Error(`fixture selection rejected: ${result.reason}`)
  }
  return result
}

describe('Flowing Contours accepted-geometry suppression', () => {
  it('represents a duplicate on the same continuous ridge', () => {
    const source = field()
    const accepted = authenticSelection(source, [5, 2])
    const { result } = commit(source, accepted)
    const query = queryFor(result.state, source)

    expect(queryFlowingContoursSuppression(query, [5.375, 2])).toBe(0.65)
    expect(
      queryFlowingContoursSuppressionAlongTangent(query, [5.375, 2], [1, 0]),
    ).toBeGreaterThanOrEqual(0.7)
    expect(
      isFlowingContoursAnchorSuppressed(query, anchor(source, [5, 2])),
    ).toBe(true)

    const duplicateSelection = authenticSelection(source, [5, 2])
    const duplicate = commitAcceptedFlowingTrajectorySuppression(
      result.state,
      register(result.state, source, duplicateSelection),
    )
    expect(duplicate.kind).toBe('committed')
    if (duplicate.kind !== 'committed') return
    expect(duplicate.state.occupancySampleCount).toBe(
      result.state.occupancySampleCount,
    )
    expect(duplicate.suppressedEvidenceSampleCount).toBe(0)
  })

  it('preserves a close distinct parallel ridge beyond the ownership tube', () => {
    const source = field()
    const { result } = commit(source, authenticSelection(source, [5, 2]))
    const query = queryFor(result.state, source)

    expect(
      queryFlowingContoursSuppressionAlongTangent(query, [5, 2.8], [1, 0]),
    ).toBe(0)
    expect(
      isFlowingContoursAnchorSuppressed(query, anchor(source, [5, 3])),
    ).toBe(false)
  })

  it('lets a perpendicular contour traverse a represented crossing', () => {
    const source = field()
    const { result } = commit(source, authenticSelection(source, [5, 2]))
    const query = queryFor(result.state, source)

    expect(
      queryFlowingContoursSuppressionAlongTangent(query, [5, 2], [0, 1]),
    ).toBeLessThan(0.7)
    expect(
      queryFlowingContoursSuppressionAlongTangent(query, [5, 2], [1, 0]),
    ).toBeGreaterThanOrEqual(0.7)
    expect(
      queryFlowingContoursSuppressionAlongTangent(query, [5, 2.3], [0, 1]),
    ).toBe(0)
    expect(
      queryFlowingContoursSuppressionAlongTangent(query, [5, 7], [0, 1]),
    ).toBe(0)
    expect(queryFlowingContoursSuppression(query, [5, 2])).toBeLessThan(0.7)
  })

  it('integrates growth segment direction with crossing-aware occupancy', () => {
    const source = field(13, 9)
    const { result } = commit(source, authenticSelection(source, [5, 2]))
    const query = queryFor(result.state, source)
    const sampler = (
      point: Readonly<Point>,
      travelTangent: Readonly<Point>,
    ): number =>
      queryFlowingContoursSuppressionAlongTangent(
        query,
        point,
        travelTangent,
      ) ?? Number.NaN
    const limits = createFlowingContoursTestLimits({
      'search-step-count': 1,
    })!
    const crossing = growFlowingContoursDirection(
      source,
      sample(source, [5, 1.55]),
      [1, 0],
      'forward',
      {
        continuity: 0,
        flowSmoothing: 0.5,
        ridgeStepOptions: { stepLength: 0.125 },
        representedOverlapSampler: sampler,
      },
      limits,
    )
    const duplicate = growFlowingContoursDirection(
      source,
      sample(source, [5, 2]),
      [1, 0],
      'forward',
      {
        continuity: 0,
        flowSmoothing: 0.5,
        ridgeStepOptions: { stepLength: 0.125 },
        representedOverlapSampler: sampler,
      },
      limits,
    )

    expect(crossing.samples).toHaveLength(2)
    expect(crossing.samples.at(-1)!.point[1]).toBeGreaterThan(1.9)
    expect(crossing.endpointReason).toBe('safety-limit')
    expect(duplicate.samples).toHaveLength(1)
    expect(duplicate.endpointReason).toBe('represented-collision')
  })

  it('can only be committed through the accepted-trajectory contract', () => {
    const source = field()
    const initial = createFlowingContoursSuppressionState({ field: source })!
    const rejected = Object.freeze({
      kind: 'rejected',
      reason: 'below-minimum-length',
    })
    const candidate = {
      anchor: anchor(source, [2, 4]),
      backward: {},
      forward: {},
      samples: [sample(source, [2, 4]), sample(source, [3, 4])],
      spanSupport: [],
      length: 1,
      score: SCORE,
    } as unknown as FlowingContoursCandidate
    const plausibleButUnregistered = trajectory(source, [
      [2, 4],
      [8, 4],
    ])

    expect(
      commitAcceptedFlowingTrajectorySuppression(
        initial,
        // @ts-expect-error rejected selection results are not registrations
        rejected,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid-input' })
    expect(
      commitAcceptedFlowingTrajectorySuppression(
        initial,
        // @ts-expect-error whole candidates are not registrations
        candidate,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid-input' })
    expect(
      commitAcceptedFlowingTrajectorySuppression(
        initial,
        // @ts-expect-error accepted-looking trajectories are not registrations
        plausibleButUnregistered,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid-input' })
    expect(
      commitAcceptedFlowingTrajectorySuppression(initial, {
        field: source,
        trajectoryId: plausibleButUnregistered.id,
        rawSampleCount: plausibleButUnregistered.samples.length,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-input' })
    expect(
      registerAcceptedFlowingTrajectorySuppression(
        initial,
        source,
        Object.freeze({
          kind: 'accepted',
          trajectory: plausibleButUnregistered,
          safetyTruncated: false,
        }),
      ),
    ).toBeNull()
    expect(
      registerAcceptedFlowingTrajectorySuppression(
        initial,
        source,
        // @ts-expect-error rejected results cannot be registered
        rejected,
      ),
    ).toBeNull()
    expect(initial.occupancySampleCount).toBe(0)
    expect(initial.suppressedEvidenceSampleCount).toBe(0)
  })

  it('provides bounded scalar collision queries for growth and search', () => {
    const source = field()
    const { result } = commit(source, authenticSelection(source, [5, 2]))
    const query = queryFor(result.state, source)
    const center = queryFlowingContoursSuppression(query, [5, 2.2])
    const edge = queryFlowingContoursSuppression(query, [5, 2.5])

    expect(center).toBeGreaterThan(0)
    expect(center).toBeLessThanOrEqual(1)
    expect(edge).toBeGreaterThanOrEqual(0)
    expect(edge).toBeLessThan(center!)
    expect(queryFlowingContoursSuppression(query, [5, 8])).toBe(0)
  })

  it('composes occupancy as a stable union regardless of accepted order', () => {
    const source = field()
    const horizontal = authenticSelection(source, [5, 2])
    const lower = authenticSelection(source, [5, 6])
    const startA = createFlowingContoursSuppressionState({ field: source })!
    const firstA = commitAcceptedFlowingTrajectorySuppression(
      startA,
      register(startA, source, horizontal),
    )
    if (firstA.kind !== 'committed') throw new Error('fixture commit failed')
    const secondA = commitAcceptedFlowingTrajectorySuppression(
      firstA.state,
      register(firstA.state, source, lower),
    )
    const startB = createFlowingContoursSuppressionState({ field: source })!
    const firstB = commitAcceptedFlowingTrajectorySuppression(
      startB,
      register(startB, source, lower),
    )
    if (firstB.kind !== 'committed') throw new Error('fixture commit failed')
    const secondB = commitAcceptedFlowingTrajectorySuppression(
      firstB.state,
      register(firstB.state, source, horizontal),
    )

    expect(secondA.kind).toBe('committed')
    expect(secondB.kind).toBe('committed')
    if (secondA.kind !== 'committed' || secondB.kind !== 'committed') return
    expect(secondA.state).toEqual(secondB.state)
    const queryA = queryFor(secondA.state, source)
    const queryB = queryFor(secondB.state, source)
    for (const point of [
      [2.25, 3],
      [7.75, 3.2],
      [4.5, 6],
      [5, 4.5],
    ] as const) {
      expect(queryFlowingContoursSuppression(queryA, point)).toBe(
        queryFlowingContoursSuppression(queryB, point),
      )
      expect(queryFlowingContoursSuppression(queryA, point)).toBe(
        queryFlowingContoursSuppression(queryA, point),
      )
    }
  })

  it('keeps equivalent-looking fields in separate identity domains', () => {
    const firstField = field()
    const secondField = field()
    const firstState = createFlowingContoursSuppressionState({
      field: firstField,
    })!
    const secondState = createFlowingContoursSuppressionState({
      field: secondField,
    })!
    const firstSelection = authenticSelection(firstField, [5, 2])
    const committed = commitAcceptedFlowingTrajectorySuppression(
      firstState,
      register(firstState, firstField, firstSelection),
    )
    if (committed.kind !== 'committed') throw new Error('fixture commit failed')
    const secondRegistration = register(
      secondState,
      secondField,
      authenticSelection(secondField, [5, 2]),
    )
    const firstQuery = queryFor(committed.state, firstField)
    const secondQuery = queryFor(secondState, secondField)

    expect(committed.state.field).toBe(firstField)
    expect(secondState.field).toBe(secondField)
    expect(queryFlowingContoursSuppression(firstQuery, [5, 2])).toBe(0.65)
    expect(queryFlowingContoursSuppression(secondQuery, [5, 2])).toBe(0)
    expect(
      createFlowingContoursSuppressionQuery(committed.state, secondField),
    ).toBeNull()
    expect(
      commitAcceptedFlowingTrajectorySuppression(
        committed.state,
        secondRegistration,
      ),
    ).toEqual({ kind: 'rejected', reason: 'field-mismatch' })
    expect(
      queryFlowingContoursSuppression({ ...firstQuery }, [5, 2]),
    ).toBeNull()
  })

  it('fails closed on hostile and malformed inputs without partial writes', () => {
    const source = field()
    const initial = createFlowingContoursSuppressionState({ field: source })!
    const malformed = {
      ...trajectory(source, [
        [1, 4],
        [10, 4],
      ]),
      length: Number.NaN,
    }
    const before = { ...initial }
    const query = queryFor(initial, source)

    expect(
      registerAcceptedFlowingTrajectorySuppression(
        initial,
        source,
        Object.freeze({
          kind: 'accepted',
          trajectory: malformed as AcceptedFlowingTrajectory,
          safetyTruncated: false,
        }),
      ),
    ).toBeNull()
    expect(initial).toEqual(before)
    expect(queryFlowingContoursSuppression(query, [Number.NaN, 4])).toBeNull()
    expect(
      queryFlowingContoursSuppressionAlongTangent(query, [5, 4], [0, 0]),
    ).toBeNull()
    expect(
      createFlowingContoursSuppressionState(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error('hostile options')
            },
          },
        ) as { field: FlowingContoursField },
      ),
    ).toBeNull()

    const revocable = Proxy.revocable(
      trajectory(source, [
        [1, 4],
        [10, 4],
      ]),
      {
        get() {
          throw new Error('external trajectory may not be reread')
        },
      },
    )
    const hostileRegistration = registerAcceptedFlowingTrajectorySuppression(
      initial,
      source,
      Object.freeze({
        kind: 'accepted',
        trajectory: revocable.proxy,
        safetyTruncated: false,
      }),
    )
    expect(hostileRegistration).toBeNull()
    revocable.revoke()
    expect(initial).toEqual(before)
  })

  it('enforces occupancy and raw-point caps transactionally', () => {
    const source = field()
    const occupancyLimits = createFlowingContoursTestLimits({
      'analysis-sample-count': 4,
    })!
    const occupancyState = createFlowingContoursSuppressionState({
      field: source,
      limits: occupancyLimits,
    })!
    const occupancySelection = authenticSelection(source, [5, 2])
    const occupancyResult = commitAcceptedFlowingTrajectorySuppression(
      occupancyState,
      register(occupancyState, source, occupancySelection),
    )
    const rawLimits = createFlowingContoursTestLimits({
      'raw-trajectory-point-count': 2,
    })!
    const rawState = createFlowingContoursSuppressionState({
      field: source,
      limits: rawLimits,
    })!
    const rawRegistration = registerAcceptedFlowingTrajectorySuppression(
      rawState,
      source,
      authenticSelection(source, [5, 2]),
    )

    expect(occupancyResult).toEqual({
      kind: 'rejected',
      reason: 'occupancy-limit',
    })
    expect(rawRegistration).toBeNull()
    expect(occupancyState.occupancySampleCount).toBe(0)
    expect(rawState.occupancySampleCount).toBe(0)
  })

  it('returns frozen detached snapshots and exact suppression accounting', () => {
    const source = field()
    const { initial, result } = commit(
      source,
      authenticSelection(source, [5, 2]),
    )

    expect(Object.isFrozen(initial)).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.state)).toBe(true)
    expect(initial.occupancySampleCount).toBe(0)
    expect(initial.suppressedEvidenceSampleCount).toBe(0)
    expect(result.suppressedEvidenceSampleCount).toBe(11)
    expect(result.state.suppressedEvidenceSampleCount).toBe(11)
    expect(result.state.occupancySampleCount).toBe(43)
  })
})
