import { simplifyPath } from './simplifyPath'
import { UniformAabbGrid } from './aabbGrid'
import type { UniformAabbGridStats } from './aabbGrid'
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
 * Roles
 * -----
 * Legacy Scenes need no annotation: every filled Primitive is both an outline
 * source and an occluder, while stroke-only inputs are ignored. A Primitive's
 * optional `hiddenLineRole` can instead identify a stroke path as a source or a
 * filled polygon as a non-emitted occluder. The pass remains domain-neutral;
 * roles describe geometry-processing intent, not what the geometry represents.
 *
 * Algorithm
 * ---------
 * The Scene's `primitives` are in painter's order: index 0 is drawn first
 * (bottom / farthest), the last element last (top / nearest). For each legacy
 * filled Primitive, or each explicitly tagged source:
 *   1. Its `points` ring is the outline to draw. If the Primitive is `closed`
 *      but its points do not repeat the first vertex, the closing edge is added
 *      so the FULL boundary ring is drawn (see "Ring closure" below).
 *   2. Broad-phase: query an exact uniform AABB grid for occluder Primitives
 *      drawn AFTER it (higher index = nearer), restoring painter order before
 *      accepting candidates. Finite, bounded geometry takes the spatial path;
 *      oversized or non-finite bounds stay conservative through the grid's
 *      overflow path and the same final AABB-overlap predicate.
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
 * (c) LEGACY STROKE-ONLY INPUTS — Primitives with no `fill` and no explicit
 *     `hiddenLineRole` are IGNORED entirely, preserving issue #210 behaviour.
 *     An explicitly tagged stroke-only `source` is emitted and clipped, but can
 *     never occlude because it has no filled interior.
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
  /** Filled, non-empty source and/or occluder Primitives accepted by the pass. */
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
  outline: Polyline
  source: boolean
  occluder: PreparedPolygon | null
  occluders: PreparedPolygon[]
}

interface HiddenLinePlan {
  planned: PlannedPrimitive[]
  workload: HiddenLineWorkload
  broadPhase: HiddenLineBroadPhaseStats
}

/** Spatial-planning evidence from the exact plan used by Hidden-line. */
export interface HiddenLineBroadPhaseStats {
  /** Sources with at least one segment that participate in broad-phase queries. */
  readonly queriedSourceCount: number
  /** Prepared filled polygons available to occlude a farther source. */
  readonly occluderCount: number
  /** Source/nearer-occluder pairs a quadratic painter scan would inspect. */
  readonly eligiblePainterPairCount: number
  /** Painter-eligible pairs returned by the spatial index before final overlap. */
  readonly enumeratedCandidatePairCount: number
  /** Candidates accepted by the unchanged inclusive AABB overlap predicate. */
  readonly trueOverlappingPairCount: number
  /** Deterministically selected square-cell size in Scene units. */
  readonly cellSize: number
  /** Index construction evidence, including conservative overflow counts. */
  readonly index: UniformAabbGridStats
}

/** Exact workload plus additive evidence about how its candidates were found. */
export interface HiddenLinePlanAnalysis {
  readonly workload: HiddenLineWorkload
  readonly broadPhase: HiddenLineBroadPhaseStats
}

/** Immutable, serialization-friendly progress reported by the Hidden-line pass. */
export interface HiddenLineProgress {
  /** Weighted work completed so far. Always between zero and `totalWorkUnits`. */
  readonly completedWorkUnits: number
  /** Stable weighted total from the exact plan being executed. */
  readonly totalWorkUnits: number
  /** True only for the final snapshot. */
  readonly terminal: boolean
}

/** Optional observation hook for coarse Hidden-line progress snapshots. */
export type HiddenLineObserver = (progress: HiddenLineProgress) => void

