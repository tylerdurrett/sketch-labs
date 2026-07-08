/**
 * The export-filename helper — the single authority on what a downloaded export
 * is named, shared by every export path (PNG today, SVG next).
 *
 * Pure and headless: no DOM, no Blob, no download. It mirrors the
 * injected-purity style of `randomize` / `newSeed` in `sketch.ts` and the Preset
 * helpers in `preset.ts` — a sibling of the core engine functions, testable
 * without a browser. The DOM-coupled "download this Blob" step is the consumer's
 * (the Studio's) concern; this module owns only the pure name string, which is
 * exactly why it lives in `core`: both the Studio and any future export consumer
 * derive the same name from the same `(sketchId, seed, t)` spine.
 *
 * Two ideas are load-bearing here:
 *
 * - The `-t{t}` segment is TIME-GATED. A static Sketch (no `time` metadata)
 *   produces a single frame with no meaningful `t`, so its name omits the
 *   segment entirely (`{sketchId}-seed{seed}.{ext}`). A time-driven Sketch
 *   captures the displayed moment, so its name carries it
 *   (`{sketchId}-seed{seed}-t{t}.{ext}`). The caller expresses that gate by
 *   supplying `t` only when `sketch.time` is present — an omitted `t` is the
 *   static case, not "t = 0".
 *
 * - The `-{variant}` segment is OPTIONAL and distinguishes sibling export
 *   pipelines that share the same `(sketchId, seed, t)` frame but differ in how
 *   the Scene was transformed before serialization (e.g. the Hidden-line SVG
 *   export tags its file `-hidden-line`). It appears IFF supplied, positioned
 *   AFTER the time segment; an omitted variant leaves the name byte-for-byte the
 *   plain-export name.
 */

import type { Seed } from './sketch'

/**
 * The reproduction coordinates a filename encodes — the determinism spine
 * (`sketchId` + `seed`) plus the OPTIONAL captured time.
 */
export interface ExportNameParts {
  /** The Sketch id slug (matches `SketchBase.id`). */
  sketchId: string
  /** The explicit {@link Seed} the frame was rendered from. */
  seed: Seed
  /**
   * The captured time in seconds. Supplied ONLY for a time-driven Sketch
   * (`sketch.time` present); OMIT it (or pass `undefined`) for a static Sketch so
   * the name carries no `-t{t}` segment. An absent value is the static case, NOT
   * `t = 0`. Explicit `undefined` is accepted so a caller can pass a computed
   * `time === undefined ? undefined : t` directly under `exactOptionalPropertyTypes`.
   */
  t?: number | undefined
  /**
   * An OPTIONAL variant tag distinguishing a sibling export pipeline over the
   * same frame (e.g. `'hidden-line'` for the occlusion-clipped SVG export). When
   * supplied it appends a `-{variant}` segment AFTER the time segment; when
   * omitted (or `undefined`) the name is byte-for-byte the plain-export name.
   * Explicit `undefined` is accepted under `exactOptionalPropertyTypes`.
   */
  variant?: string | undefined
}

/**
 * Build an export filename from a frame's reproduction coordinates.
 *
 * Shape: `{sketchId}-seed{seed}[-t{t}][-{variant}].{ext}`. The `-t{t}` segment
 * is present IFF `parts.t` is supplied (the time-driven case); a static Sketch
 * omits it. The `-{variant}` segment is present IFF `parts.variant` is supplied,
 * positioned AFTER the time segment; omitting it leaves the plain-export name
 * byte-for-byte unchanged. `ext` is a parameter so a single helper serves every
 * export path — `'png'` here, `'svg'` for the sibling export task — and is
 * appended verbatim (callers pass the bare extension, no leading dot).
 *
 * @param parts - The frame's `sketchId`, `seed`, optional captured `t`, and
 *   optional `variant` tag.
 * @param ext - The file extension WITHOUT a leading dot (e.g. `'png'`).
 * @returns The filename string.
 */
export function exportFilename(parts: ExportNameParts, ext: string): string {
  // Cap the captured time to a few decimals so a noisy float (e.g.
  // `2.5000000001`) does not bloat the name. Round, then re-`Number()` to trim
  // the trailing-zero padding `toFixed` adds, keeping `0` -> `0` and `1.5` ->
  // `1.5` byte-for-byte identical to the un-rounded values.
  const timeSegment =
    parts.t === undefined ? '' : `-t${Number(parts.t.toFixed(3))}`
  // The variant segment follows the time segment IFF supplied; an omitted
  // variant contributes nothing, so plain-export names stay unchanged.
  const variantSegment =
    parts.variant === undefined ? '' : `-${parts.variant}`
  return `${parts.sketchId}-seed${parts.seed}${timeSegment}${variantSegment}.${ext}`
}
