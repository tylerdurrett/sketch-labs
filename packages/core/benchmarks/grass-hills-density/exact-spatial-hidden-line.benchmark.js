import { describe, expect, it } from 'vitest'

import {
  analyzeHiddenLineWorkload,
  hiddenLinePass,
} from '../../src/hiddenLine.ts'
import {
  prepareExactComposition,
  sampleExactComposition,
} from './exact-common.js'
import { exactSpatialHiddenLinePass } from './exact-spatial-hidden-line.js'
import { EXACT_CANDIDATE_BASELINE } from './fixtures.js'
import {
  replayHistoricalBaselineFill,
  replayHistoricalBaselineOutline,
} from './historical-baseline.js'
import { sceneChecksum } from './metrics.js'

describe('Grass Hills exact spatial Hidden-line prototype', () => {
  it('is output/checksum-equivalent on the pinned issue-start snapshot', () => {
    const source = replayHistoricalBaselineFill()
    const expected = replayHistoricalBaselineOutline()
    const expectedWork = analyzeHiddenLineWorkload(source)
    const actual = exactSpatialHiddenLinePass(source)

    expect(hiddenLinePass(source)).toEqual(expected)
    expect(actual.scene).toEqual(expected)
    expect(sceneChecksum(actual.scene)).toBe(sceneChecksum(expected))
    expect(actual.stats.filledPrimitiveCount).toBe(410)
    expect(actual.stats.broadPhaseCandidatePairCount).toBeLessThan(
      actual.stats.allPainterPairCount,
    )
    expect(actual.stats.overlappingPairCount).toBe(
      expectedWork.overlappingPairCount,
    )
    expect(actual.stats.estimatedSegmentEdgeComparisons).toBe(
      expectedWork.estimatedSegmentEdgeComparisons,
    )
    expect(actual.stats.index.occupiedCellCount).toBeGreaterThan(0)
  })

  it.each([
    ['poisson', 'detailed-33'],
    ['poisson', 'simple-7'],
    ['stratified', 'detailed-33'],
    ['stratified', 'simple-7'],
  ])(
    'matches current Hidden-line for tractable %s/%s fixtures',
    (rootStrategy, bladeGeometry) => {
      const prepared = prepareExactComposition(
        fixturePayload({ hillCount: 2, bladeCount: 80 }),
        { rootStrategy, bladeGeometry },
      )
      const source = sampleExactComposition(prepared, 0.5).scene
      const expected = hiddenLinePass(source, { tolerance: 0.01 })
      const actual = exactSpatialHiddenLinePass(source, { tolerance: 0.01 })

      expect(actual.scene).toEqual(expected)
      expect(sceneChecksum(actual.scene)).toBe(sceneChecksum(expected))
    },
  )

  it('preserves exact painter order across touching, cross-cell, long, and degenerate bounds', () => {
    const source = {
      space: { width: 40, height: 40 },
      background: { color: 'paper' },
      primitives: [
        rectangle(0, 0, 10, 10, 1),
        rectangle(10, 0, 20, 10, 2),
        rectangle(4.5, -4, 5.5, 24, 3),
        rectangle(-1_000, 9, 1_000, 11, 4),
        { points: [[5, 5]], closed: true, fill: { color: 'white' } },
        {
          points: [
            [0, 20],
            [20, 20],
            [0, 20],
          ],
          closed: true,
          fill: { color: 'white' },
          stroke: { color: 'red', width: 5 },
        },
        { points: [], closed: true, fill: { color: 'white' } },
        {
          points: [
            [-10, -10],
            [0, 0],
          ],
          stroke: { color: 'ignored', width: 9 },
        },
        rectangle(-10, -10, 0, 0, 6),
        rectangle(
          Number.MAX_SAFE_INTEGER * 2,
          0,
          Number.MAX_SAFE_INTEGER * 2 + 2,
          2,
          7,
        ),
      ],
    }
    const expected = hiddenLinePass(source)
    const actual = exactSpatialHiddenLinePass(source, {
      cellSize: 1,
      maxCellsPerPrimitive: 4,
    })

    expect(actual.scene).toEqual(expected)
    expect(sceneChecksum(actual.scene)).toBe(sceneChecksum(expected))
    expect(actual.scene.background).toBeUndefined()
    expect(actual.stats.index.overflowPrimitiveCount).toBeGreaterThan(0)
    expect(actual.stats.overlappingPairCount).toBeGreaterThan(0)
  })

  it('reports bounded grid build/memory/candidate evidence for disjoint work', () => {
    const source = {
      space: { width: 1_000, height: 1_000 },
      primitives: Array.from({ length: 100 }, (_, index) => {
        const x = (index % 10) * 90
        const y = Math.floor(index / 10) * 90
        return rectangle(x, y, x + 4, y + 4, 1)
      }),
    }
    const result = exactSpatialHiddenLinePass(source, { cellSize: 10 })

    expect(result.scene).toEqual(hiddenLinePass(source))
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.stats).toMatchObject({
      contract: 'exact-painter-order/uniform-aabb-grid/production-polygon-clip',
      filledPrimitiveCount: 100,
      allPainterPairCount: 4_950,
      broadPhaseCandidatePairCount: 0,
      overlappingPairCount: 0,
      index: {
        cellSize: 10,
        occupiedCellCount: 100,
        indexedReferenceCount: 100,
        overflowPrimitiveCount: 0,
      },
    })
    expect(result.stats.timings.indexBuildMs).toBeGreaterThanOrEqual(0)
    expect(Number.isInteger(result.stats.index.heapDeltaBytes)).toBe(true)
    expect(result.stats.index.estimatedBytes).toBeGreaterThan(0)
  })

  it('keeps inclusive cell-boundary overlap and rejects invalid index controls', () => {
    const source = {
      space: { width: 20, height: 20 },
      primitives: [rectangle(0, 0, 10, 10, 1), rectangle(10, 10, 20, 20, 2)],
    }
    const result = exactSpatialHiddenLinePass(source, { cellSize: 10 })

    expect(result.scene).toEqual(hiddenLinePass(source))
    expect(result.stats.broadPhaseCandidatePairCount).toBe(1)
    expect(result.stats.overlappingPairCount).toBe(1)
    expect(() => exactSpatialHiddenLinePass(source, { cellSize: 0 })).toThrow(
      /cellSize/,
    )
    expect(() =>
      exactSpatialHiddenLinePass(source, { maxCellsPerPrimitive: 1.5 }),
    ).toThrow(/maxCellsPerPrimitive/)
  })
})

function fixturePayload({ hillCount, bladeCount }) {
  const baseline = EXACT_CANDIDATE_BASELINE.payload
  return {
    ...baseline,
    frame: { ...baseline.frame },
    params: { ...baseline.params, hillCount },
    request: { hillCount, bladeCount },
  }
}

function rectangle(minX, minY, maxX, maxY, width) {
  return {
    points: [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ],
    closed: true,
    fill: { color: 'white' },
    stroke: { color: 'authored', width },
  }
}
