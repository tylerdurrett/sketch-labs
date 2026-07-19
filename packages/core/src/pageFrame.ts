/**
 * Renderer-agnostic Page Frame geometry (ADR-0015).
 *
 * A Page Frame is the final output rectangle expressed in the original
 * Composition Frame's coordinate units. It may sit inside the Composition Frame
 * to crop, outside it to pad, or cross its edges to do both. It never changes
 * the Composition Frame or the generated Scene beneath it.
 */

import type { BBox } from './clip'
import type { CoordinateSpace } from './scene'
import type { Point } from './types'

/** A finite, positive-area Page boundary in Composition Frame coordinates. */
export interface PageFrame {
  /** Horizontal position of the Page's top-left in Composition coordinates. */
  readonly x: number
  /** Vertical position of the Page's top-left in Composition coordinates. */
  readonly y: number
  /** Page width in Composition coordinate units; finite and strictly positive. */
  readonly width: number
  /** Page height in Composition coordinate units; finite and strictly positive. */
  readonly height: number
}

/**
 * A Page Frame expressed as percentages of a Composition Frame's width/height.
 *
 * The shape deliberately matches {@link PageFrame}: `x` and `width` are relative
 * to Composition width, while `y` and `height` are relative to Composition
 * height. Origins may be negative and extents may exceed 100.
 */
export interface PageFramePercentages {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const PAGE_FRAME_FIELDS = ['x', 'y', 'width', 'height'] as const

/**
 * Validate a Page Frame without imposing containment in its Composition Frame.
 *
 * Origins must be finite but may be negative. Width and height must be finite
 * and strictly positive; they may extend beyond the Composition Frame.
 */
export function validatePageFrame(frame: PageFrame): void {
  validateRectangle(frame, 'validatePageFrame')
}

function validateRectangle(
  frame: PageFrame | PageFramePercentages,
  operation: string,
): void {
  for (const field of PAGE_FRAME_FIELDS) {
    const value = frame[field]
    const valid =
      Number.isFinite(value) &&
      (field === 'x' || field === 'y' || value > 0)

    if (!valid) {
      const requirement =
        field === 'x' || field === 'y'
          ? 'a finite number'
          : 'a finite positive number'
      throw new Error(
        `${operation}: ${field} must be ${requirement}, got ${value}`,
      )
    }
  }
}

/** Return the exact, visually inert Page Frame for a full Composition Frame. */
export function fullCompositionPageFrame(
  composition: CoordinateSpace,
): PageFrame {
  validateCompositionSpace(composition, 'fullCompositionPageFrame')
  return Object.freeze({
    x: 0,
    y: 0,
    width: composition.width,
    height: composition.height,
  })
}

/**
 * Convert Composition-coordinate Page geometry to percentages of the original
 * Composition Frame. No clamping is performed.
 */
export function pageFrameToPercentages(
  frame: PageFrame,
  composition: CoordinateSpace,
): PageFramePercentages {
  validatePageFrame(frame)
  validateCompositionSpace(composition, 'pageFrameToPercentages')

  const percentages = {
    x: (frame.x / composition.width) * 100,
    y: (frame.y / composition.height) * 100,
    width: (frame.width / composition.width) * 100,
    height: (frame.height / composition.height) * 100,
  }
  validateRectangle(percentages, 'pageFrameToPercentages')
  return Object.freeze(percentages)
}

/**
 * Convert Page percentages back to the original Composition Frame's coordinate
 * units. Negative origins and extents above 100 are preserved without clamping.
 */
export function pageFrameFromPercentages(
  percentages: PageFramePercentages,
  composition: CoordinateSpace,
): PageFrame {
  validateRectangle(percentages, 'pageFrameFromPercentages')
  validateCompositionSpace(composition, 'pageFrameFromPercentages')

  const frame = {
    x: (percentages.x / 100) * composition.width,
    y: (percentages.y / 100) * composition.height,
    width: (percentages.width / 100) * composition.width,
    height: (percentages.height / 100) * composition.height,
  }
  validatePageFrame(frame)
  return Object.freeze(frame)
}

/** Convert a Page Frame to `[minX, minY, maxX, maxY]` clip bounds. */
export function pageFrameClipBounds(frame: PageFrame): BBox {
  validatePageFrame(frame)
  return [frame.x, frame.y, frame.x + frame.width, frame.y + frame.height]
}

/**
 * Translate a point from Composition coordinates to Page coordinates, rebasing
 * the Page Frame's top-left to `(0, 0)` without mutating the source point.
 */
export function rebasePointToPageFrame(
  point: Readonly<Point>,
  frame: PageFrame,
): Point {
  validatePageFrame(frame)
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
    throw new Error(
      `rebasePointToPageFrame: point coordinates must be finite, got ${point[0]},${point[1]}`,
    )
  }
  return [point[0] - frame.x, point[1] - frame.y]
}

function validateCompositionSpace(
  composition: CoordinateSpace,
  operation: string,
): void {
  for (const field of ['width', 'height'] as const) {
    const value = composition[field]
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `${operation}: Composition Frame ${field} must be a finite positive number, got ${value}`,
      )
    }
  }
}
