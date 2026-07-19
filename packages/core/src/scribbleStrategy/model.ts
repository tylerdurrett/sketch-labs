import type { CoordinateSpace } from '../scene'
import {
  sampleShadingMask,
  sampleToneField,
  type ToneSource,
} from '../shadingFields'
import type { Point } from '../types'
import {
  defaultScribbleControls,
  scribbleControlSchema,
  type ScribbleControlName,
  type ScribbleControls,
  type ScribbleLattice,
  type ScribbleModel,
  type ScribbleResidualSample,
  type ScribbleScales,
} from './types'

// Ratios belong to the strategy, not the authored parameter surface. The values
// keep the default 1000 x 1000 Composition Frame practical in the Studio
// Worker while retaining enough samples to distinguish hard and feathered
// boundaries.
const SEGMENT_TO_FRAME = 0.012
const COVERAGE_TO_SEGMENT = 1.5
const RESIDUAL_TO_SEGMENT = 1.125
const MASK_CHECK_TO_SEGMENT = 0.25
const BASE_COVERAGE_PER_PASS = 0.32
const LOOSE_COMPLETION_ERROR = 0.12
const STRICT_COMPLETION_ERROR = 0.005

function assertFrame(frame: CoordinateSpace): void {
  if (
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    throw new Error(
      `createScribbleModel: frame must have finite positive dimensions, got ${frame.width} × ${frame.height}`,
    )
  }
}
function boundedControl(name: ScribbleControlName, value: number): number {
  const spec = scribbleControlSchema[name]
  if (!Number.isFinite(value)) return spec.default
  return Math.min(spec.max, Math.max(spec.min, value))
}

/**
 * Bound untrusted run controls using their authored declarations.
 *
 * A partial object is accepted so integrations can adopt the model before all
 * six controls have dedicated UI wiring; missing/non-finite values use the
 * declared defaults rather than leaking NaNs into geometry.
 */
export function normalizeScribbleControls(
  controls: Partial<ScribbleControls> = defaultScribbleControls,
): Readonly<ScribbleControls> {
  return Object.freeze({
    pathDensity: boundedControl(
      'pathDensity',
      controls.pathDensity ?? defaultScribbleControls.pathDensity,
    ),
    scribbleScale: boundedControl(
      'scribbleScale',
      controls.scribbleScale ?? defaultScribbleControls.scribbleScale,
    ),
    momentum: boundedControl(
      'momentum',
      controls.momentum ?? defaultScribbleControls.momentum,
    ),
    chaos: boundedControl('chaos', controls.chaos ?? defaultScribbleControls.chaos),
    toneFidelity: boundedControl(
      'toneFidelity',
      controls.toneFidelity ?? defaultScribbleControls.toneFidelity,
    ),
    stopPoint: Math.round(
      boundedControl(
        'stopPoint',
        controls.stopPoint ?? defaultScribbleControls.stopPoint,
      ),
    ),
  })
}

/** Derive every low-level length from one authored, frame-relative scale. */
export function resolveScribbleScales(
  frame: CoordinateSpace,
  controls: Partial<ScribbleControls> = defaultScribbleControls,
): ScribbleScales {
  assertFrame(frame)
  const normalized = normalizeScribbleControls(controls)
  const frameScale = Math.sqrt(frame.width * frame.height)
  const segmentLength =
    frameScale * SEGMENT_TO_FRAME * normalized.scribbleScale

  return Object.freeze({
    frameScale,
    segmentLength,
    coverageRadius: segmentLength * COVERAGE_TO_SEGMENT,
    residualSpacing: segmentLength * RESIDUAL_TO_SEGMENT,
    maskCheckSpacing: segmentLength * MASK_CHECK_TO_SEGMENT,
    coveragePerPass: BASE_COVERAGE_PER_PASS / normalized.pathDensity,
    completionThreshold:
      LOOSE_COMPLETION_ERROR -
      normalized.toneFidelity *
        (LOOSE_COMPLETION_ERROR - STRICT_COMPLETION_ERROR),
  })
}

