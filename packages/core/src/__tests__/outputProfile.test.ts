import { describe, expect, it } from 'vitest'
import {
  HARNESS_FALLBACK_PLOT_PROFILE,
  resolveOutputProfile,
} from '../outputProfile'
import { validatePlotProfile, type PlotProfile } from '../plotProfile'

/**
 * Build a distinct valid Plot Profile — deliberately NOT the Harness fallback —
 * so a returned profile can be told apart from the fallback by identity. `label`
 * only nudges the dimensions to keep separate profiles distinguishable.
 */
function makeProfile(label = 1): PlotProfile {
  return {
    width: 100 + label,
    height: 150 + label,
    insets: { top: 5, right: 5, bottom: 5, left: 5 },
    includeFrame: true,
    toolWidthMillimeters: 0.3,
  }
}

describe('HARNESS_FALLBACK_PLOT_PROFILE', () => {
  it('is a square 200 × 200 mm sheet', () => {
    expect(HARNESS_FALLBACK_PLOT_PROFILE.width).toBe(200)
    expect(HARNESS_FALLBACK_PLOT_PROFILE.height).toBe(200)
  })

  it('has linked (symmetric) 10 mm insets on all four edges', () => {
    expect(HARNESS_FALLBACK_PLOT_PROFILE.insets).toEqual({
      top: 10,
      right: 10,
      bottom: 10,
      left: 10,
    })
  })

  it('includes the authored Composition Frame by default', () => {
    expect(HARNESS_FALLBACK_PLOT_PROFILE.includeFrame).toBe(true)
  })

  it('validates clean through the #263 model', () => {
    expect(() =>
      validatePlotProfile(HARNESS_FALLBACK_PLOT_PROFILE),
    ).not.toThrow()
  })
})

describe('resolveOutputProfile', () => {
  it('returns the preset profile when present (preset wins outright)', () => {
    const preset = makeProfile(1)
    const sketchDefault = makeProfile(2)
    expect(resolveOutputProfile(preset, sketchDefault)).toBe(preset)
  })

  it('returns the preset profile even when no Sketch default is given', () => {
    const preset = makeProfile(1)
    expect(resolveOutputProfile(preset)).toBe(preset)
  })

  it('returns the Sketch default when no preset profile is present', () => {
    const sketchDefault = makeProfile(2)
    expect(resolveOutputProfile(undefined, sketchDefault)).toBe(sketchDefault)
  })

  it('preserves a selected profile with includeFrame disabled', () => {
    const preset = { ...makeProfile(), includeFrame: false }
    expect(resolveOutputProfile(preset).includeFrame).toBe(false)
  })

  it('returns the Harness fallback when neither preset nor Sketch default is present', () => {
    expect(resolveOutputProfile()).toBe(HARNESS_FALLBACK_PLOT_PROFILE)
    expect(resolveOutputProfile(undefined, undefined)).toBe(
      HARNESS_FALLBACK_PLOT_PROFILE,
    )
  })

  it('does not leak a last-selected profile — a resolved profile is not remembered', () => {
    // Resolve once with a distinct profile A...
    const profileA = makeProfile(7)
    expect(resolveOutputProfile(profileA)).toBe(profileA)

    // ...then resolve again with no preset and no default: it must return the
    // Harness fallback, never the previously-passed profile A.
    const next = resolveOutputProfile()
    expect(next).toBe(HARNESS_FALLBACK_PLOT_PROFILE)
    expect(next).not.toBe(profileA)
  })

  it('is a pure function of its arguments across interleaved calls', () => {
    const preset = makeProfile(3)
    const sketchDefault = makeProfile(4)
    // Prior calls with other inputs never perturb a later call's result.
    resolveOutputProfile(preset, sketchDefault)
    resolveOutputProfile(undefined, sketchDefault)
    expect(resolveOutputProfile()).toBe(HARNESS_FALLBACK_PLOT_PROFILE)
    expect(resolveOutputProfile(preset)).toBe(preset)
    expect(resolveOutputProfile(undefined, sketchDefault)).toBe(sketchDefault)
  })
})
