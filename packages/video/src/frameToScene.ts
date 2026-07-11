import { resolveCompositionFrame } from '@harness/core'
import type { Params, Scene, Seed, Sketch } from '@harness/core'

/**
 * Map a Remotion frame index to the Sketch's Scene at that moment — the single
 * place the video package converts frame-space into the Sketch's continuous time
 * `t` (ADR-0002: a Sketch is a pure function of `(params, seed, t, frame)`, and
 * `t` is seconds, never a frame count).
 *
 * The Composition Frame handed to the Sketch is DERIVED from the render's
 * resolved pixel dimensions: `resolveCompositionFrame(pixelWidth / pixelHeight)`
 * yields the fixed-area (`1,000,000`) drawable rectangle whose ASPECT matches the
 * output. Only the aspect enters — magnitude never does — so any two resolutions
 * of the same aspect (e.g. `900×1600` and `450×800`) produce the identical frame
 * and hence identical Scene geometry. This is why the derivation lives here,
 * reachable from pixel dims alone: `useVideoConfig()` round-trips only
 * `fps`/`width`/`height`, NOT the frame, so the frame must be re-derivable every
 * render from `width`/`height`. Note the Remotion frame INDEX is a separate
 * concept from the Composition Frame — the `frame` parameter here is the integer
 * frame clock, not the drawable rectangle.
 *
 * `t = frame / fps` is the whole contract: frame 0 is `t = 0`, and frame `fps`
 * is `t = 1` second. `fps` stays OUT of the Sketch — it is a Render Setting the
 * caller owns — so this helper is where the two meet. It is PURE and carries NO
 * cross-frame state: calling it for frame N never depends on frame N-1, so
 * Remotion can render frames in any order (or in parallel) and get the same
 * Scene every time.
 *
 * This mirrors the studio's `LiveCanvas.drawFrame`, which samples the same
 * `sketch.generate(params, seed, t)` from a wall-clock `t`; here `t` is derived
 * from the frame clock instead. Both feed the shared `drawSceneFitted` pipeline,
 * which is what the cross-caller parity proof asserts.
 *
 * @param sketch - The Sketch to sample (resolved from the core registry).
 * @param params - Inhabited param values for the Sketch's schema.
 * @param seed - The explicit Seed all of the Sketch's randomness derives from.
 * @param frame - The Remotion frame index (0-based).
 * @param fps - Frames per second — the Render Setting mapping frames to seconds.
 * @param width - The resolved output width in pixels (drives the frame aspect).
 * @param height - The resolved output height in pixels (drives the frame aspect).
 * @returns The Scene the Sketch produces at `t = frame / fps` within the
 *   Composition Frame derived from `width / height`.
 */
export function frameToScene(
  sketch: Sketch,
  params: Params,
  seed: Seed,
  frame: number,
  fps: number,
  width: number,
  height: number,
): Scene {
  const frameSpace = resolveCompositionFrame(width / height)
  return sketch.generate(params, seed, frame / fps, frameSpace)
}
