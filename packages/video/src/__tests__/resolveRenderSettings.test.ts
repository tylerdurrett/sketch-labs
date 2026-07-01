import { describe, expect, it } from 'vitest'

import { resolveRenderSettings, type Space } from '../resolveRenderSettings'

/**
 * A representative Sketch coordinate space — the width/height a probe `generate`
 * would report on `scene.space`. Kept distinct from any explicit prop dims so a
 * test can tell a sentinel fallback (resolves to these) from a passthrough.
 */
const SPACE: Space = { width: 800, height: 600 }

describe('resolveRenderSettings', () => {
  it('passes valid props through unchanged', () => {
    expect(resolveRenderSettings({ fps: 30, width: 1920, height: 1080 }, SPACE)).toEqual({
      fps: 30,
      width: 1920,
      height: 1080,
    })
  })

  it('resolves width: 0 to the Sketch space width (the sentinel)', () => {
    expect(resolveRenderSettings({ fps: 30, width: 0, height: 1080 }, SPACE).width).toBe(
      SPACE.width,
    )
  })

  it('resolves height: 0 to the Sketch space height (the sentinel)', () => {
    expect(resolveRenderSettings({ fps: 30, width: 1920, height: 0 }, SPACE).height).toBe(
      SPACE.height,
    )
  })

  it('resolves width: 0 and height: 0 together to the full Sketch space', () => {
    expect(resolveRenderSettings({ fps: 30, width: 0, height: 0 }, SPACE)).toEqual({
      fps: 30,
      width: SPACE.width,
      height: SPACE.height,
    })
  })

  it('passes a non-zero explicit dimension through without touching the space', () => {
    expect(resolveRenderSettings({ fps: 24, width: 1280, height: 720 }, SPACE)).toEqual({
      fps: 24,
      width: 1280,
      height: 720,
    })
  })

  it('throws naming width for a negative width', () => {
    expect(() => resolveRenderSettings({ fps: 30, width: -100, height: 1080 }, SPACE)).toThrow(
      /width/,
    )
  })

  it('throws naming height for a NaN height', () => {
    expect(() => resolveRenderSettings({ fps: 30, width: 1920, height: NaN }, SPACE)).toThrow(
      /height/,
    )
  })

  it('throws for an Infinity width', () => {
    expect(() =>
      resolveRenderSettings({ fps: 30, width: Infinity, height: 1080 }, SPACE),
    ).toThrow(/width/)
  })

  it('throws naming fps for fps: 0', () => {
    expect(() => resolveRenderSettings({ fps: 0, width: 1920, height: 1080 }, SPACE)).toThrow(/fps/)
  })

  it('throws naming fps for a negative fps', () => {
    expect(() => resolveRenderSettings({ fps: -30, width: 1920, height: 1080 }, SPACE)).toThrow(
      /fps/,
    )
  })

  it('throws naming fps for a NaN fps', () => {
    expect(() => resolveRenderSettings({ fps: NaN, width: 1920, height: 1080 }, SPACE)).toThrow(
      /fps/,
    )
  })
})
