import { simplifyPath } from './simplifyPath'
import {
  preparePolygon,
  subtractPreparedPolygonsFromPolyline,
} from './polygonClip'
import type { PreparedPolygon } from './polygonClip'
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
 * (a) OUTPUT STROKE — every survivor is black for clean monochrome plotter
 *     output. Its width comes from the SOURCE Primitive's own `stroke` when
 *     present; a filled Primitive with no `stroke` falls back to
 *     {@link DEFAULT_STROKE} (thin black), because a fill-only Primitive still
 *     has a boundary the plotter must draw and a stroke-only output Primitive
 *     without a stroke would be invisible/degenerate.
 *
 * (b) BACKGROUND — the input Scene's authored `background` is DROPPED. The
 *     result is clean plotter geometry rather than a styled preview surface;
 *     callers and renderers remain responsible for any presentation backdrop.
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

/**
 * Fixed coefficients for the deterministic Hidden-line workload heuristic.
 *
 * These are deliberately unitless: elapsed time is learned from observed work
 * throughput, not predicted here. Keep them stable so benchmark measurements
 * and progress totals remain comparable between runs.
 */
export const HIDDEN_LINE_WORK_WEIGHTS = Object.freeze({
  filledPrimitive: 8,
  sourceSegment: 4,
  overlappingPair: 16,
  segmentEdgeComparison: 1,
} as const)

/** Deterministic inventory of the geometry work a Hidden-line pass will do. */
export interface HiddenLineWorkload {
  /** Filled, non-empty Primitives accepted by the pass. */
  readonly filledPrimitiveCount: number
  /** Consecutive source-outline segments, including implicit closing segments. */
  readonly sourceSegmentCount: number
  /** Painter-ordered nearer/farther AABB pairs accepted by the broad phase. */
  readonly overlappingPairCount: number
  /** Source segments × prepared occluder edges for every overlapping pair. */
  readonly estimatedSegmentEdgeComparisons: number
  /** Fixed weighted sum of the four inventory counts above. */
  readonly totalWorkUnits: number
}

interface PlannedPrimitive {
  primitive: Primitive
  aabb: AABB
  polygon: PreparedPolygon
  outline: Polyline
  occluders: PreparedPolygon[]
}

interface HiddenLinePlan {
  filled: PlannedPrimitive[]
  workload: HiddenLineWorkload
}

/** Add non-negative integers, saturating before precision would be lost. */
function safeAdd(a: number, b: number): number {
  return a > Number.MAX_SAFE_INTEGER - b ? Number.MAX_SAFE_INTEGER : a + b
}

/** Multiply non-negative integers, saturating before precision would be lost. */
function safeMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return a > Math.floor(Number.MAX_SAFE_INTEGER / b)
    ? Number.MAX_SAFE_INTEGER
    : a * b
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

/** Build the single deterministic inventory/execution plan used by the pass. */
function createHiddenLinePlan(scene: Scene): HiddenLinePlan {
  const filled: PlannedPrimitive[] = []
  let sourceSegmentCount = 0

  for (const primitive of scene.primitives) {
    if (!primitive.fill) continue // decision (c): stroke-only inputs ignored
    const aabb = computeAABB(primitive.points)
    if (aabb === null) continue
    const outline = outlineRing(primitive)
    sourceSegmentCount = safeAdd(
      sourceSegmentCount,
      Math.max(0, outline.length - 1),
    )
    filled.push({
      primitive,
      aabb,
      polygon: preparePolygon(primitive.points),
      outline,
      occluders: [],
    })
  }

  let overlappingPairCount = 0
  let estimatedSegmentEdgeComparisons = 0
  for (let f = 0; f < filled.length; f++) {
    const self = filled[f]!
    const sourceSegments = Math.max(0, self.outline.length - 1)
    if (sourceSegments === 0) continue
    for (let g = f + 1; g < filled.length; g++) {
      const other = filled[g]!
      if (!aabbOverlap(self.aabb, other.aabb)) continue
      self.occluders.push(other.polygon)
      overlappingPairCount = safeAdd(overlappingPairCount, 1)
      estimatedSegmentEdgeComparisons = safeAdd(
        estimatedSegmentEdgeComparisons,
        safeMultiply(sourceSegments, other.polygon.edges.length),
      )
    }
  }

  const weightedFilled = safeMultiply(
    filled.length,
    HIDDEN_LINE_WORK_WEIGHTS.filledPrimitive,
  )
  const weightedSegments = safeMultiply(
    sourceSegmentCount,
    HIDDEN_LINE_WORK_WEIGHTS.sourceSegment,
  )
  const weightedPairs = safeMultiply(
    overlappingPairCount,
    HIDDEN_LINE_WORK_WEIGHTS.overlappingPair,
  )
  const weightedComparisons = safeMultiply(
    estimatedSegmentEdgeComparisons,
    HIDDEN_LINE_WORK_WEIGHTS.segmentEdgeComparison,
  )
  const totalWorkUnits = safeAdd(
    safeAdd(weightedFilled, weightedSegments),
    safeAdd(weightedPairs, weightedComparisons),
  )
  const workload = Object.freeze({
    filledPrimitiveCount: filled.length,
    sourceSegmentCount,
    overlappingPairCount,
    estimatedSegmentEdgeComparisons,
    totalWorkUnits,
  })

  return { filled, workload }
}

/**
 * Analyze a Scene using the exact filtering, closure, painter order, and AABB
 * broad-phase rules used by {@link hiddenLinePass}. The returned summary is
 * frozen and all fields are safe integers; exceptionally large derived counts
 * saturate at `Number.MAX_SAFE_INTEGER` rather than losing integer precision.
 */
export function analyzeHiddenLineWorkload(scene: Scene): HiddenLineWorkload {
  return createHiddenLinePlan(scene).workload
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
 * @returns A NEW background-free, stroke-only Scene sharing `scene.space`: the
 *   occlusion-clipped outlines of the input's filled Primitives, emitted as
 *   black, fill-free OPEN Primitives, each preserving its source width and
 *   simplified at `opts.tolerance`.
 */
export function hiddenLinePass(
  scene: Scene,
  opts?: { tolerance?: number },
): Scene {
  const tolerance = opts?.tolerance ?? 0
  const plan = createHiddenLinePlan(scene)

  const out: Primitive[] = []

  for (const self of plan.filled) {
    const { outline } = self
    if (outline.length < 2) continue

    const survivors = subtractPreparedPolygonsFromPolyline(
      outline,
      self.occluders,
    )
    const stroke: Stroke = self.primitive.stroke
      ? { color: 'black', width: self.primitive.stroke.width }
      : DEFAULT_STROKE
    for (const survivor of survivors) {
      // FINAL stage: Douglas–Peucker simplification at the requested tolerance.
      // At tolerance 0 this is an identity no-op (same array reference), so the
      // pass output stays byte-identical to an un-simplified run.
      out.push({ points: simplifyPath(survivor, tolerance), stroke })
    }
  }

  return { space: scene.space, primitives: out }
}
