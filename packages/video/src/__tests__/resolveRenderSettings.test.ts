import { describe, expect, it } from 'vitest'

import { resolveRenderSettings, type Space } from '../resolveRenderSettings'

/**
 * A representative Sketch coordinate space — the width/height a probe `generate`
 * would report on `scene.space`. Kept distinct from any explicit prop dims so a
 * test can tell a sentinel fallback (resolves to these) from a passthrough.
 */
const SPACE: Space = { width: 800, height: 600 }

/** A valid background so a test focused on other props needn't repeat it. */
const BG = 'white'

describe('resolveRenderSettings', () => {
  it('passes valid props through unchanged', () => {
    expect(
      resolveRenderSettings({ fps: 30, width: 1920, height: 1080, background: BG }, SPACE),
    ).toEqual({
      fps: 30,
      width: 1920,
      height: 1080,
      background: BG,
    })
  })

  it('resolves width: 0 to the Sketch space width (the sentinel)', () => {
    expect(
      resolveRenderSettings({ fps: 30, width: 0, height: 1080, background: BG }, SPACE).width,
    ).toBe(SPACE.width)
  })

  it('resolves height: 0 to the Sketch space height (the sentinel)', () => {
    expect(
      resolveRenderSettings({ fps: 30, width: 1920, height: 0, background: BG }, SPACE).height,
    ).toBe(SPACE.height)
  })

  it('resolves width: 0 and height: 0 together to the full Sketch space', () => {
    expect(
      resolveRenderSettings({ fps: 30, width: 0, height: 0, background: BG }, SPACE),
    ).toEqual({
      fps: 30,
      width: SPACE.width,
      height: SPACE.height,
      background: BG,
    })
  })

  it('passes a non-zero explicit dimension through without touching the space', () => {
    expect(
      resolveRenderSettings({ fps: 24, width: 1280, height: 720, background: BG }, SPACE),
    ).toEqual({
      fps: 24,
      width: 1280,
      height: 720,
      background: BG,
    })
  })

  it('throws naming width for a negative width', () => {
    expect(() =>
      resolveRenderSettings({ fps: 30, width: -100, height: 1080, background: BG }, SPACE),
    ).toThrow(/width/)
  })

  it('throws naming height for a NaN height', () => {
    expect(() =>
      resolveRenderSettings({ fps: 30, width: 1920, height: NaN, background: BG }, SPACE),
    ).toThrow(/height/)
  })

  it('throws for an Infinity width', () => {
    expect(() =>
      resolveRenderSettings({ fps: 30, width: Infinity, height: 1080, background: BG }, SPACE),
    ).toThrow(/width/)
  })

  it('throws naming fps for fps: 0', () => {
    expect(() =>
      resolveRenderSettings({ fps: 0, width: 1920, height: 1080, background: BG }, SPACE),
    ).toThrow(/fps/)
  })

  it('throws naming fps for a negative fps', () => {
    expect(() =>
      resolveRenderSettings({ fps: -30, width: 1920, height: 1080, background: BG }, SPACE),
    ).toThrow(/fps/)
  })

  it('throws naming fps for a NaN fps', () => {
    expect(() =>
      resolveRenderSettings({ fps: NaN, width: 1920, height: 1080, background: BG }, SPACE),
    ).toThrow(/fps/)
  })

  it('passes a CSS-color background through unchanged', () => {
    expect(
      resolveRenderSettings({ fps: 30, width: 1920, height: 1080, background: '#0a0a0a' }, SPACE)
        .background,
    ).toBe('#0a0a0a')
  })

  it("accepts 'transparent' as a valid background", () => {
    expect(
      resolveRenderSettings(
        { fps: 30, width: 1920, height: 1080, background: 'transparent' },
        SPACE,
      ).background,
    ).toBe('transparent')
  })

  it('throws naming background for an empty-string background', () => {
    expect(() =>
      resolveRenderSettings({ fps: 30, width: 1920, height: 1080, background: '' }, SPACE),
    ).toThrow(/background/)
  })

  it('throws naming background for a non-string background', () => {
    expect(() =>
      resolveRenderSettings(
        { fps: 30, width: 1920, height: 1080, background: null as unknown as string },
        SPACE,
      ),
    ).toThrow(/background/)
  })
})
