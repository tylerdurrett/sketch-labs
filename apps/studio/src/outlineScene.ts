import {
  hiddenLinePass,
  type CoordinateSpace,
  type Params,
  type Scene,
  type Seed,
  type Sketch,
} from "@harness/core";

/**
 * The SINGLE preview == export seam (issue #220, feature #4).
 *
 * The outline-mode canvas preview ({@link LiveCanvas}) and the hidden-line SVG
 * export ({@link SketchControls.exportHiddenLineSvg}) must render the IDENTICAL
 * processed Scene for the same `(params, seed, t)` — that is the whole promise of
 * feature #4 ("what you see is what you plot"). Before this seam existed each
 * consumer ran its OWN `sketch.generate(...) → hiddenLinePass(...)` pair, two
 * independent derivations that could silently drift (a param tweak, a pass
 * argument, a reordering on one side only). Collapsing both to this one pure
 * function makes preview == export true BY CONSTRUCTION: there is exactly one
 * place the processed Scene is derived, so the two paths cannot diverge.
 *
 * It is a pure `(params, seed, t, frame, tolerance) → Scene` function —
 * `generate` then the Hidden-line pass, nothing else — so it is trivially
 * unit-testable and lets
 * a test lock the export path to the same expression the preview evaluates. The
 * `tolerance` (default 0, i.e. no simplification) is the studio's single knob
 * value forwarded into the pass's final Douglas–Peucker stage; routing it
 * through this one seam keeps preview and export simplified IDENTICALLY.
 *
 * On-demand only (feature #4 / issue #219 invariant): the Hidden-line pass is
 * expensive, so this seam is invoked ONLY from the static/on-demand redraw path
 * and the export click handler — NEVER inside LiveCanvas's live rAF fill loop,
 * which stays `fill`-only and calls `sketch.generate` directly.
 *
 * Slice-local rationale lives here (not an ADR) per ADR-0007.
 */
export function outlineScene(
  sketch: Sketch,
  params: Params,
  seed: Seed,
  t: number,
  compositionFrame: CoordinateSpace,
  tolerance = 0,
): Scene {
  return hiddenLinePass(sketch.generate(params, seed, t, compositionFrame), {
    tolerance,
  });
}
