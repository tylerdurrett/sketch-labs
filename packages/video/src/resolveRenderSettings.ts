import type { CirclesProps } from './CirclesComposition'

/**
 * The Sketch's coordinate space — the width/height a probe `generate` reports on
 * its `scene.space`. It is the default output size when a render does not pass an
 * explicit `width`/`height`, so the video matches the Scene's aspect ratio with
 * no letterboxing.
 */
export interface Space {
  width: number
  height: number
}

/**
 * The resolved Render Settings — every field a finite positive number, ready to
 * feed straight into the Composition's metadata. This is the VALIDATED shape:
 * once past {@link resolveRenderSettings}, downstream frame math (`durationInFrames
 * = round(duration × fps)`, the canvas backing-store size) can trust these values.
 */
export interface RenderSettings {
  fps: number
  width: number
  height: number
}

/**
 * Resolve and validate the Render Settings from a render's input props.
 *
 * Render Settings arrive via Remotion `--props`, which is untyped JSON at the
 * boundary — a caller can pass ANYTHING, including a negative, `NaN`, or
 * `Infinity` number that the TypeScript `number` type does not exclude. This is
 * the one place those values are pinned to sane ones before they reach frame
 * math, so a bad input fails loudly here instead of silently producing a broken
 * `durationInFrames` or a zero/garbage-sized canvas.
 *
 * The rules:
 *
 * - `fps` must be finite and `> 0` — it is the frame→seconds sampling rate and
 *   the multiplier in `durationInFrames = round(duration × fps)`, so `0`,
 *   negative, `NaN`, and `Infinity` are all rejected.
 * - `width`/`height` keep the deliberate `0`-means-"use the Sketch's coordinate
 *   space" sentinel: exactly `0` (`-0` included) resolves to `space.width` /
 *   `space.height`. ANY other value must be finite and `> 0`; negative, `NaN`,
 *   and `Infinity` are rejected rather than passed through (the old `|| space.*`
 *   fallback only caught falsy values, letting a truthy `-100` or `NaN` slip in).
 *
 * Validation uses {@link Number.isFinite}, which correctly rejects `NaN`,
 * `Infinity`, and non-number inputs — the exact failure modes `--props` can
 * introduce.
 *
 * @param props - The render's `fps`/`width`/`height` input props.
 * @param space - The Sketch's coordinate space, read from a probe `generate`.
 * @returns The resolved {@link RenderSettings}, all finite positives.
 * @throws if `fps`, or an explicitly-provided (non-zero) `width`/`height`, is not
 *   a finite positive number — the message names the offending prop and its value.
 */
export function resolveRenderSettings(
  props: Pick<CirclesProps, 'fps' | 'width' | 'height'>,
  space: Space,
): RenderSettings {
  const { fps, width, height } = props

  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`resolveRenderSettings: fps must be a finite positive number, got ${fps}`)
  }

  return {
    fps,
    width: resolveDimension('width', width, space.width),
    height: resolveDimension('height', height, space.height),
  }
}

/**
 * Resolve one output dimension against the `0`-sentinel: exactly `0` (`-0`
 * included) falls back to the Sketch-space default; any other value must be a
 * finite positive number or it throws (naming the dimension and its bad value).
 */
function resolveDimension(name: 'width' | 'height', value: number, fallback: number): number {
  if (value === 0) return fallback
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `resolveRenderSettings: ${name} must be a finite positive number (or 0 for the Sketch's space), got ${value}`,
    )
  }
  return value
}
