import { describe, expect, it } from 'vitest'
import { computePlotMapping } from '../plotMapping'
import type { PlotProfile } from '../plotProfile'
import type { CoordinateSpace } from '../scene'

const profile: PlotProfile = {
  width: 240,
  height: 160,
  insets: { top: 20, right: 30, bottom: 40, left: 10 },
}

describe('computePlotMapping', () => {
  it('uniformly maps a matching frame into an asymmetric drawable rectangle', () => {
    // Drawable: 200 × 100 mm, so 400 × 200 Scene units map at 0.5 mm/unit.
    expect(computePlotMapping({ width: 400, height: 200 }, profile)).toEqual({
      scale: 0.5,
      offsetX: 10,
      offsetY: 20,
    })
  })

  it('uses the minimum scale and centers floating-point residual slack', () => {
    const space = { width: 2 / 3, height: 1 }
    const drawableAspect = space.width / space.height + Number.EPSILON
    const noisyProfile: PlotProfile = {
      width: 7 + drawableAspect,
      height: 6,
      insets: { top: 5, right: 0, bottom: 0, left: 7 },
    }

    const mapping = computePlotMapping(space, noisyProfile)
    const expectedScale = Math.min(
      drawableAspect / space.width,
      1 / space.height,
    )

    expect(mapping.scale).toBe(expectedScale)
    expect(mapping.offsetX).toBe(
      7 + (drawableAspect - space.width * expectedScale) / 2,
    )
    expect(mapping.offsetY).toBe(5 + (1 - space.height * expectedScale) / 2)
  })

  it('rejects materially different frame and drawable aspects', () => {
    expect(() =>
      computePlotMapping({ width: 1, height: 1 }, profile),
    ).toThrow(/Composition Frame aspect .* does not match drawable aspect/)
  })

  it.each([
    ['zero width', { width: 0, height: 1 }],
    ['negative height', { width: 1, height: -1 }],
    ['NaN width', { width: Number.NaN, height: 1 }],
    ['infinite height', { width: 1, height: Number.POSITIVE_INFINITY }],
  ] satisfies Array<[string, CoordinateSpace]>)('rejects a %s', (_name, space) => {
    expect(() => computePlotMapping(space, profile)).toThrow(
      /space (width|height) must be a finite positive number/,
    )
  })

  it('validates the profile through plotDrawableRectangle', () => {
    const invalid: PlotProfile = {
      width: 240,
      height: 160,
      insets: { top: 80, right: 30, bottom: 80, left: 10 },
    }

    expect(() =>
      computePlotMapping({ width: 400, height: 200 }, invalid),
    ).toThrow('validatePlotProfile')
  })

  it('is deterministic and does not mutate either input', () => {
    const space: CoordinateSpace = { width: 400, height: 200 }
    const mutableProfile: PlotProfile = {
      width: 240,
      height: 160,
      insets: { top: 20, right: 30, bottom: 40, left: 10 },
    }
    const originalSpace = structuredClone(space)
    const originalProfile = structuredClone(mutableProfile)

    const first = computePlotMapping(space, mutableProfile)
    const second = computePlotMapping(space, mutableProfile)

    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(space).toEqual(originalSpace)
    expect(mutableProfile).toEqual(originalProfile)
  })
})
