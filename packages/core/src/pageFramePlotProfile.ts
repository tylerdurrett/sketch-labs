/**
 * Physical Plot Profile derivation for Page Frame edits (ADR-0015).
 *
 * A committed Page Frame changes which Composition-coordinate extent the page
 * represents, but it must not change the uniform Scene-to-physical scale. The
 * current Plot Profile and the Page Frame represented by its drawable rectangle
 * together carry that scale. Re-deriving from that pair makes first edits,
 * repeated edits, and Reset-to-full-Composition all the same operation.
 *
 * Physical plot margins are outside the drawable Page extent. They therefore
 * remain fixed in millimeters while only paper width and height grow or shrink.
 */

import type { PageFrame } from './pageFrame'
import { validatePageFrame } from './pageFrame'
import {
  plotDrawableRectangle,
  type PlotProfile,
  validatePlotProfile,
} from './plotProfile'

const SCALE_RELATIVE_TOLERANCE = Number.EPSILON * 8
const CANCELLATION_ERROR_FACTOR = 4

/** A total paper dimension that drives a physical Page resize. */
export type PageFramePhysicalDimension = 'width' | 'height'

/**
 * Derive the Plot Profile for a target Page Frame at the current physical scale.
 *
 * `currentPageFrame` is the Composition-coordinate extent represented by the
 * current profile's drawable rectangle. Its origin is irrelevant to physical
 * size; its width and height establish millimeters per Composition unit. The
 * target frame's extents are mapped at that same uniform scale, then the current
 * four physical insets are added back around the new drawable rectangle.
 *
 * Supplying equal current and target extents is an identity operation, including
 * a translated frame of the same size. This preserves the exact profile record
 * and avoids numeric drift. For Reset Frame, callers pass the committed frame as
 * `currentPageFrame` and the full original Composition Frame as `targetPageFrame`.
 *
 * @throws if either input is invalid, if the current drawable and represented
 *   frame do not describe one uniform physical scale, or if the derived physical
 *   dimensions cannot form a valid Plot Profile.
 */
export function derivePageFramePlotProfile(
  profile: PlotProfile,
  currentPageFrame: PageFrame,
  targetPageFrame: PageFrame,
): PlotProfile {
  validatePlotProfile(profile)
  validatePageFrame(currentPageFrame)
  validatePageFrame(targetPageFrame)

  const millimetersPerCompositionUnit = pageFramePhysicalScale(
    profile,
    currentPageFrame,
    'derivePageFramePlotProfile',
  )

  if (
    currentPageFrame.width === targetPageFrame.width &&
    currentPageFrame.height === targetPageFrame.height
  ) {
    return profile
  }

  const targetDrawableWidth =
    targetPageFrame.width * millimetersPerCompositionUnit
  const targetDrawableHeight =
    targetPageFrame.height * millimetersPerCompositionUnit
  const { insets } = profile

  const derived: PlotProfile = {
    ...profile,
    width: targetDrawableWidth + insets.left + insets.right,
    height: targetDrawableHeight + insets.top + insets.bottom,
    insets: { ...insets },
  }
  validatePlotProfile(derived)
  return derived
}

/**
 * Resize a locked Page's paper while retaining its drawable Page aspect.
 *
 * The supplied dimension is the TOTAL paper dimension, including the current
 * fixed physical insets. After removing those insets, the opposite drawable
 * extent is derived from `pageFrame` at one uniform scale and its insets are
 * added back. No other Plot Profile field changes.
 *
 * @throws if the inputs are invalid, the requested paper dimension is exhausted
 *   by its insets, the profile and represented Page do not have one uniform
 *   physical scale, or the result cannot form a valid Plot Profile.
 */
export function resizePageFramePlotProfileProportionally(
  profile: PlotProfile,
  pageFrame: PageFrame,
  dimension: PageFramePhysicalDimension,
  millimeters: number,
): PlotProfile {
  const operation = 'resizePageFramePlotProfileProportionally'
  pageFramePhysicalScale(profile, pageFrame, operation)
  const requestedDrawable = drawableExtentFromPaperDimension(
    profile,
    dimension,
    millimeters,
    operation,
  )

  const horizontalInsets = profile.insets.left + profile.insets.right
  const verticalInsets = profile.insets.top + profile.insets.bottom
  const scale =
    dimension === 'width'
      ? requestedDrawable / pageFrame.width
      : requestedDrawable / pageFrame.height
  const derived: PlotProfile = {
    ...profile,
    width:
      (dimension === 'width'
        ? requestedDrawable
        : pageFrame.width * scale) + horizontalInsets,
    height:
      (dimension === 'height'
        ? requestedDrawable
        : pageFrame.height * scale) + verticalInsets,
    insets: { ...profile.insets },
  }

  validatePlotProfile(derived)
  return derived
}

