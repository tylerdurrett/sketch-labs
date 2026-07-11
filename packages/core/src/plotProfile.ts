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
 * This module is deliberately headless and minimal. It ships ONLY the record
 * shape, its validator, and the pure drawable-aspect → Composition Frame
 * derivation. Catalog matching (standard-paper names), unit conversion
 * (millimeters ↔ inches), default/fallback resolution, and Preset persistence
 * are sibling concerns under slice #247 and live elsewhere.
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
 * - The four insets are INDEPENDENT (top/right/bottom/left). The first UI (slice
 *   #248) edits them as one linked value, but the four-inset shape lands in the
 *   model now so asymmetric plotter-safe regions stay representable and no later
 *   Preset migration is needed (parent feature #245; CONTEXT.md: "Plot margins
 *   are four physical insets; the initial Harness UI edits them as one linked
 *   value").
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
