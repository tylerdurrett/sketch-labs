import { describe, expect, it } from 'vitest'

import { UniformAabbGrid } from '../aabbGrid'
import type { AABB } from '../aabbGrid'

function overlaps(a: AABB, b: AABB): boolean {
  return (
    a.minX <= b.maxX &&
    a.maxX >= b.minX &&
    a.minY <= b.maxY &&
    a.maxY >= b.minY
  )
}

function bruteForce(aabbs: readonly AABB[], query: AABB): number[] {
  const result: number[] = []
  for (let index = 0; index < aabbs.length; index++) {
    if (overlaps(aabbs[index]!, query)) result.push(index)
  }
  return result
}

describe('UniformAabbGrid', () => {
  it('matches brute-force overlap candidates across a dense finite fixture', () => {
    let state = 0x9e3779b9
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 0x1_0000_0000
    }
    const aabbs = Array.from({ length: 500 }, () => {
      const minX = random() * 240 - 120
      const minY = random() * 160 - 80
      return {
        minX,
        minY,
        maxX: minX + random() * 8,
        maxY: minY + random() * 24,
      }
    })
    const grid = new UniformAabbGrid(aabbs, {
      cellSize: 12,
      maxCellsPerAabb: 64,
    })

    for (let i = 0; i < 200; i++) {
      const minX = random() * 260 - 130
      const minY = random() * 180 - 90
      const query = {
        minX,
        minY,
        maxX: minX + random() * 30,
        maxY: minY + random() * 30,
      }
      expect(grid.query(query)).toEqual(bruteForce(aabbs, query))
    }

    expect(grid.stats.entryCount).toBe(500)
    expect(grid.stats.indexedEntryCount).toBe(500)
    expect(grid.stats.overflowEntryCount).toBe(0)
    expect(grid.stats.cellEntryCount).toBeGreaterThan(500)
  })

  it('suppresses candidates duplicated across multiple shared cells', () => {
    const grid = new UniformAabbGrid(
      [
        { minX: 0, minY: 0, maxX: 29, maxY: 29 },
        { minX: 5, minY: 5, maxX: 25, maxY: 25 },
        { minX: 40, minY: 40, maxX: 41, maxY: 41 },
      ],
      { cellSize: 10 },
    )

    expect(grid.query({ minX: 4, minY: 4, maxX: 26, maxY: 26 })).toEqual([
      0, 1,
    ])
  })

  it('uses floor-based cells correctly for negative coordinates', () => {
    const aabbs: AABB[] = [
      { minX: -25, minY: -15, maxX: -12, maxY: -2 },
      { minX: -9, minY: -9, maxX: -1, maxY: -1 },
      { minX: 1, minY: 1, maxX: 2, maxY: 2 },
    ]
    const grid = new UniformAabbGrid(aabbs, { cellSize: 10 })
    const query = { minX: -13, minY: -3, maxX: -1, maxY: -1 }

    expect(grid.query(query)).toEqual(bruteForce(aabbs, query))
    expect(grid.query(query)).toEqual([0, 1])
  })

  it('treats touching AABB boundaries as overlapping across cell boundaries', () => {
    const grid = new UniformAabbGrid(
      [
        { minX: -1, minY: -1, maxX: 0, maxY: 0 },
        { minX: 10, minY: 10, maxX: 20, maxY: 20 },
        { minX: 20, minY: 20, maxX: 30, maxY: 30 },
      ],
      { cellSize: 10 },
    )

    expect(grid.query({ minX: 0, minY: 0, maxX: 10, maxY: 10 })).toEqual([
      0, 1,
    ])
    expect(grid.query({ minX: 20, minY: 20, maxX: 20, maxY: 20 })).toEqual([
      1, 2,
    ])
  })

  it('returns stable ascending painter indices regardless of bucket traversal', () => {
    const grid = new UniformAabbGrid(
      [
        { minX: 19, minY: 19, maxX: 21, maxY: 21 },
        { minX: 0, minY: 0, maxX: 30, maxY: 30 },
        { minX: 10, minY: 20, maxX: 12, maxY: 22 },
        { minX: -20, minY: -20, maxX: -10, maxY: -10 },
      ],
      { cellSize: 10 },
    )
    const query = { minX: 10, minY: 10, maxX: 25, maxY: 25 }

    expect(grid.query(query)).toEqual([0, 1, 2])
    expect(grid.query(query)).toEqual(grid.query(query))
  })

  it('keeps huge ranges and non-finite inputs on conservative paths', () => {
    const grid = new UniformAabbGrid(
      [
        { minX: 0, minY: 0, maxX: 1, maxY: 1 },
        {
          minX: -Number.MAX_VALUE,
          minY: -1,
          maxX: Number.MAX_VALUE,
          maxY: 1,
        },
        { minX: Number.NaN, minY: 0, maxX: 1, maxY: 1 },
        { minX: 0, minY: 0, maxX: Number.POSITIVE_INFINITY, maxY: 1 },
      ],
      { cellSize: 1, maxCellsPerAabb: 16 },
    )

    expect(grid.stats).toMatchObject({
      entryCount: 4,
      indexedEntryCount: 1,
      overflowEntryCount: 3,
      unsafeEntryCount: 3,
      cellCapOverflowEntryCount: 0,
    })
    expect(grid.query({ minX: 100, minY: 0, maxX: 101, maxY: 1 })).toEqual([
      1, 2, 3,
    ])
    expect(
      grid.query({
        minX: Number.NEGATIVE_INFINITY,
        minY: 0,
        maxX: 1,
        maxY: 1,
      }),
    ).toEqual([0, 1, 2, 3])
  })

  it('conservatively checks ordinary boxes that exceed the configured cell cap', () => {
    const aabbs: AABB[] = [
      { minX: 0, minY: 0, maxX: 100, maxY: 1 },
      { minX: 200, minY: 200, maxX: 201, maxY: 201 },
      { minX: 50, minY: 0, maxX: 51, maxY: 1 },
    ]
    const grid = new UniformAabbGrid(aabbs, {
      cellSize: 10,
      maxCellsPerAabb: 4,
    })

    expect(grid.stats).toMatchObject({
      indexedEntryCount: 2,
      overflowEntryCount: 1,
      unsafeEntryCount: 0,
      cellCapOverflowEntryCount: 1,
    })
    const query = { minX: 50, minY: 0, maxX: 50, maxY: 0 }
    expect(grid.query(query)).toEqual(bruteForce(aabbs, query))
    expect(grid.query(query)).toEqual([0, 2])
    expect(
      grid.query({ minX: -100, minY: -100, maxX: 100, maxY: 100 }),
    ).toEqual([0, 2])
  })

  it('rejects grid options that cannot make bounded safe cells', () => {
    expect(
      () => new UniformAabbGrid([], { cellSize: Number.NaN }),
    ).toThrow(/cellSize/)
    expect(
      () => new UniformAabbGrid([], { cellSize: 1, maxCellsPerAabb: 0 }),
    ).toThrow(/maxCellsPerAabb/)
  })
})
