import type { CoordinateSpace } from '../scene'
import {
  sampleScribbleScaleField,
  type ScribbleScaleField,
} from '../scribbleScaleField'
import {
  sampleShadingMask,
  sampleToneField,
  type ToneSource,
} from '../shadingFields'
import type { Point } from '../types'
import { isMaskPermittedSegment } from './mask'
import {
  defaultScribbleControls,
  scribbleControlSchema,
  type ScribbleControlName,
  type ScribbleControls,
  type ScribbleLattice,
  type ScribbleLocalScales,
  type ScribbleModel,
  type ScribbleResidualSample,
  type ScribbleScales,
  type ScribbleSegmentScaleProfile,
  type ScribbleSegmentScaleSample,
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

function projectionOntoSegment(
  point: Readonly<Point>,
  start: Readonly<Point>,
  end: Readonly<Point>,
): { readonly point: Point; readonly distanceSquared: number } {
  const deltaX = end[0] - start[0]
  const deltaY = end[1] - start[1]
  const lengthSquared = deltaX * deltaX + deltaY * deltaY
  const progress =
    lengthSquared === 0
      ? 0
      : Math.min(
          1,
          Math.max(
            0,
            ((point[0] - start[0]) * deltaX +
              (point[1] - start[1]) * deltaY) /
              lengthSquared,
          ),
        )
  const projection: Point = [
    start[0] + progress * deltaX,
    start[1] + progress * deltaY,
  ]
  const distanceX = point[0] - projection[0]
  const distanceY = point[1] - projection[1]

  return {
    point: projection,
    distanceSquared: distanceX * distanceX + distanceY * distanceY,
  }
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
  scaleField?: ScribbleScaleField,
): ScribbleModel {
  const normalizedControls = normalizeScribbleControls(controls)
  const scales = resolveScribbleScales(frame, normalizedControls)
  const lattice = resolveScribbleLattice(frame, scales.residualSpacing)
  const points: Point[] = new Array(lattice.sampleCount)
  const tone = new Float64Array(lattice.sampleCount)
  const permission = new Float64Array(lattice.sampleCount)
  const coverage = new Float64Array(lattice.sampleCount)

  function localScalesAt(point: Readonly<Point>): ScribbleLocalScales {
    if (scaleField === undefined) return scales

    const localAuthoredScale = sampleScribbleScaleField(
      scaleField,
      point,
      normalizedControls.scribbleScale,
    )
    if (localAuthoredScale === normalizedControls.scribbleScale) return scales

    const multiplier = localAuthoredScale / normalizedControls.scribbleScale
    const segmentLength = scales.segmentLength * multiplier
    const coverageRadius = segmentLength * COVERAGE_TO_SEGMENT
    const maskCheckSpacing = segmentLength * MASK_CHECK_TO_SEGMENT

    // A valid dimensionless field sample can still overflow when converted to
    // scene units. Keep all coupled geometry at the authored fine anchor rather
    // than allowing one non-finite length to escape into traversal or deposits.
    if (
      !Number.isFinite(segmentLength) ||
      segmentLength <= 0 ||
      !Number.isFinite(coverageRadius) ||
      coverageRadius <= 0 ||
      !Number.isFinite(maskCheckSpacing) ||
      maskCheckSpacing <= 0
    ) {
      return scales
    }

    return Object.freeze({
      segmentLength,
      coverageRadius,
      maskCheckSpacing,
    })
  }

  function profileSegment(
    start: Readonly<Point>,
    end: Readonly<Point>,
  ): ScribbleSegmentScaleProfile | undefined {
    const deltaX = end[0] - start[0]
    const deltaY = end[1] - start[1]
    const length = Math.hypot(deltaX, deltaY)
    if (!Number.isFinite(length)) return undefined

    const intervalCount = Math.ceil(length / scales.maskCheckSpacing)
    if (!Number.isSafeInteger(intervalCount)) return undefined

    const samples: ScribbleSegmentScaleSample[] = []
    let minimumSegmentLength = Number.POSITIVE_INFINITY
    let minimumMaskCheckSpacing = Number.POSITIVE_INFINITY
    let maximumCoverageRadius = 0

    for (let interval = 0; interval <= intervalCount; interval++) {
      const progress = intervalCount === 0 ? 0 : interval / intervalCount
      const point = Object.freeze([
        interval === intervalCount ? end[0] : start[0] + deltaX * progress,
        interval === intervalCount ? end[1] : start[1] + deltaY * progress,
      ] as Point)
      const localScales = localScalesAt(point)

      if (
        !Number.isFinite(localScales.segmentLength) ||
        localScales.segmentLength <= 0 ||
        !Number.isFinite(localScales.coverageRadius) ||
        localScales.coverageRadius <= 0 ||
        !Number.isFinite(localScales.maskCheckSpacing) ||
        localScales.maskCheckSpacing <= 0
      ) {
        return undefined
      }

      minimumSegmentLength = Math.min(
        minimumSegmentLength,
        localScales.segmentLength,
      )
      minimumMaskCheckSpacing = Math.min(
        minimumMaskCheckSpacing,
        localScales.maskCheckSpacing,
      )
      maximumCoverageRadius = Math.max(
        maximumCoverageRadius,
        localScales.coverageRadius,
      )
      samples.push(Object.freeze({ point, progress, scales: localScales }))
    }

    return Object.freeze({
      length,
      samples: Object.freeze(samples),
      minimumSegmentLength,
      minimumMaskCheckSpacing,
      maximumCoverageRadius,
    })
  }

  function isSegmentSafe(
    start: Readonly<Point>,
    end: Readonly<Point>,
  ): boolean {
    // Keep the established uniform-scale arithmetic and sampling path exact.
    if (scaleField === undefined) {
      return isMaskPermittedSegment(
        source.shadingMask,
        lattice.frame,
        start,
        end,
        scales.maskCheckSpacing,
      )
    }

    const profile = profileSegment(start, end)
    if (profile === undefined) return false

    // Endpoints produced with sin/cos can differ from the requested length by
    // a few ulps. Admit only that representational noise, not a meaningful
    // excursion beyond the most restrictive sampled local length.
    const comparisonTolerance =
      Number.EPSILON *
      8 *
      Math.max(1, profile.length, profile.minimumSegmentLength)
    if (
      profile.length > profile.minimumSegmentLength + comparisonTolerance
    ) {
      return false
    }

    return isMaskPermittedSegment(
      source.shadingMask,
      lattice.frame,
      start,
      end,
      profile.minimumMaskCheckSpacing,
    )
  }

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

  function depositWithoutScaleField(
    start: Readonly<Point>,
    end: Readonly<Point>,
  ): void {
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

  function depositWithScaleField(
    start: Readonly<Point>,
    end: Readonly<Point>,
  ): void {
    const profile = profileSegment(start, end)
    if (profile === undefined) return

    // The profile supplies one conservative candidate bound. Each cell still
    // resolves its radius at the nearest centerline point, so a broad part of
    // the stroke cannot widen a neighboring fine part.
    const maximumRadius = profile.maximumCoverageRadius
    const minColumn = Math.max(
      0,
      Math.floor(
        (Math.min(start[0], end[0]) - maximumRadius) / lattice.cellWidth,
      ),
    )
    const maxColumn = Math.min(
      lattice.columns - 1,
      Math.floor(
        (Math.max(start[0], end[0]) + maximumRadius) / lattice.cellWidth,
      ),
    )
    const minRow = Math.max(
      0,
      Math.floor(
        (Math.min(start[1], end[1]) - maximumRadius) / lattice.cellHeight,
      ),
    )
    const maxRow = Math.min(
      lattice.rows - 1,
      Math.floor(
        (Math.max(start[1], end[1]) + maximumRadius) / lattice.cellHeight,
      ),
    )

    function depositCell(row: number, column: number): void {
      const index = row * lattice.columns + column
      const point = points[index]!
      const projection = projectionOntoSegment(point, start, end)
      const radius = localScalesAt(projection.point).coverageRadius
      const radiusSquared = radius * radius
      if (projection.distanceSquared >= radiusSquared) return

      // One cell receives one kernel evaluation for the complete segment.
      // This keeps peak darkness independent of profile sampling density.
      const normalizedDistanceSquared =
        projection.distanceSquared / radiusSquared
      const shoulder = 1 - normalizedDistanceSquared
      const amount = scales.coveragePerPass * shoulder * shoulder
      const previousResidual = cellResidual(index)
      coverage[index] = Math.min(1, coverage[index]! + amount)
      residualTotal += cellResidual(index) - previousResidual
    }

    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        depositCell(row, column)
      }
    }

    const deltaX = end[0] - start[0]
    const deltaY = end[1] - start[1]
    const lengthSquared = deltaX * deltaX + deltaY * deltaY
    if (lengthSquared === 0) return

    const boundedMaximumScale =
      scaleField?.maximumScale !== undefined &&
      Number.isFinite(scaleField.maximumScale) &&
      scaleField.maximumScale >= normalizedControls.scribbleScale
        ? scaleField.maximumScale
        : undefined
    const boundedMaximumRadius =
      boundedMaximumScale === undefined
        ? undefined
        : scales.coverageRadius *
          (boundedMaximumScale / normalizedControls.scribbleScale)
    const fallbackMinRow =
      boundedMaximumRadius === undefined
        ? 0
        : Math.max(
            0,
            Math.floor(
              (Math.min(start[1], end[1]) - boundedMaximumRadius) /
                lattice.cellHeight,
            ),
          )
    const fallbackMaxRow =
      boundedMaximumRadius === undefined
        ? lattice.rows - 1
        : Math.min(
            lattice.rows - 1,
            Math.floor(
              (Math.max(start[1], end[1]) + boundedMaximumRadius) /
                lattice.cellHeight,
            ),
          )
    const fallbackMinColumn =
      boundedMaximumRadius === undefined
        ? 0
        : Math.max(
            0,
            Math.floor(
              (Math.min(start[0], end[0]) - boundedMaximumRadius) /
                lattice.cellWidth,
            ),
          )
    const fallbackMaxColumn =
      boundedMaximumRadius === undefined
        ? lattice.columns - 1
        : Math.min(
            lattice.columns - 1,
            Math.floor(
              (Math.max(start[0], end[0]) + boundedMaximumRadius) /
                lattice.cellWidth,
            ),
          )

    // Without a declared field maximum, profile stations cannot prove a global
    // radius bound because the callback may be discontinuous. A declared bound
    // safely clips this fallback to the segment's largest possible footprint.
    // In either case, only strict interior projections can reveal a radius that
    // the station-derived initial box missed. Preserve row-major visitation so
    // the residual-total arithmetic stays bit-for-bit stable.
    for (let row = fallbackMinRow; row <= fallbackMaxRow; row++) {
      const y = (row + 0.5) * lattice.cellHeight
      let firstColumn = 0
      let lastColumn = lattice.columns - 1

      if (deltaX === 0) {
        const dot = (y - start[1]) * deltaY
        if (dot <= 0 || dot >= lengthSquared) continue
      } else {
        const verticalDot = (y - start[1]) * deltaY
        const firstBoundary = start[0] - verticalDot / deltaX
        const secondBoundary =
          start[0] + (lengthSquared - verticalDot) / deltaX
        const minimumX = Math.min(firstBoundary, secondBoundary)
        const maximumX = Math.max(firstBoundary, secondBoundary)

        // Include one conservative boundary column on either side; the exact
        // dot-product test below removes endpoint projections.
        firstColumn = Math.max(
          0,
          Math.floor(minimumX / lattice.cellWidth - 0.5),
        )
        lastColumn = Math.min(
          lattice.columns - 1,
          Math.ceil(maximumX / lattice.cellWidth - 0.5),
        )
      }

      firstColumn = Math.max(firstColumn, fallbackMinColumn)
      lastColumn = Math.min(lastColumn, fallbackMaxColumn)

      for (let column = firstColumn; column <= lastColumn; column++) {
        if (
          row >= minRow &&
          row <= maxRow &&
          column >= minColumn &&
          column <= maxColumn
        ) {
          continue
        }

        const point = points[row * lattice.columns + column]!
        const dot =
          (point[0] - start[0]) * deltaX +
          (point[1] - start[1]) * deltaY
        if (dot <= 0 || dot >= lengthSquared) continue
        depositCell(row, column)
      }
    }
  }

  function deposit(start: Readonly<Point>, end: Readonly<Point>): void {
    // Keep the established implementation as an explicit compatibility path.
    if (scaleField === undefined) {
      depositWithoutScaleField(start, end)
      return
    }

    depositWithScaleField(start, end)
  }

  return {
    source,
    controls: normalizedControls,
    ...(scaleField === undefined ? {} : { scaleField }),
    scales,
    lattice,
    localScalesAt,
    profileSegment,
    isSegmentSafe,
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
