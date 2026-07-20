import { describe, expect, it } from 'vitest'
import { resolveCompositionFrame } from '../compositionFrame'
import { fullCompositionPageFrame, type PageFrame } from '../pageFrame'
import {
  centeredFixedPageFrame,
  derivePageFramePlotProfile,
  fitPageFramePlotProfileToAspect,
  fixedPageCompositionScale,
  resizePageFrameFromPhysicalDimension,
  resizePageFramePlotProfileProportionally,
  scaleFixedPageFrame,
} from '../pageFramePlotProfile'
import { inchToMm } from '../paperCatalog'
import { plotDrawableRectangle, type PlotProfile } from '../plotProfile'

const profile: PlotProfile = {
  width: 230,
  height: 190,
  insets: { top: 7, right: 11, bottom: 23, left: 19 },
  includeFrame: false,
  toolWidthMillimeters: 0.7,
}

// The 200 x 160 mm drawable maps to this frame at exactly 0.2 mm per unit.
const fullFrame: PageFrame = { x: 0, y: 0, width: 1_000, height: 800 }

describe('fixed-page composition scale', () => {
  describe('centeredFixedPageFrame', () => {
    it.each([
      [
        'wide Composition',
        { width: 1_200, height: 600 },
        { x: 0, y: -180, width: 1_200, height: 960 },
      ],
      [
        'tall Composition',
        { width: 600, height: 1_200 },
        { x: -450, y: 0, width: 1_500, height: 1_200 },
      ],
      [
        'matching Composition',
        { width: 1_000, height: 800 },
        { x: 0, y: 0, width: 1_000, height: 800 },
      ],
    ] as const)(
      'centers and contain-fits a %s at the locked drawable aspect',
      (_name, composition, expected) => {
        const reference = centeredFixedPageFrame(profile, composition)

        expect(reference).toEqual(expected)
        expect(reference.width / reference.height).toBe(200 / 160)
        expect(reference.x).toBeLessThanOrEqual(0)
        expect(reference.y).toBeLessThanOrEqual(0)
        expect(reference.x + reference.width).toBeGreaterThanOrEqual(
          composition.width,
        )
        expect(reference.y + reference.height).toBeGreaterThanOrEqual(
          composition.height,
        )
      },
    )

    it('uses the drawable inside asymmetric physical margins, not total paper aspect', () => {
      const reference = centeredFixedPageFrame(profile, {
        width: 1_200,
        height: 600,
      })

      expect(reference.width / reference.height).toBe(1.25)
      expect(reference.width / reference.height).not.toBe(
        profile.width / profile.height,
      )
    })

    it('rejects invalid inputs and unrepresentable finite geometry', () => {
      expect(() =>
        centeredFixedPageFrame(profile, {
          width: Number.POSITIVE_INFINITY,
          height: 800,
        }),
      ).toThrow(/fullCompositionPageFrame/)

      const infiniteAspectProfile: PlotProfile = {
        ...profile,
        width: Number.MAX_VALUE,
        height: Number.MIN_VALUE,
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
      }
      expect(() =>
        centeredFixedPageFrame(infiniteAspectProfile, {
          width: 1_000,
          height: 800,
        }),
      ).toThrow(/drawable aspect must be a finite positive/)

      const enormousAspectProfile: PlotProfile = {
        ...profile,
        width: 1e300,
        height: 1,
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
      }
      expect(() =>
        centeredFixedPageFrame(enormousAspectProfile, {
          width: 1,
          height: 1e300,
        }),
      ).toThrow(/validatePageFrame/)
    })
  })

  describe('fixedPageCompositionScale', () => {
    it('reads the absolute scale as the uniform fit/frame ratio', () => {
      const reference = centeredFixedPageFrame(profile, fullFrame)
      const pannedAtDoubleScale = {
        x: 125,
        y: -40,
        width: 500,
        height: 400,
      }

      expect(
        fixedPageCompositionScale(profile, reference, pannedAtDoubleScale),
      ).toBe(2)
    })

    it('rejects nonuniform reference/frame ratios deterministically', () => {
      expect(() =>
        fixedPageCompositionScale(profile, fullFrame, {
          x: 0,
          y: 0,
          width: 500,
          height: 500,
        }),
      ).toThrow(/one finite positive uniform composition scale/)
    })

    it('rejects uniform frames incompatible with the locked drawable aspect', () => {
      expect(() =>
        fixedPageCompositionScale(
          profile,
          { x: 0, y: 0, width: 1_000, height: 1_000 },
          { x: 100, y: 100, width: 500, height: 500 },
        ),
      ).toThrow(/equivalent physical scales/)
    })

    it('rejects invalid frame values and non-finite fit/frame ratios', () => {
      expect(() =>
        fixedPageCompositionScale(profile, fullFrame, {
          x: Number.NaN,
          y: 0,
          width: 500,
          height: 400,
        }),
      ).toThrow(/validatePageFrame/)

      const microscopicFrame = {
        x: 0,
        y: 0,
        width: Number.MIN_VALUE,
        height: Number.MIN_VALUE,
      }
      expect(() =>
        fixedPageCompositionScale(
          {
            ...profile,
            width: 1,
            height: 1,
            insets: { top: 0, right: 0, bottom: 0, left: 0 },
          },
          { x: 0, y: 0, width: 1, height: 1 },
          microscopicFrame,
        ),
      ).toThrow(/one finite positive uniform composition scale/)
    })
  })

  describe('scaleFixedPageFrame', () => {
    it('applies an absolute uniform scale while preserving a panned center', () => {
      const reference = centeredFixedPageFrame(profile, fullFrame)
      const pannedAtDoubleScale = {
        x: 125,
        y: -40,
        width: 500,
        height: 400,
      }

      const scaled = scaleFixedPageFrame(
        profile,
        reference,
        pannedAtDoubleScale,
        4,
      )

      expect(scaled).toEqual({ x: 250, y: 60, width: 250, height: 200 })
      expect(scaled.width / scaled.height).toBe(
        pannedAtDoubleScale.width / pannedAtDoubleScale.height,
      )
      expect(scaled.x + scaled.width / 2).toBe(
        pannedAtDoubleScale.x + pannedAtDoubleScale.width / 2,
      )
      expect(scaled.y + scaled.height / 2).toBe(
        pannedAtDoubleScale.y + pannedAtDoubleScale.height / 2,
      )
      expect(fixedPageCompositionScale(profile, reference, scaled)).toBe(4)
    })

    it('derives every extent from the stable reference without scale drift', () => {
      const reference = centeredFixedPageFrame(profile, fullFrame)
      const pannedAtDoubleScale = {
        x: 125,
        y: -40,
        width: 500,
        height: 400,
      }
      const first = scaleFixedPageFrame(
        profile,
        reference,
        pannedAtDoubleScale,
        3,
      )
      const intermediate = scaleFixedPageFrame(
        profile,
        reference,
        first,
        0.75,
      )
      const repeated = scaleFixedPageFrame(
        profile,
        reference,
        intermediate,
        3,
      )

      expect(repeated.width).toBe(first.width)
      expect(repeated.height).toBe(first.height)
      expect(repeated.x + repeated.width / 2).toBeCloseTo(
        first.x + first.width / 2,
        12,
      )
      expect(repeated.y + repeated.height / 2).toBeCloseTo(
        first.y + first.height / 2,
        12,
      )
      expect(fixedPageCompositionScale(profile, reference, repeated)).toBe(3)
    })

    it('returns the exact current frame when its absolute scale is untouched', () => {
      const current = { x: 125, y: -40, width: 500, height: 400 }

      expect(scaleFixedPageFrame(profile, fullFrame, current, 2)).toBe(
        current,
      )
    })

    it('keeps scale-one pan distinct from the centered Reset reference', () => {
      const reference = centeredFixedPageFrame(profile, {
        width: 1_200,
        height: 600,
      })
      const pannedAtReferenceScale = {
        ...reference,
        x: reference.x + 90,
        y: reference.y - 35,
      }

      expect(
        scaleFixedPageFrame(
          profile,
          reference,
          pannedAtReferenceScale,
          1,
        ),
      ).toBe(pannedAtReferenceScale)
      expect(pannedAtReferenceScale).not.toEqual(reference)
      expect(reference).toEqual({ x: 0, y: -180, width: 1_200, height: 960 })
    })

    it('never modifies or replaces any locked Plot Profile field', () => {
      const before = structuredClone(profile)
      const insets = profile.insets
      const reference = centeredFixedPageFrame(profile, fullFrame)

      scaleFixedPageFrame(profile, reference, fullFrame, 2)

      expect(profile).toEqual(before)
      expect(profile.insets).toBe(insets)
    })

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects invalid composition scale %s',
      (compositionScale) => {
        expect(() =>
          scaleFixedPageFrame(
            profile,
            fullFrame,
            fullFrame,
            compositionScale,
          ),
        ).toThrow(/composition scale must be a finite positive number/)
      },
    )

    it('rejects scales whose finite Page Frame geometry is unrepresentable', () => {
      expect(() =>
        scaleFixedPageFrame(
          profile,
          fullFrame,
          fullFrame,
          Number.MIN_VALUE,
        ),
      ).toThrow(/validatePageFrame/)

      expect(() =>
        scaleFixedPageFrame(
          profile,
          fullFrame,
          fullFrame,
          Number.MAX_VALUE,
        ),
      ).toThrow(/validatePageFrame/)
    })
  })
})

