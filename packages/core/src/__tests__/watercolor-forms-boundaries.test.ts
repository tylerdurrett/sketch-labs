import { describe, expect, it } from 'vitest'
import {
  extractWatercolorSharedBoundaries,
  type WatercolorBoundaryExtractionLimits,
} from '../sketches/watercolor-forms/boundaries'
import {
  selectWatercolorForms,
  type WatercolorFormSelection,
  watercolorFormCutAncestorTraversalsForTest,
} from '../sketches/watercolor-forms/forms'
import { traceWatercolorBoundaryNetwork } from '../sketches/watercolor-forms/tracing'
import type {
  InitialRegionPartition,
  PreparedWatercolorRaster,
  RegionHierarchy,
  SharedBoundarySegment,
  WatercolorRegionMerge,
  WatercolorRegionSummary,
} from '../sketches/watercolor-forms/types'

const TRANSPARENT = -1

function summary(
  id: number,
  sampleCount: number,
): Readonly<WatercolorRegionSummary> {
  const value = (id % 10) / 10
  return Object.freeze({
    id,
    sampleCount,
    visibleSampleCount: sampleCount,
    meanLinearRed: value,
    meanLinearGreen: value,
    meanLinearBlue: value,
    meanLuminance: value,
    meanAlpha: 1,
  })
}

function segment(
  id: number,
  regionIds: readonly [number, number],
  start: readonly [number, number],
  end: readonly [number, number],
  strength: number,
  provenance: SharedBoundarySegment['provenance'] = 'visible-color',
): Readonly<SharedBoundarySegment> {
  return Object.freeze({
    id,
    regionIds: Object.freeze([...regionIds]) as readonly [number, number],
    start: Object.freeze([...start]),
    end: Object.freeze([...end]),
    strength,
    provenance,
  })
}

function raster(
  width: number,
  height: number,
  positiveSupport: readonly boolean[],
): Readonly<PreparedWatercolorRaster> {
  const sampleCount = width * height
  const zeros = Object.freeze(new Array<number>(sampleCount).fill(0))
  const alpha = Object.freeze(
    positiveSupport.map((supported) => (supported ? 1 : 0)),
  )
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    linearRed: zeros,
    linearGreen: zeros,
    linearBlue: zeros,
    luminance: zeros,
    alpha,
    positiveSupport: Object.freeze([...positiveSupport]),
  })
}

interface HierarchyFixture {
  readonly width: number
  readonly height: number
  readonly regionBySample: readonly number[]
  readonly regions: readonly Readonly<WatercolorRegionSummary>[]
  readonly segments?: readonly Readonly<SharedBoundarySegment>[]
  readonly merges?: readonly Readonly<WatercolorRegionMerge>[]
}

function hierarchy(fixture: HierarchyFixture): Readonly<RegionHierarchy> {
  const support = fixture.regionBySample.map(
    (regionId) => regionId !== TRANSPARENT,
  )
  const partition: Readonly<InitialRegionPartition> = Object.freeze({
    raster: raster(fixture.width, fixture.height, support),
    regionBySample: Object.freeze([...fixture.regionBySample]),
    regions: Object.freeze([...fixture.regions]),
    sharedBoundarySegments: Object.freeze([...(fixture.segments ?? [])]),
  })
  const mergedRegions = (fixture.merges ?? []).map(
    (merge) => merge.mergedRegion,
  )
  return Object.freeze({
    partition,
    regions: Object.freeze([...fixture.regions, ...mergedRegions]),
    merges: Object.freeze([...(fixture.merges ?? [])]),
    complete: true,
  })
}

function merge(
  leftRegionId: number,
  rightRegionId: number,
  mergedRegion: Readonly<WatercolorRegionSummary>,
  height: number,
): Readonly<WatercolorRegionMerge> {
  return Object.freeze({
    leftRegionId,
    rightRegionId,
    mergedRegion,
    similarity: 1 - height,
    boundaryStrength: 0.5,
    stability: 0.5,
  })
}

function extract(
  selection: Readonly<WatercolorFormSelection>,
  strength = 0,
  limits: Readonly<WatercolorBoundaryExtractionLimits> = {},
) {
  return extractWatercolorSharedBoundaries(selection, strength, limits)
}

