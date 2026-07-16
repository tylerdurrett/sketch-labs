import { describe, expect, it } from 'vitest'

import {
  DEFAULT_COMPOSITION_FRAME,
  resolveCompositionFrame,
} from '../compositionFrame'
import type { CoordinateSpace, Primitive, Scene } from '../scene'
import { defaultParams } from '../sketch'
import {
  createScribbleMoonStructuralScene,
  scribbleMoon,
  scribbleMoonSchema,
} from '../sketches/scribble-moon'

const SOURCE_CONTROL_KEYS = [
  'lightAngle',
  'terminatorSoftness',
  'toneContrast',
  'maskFeather',
]

function expectComposed(scene: Scene, frame: CoordinateSpace): void {
  expect(scene.space).toEqual(frame)
  for (const primitive of scene.primitives) {
    expect(primitive.points.length).toBeGreaterThan(1)
    for (const [x, y] of primitive.points) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(frame.width)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(frame.height)
    }
  }
}

function expectContainsStructuralScene(scene: Scene, structural: Scene): void {
  for (const primitive of structural.primitives) {
    expect(scene.primitives).toContainEqual(primitive)
  }
}

function expectAuthoredVector(primitive: Primitive): void {
  expect(Array.isArray(primitive.points)).toBe(true)
  expect(primitive.fill).toBeUndefined()
  expect(primitive.stroke?.color).toBe('black')
  expect(primitive.stroke?.width).toBeGreaterThan(0)
  expect(primitive.hiddenLineRole).toBeUndefined()
}

describe('Scribble Moon Sketch contract', () => {
  it('declares exactly the four bounded numeric source controls', () => {
    expect(Object.keys(scribbleMoon.schema)).toEqual(SOURCE_CONTROL_KEYS)
    expect(scribbleMoon.schema).toBe(scribbleMoonSchema)

    for (const key of SOURCE_CONTROL_KEYS) {
      const spec = scribbleMoon.schema[key]!
      expect(spec.kind).toBe('number')
      if (spec.kind !== 'number') throw new Error(`${key} is not numeric`)
      expect(spec.default).toBeGreaterThanOrEqual(spec.min)
      expect(spec.default).toBeLessThanOrEqual(spec.max)
    }
  })

  it('delegates defaults and live control values to the accepted source model', () => {
    const defaults = defaultParams(scribbleMoon.schema)
    const defaultSource = scribbleMoon.generateToneSource!(
      defaults,
      DEFAULT_COMPOSITION_FRAME,
    )
    const adjustedSource = scribbleMoon.generateToneSource!(
      {
        ...defaults,
        lightAngle: 205,
        terminatorSoftness: 0.8,
        toneContrast: 0.9,
        maskFeather: 0.2,
      },
      DEFAULT_COMPOSITION_FRAME,
    )
    const { sphere } = defaultSource.layout
    const left = [
      sphere.center[0] - sphere.radius * 0.72,
      sphere.center[1],
    ] as const

    expect(defaultSource.layout.frame).toEqual(DEFAULT_COMPOSITION_FRAME)
    expect(adjustedSource.layout).toEqual(defaultSource.layout)
    expect(adjustedSource.toneField.sample(left)).not.toBe(
      defaultSource.toneField.sample(left),
    )
    expect(adjustedSource.maskFeatherWidth).not.toBe(
      defaultSource.maskFeatherWidth,
    )
  })
})

describe('Scribble Moon structural artwork', () => {
  it.each([
    ['square', resolveCompositionFrame(1)],
    ['portrait', resolveCompositionFrame(2 / 3)],
    ['landscape', resolveCompositionFrame(3 / 2)],
  ])(
    'uses the exact %s Composition Frame and keeps every contour inside it',
    (_name, frame) => {
      const scene = createScribbleMoonStructuralScene(frame)
      expectComposed(scene, frame)
      expect(scene.space).not.toBe(frame)
    },
  )

  it('is a bounded sparse set of authored vectors for every named element', () => {
    const scene = createScribbleMoonStructuralScene(DEFAULT_COMPOSITION_FRAME)
    const closed = scene.primitives.filter(
      (primitive) => primitive.closed === true,
    )
    const open = scene.primitives.filter(
      (primitive) => primitive.closed === false,
    )

    // 1 halo + 2 ring segments + 2 satellites + 1 sphere + 4 craters +
    // 3 structural contours. This count belongs to the fixed helper only; later
    // generated Scribble paths may be appended without changing this assertion.
    expect(scene.primitives).toHaveLength(13)
    expect(closed).toHaveLength(8)
    expect(open).toHaveLength(5)
    expect(scene.primitives.flatMap(({ points }) => points).length).toBeLessThan(
      600,
    )
    scene.primitives.forEach(expectAuthoredVector)
    expect(scene.background).toBeUndefined()
  })

  it('keeps its structural helper byte-identical and present across Seeds', () => {
    const frame = resolveCompositionFrame(16 / 9)
    const params = defaultParams(scribbleMoon.schema)
    const structural = createScribbleMoonStructuralScene(frame)
    const structuralAgain = createScribbleMoonStructuralScene(frame)
    const first = scribbleMoon.generate(params, 'seed-a', 0, frame)
    const second = scribbleMoon.generate(params, 'seed-b', 0, frame)

    expect(JSON.stringify(structuralAgain)).toBe(JSON.stringify(structural))
    expectContainsStructuralScene(first, structural)
    expectContainsStructuralScene(second, structural)
  })

  it('keeps source layout and samples byte-identical when artwork Seed changes', () => {
    const frame = resolveCompositionFrame(4 / 3)
    const params = defaultParams(scribbleMoon.schema)
    // generateToneSource has no Seed argument by contract. Interleaving two
    // differently Seeded artwork calls demonstrates the source remains separate
    // from that axis without requiring all future generated paths to match.
    scribbleMoon.generate(params, 'first-seed', 0, frame)
    const first = scribbleMoon.generateToneSource!(params, frame)
    scribbleMoon.generate(params, 'second-seed', 0, frame)
    const second = scribbleMoon.generateToneSource!(params, frame)
    const samplePoints = [
      first.layout.sphere.center,
      first.layout.craters[0]!.center,
      [0, 0] as const,
    ]

    expect(JSON.stringify(second.layout)).toBe(JSON.stringify(first.layout))
    expect(
      samplePoints.map((point) => [
        second.toneField.sample(point),
        second.shadingMask.sample(point),
      ]),
    ).toEqual(
      samplePoints.map((point) => [
        first.toneField.sample(point),
        first.shadingMask.sample(point),
      ]),
    )
  })

  it('keeps normal artwork vector-only and free of grayscale field encoding', () => {
    const scene = scribbleMoon.generate(
      defaultParams(scribbleMoon.schema),
      'normal-artwork',
      0,
      DEFAULT_COMPOSITION_FRAME,
    )

    scene.primitives.forEach(expectAuthoredVector)
    expect(JSON.stringify(scene)).not.toMatch(
      /imageData|pixel|raster|tile|toneField|shadingMask|gray/i,
    )
  })
})
