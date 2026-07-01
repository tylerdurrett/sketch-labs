import { describe, expect, it } from 'vitest'

import { createScene, type Params, type Scene, type Seed, type Sketch } from '@harness/core'

import { frameToScene } from '../frameToScene'

/**
 * A spy Sketch that records the `(params, seed, t)` its `generate` was called
 * with, so a test can pin the exact `t` `frameToScene` samples without depending
 * on any real Sketch's output. It returns a trivial empty Scene — the sampling
 * is what's under test, not the geometry.
 */
function spySketch(): { sketch: Sketch; calls: Array<{ params: Params; seed: Seed; t: number }> } {
  const calls: Array<{ params: Params; seed: Seed; t: number }> = []
  const sketch: Sketch = {
    id: 'spy',
    name: 'Spy',
    schema: {},
    generate(params: Params, seed: Seed, t: number): Scene {
      calls.push({ params, seed, t })
      return createScene({ width: 100, height: 100 }).build()
    },
  }
  return { sketch, calls }
}

describe('frameToScene', () => {
  it('samples the Sketch at t = frame / fps', () => {
    const { sketch, calls } = spySketch()

    frameToScene(sketch, {}, 42, 15, 30)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.t).toBe(0.5)
  })

  it('maps frame 0 to t = 0', () => {
    const { sketch, calls } = spySketch()

    frameToScene(sketch, {}, 42, 0, 30)

    expect(calls[0]?.t).toBe(0)
  })

  it('maps frame = fps to t = 1 second', () => {
    const { sketch, calls } = spySketch()

    frameToScene(sketch, {}, 42, 30, 30)

    expect(calls[0]?.t).toBe(1)
  })

  it('forwards params and seed unchanged to generate', () => {
    const { sketch, calls } = spySketch()
    const params: Params = { count: 7 }

    frameToScene(sketch, params, 'my-seed', 3, 30)

    expect(calls[0]?.params).toBe(params)
    expect(calls[0]?.seed).toBe('my-seed')
  })

  it('is pure — repeated calls for the same frame yield the same t (no cross-frame state)', () => {
    const { sketch, calls } = spySketch()

    frameToScene(sketch, {}, 42, 15, 30)
    frameToScene(sketch, {}, 42, 15, 30)

    expect(calls[0]?.t).toBe(0.5)
    expect(calls[1]?.t).toBe(0.5)
  })
})