describe('derivePageFramePlotProfile', () => {
  it('is exactly inert when the represented extent is unchanged', () => {
    const sameExtentAtNewOrigin = {
      x: -125,
      y: 80,
      width: fullFrame.width,
      height: fullFrame.height,
    }

    expect(
      derivePageFramePlotProfile(profile, fullFrame, sameExtentAtNewOrigin),
    ).toBe(profile)
  })

  it.each([
    [
      'inward crop shrinks the physical page',
      { x: 100, y: 80, width: 700, height: 560 },
      { width: 170, height: 142 },
    ],
    [
      'asymmetric crop uses each target extent',
      { x: 50, y: 160, width: 800, height: 400 },
      { width: 190, height: 110 },
    ],
    [
      'outward padding enlarges the physical page',
      { x: -100, y: -80, width: 1_200, height: 960 },
      { width: 270, height: 222 },
    ],
    [
      'mixed crop and padding changes the axes independently',
      { x: 100, y: -80, width: 900, height: 960 },
      { width: 210, height: 222 },
    ],
  ] satisfies Array<
    [string, PageFrame, { readonly width: number; readonly height: number }]
  >)('%s', (_name, targetFrame, expectedPaper) => {
    const derived = derivePageFramePlotProfile(
      profile,
      fullFrame,
      targetFrame,
    )

    expect({ width: derived.width, height: derived.height }).toEqual(
      expectedPaper,
    )
    expect(derived.insets).toEqual(profile.insets)
    expect(derived.insets).not.toBe(profile.insets)
    expect(derived.includeFrame).toBe(false)
    expect(derived.toolWidthMillimeters).toBe(0.7)
    expect(plotDrawableRectangle(derived)).toEqual({
      width: targetFrame.width * 0.2,
      height: targetFrame.height * 0.2,
    })
  })

  it('preserves scale across repeated re-edits rather than compounding from the Composition extent', () => {
    const firstFrame = { x: 100, y: 80, width: 800, height: 640 }
    const secondFrame = { x: -200, y: 160, width: 1_400, height: 400 }

    const firstProfile = derivePageFramePlotProfile(
      profile,
      fullFrame,
      firstFrame,
    )
    const secondProfile = derivePageFramePlotProfile(
      firstProfile,
      firstFrame,
      secondFrame,
    )
    const directProfile = derivePageFramePlotProfile(
      profile,
      fullFrame,
      secondFrame,
    )

    expect(secondProfile).toEqual(directProfile)
    expect(plotDrawableRectangle(secondProfile)).toEqual({
      width: 280,
      height: 80,
    })
  })

  it('resets a repeatedly edited frame to the full frozen Composition at its original scale', () => {
    const composition = resolveCompositionFrame(200 / 160)
    const originalFrame = fullCompositionPageFrame(composition)
    const crop = {
      x: composition.width * 0.1,
      y: composition.height * 0.2,
      width: composition.width * 0.7,
      height: composition.height * 0.5,
    }
    const padding = {
      x: -composition.width * 0.25,
      y: composition.height * 0.1,
      width: composition.width * 1.5,
      height: composition.height * 0.8,
    }

    const croppedProfile = derivePageFramePlotProfile(
      profile,
      originalFrame,
      crop,
    )
    const paddedProfile = derivePageFramePlotProfile(
      croppedProfile,
      crop,
      padding,
    )
    const resetProfile = derivePageFramePlotProfile(
      paddedProfile,
      padding,
      originalFrame,
    )

    expect(resetProfile.width).toBeCloseTo(profile.width, 12)
    expect(resetProfile.height).toBeCloseTo(profile.height, 12)
    expect(resetProfile.insets).toEqual(profile.insets)
    expect(resetProfile.includeFrame).toBe(profile.includeFrame)
    expect(resetProfile.toolWidthMillimeters).toBe(
      profile.toolWidthMillimeters,
    )
  })

  it('re-edits and resets a tiny emitted Page extent despite inset cancellation', () => {
    const tinyFrame = { x: 100, y: 80, width: 12, height: 11 }
    const tinyProfile = derivePageFramePlotProfile(
      profile,
      fullFrame,
      tinyFrame,
    )

    expect(tinyProfile).toEqual({
      ...profile,
      width: 32.4,
      height: 32.2,
      insets: { ...profile.insets },
    })

    const resetProfile = derivePageFramePlotProfile(
      tinyProfile,
      tinyFrame,
      fullFrame,
    )
    expect(resetProfile.width).toBeCloseTo(profile.width, 12)
    expect(resetProfile.height).toBeCloseTo(profile.height, 12)
  })

  it('rejects a profile whose drawable does not represent the current Page Frame aspect', () => {
    expect(() =>
      derivePageFramePlotProfile(
        profile,
        { x: 0, y: 0, width: 1_000, height: 1_000 },
        { x: 0, y: 0, width: 500, height: 500 },
      ),
    ).toThrow(/equivalent physical scales/)
  })

  it('validates profile/frame scale consistency before an identity return', () => {
    const inconsistentFrame = {
      x: 0,
      y: 0,
      width: 1_000,
      height: 1_000,
    }

    expect(() =>
      derivePageFramePlotProfile(
        profile,
        inconsistentFrame,
        inconsistentFrame,
      ),
    ).toThrow(/equivalent physical scales/)
  })

  it('rejects materially inconsistent scales even when both are microscopic', () => {
    const microscopicProfile: PlotProfile = {
      width: 1e-12,
      height: 2e-12,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      includeFrame: true,
      toolWidthMillimeters: 0.3,
    }
    const squareFrame = { x: 0, y: 0, width: 1_000, height: 1_000 }

    expect(() =>
      derivePageFramePlotProfile(
        microscopicProfile,
        squareFrame,
        squareFrame,
      ),
    ).toThrow(/equivalent physical scales/)
  })

  it('validates both frames and the derived physical dimensions', () => {
    expect(() =>
      derivePageFramePlotProfile(
        profile,
        { x: 0, y: 0, width: 0, height: 800 },
        fullFrame,
      ),
    ).toThrow(/validatePageFrame/)

    const largeScaleProfile: PlotProfile = {
      ...profile,
      width: 2_030,
      height: 1_630,
    }
    expect(() =>
      derivePageFramePlotProfile(largeScaleProfile, fullFrame, {
        x: 0,
        y: 0,
        width: Number.MAX_VALUE,
        height: 800,
      }),
    ).toThrow(/validatePlotProfile/)
  })
})

