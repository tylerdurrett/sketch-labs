import { describe, expect, it } from 'vitest'

import { grassScaleAtY } from '../../src/sketches/grass-hills/depth.ts'
import {
  exactCanonicalRoots,
  prepareExactComposition,
  sampleExactComposition,
} from './exact-common.js'
import { benchmarkCandidate as poisson33 } from './exact-poisson-33.js'
import { benchmarkCandidate as poisson7 } from './exact-poisson-7.js'
import { benchmarkCandidate as stratified33 } from './exact-stratified-33.js'
import { benchmarkCandidate as stratified7 } from './exact-stratified-7.js'
import { HISTORICAL_BASELINE } from './fixtures.js'

const BASE_PAYLOAD = HISTORICAL_BASELINE.payload
const CURRENT_RIDGE_POINTS = 134
const CURRENT_BASELINE_POINTS = 14_540

function payload({ hillCount = 1, bladeCount = 24 } = {}) {
  return {
    ...BASE_PAYLOAD,
    frame: { ...BASE_PAYLOAD.frame },
    params: { ...BASE_PAYLOAD.params, hillCount },
    request: { hillCount, bladeCount },
  }
}

function prepare(rootStrategy, bladeGeometry, overrides) {
  return prepareExactComposition(payload(overrides), {
    rootStrategy,
    bladeGeometry,
  })
}

