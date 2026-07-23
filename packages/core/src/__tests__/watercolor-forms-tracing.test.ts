import { describe, expect, it } from 'vitest'
import {
  traceWatercolorBoundaryNetwork,
  type WatercolorBoundaryTracingResult,
} from '../sketches/watercolor-forms/tracing'
import type { SharedBoundarySegment } from '../sketches/watercolor-forms/types'
import type { Point } from '../types'

function segment(
  id: number,
  start: Readonly<Point>,
  end: Readonly<Point>,
  regionIds: readonly [number, number] = [1, 2],
  strength = 0.5,
  provenance: SharedBoundarySegment['provenance'] = 'visible-color',
): Readonly<SharedBoundarySegment> {
  return Object.freeze({
    id,
    regionIds,
    start,
    end,
    strength,
    provenance,
  })
}

function consumedIds(
  result: Readonly<WatercolorBoundaryTracingResult>,
): number[] {
  return result.paths
    .flatMap((path) => path.boundarySegmentIds)
    .slice()
    .sort((first, second) => first - second)
}

describe('Watercolor Forms shared-boundary tracing', () => {
  it('traces a line once in canonical direction and reports conservation', () => {
    const result = traceWatercolorBoundaryNetwork([
      segment(12, [2, 0], [1, 0]),
      segment(4, [0, 0], [1, 0]),
    ])

    expect(result.paths).toEqual([
      {
        points: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        closed: false,
        boundarySegmentIds: [4, 12],
      },
    ])
    expect(result.diagnostics).toMatchObject({
      termination: 'complete',
      validSegmentCount: 2,
      consumedSegmentCount: 2,
      boundaryPathCount: 1,
    })
  })

  it('emits a ring as an explicit closed cycle without a repeated terminal point', () => {
    const result = traceWatercolorBoundaryNetwork([
      segment(8, [1, 1], [0, 1]),
      segment(5, [0, 0], [1, 0]),
      segment(2, [0, 1], [0, 0]),
      segment(9, [1, 0], [1, 1]),
    ])

    expect(result.paths).toEqual([
      {
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        closed: true,
        boundarySegmentIds: [5, 9, 8, 2],
      },
    ])
    expect(result.paths[0]!.points[0]).not.toBe(
      result.paths[0]!.points.at(-1),
    )
    expect(consumedIds(result)).toEqual([2, 5, 8, 9])
  })

  it('continues only the unambiguous straight arms of a T junction', () => {
    const result = traceWatercolorBoundaryNetwork([
      segment(3, [1, 1], [1, 0]),
      segment(2, [1, 1], [2, 1]),
      segment(1, [0, 1], [1, 1]),
    ])

    expect(result.paths).toEqual([
      {
        points: [
          [1, 0],
          [1, 1],
        ],
        closed: false,
        boundarySegmentIds: [3],
      },
      {
        points: [
          [0, 1],
          [1, 1],
          [2, 1],
        ],
        closed: false,
        boundarySegmentIds: [1, 2],
      },
    ])
  })

  it('pairs an X junction into its two mutual-best straight continuations', () => {
    const result = traceWatercolorBoundaryNetwork([
      segment(40, [1, 1], [1, 2]),
      segment(30, [1, 1], [2, 1]),
      segment(20, [1, 0], [1, 1]),
      segment(10, [0, 1], [1, 1]),
    ])

    expect(result.paths.map((path) => path.points)).toEqual([
      [
        [1, 0],
        [1, 1],
        [1, 2],
      ],
      [
        [0, 1],
        [1, 1],
        [2, 1],
      ],
    ])
    expect(consumedIds(result)).toEqual([10, 20, 30, 40])
  })

  it('stops all arms at an exactly ambiguous Y junction', () => {
    const center: Point = [0, 0]
    const atAngle = (degrees: number): Point => {
      const radians = (degrees * Math.PI) / 180
      return [Math.cos(radians), Math.sin(radians)]
    }
    const result = traceWatercolorBoundaryNetwork([
      segment(1, center, atAngle(90)),
      segment(2, center, atAngle(210)),
      segment(3, center, atAngle(330)),
    ])

    expect(result.paths).toHaveLength(3)
    expect(result.paths.every((path) => path.points.length === 2)).toBe(true)
    expect(consumedIds(result)).toEqual([1, 2, 3])
  })

  it('accepts a clear unequal best continuation but rejects a near tie', () => {
    const center: Point = [0, 0]
    const atAngle = (degrees: number): Point => {
      const radians = (degrees * Math.PI) / 180
      return [Math.cos(radians), Math.sin(radians)]
    }
    const unequal = traceWatercolorBoundaryNetwork([
      segment(1, center, atAngle(180)),
      segment(2, center, atAngle(0)),
      segment(3, center, atAngle(20)),
    ])
    const nearTie = traceWatercolorBoundaryNetwork([
      segment(1, center, atAngle(180)),
      segment(2, center, atAngle(-0.4)),
      segment(3, center, atAngle(0.4)),
    ])

    expect(
      unequal.paths.map((path) => path.boundarySegmentIds.length).sort(),
    ).toEqual([1, 2])
    expect(nearTie.paths).toHaveLength(3)
    expect(
      nearTie.paths.every((path) => path.boundarySegmentIds.length === 1),
    ).toBe(true)
  })

  it('does not connect touching segments from incompatible region interfaces', () => {
    const result = traceWatercolorBoundaryNetwork([
      segment(1, [0, 0], [1, 0], [1, 2]),
      segment(2, [1, 0], [2, 0], [1, 3]),
    ])

    expect(result.paths).toHaveLength(2)
    expect(result.paths.map((path) => path.boundarySegmentIds)).toEqual([
      [1],
      [2],
    ])
  })

  it('orders disconnected paths canonically and ignores source order', () => {
    const source = [
      segment(9, [8, 2], [9, 2]),
      segment(7, [4, 1], [3, 1]),
      segment(3, [0, 1], [1, 1]),
    ]
    const expected = traceWatercolorBoundaryNetwork(source)

    expect(expected.paths.map((path) => path.points)).toEqual([
      [
        [0, 1],
        [1, 1],
      ],
      [
        [3, 1],
        [4, 1],
      ],
      [
        [8, 2],
        [9, 2],
      ],
    ])
    expect(traceWatercolorBoundaryNetwork([...source].reverse())).toEqual(
      expected,
    )
  })

  it('collapses exact duplicates, rejects malformed and conflicting records, and conserves valid uniques', () => {
    const repeated = segment(3, [0, 0], [1, 0])
    const malformed = {
      ...segment(7, [1, 0], [2, 0]),
      strength: Number.NaN,
    } as unknown as SharedBoundarySegment
    const conflictingIdentity = segment(3, [1, 0], [2, 0])
    const result = traceWatercolorBoundaryNetwork([
      repeated,
      { ...repeated, start: repeated.end, end: repeated.start },
      malformed,
      conflictingIdentity,
      segment(9, [4, 0], [5, 0]),
    ])

    expect(result.paths).toEqual([
      {
        points: [
          [4, 0],
          [5, 0],
        ],
        closed: false,
        boundarySegmentIds: [9],
      },
    ])
    expect(result.diagnostics).toMatchObject({
      inputSegmentCount: 5,
      validSegmentCount: 1,
      duplicateSegmentCount: 0,
      invalidSegmentCount: 4,
      consumedSegmentCount: 1,
      termination: 'complete',
    })
  })

  it('collapses exact duplicate geometry with different IDs to its canonical ID', () => {
    const result = traceWatercolorBoundaryNetwork([
      segment(8, [1, 0], [0, 0]),
      segment(2, [0, 0], [1, 0]),
    ])

    expect(consumedIds(result)).toEqual([2])
    expect(result.diagnostics).toMatchObject({
      validSegmentCount: 1,
      duplicateSegmentCount: 1,
      invalidSegmentCount: 0,
    })
  })

  it('takes a stable canonical segment prefix at the retained-segment cap', () => {
    const source = [
      segment(9, [9, 0], [10, 0]),
      segment(2, [2, 0], [3, 0]),
      segment(5, [5, 0], [6, 0]),
    ]
    const limits = { maxRetainedBoundarySegmentCount: 2 }
    const first = traceWatercolorBoundaryNetwork(source, limits)
    const shuffled = traceWatercolorBoundaryNetwork(
      [source[2]!, source[0]!, source[1]!],
      limits,
    )

    expect(first).toEqual(shuffled)
    expect(consumedIds(first)).toEqual([2, 5])
    expect(first.diagnostics).toMatchObject({
      termination: 'limit-reached',
      limitedBy: 'maxRetainedBoundarySegmentCount',
      validSegmentCount: 3,
      consumedSegmentCount: 2,
    })
  })

  it('does not let a segment cap hide a near tie and invent a continuation', () => {
    const center: Point = [0, 0]
    const atAngle = (degrees: number): Point => {
      const radians = (degrees * Math.PI) / 180
      return [Math.cos(radians), Math.sin(radians)]
    }
    const result = traceWatercolorBoundaryNetwork(
      [
        segment(1, center, [-1, 0]),
        segment(2, center, atAngle(-0.4)),
        segment(3, center, atAngle(0.4)),
      ],
      { maxRetainedBoundarySegmentCount: 2 },
    )

    expect(result.paths.map((path) => path.boundarySegmentIds)).toEqual([
      [2],
      [1],
    ])
    expect(result.diagnostics).toMatchObject({
      termination: 'limit-reached',
      limitedBy: 'maxRetainedBoundarySegmentCount',
      validSegmentCount: 3,
      consumedSegmentCount: 2,
    })
  })

  it('bounds work at an adversarial overfull junction and stops every arm', () => {
    const center: Point = [0, 0]
    const source = Array.from({ length: 2_000 }, (_, index) => {
      const radians = (index * Math.PI * 2) / 2_000
      return segment(index, center, [
        Math.cos(radians),
        Math.sin(radians),
      ])
    })
    const result = traceWatercolorBoundaryNetwork(source)

    expect(result.paths).toHaveLength(2_000)
    expect(
      result.paths.every((path) => path.boundarySegmentIds.length === 1),
    ).toBe(true)
    expect(result.diagnostics).toMatchObject({
      termination: 'complete',
      validSegmentCount: 2_000,
      overfullVertexCount: 1,
      consumedSegmentCount: 2_000,
    })
  })

  it('normalizes signed zero before duplicate selection and output', () => {
    const first = segment(1, [-0, 1], [2, 0])
    const duplicate = segment(1, [2, -0], [0, 1])
    const forward = traceWatercolorBoundaryNetwork([first, duplicate])
    const reversed = traceWatercolorBoundaryNetwork([duplicate, first])

    expect(forward).toEqual(reversed)
    expect(forward.diagnostics.duplicateSegmentCount).toBe(1)
    for (const point of forward.paths[0]!.points) {
      expect(Object.is(point[0], -0)).toBe(false)
      expect(Object.is(point[1], -0)).toBe(false)
    }
  })

  it('returns a stable partial path prefix and honest conservation at the path cap', () => {
    const result = traceWatercolorBoundaryNetwork(
      [
        segment(1, [0, 0], [1, 0]),
        segment(2, [3, 0], [4, 0]),
        segment(3, [6, 0], [7, 0]),
      ],
      { maxBoundaryPathCount: 2 },
    )

    expect(result.paths.map((path) => path.boundarySegmentIds)).toEqual([
      [1],
      [2],
    ])
    expect(result.diagnostics).toMatchObject({
      termination: 'limit-reached',
      limitedBy: 'maxBoundaryPathCount',
      validSegmentCount: 3,
      consumedSegmentCount: 2,
      boundaryPathCount: 2,
    })
  })

  it('fails closed for an invalid outer input or invalid limit policy', () => {
    const invalidInput = traceWatercolorBoundaryNetwork(
      null as unknown as readonly SharedBoundarySegment[],
    )
    const invalidLimit = traceWatercolorBoundaryNetwork(
      [segment(1, [0, 0], [1, 0])],
      { maxBoundaryPathCount: -1 },
    )

    expect(invalidInput.diagnostics.termination).toBe('invalid-input')
    expect(invalidInput.paths).toEqual([])
    expect(invalidLimit.diagnostics).toMatchObject({
      termination: 'invalid-input',
      inputSegmentCount: 1,
      invalidSegmentCount: 1,
    })
    expect(invalidLimit.paths).toEqual([])
  })
})
