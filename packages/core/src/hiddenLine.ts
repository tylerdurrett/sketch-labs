import { simplifyPath } from './simplifyPath'
import { subtractPolygonsFromPolyline } from './polygonClip'
import type { Scene, Primitive, Stroke } from './scene'
import type { Point, Polyline } from './types'

/**
 * The Hidden-line pass: a pure `Scene → Scene` transform that removes outline
 * geometry occluded by nearer Primitive fills (painter's order) and returns a
 * stroke-only Scene of occlusion-clipped open polylines (ADR-0011, CONTEXT.md
 * "Hidden-line pass").
 *
 * It is NOT a Scene Renderer: it consumes a Scene and emits ANOTHER Scene, which
 * the existing Canvas2D/SVG renderers then draw unchanged. This framing is what
 * makes Outline-mode preview and plotter export render the same processed Scene
 * through the same two renderers (preview == export by construction), and lets
 * the pass be tested as pure geometry with no serializer/canvas in the loop.
 *
 * Algorithm
 * ---------
 * The Scene's `primitives` are in painter's order: index 0 is drawn first
 * (bottom / farthest), the last element last (top / nearest). For each FILLED
 * Primitive:
 *   1. Its `points` ring is the outline to draw. If the Primitive is `closed`
 *      but its points do not repeat the first vertex, the closing edge is added
 *      so the FULL boundary ring is drawn (see "Ring closure" below).
 *   2. Broad-phase: find the filled Primitives drawn AFTER it (higher index =
 *      nearer) whose axis-aligned bounding box overlaps this outline's AABB.
 *      This is a plain per-Primitive AABB-overlap test — deliberately NO spatial
 *      index (out of scope for this pass; issue #210).
 *   3. Subtract the union of those nearer fill polygons from the outline via
 *      {@link subtractPolygonsFromPolyline} (the #209 arbitrary-polygon clip,
 *      correct for concave occluders like a leaf silhouette).
 *   4. Emit the surviving sub-polylines as stroke-only, fill-free OPEN
 *      Primitives into a new Scene sharing the input's `space`.
 *
 * The result is a stroke-only Scene: an outline fully behind a nearer fill is
 * absent; one fully in front survives intact; a partially occluded outline is
 * clipped at the fill boundary.
 *
 * This module is domain-agnostic: it is not leaf-aware and computes its own AABB
 * from each Primitive's points (the `bbox`/`BBox` helpers in `sketches/` are
 * sketch-internal and not exported, so the pass does not depend on them).
 *
 * The pass is ON-DEMAND ONLY. The core invariant (CONTEXT.md) keeps expensive,
 * export-only work out of the live `generate → draw → painter's render` loop, so
 * nothing in that loop calls this — Outline mode and export invoke it explicitly.
 *
 * Local decisions (per ADR-0007 these are pass-local rationale, not an ADR)
 * -----------------------------------------------------------------------
 * (a) OUTPUT STROKE — each survivor reuses the SOURCE Primitive's own `stroke`
 *     when it has one, so an authored outline color/width carries through to the
 *     plotter line. A filled Primitive with no `stroke` falls back to
 *     {@link DEFAULT_STROKE} (thin black), because a fill-only Primitive still
 *     has a boundary the plotter must draw and a stroke-only output Primitive
 *     without a stroke would be invisible/degenerate.
 *
 * (b) BACKGROUND — the input Scene's `background` is CARRIED into the output
 *     Scene (when present). Outline mode shows the plotter result in place of the
 *     fill preview, and preserving the Scene-declared backdrop keeps that view's
 *     framing identical to the fill preview and the eventual export; the pass
 *     only removes occluded strokes, it does not restyle the surface. A
 *     background-less input yields a background-less output (no explicit
 *     `undefined` field), so the Scene stays byte-identical in that common case.
 *
 * (c) STROKE-ONLY INPUTS — Primitives with no `fill` are IGNORED entirely:
 *     neither drawn as an outline nor treated as occluders. The pass is defined
 *     over FILLED geometry (issue #210) — a fill is what occludes what is behind
 *     it in painter's order, and a fill boundary is the outline the plotter
 *     draws. A stroke-only Primitive occludes nothing (no interior) and is not a
 *     derived fill boundary, so it has no role here and is dropped rather than
 *     passed through unclipped.
 */

