import { useEffect, useRef } from 'react'
import {
  useCurrentFrame,
  useVideoConfig,
  type CalculateMetadataFunction,
} from 'remotion'

import {
  DEFAULT_COMPOSITION_FRAME,
  drawSceneFitted,
  registry,
  type Canvas2DContext,
  type Params,
  type Seed,
} from '@harness/core'

import { frameToScene } from './frameToScene'
import { resolveRenderSettings } from './resolveRenderSettings'

/** The Sketch this Composition renders — resolved from core's PUBLIC registry by
 * its stable id, NOT a direct import of the circles module. The video package is
 * a real second caller of core's public surface; if the id ever went stale the
 * registry throws loudly (see {@link registry}). */
export const CIRCLES_ID = 'circles'

/**
 * The default Render Settings fps (frames per second). A Render Setting, NOT part
 * of the Sketch contract — a Sketch is continuous in `t`, and `fps` is how a
 * discrete renderer SAMPLES that continuum (`t = frame / fps`). Overridable per
 * render via the composition's input props.
 */
export const DEFAULT_FPS = 30

/**
 * The default Seed — a fixed literal so every render is deterministic by default.
 * Overridable per render via input props (the determinism knob, alongside
 * `params`).
 */
export const DEFAULT_SEED: Seed = 1

/**
 * The default background — the opaque backdrop the shared `drawSceneFitted`
 * pipeline paints over the full surface (issue #92). A Render Setting with a safe
 * opaque default (white), so a black-stroked Sketch is never black-on-black in the
 * alpha-less `.mp4`. Overridable per render via `--props` (e.g. `'transparent'`).
 */
export const DEFAULT_BACKGROUND: string = 'white'

/**
 * The circles Composition's input props — the render-time knobs, split into two
 * kinds:
 *
 * - Render Settings (`fps`, `width`, `height`, `background`): how the discrete
 *   renderer samples, sizes, and backs the output. `fps` defaults to
 *   {@link DEFAULT_FPS}; `width`/`height` default (via
 *   {@link calculateCirclesMetadata}) to the Sketch's own coordinate space so the
 *   video matches the Scene's aspect ratio with no letterboxing; `background`
 *   defaults to {@link DEFAULT_BACKGROUND}.
 * - Determinism inputs (`params`, `seed`): what the Sketch draws. `params`
 *   defaults to `defaultParams(sketch.schema)`; `seed` to {@link DEFAULT_SEED}.
 *
 * All are overridable per render (Remotion `--props`), which is the whole point:
 * one Composition, many renders.
 */
export interface CirclesProps extends Record<string, unknown> {
  /** Frames per second — the frame→seconds sampling rate (`t = frame / fps`). */
  fps: number
  /** Output width in pixels; defaults to the Sketch's coordinate-space width. */
  width: number
  /** Output height in pixels; defaults to the Sketch's coordinate-space height. */
  height: number
  /** Opaque backdrop CSS color painted over the full surface; `'transparent'` clears. */
  background: string
  /** Inhabited param values handed to the Sketch's `generate`. */
  params: Params
  /** The explicit Seed all of the Sketch's randomness derives from. */
  seed: Seed
}

/**
 * Derive the Composition's metadata from its input props (Remotion calls this
 * before rendering):
 *
 * - `durationInFrames = round(time.duration × fps)` — the Sketch's declared
 *   loop length (circles: `time.duration = 4`) turned into a frame count at the
 *   chosen fps. `mode` is not part of frame math (it is a playback intent, ADR-0002).
 * - `width`/`height` default to the Sketch's coordinate space, read from ONE
 *   probe `generate` (`scene.space`). Any explicit `width`/`height` in the props
 *   wins, so a render can override the output size.
 *
 * The probe is a throwaway sample at `t = 0` purely to read the coordinate space;
 * its geometry is discarded. Keeping this in `calculateMetadata` (not the
 * component) means the frame count and default dimensions are settled ONCE per
 * render, before any frame draws.
 *
 * The Render Settings (`fps`, `width`, `height`) are validated via
 * {@link resolveRenderSettings} before use — `--props` is untyped JSON at the
 * boundary, so a negative/`NaN`/`Infinity` value that TypeScript's `number` type
 * does not exclude fails loudly here rather than corrupting the frame count or
 * canvas size.
 */
export const calculateCirclesMetadata: CalculateMetadataFunction<CirclesProps> = ({ props }) => {
  const sketch = registry.get(CIRCLES_ID)
  const durationSeconds = sketch.time?.duration ?? 1

  const probe = sketch.generate(props.params, props.seed, 0, DEFAULT_COMPOSITION_FRAME)
  const { fps, width, height } = resolveRenderSettings(props, probe.space)

  return {
    fps,
    durationInFrames: Math.round(durationSeconds * fps),
    width,
    height,
  }
}

/**
 * The circles Composition's per-frame component — the video-side mirror of the
 * studio's `LiveCanvas.drawFrame`, driving the SAME shared `drawSceneFitted`
 * pipeline from a second, independent caller (the cross-caller parity proof).
 *
 * Each frame: resolve the Sketch from the registry, sample it at `t = frame /
 * fps` via the pure {@link frameToScene} (no cross-frame state — this component
 * holds none), then `drawSceneFitted(ctx, scene, width, height, background)` onto
 * the canvas. `width`/`height` come from `useVideoConfig` (the metadata-resolved
 * output size), and the canvas backing store is sized to them. `mode` never
 * enters the frame math.
 *
 * `background` is NOT part of Remotion's returned metadata (only
 * `fps`/`durationInFrames`/`width`/`height` round-trip through `useVideoConfig`),
 * so it is received as a PROP directly (validated in {@link calculateCirclesMetadata}
 * via `resolveRenderSettings`). Painting it in `drawSceneFitted` also does the
 * per-frame surface clear unconditionally, subsuming the previously-missing
 * `clearRect` here — no cross-frame ghosting in the loop (issue #92).
 *
 * The browser `CanvasRenderingContext2D` is structurally assignable to core's
 * `Canvas2DContext` port except its `fillStyle`/`strokeStyle` getters are typed
 * wider (`string | CanvasGradient | CanvasPattern`); asserting to the port at
 * this single boundary keeps core headless with no runtime adapter — the same
 * boundary the studio's `drawFrame` establishes.
 */
export function CirclesComposition({ params, seed, background }: CirclesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    const sketch = registry.get(CIRCLES_ID)
    const scene = frameToScene(sketch, params, seed, frame, fps)
    drawSceneFitted(ctx as Canvas2DContext, scene, width, height, background)
  }, [frame, fps, width, height, params, seed, background])

  return <canvas ref={canvasRef} width={width} height={height} />
}
