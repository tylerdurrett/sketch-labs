/**
 * Physical Plot Profile derivation for Page Frame edits (ADR-0015).
 *
 * Ordinary Page Frame edits preserve the uniform Scene-to-physical scale by
 * resizing the Plot Profile around the new Composition-coordinate extent. The
 * explicit fixed-page inverse instead locks that profile and changes the Page
 * Frame extent proportionally, uniformly scaling the frozen Scene behind it.
 *
 * Physical plot margins remain outside the drawable Page extent: ordinary
 * framing keeps them fixed while paper dimensions change, and fixed-page
 * scaling keeps the entire profile—including those margins—exactly untouched.
 */

import type { PageFrame } from './pageFrame'
import { fullCompositionPageFrame, validatePageFrame } from './pageFrame'
import {
  PLOT_DRAWABLE_ASPECT_RELATIVE_TOLERANCE,
  plotDrawableRectangle,
  type PlotProfile,
  validatePlotProfile,
} from './plotProfile'
import type { CoordinateSpace } from './scene'

const SCALE_RELATIVE_TOLERANCE = Number.EPSILON * 8
const CANCELLATION_ERROR_FACTOR = 4

/** A total paper dimension that drives a physical Page resize. */
export type PageFramePhysicalDimension = 'width' | 'height'

/**
 * Build the fixed-page scale reference for a frozen Composition Frame.
 *
 * The reference has the locked Plot Profile drawable's aspect and is centered
 * around the full Composition. Its extent contains the complete Composition:
 * the narrower axis is expanded when the two aspects differ, creating
 * geometry-free padding rather than cropping generated Scene geometry.
 *
 * This frame is both the stable `1` composition-scale reference and the Reset
 * result. Scaling a panned frame back to `1` deliberately preserves its center;
 * callers that mean Reset use this centered reference directly.
 *
 * The Plot Profile is validated but never cloned or modified.
 *
 * @throws if the profile or Composition Frame is invalid, its drawable aspect
 *   is not finite and positive, or the centered reference is not representable.
 */
export function centeredFixedPageFrame(
  profile: PlotProfile,
  composition: CoordinateSpace,
): PageFrame {
  const operation = 'centeredFixedPageFrame'
  const drawable = plotDrawableRectangle(profile)
  const compositionFrame = fullCompositionPageFrame(composition)
  const drawableAspect = drawable.width / drawable.height

  if (!Number.isFinite(drawableAspect) || drawableAspect <= 0) {
    throw new Error(
      `${operation}: Plot Profile drawable aspect must be a finite positive width/height ratio, got ${drawableAspect}`,
    )
  }

  const compositionAspect = composition.width / composition.height
  const reference: PageFrame =
    drawableAspect > compositionAspect
      ? {
          x:
            (composition.width - composition.height * drawableAspect) /
            2,
          y: 0,
          width: composition.height * drawableAspect,
          height: composition.height,
        }
      : drawableAspect < compositionAspect
        ? {
            x: 0,
            y:
              (composition.height - composition.width / drawableAspect) /
              2,
            width: composition.width,
            height: composition.width / drawableAspect,
          }
        : compositionFrame

  validatePageFrame(reference)
  pageFramePhysicalScale(profile, reference, operation)
  return reference
}

/**
 * Read a Page Frame's absolute composition scale against its fixed-page fit.
 *
 * Scale is `fit extent / current extent` on both axes: values above one zoom in
 * and values below one zoom out. Both frames must retain the locked drawable
 * aspect, and their per-axis ratios must describe one uniform scale.
 *
 * @throws if the profile or either frame is invalid, either frame is
 *   incompatible with the locked drawable aspect, or the ratios are not one
 *   finite positive uniform scale.
 */
export function fixedPageCompositionScale(
  profile: PlotProfile,
  referenceFrame: PageFrame,
  pageFrame: PageFrame,
): number {
  const operation = 'fixedPageCompositionScale'
  validatePlotProfile(profile)
  validatePageFrame(referenceFrame)
  validatePageFrame(pageFrame)

  const horizontalScale = referenceFrame.width / pageFrame.width
  const verticalScale = referenceFrame.height / pageFrame.height
  if (!scalesStrictlyEquivalent(horizontalScale, verticalScale)) {
    throw new Error(
      `${operation}: reference and current Page Frame extents must describe one finite positive uniform composition scale`,
    )
  }

  pageFramePhysicalScale(profile, referenceFrame, operation)
  pageFramePhysicalScale(profile, pageFrame, operation)
  return horizontalScale
}

/**
 * Apply an absolute fixed-page composition scale around the current Page center.
 *
 * Extents are always derived from the immutable centered-fit reference rather
 * than the previously scaled extents, avoiding compounding drift. The current
 * center is retained so scaling after a pan does not move the artwork anchor.
 * The locked Plot Profile is validation-only and remains exactly untouched.
 *
 * @throws if the profile/reference/current frame relationship is invalid, the
 *   scale is not finite and strictly positive, or the scaled frame cannot be
 *   represented as finite Page geometry.
 */
