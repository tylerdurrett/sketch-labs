import { describe, expect, it } from 'vitest'

import type { CoordinateSpace } from '../scene'
import {
  grassScaleAtY,
  layoutHillBands,
  type HillBandDepth,
  type HillDepthProjection,
} from '../sketches/grass-hills/depth'
import {
  buildGrassBlades,
  resolveMaximumUnscaledBladeLength,
  type GrassBladeDescriptor,
} from '../sketches/grass-hills/grass'
import {
  createGrassHillMask,
  ridgelineYAtX,
  type GrassHillMask,
  type RidgeProfile,
} from '../sketches/grass-hills/grass-placement'
import {
  scatterGrassRoots,
  type GrassRootCandidate,
} from '../sketches/grass-hills/grass-scatter'
import {
  allocateGrassRootCounts,
  selectGrassRoots,
} from '../sketches/grass-hills/grass-selection'
import { buildRidgeBands } from '../sketches/grass-hills/ridge-bands'
import { createTerrainField } from '../sketches/grass-hills/terrain'

const FRAME: CoordinateSpace = { width: 1_600, height: 1_000 }
const SEED = 'canonical-acceptance'
const BLADE_DENSITY = 0.1
const SHAPE = {
  bladeLength: 28,
  bladeLengthVariance: 8,
  bladeWidth: 3,
  stiffnessVariance: 0.25,
  windLean: 0,
} as const

interface PreparedHill {
  readonly band: HillBandDepth
  readonly ridge: RidgeProfile
  readonly mask: GrassHillMask
  readonly candidates: readonly GrassRootCandidate[]
  readonly roots: readonly GrassRootCandidate[]
  readonly blades: readonly GrassBladeDescriptor[]
}

function prepareHills({
  hillCount,
  depthFalloff,
  ridgeAmplitude,
  seed = SEED,
}: {
  hillCount: number
  depthFalloff: number
  ridgeAmplitude: number
  seed?: string
}): {
  readonly projection: HillDepthProjection
  readonly hills: readonly PreparedHill[]
} {
  const projection = {
    frame: FRAME,
    horizonHeight: 0.25,
    depthFalloff,
  }
  const bands = layoutHillBands(hillCount, projection)
  const ridges = buildRidgeBands({
    frame: FRAME,
    bands,
    terrainAt: createTerrainField(seed, {
      ridgeScale: 3.5,
      terrainDrift: 1.25,
    }),
    ridgeAmplitude,
    ridgeSamples: 128,
  })
  const maxUnscaledBladeLength = resolveMaximumUnscaledBladeLength(
    SHAPE.bladeLength,
    SHAPE.bladeLengthVariance,
  )
  const rootCounts = allocateGrassRootCounts(
    bands.map(({ depth }) => depth),
    BLADE_DENSITY,
  )

  const hills = bands.map((band, index): PreparedHill => {
    const ridge = ridges[index]!
    const candidates = scatterGrassRoots({
      seed,
      hillKey: band.hillKey,
    })
    const roots = selectGrassRoots({
      count: rootCounts[index]!,
      candidates,
    })
    const mask = createGrassHillMask({
      frame: FRAME,
      projection,
      band,
      ridge,
      ...(index + 1 < ridges.length
        ? { nextNearerRidge: ridges[index + 1]! }
        : {}),
      maxUnscaledBladeLength,
    })

    return {
      band,
      ridge,
      mask,
      candidates,
      roots,
      blades: buildGrassBlades({
        seed,
        hillKey: band.hillKey,
        roots,
        mask,
        ...SHAPE,
      }),
    }
  })

  return { projection, hills }
}

function canonicalRows(roots: readonly GrassRootCandidate[]) {
  return roots.map(({ u, v, ordinal, rootKey }) => [
    u,
    v,
    ordinal,
    rootKey,
  ])
}

