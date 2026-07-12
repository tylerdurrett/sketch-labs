/**
 * The Plot Profile domain model (CONTEXT.md "Output Profile", "Composition Frame").
 *
 * A Plot Profile is the plot-target Output Profile: the authoritative physical
 * description of the sheet a Sketch plots onto — its paper `width` and `height`
 * plus four independent margin `insets` — stored in canonical MILLIMETERS. Its
 * drawable rectangle (paper minus insets) has an aspect that supplies the
 * Composition Frame; its magnitude belongs to the later output mapping, not to
 * the frame's coordinate space.
 *
 * This module is deliberately headless and minimal. It owns the record shape,
 * validation, drawable-aspect equivalence, and pure Composition Frame derivation.
 * Catalog matching, unit conversion, default resolution, and Preset persistence
 * remain separate modules rather than UI concerns leaking into this model.
 *
 * Design decisions carried here (a Plot Profile is a Sketch-agnostic system
 * value, so its rationale lives in this header rather than in any one sketch, and
 * it needs no ADR of its own — ADR-0007):
 *
 * - Millimeters are canonical. A profile stores authoritative physical
 *   dimensions in mm and NOTHING derived: no standard-paper name, no
 *   portrait/landscape orientation flag, and no display-unit field. The Harness
 *   derives standard-size labels, a portrait/landscape convenience swaps width
 *   and height, and the display unit is a Studio local-storage preference — all
 *   owned by sibling tasks, none stored on the record (CONTEXT.md: "Plot profiles
 *   store authoritative physical dimensions, not a redundant paper name or
 *   orientation"; "Plot dimensions and insets are canonical millimeters").
 *
 * - The four insets are INDEPENDENT (top/right/bottom/left). Studio initially
 *   edits them as one linked value, while the four-inset shape keeps asymmetric
 *   plotter-safe regions representable without a later Preset migration (parent
 *   feature #245; CONTEXT.md: "Plot margins are four physical insets").
 *
 * - Validation contract. Paper `width`/`height` are strictly POSITIVE and finite
 *   (a zero, negative, `NaN`, or `Infinity` sheet is meaningless). The four
 *   insets are NON-NEGATIVE and finite — zero is VALID: parent #245 makes the
 *   provisional `10 mm` margin subject to change to zero, so a zero inset is a
 *   real, representable choice, not an error. Finally a profile whose insets
 *   exhaust the sheet (`left + right >= width` or `top + bottom >= height`,
 *   leaving no positive drawable rectangle) is rejected with a
 *   Plot-Profile-specific message rather than deferring to the downstream frame
 *   resolver's throw.
 *
 * - The drawable aspect feeds {@link resolveCompositionFrame} directly. This
 *   module does NOT reimplement fixed-area normalization; it computes the
 *   drawable rectangle and delegates the aspect → frame step to the one system
 *   module that owns it (`./compositionFrame`).
 */

import { resolveCompositionFrame } from './compositionFrame'
import type { CoordinateSpace } from './scene'

/**
 * The four independent margin insets of a {@link PlotProfile}, in millimeters.
 *
 * Each inset trims its edge of the paper inward to form the drawable rectangle.
 * They are modeled independently — even though the first UI edits them as one
 * linked value — so asymmetric plotter-safe regions are representable without a
 * later Preset migration. Each is NON-NEGATIVE and finite; zero is a valid inset.
 */
export interface PlotInsets {
  /** Distance from the top paper edge inward, in millimeters. */
  top: number
  /** Distance from the right paper edge inward, in millimeters. */
  right: number
  /** Distance from the bottom paper edge inward, in millimeters. */
  bottom: number
  /** Distance from the left paper edge inward, in millimeters. */
  left: number
}

/**
 * A Plot Profile: the plot-target Output Profile's authoritative physical
 * description, in canonical millimeters.
 *
 * Carries ONLY the paper's physical extent and its four margin insets — no
 * derived standard-paper name, orientation flag, or display-unit field (those
 * belong to sibling tasks). `width`/`height` are strictly positive; the four
 * `insets` are non-negative (zero valid). The drawable rectangle (paper minus
 * insets) supplies the Composition Frame via {@link resolvePlotCompositionFrame}.
 */
export interface PlotProfile {
  /** Paper width, in millimeters; strictly positive and finite. */
  width: number
  /** Paper height, in millimeters; strictly positive and finite. */
  height: number
  /** The four independent margin insets, in millimeters. */
  insets: PlotInsets
}

/** The four inset edges, in the canonical top/right/bottom/left order. */
const INSET_EDGES: ReadonlyArray<keyof PlotInsets> = [
  'top',
  'right',
  'bottom',
  'left',
]

