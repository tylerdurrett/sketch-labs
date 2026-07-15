import { describe, expect, it } from 'vitest'

import type { CoordinateSpace } from '../scene'
import {
  grassScaleAtY,
  type HillDepthProjection,
} from '../sketches/grass-hills/depth'
import {
  createGrassHillMask,
  projectDensityQuantile,
  projectGrassRoot,
  ridgelineYAtX,
  type RidgeProfile,
} from '../sketches/grass-hills/grass-placement'

const FRAME: CoordinateSpace = { width: 100, height: 100 }
const PROJECTION: HillDepthProjection = {
  frame: FRAME,
  horizonHeight: 0.2,
  depthFalloff: 1,
}

function ridge(ys: readonly [number, number, number]): RidgeProfile {
  const ridgePoints: [number, number][] = [
    [-10, ys[0]],
    [50, ys[1]],
    [110, ys[2]],
  ]
  return {
    points: [
      ...ridgePoints,
      [110, 150],
      [-10, 150],
      [-10, ys[0]],
    ],
  }
}

function mask(
  own = ridge([30, 40, 50]),
  nearer: RidgeProfile | null = ridge([60, 70, 80]),
  overrides: {
    maxUnscaledBladeLength?: number
    lowerClearance?: number
  } = {},
) {
  return createGrassHillMask({
    frame: FRAME,
    projection: PROJECTION,
    band: { lowerClearance: overrides.lowerClearance ?? 20 },
    ridge: own,
    ...(nearer === null ? {} : { nextNearerRidge: nearer }),
    maxUnscaledBladeLength: overrides.maxUnscaledBladeLength ?? 10,
  })
}

function referenceProjection(
  v: number,
  upperY: number,
  lowerY: number,
): number {
  if (v <= 0) return upperY
  if (v >= 1) return lowerY

  const steps = 8192
  const height = (lowerY - upperY) / steps
  const cumulative = new Array<number>(steps + 1).fill(0)
  let previous = 1 / grassScaleAtY(upperY, PROJECTION) ** 2
  for (let index = 1; index <= steps; index++) {
    const current =
      1 / grassScaleAtY(upperY + index * height, PROJECTION) ** 2
    cumulative[index] =
      cumulative[index - 1]! + ((previous + current) * height) / 2
    previous = current
  }

  const target = v * cumulative[steps]!
  let low = 0
  let high = steps
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (cumulative[middle]! < target) low = middle
    else high = middle
  }
  const fraction =
    (target - cumulative[low]!) /
    (cumulative[high]! - cumulative[low]!)
  return upperY + (low + fraction) * height
}

describe('grass-hills ridgeline interpolation', () => {
  it('interpolates the sampled terrain rather than the polygon closure', () => {
    const profile = ridge([20, 50, 80])

    expect(ridgelineYAtX(profile, 0)).toBe(25)
    expect(ridgelineYAtX(profile, 50)).toBe(50)
    expect(ridgelineYAtX(profile, 100)).toBe(75)
    // A closure-aware endpoint clamps to the last ridge sample, not bottomY=150.
    expect(ridgelineYAtX(profile, 1_000)).toBe(80)
  })

  it('keeps empty, singleton, and non-finite interpolation inputs finite', () => {
    expect(ridgelineYAtX({ points: [] }, 10)).toBe(0)
    expect(ridgelineYAtX({ points: [[2, 7]] }, 10)).toBe(7)
    expect(ridgelineYAtX(ridge([20, 50, 80]), Number.NaN)).toBe(20)
    expect(ridgelineYAtX(ridge([20, 50, 80]), Infinity)).toBe(80)
  })
})

describe('grass-hills physical root masks', () => {
  it('uses the own ridge above and the nearer ridge plus a scaled margin below', () => {
    const hillMask = mask()
    const bounds = hillMask.boundsAtX(50)
    const scaleAtNearerRidge = grassScaleAtY(70, PROJECTION)

    expect(bounds.upperY).toBe(40)
    expect(bounds.lowerY).toBeCloseTo(70 + 10 * scaleAtNearerRidge, 12)
  })

  it('bounds the maximum-blade margin by the band lower clearance', () => {
    const bounds = mask(undefined, ridge([60, 70, 80]), {
      maxUnscaledBladeLength: 1_000,
      lowerClearance: 6,
    }).boundsAtX(50)

    expect(bounds).toEqual({ upperY: 40, lowerY: 76 })
  })

  it('uses the frame bottom for the nearest hill', () => {
    expect(mask(ridge([55, 60, 65]), null).boundsAtX(50)).toEqual({
      upperY: 60,
      lowerY: 100,
    })
  })

  it('clips relief to the frame and collapses crossing ridge domains', () => {
    const crossed = mask(
      ridge([35, 40, 45]),
      ridge([10, 15, 20]),
      { maxUnscaledBladeLength: 2 },
    ).boundsAtX(50)
    const offFrame = mask(
      ridge([150, 160, 170]),
      ridge([180, 190, 200]),
    ).boundsAtX(50)

    expect(crossed).toEqual({ upperY: 40, lowerY: 40 })
    expect(offFrame).toEqual({ upperY: 100, lowerY: 100 })
  })
})

