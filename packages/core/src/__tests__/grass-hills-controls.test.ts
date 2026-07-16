import { describe, expect, it } from 'vitest'

import type { CoordinateSpace, Primitive, Scene } from '../scene'
import { randomize } from '../sketch'
import { grassHills } from '../sketches/grass-hills'
import { grassScaleAtY } from '../sketches/grass-hills/depth'

const FRAME: CoordinateSpace = { width: 240, height: 160 }
const SEED = 'control-sensitivity'
const BASE_PARAMS = {
  hillCount: 1,
  horizonHeight: 0.2,
  depthFalloff: 1.5,
  foregroundZoom: 1,
  ridgeScale: 3,
  ridgeAmplitude: 0,
  terrainDrift: 1,
  bladeDensity: 0.004,
  bladeLength: 30,
  bladeLengthVariance: 0,
  bladeWidth: 2,
  stiffnessVariance: 0,
  windLean: 0.7,
  backgroundColor: '#f8f4e8',
  hillColor: '#638052',
  hillStrokeColor: '#263322',
  bladeColor: '#b8d095',
  bladeStrokeColor: '#172215',
} as const

function render(overrides: Record<string, unknown> = {}, seed = SEED): Scene {
  return grassHills.generate({ ...BASE_PARAMS, ...overrides }, seed, 0, FRAME)
}

function hills(scene: Scene): Primitive[] {
  return scene.primitives.filter(({ closed }) => closed === false)
}

function blades(scene: Scene): Primitive[] {
  return scene.primitives.filter(({ closed }) => closed === true)
}

function roots(scene: Scene): Array<[number, number]> {
  return blades(scene).map(({ points }) => [...points[0]!] as [number, number])
}

function pathMetadata(scene: Scene) {
  return scene.primitives.map(({ points, closed }) => ({ points, closed }))
}

function relativeBladeGeometry(scene: Scene) {
  return blades(scene).map(({ points }) => {
    const [rootX, rootY] = points[0]!
    return points.map(([x, y]) => [x - rootX, y - rootY])
  })
}

function bladeLength({ points }: Primitive): number {
  const root = points[0]!
  const tip = points[3]!
  return root[1] - tip[1]
}

function bladeWidth({ points }: Primitive): number {
  return Math.abs(points[1]![0] - points[5]![0])
}

function midpointBendRatio({ points }: Primitive): number {
  const rootX = points[0]![0]
  const tipX = points[3]![0]
  const midpointX = (points[1]![0] + points[5]![0]) / 2
  return (midpointX - rootX) / (tipX - rootX)
}

function shapeInvariants(scene: Scene): number[][] {
  const projection = {
    frame: FRAME,
    horizonHeight: BASE_PARAMS.horizonHeight,
    depthFalloff: BASE_PARAMS.depthFalloff,
  }

  return blades(scene)
    .map((primitive) => {
      const length = bladeLength(primitive)
      const root = primitive.points[0]!
      const tip = primitive.points[3]!
      return [
        length / grassScaleAtY(root[1], projection),
        bladeWidth(primitive) / length,
        (tip[0] - root[0]) / length,
        midpointBendRatio(primitive),
      ].map((value) => Number(value.toFixed(8)))
    })
    .sort((a, b) => {
      for (let index = 0; index < a.length; index++) {
        const difference = a[index]! - b[index]!
        if (difference !== 0) return difference
      }
      return 0
    })
}

function invariantValues(invariants: number[][], index: number): number[] {
  return invariants.map((values) => values[index]!).sort((a, b) => a - b)
}

