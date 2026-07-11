import { describe, expect, it } from 'vitest'

import { DEFAULT_COMPOSITION_FRAME } from '@harness/core'

import { resolveRenderSettings } from '../resolveRenderSettings'

/** A valid background so a test focused on other props needn't repeat it. */
const BG = 'white'

describe('resolveRenderSettings', () => {
  it('passes valid props through unchanged', () => {
    expect(
      resolveRenderSettings({ fps: 30, width: 1920, height: 1080, background: BG }),
    ).toEqual({
      fps: 30,
      width: 1920,
      height: 1080,
      background: BG,
    })
  })

  it('resolves width: 0 to the default Composition Frame width (the sentinel)', () => {
    expect(
      resolveRenderSettings({ fps: 30, width: 0, height: 1080, background: BG }).width,
    ).toBe(DEFAULT_COMPOSITION_FRAME.width)
  })

  it('resolves height: 0 to the default Composition Frame height (the sentinel)', () => {
    expect(
      resolveRenderSettings({ fps: 30, width: 1920, height: 0, background: BG }).height,
    ).toBe(DEFAULT_COMPOSITION_FRAME.height)
  })

  it('resolves width: 0 and height: 0 together to the full default Composition Frame', () => {
    expect(
      resolveRenderSettings({ fps: 30, width: 0, height: 0, background: BG }),
    ).toEqual({
      fps: 30,
      width: DEFAULT_COMPOSITION_FRAME.width,
      height: DEFAULT_COMPOSITION_FRAME.height,
      background: BG,
    })
  })

  it('passes a non-zero explicit dimension through without touching the default frame', () => {
    expect(
      resolveRenderSettings({ fps: 24, width: 1280, height: 720, background: BG }),
    ).toEqual({
      fps: 24,
      width: 1280,
      height: 720,
      background: BG,
    })
  })

  it('throws naming width for a negative width', () => {
    expect(() =>
      resolveRenderSettings({ fps: 30, width: -100, height: 1080, background: BG }),
    ).toThrow(/width/)
  })

  it('throws naming height for a NaN height', () => {
    expect(() =>
      resolveRenderSettings({ fps: 30, width: 1920, height: NaN, background: BG }),
    ).toThrow(/height/)
  })

  it('throws for an Infinity width', () => {
    expect(() =>
      resolveRenderSettings({ fps: 30, width: Infinity, height: 1080, background: BG }),
    ).toThrow(/width/)
  })

  it('throws naming fps for fps: 0', () => {
    expect(() =>
      resolveRenderSettings({ fps: 0, width: 1920, height: 1080, background: BG }),
    ).toThrow(/fps/)
  })

  it('throws naming fps for a negative fps', () => {
    expect(() =>
      resolveRenderSettings({ fps: -30, width: 1920, height: 1080, background: BG }),
    ).toThrow(/fps/)
  })

  it('throws naming fps for a NaN fps', () => {
    expect(() =>
      resolveRenderSettings({ fps: NaN, width: 1920, height: 1080, background: BG }),
    ).toThrow(/fps/)
  })

  it('passes a CSS-color background through unchanged', () => {
    expect(
      resolveRenderSettings({ fps: 30, width: 1920, height: 1080, background: '#0a0a0a' })
        .background,
    ).toBe('#0a0a0a')
  })

  it("accepts 'transparent' as a valid background", () => {
    expect(
      resolveRenderSettings({ fps: 30, width: 1920, height: 1080, background: 'transparent' })
        .background,
    ).toBe('transparent')
  })

  it('throws naming background for an empty-string background', () => {
    expect(() =>
      resolveRenderSettings({ fps: 30, width: 1920, height: 1080, background: '' }),
    ).toThrow(/background/)
  })

  it('throws naming background for a non-string background', () => {
    expect(() =>
      resolveRenderSettings({
        fps: 30,
        width: 1920,
        height: 1080,
        background: null as unknown as string,
      }),
    ).toThrow(/background/)
  })
})
