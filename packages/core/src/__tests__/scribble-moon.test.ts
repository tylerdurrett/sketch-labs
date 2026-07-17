import { describe, expect, it } from 'vitest'

import {
  DEFAULT_COMPOSITION_FRAME,
  resolveCompositionFrame,
} from '../compositionFrame'
import type { CoordinateSpace, Primitive, Scene } from '../scene'
import { defaultParams } from '../sketch'
import {
  createScribbleMoonStructuralScene,
  generateScribbleMoonScribble,
  scribbleMoon,
  scribbleMoonSchema,
  type ScribbleMoonSource,
} from '../sketches/scribble-moon'
import type { ScribbleResult } from '../scribbleStrategy'
import type { Point } from '../types'

const SOURCE_CONTROL_KEYS = [
  'lightAngle',
  'terminatorSoftness',
  'toneContrast',
  'maskFeather',
] as const
const SCRIBBLE_CONTROL_KEYS = [
  'pathDensity',
  'scribbleScale',
  'momentum',
  'chaos',
  'toneFidelity',
] as const
const CONTROL_KEYS = [...SOURCE_CONTROL_KEYS, ...SCRIBBLE_CONTROL_KEYS]
const FORBIDDEN_CONTROL_KEYS = [
  'segmentLength',
  'coverageRadius',
  'residualSpacing',
  'maskCheckSpacing',
  'coveragePerPass',
  'completionThreshold',
  'maxAcceptedSegments',
  'maxPolylines',
  'strategy',
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

function expectAuthoredVector(primitive: Primitive): void {
  expect(Array.isArray(primitive.points)).toBe(true)
  expect(primitive.fill).toBeUndefined()
  expect(primitive.stroke?.color).toBe('black')
  expect(primitive.stroke?.width).toBeGreaterThan(0)
  expect(primitive.hiddenLineRole).toBeUndefined()
}

function sourceSnapshot(source: ScribbleMoonSource) {
  const { frame } = source.layout
  const columns = 13
  const rows = 11
  const samples = []

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const point = [
        ((column + 0.5) / columns) * frame.width,
        ((row + 0.5) / rows) * frame.height,
      ] as const
      samples.push([
        point,
        source.toneField.sample(point),
        source.shadingMask.sample(point),
      ])
    }
  }

  return {
    layout: source.layout,
    maskFeatherWidth: source.maskFeatherWidth,
    samples,
  }
}

function independentlySampleMask(
  result: ScribbleResult,
  source: ScribbleMoonSource,
  frame: CoordinateSpace,
): { sawSoftPermission: boolean } {
  // This spacing is intentionally independent of Scribble's derived mask-check
  // ratio and finer than one thousandth of the shorter frame extent.
  const maxSpacing = Math.min(frame.width, frame.height) / 1_000
  let sawSoftPermission = false

  for (const polyline of result.polylines) {
    for (let index = 1; index < polyline.length; index++) {
      const start = polyline[index - 1]!
      const end = polyline[index]!
      const intervals = Math.max(
        1,
        Math.ceil(
          Math.hypot(end[0] - start[0], end[1] - start[1]) / maxSpacing,
        ),
      )

      for (let step = 0; step <= intervals; step++) {
        const progress = step / intervals
        const point: Point = [
          start[0] + (end[0] - start[0]) * progress,
          start[1] + (end[1] - start[1]) * progress,
        ]
        const permission = source.shadingMask.sample(point)
        expect(permission).toBeGreaterThan(0)
        if (permission < 1) sawSoftPermission = true
      }
    }
  }

  return { sawSoftPermission }
}