describe('grass-hills canonical root projection', () => {
  it('maps exact endpoints and clamps out-of-range density quantiles', () => {
    expect(projectDensityQuantile(0, 25, 90, PROJECTION)).toBe(25)
    expect(projectDensityQuantile(1, 25, 90, PROJECTION)).toBe(90)
    expect(projectDensityQuantile(-1, 25, 90, PROJECTION)).toBe(25)
    expect(projectDensityQuantile(2, 25, 90, PROJECTION)).toBe(90)
  })

  it('is monotonic and byte-deterministic', () => {
    const quantiles = Array.from({ length: 101 }, (_, index) => index / 100)
    const first = quantiles.map((v) =>
      projectDensityQuantile(v, 25, 90, PROJECTION),
    )
    const second = quantiles.map((v) =>
      projectDensityQuantile(v, 25, 90, PROJECTION),
    )

    expect(second).toEqual(first)
    for (let index = 1; index < first.length; index++) {
      expect(first[index]).toBeGreaterThan(first[index - 1]!)
    }
  })

  it('puts every projected root inside its x-specific terrain mask', () => {
    const hillMask = mask()
    for (let uIndex = 0; uIndex <= 20; uIndex++) {
      for (let vIndex = 0; vIndex <= 20; vIndex++) {
        const [x, y] = projectGrassRoot(
          { u: uIndex / 20, v: vIndex / 20 },
          hillMask,
        )
        const bounds = hillMask.boundsAtX(x)
        expect(y).toBeGreaterThanOrEqual(bounds.upperY)
        expect(y).toBeLessThanOrEqual(bounds.lowerY)
      }
    }
  })

  it('tracks a high-resolution inverse CDF within one pinned cell', () => {
    const upperY = 20
    const lowerY = 95
    const cellHeight = (lowerY - upperY) / 64

    for (const v of [0.001, 0.03, 0.1, 0.25, 0.5, 0.8, 0.97, 0.999]) {
      const actual = projectDensityQuantile(v, upperY, lowerY, PROJECTION)
      const reference = referenceProjection(v, upperY, lowerY)
      expect(Math.abs(actual - reference)).toBeLessThan(cellHeight + 1e-9)
    }
  })

  it('produces the expected inverse-scale-squared empirical density', () => {
    const upperY = 20
    const lowerY = 100
    const midpoint = 60
    const sampleCount = 20_001
    let upperCount = 0

    for (let index = 0; index < sampleCount; index++) {
      const v = (index + 0.5) / sampleCount
      if (projectDensityQuantile(v, upperY, lowerY, PROJECTION) < midpoint) {
        upperCount++
      }
    }

    const expectedMidpointQuantile = (() => {
      const steps = 8192
      const dy = (lowerY - upperY) / steps
      let total = 0
      let upper = 0
      for (let index = 0; index < steps; index++) {
        const y = upperY + (index + 0.5) * dy
        const weight = 1 / grassScaleAtY(y, PROJECTION) ** 2
        total += weight
        if (y < midpoint) upper += weight
      }
      return upper / total
    })()

    expect(upperCount / sampleCount).toBeCloseTo(expectedMidpointQuantile, 3)
    expect(upperCount).toBeGreaterThan(sampleCount / 2)
  })

  it('collapses epsilon domains and keeps extreme roots finite', () => {
    expect(projectDensityQuantile(0.7, 42, 42 + 1e-13, PROJECTION)).toBe(42)

    const hillMask = mask()
    for (const root of [
      { u: Number.NaN, v: Number.NaN },
      { u: -Infinity, v: -Infinity },
      { u: Infinity, v: Infinity },
    ]) {
      const point = projectGrassRoot(root, hillMask)
      expect(point.every(Number.isFinite)).toBe(true)
      expect(point[0]).toBeGreaterThanOrEqual(0)
      expect(point[0]).toBeLessThanOrEqual(FRAME.width)
      expect(point[1]).toBeGreaterThanOrEqual(0)
      expect(point[1]).toBeLessThanOrEqual(FRAME.height)
    }
  })
})
