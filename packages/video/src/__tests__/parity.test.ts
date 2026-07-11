import { describe, expect, it } from 'vitest'

import {
  COMPOSITION_FRAME_AREA,
  createScene,
  defaultParams,
  drawSceneFitted,
  prepareSketch,
  registry,
  resolveCompositionFrame,
  type CoordinateSpace,
  type Params,
  type Scene,
  type Seed,
  type Sketch,
} from '@harness/core'

import { frameToScene } from '../frameToScene'
import { RecordingContext } from './recordingContext'

/**
 * Cross-caller parity proof (headless — no browser, no video render).
 *
 * The claim under test is that `@harness/core` is genuinely headless: the SAME
 * shared `drawSceneFitted` pipeline, driven by two INDEPENDENT callers, produces
 * a byte-identical ordered stream of draw calls — AND that both callers now
 * DERIVE the Composition Frame from the same resolved pixel dimensions (aspect
 * only), so the frame handed to the Sketch is identical on both sides.
 *
 * - The STUDIO-shaped caller mirrors `LiveCanvas.drawFrame` under the unified
 *   Composition-Frame contract: `sketch.generate(params, seed, t,
 *   resolveCompositionFrame(pixelW / pixelH))` → `drawSceneFitted(ctx, scene, w, h)`.
 * - The VIDEO-shaped caller mirrors `CirclesComposition`:
 *   `frameToScene(sketch, params, seed, frame, fps, pixelW, pixelH)` →
 *   `drawSceneFitted(ctx, scene, w, h)`, where `frameToScene` samples at
 *   `t = frame / fps` and derives the SAME frame from `pixelW / pixelH` internally.
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
  // 900×1600 (portrait) is a non-square resolution: the derived Composition Frame
  // SHARES that aspect, so contain-fit is a pure uniform scale (no letterbox) but
  // still non-identity (scale ≠ 1), a stronger assertion than an identity transform.
  const pixelW = 900
  const pixelH = 1600
  // Both callers derive the SAME Composition Frame from the SAME pixel aspect.
  const frameSpace = resolveCompositionFrame(pixelW / pixelH)
  // t = 0.5s expressed two ways: the studio's wall-clock t, and frame 15 @ 30fps.
  const t = 0.5
  const fps = 30
  const frame = 15

  it('studio-shaped and video-shaped invocations emit byte-identical ordered logs', () => {
    const studioCtx = new RecordingContext()
    const studioScene = sketch.generate(params, seed, t, frameSpace)
    drawSceneFitted(studioCtx, studioScene, pixelW, pixelH)

    const videoCtx = new RecordingContext()
    const videoScene = frameToScene(sketch, params, seed, frame, fps, pixelW, pixelH)
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
    const scene = sketch.generate(params, seed, t, frameSpace)
    drawSceneFitted(ctx, scene, pixelW, pixelH)

    // The log STARTS with the background paint sequence: identity reset, white
    // fill of the full surface (both callers inherit the white default).
    expect(ctx.log.slice(0, 3)).toEqual([
      'setTransform(1,0,0,1,0,0)',
      'fillStyle=white',
      `fillRect(0,0,${pixelW},${pixelH})`,
    ])

    // There are exactly TWO setTransforms: the background's identity reset, then
    // the fit transform — which is the SECOND and is non-identity here (the frame
    // is scaled up to the larger pixel surface).
    const setTransforms = ctx.log.filter((entry) => entry.startsWith('setTransform('))
    expect(setTransforms).toHaveLength(2)
    expect(setTransforms[0]).toBe('setTransform(1,0,0,1,0,0)')
    expect(setTransforms[1]).not.toBe('setTransform(1,0,0,1,0,0)')
  })

  it('produces a non-empty draw stream (the proof is not vacuously equal)', () => {
    const ctx = new RecordingContext()
    const scene = sketch.generate(params, seed, t, frameSpace)
    drawSceneFitted(ctx, scene, pixelW, pixelH)

    // The 24 default circles each emit save/beginPath/moveTo/…/stroke — a
    // substantial log (circles are stroked, not filled).
    expect(ctx.log.length).toBeGreaterThan(10)
    expect(ctx.log).toContain('save')
    expect(ctx.log).toContain('stroke')
  })
})

/**
 * A spy Sketch that records the Composition Frame each `generate` call receives,
 * so a test can pin the EXACT frame a caller derives from pixel dimensions —
 * independent of any real Sketch's geometry. Current Sketches derive their own
 * fixed coordinate space and ignore the passed frame, so the frame-derivation
 * contract is proven here on the value HANDED to `generate`, not on downstream
 * Scene geometry.
 */
function frameSpySketch(): {
  sketch: Sketch
  frames: CoordinateSpace[]
} {
  const frames: CoordinateSpace[] = []
  const sketch: Sketch = {
    id: 'frame-spy',
    name: 'Frame Spy',
    schema: {},
    generate(_params: Params, _seed: Seed, _t: number, frame: CoordinateSpace): Scene {
      frames.push(frame)
      return createScene({ width: 100, height: 100 }).build()
    },
  }
  return { sketch, frames }
}

