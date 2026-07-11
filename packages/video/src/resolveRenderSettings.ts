import { DEFAULT_COMPOSITION_FRAME } from '@harness/core'

import type { CirclesProps } from './CirclesComposition'

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
  background: string
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
 * - `width`/`height` keep the deliberate `0`-means-"use the default Composition
 *   Frame size" sentinel: exactly `0` (`-0` included) resolves to
 *   {@link DEFAULT_COMPOSITION_FRAME}'s `width` / `height` (`1000 × 1000`). ANY
 *   other value must be finite and `> 0`; negative, `NaN`, and `Infinity` are
 *   rejected rather than passed through (the old `|| space.*` fallback only
 *   caught falsy values, letting a truthy `-100` or `NaN` slip in). The default
 *   is a static constant now, not a probe-sourced Scene space, so resolving the
 *   default output size no longer requires generating and discarding a Scene.
 * - `background` is the opaque backdrop the shared pipeline paints (issue #92). It
 *   is a CSS color string OR `'transparent'`, and the default white lives in
 *   `defaultProps` (Root.tsx) rather than here. We cannot fully validate a CSS
 *   color headlessly (no DOM), so the boundary is minimal: reject a non-string or
 *   empty string; any non-empty string (`'transparent'` included) passes through.
 *
 * Numeric validation uses {@link Number.isFinite}, which correctly rejects `NaN`,
 * `Infinity`, and non-number inputs — the exact failure modes `--props` can
 * introduce.
 *
 * @param props - The render's `fps`/`width`/`height`/`background` input props.
 * @returns The resolved {@link RenderSettings}, dimensions finite positive.
 * @throws if `fps`, or an explicitly-provided (non-zero) `width`/`height`, is not
 *   a finite positive number, or `background` is not a non-empty string — the
 *   message names the offending prop and its value.
 */
export function resolveRenderSettings(
  props: Pick<CirclesProps, 'fps' | 'width' | 'height' | 'background'>,
): RenderSettings {
  const { fps, width, height, background } = props

  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`resolveRenderSettings: fps must be a finite positive number, got ${fps}`)
  }

  if (typeof background !== 'string' || background === '') {
    throw new Error(
      `resolveRenderSettings: background must be a non-empty CSS color string (or 'transparent'), got ${background}`,
    )
  }

  return {
    fps,
    width: resolveDimension('width', width, DEFAULT_COMPOSITION_FRAME.width),
    height: resolveDimension('height', height, DEFAULT_COMPOSITION_FRAME.height),
    background,
  }
}

/**
 * Resolve one output dimension against the `0`-sentinel: exactly `0` (`-0`
 * included) falls back to the default Composition Frame size; any other value
 * must be a finite positive number or it throws (naming the dimension and its
 * bad value).
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
