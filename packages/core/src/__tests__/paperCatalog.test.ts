import { describe, expect, it } from 'vitest'
import {
  STANDARD_PAPERS,
  STANDARD_PAPER_NAMES,
  standardPaperProfile,
  applyStandardPaper,
  matchStandardPaper,
  derivePaperOrientation,
  swapPlotOrientation,
  MM_PER_INCH,
  mmToInch,
  inchToMm,
  plotProfileToInches,
  plotProfileFromInches,
} from '../paperCatalog'
import type { PlotInsets, PlotProfile } from '../plotProfile'

/** Asymmetric insets — asymmetry proves a swap does NOT reorder them. */
const ASYMMETRIC_INSETS: PlotInsets = { top: 5, right: 10, bottom: 15, left: 20 }
const ZERO_INSETS: PlotInsets = { top: 0, right: 0, bottom: 0, left: 0 }

/** The record shape carries only dimensions and insets — nothing derived. */
const PROFILE_KEYS = ['height', 'insets', 'width']

describe('STANDARD_PAPERS catalog', () => {
  it('covers the six standard formats in portrait millimeters (AC4)', () => {
    expect(STANDARD_PAPERS).toEqual({
      a2: { width: 420, height: 594 },
      a3: { width: 297, height: 420 },
      a4: { width: 210, height: 297 },
      a5: { width: 148, height: 210 },
      letter: { width: 215.9, height: 279.4 },
      tabloid: { width: 279.4, height: 431.8 },
    })
  })

  it('lists exactly the six standard names', () => {
    expect([...STANDARD_PAPER_NAMES]).toEqual([
      'a2',
      'a3',
      'a4',
      'a5',
      'letter',
      'tabloid',
    ])
  })

  it('stores every format in portrait orientation (width <= height)', () => {
    for (const name of STANDARD_PAPER_NAMES) {
      const { width, height } = STANDARD_PAPERS[name]
      expect(width, `${name} width should be <= height`).toBeLessThanOrEqual(
        height,
      )
    }
  })
})

describe('standardPaperProfile', () => {
  it('produces portrait catalog dimensions by default', () => {
    const profile = standardPaperProfile('a4')
    expect(profile.width).toBe(210)
    expect(profile.height).toBe(297)
  })

  it('transposes width and height for landscape', () => {
    const profile = standardPaperProfile('a4', 'landscape')
    expect(profile.width).toBe(297)
    expect(profile.height).toBe(210)
  })

  it('defaults to zero insets', () => {
    expect(standardPaperProfile('a4').insets).toEqual(ZERO_INSETS)
  })

  it('carries provided insets through', () => {
    expect(standardPaperProfile('a4', 'portrait', ASYMMETRIC_INSETS).insets).toEqual(
      ASYMMETRIC_INSETS,
    )
  })

  it('stores only dimensions and insets — no paper name or orientation (AC1)', () => {
    expect(Object.keys(standardPaperProfile('a4')).sort()).toEqual(PROFILE_KEYS)
  })
})

