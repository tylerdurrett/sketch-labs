import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import { analyzeHiddenLineWorkload, hiddenLinePass } from '../hiddenLine'
import type { Primitive, Scene } from '../scene'
import { defaultParams } from '../sketch'
import { grassHills } from '../sketches/grass-hills'
import { GRASS_HILLS_TOOL_WIDTH_MILLIMETERS } from '../sketches/grass-hills/outline'

const FRAME = { width: 1_000, height: 1_000 }
const TARGET = {
  toolWidthMillimeters: GRASS_HILLS_TOOL_WIDTH_MILLIMETERS,
  millimetersPerSceneUnit: 180 / 1_000,
}
const TOOL_WIDTH_SCENE_UNITS = 5 / 3
const PARAMS = {
  ...defaultParams(grassHills.schema),
  bladeDensity: 2,
}

function role(scene: Scene, value: Primitive['hiddenLineRole']): Primitive[] {
  return scene.primitives.filter(({ hiddenLineRole }) => hiddenLineRole === value)
}

describe('grass-hills production Outline architecture', () => {
  it('derives deterministic six-point sources and nearer-hill masks from the full 10k descriptor set', () => {
    const fill = grassHills.generate(PARAMS, 12345, 0, FRAME)
    const started = performance.now()
    const source = grassHills.generateOutlineSource!(
      PARAMS,
      12345,
      0,
      FRAME,
      TARGET,
    )
    const preparedMs = performance.now() - started
    const masks = role(source, 'occluder')
    const sources = role(source, 'source')
    const ridges = sources.filter(({ points }) => points.length === 131)
    const spines = sources.filter(({ points }) => points.length === 6)
    const workload = analyzeHiddenLineWorkload(source)
    const processingStarted = performance.now()
    const outlined = hiddenLinePass(source)
    const processingMs = performance.now() - processingStarted
    const fillByRoot = new Map(
      fill.primitives
        .filter(({ closed }) => closed === true)
        .map((primitive) => [primitive.points[0]!.join(':'), primitive]),
    )

    expect(fill.primitives.filter(({ closed }) => closed === true)).toHaveLength(
      10_000,
    )
    expect(
      fill.primitives
        .filter(({ closed }) => closed === true)
        .every(({ points }) => points.length === 7),
    ).toBe(true)
    expect(masks).toHaveLength(10)
    expect(ridges).toHaveLength(10)
    // P1's adopted inverse-square hill allocation intentionally differs from
    // the equal-per-hill decision prototype (9,298 selected / 8,939 emitted).
    expect(spines).toHaveLength(8_179)
    for (const spine of spines) {
      const fillBlade = fillByRoot.get(spine.points[0]!.join(':'))
      expect(fillBlade).toBeDefined()
      expect(spine.points.at(-1)).toEqual(fillBlade!.points[3])
    }
    for (const mask of masks) {
      const maskIndex = source.primitives.indexOf(mask)
      expect(source.primitives[maskIndex + 1]).toMatchObject({
        hiddenLineRole: 'source',
        points: expect.any(Array),
      })
    }
    expect(
      spines.every(({ stroke }) => stroke?.width === TOOL_WIDTH_SCENE_UNITS),
    ).toBe(true)
    expect(source).toEqual(
      grassHills.generateOutlineSource!(PARAMS, 12345, 999, FRAME, TARGET),
    )
    expect(outlined.primitives.every(({ fill }) => fill === undefined)).toBe(
      true,
    )
    expect(
      outlined.primitives.every(
        ({ stroke }) => stroke?.width === TOOL_WIDTH_SCENE_UNITS,
      ),
    ).toBe(true)
    expect(outlined.primitives).toHaveLength(7_771)
    expect(workload).toEqual({
      filledPrimitiveCount: 10,
      sourceSegmentCount: 42_195,
      overlappingPairCount: 5_743,
      estimatedSegmentEdgeComparisons: 3_898_060,
      totalWorkUnits: 4_158_808,
    })
    // Observations only, not SLAs; guards merely catch accidental pathological
    // work on ordinary development hardware.
    expect(preparedMs).toBeLessThan(10_000)
    expect(processingMs).toBeLessThan(5_000)
  }, 30_000)

  it('rejects an invalid physical tool target rather than falling back', () => {
    expect(() =>
      grassHills.generateOutlineSource!(PARAMS, 12345, 0, FRAME, {
        ...TARGET,
        toolWidthMillimeters: 0,
      }),
    ).toThrow(/toolWidthMillimeters must be finite and positive/)
  })
})
