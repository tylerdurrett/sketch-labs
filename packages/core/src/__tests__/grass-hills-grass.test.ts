import { describe, expect, it } from 'vitest'

import { clamp, lerp } from '../math'
import { createRandom } from '../random'
import {
  grassScaleAtY,
  type HillDepthProjection,
} from '../sketches/grass-hills/depth'
import {
  buildGrassBlades,
  resolveMaximumUnscaledBladeLength,
} from '../sketches/grass-hills/grass'
import type { GrassHillMask } from '../sketches/grass-hills/grass-placement'
import type { GrassRootCandidate } from '../sketches/grass-hills/grass-scatter'

const PROJECTION: HillDepthProjection = {
  frame: { height: 100 },
  horizonHeight: 0.2,
  depthFalloff: 1,
}

const ROOTS: readonly GrassRootCandidate[] = Object.freeze([
  Object.freeze({ u: 0.25, v: 0.2, ordinal: 3, rootKey: '2/3:3' }),
  Object.freeze({ u: 0.75, v: 0.8, ordinal: 8, rootKey: '2/3:8' }),
])

const SHAPE_OPTIONS = {
  bladeLength: 20,
  bladeLengthVariance: 6,
  bladeWidth: 3,
  stiffnessVariance: 0.75,
  windLean: 0.4,
} as const

function fixedMask(y: number, width = 200): GrassHillMask {
  return {
    frame: { width, height: PROJECTION.frame.height },
    projection: PROJECTION,
    boundsAtX: () => ({ upperY: y, lowerY: y }),
  }
}

function rangedMask(): GrassHillMask {
  return {
    frame: { width: 200, height: PROJECTION.frame.height },
    projection: PROJECTION,
    boundsAtX: (x) => ({
      upperY: 25 + x / 40,
      lowerY: 70 + x / 20,
    }),
  }
}

function build(
  overrides: Partial<Parameters<typeof buildGrassBlades>[0]> = {},
) {
  return buildGrassBlades({
    seed: 'seed-a',
    hillKey: '2/3',
    roots: ROOTS,
    mask: fixedMask(60),
    ...SHAPE_OPTIONS,
    ...overrides,
  })
}