describe('applyStandardPaper', () => {
  it('writes catalog dimensions into the profile, preserving its insets (AC1)', () => {
    const profile: PlotProfile = {
      width: 200,
      height: 200,
      insets: ASYMMETRIC_INSETS,
    }
    const next = applyStandardPaper(profile, 'a3')
    expect(next.width).toBe(297)
    expect(next.height).toBe(420)
    expect(next.insets).toEqual(ASYMMETRIC_INSETS)
  })

  it('preserves insets when writing a landscape standard', () => {
    const profile: PlotProfile = {
      width: 200,
      height: 200,
      insets: ASYMMETRIC_INSETS,
    }
    const next = applyStandardPaper(profile, 'letter', 'landscape')
    expect(next.width).toBe(279.4)
    expect(next.height).toBe(215.9)
    expect(next.insets).toEqual(ASYMMETRIC_INSETS)
  })

  it('persists no standard name or orientation on the profile (AC1)', () => {
    const profile: PlotProfile = { width: 200, height: 200, insets: ZERO_INSETS }
    expect(Object.keys(applyStandardPaper(profile, 'a4')).sort()).toEqual(
      PROFILE_KEYS,
    )
  })

  it('does not mutate the input profile', () => {
    const profile: PlotProfile = { width: 200, height: 200, insets: ZERO_INSETS }
    applyStandardPaper(profile, 'a4', 'landscape')
    expect(profile).toEqual({ width: 200, height: 200, insets: ZERO_INSETS })
  })

  it('writes dimensions from which the label and orientation are re-derivable (AC1)', () => {
    const profile: PlotProfile = { width: 200, height: 200, insets: ZERO_INSETS }
    const next = applyStandardPaper(profile, 'a4', 'landscape')
    expect(matchStandardPaper(next)).toBe('a4')
    expect(derivePaperOrientation(next)).toBe('landscape')
  })
})

describe('matchStandardPaper', () => {
  it('matches every standard format from its portrait dimensions', () => {
    for (const name of STANDARD_PAPER_NAMES) {
      expect(matchStandardPaper(STANDARD_PAPERS[name])).toBe(name)
    }
  })

  it('matches a landscape sheet to the same standard (orientation-independent)', () => {
    const { width, height } = STANDARD_PAPERS.a4
    expect(matchStandardPaper({ width: height, height: width })).toBe('a4')
  })

  it('accepts a full Plot Profile and ignores its insets', () => {
    const profile: PlotProfile = {
      width: 210,
      height: 297,
      insets: ASYMMETRIC_INSETS,
    }
    expect(matchStandardPaper(profile)).toBe('a4')
  })

  it('returns null for a custom (non-standard) size', () => {
    expect(matchStandardPaper({ width: 200, height: 200 })).toBeNull()
  })

  it('tolerates small float noise within tolerance', () => {
    expect(
      matchStandardPaper({ width: 210.0000001, height: 296.9999999 }),
    ).toBe('a4')
  })

  it('returns null for a size just outside the tolerance', () => {
    expect(matchStandardPaper({ width: 215, height: 297 })).toBeNull()
  })
})

describe('derivePaperOrientation', () => {
  it('derives portrait when height exceeds width', () => {
    expect(derivePaperOrientation({ width: 210, height: 297 })).toBe('portrait')
  })

  it('derives landscape when width exceeds height', () => {
    expect(derivePaperOrientation({ width: 297, height: 210 })).toBe('landscape')
  })

  it('treats a square sheet as portrait', () => {
    expect(derivePaperOrientation({ width: 200, height: 200 })).toBe('portrait')
  })

  it('derives from a full Plot Profile', () => {
    const profile: PlotProfile = {
      width: 297,
      height: 210,
      insets: ZERO_INSETS,
    }
    expect(derivePaperOrientation(profile)).toBe('landscape')
  })
})

