/**
 * The Composition Frame resolver (CONTEXT.md "Composition Frame", line 96).
 *
 * A Composition Frame is the scale-independent, aspect-ratio-bearing drawable
 * rectangle a Sketch composes into: a unitless coordinate space normalized to the
 * area of the Harness's `1000 × 1000` square. This module is the one place that
 * turns a bare drawable aspect ratio into that normalized space.
 *
 * Fixed-area normalization: for aspect `r` (width ÷ height), the frame resolves to
 * `width = 1000·√r` and `height = 1000/√r`. Two properties fall straight out of
 * that definition:
 *
 * - Fixed area: `width × height = 1000·√r · 1000/√r = 1,000,000` for every valid
 *   `r`. One million square coordinate units are preserved across aspect changes,
 *   so a Sketch's stroke widths and feature sizes read the same regardless of the
 *   frame's shape — an Output Profile later supplies the uniform conversion from
 *   these unitless coordinates to millimeters or pixels.
 * - Portrait/landscape symmetry: `√(1/r) = 1/√r`, so `r` and `1/r` produce exact
 *   transposes — resolve(r).width === resolve(1/r).height and vice versa. A
 *   portrait/landscape swap is therefore a pure transpose of the same frame.
 *
 * Magnitude never enters this module: it takes only the ratio. The physical paper
 * size or pixel resolution that a magnitude carries belongs to the later output
 * mapping, not to the frame's coordinate space.
 *
 * This is a Sketch-agnostic system module: the same resolver serves every Sketch
 * and every target (plot, video), which is why its rationale lives here rather
 * than in any one sketch (ADR-0007) and needs no ADR of its own.
 */

import type { CoordinateSpace } from './scene'

/**
 * The total area, in square coordinate units, every resolved Composition Frame
 * preserves. Exposed as a named constant so callers and tests can assert against
 * it by name rather than a bare literal.
 */
export const COMPOSITION_FRAME_AREA = 1_000_000

/**
 * Resolve a drawable aspect ratio into a fixed-area Composition Frame coordinate
 * space.
 *
 * The aspect arrives from a drawable rectangle — a plot's paper inside its
 * margins, or a video's pixel width/height — as a bare `number` the TypeScript
 * type does not constrain to a sane value. This is the boundary where a bad input
 * fails loudly, mirroring {@link resolveRenderSettings} in `@sketch-labs/video`:
 * `0` (`-0` included), a negative, `NaN`, and `Infinity` are all rejected via
 * {@link Number.isFinite} and a `> 0` check, rather than silently producing a
 * `NaN`, zero-sized, or infinite frame.
 *
 * @param aspect - The drawable aspect ratio, width ÷ height; must be finite `> 0`.
 * @returns The resolved frame as a {@link CoordinateSpace}: `width = 1000·√aspect`,
 *   `height = 1000/√aspect`, so `width × height = 1,000,000`.
 * @throws if `aspect` is not a finite positive number.
 */
export function resolveCompositionFrame(aspect: number): CoordinateSpace {
  if (!Number.isFinite(aspect) || aspect <= 0) {
    throw new Error(
      `resolveCompositionFrame: aspect must be a finite positive number, got ${aspect}`,
    )
  }

  const root = Math.sqrt(aspect)
  return {
    width: 1000 * root,
    height: 1000 / root,
  }
}
