import { describe, expect, it } from 'vitest'
import {
  validatePlotProfile,
  normalizePlotProfile,
  plotDrawableRectangle,
  plotDrawableAspectsEquivalent,
  resolvePlotCompositionFrame,
  type PlotInsets,
  type PlotProfile,
} from '../plotProfile'
import {
  resolveCompositionFrame,
  COMPOSITION_FRAME_AREA,
} from '../compositionFrame'

/**
 * Build a valid Plot Profile with overridable dimensions and insets. The base is
 * the Harness's provisional default (a square `200 mm` sheet with linked `10 mm`
 * insets, CONTEXT.md "Output Profile"). `??` lets `0` pass through as an explicit
 * override — a zero inset is a valid choice.
 */
function makeProfile(
  overrides: {
    width?: number
    height?: number
    insets?: Partial<PlotInsets>
    includeFrame?: boolean
  } = {},
): PlotProfile {
  return {
    width: overrides.width ?? 200,
    height: overrides.height ?? 200,
    insets: {
      top: overrides.insets?.top ?? 10,
      right: overrides.insets?.right ?? 10,
      bottom: overrides.insets?.bottom ?? 10,
      left: overrides.insets?.left ?? 10,
    },
    includeFrame: overrides.includeFrame ?? true,
  }
}

const EDGES: ReadonlyArray<keyof PlotInsets> = ['top', 'right', 'bottom', 'left']

describe('validatePlotProfile', () => {
  describe('accepts valid profiles', () => {
    it('accepts the provisional square 200mm profile with linked 10mm insets', () => {
      expect(() => validatePlotProfile(makeProfile())).not.toThrow()
    })

    it('accepts four asymmetric insets', () => {
      const profile = makeProfile({
        insets: { top: 5, right: 15, bottom: 25, left: 35 },
      })
      expect(() => validatePlotProfile(profile)).not.toThrow()
    })

    it('accepts zero insets on every edge', () => {
      const profile = makeProfile({
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
      })
      expect(() => validatePlotProfile(profile)).not.toThrow()
    })

    it('accepts a mix of zero and positive insets', () => {
      const profile = makeProfile({
        insets: { top: 0, right: 10, bottom: 0, left: 10 },
      })
      expect(() => validatePlotProfile(profile)).not.toThrow()
    })

    it('accepts a non-square (portrait) sheet', () => {
      expect(() =>
        validatePlotProfile(makeProfile({ width: 210, height: 297 })),
      ).not.toThrow()
    })

    it('accepts an explicitly disabled Composition Frame', () => {
      expect(() =>
        validatePlotProfile(makeProfile({ includeFrame: false })),
      ).not.toThrow()
    })
  })

  describe('rejects invalid dimensions', () => {
    const rejected: Array<[string, number]> = [
      ['zero', 0],
      ['negative zero', -0],
      ['a negative', -5],
      ['NaN', NaN],
      ['Infinity', Infinity],
    ]

    for (const dimension of ['width', 'height'] as const) {
      for (const [label, value] of rejected) {
        it(`throws for ${label} ${dimension}`, () => {
          expect(() =>
            validatePlotProfile(makeProfile({ [dimension]: value })),
          ).toThrow()
        })

        it(`names ${dimension} and the offending value ${label}`, () => {
          const run = () =>
            validatePlotProfile(makeProfile({ [dimension]: value }))
          expect(run).toThrow(dimension)
          expect(run).toThrow(String(value))
        })
      }
    }

    it('names the validator in the message', () => {
      expect(() => validatePlotProfile(makeProfile({ width: 0 }))).toThrow(
        'validatePlotProfile',
      )
    })
  })

  describe('rejects invalid insets', () => {
    // Zero is intentionally ABSENT — a zero inset is valid (see accepts block).
    const rejected: Array<[string, number]> = [
      ['a negative', -1],
      ['NaN', NaN],
      ['Infinity', Infinity],
    ]

    for (const edge of EDGES) {
      for (const [label, value] of rejected) {
        it(`throws for ${label} ${edge} inset`, () => {
          const profile = makeProfile({
            insets: { [edge]: value } as Partial<PlotInsets>,
          })
          expect(() => validatePlotProfile(profile)).toThrow()
        })

        it(`names the ${edge} inset for a ${label} value`, () => {
          const profile = makeProfile({
            insets: { [edge]: value } as Partial<PlotInsets>,
          })
          expect(() => validatePlotProfile(profile)).toThrow(edge)
        })
      }
    }
  })

  describe('rejects an exhausted drawable region', () => {
    it('rejects horizontal insets that equal the paper width', () => {
      const profile = makeProfile({
        width: 100,
        insets: { left: 50, right: 50 },
      })
      expect(() => validatePlotProfile(profile)).toThrow('validatePlotProfile')
    })

    it('rejects horizontal insets that exceed the paper width', () => {
      const profile = makeProfile({
        width: 100,
        insets: { left: 60, right: 60 },
      })
      expect(() => validatePlotProfile(profile)).toThrow('width')
    })

    it('rejects vertical insets that equal the paper height', () => {
      const profile = makeProfile({
        height: 100,
        insets: { top: 50, bottom: 50 },
      })
      expect(() => validatePlotProfile(profile)).toThrow('validatePlotProfile')
    })

    it('rejects vertical insets that exceed the paper height', () => {
      const profile = makeProfile({
        height: 100,
        insets: { top: 60, bottom: 60 },
      })
      expect(() => validatePlotProfile(profile)).toThrow('height')
    })

    it('rejects a single inset that alone exceeds the paper (negative drawable region)', () => {
      const profile = makeProfile({
        width: 200,
        insets: { left: 250, right: 0 },
      })
      expect(() => validatePlotProfile(profile)).toThrow('validatePlotProfile')
    })
  })
})