describe('swapPlotOrientation', () => {
  it('transposes width and height (AC2)', () => {
    const swapped = swapPlotOrientation({
      width: 210,
      height: 297,
      insets: ASYMMETRIC_INSETS,
    })
    expect(swapped.width).toBe(297)
    expect(swapped.height).toBe(210)
  })

  it('carries the insets through unchanged — does NOT reorder them (AC2)', () => {
    const swapped = swapPlotOrientation({
      width: 210,
      height: 297,
      insets: ASYMMETRIC_INSETS,
    })
    // top/right/bottom/left are identical — not rotated with the paper.
    expect(swapped.insets).toEqual(ASYMMETRIC_INSETS)
  })

  it('introduces no new stored state — only width, height, insets (AC2)', () => {
    const swapped = swapPlotOrientation({
      width: 210,
      height: 297,
      insets: ASYMMETRIC_INSETS,
    })
    expect(Object.keys(swapped).sort()).toEqual(PROFILE_KEYS)
  })

  it('does not mutate the input profile', () => {
    const profile: PlotProfile = {
      width: 210,
      height: 297,
      insets: { ...ASYMMETRIC_INSETS },
    }
    swapPlotOrientation(profile)
    expect(profile).toEqual({
      width: 210,
      height: 297,
      insets: ASYMMETRIC_INSETS,
    })
  })

  it('is its own inverse — swapping twice restores the original', () => {
    const profile: PlotProfile = {
      width: 210,
      height: 297,
      insets: ASYMMETRIC_INSETS,
    }
    expect(swapPlotOrientation(swapPlotOrientation(profile))).toEqual(profile)
  })

  it('flips the derived orientation while matching the same standard', () => {
    const portrait: PlotProfile = {
      width: 210,
      height: 297,
      insets: ASYMMETRIC_INSETS,
    }
    const landscape = swapPlotOrientation(portrait)
    expect(derivePaperOrientation(portrait)).toBe('portrait')
    expect(derivePaperOrientation(landscape)).toBe('landscape')
    expect(matchStandardPaper(portrait)).toBe('a4')
    expect(matchStandardPaper(landscape)).toBe('a4')
  })
})

describe('millimeter <-> inch conversion', () => {
  it('MM_PER_INCH is the exact 25.4 factor', () => {
    expect(MM_PER_INCH).toBe(25.4)
  })

  it('mmToInch / inchToMm convert scalar lengths', () => {
    expect(mmToInch(25.4)).toBeCloseTo(1)
    expect(inchToMm(1)).toBeCloseTo(25.4)
    expect(mmToInch(210)).toBeCloseTo(210 / 25.4)
  })

  it('plotProfileToInches converts width, height, and all four insets', () => {
    const profile: PlotProfile = {
      width: 25.4,
      height: 50.8,
      insets: { top: 25.4, right: 50.8, bottom: 12.7, left: 0 },
    }
    const inches = plotProfileToInches(profile)
    expect(inches.width).toBeCloseTo(1)
    expect(inches.height).toBeCloseTo(2)
    expect(inches.insets.top).toBeCloseTo(1)
    expect(inches.insets.right).toBeCloseTo(2)
    expect(inches.insets.bottom).toBeCloseTo(0.5)
    expect(inches.insets.left).toBeCloseTo(0)
  })

  it('round-trips mm -> inch -> mm back to the canonical value (AC3)', () => {
    const profile: PlotProfile = {
      width: 210,
      height: 297,
      insets: ASYMMETRIC_INSETS,
    }
    const roundTripped = plotProfileFromInches(plotProfileToInches(profile))
    // toBeCloseTo — the round trip returns within float tolerance, e.g. 210 may
    // come back as 210.00000000000003; NOT exact float equality.
    expect(roundTripped.width).toBeCloseTo(profile.width)
    expect(roundTripped.height).toBeCloseTo(profile.height)
    expect(roundTripped.insets.top).toBeCloseTo(profile.insets.top)
    expect(roundTripped.insets.right).toBeCloseTo(profile.insets.right)
    expect(roundTripped.insets.bottom).toBeCloseTo(profile.insets.bottom)
    expect(roundTripped.insets.left).toBeCloseTo(profile.insets.left)
  })

  it('never overwrites the canonical mm model — the input profile is unchanged (AC3)', () => {
    const profile: PlotProfile = {
      width: 210,
      height: 297,
      insets: ASYMMETRIC_INSETS,
    }
    plotProfileToInches(profile)
    plotProfileFromInches(profile)
    expect(profile).toEqual({
      width: 210,
      height: 297,
      insets: ASYMMETRIC_INSETS,
    })
  })

  it('the round trip still matches the same standard within catalog tolerance', () => {
    const profile: PlotProfile = { width: 210, height: 297, insets: ZERO_INSETS }
    const roundTripped = plotProfileFromInches(plotProfileToInches(profile))
    expect(matchStandardPaper(roundTripped)).toBe('a4')
  })
})
