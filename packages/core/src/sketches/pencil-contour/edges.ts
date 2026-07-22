/**
 * Deterministic edge localization for Pencil Contour.
 *
 * Luminance and alpha deliberately remain separate signals. Luminance edges
 * are admitted only between two positively supported samples. Alpha boundaries
 * are interpolated at one private isovalue by marching squares, without
 * inventing samples beyond the analyzed raster. This means a flat opaque image
 * has no fitted perimeter while a real internal alpha transition remains
 * available to tracing.
 */

import type { Point } from '../../types'
import type {
  AnalyzedRaster,
  EdgeProvenance,
  LocalizedEdge,
  LocalizedEdgeGraph,
} from './types'

// A stable half-coverage boundary represents meaningful continuous opacity;
// exact alpha > 0 remains the separate permission policy in positiveSupport.
const ALPHA_BOUNDARY_ISOVALUE = 0.5
const MIN_LUMINANCE_EDGE_STRENGTH = 0.03
const MAX_LUMINANCE_EDGE_STRENGTH = 0.3
const MAX_SELECTION_FRACTION = 0.5

const LUMINANCE_PROVENANCE: Readonly<EdgeProvenance> = Object.freeze({
  kind: 'luminance',
})
const ALPHA_BOUNDARY_PROVENANCE: Readonly<EdgeProvenance> = Object.freeze({
  kind: 'alpha-boundary',
})

interface LuminanceCandidate {
  readonly edge: Readonly<LocalizedEdge>
  readonly strength: number
  readonly order: number
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

function rasterIndex(width: number, x: number, y: number): number {
  return y * width + x
}

function freezePoint(x: number, y: number): Readonly<Point> {
  return Object.freeze([x, y] as Point)
}

function freezeEdge(
  start: Readonly<Point>,
  end: Readonly<Point>,
  provenance: Readonly<EdgeProvenance>,
): Readonly<LocalizedEdge> {
  return Object.freeze({ start, end, provenance })
}

function supportedDifference(
  raster: Readonly<AnalyzedRaster>,
  firstIndex: number,
  secondIndex: number,
): number {
  if (
    raster.positiveSupport[firstIndex] !== true ||
    raster.positiveSupport[secondIndex] !== true
  ) {
    return 0
  }
  return Math.abs(
    (raster.luminance[secondIndex] ?? 0) -
      (raster.luminance[firstIndex] ?? 0),
  )
}

function horizontalDifference(
  raster: Readonly<AnalyzedRaster>,
  x: number,
  y: number,
): number {
  return supportedDifference(
    raster,
    rasterIndex(raster.width, x, y),
    rasterIndex(raster.width, x + 1, y),
  )
}

function verticalDifference(
  raster: Readonly<AnalyzedRaster>,
  x: number,
  y: number,
): number {
  return supportedDifference(
    raster,
    rasterIndex(raster.width, x, y),
    rasterIndex(raster.width, x, y + 1),
  )
}

/**
 * Keep one deterministic representative from a flat response plateau.
 *
 * Missing neighbours are not treated as zero-strength samples: source edges
 * simply have one fewer comparison. Ties keep the later pair in scan order.
 */
function isSuppressed(
  strength: number,
  previousStrength: number | undefined,
  nextStrength: number | undefined,
): boolean {
  if (previousStrength !== undefined && strength < previousStrength) return true
  if (nextStrength !== undefined && strength <= nextStrength) return true
  return false
}

function luminanceCandidates(
  raster: Readonly<AnalyzedRaster>,
): readonly LuminanceCandidate[] {
  const candidates: LuminanceCandidate[] = []
  let order = 0

  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x + 1 < raster.width; x += 1) {
      const strength = horizontalDifference(raster, x, y)
      const previous =
        x > 0 ? horizontalDifference(raster, x - 1, y) : undefined
      const next =
        x + 2 < raster.width
          ? horizontalDifference(raster, x + 1, y)
          : undefined

      if (strength > 0 && !isSuppressed(strength, previous, next)) {
        const edgeX = x + 0.5
        candidates.push({
          edge: freezeEdge(
            freezePoint(edgeX, Math.max(0, y - 0.5)),
            freezePoint(edgeX, Math.min(raster.height - 1, y + 0.5)),
            LUMINANCE_PROVENANCE,
          ),
          strength,
          order,
        })
      }
      order += 1
    }
  }

  for (let y = 0; y + 1 < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const strength = verticalDifference(raster, x, y)
      const previous =
        y > 0 ? verticalDifference(raster, x, y - 1) : undefined
      const next =
        y + 2 < raster.height
          ? verticalDifference(raster, x, y + 1)
          : undefined

      if (strength > 0 && !isSuppressed(strength, previous, next)) {
        const edgeY = y + 0.5
        candidates.push({
          edge: freezeEdge(
            freezePoint(Math.max(0, x - 0.5), edgeY),
            freezePoint(Math.min(raster.width - 1, x + 0.5), edgeY),
            LUMINANCE_PROVENANCE,
          ),
          strength,
          order,
        })
      }
      order += 1
    }
  }

  return candidates
}

function selectLuminanceEdges(
  raster: Readonly<AnalyzedRaster>,
  contourDetail: number,
): readonly Readonly<LocalizedEdge>[] {
  const detail = clampUnit(contourDetail)
  const threshold =
    MAX_LUMINANCE_EDGE_STRENGTH -
    detail *
      (MAX_LUMINANCE_EDGE_STRENGTH - MIN_LUMINANCE_EDGE_STRENGTH)
  // A fixed ceiling keeps growth bounded without breaking a strong contour
  // into progressively longer fragments as detail changes.
  const limit = Math.ceil(
    raster.width * raster.height * MAX_SELECTION_FRACTION,
  )

  const selected = luminanceCandidates(raster)
    .filter(({ strength }) => strength >= threshold)
    .sort((first, second) =>
      second.strength === first.strength
        ? first.order - second.order
        : second.strength - first.strength,
    )
    .slice(0, limit)
    .sort((first, second) => first.order - second.order)
    .map(({ edge }) => edge)

  return selected
}