describe('fitPageFramePlotProfileToAspect', () => {
  it.each([
    ['portrait', 3 / 4, { width: 150, height: 190 }],
    ['landscape', 2, { width: 230, height: 130 }],
  ] as const)(
    'fits a %s target inside the current non-square drawable without enlarging it',
    (_name, targetAspect, expectedPaper) => {
      const fitted = fitPageFramePlotProfileToAspect(profile, targetAspect)
      const before = plotDrawableRectangle(profile)
      const after = plotDrawableRectangle(fitted)

      expect({ width: fitted.width, height: fitted.height }).toEqual(
        expectedPaper,
      )
      expect(after.width / after.height).toBe(targetAspect)
      expect(after.width).toBeLessThanOrEqual(before.width)
      expect(after.height).toBeLessThanOrEqual(before.height)
      expect(after.width === before.width || after.height === before.height).toBe(
        true,
      )
    },
  )

  it('preserves asymmetric margins and every unrelated profile field', () => {
    const fitted = fitPageFramePlotProfileToAspect(profile, 1)

    expect(fitted).toEqual({
      width: 190,
      height: 190,
      insets: { top: 7, right: 11, bottom: 23, left: 19 },
      includeFrame: false,
      toolWidthMillimeters: 0.7,
    })
    expect(fitted.insets).not.toBe(profile.insets)
    expect(plotDrawableRectangle(fitted)).toEqual({
      width: 160,
      height: 160,
    })
  })

  it('retains the exact profile for an equal or machine-equivalent aspect', () => {
    const currentAspect = 200 / 160

    expect(
      fitPageFramePlotProfileToAspect(profile, currentAspect),
    ).toBe(profile)
    expect(
      fitPageFramePlotProfileToAspect(
        profile,
        currentAspect + Number.EPSILON,
      ),
    ).toBe(profile)
  })

  it('fits an exact target from a different non-square containing profile', () => {
    const wideProfile: PlotProfile = {
      width: 337,
      height: 149,
      insets: { top: 13, right: 17, bottom: 16, left: 20 },
      includeFrame: true,
      toolWidthMillimeters: 1.2,
    }

    const fitted = fitPageFramePlotProfileToAspect(wideProfile, 3 / 2)

    expect(fitted.width).toBe(217)
    expect(fitted.height).toBe(wideProfile.height)
    expect(plotDrawableRectangle(fitted)).toEqual({
      width: 180,
      height: 120,
    })
    expect(plotDrawableRectangle(fitted).width).toBeLessThan(
      plotDrawableRectangle(wideProfile).width,
    )
  })

  it.each([
    ['extreme portrait', 1e-16, { width: 1e-16, height: 1 }],
    ['extreme landscape', 1e16, { width: 1, height: 1e-16 }],
  ] as const)(
    'fits a representable %s aspect without a unit-scale tolerance floor',
    (_name, targetAspect, expected) => {
      const marginlessProfile: PlotProfile = {
        width: 1,
        height: 1,
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
        includeFrame: true,
        toolWidthMillimeters: 0.3,
      }

      const fitted = fitPageFramePlotProfileToAspect(
        marginlessProfile,
        targetAspect,
      )

      expect({ width: fitted.width, height: fitted.height }).toEqual(expected)
      const fittedDrawable = plotDrawableRectangle(fitted)
      expect(fittedDrawable.width / fittedDrawable.height).toBe(targetAspect)
    },
  )

  it('does not treat materially different tiny aspects as equivalent', () => {
    const tinyAspectProfile: PlotProfile = {
      width: 1e-16,
      height: 1,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      includeFrame: false,
      toolWidthMillimeters: 0.3,
    }

    const fitted = fitPageFramePlotProfileToAspect(tinyAspectProfile, 2e-16)

    expect(fitted).not.toBe(tinyAspectProfile)
    expect(fitted.width).toBe(tinyAspectProfile.width)
    expect(fitted.height).toBe(0.5)
  })

  it('rejects a target whose drawable aspect is corrupted by inset cancellation', () => {
    expect(() =>
      fitPageFramePlotProfileToAspect(profile, 1e-16),
    ).toThrow(/cannot be represented with the current fixed physical insets/)
  })

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('rejects invalid target aspect %s', (targetAspect) => {
    expect(() =>
      fitPageFramePlotProfileToAspect(profile, targetAspect),
    ).toThrow(/finite positive/)
  })
})