describe('Scribble Moon Sketch contract', () => {
  it('declares exactly four source controls plus five shared Scribble controls', () => {
    expect(Object.keys(scribbleMoon.schema)).toEqual(CONTROL_KEYS)
    expect(scribbleMoon.schema).toBe(scribbleMoonSchema)

    for (const key of CONTROL_KEYS) {
      const spec = scribbleMoon.schema[key]!
      expect(spec.kind).toBe('number')
      if (spec.kind !== 'number') throw new Error(`${key} is not numeric`)
      expect(spec.default).toBeGreaterThanOrEqual(spec.min)
      expect(spec.default).toBeLessThanOrEqual(spec.max)
    }

    expect(
      Object.keys(scribbleMoon.schema).filter((key) =>
        FORBIDDEN_CONTROL_KEYS.includes(key),
      ),
    ).toEqual([])
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

  it('keeps its structural helper byte-identical', () => {
    const frame = resolveCompositionFrame(16 / 9)
    const structural = createScribbleMoonStructuralScene(frame)
    const structuralAgain = createScribbleMoonStructuralScene(frame)

    expect(JSON.stringify(structuralAgain)).toBe(JSON.stringify(structural))
  })

  it('keeps exact source metadata and lattice samples independent of Seed and Scribble controls while routes differ', () => {
    const frame = resolveCompositionFrame(4 / 3)
    const params = defaultParams(scribbleMoon.schema)
    const adjusted = {
      ...params,
      pathDensity: 10,
      scribbleScale: 0.5,
      momentum: scribbleMoonSchema.momentum.min,
      chaos: scribbleMoonSchema.chaos.max,
      toneFidelity: scribbleMoonSchema.toneFidelity.min,
    }
    const before = scribbleMoon.generateToneSource!(params, frame)
    const seedA = generateScribbleMoonScribble(params, 'moon-seed-a', frame)
    const afterSeedA = scribbleMoon.generateToneSource!(params, frame)
    const seedB = generateScribbleMoonScribble(params, 'moon-seed-b', frame)
    const afterSeedB = scribbleMoon.generateToneSource!(params, frame)
    const adjustedRoute = generateScribbleMoonScribble(
      adjusted,
      'moon-seed-a',
      frame,
    )
    const afterControls = scribbleMoon.generateToneSource!(adjusted, frame)
    const expectedSource = sourceSnapshot(before)

    expect(sourceSnapshot(afterSeedA)).toEqual(expectedSource)
    expect(sourceSnapshot(afterSeedB)).toEqual(expectedSource)
    expect(sourceSnapshot(afterControls)).toEqual(expectedSource)
    expect(seedB.polylines).not.toEqual(seedA.polylines)
    expect(adjustedRoute.polylines).not.toEqual(seedA.polylines)
  })

  it('lets source controls change the target without changing structural geometry', () => {
    const frame = resolveCompositionFrame(3 / 2)
    const params = defaultParams(scribbleMoon.schema)
    const adjusted = {
      ...params,
      lightAngle: 205,
      terminatorSoftness: 0.8,
      toneContrast: 0.9,
      maskFeather: 0.2,
    }
    const structural = createScribbleMoonStructuralScene(frame)
    const defaultSource = scribbleMoon.generateToneSource!(params, frame)
    const adjustedSource = scribbleMoon.generateToneSource!(adjusted, frame)
    const defaultArtwork = scribbleMoon.generate(
      params,
      'source-controls',
      0,
      frame,
    )
    const adjustedArtwork = scribbleMoon.generate(
      adjusted,
      'source-controls',
      0,
      frame,
    )

    expect(sourceSnapshot(adjustedSource)).not.toEqual(
      sourceSnapshot(defaultSource),
    )
    expect(defaultArtwork.primitives.slice(0, 13)).toEqual(
      structural.primitives,
    )
    expect(adjustedArtwork.primitives.slice(0, 13)).toEqual(
      structural.primitives,
    )
  })

  it('returns byte-identical complete artwork for identical inputs and Seed', () => {
    const frame = resolveCompositionFrame(16 / 9)
    const params = defaultParams(scribbleMoon.schema)
    const first = scribbleMoon.generate(params, 'repeatable-moon', 0, frame)
    const second = scribbleMoon.generate(params, 'repeatable-moon', 0, frame)

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('keeps all 13 structural primitives as the exact prefix, then appends generated paths in painter order', () => {
    const frame = DEFAULT_COMPOSITION_FRAME
    const params = defaultParams(scribbleMoon.schema)
    const structural = createScribbleMoonStructuralScene(frame)
    const result = generateScribbleMoonScribble(params, 'painter-order', frame)
    const scene = scribbleMoon.generate(params, 'painter-order', 0, frame)
    const generated = scene.primitives.slice(structural.primitives.length)

    expect(scene.primitives.slice(0, 13)).toEqual(structural.primitives)
    expect(generated.map(({ points }) => points)).toEqual(result.polylines)
    expect(generated).toHaveLength(result.polylines.length)
    generated.forEach((primitive) => {
      expect(primitive.closed).toBe(false)
      expect(primitive.fill).toBeUndefined()
      expect(primitive.stroke).toEqual({ color: 'black', width: 1.1 })
      expect(primitive.hiddenLineRole).toBeUndefined()
    })
    expect(JSON.stringify(scene)).not.toMatch(
      /imageData|pixel|raster|tile|toneField|shadingMask|gray/i,
    )
  })

  it('independently samples generated segments through Moon soft permission and never exact zero', () => {
    const frame = DEFAULT_COMPOSITION_FRAME
    const params = defaultParams(scribbleMoon.schema)
    const source = scribbleMoon.generateToneSource!(params, frame)
    const result = generateScribbleMoonScribble(
      params,
      'moon-mask-safety',
      frame,
    )
    const sampled = independentlySampleMask(result, source, frame)

    expect(result.polylines.length).toBeGreaterThan(0)
    expect(sampled.sawSoftPermission).toBe(true)
  })
})
