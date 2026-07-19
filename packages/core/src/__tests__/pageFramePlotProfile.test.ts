import { describe, expect, it } from 'vitest'
import { resolveCompositionFrame } from '../compositionFrame'
import { fullCompositionPageFrame, type PageFrame } from '../pageFrame'
import { derivePageFramePlotProfile } from '../pageFramePlotProfile'
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
    ).toThrow(/equivalent aspects/)
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
    ).toThrow(/equivalent aspects/)
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
