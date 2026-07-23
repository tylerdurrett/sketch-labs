import { describe, expect, it } from 'vitest'

import { sampleFlowingContoursField } from '../sketches/flowing-contours/field'
import { createFlowingContoursTestLimits } from '../sketches/flowing-contours/limits'
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
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze(new Array<number>(count).fill(0.5)),
    alpha: Object.freeze(new Array<number>(count).fill(1)),
    positiveSupport: Object.freeze(new Array<boolean>(count).fill(true)),
    contourEvidence: Object.freeze(new Array<number>(count).fill(1)),
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
  accepted: AcceptedFlowingTrajectory,
) {
  const initial = createFlowingContoursSuppressionState({ field: source })
  if (initial === null) throw new Error('fixture field must be valid')
  const registration = registerAcceptedFlowingTrajectorySuppression(
    initial,
    source,
    Object.freeze({
      kind: 'accepted',
      trajectory: accepted,
      safetyTruncated: false,
    }),
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
  accepted: AcceptedFlowingTrajectory,
) {
  const registration = registerAcceptedFlowingTrajectorySuppression(
    state,
    source,
    Object.freeze({
      kind: 'accepted' as const,
      trajectory: accepted,
      safetyTruncated: false,
    }),
  )
  if (registration === null) throw new Error('fixture registration failed')
  return registration
}

describe('Flowing Contours accepted-geometry suppression', () => {
  it('represents a duplicate on the same continuous ridge', () => {
    const source = field()
    const accepted = trajectory(source, [
      [1, 4],
      [5, 4],
      [10, 4],
    ])
    const { result } = commit(source, accepted)
    const query = queryFor(result.state, source)

    expect(queryFlowingContoursSuppression(query, [5.375, 4])).toBe(0.65)
    expect(
      queryFlowingContoursSuppressionAlongTangent(query, [5.375, 4], [1, 0]),
    ).toBeGreaterThanOrEqual(0.7)
    expect(
      isFlowingContoursAnchorSuppressed(query, anchor(source, [5, 4])),
    ).toBe(true)

    const duplicateTrajectory = trajectory(
      source,
      [
        [1, 4],
        [5, 4],
        [10, 4],
      ],
      1,
    )
    const duplicate = commitAcceptedFlowingTrajectorySuppression(
      result.state,
      register(result.state, source, duplicateTrajectory),
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
    const { result } = commit(
      source,
      trajectory(source, [
        [1, 4],
        [10, 4],
      ]),
    )
    const query = queryFor(result.state, source)

    expect(
      queryFlowingContoursSuppressionAlongTangent(query, [5, 4.8], [1, 0]),
    ).toBe(0)
    expect(
      isFlowingContoursAnchorSuppressed(query, anchor(source, [5, 5])),
    ).toBe(false)
  })

  it('lets a perpendicular contour traverse a represented crossing', () => {
    const source = field()
    const { result } = commit(
      source,
      trajectory(source, [
        [1, 4],
        [10, 4],
      ]),
    )
    const query = queryFor(result.state, source)

    expect(
      queryFlowingContoursSuppressionAlongTangent(query, [5, 4], [0, 1]),
    ).toBeLessThan(0.7)
    expect(
      queryFlowingContoursSuppressionAlongTangent(query, [5, 4], [1, 0]),
    ).toBeGreaterThanOrEqual(0.7)
    expect(
      queryFlowingContoursSuppressionAlongTangent(query, [5, 4.3], [0, 1]),
    ).toBe(0)
    expect(
      queryFlowingContoursSuppressionAlongTangent(query, [5, 7], [0, 1]),
    ).toBe(0)
    expect(queryFlowingContoursSuppression(query, [5, 4])).toBeLessThan(0.7)
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
        // @ts-expect-error rejected results cannot be registered
        rejected,
      ),
    ).toBeNull()
    expect(initial.occupancySampleCount).toBe(0)
    expect(initial.suppressedEvidenceSampleCount).toBe(0)
  })

  it('provides bounded scalar collision queries for growth and search', () => {
    const source = field()
    const { result } = commit(
      source,
      trajectory(source, [
        [1, 4],
        [10, 4],
      ]),
    )
    const query = queryFor(result.state, source)
    const center = queryFlowingContoursSuppression(query, [5, 4.2])
    const edge = queryFlowingContoursSuppression(query, [5, 4.5])

    expect(center).toBeGreaterThan(0)
    expect(center).toBeLessThanOrEqual(1)
    expect(edge).toBeGreaterThanOrEqual(0)
    expect(edge).toBeLessThan(center!)
    expect(queryFlowingContoursSuppression(query, [5, 8])).toBe(0)
  })

  it('composes occupancy as a stable union regardless of accepted order', () => {
    const source = field()
    const horizontal = trajectory(source, [
      [1, 3],
      [10, 3],
    ])
    const lower = trajectory(
      source,
      [
        [1, 6],
        [10, 6],
      ],
      1,
    )
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
    const firstTrajectory = trajectory(firstField, [
      [1, 4],
      [10, 4],
    ])
    const committed = commitAcceptedFlowingTrajectorySuppression(
      firstState,
      register(firstState, firstField, firstTrajectory),
    )
    if (committed.kind !== 'committed') throw new Error('fixture commit failed')
    const secondRegistration = register(
      secondState,
      secondField,
      trajectory(secondField, [
        [1, 4],
        [10, 4],
      ]),
    )
    const firstQuery = queryFor(committed.state, firstField)
    const secondQuery = queryFor(secondState, secondField)

    expect(committed.state.field).toBe(firstField)
    expect(secondState.field).toBe(secondField)
    expect(queryFlowingContoursSuppression(firstQuery, [5, 4])).toBe(0.65)
    expect(queryFlowingContoursSuppression(secondQuery, [5, 4])).toBe(0)
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
      queryFlowingContoursSuppression({ ...firstQuery }, [5, 4]),
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
    const registration = registerAcceptedFlowingTrajectorySuppression(
      initial,
      source,
      Object.freeze({
        kind: 'accepted',
        trajectory: revocable.proxy,
        safetyTruncated: false,
      }),
    )
    expect(registration).not.toBeNull()
    revocable.revoke()
    expect(
      commitAcceptedFlowingTrajectorySuppression(initial, registration!),
    ).toMatchObject({ kind: 'committed' })
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
    const occupancyTrajectory = trajectory(source, [
      [1, 4],
      [3, 4],
    ])
    const occupancyResult = commitAcceptedFlowingTrajectorySuppression(
      occupancyState,
      register(occupancyState, source, occupancyTrajectory),
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
      Object.freeze({
        kind: 'accepted',
        trajectory: trajectory(source, [
          [1, 4],
          [2, 4],
          [3, 4],
        ]),
        safetyTruncated: false,
      }),
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
      trajectory(source, [
        [1, 4],
        [10, 4],
      ]),
    )

    expect(Object.isFrozen(initial)).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.state)).toBe(true)
    expect(initial.occupancySampleCount).toBe(0)
    expect(initial.suppressedEvidenceSampleCount).toBe(0)
    expect(result.suppressedEvidenceSampleCount).toBe(10)
    expect(result.state.suppressedEvidenceSampleCount).toBe(10)
    expect(result.state.occupancySampleCount).toBe(37)
  })
})
