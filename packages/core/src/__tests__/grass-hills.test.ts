import { describe, expect, it } from 'vitest'

import type { CoordinateSpace, Scene } from '../scene'
import { grassHills } from '../sketches/grass-hills'

const SQUARE: CoordinateSpace = { width: 1000, height: 1000 }
const WIDE: CoordinateSpace = { width: 1600, height: 900 }

const SCHEMA_KEYS = [
  'hillCount',
  'horizonHeight',
  'depthFalloff',
  'ridgeScale',
  'ridgeAmplitude',
  'terrainDrift',
  'backgroundColor',
  'hillColor',
  'hillStrokeColor',
]

function geometry(scene: Scene): Array<Array<[number, number]>> {
  return scene.primitives.map((primitive) =>
    primitive.points.map(([x, y]) => [x, y]),
  )
}

describe('grass-hills Sketch contract', () => {
  it('declares the flat Terrain-then-Colors schema with physical defaults', () => {
    expect(Object.keys(grassHills.schema)).toEqual(SCHEMA_KEYS)
    expect(grassHills.schema).toEqual({
      hillCount: {
        kind: 'number',
        min: 1,
        max: 64,
        default: 12,
        step: 1,
        integer: true,
      },
      horizonHeight: {
        kind: 'number',
        min: 0,
        max: 0.9,
        default: 0.25,
        step: 0.01,
      },
      depthFalloff: {
        kind: 'number',
        min: 0.25,
        max: 4,
        default: 2,
        step: 0.05,
      },
      ridgeScale: {
        kind: 'number',
        min: 0.25,
        max: 12,
        default: 3.5,
        step: 0.05,
      },
      ridgeAmplitude: {
        kind: 'number',
        min: 0,
        max: 1,
        default: 0.8,
        step: 0.01,
      },
      terrainDrift: {
        kind: 'number',
        min: 0,
        max: 8,
        default: 1.25,
        step: 0.05,
      },
      backgroundColor: { kind: 'color', default: '#ffffff' },
      hillColor: { kind: 'color', default: '#ffffff' },
      hillStrokeColor: { kind: 'color', default: '#000000' },
    })
    expect(grassHills.schema.hillCount.integer).toBe(true)
    expect(grassHills.time).toBeUndefined()
  })

  it.each([
    ['square', SQUARE],
    ['non-square', WIDE],
  ])('composes into the exact supplied %s frame', (_label, frame) => {
    const scene = grassHills.generate({}, 'frame', 0, frame)

    expect(scene.space).toEqual(frame)
    expect(scene.space).not.toBe(frame)
    expect(scene.background).toEqual({ color: '#ffffff' })
    expect(scene.primitives).toHaveLength(12)
  })

  it('uses hillCount as the primitive count', () => {
    expect(grassHills.generate({ hillCount: 1 }, 'count', 0, SQUARE).primitives).toHaveLength(1)
    expect(grassHills.generate({ hillCount: 37 }, 'count', 0, SQUARE).primitives).toHaveLength(37)
  })

  it('emits filled and stroked explicit rings with open path metadata', () => {
    const scene = grassHills.generate(
      {
        hillCount: 3,
        backgroundColor: '#f7f3e8',
        hillColor: '#88aa55',
        hillStrokeColor: '#102010',
      },
      'rings',
      0,
      WIDE,
    )

    expect(scene.background).toEqual({ color: '#f7f3e8' })
    for (const primitive of scene.primitives) {
      expect(primitive.fill).toEqual({ color: '#88aa55' })
      expect(primitive.stroke).toEqual({ color: '#102010', width: 2 })
      expect(primitive.closed).toBe(false)
      expect(primitive.points.at(-1)).toEqual(primitive.points[0])
      expect(primitive.points[0]![0]).toBeLessThan(0)
      expect(primitive.points.at(-4)![0]).toBeGreaterThan(WIDE.width)
      expect(primitive.points.at(-3)![1]).toBeGreaterThan(WIDE.height)
      expect(primitive.points.at(-2)![1]).toBeGreaterThan(WIDE.height)
    }
  })

  it('preserves far-to-near painter order', () => {
    const scene = grassHills.generate(
      { hillCount: 8, ridgeAmplitude: 0 },
      'painter-order',
      0,
      SQUARE,
    )
    const baselineYs = scene.primitives.map((primitive) => primitive.points[0]![1])

    for (let index = 1; index < baselineYs.length; index++) {
      expect(baselineYs[index]).toBeGreaterThan(baselineYs[index - 1]!)
    }
  })
})

describe('grass-hills preparation and determinism', () => {
  const params = {
    hillCount: 7,
    horizonHeight: 0.31,
    depthFalloff: 2.4,
    ridgeScale: 4.25,
    ridgeAmplitude: 0.72,
    terrainDrift: 2.1,
    backgroundColor: '#faf7ed',
    hillColor: '#8ea769',
    hillStrokeColor: '#172211',
  }

  it('makes warm and cold generation byte-identical', () => {
    const warm = grassHills.prepare(params, 'warm-cold', WIDE)(3.5)
    const cold = grassHills.generate(params, 'warm-cold', 3.5, WIDE)

    expect(warm).toEqual(cold)
  })

  it('returns identical static scenes for different t values', () => {
    const sample = grassHills.prepare(params, 'static-time', WIDE)

    expect(sample(-100)).toEqual(sample(0))
    expect(sample(0)).toEqual(sample(1234.5))
  })

  it('keeps geometry deterministic and seed-owned', () => {
    const first = grassHills.generate(params, 'terrain-a', 0, WIDE)
    const repeated = grassHills.generate(params, 'terrain-a', 0, WIDE)
    const reseeded = grassHills.generate(params, 'terrain-b', 0, WIDE)

    expect(first).toEqual(repeated)
    expect(geometry(first)).not.toEqual(geometry(reseeded))
  })

  it('keeps color changes out of geometry', () => {
    const base = grassHills.generate(params, 'colors', 0, WIDE)
    const recolored = grassHills.generate(
      {
        ...params,
        backgroundColor: '#010203',
        hillColor: '#aabbcc',
        hillStrokeColor: '#ddeeff',
      },
      'colors',
      0,
      WIDE,
    )

    expect(geometry(recolored)).toEqual(geometry(base))
  })

  it('returns fresh Scene-owned containers and resists caller mutation', () => {
    const sample = grassHills.prepare(params, 'isolated', WIDE)
    const first = sample(0)
    const pristine = sample(1)

    expect(first).toEqual(pristine)
    expect(first).not.toBe(pristine)
    expect(first.space).not.toBe(pristine.space)
    expect(first.background).not.toBe(pristine.background)
    expect(first.primitives).not.toBe(pristine.primitives)
    expect(first.primitives[0]).not.toBe(pristine.primitives[0])
    expect(first.primitives[0]!.points).not.toBe(pristine.primitives[0]!.points)
    expect(first.primitives[0]!.points[0]).not.toBe(pristine.primitives[0]!.points[0])
    expect(first.primitives[0]!.fill).not.toBe(pristine.primitives[0]!.fill)
    expect(first.primitives[0]!.stroke).not.toBe(pristine.primitives[0]!.stroke)

    first.space.width = -1
    first.background!.color = '#000000'
    first.primitives[0]!.points[0]![0] = Number.NaN
    first.primitives[0]!.fill!.color = '#000000'
    first.primitives[0]!.stroke!.width = 999
    first.primitives.reverse()

    expect(sample(2)).toEqual(pristine)
  })
})
