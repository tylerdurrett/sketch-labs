import { describe, expect, it } from 'vitest'
import { resolveCompositionFrame } from '../compositionFrame'
import { fullCompositionPageFrame, type PageFrame } from '../pageFrame'
import {
  derivePageFramePlotProfile,
  resizePageFrameFromPhysicalDimension,
  resizePageFramePlotProfileProportionally,
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