/**
 * Build a deterministic rectangular lattice with equal-area, center-sampled
 * cells. Counts derive symmetrically from the short/long frame axes, so swapping
 * portrait and landscape dimensions only transposes the lattice.
 */
export function resolveScribbleLattice(
  frame: CoordinateSpace,
  nominalSpacing: number,
): ScribbleLattice {
  assertFrame(frame)
  if (!Number.isFinite(nominalSpacing) || nominalSpacing <= 0) {
    throw new Error(
      `resolveScribbleLattice: spacing must be finite and positive, got ${nominalSpacing}`,
    )
  }

  const shortExtent = Math.min(frame.width, frame.height)
  const longExtent = Math.max(frame.width, frame.height)
  const shortCount = Math.max(1, Math.round(shortExtent / nominalSpacing))
  const longCount = Math.max(
    1,
    Math.round((longExtent / shortExtent) * shortCount),
  )
  const columns = frame.width <= frame.height ? shortCount : longCount
  const rows = frame.width <= frame.height ? longCount : shortCount
  const cellWidth = frame.width / columns
  const cellHeight = frame.height / rows

  return Object.freeze({
    frame: Object.freeze({ width: frame.width, height: frame.height }),
    columns,
    rows,
    cellWidth,
    cellHeight,
    cellArea: cellWidth * cellHeight,
    sampleCount: columns * rows,
  })
}

function squaredDistanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) {
    const pointDx = px - ax
    const pointDy = py - ay
    return pointDx * pointDx + pointDy * pointDy
  }

  const projection = Math.min(
    1,
    Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared),
  )
  const nearestX = ax + projection * dx
  const nearestY = ay + projection * dy
  const nearestDx = px - nearestX
  const nearestDy = py - nearestY
  return nearestDx * nearestDx + nearestDy * nearestDy
}

function interpolatedLatticeValue(
  lattice: ScribbleLattice,
  values: Float64Array,
  point: Readonly<Point>,
): number {
  // Cell values live at their centers. Clamp positions to those centers so
  // interpolation remains continuous all the way to and beyond frame edges.
  const columnPosition = Math.min(
    lattice.columns - 1,
    Math.max(0, point[0] / lattice.cellWidth - 0.5),
  )
  const rowPosition = Math.min(
    lattice.rows - 1,
    Math.max(0, point[1] / lattice.cellHeight - 0.5),
  )
  const leftColumn = Math.floor(columnPosition)
  const rightColumn = Math.min(lattice.columns - 1, leftColumn + 1)
  const topRow = Math.floor(rowPosition)
  const bottomRow = Math.min(lattice.rows - 1, topRow + 1)
  const horizontalWeight = columnPosition - leftColumn
  const verticalWeight = rowPosition - topRow
  const topLeft = values[topRow * lattice.columns + leftColumn]!
  const topRight = values[topRow * lattice.columns + rightColumn]!
  const bottomLeft = values[bottomRow * lattice.columns + leftColumn]!
  const bottomRight = values[bottomRow * lattice.columns + rightColumn]!
  const top = topLeft + (topRight - topLeft) * horizontalWeight
  const bottom = bottomLeft + (bottomRight - bottomLeft) * horizontalWeight

  return top + (bottom - top) * verticalWeight
}

/**
 * Create the virtual coverage and residual state for one strategy run.
 *
 * Tone and permission are sampled into separate arrays. In particular, soft
 * permission weights residual demand; it does not rewrite the authored target.
 */