describe('grass blade descriptors', () => {
  it('uses exactly four root-local draws in length, width, stiffness, lean order', () => {
    const [descriptor] = build({ roots: [ROOTS[0]!] })
    const random = createRandom('seed-a-grass-blade-2/3:3')
    const lengthRoll = random.value()
    const widthRoll = random.value()
    const stiffnessRoll = random.value()
    const leanRoll = random.value()
    const scale = grassScaleAtY(descriptor!.projected[1], PROJECTION)
    const unscaledLength = clamp(
      SHAPE_OPTIONS.bladeLength +
        (2 * lengthRoll - 1) * SHAPE_OPTIONS.bladeLengthVariance,
      1,
      120,
    )

    expect(descriptor!.rolls).toEqual({
      length: lengthRoll,
      width: widthRoll,
      stiffness: stiffnessRoll,
      lean: leanRoll,
    })
    expect(descriptor!.shape).toEqual({
      length: unscaledLength * scale,
      width:
        clamp(
          SHAPE_OPTIONS.bladeWidth * lerp(0.8, 1.2, widthRoll),
          0.1,
          0.8 * unscaledLength,
        ) * scale,
      stiffness: clamp(
        2.5 +
          (2 * stiffnessRoll - 1) *
            SHAPE_OPTIONS.stiffnessVariance *
            1.5,
        1,
        4,
      ),
      lean: SHAPE_OPTIONS.windLean * lerp(0.8, 1.2, leanRoll),
    })
    // A fifth draw must not leak into any stored property.
    expect(Object.values(descriptor!.rolls)).not.toContain(random.value())
  })

  it('isolates roots from sibling insertion and iteration order', () => {
    const original = build()
    const extra = Object.freeze({
      u: 0.5,
      v: 0.5,
      ordinal: 99,
      rootKey: '2/3:99',
    })
    const reordered = build({ roots: [ROOTS[1]!, extra, ROOTS[0]!] })

    for (const descriptor of original) {
      expect(
        reordered.find(
          ({ identity }) => identity.rootKey === descriptor.identity.rootKey,
        ),
      ).toEqual(descriptor)
    }
  })

  it('repeats exactly for one seed and changes rolls for another seed', () => {
    expect(build()).toEqual(build())
    const reseeded = build({ seed: 'seed-b' })
    expect(reseeded.map(({ rolls }) => rolls)).not.toEqual(
      build().map(({ rolls }) => rolls),
    )
  })

  it('consumes rolls while zero variance resolves exact nominal values', () => {
    const [descriptor] = build({
      roots: [ROOTS[0]!],
      bladeLengthVariance: 0,
      stiffnessVariance: 0,
      windLean: 0,
      mask: fixedMask(100),
    })

    const random = createRandom('seed-a-grass-blade-2/3:3')
    expect(descriptor!.rolls).toEqual({
      length: random.value(),
      width: random.value(),
      stiffness: random.value(),
      lean: random.value(),
    })
    expect(descriptor!.shape.length).toBe(20)
    expect(descriptor!.shape.stiffness).toBe(2.5)
    expect(descriptor!.shape.lean).toBe(0)
  })

  it('clamps maximum variance to finite positive shape limits', () => {
    const descriptors = build({
      bladeLength: 4,
      bladeLengthVariance: 40,
      bladeWidth: 12,
      stiffnessVariance: 1,
      windLean: 1,
    })

    for (const { shape } of descriptors) {
      expect(Number.isFinite(shape.length)).toBe(true)
      expect(Number.isFinite(shape.width)).toBe(true)
      expect(Number.isFinite(shape.stiffness)).toBe(true)
      expect(Number.isFinite(shape.lean)).toBe(true)
      expect(shape.length).toBeGreaterThan(0)
      expect(shape.width).toBeGreaterThan(0)
      expect(shape.width).toBeLessThanOrEqual(0.8 * shape.length)
      expect(shape.stiffness).toBeGreaterThanOrEqual(1)
      expect(shape.stiffness).toBeLessThanOrEqual(4)
    }
  })

  it('stays valid across every supported cross-parameter extreme', () => {
    for (const bladeLength of [4, 80]) {
      for (const bladeLengthVariance of [0, 40]) {
        for (const bladeWidth of [0.5, 12]) {
          for (const stiffnessVariance of [0, 1]) {
            for (const windLean of [-1, 1]) {
              const descriptors = build({
                bladeLength,
                bladeLengthVariance,
                bladeWidth,
                stiffnessVariance,
                windLean,
              })
              for (const { shape } of descriptors) {
                expect(shape.length).toBeGreaterThan(0)
                expect(shape.width).toBeGreaterThan(0)
                expect(shape.width).toBeLessThanOrEqual(0.8 * shape.length)
                expect(shape.stiffness).toBeGreaterThanOrEqual(1)
                expect(shape.stiffness).toBeLessThanOrEqual(4)
                expect(Object.values(shape).every(Number.isFinite)).toBe(true)
              }
            }
          }
        }
      }
    }
  })

  it('applies exact y scale ratios only to length and width', () => {
    const root = ROOTS[0]!
    const [far] = build({
      roots: [root],
      bladeLengthVariance: 0,
      mask: fixedMask(20),
    })
    const [near] = build({
      roots: [root],
      bladeLengthVariance: 0,
      mask: fixedMask(100),
    })

    expect(near!.rolls).toEqual(far!.rolls)
    expect(near!.shape.length / far!.shape.length).toBe(5)
    expect(near!.shape.width / far!.shape.width).toBe(5)
    expect(near!.shape.stiffness).toBe(far!.shape.stiffness)
    expect(near!.shape.lean).toBe(far!.shape.lean)
  })

  it('deep-freezes identities, coordinates, rolls, shape, and result array', () => {
    const descriptors = build()
    const descriptor = descriptors[0]!

    expect(Object.isFrozen(descriptors)).toBe(true)
    expect(Object.isFrozen(descriptor)).toBe(true)
    expect(Object.isFrozen(descriptor.identity)).toBe(true)
    expect(Object.isFrozen(descriptor.canonical)).toBe(true)
    expect(Object.isFrozen(descriptor.projected)).toBe(true)
    expect(Object.isFrozen(descriptor.rolls)).toBe(true)
    expect(Object.isFrozen(descriptor.shape)).toBe(true)
    expect(descriptor.identity).toEqual({
      hillKey: '2/3',
      rootKey: '2/3:3',
      ordinal: 3,
    })
    expect(descriptor.canonical).toEqual({ u: 0.25, v: 0.2 })
  })

  it('projects every root inside its x-dependent hill mask', () => {
    const mask = rangedMask()
    const descriptors = build({ mask })

    for (const descriptor of descriptors) {
      const [x, y] = descriptor.projected
      const bounds = mask.boundsAtX(x)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(mask.frame.width)
      expect(y).toBeGreaterThanOrEqual(bounds.upperY)
      expect(y).toBeLessThanOrEqual(bounds.lowerY)
    }
  })

  it('clamps the caller mask reach to the same unscaled length domain', () => {
    expect(resolveMaximumUnscaledBladeLength(20, 6)).toBe(26)
    expect(resolveMaximumUnscaledBladeLength(4, 40)).toBe(44)
    expect(resolveMaximumUnscaledBladeLength(80, 40)).toBe(120)
    expect(resolveMaximumUnscaledBladeLength(-10, 0)).toBe(1)
  })
})
