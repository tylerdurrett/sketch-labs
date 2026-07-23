import { describe, expect, it } from 'vitest'

import { WATERCOLOR_FORMS_LIMITS } from '../sketches/watercolor-forms/limits'
import {
  partitionWatercolorFormsRaster,
  partitionWatercolorFormsRasterWithEdgeOrderForTest,
} from '../sketches/watercolor-forms/partition'
import type { PreparedWatercolorRaster } from '../sketches/watercolor-forms/types'

function raster(
  width: number,
  height: number,
  colors: readonly (readonly [number, number, number])[],
  alpha: readonly number[] = colors.map(() => 1),
  support: readonly boolean[] = alpha.map((value) => value > 0),
): PreparedWatercolorRaster {
  const linearRed = colors.map((color) => color[0])
  const linearGreen = colors.map((color) => color[1])
  const linearBlue = colors.map((color) => color[2])
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    linearRed: Object.freeze(linearRed),
    linearGreen: Object.freeze(linearGreen),
    linearBlue: Object.freeze(linearBlue),
    luminance: Object.freeze(
      colors.map(
        ([red, green, blue]) =>
          0.2126 * red + 0.7152 * green + 0.0722 * blue,
      ),
    ),
    alpha: Object.freeze([...alpha]),
    positiveSupport: Object.freeze([...support]),
  })
}

function flatRaster(
  width: number,
  height: number,
  color: readonly [number, number, number] = [0.25, 0.25, 0.25],
): PreparedWatercolorRaster {
  return raster(
    width,
    height,
    Array.from({ length: width * height }, () => color),
  )
}

