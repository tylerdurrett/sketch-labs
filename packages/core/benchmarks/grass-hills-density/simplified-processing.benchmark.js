import { describe, expect, it } from 'vitest'

import { sceneChecksum } from './metrics.js'
import { DENSITY_FIXTURES } from './fixtures.js'
import { benchmarkCandidate } from './simplified-candidate.js'
import {
  PINNED_PLOTTER_NIB_MILLIMETERS,
  processSimplifiedStrokes,
  selectPlotterLod,
} from './simplified-processing.js'

const MILLIMETERS_PER_SCENE_UNIT = 0.18
const NIB_WIDTH_SCENE_UNITS =
  PINNED_PLOTTER_NIB_MILLIMETERS / MILLIMETERS_PER_SCENE_UNIT

function payload({
  bladeCount = 60,
  hillCount = 2,
  occluderMode = 'hill-only',
  densityMode = 'same-density',
} = {}) {
  const value = structuredClone(DENSITY_FIXTURES[0].payload)
  value.params.hillCount = hillCount
  value.request = { hillCount, bladeCount }
  value.simplified = { occluderMode, densityMode }
  return value
}

function sourceEntry({
  rootKey,
  tuftKey,
  hillIndex = 0,
  rank,
  root,
  points,
}) {
  return {
    rootKey,
    tuftKey,
    hillIndex,
    descriptor: {
      projected: root,
      lod: { rank, tieBreak: rank / 10 },
    },
    primitive: {
      points,
      closed: false,
      stroke: { color: '#000000', width: 1 },
    },
  }
}

function processSynthetic(entries, overrides = {}) {
  return processSimplifiedStrokes({
    sourceScene: {
      space: { width: 20, height: 20 },
      primitives: entries.map((entry) => entry.primitive),
    },
    sourceEntries: entries,
    hillRidges: [],
    occluderMode: 'hill-only',
    densityMode: 'same-density',
    millimetersPerSceneUnit: MILLIMETERS_PER_SCENE_UNIT,
    nibWidthSceneUnits: NIB_WIDTH_SCENE_UNITS,
    ...overrides,
  })
}