type CellEdge = 'top' | 'right' | 'bottom' | 'left'

function interpolateIsovalue(
  start: Readonly<Point>,
  end: Readonly<Point>,
  startValue: number,
  endValue: number,
): Readonly<Point> {
  const amount =
    (ALPHA_BOUNDARY_ISOVALUE - startValue) / (endValue - startValue)
  return freezePoint(
    start[0] + (end[0] - start[0]) * amount,
    start[1] + (end[1] - start[1]) * amount,
  )
}

function alphaCellCrossings(
  raster: Readonly<AnalyzedRaster>,
  x: number,
  y: number,
): Readonly<Record<CellEdge, Readonly<Point> | undefined>> {
  const topLeftIndex = rasterIndex(raster.width, x, y)
  const topRightIndex = topLeftIndex + 1
  const bottomLeftIndex = topLeftIndex + raster.width
  const bottomRightIndex = bottomLeftIndex + 1
  const topLeft = raster.alpha[topLeftIndex] ?? 0
  const topRight = raster.alpha[topRightIndex] ?? 0
  const bottomRight = raster.alpha[bottomRightIndex] ?? 0
  const bottomLeft = raster.alpha[bottomLeftIndex] ?? 0
  const crosses = (first: number, second: number) =>
    (first >= ALPHA_BOUNDARY_ISOVALUE) !==
    (second >= ALPHA_BOUNDARY_ISOVALUE)

  return {
    top: crosses(topLeft, topRight)
      ? interpolateIsovalue(
          freezePoint(x, y),
          freezePoint(x + 1, y),
          topLeft,
          topRight,
        )
      : undefined,
    right: crosses(topRight, bottomRight)
      ? interpolateIsovalue(
          freezePoint(x + 1, y),
          freezePoint(x + 1, y + 1),
          topRight,
          bottomRight,
        )
      : undefined,
    bottom: crosses(bottomLeft, bottomRight)
      ? interpolateIsovalue(
          freezePoint(x, y + 1),
          freezePoint(x + 1, y + 1),
          bottomLeft,
          bottomRight,
        )
      : undefined,
    left: crosses(topLeft, bottomLeft)
      ? interpolateIsovalue(
          freezePoint(x, y),
          freezePoint(x, y + 1),
          topLeft,
          bottomLeft,
        )
      : undefined,
  }
}

const CELL_CONNECTIONS: Readonly<
  Record<number, readonly (readonly [CellEdge, CellEdge])[]>
> = Object.freeze({
  0: [],
  1: [['left', 'top']],
  2: [['top', 'right']],
  3: [['left', 'right']],
  4: [['right', 'bottom']],
  5: [
    ['left', 'top'],
    ['right', 'bottom'],
  ],
  6: [['top', 'bottom']],
  7: [['left', 'bottom']],
  8: [['bottom', 'left']],
  9: [['top', 'bottom']],
  10: [
    ['top', 'right'],
    ['bottom', 'left'],
  ],
  11: [['right', 'bottom']],
  12: [['left', 'right']],
  13: [['top', 'right']],
  14: [['left', 'top']],
  15: [],
})

function alphaBoundaryEdges(
  raster: Readonly<AnalyzedRaster>,
): readonly Readonly<LocalizedEdge>[] {
  const edges: Readonly<LocalizedEdge>[] = []

  for (let y = 0; y + 1 < raster.height; y += 1) {
    for (let x = 0; x + 1 < raster.width; x += 1) {
      const topLeftIndex = rasterIndex(raster.width, x, y)
      const topRightIndex = topLeftIndex + 1
      const bottomLeftIndex = topLeftIndex + raster.width
      const bottomRightIndex = bottomLeftIndex + 1
      const cellCase =
        ((raster.alpha[topLeftIndex] ?? 0) >= ALPHA_BOUNDARY_ISOVALUE
          ? 1
          : 0) |
        ((raster.alpha[topRightIndex] ?? 0) >= ALPHA_BOUNDARY_ISOVALUE
          ? 2
          : 0) |
        ((raster.alpha[bottomRightIndex] ?? 0) >= ALPHA_BOUNDARY_ISOVALUE
          ? 4
          : 0) |
        ((raster.alpha[bottomLeftIndex] ?? 0) >= ALPHA_BOUNDARY_ISOVALUE
          ? 8
          : 0)
      const crossings = alphaCellCrossings(raster, x, y)

      for (const [startSide, endSide] of CELL_CONNECTIONS[cellCase] ?? []) {
        const start = crossings[startSide]
        const end = crossings[endSide]
        if (start !== undefined && end !== undefined) {
          edges.push(freezeEdge(start, end, ALPHA_BOUNDARY_PROVENANCE))
        }
      }
    }
  }

  return edges
}

/**
 * Localize a prepared raster into deterministic tracing-ready edge segments.
 *
 * Detail changes only luminance admission. The fixed alpha boundary signal and
 * retained permission fields are identical at every detail value.
 */
export function localizePencilContourEdges(
  raster: Readonly<AnalyzedRaster>,
  contourDetail: number,
): Readonly<LocalizedEdgeGraph> {
  const edges = Object.freeze([
    ...selectLuminanceEdges(raster, contourDetail),
    ...alphaBoundaryEdges(raster),
  ])

  return Object.freeze({
    width: raster.width,
    height: raster.height,
    alpha: raster.alpha,
    positiveSupport: raster.positiveSupport,
    edges,
  })
}
