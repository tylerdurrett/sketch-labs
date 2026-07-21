import { describe, expect, it } from 'vitest'

import type { Point } from '../types'
import {
  STIPPLING_VORONOI_REFERENCE_MAX_PAIR_CHECKS,
  stipplingVoronoiReference,
  type StipplingVoronoiReferenceSample,
} from './support/stipplingVoronoiReference'

const FRAME = Object.freeze({ width: 10, height: 10 })

function demandSample(
  point: Readonly<Point>,
  tone: number,
  permission = 1,
): Readonly<StipplingVoronoiReferenceSample> {
  return Object.freeze({ point, weight: tone * permission })
}

describe('small-fixture Stippling Voronoi reference', () => {
  it('hand-calculates flat demand assignment, centroids, and objective for two sites', () => {
    const result = stipplingVoronoiReference(
      FRAME,
      [
        [0, 5],
        [10, 5],
      ],
      [
        demandSample([1, 5], 1),
        demandSample([4, 5], 1),
        demandSample([6, 5], 1),
        demandSample([9, 5], 1),
      ],
    )

    expect(result.assignments).toEqual([0, 0, 1, 1])
    expect(result.cells).toEqual([
      { siteIndex: 0, weight: 2, centroid: [2.5, 5] },
      { siteIndex: 1, weight: 2, centroid: [7.5, 5] },
    ])
    expect(result.totalWeight).toBe(4)
    expect(result.normalizedObjective).toBeCloseTo(34 / (4 * 200), 15)
  })

  it('assigns a symmetric four-site fixture without imposing scanline bias', () => {
    const result = stipplingVoronoiReference(
      { width: 4, height: 4 },
      [
        [1, 1],
        [3, 1],
        [1, 3],
        [3, 3],
      ],
      [
        demandSample([0, 0], 1),
        demandSample([4, 0], 1),
        demandSample([0, 4], 1),
        demandSample([4, 4], 1),
      ],
    )

    expect(result.assignments).toEqual([0, 1, 2, 3])
    expect(result.cells.map((cell) => cell.centroid)).toEqual([
      [0, 0],
      [4, 0],
      [0, 4],
      [4, 4],
    ])
    expect(result.normalizedObjective).toBeCloseTo(1 / 16, 15)
  })

  it('uses ramp demand as weights in each cell centroid', () => {
    const result = stipplingVoronoiReference(
      FRAME,
      [
        [2, 5],
        [8, 5],
      ],
      [
        demandSample([1, 5], 0.1),
        demandSample([3, 5], 0.3),
        demandSample([7, 5], 0.7),
        demandSample([9, 5], 0.9),
      ],
    )

    expect(result.assignments).toEqual([0, 0, 1, 1])
    expect(result.cells[0]!.weight).toBeCloseTo(0.4, 15)
    expect(result.cells[0]!.centroid).toEqual([2.5, 5])
    expect(result.cells[1]!.weight).toBeCloseTo(1.6, 15)
    expect(result.cells[1]!.centroid![0]).toBeCloseTo(8.125, 15)
    expect(result.cells[1]!.centroid![1]).toBe(5)
    expect(result.normalizedObjective).toBeCloseTo(1 / 200, 15)
  })

  it('applies soft permission linearly through effective demand', () => {
    const full = stipplingVoronoiReference(
      FRAME,
      [[5, 5]],
      [demandSample([3, 5], 0.8, 1), demandSample([7, 5], 0.8, 1)],
    )
    const soft = stipplingVoronoiReference(
      FRAME,
      [[5, 5]],
      [demandSample([3, 5], 0.8, 1), demandSample([7, 5], 0.8, 0.25)],
    )

    expect(soft.cells[0]!.weight).toBeCloseTo(1, 15)
    expect(soft.cells[0]!.centroid![0]).toBeCloseTo(3.8, 15)
    expect(soft.totalWeight).toBeCloseTo(full.totalWeight * 0.625, 15)
  })

  it('leaves zero-demand samples unassigned and empty cells without centroids', () => {
    const result = stipplingVoronoiReference(
      FRAME,
      [
        [2, 5],
        [8, 5],
      ],
      [demandSample([2, 5], 0), demandSample([2, 5], 1)],
    )

    expect(result.assignments).toEqual([null, 0])
    expect(result.cells).toEqual([
      { siteIndex: 0, weight: 1, centroid: [2, 5] },
      { siteIndex: 1, weight: 0, centroid: null },
    ])
    expect(result.normalizedObjective).toBe(0)
  })

  it('uses a finite zero convention for zero demand and empty sites', () => {
    const zeroDemand = stipplingVoronoiReference(
      FRAME,
      [[5, 5]],
      [demandSample([4, 5], 0)],
    )
    const noSites = stipplingVoronoiReference(
      FRAME,
      [],
      [demandSample([4, 5], 1)],
    )

    expect(zeroDemand).toMatchObject({
      assignments: [null],
      totalWeight: 0,
      normalizedObjective: 0,
    })
    expect(zeroDemand.cells[0]).toEqual({
      siteIndex: 0,
      weight: 0,
      centroid: null,
    })
    expect(noSites).toEqual({
      assignments: [null],
      cells: [],
      totalWeight: 1,
      normalizedObjective: 0,
    })
    expect(Number.isFinite(zeroDemand.normalizedObjective)).toBe(true)
    expect(Number.isFinite(noSites.normalizedObjective)).toBe(true)
  })

  it('breaks exact distance ties by the lower ordered site index', () => {
    const result = stipplingVoronoiReference(
      FRAME,
      [
        [7, 5],
        [3, 5],
      ],
      [demandSample([5, 5], 1)],
    )

    expect(result.assignments).toEqual([0])
    expect(result.cells.map((cell) => cell.centroid)).toEqual([[5, 5], null])
  })

  it('keeps its objective invariant under proportional frame scaling', () => {
    const solve = (scale: number) =>
      stipplingVoronoiReference(
        { width: 10 * scale, height: 5 * scale },
        [
          [2 * scale, 2 * scale],
          [8 * scale, 2 * scale],
        ],
        [
          demandSample([1 * scale, 1 * scale], 0.25),
          demandSample([4 * scale, 3 * scale], 0.5),
          demandSample([9 * scale, 4 * scale], 1),
        ],
      )

    const small = solve(1)
    const large = solve(1e150)

    expect(large.assignments).toEqual(small.assignments)
    expect(large.normalizedObjective).toBeCloseTo(small.normalizedObjective, 15)
    expect(Number.isFinite(large.normalizedObjective)).toBe(true)
  })

  it('does not mutate frozen sites, samples, or frame and freezes its output', () => {
    const frame = Object.freeze({ width: 10, height: 10 })
    const sites = Object.freeze([
      Object.freeze([8, 5] as Point),
      Object.freeze([2, 5] as Point),
    ])
    const samples = Object.freeze([
      demandSample(Object.freeze([1, 5] as Point), 1),
      demandSample(Object.freeze([9, 5] as Point), 0.5),
    ])
    const before = JSON.stringify({ frame, sites, samples })

    const result = stipplingVoronoiReference(frame, sites, samples)

    expect(JSON.stringify({ frame, sites, samples })).toBe(before)
    expect(result.assignments).toEqual([1, 0])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.assignments)).toBe(true)
    expect(Object.isFrozen(result.cells)).toBe(true)
    expect(Object.isFrozen(result.cells[0])).toBe(true)
    expect(Object.isFrozen(result.cells[0]!.centroid)).toBe(true)
  })

  it('rejects malformed finite-domain inputs and oversized exhaustive fixtures', () => {
    expect(() =>
      stipplingVoronoiReference(
        FRAME,
        [[5, 5]],
        [{ point: [5, 5], weight: Number.NaN }],
      ),
    ).toThrow(/weight must be finite/)
    expect(() => stipplingVoronoiReference(FRAME, [[11, 5]], [])).toThrow(
      /inside the frame/,
    )

    const siteCount = 129
    const sampleCount =
      Math.floor(STIPPLING_VORONOI_REFERENCE_MAX_PAIR_CHECKS / siteCount) + 1
    const sites = Array.from({ length: siteCount }, () => [5, 5] as Point)
    const samples = Array.from({ length: sampleCount }, () =>
      demandSample([5, 5], 1),
    )

    expect(() => stipplingVoronoiReference(FRAME, sites, samples)).toThrow(
      /limited to 16384 site\/sample pair checks/,
    )
  })
})
