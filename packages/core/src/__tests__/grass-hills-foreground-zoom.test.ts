import { describe, expect, it } from 'vitest'

import type { GrassBladeDescriptor } from '../sketches/grass-hills/grass'
import {
  applyForegroundZoom,
  type ForegroundZoomHill,
} from '../sketches/grass-hills/foreground-zoom'

function descriptor(
  projected: readonly [number, number],
): GrassBladeDescriptor {
  return {
    identity: { hillKey: '1/2', rootKey: 'cell-4', ordinal: 4 },
    canonical: { u: 0.25, v: 0.75 },
    projected,
    rolls: { length: 0.1, width: 0.2, stiffness: 0.3, lean: 0.4, survival: 0.5 },
    shape: { length: 12, width: 3, stiffness: 2.75, lean: -0.25 },
  }
}

function fixture(): readonly ForegroundZoomHill[] {
  return [
    {
      ridge: [
        [-10, 40],
        [50, 30],
        [110, 40],
        [110, 120],
        [-10, 120],
        [-10, 40],
      ],
      blades: [descriptor([25, 75])],
    },
  ]
}

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectDeeplyFrozen(child)
}

describe('grass-hills foreground zoom', () => {
  it('returns the exact input graph when zoom is one', () => {
    const hills = fixture()

    expect(
      applyForegroundZoom(hills, {
        frame: { width: 100, height: 100 },
        horizonHeight: 0.3,
        zoom: 1,
      }),
    ).toBe(hills)
  })

  it.each([
    ['square', { width: 100, height: 100 }, 0.3, [50, 30]],
    ['wide', { width: 200, height: 100 }, 0.4, [100, 40]],
    ['tall', { width: 100, height: 240 }, 0.25, [50, 60]],
  ] as const)(
    'uniformly transforms complete %s geometry around the horizon center',
    (_label, frame, horizonHeight, anchor) => {
      const hills: readonly ForegroundZoomHill[] = [
        {
          ridge: [
            [anchor[0] - 10, anchor[1] - 5],
            [anchor[0] + 20, anchor[1] + 15],
            [anchor[0] - 10, anchor[1] - 5],
          ],
          blades: [descriptor([anchor[0] + 5, anchor[1] + 10])],
        },
      ]

      const transformed = applyForegroundZoom(hills, {
        frame,
        horizonHeight,
        zoom: 1.5,
      })
      const hill = transformed[0]!
      const blade = hill.blades[0]!

      expect(hill.ridge).toEqual([
        [anchor[0] - 15, anchor[1] - 7.5],
        [anchor[0] + 30, anchor[1] + 22.5],
        [anchor[0] - 15, anchor[1] - 7.5],
      ])
      expect(blade.projected).toEqual([
        anchor[0] + 7.5,
        anchor[1] + 15,
      ])
      expect(blade.shape).toEqual({
        length: 18,
        width: 4.5,
        stiffness: 2.75,
        lean: -0.25,
      })
    },
  )

  it('preserves closure and stable descriptor data without modifying inputs', () => {
    const hills = fixture()
    const before = structuredClone(hills)

    const transformed = applyForegroundZoom(hills, {
      frame: { width: 100, height: 100 },
      horizonHeight: 0.3,
      zoom: 2.5,
    })
    const blade = transformed[0]!.blades[0]!

    expect(hills).toEqual(before)
    expect(transformed).not.toBe(hills)
    expect(transformed[0]!.ridge.at(-1)).toEqual(
      transformed[0]!.ridge[0],
    )
    expect(blade.identity).toEqual(hills[0]!.blades[0]!.identity)
    expect(blade.canonical).toEqual(hills[0]!.blades[0]!.canonical)
    expect(blade.rolls).toEqual(hills[0]!.blades[0]!.rolls)
    expect(blade.shape.lean).toBe(hills[0]!.blades[0]!.shape.lean)
    expect(blade.shape.stiffness).toBe(hills[0]!.blades[0]!.shape.stiffness)
    expectDeeplyFrozen(transformed)
  })
})
