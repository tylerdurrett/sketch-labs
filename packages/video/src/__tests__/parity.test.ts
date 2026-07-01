import { describe, expect, it } from 'vitest'

import { defaultParams, drawSceneFitted, registry, type Seed } from '@harness/core'

import { frameToScene } from '../frameToScene'
import { RecordingContext } from './recordingContext'

/**
 * Cross-caller parity proof (headless — no browser, no video render).
 *
 * The claim under test is that `@harness/core` is genuinely headless: the SAME
 * shared `drawSceneFitted` pipeline, driven by two INDEPENDENT callers, produces
 * a byte-identical ordered stream of draw calls.
 *
 * - The STUDIO-shaped caller mirrors `LiveCanvas.drawFrame`:
 *   `sketch.generate(params, seed, t)` → `drawSceneFitted(ctx, scene, w, h)`.
 * - The VIDEO-shaped caller mirrors `CirclesComposition`:
 *   `frameToScene(sketch, params, seed, frame, fps)` → `drawSceneFitted(ctx, scene, w, h)`,
 *   where `frameToScene` samples at `t = frame / fps`.
 *
 * With the frame/fps chosen so `frame / fps === t`, and the same params/seed/dims,
 * the two callers MUST emit identical ordered logs — including the `setTransform`
 * contain-fit call `drawSceneFitted` establishes before drawing (the recording
 * stub records it as an ordered event, so the fit transform is part of the proof,
 * not invisible glue).
 */
describe('cross-caller draw-call parity', () => {
  const sketch = registry.get('circles')
  const params = defaultParams(sketch.schema)
  const seed: Seed = 1
  // 900×1600 (portrait) forces a non-trivial contain-fit: the 1000×1000 square
  // Scene is scaled and letterbox-centered, so setTransform carries a real
  // scale + offset — a stronger assertion than an identity transform.
  const pixelW = 900
  const pixelH = 1600
  // t = 0.5s expressed two ways: the studio's wall-clock t, and frame 15 @ 30fps.
  const t = 0.5
  const fps = 30
  const frame = 15

  it('studio-shaped and video-shaped invocations emit byte-identical ordered logs', () => {
    const studioCtx = new RecordingContext()
    const studioScene = sketch.generate(params, seed, t)
    drawSceneFitted(studioCtx, studioScene, pixelW, pixelH)

    const videoCtx = new RecordingContext()
    const videoScene = frameToScene(sketch, params, seed, frame, fps)
    drawSceneFitted(videoCtx, videoScene, pixelW, pixelH)

    expect(videoCtx.log).toEqual(studioCtx.log)
    // The join is the byte-level assertion the proof is named for.
    expect(videoCtx.log.join('\n')).toBe(studioCtx.log.join('\n'))
  })

  it('records the contain-fit setTransform as the first ordered event', () => {
    const ctx = new RecordingContext()
    const scene = sketch.generate(params, seed, t)
    drawSceneFitted(ctx, scene, pixelW, pixelH)

    // drawSceneFitted establishes the fit transform BEFORE renderToCanvas draws,
    // so the very first logged event is the setTransform with a real scale/offset.
    expect(ctx.log[0]).toMatch(/^setTransform\(/)
    // The transform is non-identity here (square Scene into a portrait surface).
    expect(ctx.log[0]).not.toBe('setTransform(1,0,0,1,0,0)')
    // And it is present exactly once (the fit is established once per draw).
    expect(ctx.log.filter((entry) => entry.startsWith('setTransform(')).length).toBe(1)
  })

  it('produces a non-empty draw stream (the proof is not vacuously equal)', () => {
    const ctx = new RecordingContext()
    const scene = sketch.generate(params, seed, t)
    drawSceneFitted(ctx, scene, pixelW, pixelH)

    // The 24 default circles each emit save/beginPath/moveTo/…/stroke — a
    // substantial log (circles are stroked, not filled).
    expect(ctx.log.length).toBeGreaterThan(10)
    expect(ctx.log).toContain('save')
    expect(ctx.log).toContain('stroke')
  })
})