/**
 * Convert an edit-mode total paper dimension into one Page Frame draft extent.
 *
 * `profile` and `representedFrame` establish the committed Page's uniform
 * millimeters-per-Composition-unit scale. The requested paper dimension has its
 * fixed physical insets removed and is converted at that scale. Only the chosen
 * draft width or height changes; its origin and opposite extent are retained.
 *
 * @throws if the inputs are invalid, the requested paper dimension is exhausted
 *   by its insets, the committed profile/frame pair does not have one uniform
 *   physical scale, or the derived draft is invalid.
 */
export function resizePageFrameFromPhysicalDimension(
  profile: PlotProfile,
  representedFrame: PageFrame,
  draftFrame: PageFrame,
  dimension: PageFramePhysicalDimension,
  millimeters: number,
): PageFrame {
  const operation = 'resizePageFrameFromPhysicalDimension'
  const millimetersPerCompositionUnit = pageFramePhysicalScale(
    profile,
    representedFrame,
    operation,
  )
  validatePageFrame(draftFrame)
  const requestedDrawable = drawableExtentFromPaperDimension(
    profile,
    dimension,
    millimeters,
    operation,
  )
  const derived = {
    ...draftFrame,
    [dimension]: requestedDrawable / millimetersPerCompositionUnit,
  }

  validatePageFrame(derived)
  return derived
}

function drawableExtentFromPaperDimension(
  profile: PlotProfile,
  dimension: PageFramePhysicalDimension,
  millimeters: number,
  operation: string,
): number {
  if (dimension !== 'width' && dimension !== 'height') {
    throw new Error(
      `${operation}: dimension must be "width" or "height", got ${String(dimension)}`,
    )
  }
  if (!Number.isFinite(millimeters) || millimeters <= 0) {
    throw new Error(
      `${operation}: ${dimension} must be a finite positive total paper dimension in millimeters, got ${millimeters}`,
    )
  }

  const insetExtent =
    dimension === 'width'
      ? profile.insets.left + profile.insets.right
      : profile.insets.top + profile.insets.bottom
  const drawableExtent = millimeters - insetExtent
  if (drawableExtent <= 0) {
    throw new Error(
      `${operation}: ${dimension} ${millimeters} is exhausted by its fixed physical insets (${insetExtent}), leaving no drawable Page extent`,
    )
  }
  return drawableExtent
}

/** Validate a profile/frame pair and return its uniform physical scale. */
function pageFramePhysicalScale(
  profile: PlotProfile,
  representedFrame: PageFrame,
  operation: string,
): number {
  validatePlotProfile(profile)
  validatePageFrame(representedFrame)

  const drawable = plotDrawableRectangle(profile)
  const horizontalMillimetersPerUnit =
    drawable.width / representedFrame.width
  const verticalMillimetersPerUnit =
    drawable.height / representedFrame.height

  if (
    !physicalScalesEquivalent(
      horizontalMillimetersPerUnit,
      verticalMillimetersPerUnit,
      profile,
      representedFrame,
    )
  ) {
    throw new Error(
      `${operation}: the current Plot Profile drawable and represented Page Frame must have equivalent physical scales`,
    )
  }
  return horizontalMillimetersPerUnit
}

/**
 * Compare direct per-axis physical scales at their own magnitude.
 *
 * The ordinary tolerance is strictly relative, including below one; using an
 * absolute floor would incorrectly accept materially different microscopic
 * scales. The additional allowance models only cancellation from recovering the
 * drawable via `paper - inset - inset`. That recovery can lose a few ULPs when a
 * small emitted Page extent sits beside much larger fixed physical margins.
 */
function physicalScalesEquivalent(
  horizontal: number,
  vertical: number,
  profile: PlotProfile,
  representedFrame: PageFrame,
): boolean {
  if (
    !Number.isFinite(horizontal) ||
    horizontal <= 0 ||
    !Number.isFinite(vertical) ||
    vertical <= 0
  ) {
    return false
  }
  const scale = Math.max(Math.abs(horizontal), Math.abs(vertical))
  const relativeTolerance = SCALE_RELATIVE_TOLERANCE * scale
  const horizontalCancellationTolerance =
    (Number.EPSILON *
      CANCELLATION_ERROR_FACTOR *
      (Math.abs(profile.width) +
        Math.abs(profile.insets.left) +
        Math.abs(profile.insets.right))) /
    representedFrame.width
  const verticalCancellationTolerance =
    (Number.EPSILON *
      CANCELLATION_ERROR_FACTOR *
      (Math.abs(profile.height) +
        Math.abs(profile.insets.top) +
        Math.abs(profile.insets.bottom))) /
    representedFrame.height

  return (
    Math.abs(horizontal - vertical) <=
    relativeTolerance +
      horizontalCancellationTolerance +
      verticalCancellationTolerance
  )
}