describe('grass-hills control sensitivity', () => {
  it('uses zero bladeDensity as a literal off switch', () => {
    const scene = render({ bladeDensity: 0 })

    expect(hills(scene)).toHaveLength(1)
    expect(blades(scene)).toHaveLength(0)
  })

  it('uses bladeDensity to change rendered root count, identity, and placement', () => {
    const sparse = render({ bladeDensity: 0.0016 })
    const dense = render({ bladeDensity: 0.0032 })

    expect(blades(sparse)).toHaveLength(8)
    expect(blades(dense).length).toBeGreaterThan(blades(sparse).length)
    expect(roots(dense)).not.toEqual(roots(sparse))
    expect(relativeBladeGeometry(dense).slice(0, 4)).not.toEqual(
      relativeBladeGeometry(sparse),
    )
  })

  it('uses bladeLength only for longitudinal extent when variance is zero', () => {
    const short = render({ bladeLength: 15 })
    const long = render({ bladeLength: 30 })

    expect(roots(long)).toEqual(roots(short))
    for (let index = 0; index < blades(short).length; index++) {
      expect(bladeLength(blades(long)[index]!)).toBeCloseTo(
        2 * bladeLength(blades(short)[index]!),
      )
    }
  })

  it('uses bladeLengthVariance for seeded length spread without moving roots', () => {
    const uniform = render({ bladeLengthVariance: 0 })
    const varied = render({ bladeLengthVariance: 12 })
    const projection = {
      frame: FRAME,
      horizonHeight: BASE_PARAMS.horizonHeight,
      depthFalloff: BASE_PARAMS.depthFalloff,
    }
    const unscaledLengths = (scene: Scene) =>
      blades(scene).map(
        (primitive) =>
          bladeLength(primitive) /
          grassScaleAtY(primitive.points[0]![1], projection),
      )

    expect(roots(varied)).toEqual(roots(uniform))
    for (const length of unscaledLengths(uniform)) {
      expect(length).toBeCloseTo(30)
    }
    expect(new Set(unscaledLengths(varied).map((value) => value.toFixed(8))).size)
      .toBeGreaterThan(1)
  })

  it('uses bladeWidth only for transverse extent', () => {
    const narrow = render({ bladeWidth: 1 })
    const wide = render({ bladeWidth: 5 })

    expect(roots(wide)).toEqual(roots(narrow))
    for (let index = 0; index < blades(narrow).length; index++) {
      expect(bladeWidth(blades(wide)[index]!)).toBeCloseTo(
        5 * bladeWidth(blades(narrow)[index]!),
      )
    }
  })

  it('uses stiffnessVariance for nonuniform seeded bend profiles', () => {
    const uniform = render({ stiffnessVariance: 0 })
    const varied = render({ stiffnessVariance: 1 })
    const uniformProfiles = blades(uniform).map(midpointBendRatio)
    const variedProfiles = blades(varied).map(midpointBendRatio)

    expect(roots(varied)).toEqual(roots(uniform))
    expect(new Set(uniformProfiles.map((value) => value.toFixed(8)))).toHaveLength(
      1,
    )
    expect(new Set(variedProfiles.map((value) => value.toFixed(8))).size)
      .toBeGreaterThan(1)
    expect(variedProfiles).not.toEqual(uniformProfiles)
  })

  it('uses windLean for bend while preserving blade roots and longitudinal extent', () => {
    const still = render({ windLean: 0 })
    const leaning = render({ windLean: 1 })

    expect(roots(leaning)).toEqual(roots(still))
    expect(blades(leaning).map(bladeLength)).toEqual(blades(still).map(bladeLength))
    expect(relativeBladeGeometry(leaning)).not.toEqual(
      relativeBladeGeometry(still),
    )
  })

  it('applies bladeColor only to blade fills and bladeStrokeColor only to blade strokes', () => {
    const base = render()
    const fillChanged = render({ bladeColor: '#102030' })
    const strokeChanged = render({ bladeStrokeColor: '#405060' })

    expect(pathMetadata(fillChanged)).toEqual(pathMetadata(base))
    expect(pathMetadata(strokeChanged)).toEqual(pathMetadata(base))
    expect(fillChanged.background).toEqual(base.background)
    expect(hills(fillChanged)).toEqual(hills(base))
    expect(blades(fillChanged).map(({ fill }) => fill?.color)).toEqual(
      blades(base).map(() => '#102030'),
    )
    expect(blades(fillChanged).map(({ stroke }) => stroke)).toEqual(
      blades(base).map(({ stroke }) => stroke),
    )
    expect(strokeChanged.background).toEqual(base.background)
    expect(hills(strokeChanged)).toEqual(hills(base))
    expect(blades(strokeChanged).map(({ fill }) => fill)).toEqual(
      blades(base).map(({ fill }) => fill),
    )
    expect(blades(strokeChanged).map(({ stroke }) => stroke?.color)).toEqual(
      blades(base).map(() => '#405060'),
    )
  })
})