describe('resizePageFramePlotProfileProportionally', () => {
  it.each([
    ['width', 130, { width: 130, height: 110 }],
    ['width', 430, { width: 430, height: 350 }],
    ['height', 70, { width: 80, height: 70 }],
    ['height', 350, { width: 430, height: 350 }],
  ] as const)(
    'drives a crop or pad from total paper %s while retaining fixed asymmetric insets',
    (dimension, millimeters, expected) => {
      const resized = resizePageFramePlotProfileProportionally(
        profile,
        fullFrame,
        dimension,
        millimeters,
      )

      expect({ width: resized.width, height: resized.height }).toEqual(
        expected,
      )
      expect(resized.insets).toEqual(profile.insets)
      expect(resized.insets).not.toBe(profile.insets)
      expect(resized.includeFrame).toBe(profile.includeFrame)
      expect(resized.toolWidthMillimeters).toBe(
        profile.toolWidthMillimeters,
      )
      expect(
        plotDrawableRectangle(resized).width /
          plotDrawableRectangle(resized).height,
      ).toBe(fullFrame.width / fullFrame.height)
    },
  )

  it('supports repeated edits and inch-converted total paper values without compounding scale', () => {
    const tenInches = inchToMm(10)
    const twelveInches = inchToMm(12)
    const widthDriven = resizePageFramePlotProfileProportionally(
      profile,
      fullFrame,
      'width',
      tenInches,
    )
    const heightDriven = resizePageFramePlotProfileProportionally(
      widthDriven,
      fullFrame,
      'height',
      twelveInches,
    )
    const widthDrivenAgain = resizePageFramePlotProfileProportionally(
      heightDriven,
      fullFrame,
      'width',
      tenInches,
    )

    expect(widthDriven.width).toBe(254)
    expect(widthDriven.height).toBeCloseTo(209.2, 12)
    expect(heightDriven.width).toBeCloseTo(373.5, 12)
    expect(heightDriven.height).toBeCloseTo(304.8, 12)
    expect(widthDrivenAgain.width).toBe(widthDriven.width)
    expect(widthDrivenAgain.height).toBeCloseTo(widthDriven.height, 12)
    expect(profile).toEqual({
      width: 230,
      height: 190,
      insets: { top: 7, right: 11, bottom: 23, left: 19 },
      includeFrame: false,
      toolWidthMillimeters: 0.7,
    })
  })

  it('rejects invalid dimensions, inset exhaustion, and a nonuniform represented scale', () => {
    expect(() =>
      resizePageFramePlotProfileProportionally(
        profile,
        fullFrame,
        'width',
        Number.NaN,
      ),
    ).toThrow(/finite positive/)
    expect(() =>
      resizePageFramePlotProfileProportionally(
        profile,
        fullFrame,
        'height',
        0,
      ),
    ).toThrow(/finite positive/)
    expect(() =>
      resizePageFramePlotProfileProportionally(
        profile,
        fullFrame,
        'width',
        profile.insets.left + profile.insets.right,
      ),
    ).toThrow(/exhausted/)
    expect(() =>
      resizePageFramePlotProfileProportionally(
        profile,
        { ...fullFrame, height: 1_000 },
        'width',
        130,
      ),
    ).toThrow(/equivalent physical scales/)
  })
})