describe('Watercolor Forms hierarchy selection and shared boundaries', () => {
  it('moves Form detail through a monotonic hierarchy refinement', () => {
    const first = summary(0, 2)
    const second = summary(1, 2)
    const third = summary(2, 2)
    const firstMerge = summary(3, 4)
    const root = summary(4, 6)
    const source = hierarchy({
      width: 6,
      height: 1,
      regionBySample: [0, 0, 1, 1, 2, 2],
      regions: [first, second, third],
      segments: [
        segment(1, [0, 1], [2, 0], [2, 1], 0.4),
        segment(3, [1, 2], [4, 0], [4, 1], 0.7),
      ],
      merges: [
        merge(0, 1, firstMerge, 0.2),
        merge(3, 2, root, 0.8),
      ],
    })

    const coarse = selectWatercolorForms(source, 0)
    const medium = selectWatercolorForms(source, 0.5)
    const fine = selectWatercolorForms(source, 0.9)

    expect(coarse.regionIds).toEqual([4])
    expect(medium.regionIds).toEqual([2, 3])
    expect(fine.regionIds).toEqual([0, 1, 2])
    expect([
      coarse.regionIds.length,
      medium.regionIds.length,
      fine.regionIds.length,
    ]).toEqual([1, 2, 3])
  })

  it('absorbs a micro-island before any boundary segment can be emitted', () => {
    const source = hierarchy({
      width: 3,
      height: 3,
      regionBySample: [0, 0, 0, 0, 1, 0, 0, 0, 0],
      regions: [summary(0, 8), summary(1, 1)],
      segments: [
        segment(1, [0, 1], [1, 1], [2, 1], 0.9),
        segment(2, [0, 1], [1, 1], [1, 2], 0.9),
        segment(4, [0, 1], [2, 1], [2, 2], 0.9),
        segment(5, [0, 1], [1, 2], [2, 2], 0.9),
      ],
    })

    const selected = selectWatercolorForms(source, 0.5)

    expect(selected.regionIds).toEqual([0])
    expect(selected.regionBySample).toEqual(new Array(9).fill(0))
    expect(extract(selected, 0).sharedBoundarySegments).toEqual([])
  })

  it('emits each unit of one shared interface once', () => {
    const source = hierarchy({
      width: 2,
      height: 2,
      regionBySample: [0, 1, 0, 1],
      regions: [summary(0, 2), summary(1, 2)],
      segments: [
        segment(0, [0, 1], [1, 0], [1, 1], 0.7),
        segment(2, [0, 1], [1, 1], [1, 2], 0.7),
      ],
    })
    const result = extract(selectWatercolorForms(source, 1), 0)

    expect(result.sharedBoundarySegments).toHaveLength(2)
    expect(
      new Set(
        result.sharedBoundarySegments.map(
          ({ start, end }) => `${start.join(',')}|${end.join(',')}`,
        ),
      ).size,
    ).toBe(2)
    expect(
      result.sharedBoundarySegments.map((boundary) => boundary.regionIds),
    ).toEqual([
      [0, 1],
      [0, 1],
    ])
  })

  it('filters on aggregate whole-interface evidence, not individual units', () => {
    const source = hierarchy({
      width: 2,
      height: 2,
      regionBySample: [0, 1, 0, 1],
      regions: [summary(0, 2), summary(1, 2)],
      segments: [
        segment(0, [0, 1], [1, 0], [1, 1], 0.1),
        segment(2, [0, 1], [1, 1], [1, 2], 0.9),
      ],
    })
    const selected = selectWatercolorForms(source, 1)

    expect(extract(selected, 0.51).sharedBoundarySegments).toEqual([])
    const retained = extract(selected, 0.5).sharedBoundarySegments
    expect(retained).toHaveLength(2)
    expect(retained.map((boundary) => boundary.strength)).toEqual([0.5, 0.5])
  })

  it('emits neither a flat field nor the fitted lattice perimeter', () => {
    const source = hierarchy({
      width: 4,
      height: 2,
      regionBySample: new Array(8).fill(0),
      regions: [summary(0, 8)],
    })

    const result = extract(selectWatercolorForms(source, 1), 0)

    expect(result.regionIds).toEqual([0])
    expect(result.sharedBoundarySegments).toEqual([])
  })

  it('keeps an internal alpha silhouette without inventing the outer perimeter', () => {
    const source = hierarchy({
      width: 3,
      height: 3,
      regionBySample: [
        TRANSPARENT,
        TRANSPARENT,
        TRANSPARENT,
        TRANSPARENT,
        0,
        TRANSPARENT,
        TRANSPARENT,
        TRANSPARENT,
        TRANSPARENT,
      ],
      regions: [summary(0, 1)],
      segments: [
        segment(
          1,
          [TRANSPARENT, 0],
          [1, 1],
          [2, 1],
          1,
          'alpha-boundary',
        ),
        segment(
          2,
          [TRANSPARENT, 0],
          [1, 1],
          [1, 2],
          1,
          'alpha-boundary',
        ),
        segment(
          4,
          [TRANSPARENT, 0],
          [2, 1],
          [2, 2],
          1,
          'alpha-boundary',
        ),
        segment(
          5,
          [TRANSPARENT, 0],
          [1, 2],
          [2, 2],
          1,
          'alpha-boundary',
        ),
      ],
    })

    const result = extract(selectWatercolorForms(source, 1), 0.9)

    expect(result.sharedBoundarySegments).toHaveLength(4)
    expect(
      result.sharedBoundarySegments.every(
        (boundary) =>
          boundary.provenance === 'alpha-boundary' &&
          boundary.regionIds[0] === 0 &&
          boundary.regionIds[1] === 1,
      ),
    ).toBe(true)
    expect(
      result.sharedBoundarySegments.every(({ start, end }) =>
        [...start, ...end].every((coordinate) => coordinate > 0 && coordinate < 3),
      ),
    ).toBe(true)
  })

  it('never drains visible forms into transparency across detail refinement', () => {
    const source = hierarchy({
      width: 6,
      height: 1,
      regionBySample: [TRANSPARENT, 0, 0, 1, 1, TRANSPARENT],
      regions: [summary(0, 2), summary(1, 2)],
      segments: [
        segment(
          0,
          [TRANSPARENT, 0],
          [1, 0],
          [1, 1],
          1,
          'alpha-boundary',
        ),
        segment(2, [0, 1], [3, 0], [3, 1], 0.4),
        segment(
          4,
          [TRANSPARENT, 1],
          [5, 0],
          [5, 1],
          1,
          'alpha-boundary',
        ),
      ],
      merges: [merge(0, 1, summary(2, 4), 0.8)],
    })

    const coarse = selectWatercolorForms(source, 0.19)
    const justFiner = selectWatercolorForms(source, 0.21)
    const finer = selectWatercolorForms(source, 0.5)

    expect(coarse.regionIds).toEqual([2])
    expect(justFiner.regionIds).toEqual([0])
    expect(finer.regionIds).toEqual([0, 1])
    expect(
      [coarse, justFiner, finer].map(
        (selection) =>
          selection.regionBySample.filter(
            (regionId) => regionId !== TRANSPARENT,
          ).length,
      ),
    ).toEqual([4, 4, 4])
    expect(
      [coarse, justFiner, finer].map(
        (selection) => extract(selection, 0).sharedBoundarySegments.length,
      ),
    ).toEqual([2, 2, 3])
  })

  it('path-compresses leaf ownership in a large comb hierarchy', () => {
    const leafCount = 8_192
    const leaves = Array.from({ length: leafCount }, (_, id) => summary(id, 1))
    const merges: Readonly<WatercolorRegionMerge>[] = []
    let activeRegionId = 0
    for (let leafId = 1; leafId < leafCount; leafId += 1) {
      const mergedRegion = summary(
        leafCount + leafId - 1,
        leafId + 1,
      )
      merges.push(merge(activeRegionId, leafId, mergedRegion, 0.25))
      activeRegionId = mergedRegion.id
    }
    const source = hierarchy({
      width: leafCount,
      height: 1,
      regionBySample: Array.from({ length: leafCount }, (_, id) => id),
      regions: leaves,
      merges,
    })

    const traversals = watercolorFormCutAncestorTraversalsForTest(source, 0)
    const selected = selectWatercolorForms(source, 0)

    expect(selected.regionIds).toEqual([activeRegionId])
    expect(new Set(selected.regionBySample)).toEqual(
      new Set([activeRegionId]),
    )
    expect(traversals).toBeLessThan(4 * leafCount)
  })

  it('caps by interface significance and then a canonical segment prefix', () => {
    const source = hierarchy({
      width: 3,
      height: 2,
      regionBySample: [0, 1, 2, 0, 1, 2],
      regions: [summary(0, 2), summary(1, 2), summary(2, 2)],
      segments: [
        segment(0, [0, 1], [1, 0], [1, 1], 0.4),
        segment(1, [1, 2], [2, 0], [2, 1], 0.8),
        segment(3, [0, 1], [1, 1], [1, 2], 0.4),
        segment(4, [1, 2], [2, 1], [2, 2], 0.8),
      ],
    })
    const selected = selectWatercolorForms(source, 1)

    const first = extract(selected, 0, {
      maxRetainedBoundarySegmentCount: 1,
    })
    const repeated = extract(selected, 0, {
      maxRetainedBoundarySegmentCount: 1,
    })

    expect(first).toEqual(repeated)
    expect(first.sharedBoundarySegments).toEqual([
      {
        id: 1,
        regionIds: [1, 2],
        start: [2, 0],
        end: [2, 1],
        strength: 0.8,
        provenance: 'visible-color',
      },
    ])
    expect(
      traceWatercolorBoundaryNetwork(first.sharedBoundarySegments).diagnostics,
    ).toMatchObject({
      termination: 'complete',
      validSegmentCount: 1,
      consumedSegmentCount: 1,
    })
  })

  it('returns deeply immutable selection and boundary snapshots', () => {
    const source = hierarchy({
      width: 2,
      height: 1,
      regionBySample: [0, 1],
      regions: [summary(0, 1), summary(1, 1)],
      segments: [segment(0, [0, 1], [1, 0], [1, 1], 1)],
    })
    const selected = selectWatercolorForms(source, 1)
    const result = extract(selected)

    expect(Object.isFrozen(selected)).toBe(true)
    expect(Object.isFrozen(selected.regionIds)).toBe(true)
    expect(Object.isFrozen(selected.regionBySample)).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.regionIds)).toBe(true)
    expect(Object.isFrozen(result.sharedBoundarySegments)).toBe(true)
    expect(Object.isFrozen(result.sharedBoundarySegments[0])).toBe(true)
    expect(
      Object.isFrozen(result.sharedBoundarySegments[0]!.regionIds),
    ).toBe(true)
    expect(Object.isFrozen(result.sharedBoundarySegments[0]!.start)).toBe(true)
    expect(Object.isFrozen(result.sharedBoundarySegments[0]!.end)).toBe(true)
  })
})