describe('Grass Hills exact filled-blade candidates', () => {
  it.each(['poisson', 'stratified'])(
    'pins deterministic, nested canonical %s roots and exact counts',
    (strategy) => {
      const shorter = exactCanonicalRoots({
        strategy,
        seed: 12345,
        hillKey: '1/2',
        count: 12,
      })
      const longer = exactCanonicalRoots({
        strategy,
        seed: 12345,
        hillKey: '1/2',
        count: 24,
      })

      expect(longer).toHaveLength(24)
      expect(longer.slice(0, 12)).toEqual(shorter)
      expect(
        exactCanonicalRoots({
          strategy,
          seed: 12345,
          hillKey: '1/2',
          count: 12,
        }),
      ).toEqual(shorter)
      expect(new Set(longer.map((root) => root.rootKey)).size).toBe(24)
      for (const root of longer) {
        expect(root.hillKey).toBe('1/2')
        expect(root.rootKey.startsWith('1/2:')).toBe(true)
        expect(root.u).toBeGreaterThanOrEqual(0)
        expect(root.u).toBeLessThan(1)
        expect(root.v).toBeGreaterThanOrEqual(0)
        expect(root.v).toBeLessThan(1)
      }
    },
  )

  it('covers the pinned 10k one-hill request with the smaller Poisson radius', () => {
    expect(
      exactCanonicalRoots({
        strategy: 'poisson',
        seed: 12345,
        hillKey: '1/2',
        count: 10_000,
      }),
    ).toHaveLength(10_000)
  })

  it('retains reduced hill/root identity and four rolls across count reprojection', () => {
    const oneHill = prepare('stratified', 'simple-7', {
      hillCount: 1,
      bladeCount: 12,
    })
    const threeHills = prepare('stratified', 'simple-7', {
      hillCount: 3,
      bladeCount: 36,
    })
    const before = oneHill.hills.find((hill) => hill.hillKey === '1/2')
    const after = threeHills.hills.find((hill) => hill.hillKey === '1/2')

    expect(before).toBeDefined()
    expect(after).toBeDefined()
    expect(after.roots).toEqual(before.roots)
    expect(after.blades.map((blade) => blade.identity.rootKey).sort()).toEqual(
      before.blades.map((blade) => blade.identity.rootKey).sort(),
    )
    const beforeByKey = new Map(
      before.blades.map((blade) => [blade.identity.rootKey, blade]),
    )
    for (const descriptor of after.blades) {
      expect(descriptor.rolls).toEqual(
        beforeByKey.get(descriptor.identity.rootKey).rolls,
      )
    }
    expect(Object.keys(before.blades[0].rolls)).toEqual([
      'length',
      'width',
      'stiffness',
      'lean',
    ])
    expect(
      after.blades.some(
        (blade) =>
          blade.projected[0] !==
            beforeByKey.get(blade.identity.rootKey).projected[0] ||
          blade.projected[1] !==
            beforeByKey.get(blade.identity.rootKey).projected[1],
      ),
    ).toBe(true)
  })

  it('applies continuous depth scale to finite prepared blade shapes', () => {
    const composition = prepare('stratified', 'simple-7', {
      hillCount: 1,
      bladeCount: 24,
    })
    const projection = {
      frame: composition.frame,
      horizonHeight: BASE_PAYLOAD.params.horizonHeight,
      depthFalloff: BASE_PAYLOAD.params.depthFalloff,
    }

    for (const descriptor of composition.hills[0].blades) {
      const unscaledLength = Math.max(
        1,
        Math.min(
          120,
          BASE_PAYLOAD.params.bladeLength +
            (2 * descriptor.rolls.length - 1) *
              BASE_PAYLOAD.params.bladeLengthVariance,
        ),
      )
      expect(descriptor.shape.length).toBeCloseTo(
        unscaledLength * grassScaleAtY(descriptor.projected[1], projection),
        12,
      )
      expect(allFinite(descriptor.projected)).toBe(true)
      expect(allFinite(Object.values(descriptor.shape))).toBe(true)
      expect(allFinite(Object.values(descriptor.rolls))).toBe(true)
    }
  })

  it.each([
    ['detailed-33', 33],
    ['simple-7', 7],
  ])(
    'emits exact counts and explicitly closed finite %s geometry',
    (geometry, points) => {
      const result = sampleExactComposition(
        prepare('stratified', geometry, { hillCount: 2, bladeCount: 25 }),
        0.25,
      )
      const blades = result.scene.primitives.filter(
        (primitive) => primitive.closed === true,
      )
      const hills = result.scene.primitives.filter(
        (primitive) => primitive.closed !== true,
      )

      expect(blades).toHaveLength(25)
      expect(hills).toHaveLength(2)
      expect(result.roots).toHaveLength(25)
      expect(
        sampleExactComposition(
          prepare('stratified', geometry, {
            hillCount: 2,
            bladeCount: 25,
          }),
          0.25,
        ),
      ).toEqual(result)
      for (const primitive of blades) {
        expect(primitive.points).toHaveLength(points)
        expect(primitive.points.at(-1)).toEqual(primitive.points[0])
        expect(primitive.fill).toBeDefined()
        expect(allFinite(primitive.points.flat())).toBe(true)
      }
    },
  )

  it('matches the current 33-point baseline inventory and authored styles', () => {
    const result = sampleExactComposition(
      prepare('poisson', 'detailed-33', {
        hillCount: 10,
        bladeCount: 400,
      }),
      BASE_PAYLOAD.t,
    )
    const blades = result.scene.primitives.filter(
      (primitive) => primitive.closed === true,
    )
    const hills = result.scene.primitives.filter(
      (primitive) => primitive.closed !== true,
    )
    const pointCount = result.scene.primitives.reduce(
      (count, primitive) => count + primitive.points.length,
      0,
    )

    expect(result.scene.background).toEqual({
      color: BASE_PAYLOAD.params.backgroundColor,
    })
    expect(hills).toHaveLength(10)
    expect(blades).toHaveLength(400)
    expect(result.scene.primitives).toHaveLength(410)
    expect(
      hills.every((hill) => hill.points.length === CURRENT_RIDGE_POINTS),
    ).toBe(true)
    expect(
      hills.every(
        (hill) =>
          hill.fill?.color === BASE_PAYLOAD.params.hillColor &&
          hill.stroke?.color === BASE_PAYLOAD.params.hillStrokeColor &&
          hill.stroke?.width === 2,
      ),
    ).toBe(true)
    expect(
      blades.every(
        (blade) =>
          blade.points.length === 33 &&
          blade.fill?.color === BASE_PAYLOAD.params.bladeColor &&
          blade.stroke?.color === BASE_PAYLOAD.params.bladeStrokeColor &&
          blade.stroke?.width === 2,
      ),
    ).toBe(true)
    expect(pointCount).toBe(10 * CURRENT_RIDGE_POINTS + 400 * 33)
    expect(pointCount).toBe(CURRENT_BASELINE_POINTS)
  })

  it('exposes all four candidates through the common M2 protocol interface', () => {
    const candidates = [poisson33, poisson7, stratified33, stratified7]
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      'exact-poisson-33',
      'exact-poisson-7',
      'exact-stratified-33',
      'exact-stratified-7',
    ])

    for (const candidate of candidates) {
      expect(candidate.complexity).toBe('linear')
      expect(candidate.prepare).toEqual(expect.any(Function))
      expect(candidate.generate).toEqual(expect.any(Function))
      expect(candidate.guard).toEqual(expect.any(Function))
      expect(candidate.inspect).toEqual(expect.any(Function))
    }

    const fixture = payload({ hillCount: 1, bladeCount: 8 })
    const sampler = stratified7.prepare(fixture)
    const sampled = sampler(0.5)
    expect(stratified7.guard(sampler)).toBeGreaterThan(0)
    expect(
      stratified7.inspect({ value: sampled, payload: fixture }),
    ).toMatchObject({
      source: {
        primitiveCount: 9,
        pointCount: 8 * 7 + CURRENT_RIDGE_POINTS,
      },
      processing: { kind: 'supplied' },
      rootCount: 8,
      identity: {
        rootStrategy: 'stratified',
        bladeGeometry: 'simple-7',
        hillKeys: ['1/2'],
      },
      exactSpatialHiddenLine: {
        contract:
          'exact-painter-order/uniform-aabb-grid/production-polygon-clip',
      },
    })
  })
})

function allFinite(values) {
  return values.every(Number.isFinite)
}
