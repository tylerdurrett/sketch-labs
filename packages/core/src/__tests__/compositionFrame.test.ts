import { describe, expect, it } from 'vitest'
import {
  resolveCompositionFrame,
  COMPOSITION_FRAME_AREA,
} from '../compositionFrame'

describe('resolveCompositionFrame', () => {
  describe('fixed area', () => {
    // width = 1000·√r, height = 1000/√r → width × height = 1,000,000 for every r.
    const aspects = [1, 2, 0.5, 16 / 9, 9 / 16, 3, 1 / 3, 21 / 9, 0.001, 1000]

    for (const r of aspects) {
      it(`preserves 1,000,000 square units for aspect ${r}`, () => {
        const { width, height } = resolveCompositionFrame(r)
        // Floating-point round-trip through √: assert to high precision rather
        // than exact equality.
        expect(width * height).toBeCloseTo(COMPOSITION_FRAME_AREA, 6)
      })
    }

    it('resolves the exact formula width = 1000·√r, height = 1000/√r', () => {
      const r = 2
      const frame = resolveCompositionFrame(r)
      expect(frame.width).toBe(1000 * Math.sqrt(r))
      expect(frame.height).toBe(1000 / Math.sqrt(r))
    })

    it('resolves a square aspect to the Harness 1000 × 1000 square', () => {
      const frame = resolveCompositionFrame(1)
      expect(frame.width).toBe(1000)
      expect(frame.height).toBe(1000)
    })

    it('exposes the fixed area as a named constant', () => {
      expect(COMPOSITION_FRAME_AREA).toBe(1_000_000)
    })
  })

  describe('portrait/landscape swap symmetry', () => {
    // √(1/r) = 1/√r, so r and 1/r are transposes of each other. The transpose is
    // bit-exact when both r and 1/r have exact IEEE-754 square roots (perfect
    // squares and their reciprocals): 1/r round-trips exactly, so √(1/r) equals
    // 1/√r to the bit. These pairs assert genuine `===` equality.
    const exactPairs: Array<[number, number]> = [
      [1, 1],
      [4, 0.25],
      [16, 0.0625],
      [0.25, 4],
    ]

    for (const [r, inverse] of exactPairs) {
      it(`resolve(${r}) and resolve(${inverse}) are exact transposes`, () => {
        const landscape = resolveCompositionFrame(r)
        const portrait = resolveCompositionFrame(inverse)
        expect(landscape.width).toBe(portrait.height)
        expect(landscape.height).toBe(portrait.width)
      })
    }

    // For a general aspect where 1/r is not a clean binary fraction, the
    // transpose still holds to full floating-point precision.
    const generalAspects = [2, 16 / 9, 3, 21 / 9, 1.5]

    for (const r of generalAspects) {
      it(`resolve(${r}) and resolve(1/${r}) transpose to full precision`, () => {
        const landscape = resolveCompositionFrame(r)
        const portrait = resolveCompositionFrame(1 / r)
        expect(landscape.width).toBeCloseTo(portrait.height, 9)
        expect(landscape.height).toBeCloseTo(portrait.width, 9)
      })
    }
  })

  describe('magnitude irrelevance / purity in the ratio', () => {
    it('resolves equal aspects identically regardless of how derived', () => {
      // r = 2 however it was derived: a 2:1 ratio, a 1000:500 ratio, a 6:3
      // ratio all collapse to the same aspect and therefore the same frame.
      const fromRatio = resolveCompositionFrame(2)
      const fromLargeMagnitude = resolveCompositionFrame(1000 / 500)
      const fromSmallMagnitude = resolveCompositionFrame(6 / 3)
      expect(fromLargeMagnitude).toEqual(fromRatio)
      expect(fromSmallMagnitude).toEqual(fromRatio)
    })

    it('is a pure function: same input yields an equal frame every call', () => {
      const a = resolveCompositionFrame(16 / 9)
      const b = resolveCompositionFrame(16 / 9)
      expect(a).toEqual(b)
    })
  })

  describe('boundary validation', () => {
    const rejected: Array<[string, number]> = [
      ['zero', 0],
      ['negative zero', -0],
      ['a negative', -2],
      ['NaN', NaN],
      ['Infinity', Infinity],
    ]

    for (const [label, value] of rejected) {
      it(`throws for ${label}`, () => {
        expect(() => resolveCompositionFrame(value)).toThrow()
      })

      it(`names the offending value ${label} in the message`, () => {
        expect(() => resolveCompositionFrame(value)).toThrow(String(value))
      })
    }

    it('names the module in the message', () => {
      expect(() => resolveCompositionFrame(0)).toThrow('resolveCompositionFrame')
    })
  })
})