describe('normalizePlotProfile', () => {
  it('defaults a legacy profile with no includeFrame field to true', () => {
    const { includeFrame: _includeFrame, ...legacy } = makeProfile()
    expect(normalizePlotProfile(legacy).includeFrame).toBe(true)
  })

  it('preserves an explicit false value', () => {
    expect(
      normalizePlotProfile({ ...makeProfile(), includeFrame: false })
        .includeFrame,
    ).toBe(false)
  })

  it.each([undefined, null, 0, 'false', {}])(
    'rejects a present non-boolean includeFrame value (%j)',
    (includeFrame) => {
      expect(() =>
        normalizePlotProfile({ ...makeProfile(), includeFrame }),
      ).toThrow('normalizePlotProfile: includeFrame must be a boolean')
    },
  )

  it('returns defensive copies of the profile and its nested insets', () => {
    const source = makeProfile()
    const normalized = normalizePlotProfile(source)

    expect(normalized).not.toBe(source)
    expect(normalized.insets).not.toBe(source.insets)
    normalized.insets.top = 99
    expect(source.insets.top).toBe(10)
  })
})

describe('plotDrawableRectangle', () => {
  it('derives the drawable rectangle as paper minus the four insets', () => {
    const profile = makeProfile({
      width: 200,
      height: 300,
      insets: { top: 10, right: 20, bottom: 30, left: 40 },
    })
    // width  = 200 - left(40) - right(20) = 140
    // height = 300 - top(10)  - bottom(30) = 260
    expect(plotDrawableRectangle(profile)).toEqual({ width: 140, height: 260 })
  })

  it('returns the full sheet when every inset is zero', () => {
    const profile = makeProfile({
      width: 300,
      height: 150,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    })
    expect(plotDrawableRectangle(profile)).toEqual({ width: 300, height: 150 })
  })

  it('validates first — throws on an exhausted region rather than returning a non-positive rectangle', () => {
    const profile = makeProfile({
      width: 100,
      insets: { left: 60, right: 60 },
    })
    expect(() => plotDrawableRectangle(profile)).toThrow('validatePlotProfile')
  })
})

describe('plotDrawableAspectsEquivalent', () => {
  it('treats a one-ULP quotient difference from proportional physical scaling as the same aspect', () => {
    const base = makeProfile({ width: 210, height: 297 })
    const scale = 1.2
    const scaled: PlotProfile = {
      width: base.width * scale,
      height: base.height * scale,
      insets: {
        top: base.insets.top * scale,
        right: base.insets.right * scale,
        bottom: base.insets.bottom * scale,
        left: base.insets.left * scale,
      },
      includeFrame: base.includeFrame,
    }
    const baseDrawable = plotDrawableRectangle(base)
    const scaledDrawable = plotDrawableRectangle(scaled)
    const baseAspect = baseDrawable.width / baseDrawable.height
    const scaledAspect = scaledDrawable.width / scaledDrawable.height

    expect(baseAspect).not.toBe(scaledAspect)
    expect(plotDrawableAspectsEquivalent(baseAspect, scaledAspect)).toBe(true)
  })

  it('keeps real aspect changes distinct and rejects invalid inputs', () => {
    expect(plotDrawableAspectsEquivalent(2 / 3, 3 / 4)).toBe(false)
    expect(plotDrawableAspectsEquivalent(Number.NaN, Number.NaN)).toBe(false)
    expect(plotDrawableAspectsEquivalent(0, 0)).toBe(false)
  })
})

describe('resolvePlotCompositionFrame', () => {
  it('derives the frame from the drawable aspect for asymmetric insets', () => {
    const profile = makeProfile({
      width: 200,
      height: 300,
      insets: { top: 10, right: 20, bottom: 30, left: 40 },
    })
    // Drawable 140 × 260 → aspect 140/260, delegated to resolveCompositionFrame.
    expect(resolvePlotCompositionFrame(profile)).toEqual(
      resolveCompositionFrame(140 / 260),
    )
  })

  it('preserves the fixed 1,000,000 square-unit area', () => {
    const profile = makeProfile({
      width: 200,
      height: 300,
      insets: { top: 10, right: 20, bottom: 30, left: 40 },
    })
    const { width, height } = resolvePlotCompositionFrame(profile)
    expect(width * height).toBeCloseTo(COMPOSITION_FRAME_AREA, 6)
  })

  it('resolves a square drawable region to the 1000 × 1000 frame', () => {
    // 200mm sheet, symmetric 10mm insets → 180 × 180 drawable, aspect 1.
    const frame = resolvePlotCompositionFrame(makeProfile())
    expect(frame.width).toBeCloseTo(1000)
    expect(frame.height).toBeCloseTo(1000)
  })

  it('takes zero-inset profiles straight from the raw paper aspect', () => {
    const profile = makeProfile({
      width: 300,
      height: 150,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    })
    expect(resolvePlotCompositionFrame(profile)).toEqual(
      resolveCompositionFrame(300 / 150),
    )
  })

  it('throws the Plot-Profile message on an exhausted region, not the resolver throw', () => {
    const profile = makeProfile({
      width: 100,
      insets: { left: 60, right: 60 },
    })
    const run = () => resolvePlotCompositionFrame(profile)
    expect(run).toThrow('validatePlotProfile')
    expect(run).not.toThrow('resolveCompositionFrame')
  })
})
