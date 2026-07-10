import { describe, expect, it } from 'vitest'

import {
  defaultParams,
  drawSceneFitted,
  prepareSketch,
  registry,
  type Seed,
} from '@harness/core'

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
 * contain-fit call AND the opaque-background paint `drawSceneFitted` establishes
 * before drawing (the recording stub records both as ordered events, so the fit
 * transform and backdrop are part of the proof, not invisible glue).
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

    // The opaque-background paint (default white, over the full surface) is part
    // of the byte-identical log — the AC that the recording-context test covers
    // the background paint (issue #92).
    expect(studioCtx.log.slice(0, 3)).toEqual([
      'setTransform(1,0,0,1,0,0)',
      'fillStyle=white',
      `fillRect(0,0,${pixelW},${pixelH})`,
    ])
  })

  it('opens with the background paint, then the contain-fit setTransform', () => {
    const ctx = new RecordingContext()
    const scene = sketch.generate(params, seed, t)
    drawSceneFitted(ctx, scene, pixelW, pixelH)

    // The log STARTS with the background paint sequence: identity reset, white
    // fill of the full surface (both callers inherit the white default).
    expect(ctx.log.slice(0, 3)).toEqual([
      'setTransform(1,0,0,1,0,0)',
      'fillStyle=white',
      `fillRect(0,0,${pixelW},${pixelH})`,
    ])

    // There are exactly TWO setTransforms: the background's identity reset, then
    // the fit transform — which is the SECOND and is non-identity here (square
    // Scene into a portrait surface).
    const setTransforms = ctx.log.filter((entry) => entry.startsWith('setTransform('))
    expect(setTransforms).toHaveLength(2)
    expect(setTransforms[0]).toBe('setTransform(1,0,0,1,0,0)')
    expect(setTransforms[1]).not.toBe('setTransform(1,0,0,1,0,0)')
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

describe('prepared Studio sampling remains identical to random-access video sampling', () => {
  it('produces the same leaf-field Scene and ordered draw stream at frame/fps time', () => {
    const sketch = registry.get('leaf-field')
    const params = { ...defaultParams(sketch.schema), density: 3, sphereCount: 1 }
    const seed: Seed = 'prepared-cross-caller'
    const frame = 9
    const fps = 24
    const t = frame / fps

    // Studio retains this caller-owned sampler across its wall-clock frames;
    // Remotion remains free to request the same frame cold and out of order.
    const studioScene = prepareSketch(sketch, params, seed)(t)
    const videoScene = frameToScene(sketch, params, seed, frame, fps)
    expect(studioScene).toEqual(videoScene)

    const studioCtx = new RecordingContext()
    const videoCtx = new RecordingContext()
    drawSceneFitted(studioCtx, studioScene, 1000, 1000)
    drawSceneFitted(videoCtx, videoScene, 1000, 1000)
    expect(studioCtx.log).toEqual(videoCtx.log)
  })
})