/** Options for {@link hiddenLinePass}. */
export interface HiddenLinePassOptions {
  /** Final-stage Douglas–Peucker simplification tolerance (default 0). */
  readonly tolerance?: number
  /** Receives immutable progress snapshots at participating-Primitive boundaries. */
  readonly observer?: HiddenLineObserver
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
 * Return the outline path to draw for a source Primitive. The `points` are
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

/** Resolve explicit processing intent while retaining the legacy fill rules. */
function hiddenLineRoles(primitive: Primitive): {
  source: boolean
  occluder: boolean
} {
  switch (primitive.hiddenLineRole) {
    case 'source':
      return { source: true, occluder: false }
    case 'occluder':
      return { source: false, occluder: primitive.fill !== undefined }
    case 'both':
      return { source: true, occluder: primitive.fill !== undefined }
    default: {
      const legacyFilled = primitive.fill !== undefined
      return { source: legacyFilled, occluder: legacyFilled }
    }
  }
}

const HIDDEN_LINE_MAX_CELLS_PER_AABB = 4096

/** Pick a deterministic finite cell size without assuming ordinary Scene bounds. */
function hiddenLineCellSize(scene: Scene, planned: readonly PlannedPrimitive[]) {
  const sceneSpan = Math.max(scene.space.width, scene.space.height)
  let span = Number.isFinite(sceneSpan) && sceneSpan > 0 ? sceneSpan : 0
  if (span === 0) {
    for (const { aabb } of planned) {
      const width = aabb.maxX - aabb.minX
      const height = aabb.maxY - aabb.minY
      if (Number.isFinite(width) && width > span) span = width
      if (Number.isFinite(height) && height > span) span = height
    }
  }
  if (!Number.isFinite(span) || span <= 0) span = 1
  const cellSize = span / Math.max(1, Math.ceil(Math.sqrt(planned.length)))
  return Number.isFinite(cellSize) && cellSize > 0 ? cellSize : span
}

/** Build the single deterministic inventory/execution plan used by the pass. */
function createHiddenLinePlan(scene: Scene): HiddenLinePlan {
  const planned: PlannedPrimitive[] = []
  let filledPrimitiveCount = 0
  let sourceSegmentCount = 0

  for (const primitive of scene.primitives) {
    const roles = hiddenLineRoles(primitive)
    if (!roles.source && !roles.occluder) continue
    const aabb = computeAABB(primitive.points)
    if (aabb === null) continue
    const outline = outlineRing(primitive)
    if (primitive.fill !== undefined) {
      filledPrimitiveCount = safeAdd(filledPrimitiveCount, 1)
    }
    if (roles.source) {
      sourceSegmentCount = safeAdd(
        sourceSegmentCount,
        Math.max(0, outline.length - 1),
      )
    }
    planned.push({
      primitive,
      aabb,
      outline,
      source: roles.source,
      occluder: roles.occluder ? preparePolygon(primitive.points) : null,
      occluders: [],
    })
  }

  const occluderEntries: Array<{
    plannedIndex: number
    aabb: AABB
  }> = []
  for (let plannedIndex = 0; plannedIndex < planned.length; plannedIndex++) {
    const item = planned[plannedIndex]!
    if (item.occluder !== null) {
      occluderEntries.push({ plannedIndex, aabb: item.aabb })
    }
  }
  const cellSize = hiddenLineCellSize(scene, planned)
  const index = new UniformAabbGrid(
    occluderEntries.map(({ aabb }) => aabb),
    { cellSize, maxCellsPerAabb: HIDDEN_LINE_MAX_CELLS_PER_AABB },
  )

  const nearerOccluderCounts = new Array<number>(planned.length).fill(0)
  let nearerOccluderCount = 0
  for (let plannedIndex = planned.length - 1; plannedIndex >= 0; plannedIndex--) {
    nearerOccluderCounts[plannedIndex] = nearerOccluderCount
    if (planned[plannedIndex]!.occluder !== null) nearerOccluderCount++
  }

  let queriedSourceCount = 0
  let eligiblePainterPairCount = 0
  let enumeratedCandidatePairCount = 0
  let overlappingPairCount = 0
  let estimatedSegmentEdgeComparisons = 0
  for (let f = 0; f < planned.length; f++) {
    const self = planned[f]!
    if (!self.source) continue
    const sourceSegments = Math.max(0, self.outline.length - 1)
    if (sourceSegments === 0) continue
    queriedSourceCount = safeAdd(queriedSourceCount, 1)
    eligiblePainterPairCount = safeAdd(
      eligiblePainterPairCount,
      nearerOccluderCounts[f]!,
    )
    for (const occluderIndex of index.query(self.aabb)) {
      const entry = occluderEntries[occluderIndex]!
      if (entry.plannedIndex <= f) continue
      enumeratedCandidatePairCount = safeAdd(
        enumeratedCandidatePairCount,
        1,
      )
      const other = planned[entry.plannedIndex]!
      if (!aabbOverlap(self.aabb, other.aabb)) continue
      const occluder = other.occluder
      if (occluder === null) continue
      self.occluders.push(occluder)
      overlappingPairCount = safeAdd(overlappingPairCount, 1)
      estimatedSegmentEdgeComparisons = safeAdd(
        estimatedSegmentEdgeComparisons,
        safeMultiply(sourceSegments, occluder.edges.length),
      )
    }
  }

  const weightedFilled = safeMultiply(
    filledPrimitiveCount,
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
    filledPrimitiveCount,
    sourceSegmentCount,
    overlappingPairCount,
    estimatedSegmentEdgeComparisons,
    totalWorkUnits,
  })
  const broadPhase = Object.freeze({
    queriedSourceCount,
    occluderCount: occluderEntries.length,
    eligiblePainterPairCount,
    enumeratedCandidatePairCount,
    trueOverlappingPairCount: overlappingPairCount,
    cellSize,
    index: index.stats,
  })