describe('simplified source-stroke processing candidate', () => {
  it('keeps source strokes and coarse occluders explicitly distinct', () => {
    const fixture = payload()
    const result = benchmarkCandidate.generate(fixture, 0)

    expect(result.scene.primitives).toHaveLength(60)
    expect(result.processing.evidence.source).toMatchObject({
      kind: 'open-blade-strokes',
      primitiveCount: 60,
    })
    expect(result.processing.evidence.occluders).toMatchObject({
      mode: 'hill-only',
      emittedAsGeometry: false,
      hillCount: 2,
      clumpCount: 0,
    })
    for (const scene of [result.scene, result.processing.scene]) {
      expect(
        scene.primitives.every(
          (primitive) =>
            primitive.closed === false &&
            primitive.fill === undefined &&
            primitive.stroke !== undefined,
        ),
      ).toBe(true)
    }
    expect(result.processing.previewScene).toBe(result.processing.scene)
    expect(result.processing.exportScene).toBe(result.processing.scene)

    const metrics = benchmarkCandidate.inspect({
      phase: 'warm',
      value: result,
      payload: fixture,
    })
    expect(metrics.processing.kind).toBe('supplied')
    expect(metrics.processing.durationMs).toBe(result.processing.durationMs)
    expect(metrics.processing.processed.checksum).toBe(
      sceneChecksum(result.processing.scene),
    )
  })

  it('subtracts nearer hill masks without emitting their polygons', () => {
    const far = sourceEntry({
      rootKey: 'far',
      tuftKey: 'far-tuft',
      hillIndex: 0,
      rank: 0,
      root: [0, 10],
      points: [[0, 10], [0, 5], [0, 0]],
    })
    const processed = processSynthetic([far], {
      hillRidges: [
        { points: [[-5, 20], [5, 20], [5, 25], [-5, 25]] },
        { points: [[-2, 4], [2, 4], [2, 12], [-2, 12]] },
      ],
    })

    expect(processed.evidence.occluders).toMatchObject({
      hillCount: 2,
      clumpCount: 0,
      emittedAsGeometry: false,
    })
    expect(processed.scene.primitives).toHaveLength(1)
    expect(processed.scene.primitives[0].points[0][1]).toBeCloseTo(4, 12)
    expect(processed.scene.primitives[0].points.at(-1)).toEqual([0, 0])
  })

  it('adds deterministic clump masks only in hill-and-clump mode', () => {
    const farther = sourceEntry({
      rootKey: 'farther',
      tuftKey: 'tuft-a',
      rank: 0,
      root: [0, 5],
      points: [[0, 5], [0, 0], [0, -5]],
    })
    const nearer = sourceEntry({
      rootKey: 'nearer',
      tuftKey: 'tuft-b',
      rank: 1,
      root: [0, 10],
      points: [[0, 10], [0, 5], [0, 0]],
    })
    const source = [farther, nearer]
    const hillOnly = processSynthetic(source)
    const withClumps = processSynthetic(source, {
      occluderMode: 'hill-and-clump',
    })

    expect(hillOnly.evidence.occluders.clumpCount).toBe(0)
    expect(withClumps.evidence.occluders).toMatchObject({
      clumpCount: 2,
      emittedAsGeometry: false,
    })
    expect(withClumps.scene).not.toEqual(hillOnly.scene)
    expect(withClumps.evidence.emittedRootKeys).toContain('nearer')
    expect(
      withClumps.scene.primitives.every(
        (primitive) => primitive.fill === undefined && !primitive.closed,
      ),
    ).toBe(true)
  })

  it('selects deterministic, ordered, nib-spaced plotter membership', () => {
    const entries = [
      sourceEntry({
        rootKey: 'a',
        tuftKey: 'a',
        rank: 0,
        root: [0, 0],
        points: [[0, 0], [0, -1]],
      }),
      sourceEntry({
        rootKey: 'b',
        tuftKey: 'b',
        rank: 1,
        root: [1, 0],
        points: [[1, 0], [1, -1]],
      }),
      sourceEntry({
        rootKey: 'c',
        tuftKey: 'c',
        rank: 2,
        root: [2, 0],
        points: [[2, 0], [2, -1]],
      }),
      sourceEntry({
        rootKey: 'd',
        tuftKey: 'd',
        rank: 3,
        root: [4, 0],
        points: [[4, 0], [4, -1]],
      }),
    ]

    const nested = selectPlotterLod(entries.slice(0, 3), NIB_WIDTH_SCENE_UNITS)
    const selected = selectPlotterLod(entries, NIB_WIDTH_SCENE_UNITS)
    const reordered = selectPlotterLod(
      [...entries].reverse(),
      NIB_WIDTH_SCENE_UNITS,
    )
    expect(nested.selectedRootKeys).toEqual(['a', 'c'])
    expect(selected.selectedRootKeys).toEqual(['a', 'c', 'd'])
    expect(reordered.selectedRootKeys).toEqual(selected.selectedRootKeys)

    for (let left = 0; left < selected.entries.length; left++) {
      for (let right = left + 1; right < selected.entries.length; right++) {
        expect(
          Math.hypot(
            selected.entries[left].descriptor.projected[0] -
              selected.entries[right].descriptor.projected[0],
            selected.entries[left].descriptor.projected[1] -
              selected.entries[right].descriptor.projected[1],
          ),
        ).toBeGreaterThanOrEqual(NIB_WIDTH_SCENE_UNITS)
      }
    }
  })

  it('compares equal preview/export density with deterministic plotter LOD', () => {
    const entries = [
      sourceEntry({
        rootKey: 'a',
        tuftKey: 'a',
        rank: 0,
        root: [0, 0],
        points: [[0, 0], [0, -1]],
      }),
      sourceEntry({
        rootKey: 'b',
        tuftKey: 'b',
        rank: 1,
        root: [1, 0],
        points: [[1, 0], [1, -1]],
      }),
      sourceEntry({
        rootKey: 'c',
        tuftKey: 'c',
        rank: 2,
        root: [2, 0],
        points: [[2, 0], [2, -1]],
      }),
    ]
    const sameDensity = processSynthetic(entries)
    const plotterLod = processSynthetic(entries, {
      densityMode: 'plotter-lod',
    })

    expect(sameDensity.evidence.lod).toMatchObject({
      mode: 'same-density',
      nibWidthMillimeters: 0.3,
      eligibleCount: 3,
      selectedCount: 3,
    })
    expect(sameDensity.scene.primitives).toHaveLength(3)
    expect(plotterLod.evidence.lod).toMatchObject({
      mode: 'plotter-lod',
      nibWidthMillimeters: 0.3,
      nibWidthSceneUnits: NIB_WIDTH_SCENE_UNITS,
      eligibleCount: 3,
      selectedCount: 2,
      includedRootKeys: ['a', 'c'],
    })
    expect(plotterLod.scene.primitives).toHaveLength(2)
    expect(plotterLod.evidence.emittedRootKeys).toEqual(['a', 'c'])

    expect(() =>
      processSynthetic(entries, { nibWidthSceneUnits: 2 }),
    ).toThrow(/pinned 0.30 mm/)
  })

  it('keeps end-to-end plotter LOD membership nested across density', () => {
    let previousKeys = new Set()
    for (let bladeCount = 1; bladeCount <= 80; bladeCount++) {
      const result = benchmarkCandidate.generate(
        payload({ bladeCount, hillCount: 4, densityMode: 'plotter-lod' }),
        0,
      )
      const currentKeys = new Set(
        result.processing.evidence.lod.priorityRootKeys,
      )

      for (const rootKey of previousKeys) expect(currentKeys.has(rootKey)).toBe(true)
      previousKeys = currentKeys
    }
  })
})
