import { DEFAULT_COMPOSITION_FRAME } from '@harness/core'
import type { Params, Scene, Seed, Sketch } from '@harness/core'

/**
 * Map a Remotion frame index to the Sketch's Scene at that moment — the single
 * place the video package converts frame-space into the Sketch's continuous time
 * `t` (ADR-0002: a Sketch is a pure function of `(params, seed, t, frame)`, and
 * `t` is seconds, never a frame count).
 *
 * The Sketch's Composition Frame is the DEFAULT `1000 × 1000` frame for now
 * (`DEFAULT_COMPOSITION_FRAME`); deriving the real frame from the render's pixel
 * dimensions is #255's job. Note the Remotion frame INDEX below is a separate
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
 * @returns The Scene the Sketch produces at `t = frame / fps`.
 */
export function frameToScene(
  sketch: Sketch,
  params: Params,
  seed: Seed,
  frame: number,
  fps: number,
): Scene {
  return sketch.generate(params, seed, frame / fps, DEFAULT_COMPOSITION_FRAME)
}