/**
 * Validate a {@link PlotProfile}, throwing a Plot-Profile-specific error on any
 * violation. A valid profile returns cleanly (no value).
 *
 * Enforced in order so later checks operate on already-finite values:
 *
 * 1. `width` and `height` must each be a finite number strictly `> 0`. Zero, a
 *    negative, `NaN`, and `Infinity` are all rejected — a sheet with no positive
 *    physical extent is meaningless.
 * 2. Each of the four `insets` must be a finite number `>= 0`. Zero is VALID (the
 *    provisional `10 mm` margin may be set to zero); only a negative,
 *    `NaN`, or `Infinity` inset is rejected.
 * 3. The insets must leave a positive drawable rectangle: `left + right` must be
 *    strictly less than `width`, and `top + bottom` strictly less than `height`.
 *    Insets that meet or exceed the sheet exhaust the drawable region and are
 *    rejected here — rather than deferring to {@link resolveCompositionFrame}'s
 *    throw — so the failure names the Plot Profile cause.
 *
 * @param profile - The profile to validate.
 * @throws if any dimension is non-positive/non-finite, any inset is
 *   negative/non-finite, or the insets exhaust the drawable region.
 */
export function validatePlotProfile(profile: PlotProfile): void {
  const { width, height, insets } = profile

  for (const [name, value] of [
    ['width', width],
    ['height', height],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `validatePlotProfile: ${name} must be a finite positive number of millimeters, got ${value}`,
      )
    }
  }

  for (const edge of INSET_EDGES) {
    const value = insets[edge]
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `validatePlotProfile: ${edge} inset must be a finite non-negative number of millimeters, got ${value}`,
      )
    }
  }

  const horizontal = insets.left + insets.right
  if (horizontal >= width) {
    throw new Error(
      `validatePlotProfile: horizontal insets (left ${insets.left} + right ${insets.right} = ${horizontal}) meet or exceed the paper width ${width}, leaving no drawable rectangle`,
    )
  }

  const vertical = insets.top + insets.bottom
  if (vertical >= height) {
    throw new Error(
      `validatePlotProfile: vertical insets (top ${insets.top} + bottom ${insets.bottom} = ${vertical}) meet or exceed the paper height ${height}, leaving no drawable rectangle`,
    )
  }
}

/**
 * A rectangle in physical millimeters — distinct from the unitless
 * {@link CoordinateSpace} a Composition Frame lives in. The drawable rectangle of
 * a {@link PlotProfile} is measured in the same canonical millimeters as the
 * paper; only its ASPECT crosses over into the frame's normalized coordinate
 * space.
 */
export interface PlotRectangle {
  /** Rectangle width, in millimeters. */
  width: number
  /** Rectangle height, in millimeters. */
  height: number
}

/**
 * Derive a {@link PlotProfile}'s drawable rectangle — the paper minus its four
 * insets — in millimeters.
 *
 * The profile is validated first (see {@link validatePlotProfile}), so an
 * exhausted-region profile fails with the Plot-Profile message before this
 * returns. A valid profile always yields a rectangle with strictly positive
 * `width` and `height`, since valid insets leave a positive drawable region.
 *
 * @param profile - The profile to inset.
 * @returns The drawable rectangle in millimeters:
 *   `width  = width  - left - right`, `height = height - top  - bottom`.
 * @throws via {@link validatePlotProfile} if the profile is invalid.
 */
export function plotDrawableRectangle(profile: PlotProfile): PlotRectangle {
  validatePlotProfile(profile)
  const { width, height, insets } = profile
  return {
    width: width - insets.left - insets.right,
    height: height - insets.top - insets.bottom,
  }
}

/**
 * Relative tolerance for deciding whether two dimensionless drawable aspects
 * represent the same composition shape. This is intentionally machine-scale:
 * unlike the paper catalog's `0.5 mm` physical-input tolerance, aspect has no
 * unit and should absorb only arithmetic noise (for example, one ULP introduced
 * when every paper dimension and inset is proportionally scaled).
 */
export const PLOT_DRAWABLE_ASPECT_RELATIVE_TOLERANCE = Number.EPSILON * 8

/**
 * Compare positive drawable aspects without treating floating-point quotient
 * noise as a geometry change. Invalid aspects are never equivalent; exact values
 * take the fast path. The `max(1, |a|, |b|)` scale gives a standard symmetric
 * relative comparison while retaining useful behavior for portrait ratios < 1.
 */
export function plotDrawableAspectsEquivalent(
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
  const scale = Math.max(1, Math.abs(left), Math.abs(right))
  return (
    Math.abs(left - right) <= PLOT_DRAWABLE_ASPECT_RELATIVE_TOLERANCE * scale
  )
}

/**
 * Resolve a {@link PlotProfile}'s Composition Frame from its drawable rectangle's
 * aspect.
 *
 * The drawable rectangle (paper minus the four insets) carries the profile's
 * aspect; its magnitude belongs to the later output mapping, not to the frame.
 * This delegates the aspect → fixed-area frame step to
 * {@link resolveCompositionFrame} — the one system module that owns fixed-area
 * normalization — rather than reimplementing it. Validation runs first (via
 * {@link plotDrawableRectangle}), so an exhausted region fails with the
 * Plot-Profile message rather than the resolver's downstream throw.
 *
 * @param profile - The plot profile to resolve.
 * @returns The Composition Frame as a {@link CoordinateSpace}, normalized to the
 *   Harness's `1,000,000` square coordinate units.
 * @throws via {@link validatePlotProfile} if the profile is invalid.
 */
export function resolvePlotCompositionFrame(
  profile: PlotProfile,
): CoordinateSpace {
  const drawable = plotDrawableRectangle(profile)
  return resolveCompositionFrame(drawable.width / drawable.height)
}
