import { describe, expect, it } from 'vitest'
import { getPaperSize, PAPER_SIZES } from '../paper'

describe('PAPER_SIZES', () => {
  it('letter is 21.59 × 27.94 cm', () => {
    expect(PAPER_SIZES.letter).toEqual({ width: 21.59, height: 27.94 })
  })

  it('a4 is 21.0 × 29.7 cm', () => {
    expect(PAPER_SIZES.a4).toEqual({ width: 21.0, height: 29.7 })
  })

  it('a3 is 29.7 × 42.0 cm', () => {
    expect(PAPER_SIZES.a3).toEqual({ width: 29.7, height: 42.0 })
  })

  it('a5 is 14.8 × 21.0 cm', () => {
    expect(PAPER_SIZES.a5).toEqual({ width: 14.8, height: 21.0 })
  })

  it('a2 is 42.0 × 59.4 cm', () => {
    expect(PAPER_SIZES.a2).toEqual({ width: 42.0, height: 59.4 })
  })

  it('tabloid is 27.94 × 43.18 cm', () => {
    expect(PAPER_SIZES.tabloid).toEqual({ width: 27.94, height: 43.18 })
  })

  it('all sizes are in portrait orientation (width < height)', () => {
    for (const [name, size] of Object.entries(PAPER_SIZES)) {
      expect(
        size.width,
        `${name} width should be less than height`,
      ).toBeLessThan(size.height)
    }
  })
})

describe('getPaperSize', () => {
  it('returns portrait dimensions by default', () => {
    expect(getPaperSize('letter')).toEqual({ width: 21.59, height: 27.94 })
  })

  it('returns portrait dimensions when explicitly requested', () => {
    expect(getPaperSize('a4', 'portrait')).toEqual({
      width: 21.0,
      height: 29.7,
    })
  })

  it('swaps width/height for landscape', () => {
    expect(getPaperSize('a4', 'landscape')).toEqual({
      width: 29.7,
      height: 21.0,
    })
  })

  it('swaps width/height for landscape (letter)', () => {
    expect(getPaperSize('letter', 'landscape')).toEqual({
      width: 27.94,
      height: 21.59,
    })
  })

  it('throws for unknown paper name', () => {
    expect(() => getPaperSize('unknown')).toThrow(
      'Unknown paper size: "unknown"',
    )
  })

  it('returns a new object (not the original reference)', () => {
    const result = getPaperSize('letter')
    expect(result).not.toBe(PAPER_SIZES.letter)
    expect(result).toEqual(PAPER_SIZES.letter)
  })

  // Custom paper size support (Phase 2.2.5)
  it('accepts a custom { width, height } object', () => {
    expect(getPaperSize({ width: 15, height: 20 })).toEqual({
      width: 15,
      height: 20,
    })
  })

  it('swaps custom dimensions for landscape', () => {
    expect(getPaperSize({ width: 15, height: 20 }, 'landscape')).toEqual({
      width: 20,
      height: 15,
    })
  })

  it('throws for custom size with zero width', () => {
    expect(() => getPaperSize({ width: 0, height: 20 })).toThrow(
      'Paper dimensions must be positive',
    )
  })

  it('throws for custom size with negative height', () => {
    expect(() => getPaperSize({ width: 15, height: -1 })).toThrow(
      'Paper dimensions must be positive',
    )
  })
})
