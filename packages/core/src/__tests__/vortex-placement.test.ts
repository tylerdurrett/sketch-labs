import { describe, expect, it } from 'vitest'

import { placeSpheresAtVortices } from '../sketches/leaf-field/vortex-placement'

describe('placeSpheresAtVortices', () => {
  it('refines a round potential maximum to its off-grid center', () => {
    const center = [47, 63] as const
    const [sphere] = placeSpheresAtVortices(
      (x, y) => -((x - center[0]) ** 2 + (y - center[1]) ** 2),
      100,
      100,
      [{ radius: 10, tieBreaker: [0.1, 0.9] }],
    )

    expect(sphere?.cx).toBeCloseTo(center[0], 1)
    expect(sphere?.cy).toBeCloseTo(center[1], 1)
    expect(sphere?.r).toBe(10)
  })

  it('finds a basin as well as a peak', () => {
    const center = [35, 70] as const
    const [sphere] = placeSpheresAtVortices(
      (x, y) => (x - center[0]) ** 2 + (y - center[1]) ** 2,
      100,
      100,
      [{ radius: 12, tieBreaker: [0.8, 0.2] }],
    )

    expect(sphere?.cx).toBeCloseTo(center[0], 1)
    expect(sphere?.cy).toBeCloseTo(center[1], 1)
  })

  it('emits the exact request count on a flat fallback field without duplicating centers', () => {
    const requests = Array.from({ length: 6 }, (_, index) => ({
      radius: 20,
      tieBreaker: [index / 5, 1 - index / 5] as const,
    }))
    const spheres = placeSpheresAtVortices(() => 0, 100, 100, requests)

    expect(spheres).toHaveLength(requests.length)
    expect(new Set(spheres.map(({ cx, cy }) => `${cx},${cy}`)).size).toBe(spheres.length)
  })

  it('keeps crowded large-radius requests on distinct candidate centers', () => {
    const requests = Array.from({ length: 6 }, () => ({
      radius: 400,
      tieBreaker: [0.5, 0.5] as const,
    }))
    const spheres = placeSpheresAtVortices(
      (x, y) => Math.sin(x * 0.01) + Math.cos(y * 0.013),
      1000,
      1000,
      requests,
    )

    expect(new Set(spheres.map(({ cx, cy }) => `${cx},${cy}`)).size).toBe(spheres.length)
  })

  it('continues honoring the seeded tie-break anchor during refinement', () => {
    const tieBreaker = [0.333, 0.777] as const
    const radius = 10
    const [sphere] = placeSpheresAtVortices(() => 0, 100, 100, [
      { radius, tieBreaker },
    ])
    const expectedX = radius + tieBreaker[0] * (100 - radius * 2)
    const expectedY = radius + tieBreaker[1] * (100 - radius * 2)

    expect(sphere?.cx).toBeCloseTo(expectedX, 1)
    expect(sphere?.cy).toBeCloseTo(expectedY, 1)
  })

  it('keeps every requested circle fully on-canvas', () => {
    const spheres = placeSpheresAtVortices(
      (x, y) => Math.sin(x * 0.1) + Math.cos(y * 0.12),
      120,
      80,
      [
        { radius: 8, tieBreaker: [0.2, 0.4] },
        { radius: 39, tieBreaker: [0.8, 0.6] },
      ],
    )

    for (const { cx, cy, r } of spheres) {
      expect(cx - r).toBeGreaterThanOrEqual(0)
      expect(cy - r).toBeGreaterThanOrEqual(0)
      expect(cx + r).toBeLessThanOrEqual(120)
      expect(cy + r).toBeLessThanOrEqual(80)
    }
  })

  it('is deterministic and preserves an existing prefix when requests are appended', () => {
    const field = (x: number, y: number): number =>
      Math.sin(x * 0.09) + Math.cos(y * 0.11) + Math.sin((x + y) * 0.04)
    const requests = [
      { radius: 9, tieBreaker: [0.2, 0.7] as const },
      { radius: 14, tieBreaker: [0.8, 0.3] as const },
      { radius: 11, tieBreaker: [0.5, 0.5] as const },
    ]

    const short = placeSpheresAtVortices(field, 100, 100, requests.slice(0, 2))
    const long = placeSpheresAtVortices(field, 100, 100, requests)
    expect(placeSpheresAtVortices(field, 100, 100, requests)).toEqual(long)
    expect(long.slice(0, 2)).toEqual(short)
  })
})
