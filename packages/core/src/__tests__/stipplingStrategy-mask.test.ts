import { describe, expect, it, vi } from 'vitest'

import { createShadingMask } from '../shadingFields'
import { isMaskPermittedStipple } from '../stipplingStrategy/mask'
import type { CoordinateSpace } from '../scene'
import type { Point } from '../types'

const FRAME: CoordinateSpace = { width: 10, height: 10 }

describe('Stippling mask validation', () => {
  it.each([1, 0.25, Number.MIN_VALUE])(
    'accepts full or soft positive permission %s',
    (permission) => {
      const mask = createShadingMask(() => permission)

      expect(
        isMaskPermittedStipple(mask, FRAME, [1, 2], [9, 8], 0.5),
      ).toBe(true)
    },
  )

  it('uses ceil(length / maxSpacing) equal intervals including both endpoints', () => {
    const sample = vi.fn(() => 1)
    const mask = createShadingMask(sample)

    expect(
      isMaskPermittedStipple(mask, FRAME, [0, 5], [10, 5], 3),
    ).toBe(true)
    expect(sample.mock.calls.map(([point]) => point)).toEqual([
      [0, 5],
      [2.5, 5],
      [5, 5],
      [7.5, 5],
      [10, 5],
    ])
  })

  it('rejects exact-zero permission at either endpoint', () => {
    const startForbidden = createShadingMask(([x]) => (x === 1 ? 0 : 1))
    const endForbidden = createShadingMask(([x]) => (x === 9 ? 0 : 1))

    expect(
      isMaskPermittedStipple(startForbidden, FRAME, [1, 5], [9, 5], 2),
    ).toBe(false)
    expect(
      isMaskPermittedStipple(endForbidden, FRAME, [1, 5], [9, 5], 2),
    ).toBe(false)
  })

  it('rejects a crossing of a thin exact-zero barrier', () => {
    const mask = createShadingMask(([x]) =>
      x > 4.95 && x < 5.05 ? 0 : 1,
    )

    expect(
      isMaskPermittedStipple(mask, FRAME, [2, 5], [8, 5], 0.25),
    ).toBe(false)
  })

  it('rejects a segment joining disconnected permission islands', () => {
    const mask = createShadingMask(([x]) => (x <= 3 || x >= 7 ? 1 : 0))

    expect(
      isMaskPermittedStipple(mask, FRAME, [2, 5], [8, 5], 0.5),
    ).toBe(false)
  })

  it('allows hard mask boundaries but rejects crossing beyond them', () => {
    const mask = createShadingMask(([x, y]) =>
      x >= 2 && x <= 8 && y >= 3 && y <= 7 ? 1 : 0,
    )

    expect(
      isMaskPermittedStipple(mask, FRAME, [2, 3], [8, 7], 0.25),
    ).toBe(true)
    expect(
      isMaskPermittedStipple(mask, FRAME, [1.9, 3], [8, 7], 0.25),
    ).toBe(false)
  })

  it('treats Composition Frame edges as inclusive and rejects out-of-frame endpoints', () => {
    const mask = createShadingMask(() => 1)

    expect(
      isMaskPermittedStipple(mask, FRAME, [0, 0], [10, 10], 1),
    ).toBe(true)
    expect(
      isMaskPermittedStipple(mask, FRAME, [-0.01, 5], [5, 5], 1),
    ).toBe(false)
    expect(
      isMaskPermittedStipple(mask, FRAME, [5, 5], [10.01, 5], 1),
    ).toBe(false)
  })

  it('samples a zero-length segment once and still enforces mask and frame permission', () => {
    const sample = vi.fn(() => 0.4)
    const permitted = createShadingMask(sample)
    const forbidden = createShadingMask(() => 0)

    expect(
      isMaskPermittedStipple(permitted, FRAME, [10, 0], [10, 0], 1),
    ).toBe(true)
    expect(sample).toHaveBeenCalledTimes(1)
    expect(
      isMaskPermittedStipple(forbidden, FRAME, [5, 5], [5, 5], 1),
    ).toBe(false)
    expect(
      isMaskPermittedStipple(permitted, FRAME, [11, 5], [11, 5], 1),
    ).toBe(false)
  })

  it.each([
    [[Number.NaN, 1] as Point, [2, 2] as Point],
    [[1, Number.POSITIVE_INFINITY] as Point, [2, 2] as Point],
    [[1, 1] as Point, [Number.NEGATIVE_INFINITY, 2] as Point],
  ])('rejects malformed non-finite endpoints without sampling', (start, end) => {
    const sample = vi.fn(() => 1)
    const mask = createShadingMask(sample)

    expect(isMaskPermittedStipple(mask, FRAME, start, end, 1)).toBe(false)
    expect(sample).not.toHaveBeenCalled()
  })

  it('rejects finite endpoints whose distance overflows', () => {
    const sample = vi.fn(() => 1)
    const mask = createShadingMask(sample)
    const hugeFrame: CoordinateSpace = {
      width: Number.MAX_VALUE,
      height: Number.MAX_VALUE,
    }

    expect(
      isMaskPermittedStipple(
        mask,
        hugeFrame,
        [0, 0],
        [Number.MAX_VALUE, Number.MAX_VALUE],
        Number.MAX_VALUE,
      ),
    ).toBe(false)
    expect(sample).not.toHaveBeenCalled()
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maximum spacing %s',
    (maxSpacing) => {
      const mask = createShadingMask(() => 1)

      expect(() =>
        isMaskPermittedStipple(mask, FRAME, [1, 1], [2, 2], maxSpacing),
      ).toThrow(RangeError)
    },
  )

  it.each([
    ['non-finite', Number.MIN_VALUE],
    ['finite but unsafe', 2 ** -53],
  ])('rejects spacing that produces a %s interval count', (_kind, spacing) => {
    const sample = vi.fn(() => 1)
    const mask = createShadingMask(sample)

    expect(() =>
      isMaskPermittedStipple(mask, FRAME, [1, 1], [2, 1], spacing),
    ).toThrow(RangeError)
    expect(sample).not.toHaveBeenCalled()
  })
})
