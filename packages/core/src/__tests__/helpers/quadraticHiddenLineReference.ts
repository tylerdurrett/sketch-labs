import {
  DEFAULT_STROKE,
  HIDDEN_LINE_WORK_WEIGHTS,
} from '../../hiddenLine'
import type {
  HiddenLineProgress,
  HiddenLineWorkload,
} from '../../hiddenLine'
import {
  preparePolygon,
  subtractPreparedPolygonsFromPolyline,
} from '../../polygonClip'
import type { PreparedPolygon } from '../../polygonClip'
import type { Primitive, Scene, Stroke } from '../../scene'
import { simplifyPath } from '../../simplifyPath'
import type { Point, Polyline } from '../../types'

interface Aabb {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface PlannedPrimitive {
  primitive: Primitive
  aabb: Aabb
  outline: Polyline
  source: boolean
  occluder: PreparedPolygon | null
  occluders: PreparedPolygon[]
}

export interface QuadraticHiddenLineReferenceResult {
  readonly scene: Scene
  readonly workload: HiddenLineWorkload
  /** Accepted overlapping pairs, as indices in the filtered execution plan. */
  readonly candidatePairs: ReadonlyArray<readonly [number, number]>
  readonly progress: readonly HiddenLineProgress[]
}

function safeAdd(a: number, b: number): number {
  return a > Number.MAX_SAFE_INTEGER - b ? Number.MAX_SAFE_INTEGER : a + b
}

function safeMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return a > Math.floor(Number.MAX_SAFE_INTEGER / b)
    ? Number.MAX_SAFE_INTEGER
    : a * b
}

function computeAabb(points: Polyline): Aabb | null {
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

function overlaps(a: Aabb, b: Aabb): boolean {
  return (
    a.minX <= b.maxX &&
    a.maxX >= b.minX &&
    a.minY <= b.maxY &&
    a.maxY >= b.minY
  )
}

function outlineRing(primitive: Primitive): Polyline {
  const ring: Polyline = primitive.points.map(([x, y]) => [x, y] as Point)
  if (primitive.closed && ring.length >= 2) {
    const first = ring[0]!
    const last = ring[ring.length - 1]!
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]])
    }
  }
  return ring
}

function roles(primitive: Primitive) {
  switch (primitive.hiddenLineRole) {
    case 'source':
      return { source: true, occluder: false }
    case 'occluder':
      return { source: false, occluder: primitive.fill !== undefined }
    case 'both':
      return { source: true, occluder: primitive.fill !== undefined }
    default: {
      const filled = primitive.fill !== undefined
      return { source: filled, occluder: filled }
    }
  }
}

/**
 * Test-only frozen quadratic reference for the Hidden-line planner and pass.
 *
 * This intentionally retains the former all-pairs broad phase. It is independent
 * of the visible-contour oracle and benchmark prototypes: differential tests use
 * it only to prove that spatial candidate enumeration preserves the production
 * planner's generic Scene contract.
 */
export function quadraticHiddenLineReference(
  scene: Scene,
  tolerance = 0,
): QuadraticHiddenLineReferenceResult {
  const planned: PlannedPrimitive[] = []
  let filledPrimitiveCount = 0
  let sourceSegmentCount = 0

  for (const primitive of scene.primitives) {
    const resolved = roles(primitive)
    if (!resolved.source && !resolved.occluder) continue
    const aabb = computeAabb(primitive.points)
    if (aabb === null) continue
    const outline = outlineRing(primitive)
    if (primitive.fill !== undefined) {
      filledPrimitiveCount = safeAdd(filledPrimitiveCount, 1)
    }
    if (resolved.source) {
      sourceSegmentCount = safeAdd(
        sourceSegmentCount,
        Math.max(0, outline.length - 1),
      )
    }
    planned.push({
      primitive,
      aabb,
      outline,
      source: resolved.source,
      occluder: resolved.occluder ? preparePolygon(primitive.points) : null,
      occluders: [],
    })
  }

  const candidatePairs: Array<readonly [number, number]> = []
  let estimatedSegmentEdgeComparisons = 0
  for (let sourceIndex = 0; sourceIndex < planned.length; sourceIndex++) {
    const source = planned[sourceIndex]!
    if (!source.source) continue
    const sourceSegments = Math.max(0, source.outline.length - 1)
    if (sourceSegments === 0) continue
    for (
      let occluderIndex = sourceIndex + 1;
      occluderIndex < planned.length;
      occluderIndex++
    ) {
      const other = planned[occluderIndex]!
      if (other.occluder === null || !overlaps(source.aabb, other.aabb)) {
        continue
      }
      source.occluders.push(other.occluder)
      candidatePairs.push(Object.freeze([sourceIndex, occluderIndex]))
      estimatedSegmentEdgeComparisons = safeAdd(
        estimatedSegmentEdgeComparisons,
        safeMultiply(sourceSegments, other.occluder.edges.length),
      )
    }
  }

  const workload = Object.freeze({
    filledPrimitiveCount,
    sourceSegmentCount,
    overlappingPairCount: candidatePairs.length,
    estimatedSegmentEdgeComparisons,
    totalWorkUnits: safeAdd(
      safeAdd(
        safeMultiply(
          filledPrimitiveCount,
          HIDDEN_LINE_WORK_WEIGHTS.filledPrimitive,
        ),
        safeMultiply(
          sourceSegmentCount,
          HIDDEN_LINE_WORK_WEIGHTS.sourceSegment,
        ),
      ),
      safeAdd(
        safeMultiply(
          candidatePairs.length,
          HIDDEN_LINE_WORK_WEIGHTS.overlappingPair,
        ),
        safeMultiply(
          estimatedSegmentEdgeComparisons,
          HIDDEN_LINE_WORK_WEIGHTS.segmentEdgeComparison,
        ),
      ),
    ),
  })

  const progress: HiddenLineProgress[] = []
  let completedWorkUnits = 0
  const out: Primitive[] = []
  for (let primitiveIndex = 0; primitiveIndex < planned.length; primitiveIndex++) {
    const self = planned[primitiveIndex]!
    const sourceSegments = self.source
      ? Math.max(0, self.outline.length - 1)
      : 0

    if (self.source && self.outline.length >= 2) {
      const survivors = subtractPreparedPolygonsFromPolyline(
        self.outline,
        self.occluders,
      )
      const stroke: Stroke = self.primitive.stroke
        ? { color: 'black', width: self.primitive.stroke.width }
        : DEFAULT_STROKE
      for (const survivor of survivors) {
        out.push({ points: simplifyPath(survivor, tolerance), stroke })
      }
    }

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
      workload.totalWorkUnits,
      safeAdd(completedWorkUnits, primitiveWorkUnits),
    )
    const terminal = primitiveIndex === planned.length - 1
    if (terminal) completedWorkUnits = workload.totalWorkUnits
    progress.push(
      Object.freeze({
        completedWorkUnits,
        totalWorkUnits: workload.totalWorkUnits,
        terminal,
      }),
    )
  }
  if (planned.length === 0) {
    progress.push(
      Object.freeze({
        completedWorkUnits: 0,
        totalWorkUnits: 0,
        terminal: true,
      }),
    )
  }

  return Object.freeze({
    scene: { space: scene.space, primitives: out },
    workload,
    candidatePairs: Object.freeze(candidatePairs),
    progress: Object.freeze(progress),
  })
}
