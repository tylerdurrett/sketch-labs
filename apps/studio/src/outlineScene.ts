import { hiddenLinePass, type Scene } from "@harness/core";

/**
 * The SINGLE preview == export seam (issue #220, feature #4).
 *
 * The outline-mode canvas preview ({@link LiveCanvas}) and the hidden-line SVG
 * export ({@link SketchControls.exportHiddenLineSvg}) must apply the IDENTICAL
 * processing to their input Scene — that is the whole promise of
 * feature #4 ("what you see is what you plot"). Before this seam existed each
 * consumer ran its OWN Hidden-line invocation, two independent processing seams
 * that could silently drift (a pass argument or reordering on one side only).
 * Collapsing both to this one pure function makes preview == export processing
 * true BY CONSTRUCTION: there is exactly one place the input Scene is reduced.
 *
 * It is a pure `(Scene, tolerance) → Scene` function — the Hidden-line pass and
 * nothing else — so it is trivially unit-testable. Scene sampling deliberately
 * stays caller-owned: LiveCanvas supplies its retained ADR-0012 prepared sample,
 * avoiding a redundant cold `generate`, while one-shot export may generate its
 * Scene cold. The `tolerance` (default 0, i.e. no simplification) is the studio's
 * single knob value forwarded into the pass's final Douglas–Peucker stage;
 * routing it through this one seam keeps preview and export simplified
 * IDENTICALLY.
 *
 * On-demand only (feature #4 / issue #219 invariant): the Hidden-line pass is
 * expensive, so this seam is invoked ONLY from the static/on-demand redraw path
 * and the export click handler — NEVER inside LiveCanvas's live rAF fill loop.
 *
 * Slice-local rationale lives here (not an ADR) per ADR-0007.
 */
export function outlineScene(scene: Scene, tolerance = 0): Scene {
  return hiddenLinePass(scene, { tolerance });
}