/**
 * Fallback stroke for a filled Primitive that carries no `stroke` of its own
 * (local decision (a)). Thin black — a visible plotter line in the Scene's
 * coordinate-space units.
 */
export const DEFAULT_STROKE: Stroke = { color: 'black', width: 1 }

/** Axis-aligned bounding box, in the Scene's coordinate-space units. */
interface AABB {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Compute a Primitive's AABB from its points; null for empty geometry. */
function computeAABB(points: Polyline): AABB | null {
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

/** Standard AABB-overlap predicate (touching edges count as overlapping). */
function aabbOverlap(a: AABB, b: AABB): boolean {
  return (
    a.minX <= b.maxX &&
    a.maxX >= b.minX &&
    a.minY <= b.maxY &&
    a.maxY >= b.minY
  )
}

/**
 * Return the outline ring to draw for a filled Primitive. The `points` are
 * copied (inputs are never mutated); when the Primitive is `closed` and its
 * points do not already repeat the first vertex, the closing edge back to the
 * start is appended so the FULL boundary ring is drawn and clipped — otherwise
 * `subtractPolygonsFromPolyline` (which walks consecutive points, no wrap) would
 * silently drop the final edge.
 */
function outlineRing(primitive: Primitive): Polyline {
  const ring: Polyline = primitive.points.map((p) => [p[0], p[1]] as Point)
  if (primitive.closed && ring.length >= 2) {
    const first = ring[0]!
    const last = ring[ring.length - 1]!
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]])
    }
  }
  return ring
}

/**
 * Run the Hidden-line pass over a Scene.
 *
 * @param scene - The Scene to reduce. Its `primitives` are read in painter's
 *   order (index 0 = farthest, last = nearest). Inputs are never mutated.
 * @param opts - Optional pass options. `tolerance` (default 0) is the
 *   Douglas–Peucker distance passed to {@link simplifyPath} on each surviving
 *   stroke as the FINAL stage — the studio's tolerance knob feeds this so
 *   Outline-mode preview and hidden-line SVG export simplify identically. A
 *   tolerance of 0 is an identity no-op (survivors pass through unchanged), so
 *   output stays byte-identical to an un-simplified pass.
 * @returns A NEW stroke-only Scene sharing `scene.space` (and carrying
 *   `scene.background` when present): the occlusion-clipped outlines of the
 *   input's filled Primitives, emitted as fill-free OPEN Primitives, each
 *   simplified at `opts.tolerance`.
 */
export function hiddenLinePass(
  scene: Scene,
  opts?: { tolerance?: number },
): Scene {
  const tolerance = opts?.tolerance ?? 0
  const { primitives } = scene

  // Precompute each filled Primitive's index and AABB for the broad-phase.
  const filled: { index: number; primitive: Primitive; aabb: AABB }[] = []
  for (let i = 0; i < primitives.length; i++) {
    const primitive = primitives[i]!
    if (!primitive.fill) continue // decision (c): stroke-only inputs ignored
    const aabb = computeAABB(primitive.points)
    if (aabb === null) continue
    filled.push({ index: i, primitive, aabb })
  }

  const out: Primitive[] = []

  for (let f = 0; f < filled.length; f++) {
    const self = filled[f]!
    const outline = outlineRing(self.primitive)
    if (outline.length < 2) continue

    // Broad-phase: nearer (higher-index) filled Primitives whose AABB overlaps.
    const occluders: Polyline[] = []
    for (let g = f + 1; g < filled.length; g++) {
      const other = filled[g]!
      if (aabbOverlap(self.aabb, other.aabb)) {
        occluders.push(other.primitive.points)
      }
    }

    const survivors = subtractPolygonsFromPolyline(outline, occluders)
    const stroke = self.primitive.stroke ?? DEFAULT_STROKE
    for (const survivor of survivors) {
      // FINAL stage: Douglas–Peucker simplification at the requested tolerance.
      // At tolerance 0 this is an identity no-op (same array reference), so the
      // pass output stays byte-identical to an un-simplified run.
      out.push({ points: simplifyPath(survivor, tolerance), stroke })
    }
  }

  return scene.background === undefined
    ? { space: scene.space, primitives: out }
    : { space: scene.space, primitives: out, background: scene.background }
}
