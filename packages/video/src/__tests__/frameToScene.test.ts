import { describe, expect, it } from 'vitest'

import {
  COMPOSITION_FRAME_AREA,
  createScene,
  resolveCompositionFrame,
  type CoordinateSpace,
  type Params,
  type Scene,
  type Seed,
  type Sketch,
} from '@harness/core'

import { frameToScene } from '../frameToScene'

/**
 * A spy Sketch that records the `(params, seed, t, frame)` its `generate` was
 * called with, so a test can pin the exact `t` `frameToScene` samples AND the
 * Composition Frame it derives, without depending on any real Sketch's output.
 * It returns a trivial empty Scene — the sampling and derivation are what's under
 * test, not the geometry.
 */
function spySketch(): {
  sketch: Sketch
  calls: Array<{ params: Params; seed: Seed; t: number; frame: CoordinateSpace }>
} {
  const calls: Array<{ params: Params; seed: Seed; t: number; frame: CoordinateSpace }> = []
  const sketch: Sketch = {
    id: 'spy',
    name: 'Spy',
    schema: {},
    generate(params: Params, seed: Seed, t: number, frame: CoordinateSpace): Scene {
      calls.push({ params, seed, t, frame })
      return createScene({ width: 100, height: 100 }).build()
    },
  }
  return { sketch, calls }
}

describe('frameToScene', () => {
  it('samples the Sketch at t = frame / fps', () => {
    const { sketch, calls } = spySketch()

    frameToScene(sketch, {}, 42, 15, 30, 1000, 1000)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.t).toBe(0.5)
  })

  it('maps frame 0 to t = 0', () => {
    const { sketch, calls } = spySketch()

    frameToScene(sketch, {}, 42, 0, 30, 1000, 1000)

    expect(calls[0]?.t).toBe(0)
  })

  it('maps frame = fps to t = 1 second', () => {
    const { sketch, calls } = spySketch()

    frameToScene(sketch, {}, 42, 30, 30, 1000, 1000)

    expect(calls[0]?.t).toBe(1)
  })

  it('forwards params and seed unchanged to generate', () => {
    const { sketch, calls } = spySketch()
    const params: Params = { count: 7 }

    frameToScene(sketch, params, 'my-seed', 3, 30, 1000, 1000)

    expect(calls[0]?.params).toBe(params)
    expect(calls[0]?.seed).toBe('my-seed')
  })

  it('derives the Composition Frame from the pixel aspect (magnitude never enters)', () => {
    const { sketch, calls } = spySketch()

    // Portrait 900×1600 → aspect 0.5625 → the shared fixed-area frame.
    frameToScene(sketch, {}, 42, 15, 30, 900, 1600)

    expect(calls[0]?.frame).toEqual(resolveCompositionFrame(900 / 1600))
    // Fixed area invariant carries through: width × height === 1,000,000.
    const { width, height } = calls[0]!.frame
    expect(width * height).toBeCloseTo(COMPOSITION_FRAME_AREA)
    // Portrait output → portrait frame (height > width).
    expect(height).toBeGreaterThan(width)
  })

  it('yields the identical frame for same-aspect resolutions of different magnitude', () => {
    const big = spySketch()
    const small = spySketch()

    frameToScene(big.sketch, {}, 42, 15, 30, 900, 1600)
    frameToScene(small.sketch, {}, 42, 15, 30, 450, 800)

    expect(small.calls[0]?.frame).toEqual(big.calls[0]?.frame)
  })

  it('is pure — repeated calls for the same frame yield the same t (no cross-frame state)', () => {
    const { sketch, calls } = spySketch()

    frameToScene(sketch, {}, 42, 15, 30, 1000, 1000)
    frameToScene(sketch, {}, 42, 15, 30, 1000, 1000)

    expect(calls[0]?.t).toBe(0.5)
    expect(calls[1]?.t).toBe(0.5)
  })
})