describe('grass-hills control workflow contracts', () => {
  it('randomizes every unlocked Grass/Wind number, honors locks and integer rules, and skips colors', () => {
    const locks = new Set(['depthFalloff', 'bladeLength'])
    const randomized = randomize(grassHills.schema, BASE_PARAMS, locks, () => 0.37)

    for (const key of [
      'horizonHeight',
      'foregroundZoom',
      'ridgeScale',
      'ridgeAmplitude',
      'terrainDrift',
      'bladeDensity',
      'bladeLengthVariance',
      'bladeWidth',
      'stiffnessVariance',
      'windLean',
    ] as const) {
      const spec = grassHills.schema[key]
      expect(randomized[key]).toBe(spec.min + 0.37 * (spec.max - spec.min))
    }
    expect(randomized.depthFalloff).toBe(BASE_PARAMS.depthFalloff)
    expect(randomized.bladeLength).toBe(BASE_PARAMS.bladeLength)
    expect(randomized.hillCount).toBe(
      Math.round(
        grassHills.schema.hillCount.min +
          0.37 *
            (grassHills.schema.hillCount.max - grassHills.schema.hillCount.min),
      ),
    )
    for (const key of [
      'backgroundColor',
      'hillColor',
      'hillStrokeColor',
      'bladeColor',
      'bladeStrokeColor',
    ] as const) {
      expect(randomized[key]).toBe(BASE_PARAMS[key])
    }

    const zoomLocked = randomize(
      grassHills.schema,
      BASE_PARAMS,
      new Set(['foregroundZoom']),
      () => 0.9,
    )
    expect(zoomLocked.foregroundZoom).toBe(BASE_PARAMS.foregroundZoom)
  })

  it.each([
    ['backgroundColor', '#010203'],
    ['hillColor', '#112233'],
    ['hillStrokeColor', '#223344'],
    ['bladeColor', '#334455'],
    ['bladeStrokeColor', '#445566'],
  ] as const)('keeps geometry and open/closed metadata fixed when recoloring %s', (key, color) => {
    expect(pathMetadata(render({ [key]: color }))).toEqual(pathMetadata(render()))
  })

  it('re-seeding changes both roots and root-keyed blade variation', () => {
    const liveVariation = {
      bladeLengthVariance: 12,
      stiffnessVariance: 1,
      windLean: 0.7,
    }
    const first = render(liveVariation, 'seed-a')
    const reseeded = render(liveVariation, 'seed-b')
    const firstInvariants = shapeInvariants(first)
    const reseededInvariants = shapeInvariants(reseeded)

    expect(roots(reseeded)).not.toEqual(roots(first))
    for (let invariant = 0; invariant < 4; invariant++) {
      expect(invariantValues(reseededInvariants, invariant)).not.toEqual(
        invariantValues(firstInvariants, invariant),
      )
    }
  })

  it('keeps warm, cold, and arbitrary-t static generation equal', () => {
    const warm = grassHills.prepare(BASE_PARAMS, SEED, FRAME)
    const cold = grassHills.generate(BASE_PARAMS, SEED, -10, FRAME)

    expect(warm(-10)).toEqual(cold)
    expect(warm(0)).toEqual(cold)
    expect(warm(987.6)).toEqual(cold)
  })

  it('isolates prepared output from mutation by earlier callers', () => {
    const sample = grassHills.prepare(BASE_PARAMS, SEED, FRAME)
    const first = sample(0)
    const pristine = sample(1)
    const firstBlade = blades(first)[0]!

    first.space.width = -1
    first.background!.color = '#000000'
    first.primitives[0]!.points[0]![0] = Number.NaN
    first.primitives[0]!.fill!.color = '#000000'
    first.primitives[0]!.stroke!.width = 999
    firstBlade.points[0]![0] = Number.NaN
    firstBlade.fill!.color = '#000000'
    firstBlade.stroke!.width = 999
    first.primitives.reverse()

    expect(sample(2)).toEqual(pristine)
  })
})

describe('grass-hills supported Grass/Wind extremes', () => {
  it('keeps every cross-parameter extreme finite, closed, and within shape bounds', () => {
    for (const bladeDensity of [0, 0.002]) {
      for (const bladeLengthParam of [4, 80]) {
        for (const bladeLengthVariance of [0, 40]) {
          for (const bladeWidthParam of [0.5, 12]) {
            for (const stiffnessVariance of [0, 1]) {
              for (const windLean of [-1, 1]) {
                const scene = render({
                  bladeDensity,
                  bladeLength: bladeLengthParam,
                  bladeLengthVariance,
                  bladeWidth: bladeWidthParam,
                  stiffnessVariance,
                  windLean,
                })

                if (bladeDensity === 0) {
                  expect(blades(scene)).toHaveLength(0)
                  continue
                }

                expect(blades(scene).length).toBeGreaterThan(0)
                for (const primitive of blades(scene)) {
                  const { points } = primitive
                  const length = bladeLength(primitive)
                  const width = bladeWidth(primitive)
                  const tipLean = (points[3]![0] - points[0]![0]) / length
                  const stiffness =
                    Math.log(Math.abs(midpointBendRatio(primitive))) /
                      Math.log(0.5) -
                    1

                  expect(primitive.closed).toBe(true)
                  expect(points[0]).toEqual(points.at(-1))
                  expect(points.flat().every(Number.isFinite)).toBe(true)
                  expect(length).toBeGreaterThan(0)
                  expect(width).toBeGreaterThan(0)
                  expect(width).toBeLessThanOrEqual(0.8 * length + 1e-10)
                  expect(Math.abs(tipLean)).toBeGreaterThanOrEqual(0.48)
                  expect(Math.abs(tipLean)).toBeLessThanOrEqual(1.52)
                  expect(stiffness).toBeGreaterThanOrEqual(1)
                  expect(stiffness).toBeLessThanOrEqual(4)
                }
              }
            }
          }
        }
      }
    }
  })
})