function fixedMask(y: number, projection: HillDepthProjection): GrassHillMask {
  return {
    frame: FRAME,
    projection,
    boundsAtX: () => ({ upperY: y, lowerY: y }),
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

function nearestSiblingDistances(
  blades: readonly GrassBladeDescriptor[],
): readonly number[] {
  return blades.map((blade, index) => {
    let nearest = Number.POSITIVE_INFINITY
    for (let other = 0; other < blades.length; other++) {
      if (other === index) continue
      nearest = Math.min(
        nearest,
        Math.hypot(
          blade.projected[0] - blades[other]!.projected[0],
          blade.projected[1] - blades[other]!.projected[1],
        ),
      )
    }
    return nearest
  })
}

describe('grass-hills canonical count stability', () => {
  it('retains complete roots, selection, and variation while reprojecting shared hills', () => {
    const countThree = prepareHills({
      hillCount: 3,
      depthFalloff: 2,
      ridgeAmplitude: 0,
    })
    const countSeven = prepareHills({
      hillCount: 7,
      depthFalloff: 2,
      ridgeAmplitude: 0,
    })

    expect(countThree.hills.map(({ band }) => band.hillKey)).toEqual([
      '3/4',
      '1/2',
      '1/4',
    ])
    expect(countSeven.hills.map(({ band }) => band.hillKey)).toEqual([
      '7/8',
      '3/4',
      '5/8',
      '1/2',
      '3/8',
      '1/4',
      '1/8',
    ])

    let movedVertically = false
    for (const atThree of countThree.hills) {
      const atSeven = countSeven.hills.find(
        ({ band }) => band.hillKey === atThree.band.hillKey,
      )!

      expect(canonicalRows(atSeven.candidates)).toEqual(
        canonicalRows(atThree.candidates),
      )
      const sharedCount = Math.min(atSeven.roots.length, atThree.roots.length)
      expect(atSeven.roots.slice(0, sharedCount)).toEqual(
        atThree.roots.slice(0, sharedCount),
      )

      for (const bladeAtThree of atThree.blades.slice(0, sharedCount)) {
        const bladeAtSeven = atSeven.blades.find(
          ({ identity }) =>
            identity.rootKey === bladeAtThree.identity.rootKey,
        )!
        expect(bladeAtSeven.canonical).toEqual(bladeAtThree.canonical)
        expect(bladeAtSeven.rolls).toEqual(bladeAtThree.rolls)
        expect(bladeAtSeven.projected[0]).toBe(bladeAtThree.projected[0])
        movedVertically ||=
          bladeAtSeven.projected[1] !== bladeAtThree.projected[1]

        for (const [blade, hill] of [
          [bladeAtThree, atThree],
          [bladeAtSeven, atSeven],
        ] as const) {
          const [x, y] = blade.projected
          const bounds = hill.mask.boundsAtX(x)
          expect(y).toBeGreaterThanOrEqual(bounds.upperY)
          expect(y).toBeLessThanOrEqual(bounds.lowerY)
        }
      }
    }
    expect(movedVertically).toBe(true)
  })
})

describe('grass-hills continuous perspective acceptance', () => {
  it('scales equal-roll blade length and width exactly at root depth', () => {
    const projection: HillDepthProjection = {
      frame: FRAME,
      horizonHeight: 0.25,
      depthFalloff: 2,
    }
    const root = {
      u: 0.5,
      v: 0.5,
      ordinal: 4,
      rootKey: '1/2:4',
    }
    const buildAt = (y: number) =>
      buildGrassBlades({
        seed: SEED,
        hillKey: '1/2',
        roots: [root],
        mask: fixedMask(y, projection),
        ...SHAPE,
      })[0]!
    const horizonward = buildAt(300)
    const foreground = buildAt(900)
    const expectedRatio =
      grassScaleAtY(900, projection) / grassScaleAtY(300, projection)

    expect(foreground.rolls).toEqual(horizonward.rolls)
    expect(foreground.shape.length / horizonward.shape.length).toBeCloseTo(
      expectedRatio,
      12,
    )
    expect(foreground.shape.width / horizonward.shape.width).toBeCloseTo(
      expectedRatio,
      12,
    )
  })

  it('shrinks characteristic spacing horizonward and varies size within one hill', () => {
    const { projection, hills } = prepareHills({
      hillCount: 7,
      depthFalloff: 2,
      ridgeAmplitude: 0,
    })
    const far = hills[0]!
    const near = hills.at(-1)!
    const rawSpacing = (hill: PreparedHill) =>
      median(nearestSiblingDistances(hill.blades))

    expect(rawSpacing(far)).toBeLessThan(rawSpacing(near))

    const probeRoot = {
      u: 0.5,
      v: 0.5,
      ordinal: 0,
      rootKey: 'within-hill:0',
    }
    const hillMask: GrassHillMask = {
      frame: FRAME,
      projection,
      boundsAtX: () => ({ upperY: 400, lowerY: 500 }),
    }
    const buildAtQuantile = (v: number) =>
      buildGrassBlades({
        seed: SEED,
        hillKey: 'within-hill',
        roots: [{ ...probeRoot, v }],
        mask: hillMask,
        ...SHAPE,
      })[0]!
    const atTop = buildAtQuantile(0)
    const atMiddle = buildAtQuantile(0.5)
    const atBottom = buildAtQuantile(1)

    expect(atBottom.rolls).toEqual(atTop.rolls)
    expect(atMiddle.shape.length).toBeGreaterThan(atTop.shape.length)
    expect(atBottom.shape.length).toBeGreaterThan(atMiddle.shape.length)
    expect(atMiddle.shape.width).toBeGreaterThan(atTop.shape.width)
    expect(atBottom.shape.width).toBeGreaterThan(atMiddle.shape.width)
  })

  it('has no conspicuous normalized-spacing step at representative adjacent boundaries', () => {
    for (const hillCount of [7, 50]) {
      for (const depthFalloff of [1, 2, 3]) {
        for (const ridgeAmplitude of [0, 0.8]) {
          let evaluated = 0
          const allAbove: number[] = []
          const allBelow: number[] = []

          // Two fixed root fields keep the sparse seven-hill sample meaningful
          // without turning this acceptance gate into a Monte Carlo benchmark.
          for (const seed of [SEED, 'canonical-spacing-b']) {
            const { projection, hills } = prepareHills({
              hillCount,
              depthFalloff,
              ridgeAmplitude,
              seed,
            })

            for (let index = 0; index + 1 < hills.length; index++) {
              const farther = hills[index]!
              const nearer = hills[index + 1]!
              const fartherDistances = nearestSiblingDistances(
                farther.blades,
              )
              const nearerDistances = nearestSiblingDistances(
                nearer.blades,
              )
              const strip = Math.min(
                farther.band.lowerClearance,
                nearer.band.lowerClearance,
              )
              const above = farther.blades.flatMap((blade, bladeIndex) => {
                const boundary = ridgelineYAtX(
                  nearer.ridge,
                  blade.projected[0],
                )
                return blade.projected[1] >= boundary - strip &&
                  blade.projected[1] < boundary
                  ? [
                      fartherDistances[bladeIndex]! /
                        grassScaleAtY(blade.projected[1], projection),
                    ]
                  : []
              })
              const below = nearer.blades.flatMap((blade, bladeIndex) => {
                const boundary = ridgelineYAtX(
                  nearer.ridge,
                  blade.projected[0],
                )
                return blade.projected[1] >= boundary &&
                  blade.projected[1] <= boundary + strip
                  ? [
                      nearerDistances[bladeIndex]! /
                        grassScaleAtY(blade.projected[1], projection),
                    ]
                  : []
              })

              if (above.length < 2 || below.length < 2) continue
              allAbove.push(...above)
              allBelow.push(...below)
              evaluated++
            }
          }
          const ratio = median(allBelow) / median(allAbove)

          expect(evaluated).toBeGreaterThanOrEqual(hillCount)
          expect(ratio).toBeGreaterThanOrEqual(0.75)
          // The adopted inverse-square inter-hill allocation deliberately
          // concentrates more roots in distant bands than the retired cap.
          expect(ratio).toBeLessThanOrEqual(1.5)
        }
      }
    }
  })
})