  return { planned, workload, broadPhase }
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
 * Analyze the exact Hidden-line plan, including additive spatial-index evidence.
 *
 * `eligiblePainterPairCount` is the quadratic search space avoided by the
 * planner. `enumeratedCandidatePairCount` is the conservative spatial result,
 * while `trueOverlappingPairCount` is the unchanged broad-phase acceptance
 * count used by the workload and execution plan. Finite adopted fixtures should
 * have no index overflow; malformed, non-finite, or extremely large geometry is
 * retained conservatively and is visible in `broadPhase.index`.
 */
export function analyzeHiddenLinePlan(scene: Scene): HiddenLinePlanAnalysis {
  const { workload, broadPhase } = createHiddenLinePlan(scene)
  return Object.freeze({ workload, broadPhase })
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
 *   output stays byte-identical to an un-simplified pass. `observer` receives
 *   frozen progress snapshots at coarse participating-Primitive boundaries; no
 *   callbacks run in the segment-edge clipping loop.
 * @returns A NEW background-free, stroke-only Scene sharing `scene.space`: the
 *   occlusion-clipped outlines of legacy filled and explicitly tagged source
 *   Primitives, emitted as black, fill-free OPEN Primitives, each preserving
 *   its source width and simplified at `opts.tolerance`. Occluder-only
 *   Primitives are never emitted.
 */
export function hiddenLinePass(
  scene: Scene,
  opts?: HiddenLinePassOptions,
): Scene {
  const tolerance = opts?.tolerance ?? 0
  const plan = createHiddenLinePlan(scene)
  const observer = opts?.observer
  const totalWorkUnits = plan.workload.totalWorkUnits
  let completedWorkUnits = 0

  const reportProgress = (terminal: boolean) => {
    observer?.(
      Object.freeze({ completedWorkUnits, totalWorkUnits, terminal }),
    )
  }

  const completePrimitive = (
    self: PlannedPrimitive,
    primitiveIndex: number,
  ) => {
    if (!observer) return

    const sourceSegments = self.source
      ? Math.max(0, self.outline.length - 1)
      : 0
    let primitiveWorkUnits = self.primitive.fill
      ? HIDDEN_LINE_WORK_WEIGHTS.filledPrimitive
      : 0
    primitiveWorkUnits = safeAdd(
      primitiveWorkUnits,
      safeMultiply(sourceSegments, HIDDEN_LINE_WORK_WEIGHTS.sourceSegment),
    )
    primitiveWorkUnits = safeAdd(
      primitiveWorkUnits,
      safeMultiply(
        self.occluders.length,
        HIDDEN_LINE_WORK_WEIGHTS.overlappingPair,
      ),
    )
    for (const occluder of self.occluders) {
      primitiveWorkUnits = safeAdd(
        primitiveWorkUnits,
        safeMultiply(
          safeMultiply(sourceSegments, occluder.edges.length),
          HIDDEN_LINE_WORK_WEIGHTS.segmentEdgeComparison,
        ),
      )
    }
    completedWorkUnits = Math.min(
      totalWorkUnits,
      safeAdd(completedWorkUnits, primitiveWorkUnits),
    )
    const terminal = primitiveIndex === plan.planned.length - 1
    if (terminal) completedWorkUnits = totalWorkUnits
    reportProgress(terminal)
  }

  const out: Primitive[] = []

  for (
    let primitiveIndex = 0;
    primitiveIndex < plan.planned.length;
    primitiveIndex++
  ) {
    const self = plan.planned[primitiveIndex]!
    const { outline } = self
    if (!self.source || outline.length < 2) {
      completePrimitive(self, primitiveIndex)
      continue
    }

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

    completePrimitive(self, primitiveIndex)
  }

  // Empty Scenes still have an observable terminal state.
  if (plan.planned.length === 0) reportProgress(true)

  return { space: scene.space, primitives: out }
}