export function createScribbleModel(
  source: ToneSource,
  frame: CoordinateSpace,
  controls: Partial<ScribbleControls> = defaultScribbleControls,
): ScribbleModel {
  const normalizedControls = normalizeScribbleControls(controls)
  const scales = resolveScribbleScales(frame, normalizedControls)
  const lattice = resolveScribbleLattice(frame, scales.residualSpacing)
  const points: Point[] = new Array(lattice.sampleCount)
  const tone = new Float64Array(lattice.sampleCount)
  const permission = new Float64Array(lattice.sampleCount)
  const coverage = new Float64Array(lattice.sampleCount)

  for (let row = 0; row < lattice.rows; row++) {
    for (let column = 0; column < lattice.columns; column++) {
      const index = row * lattice.columns + column
      const point = [
        (column + 0.5) * lattice.cellWidth,
        (row + 0.5) * lattice.cellHeight,
      ] as Point
      points[index] = point
      // Keep the source channels distinct even when permission is exact zero.
      permission[index] = sampleShadingMask(source.shadingMask, point)
      tone[index] = sampleToneField(source.toneField, point)
    }
  }

  function cellResidual(index: number): number {
    return permission[index]! * Math.max(0, tone[index]! - coverage[index]!)
  }

  let residualTotal = 0
  for (let index = 0; index < lattice.sampleCount; index++) {
    residualTotal += cellResidual(index)
  }

  function deposit(start: Readonly<Point>, end: Readonly<Point>): void {
    const radius = scales.coverageRadius
    const radiusSquared = radius * radius
    const minColumn = Math.max(
      0,
      Math.floor((Math.min(start[0], end[0]) - radius) / lattice.cellWidth),
    )
    const maxColumn = Math.min(
      lattice.columns - 1,
      Math.floor((Math.max(start[0], end[0]) + radius) / lattice.cellWidth),
    )
    const minRow = Math.max(
      0,
      Math.floor((Math.min(start[1], end[1]) - radius) / lattice.cellHeight),
    )
    const maxRow = Math.min(
      lattice.rows - 1,
      Math.floor((Math.max(start[1], end[1]) + radius) / lattice.cellHeight),
    )

    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        const index = row * lattice.columns + column
        const point = points[index]!
        const distanceSquared = squaredDistanceToSegment(
          point[0],
          point[1],
          start[0],
          start[1],
          end[0],
          end[1],
        )
        if (distanceSquared >= radiusSquared) continue

        // Quartic compact kernel: smooth at the center and reaches exactly zero
        // at the footprint edge. Repeated passes add darkness monotonically.
        const normalizedDistanceSquared = distanceSquared / radiusSquared
        const shoulder = 1 - normalizedDistanceSquared
        const amount = scales.coveragePerPass * shoulder * shoulder
        const previousResidual = cellResidual(index)
        coverage[index] = Math.min(1, coverage[index]! + amount)
        residualTotal += cellResidual(index) - previousResidual
      }
    }
  }

  return {
    source,
    controls: normalizedControls,
    scales,
    lattice,
    residualError(): number {
      // Every term is bounded [0,1], and sampleCount is always positive.
      return Math.min(1, Math.max(0, residualTotal / lattice.sampleCount))
    },
    residualAt(point: Readonly<Point>): number {
      const permissionAtPoint = sampleShadingMask(source.shadingMask, point)
      const toneAtPoint = sampleToneField(source.toneField, point)
      const coverageAtPoint = interpolatedLatticeValue(lattice, coverage, point)
      return permissionAtPoint * Math.max(0, toneAtPoint - coverageAtPoint)
    },
    coverageAt(point: Readonly<Point>): number {
      return interpolatedLatticeValue(lattice, coverage, point)
    },
    visitResidualSamples(visit): void {
      for (let index = 0; index < lattice.sampleCount; index++) {
        if (visit(index, points[index]!, cellResidual(index)) === false) {
          break
        }
      }
    },
    samples(): readonly ScribbleResidualSample[] {
      return points.map((point, index) =>
        Object.freeze({
          point: Object.freeze([point[0], point[1]] as Point),
          tone: tone[index]!,
          permission: permission[index]!,
          coverage: coverage[index]!,
          residual: cellResidual(index),
        }),
      )
    },
    depositPoint(point: Readonly<Point>): void {
      deposit(point, point)
    },
    depositSegment(start: Readonly<Point>, end: Readonly<Point>): void {
      deposit(start, end)
    },
  }
}