/**
 * Composition-Frame derivation across pixel resolutions — the aspect-only rule.
 *
 * Both the studio-shaped caller (`resolveCompositionFrame(pixelW / pixelH)`) and
 * the video-shaped caller (`frameToScene`, which derives the same internally) map
 * pixel dimensions to the shared fixed-area frame using ASPECT ONLY. These tests
 * pin: same-aspect resolutions of different magnitude produce the identical
 * frame (and identical Scene geometry); differing aspects produce the
 * corresponding `resolveCompositionFrame(aspect)` frame; the two callers agree on
 * that frame; and the derivation is deterministic (re-derivable every render).
 */
describe('Composition Frame derivation across pixel resolutions', () => {
  const fps = 30
  const frame = 15

  it('derives the identical frame for same-aspect resolutions of different magnitude', () => {
    const big = frameSpySketch()
    const small = frameSpySketch()

    // 900×1600 and 450×800 share aspect 0.5625.
    frameToScene(big.sketch, {}, 1, frame, fps, 900, 1600)
    frameToScene(small.sketch, {}, 1, frame, fps, 450, 800)

    expect(small.frames[0]).toEqual(big.frames[0])
    expect(big.frames[0]).toEqual(resolveCompositionFrame(900 / 1600))
  })

  it('same-aspect resolutions yield identical Scene geometry from a real Sketch', () => {
    const sketch = registry.get('circles')
    const params = defaultParams(sketch.schema)
    const seed: Seed = 1

    const big = frameToScene(sketch, params, seed, frame, fps, 900, 1600)
    const small = frameToScene(sketch, params, seed, frame, fps, 450, 800)

    // Identical derived frame ⇒ identical Scene; drawing each at a shared target
    // size therefore produces byte-identical ordered logs.
    expect(small).toEqual(big)
    const bigCtx = new RecordingContext()
    const smallCtx = new RecordingContext()
    drawSceneFitted(bigCtx, big, 900, 1600)
    drawSceneFitted(smallCtx, small, 900, 1600)
    expect(smallCtx.log).toEqual(bigCtx.log)
  })

  it('portrait and landscape derive their corresponding, distinct frames', () => {
    const portrait = frameSpySketch()
    const landscape = frameSpySketch()

    frameToScene(portrait.sketch, {}, 1, frame, fps, 900, 1600)
    frameToScene(landscape.sketch, {}, 1, frame, fps, 1600, 900)

    // Each caller derives the fixed-area frame for its OWN aspect.
    expect(portrait.frames[0]).toEqual(resolveCompositionFrame(900 / 1600))
    expect(landscape.frames[0]).toEqual(resolveCompositionFrame(1600 / 900))
    // Differing aspects ⇒ differing frames (portrait is taller, landscape wider),
    // both holding the fixed 1,000,000 area.
    expect(portrait.frames[0]).not.toEqual(landscape.frames[0])
    expect(portrait.frames[0]!.height).toBeGreaterThan(portrait.frames[0]!.width)
    expect(landscape.frames[0]!.width).toBeGreaterThan(landscape.frames[0]!.height)
    expect(portrait.frames[0]!.width * portrait.frames[0]!.height).toBeCloseTo(
      COMPOSITION_FRAME_AREA,
    )
    expect(landscape.frames[0]!.width * landscape.frames[0]!.height).toBeCloseTo(
      COMPOSITION_FRAME_AREA,
    )
  })

  it('studio-shaped and video-shaped callers derive the SAME frame from the same pixel dims', () => {
    const video = frameSpySketch()
    frameToScene(video.sketch, {}, 1, frame, fps, 1600, 900)

    // The studio-shaped caller derives its frame the same way, from the same dims.
    const studioFrame = resolveCompositionFrame(1600 / 900)
    expect(video.frames[0]).toEqual(studioFrame)
  })

  it('recomposition is deterministic — re-deriving reproduces the same frame', () => {
    const spy = frameSpySketch()

    frameToScene(spy.sketch, {}, 1, frame, fps, 1280, 720)
    frameToScene(spy.sketch, {}, 1, frame, fps, 1280, 720)

    expect(spy.frames[1]).toEqual(spy.frames[0])
    expect(spy.frames[0]).toEqual(resolveCompositionFrame(1280 / 720))
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
    // A square 1000×1000 output ⇒ the derived frame is the default 1000×1000
    // Composition Frame (aspect 1), which the studio prepares with.
    const pixelW = 1000
    const pixelH = 1000
    const frameSpace = resolveCompositionFrame(pixelW / pixelH)

    // Studio retains this caller-owned sampler across its wall-clock frames;
    // Remotion remains free to request the same frame cold and out of order.
    const studioScene = prepareSketch(sketch, params, seed, frameSpace)(t)
    const videoScene = frameToScene(sketch, params, seed, frame, fps, pixelW, pixelH)
    expect(studioScene).toEqual(videoScene)

    const studioCtx = new RecordingContext()
    const videoCtx = new RecordingContext()
    drawSceneFitted(studioCtx, studioScene, pixelW, pixelH)
    drawSceneFitted(videoCtx, videoScene, pixelW, pixelH)
    expect(studioCtx.log).toEqual(videoCtx.log)
  })
})
