import { describe, expect, it } from 'vitest'
import { computePlotMapping } from '../plotMapping'
import type { PlotProfile } from '../plotProfile'
import type { CoordinateSpace } from '../scene'

const profile: PlotProfile = {
  width: 240,
  height: 160,
  insets: { top: 20, right: 30, bottom: 40, left: 10 },
  includeFrame: true,
}

function nextRepresentableFloat(value: number): number {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setFloat64(0, value)
  view.setBigUint64(0, view.getBigUint64(0) + 1n)
  return view.getFloat64(0)
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

  it('maps a portrait frame inside asymmetric portrait insets', () => {
    const portraitProfile: PlotProfile = {
      width: 120,
      height: 240,
      insets: { top: 10, right: 20, bottom: 30, left: 10 },
      includeFrame: true,
    }

    // Drawable: 90 × 200 mm, matching the portrait frame's 0.45 aspect.
    expect(
      computePlotMapping({ width: 450, height: 1_000 }, portraitProfile),
    ).toEqual({
      scale: 0.2,
      offsetX: 10,
      offsetY: 10,
    })
  })

  it('changes only physical mapping for proportional same-aspect profiles', () => {
    const space: CoordinateSpace = { width: 400, height: 200 }
    const originalSpace = structuredClone(space)
    const small: PlotProfile = {
      width: 120,
      height: 70,
      insets: { top: 10, right: 10, bottom: 10, left: 10 },
      includeFrame: true,
    }
    const doubled: PlotProfile = {
      width: 240,
      height: 140,
      insets: { top: 20, right: 20, bottom: 20, left: 20 },
      includeFrame: true,
    }

    expect(computePlotMapping(space, small)).toEqual({
      scale: 0.25,
      offsetX: 10,
      offsetY: 10,
    })
    expect(computePlotMapping(space, doubled)).toEqual({
      scale: 0.5,
      offsetX: 20,
      offsetY: 20,
    })
    expect(space).toEqual(originalSpace)
  })

  it('contains and centers a frame whose aspect is one ULP away', () => {
    const space = { width: 2 / 3, height: 1 }
    const spaceAspect = space.width / space.height
    const drawableAspect = nextRepresentableFloat(spaceAspect)
    const noisyProfile: PlotProfile = {
      width: drawableAspect,
      height: 1,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      includeFrame: true,
    }

    const mapping = computePlotMapping(space, noisyProfile)
    const expectedScale = Math.min(
      drawableAspect / space.width,
      1 / space.height,
    )

    const mappedMinX = mapping.offsetX
    const mappedMaxX = mapping.offsetX + space.width * mapping.scale
    const mappedMinY = mapping.offsetY
    const mappedMaxY = mapping.offsetY + space.height * mapping.scale
    const residualX = drawableAspect - space.width * mapping.scale
    const residualY = 1 - space.height * mapping.scale

    expect(drawableAspect).toBeGreaterThan(spaceAspect)
    expect(mapping.scale).toBe(expectedScale)
    expect(mappedMinX).toBeGreaterThanOrEqual(0)
    expect(mappedMaxX).toBeLessThanOrEqual(drawableAspect)
    expect(mappedMinY).toBeGreaterThanOrEqual(0)
    expect(mappedMaxY).toBeLessThanOrEqual(1)
    expect(mapping.offsetX).toBe(residualX / 2)
    expect(mapping.offsetY).toBe(residualY / 2)
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
      includeFrame: true,
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
      includeFrame: false,
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