describe('resizePageFrameFromPhysicalDimension', () => {
  const draftFrame: PageFrame = {
    x: 50,
    y: -20,
    width: 900,
    height: 700,
  }

  it.each([
    ['width', 130, { ...draftFrame, width: 500 }],
    ['width', 430, { ...draftFrame, width: 2_000 }],
    ['height', 110, { ...draftFrame, height: 400 }],
    ['height', 350, { ...draftFrame, height: 1_600 }],
  ] as const)(
    'maps cropped and padded total paper %s to only that draft extent',
    (dimension, millimeters, expected) => {
      expect(
        resizePageFrameFromPhysicalDimension(
          profile,
          fullFrame,
          draftFrame,
          dimension,
          millimeters,
        ),
      ).toEqual(expected)
    },
  )

  it('supports repeated per-axis edits, including an inch-converted value', () => {
    const widthEdited = resizePageFrameFromPhysicalDimension(
      profile,
      fullFrame,
      draftFrame,
      'width',
      inchToMm(10),
    )
    const heightEdited = resizePageFrameFromPhysicalDimension(
      profile,
      fullFrame,
      widthEdited,
      'height',
      110,
    )
    const widthEditedAgain = resizePageFrameFromPhysicalDimension(
      profile,
      fullFrame,
      heightEdited,
      'width',
      130,
    )

    expect(widthEdited).toEqual({ ...draftFrame, width: 1_120 })
    expect(heightEdited).toEqual({
      ...draftFrame,
      width: 1_120,
      height: 400,
    })
    expect(widthEditedAgain).toEqual({
      ...draftFrame,
      width: 500,
      height: 400,
    })
  })

  it('preserves the represented physical scale when the derived draft is committed', () => {
    const resizedDraft = resizePageFrameFromPhysicalDimension(
      profile,
      fullFrame,
      draftFrame,
      'width',
      130,
    )
    const committed = derivePageFramePlotProfile(
      profile,
      fullFrame,
      resizedDraft,
    )

    expect(committed.width).toBe(130)
    expect(committed.height).toBe(170)
    expect(plotDrawableRectangle(committed).width / resizedDraft.width).toBe(
      0.2,
    )
    expect(
      plotDrawableRectangle(committed).height / resizedDraft.height,
    ).toBe(0.2)
  })

  it('rejects invalid dimensions, inset exhaustion, and a nonuniform represented scale', () => {
    expect(() =>
      resizePageFrameFromPhysicalDimension(
        profile,
        fullFrame,
        draftFrame,
        'height',
        Number.POSITIVE_INFINITY,
      ),
    ).toThrow(/finite positive/)
    expect(() =>
      resizePageFrameFromPhysicalDimension(
        profile,
        fullFrame,
        draftFrame,
        'height',
        profile.insets.top + profile.insets.bottom,
      ),
    ).toThrow(/exhausted/)
    expect(() =>
      resizePageFrameFromPhysicalDimension(
        profile,
        { ...fullFrame, width: 800 },
        draftFrame,
        'width',
        130,
      ),
    ).toThrow(/equivalent physical scales/)
  })
})
