import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { Scene } from '../scene'
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

function sceneSha256(scene: Scene): string {
  return createHash('sha256').update(JSON.stringify(scene)).digest('hex')
}

describe('grass-hills production Outline architecture', () => {
  it('derives a deterministic faithful source from the full 10k Fill geometry', () => {
    expect(grassHills.deriveOutlineSource).toBeUndefined()
    const fill = grassHills.generate(PARAMS, 12345, 0, FRAME)
    const preparedFill = grassHills.prepare!(PARAMS, 12345, FRAME)
    const warmFill = preparedFill(999)
    const source = grassHills.generateOutlineSource!(
      PARAMS,
      12345,
      0,
      FRAME,
      TARGET,
    )

    expect(warmFill).toEqual(fill)

    expect(fill.primitives.filter(({ closed }) => closed === true)).toHaveLength(
      10_000,
    )
    expect(
      fill.primitives
        .filter(({ closed }) => closed === true)
        .every(({ points }) => points.length === 7),
    ).toBe(true)
    expect(source.primitives).toHaveLength(fill.primitives.length)
    expect(
      source.primitives.every(
        ({ hiddenLineRole }) => hiddenLineRole === 'both',
      ),
    ).toBe(true)
    expect(
      source.primitives.every(
        ({ stroke }) => stroke?.width === TOOL_WIDTH_SCENE_UNITS,
      ),
    ).toBe(true)
    for (let index = 0; index < fill.primitives.length; index++) {
      expect(source.primitives[index]!.points).toEqual(
        fill.primitives[index]!.points,
      )
      expect(source.primitives[index]!.closed).toBe(
        fill.primitives[index]!.closed,
      )
    }
    expect(source).toEqual(
      grassHills.generateOutlineSource!(PARAMS, 12345, 999, FRAME, TARGET),
    )
    expect(sceneSha256(fill)).toBe(
      '1909cd36e92c13444acd3a600b9362360f2caf23f41024a131b7903bf57f2cc9',
    )
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
