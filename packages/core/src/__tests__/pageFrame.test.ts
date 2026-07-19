import { describe, expect, it } from 'vitest'
import {
  fullCompositionPageFrame,
  pageFrameClipBounds,
  pageFrameFromPercentages,
  pageFrameToPercentages,
  rebasePointToPageFrame,
  validatePageFrame,
  type PageFrame,
  type PageFramePercentages,
} from '../pageFrame'

const composition = { width: 1_000, height: 800 }

describe('Page Frame', () => {
  it('represents the exact full-Composition identity frame', () => {
    const frame = fullCompositionPageFrame(composition)

    expect(frame).toEqual({ x: 0, y: 0, width: 1_000, height: 800 })
    expect(pageFrameClipBounds(frame)).toEqual([0, 0, 1_000, 800])
    expect(rebasePointToPageFrame([250, 400], frame)).toEqual([250, 400])
  })

  it.each([
    ['inward crop', { x: 100, y: 80, width: 700, height: 560 }],
    ['asymmetric crop', { x: 50, y: 160, width: 800, height: 400 }],
    ['outward padding', { x: -100, y: -80, width: 1_200, height: 960 }],
    ['mixed crop and padding', { x: 100, y: -80, width: 1_100, height: 720 }],
  ] satisfies Array<[string, PageFrame]>)('accepts an %s frame', (_name, frame) => {
    expect(() => validatePageFrame(frame)).not.toThrow()
    expect(pageFrameClipBounds(frame)).toEqual([
      frame.x,
      frame.y,
      frame.x + frame.width,
      frame.y + frame.height,
    ])
    expect(rebasePointToPageFrame([frame.x, frame.y], frame)).toEqual([0, 0])
  })

  describe('validation', () => {
    it.each([
      ['zero width', { x: 0, y: 0, width: 0, height: 1 }],
      ['negative width', { x: 0, y: 0, width: -1, height: 1 }],
      ['zero height', { x: 0, y: 0, width: 1, height: 0 }],
      ['negative height', { x: 0, y: 0, width: 1, height: -1 }],
      ['NaN width', { x: 0, y: 0, width: Number.NaN, height: 1 }],
      ['positive infinite width', { x: 0, y: 0, width: Infinity, height: 1 }],
      ['negative infinite height', { x: 0, y: 0, width: 1, height: -Infinity }],
      ['NaN x', { x: Number.NaN, y: 0, width: 1, height: 1 }],
      ['positive infinite x', { x: Infinity, y: 0, width: 1, height: 1 }],
      ['negative infinite y', { x: 0, y: -Infinity, width: 1, height: 1 }],
    ] satisfies Array<[string, PageFrame]>)('rejects %s', (_name, frame) => {
      expect(() => validatePageFrame(frame)).toThrow(/validatePageFrame/)
    })

    it.each([
      ['zero width', { width: 0, height: 800 }],
      ['negative height', { width: 1_000, height: -1 }],
      ['NaN width', { width: Number.NaN, height: 800 }],
      ['infinite height', { width: 1_000, height: Infinity }],
    ])('rejects a Composition Frame with %s', (_name, invalidComposition) => {
      expect(() => fullCompositionPageFrame(invalidComposition)).toThrow(
        /Composition Frame (width|height) must be a finite positive number/,
      )
    })

    it.each([
      [
        'overflowing horizontal far edge',
        { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1 },
      ],
      [
        'collapsed horizontal far edge',
        { x: Number.MAX_VALUE, y: 0, width: 1, height: 1 },
      ],
      [
        'overflowing vertical far edge',
        { x: 0, y: Number.MAX_VALUE, width: 1, height: Number.MAX_VALUE },
      ],
      [
        'collapsed vertical far edge',
        { x: 0, y: Number.MAX_VALUE, width: 1, height: 1 },
      ],
    ] satisfies Array<[string, PageFrame]>)(
      'rejects a frame with an %s',
      (_name, frame) => {
        expect(() => validatePageFrame(frame)).toThrow(
          /must produce a finite far edge strictly greater/,
        )
        expect(() => pageFrameClipBounds(frame)).toThrow(
          /must produce a finite far edge strictly greater/,
        )
      },
    )

    it('rejects a rebase whose finite operands produce a nonfinite point', () => {
      const frame = {
        x: -Number.MAX_VALUE,
        y: 0,
        width: Number.MAX_VALUE,
        height: 1,
      }

      expect(() =>
        rebasePointToPageFrame([Number.MAX_VALUE, 0], frame),
      ).toThrow(/rebased point coordinates must be finite/)
    })
  })

  describe('percentage conversion', () => {
    it('converts an asymmetric crop relative to each Composition axis', () => {
      expect(
        pageFrameToPercentages(
          { x: 100, y: 160, width: 750, height: 400 },
          composition,
        ),
      ).toEqual({ x: 10, y: 20, width: 75, height: 50 })
    })

    it.each([
      [
        'negative origins',
        { x: -25, y: -50, width: 100, height: 100 },
      ],
      [
        'extents above 100 percent',
        { x: 0, y: 0, width: 125, height: 150 },
      ],
      [
        'mixed crop and padding percentages',
        { x: 10, y: -25, width: 120, height: 75 },
      ],
    ] satisfies Array<[string, PageFramePercentages]>)(
      'round-trips %s exactly without clamping',
      (_name, percentages) => {
        const frame = pageFrameFromPercentages(percentages, composition)
        expect(pageFrameToPercentages(frame, composition)).toEqual(percentages)
      },
    )

    it('uses one per-axis factor for exact representative decimal conversions', () => {
      const decimalComposition = { width: 3, height: 3 }
      const percentages = { x: 10, y: 10, width: 100, height: 100 }

      const frame = pageFrameFromPercentages(
        percentages,
        decimalComposition,
      )
      expect(frame).toEqual({ x: 0.3, y: 0.3, width: 3, height: 3 })
      expect(pageFrameToPercentages(frame, decimalComposition)).toEqual(
        percentages,
      )
    })

    it('falls back safely when units-per-percent underflows', () => {
      const subnormalComposition = {
        width: Number.MIN_VALUE,
        height: Number.MIN_VALUE,
      }
      const percentages = { x: 0, y: 0, width: 100, height: 100 }

      const frame = pageFrameFromPercentages(
        percentages,
        subnormalComposition,
      )
      expect(frame).toEqual({
        x: 0,
        y: 0,
        width: Number.MIN_VALUE,
        height: Number.MIN_VALUE,
      })
      expect(pageFrameToPercentages(frame, subnormalComposition)).toEqual(
        percentages,
      )
    })
  })

  it('returns immutable records and never mutates its inputs', () => {
    const mutableComposition = { width: 1_000, height: 800 }
    const mutableFrame = { x: -100, y: 80, width: 1_200, height: 640 }
    const originalComposition = structuredClone(mutableComposition)
    const originalFrame = structuredClone(mutableFrame)

    const full = fullCompositionPageFrame(mutableComposition)
    const percentages = pageFrameToPercentages(
      mutableFrame,
      mutableComposition,
    )
    const roundTrip = pageFrameFromPercentages(
      percentages,
      mutableComposition,
    )

    expect(Object.isFrozen(full)).toBe(true)
    expect(Object.isFrozen(percentages)).toBe(true)
    expect(Object.isFrozen(roundTrip)).toBe(true)
    expect(mutableComposition).toEqual(originalComposition)
    expect(mutableFrame).toEqual(originalFrame)
    expect(rebasePointToPageFrame([0, 0], mutableFrame)).toEqual([100, -80])
  })
})