export function scaleFixedPageFrame(
  profile: PlotProfile,
  referenceFrame: PageFrame,
  currentFrame: PageFrame,
  compositionScale: number,
): PageFrame {
  const operation = 'scaleFixedPageFrame'
  if (!Number.isFinite(compositionScale) || compositionScale <= 0) {
    throw new Error(
      `${operation}: composition scale must be a finite positive number, got ${compositionScale}`,
    )
  }
  const currentScale = fixedPageCompositionScale(
    profile,
    referenceFrame,
    currentFrame,
  )
  if (scalesStrictlyEquivalent(currentScale, compositionScale)) {
    return currentFrame
  }

  const width = referenceFrame.width / compositionScale
  const height = referenceFrame.height / compositionScale
  const scaled: PageFrame = {
    x: currentFrame.x + (currentFrame.width - width) / 2,
    y: currentFrame.y + (currentFrame.height - height) / 2,
    width,
    height,
  }
  validatePageFrame(scaled)
  pageFramePhysicalScale(profile, scaled, operation)

  const representedScale = fixedPageCompositionScale(
    profile,
    referenceFrame,
    scaled,
  )
  if (!scalesStrictlyEquivalent(representedScale, compositionScale)) {
    throw new Error(
      `${operation}: composition scale ${compositionScale} cannot be represented as finite Page Frame geometry`,
    )
  }
  return scaled
}

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
 * Contain a target drawable aspect within the current physical Page.
 *
 * The current drawable rectangle is the containing box. One drawable axis is
 * retained exactly and only the other is shortened to reach the target
 * width/height ratio, so this operation never enlarges the Page. The four
 * physical insets remain fixed and are added around the fitted drawable.
 *
 * An already-equivalent aspect is an identity operation, preserving the exact
 * profile record and avoiding arithmetic drift.
 *
 * @throws if the profile is invalid, the target aspect is not finite and
 *   strictly positive, or fixed-inset arithmetic cannot represent the fitted
 *   drawable aspect accurately without enlargement.
 */
export function fitPageFramePlotProfileToAspect(
  profile: PlotProfile,
  targetDrawableAspect: number,
): PlotProfile {
  const operation = 'fitPageFramePlotProfileToAspect'
  const drawable = plotDrawableRectangle(profile)
  if (!Number.isFinite(targetDrawableAspect) || targetDrawableAspect <= 0) {
    throw new Error(
      `${operation}: target drawable aspect must be a finite positive width/height ratio, got ${targetDrawableAspect}`,
    )
  }

  const currentDrawableAspect = drawable.width / drawable.height
  if (
    drawableAspectsStrictlyEquivalent(
      currentDrawableAspect,
      targetDrawableAspect,
    )
  ) {
    return profile
  }

  const { insets } = profile
  const fitted: PlotProfile =
    currentDrawableAspect > targetDrawableAspect
      ? {
          ...profile,
          width: Math.min(
            profile.width,
            drawable.height * targetDrawableAspect +
              insets.left +
              insets.right,
          ),
          height: profile.height,
          insets: { ...insets },
        }
      : {
          ...profile,
          width: profile.width,
          height: Math.min(
            profile.height,
            drawable.width / targetDrawableAspect +
              insets.top +
              insets.bottom,
          ),
          insets: { ...insets },
        }

  try {
    validatePlotProfile(fitted)
  } catch {
    throw unrepresentableDrawableAspectError(operation, targetDrawableAspect)
  }

  const recovered = plotDrawableRectangle(fitted)
  if (
    recovered.width > drawable.width ||
    recovered.height > drawable.height ||
    !drawableAspectsStrictlyEquivalent(
      recovered.width / recovered.height,
      targetDrawableAspect,
    )
  ) {
    throw unrepresentableDrawableAspectError(operation, targetDrawableAspect)
  }
  return fitted
}

/** Compare aspects relatively at their own magnitude, including below one. */
function drawableAspectsStrictlyEquivalent(
  left: number,
  right: number,
): boolean {
  if (
    !Number.isFinite(left) ||
    left <= 0 ||
    !Number.isFinite(right) ||
    right <= 0
  ) {
    return false
  }
  if (left === right) return true
  const scale = Math.max(Math.abs(left), Math.abs(right))
  return (
    Math.abs(left - right) <=
    PLOT_DRAWABLE_ASPECT_RELATIVE_TOLERANCE * scale
  )
}

function unrepresentableDrawableAspectError(
  operation: string,
  targetDrawableAspect: number,
): Error {
  return new Error(
    `${operation}: target drawable aspect ${targetDrawableAspect} cannot be represented with the current fixed physical insets`,
  )
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

/** Compare two positive scales relatively, without a unit-scale floor. */
function scalesStrictlyEquivalent(left: number, right: number): boolean {
  if (
    !Number.isFinite(left) ||
    left <= 0 ||
    !Number.isFinite(right) ||
    right <= 0
  ) {
    return false
  }
  if (left === right) return true
  const scale = Math.max(Math.abs(left), Math.abs(right))
  return Math.abs(left - right) <= SCALE_RELATIVE_TOLERANCE * scale
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