describe('partitionWatercolorFormsRaster', () => {
  it('coalesces a flat connected raster and reports visible statistics', () => {
    const source = flatRaster(4, 3, [0.2, 0.4, 0.6])
    const result = partitionWatercolorFormsRaster(source)

    expect(result.regionBySample).toEqual(Array(12).fill(0))
    expect(result.regions).toHaveLength(1)
    expect(result.regions[0]).toMatchObject({
      id: 0,
      sampleCount: 12,
      visibleSampleCount: 12,
      meanAlpha: 1,
    })
    expect(result.regions[0]!.meanLinearRed).toBeCloseTo(0.2, 15)
    expect(result.regions[0]!.meanLinearGreen).toBeCloseTo(0.4, 15)
    expect(result.regions[0]!.meanLinearBlue).toBeCloseTo(0.6, 15)
    expect(result.regions[0]!.meanLuminance).toBeCloseTo(
      0.37192,
      15,
    )
    expect(result.sharedBoundarySegments).toEqual([])
  })

  it.each([
    [
      'luminance',
      [0, 0, 0] as const,
      [1, 1, 1] as const,
      [1, 1] as const,
      'visible-color',
    ],
    [
      'chromatic-only',
      [1, 0, 0] as const,
      [0, 0.297227, 0] as const,
      [1, 1] as const,
      'visible-color',
    ],
    [
      'alpha',
      [0.3, 0.3, 0.3] as const,
      [0.3, 0.3, 0.3] as const,
      [1, 0.5] as const,
      'alpha-boundary',
    ],
  ])(
    'preserves a strong %s edge',
    (_name, first, second, alpha, provenance) => {
      const result = partitionWatercolorFormsRaster(
        raster(2, 1, [first, second], alpha),
      )

      expect(result.regionBySample).toEqual([0, 1])
      expect(result.regions).toHaveLength(2)
      expect(result.sharedBoundarySegments).toEqual([
        {
          id: 0,
          regionIds: [0, 1],
          start: [1, 0],
          end: [1, 1],
          strength: expect.any(Number),
          provenance,
        },
      ])
      expect(result.sharedBoundarySegments[0]!.strength).toBeGreaterThan(
        0.08,
      )
    },
  )

  it('uses chromatic evidence when luminance is effectively equal', () => {
    const red = [1, 0, 0] as const
    const equalLuminanceGreen = [0, 0.2126 / 0.7152, 0] as const
    const source = raster(2, 1, [red, equalLuminanceGreen])
    const result = partitionWatercolorFormsRaster(source)

    expect(source.luminance[0]).toBeCloseTo(source.luminance[1]!, 12)
    expect(result.regionBySample).toEqual([0, 1])
  })

  it('caps a flat initial region at a fixed fine-partition area', () => {
    const result = partitionWatercolorFormsRaster(flatRaster(65, 1))

    expect(result.regions.map((region) => region.sampleCount)).toEqual([
      64, 1,
    ])
    expect(result.regionBySample.slice(0, 64)).toEqual(Array(64).fill(0))
    expect(result.regionBySample[64]).toBe(1)
    expect(result.sharedBoundarySegments).toHaveLength(1)
    expect(result.sharedBoundarySegments[0]!.strength).toBe(0)
  })

  it('is invariant to shuffled edge construction order', () => {
    const source = raster(3, 3, [
      [0.2, 0.2, 0.2],
      [0.21, 0.2, 0.2],
      [0.8, 0.8, 0.8],
      [0.2, 0.21, 0.2],
      [0.2, 0.2, 0.21],
      [0.8, 0.79, 0.8],
      [0.1, 0.1, 0.7],
      [0.1, 0.11, 0.7],
      [0.8, 0.8, 0.79],
    ])
    const canonical = partitionWatercolorFormsRaster(source)
    const adjacencyCount =
      source.width * (source.height - 1) +
      source.height * (source.width - 1)
    const shuffledOrder = Array.from(
      { length: adjacencyCount },
      (_, index) => (index * 5 + 3) % adjacencyCount,
    )
    const shuffled = partitionWatercolorFormsRasterWithEdgeOrderForTest(
      source,
      shuffledOrder,
    )

    expect(shuffled).toEqual(canonical)
  })

  it('keeps exact-zero support out of the color-region inventory', () => {
    const result = partitionWatercolorFormsRaster(
      raster(
        3,
        1,
        [
          [0.2, 0.4, 0.6],
          [1, 0, 1],
          [0.2, 0.4, 0.6],
        ],
        [1, 0, 1],
        [true, false, true],
      ),
    )

    expect(result.regionBySample).toEqual([0, -1, 1])
    expect(result.regions).toHaveLength(2)
    expect(result.regions.every((region) => region.sampleCount === 1)).toBe(
      true,
    )
    expect(result.sharedBoundarySegments).toEqual([
      {
        id: 0,
        regionIds: [-1, 0],
        start: [1, 0],
        end: [1, 1],
        strength: 1,
        provenance: 'alpha-boundary',
      },
      {
        id: 1,
        regionIds: [-1, 1],
        start: [2, 0],
        end: [2, 1],
        strength: 1,
        provenance: 'alpha-boundary',
      },
    ])
  })

  it('returns no regions or boundaries for fully transparent support', () => {
    const source = raster(
      2,
      2,
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 1, 1],
      ],
      [0, 0, 0, 0],
      [false, false, false, false],
    )
    const result = partitionWatercolorFormsRaster(source)

    expect(result.regionBySample).toEqual([-1, -1, -1, -1])
    expect(result.regions).toEqual([])
    expect(result.sharedBoundarySegments).toEqual([])
  })

  it('keeps canonical inventories within every partition cap', () => {
    const width = 32
    const height = 24
    const colors = Array.from(
      { length: width * height },
      (_, index) =>
        (Math.floor(index / width) + (index % width)) % 2 === 0
          ? ([0, 0, 0] as const)
          : ([1, 1, 1] as const),
    )
    const result = partitionWatercolorFormsRaster(
      raster(width, height, colors),
    )
    const adjacencyCount =
      width * (height - 1) + height * (width - 1)

    expect(result.regions).toHaveLength(width * height)
    expect(result.sharedBoundarySegments).toHaveLength(adjacencyCount)
    expect(result.regions.length).toBeLessThanOrEqual(
      WATERCOLOR_FORMS_LIMITS.maxInitialRegionCount,
    )
    expect(result.sharedBoundarySegments.length).toBeLessThanOrEqual(
      WATERCOLOR_FORMS_LIMITS.maxGridAdjacencyCount,
    )
    expect(WATERCOLOR_FORMS_LIMITS.maxGridAdjacencyCount).toBe(
      2 * WATERCOLOR_FORMS_LIMITS.maxSampleCount -
        2 * WATERCOLOR_FORMS_LIMITS.analysisMaxDimension,
    )
  })

  it('returns deeply immutable row-major labels and evidence', () => {
    const result = partitionWatercolorFormsRaster(
      raster(
        2,
        1,
        [
          [0, 0, 0],
          [1, 1, 1],
        ],
      ),
    )

    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.regionBySample)).toBe(true)
    expect(Object.isFrozen(result.regions)).toBe(true)
    expect(Object.isFrozen(result.regions[0])).toBe(true)
    expect(Object.isFrozen(result.sharedBoundarySegments)).toBe(true)
    expect(Object.isFrozen(result.sharedBoundarySegments[0])).toBe(true)
    expect(
      Object.isFrozen(result.sharedBoundarySegments[0]!.regionIds),
    ).toBe(true)
    expect(Object.isFrozen(result.sharedBoundarySegments[0]!.start)).toBe(
      true,
    )
    expect(Object.isFrozen(result.sharedBoundarySegments[0]!.end)).toBe(
      true,
    )
  })
})
