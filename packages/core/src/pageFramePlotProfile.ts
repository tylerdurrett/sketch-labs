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

  const drawable = plotDrawableRectangle(profile)
  const horizontalMillimetersPerUnit =
    drawable.width / currentPageFrame.width
  const verticalMillimetersPerUnit =
    drawable.height / currentPageFrame.height

  if (
    !physicalScalesEquivalent(
      horizontalMillimetersPerUnit,
      verticalMillimetersPerUnit,
      profile,
      currentPageFrame,
    )
  ) {
    throw new Error(
      'derivePageFramePlotProfile: the current Plot Profile drawable and current Page Frame must have equivalent physical scales',
    )
  }

  if (
    currentPageFrame.width === targetPageFrame.width &&
    currentPageFrame.height === targetPageFrame.height
  ) {
    return profile
  }

  const millimetersPerCompositionUnit = horizontalMillimetersPerUnit
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
