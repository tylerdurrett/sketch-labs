/**
 * The standard-paper catalog boundary over the {@link PlotProfile} domain model
 * (CONTEXT.md "Output Profile"; parent feature #245).
 *
 * A Plot Profile stores ONLY authoritative physical dimensions in canonical
 * millimeters plus four independent margin insets. It deliberately persists no
 * standard-paper name, no portrait/landscape orientation flag, and no display
 * unit. This module is the pure, headless boundary that lets the Harness work in
 * those human terms WITHOUT ever writing them onto the record: the standard-size
 * label and the portrait/landscape state are DERIVED from the stored dimensions
 * on demand, and selecting a standard writes authoritative millimeters back.
 *
 * It is deliberately minimal and free of UI: it ships the catalog, the derivation
 * helpers, and the orientation swap as pure functions. The first Paper UI that
 * consumes them is a sibling task (slice #248).
 *
 * Design decisions carried here (the paper catalog is a Sketch-agnostic system
 * value, so its rationale lives in this header rather than in any one sketch, and
 * it needs no ADR of its own — ADR-0007):
 *
 * - The catalog is millimeter-canonical, stored in PORTRAIT orientation. The seven
 *   supported formats (square, A2–A5, letter, tabloid) live in
 *   {@link STANDARD_PAPERS} as
 *   `width <= height` millimeter rectangles. This supersedes the earlier
 *   centimeter catalog that carried orientation as an argument — the whole domain
 *   is canonical millimeters now (CONTEXT.md: "Plot dimensions and insets are
 *   canonical millimeters").
 *
 * - The standard label and orientation are DERIVED, never persisted. A Plot
 *   Profile never stores which standard it is or which way it is turned;
 *   {@link matchStandardPaper} recovers the label from the stored dimensions and
 *   {@link derivePaperOrientation} recovers the orientation. Selecting a standard
 *   ({@link standardPaperProfile} / {@link applyStandardPaper}) writes the
 *   authoritative millimeters and nothing else (CONTEXT.md: "Plot profiles store
 *   authoritative physical dimensions, not a redundant paper name or orientation;
 *   the Harness derives standard-size labels").
 *
 * - Standard matching is ORIENTATION-INDEPENDENT. A landscape A4 is still an A4,
 *   so matching compares the profile's dimensions as a sorted `[min, max]` pair
 *   against each catalog entry's sorted pair, within a small millimeter tolerance
 *   ({@link STANDARD_PAPER_MATCH_TOLERANCE_MM}) that absorbs float and rounding
 *   noise while staying far below the tens-of-millimeters separation between
 *   formats. A size that matches nothing is custom, reported as `null`.
 *
 * - The orientation swap reorders WIDTH AND HEIGHT ONLY. Portrait/landscape is a
 *   convenience over the stored dimensions, so {@link swapPlotOrientation}
 *   returns a profile with `width`/`height` transposed and the four `insets`
 *   carried through UNCHANGED — the insets are not reordered — introducing no new
 *   stored state (resolved in feature #245: "portrait/landscape and swap controls
 *   only reorder width and height"; CONTEXT.md: "its portrait/landscape
 *   convenience swaps width and height").
 *
 * - Millimeter↔inch conversion is a DISPLAY transform at the model boundary that
 *   NEVER overwrites the canonical millimeter model. Millimeters stay canonical
 *   ({@link MM_PER_INCH} = 25.4). {@link plotProfileToInches} produces an
 *   inch-valued VIEW of a profile for the Paper UI to display and edit;
 *   {@link plotProfileFromInches} maps an inch-valued edit back to canonical
 *   millimeters. Because these are pure and only ever return new records, the
 *   round trip is an identity on the stored model — the canonical profile is
 *   never mutated — and a numeric mm→inch→mm round trip returns to the canonical
 *   value within floating-point tolerance (CONTEXT.md: "the Paper UI accepts and
 *   displays both millimeters and inches by converting at its boundary").
 */

import type { PlotInsets, PlotProfile, PlotRectangle } from './plotProfile'

/**
 * A paper orientation derived from a Plot Profile's stored dimensions.
 *
 * This is NEVER persisted on a profile — it is resolved from the dimensions by
 * {@link derivePaperOrientation} and only supplied as an argument when writing a
 * standard format at a chosen orientation.
 */
export type PaperOrientation = 'portrait' | 'landscape'

/**
 * The names of the standard paper formats in {@link STANDARD_PAPERS}, in catalog
 * order. The {@link StandardPaperName} union is derived from this tuple so the
 * names, the type, and the catalog stay in lockstep.
 */
export const STANDARD_PAPER_NAMES = [
  'square',
  'a2',
  'a3',
  'a4',
  'a5',
  'letter',
  'tabloid',
] as const

/** A supported standard paper format name. */
export type StandardPaperName = (typeof STANDARD_PAPER_NAMES)[number]

/**
 * The standard paper catalog, in canonical millimeters and PORTRAIT orientation
 * (`width <= height`).
 *
 * These are the seven supported formats expressed in millimeters: the Harness's
 * square default, the ISO A-series A2–A5, and US letter and tabloid. Landscape
 * dimensions are derived by transposing width and height on demand; they are not
 * stored.
 */
export const STANDARD_PAPERS: Record<StandardPaperName, PlotRectangle> = {
  square: { width: 200, height: 200 },
  a2: { width: 420, height: 594 },
  a3: { width: 297, height: 420 },
  a4: { width: 210, height: 297 },
  a5: { width: 148, height: 210 },
  letter: { width: 215.9, height: 279.4 },
  tabloid: { width: 279.4, height: 431.8 },
}

/**
 * The millimeter tolerance used when matching a profile's dimensions against the
 * catalog ({@link matchStandardPaper}).
 *
 * Small on purpose: it absorbs floating-point noise (e.g. a millimeter↔inch
 * round-trip) and minor input rounding without ever fuzzing one standard into
 * another. The closest two catalog formats differ by tens of millimeters, so this
 * `0.5 mm` window is safely below any real ambiguity.
 */
export const STANDARD_PAPER_MATCH_TOLERANCE_MM = 0.5

/** A profile or bare rectangle — anything carrying millimeter `width`/`height`. */
type Dimensions = PlotProfile | PlotRectangle

/** Return a rectangle's dimensions sorted ascending as `[min, max]`. */
function sortedDimensions({ width, height }: Dimensions): [number, number] {
  return width <= height ? [width, height] : [height, width]
}

/**
 * Resolve a standard format's catalog dimensions at a chosen orientation.
 *
 * Portrait returns the stored (portrait) millimeters; landscape transposes width
 * and height. Kept internal — the record shape ({@link standardPaperProfile} /
 * {@link applyStandardPaper}) is the public way to obtain oriented dimensions.
 */
function orientedStandardDimensions(
  name: StandardPaperName,
  orientation: PaperOrientation,
): PlotRectangle {
  const { width, height } = STANDARD_PAPERS[name]
  return orientation === 'landscape'
    ? { width: height, height: width }
    : { width, height }
}

/**
 * Build a Plot Profile from a standard format at a chosen orientation.
 *
 * Writes the catalog's authoritative millimeters for `name` (transposed for
 * landscape) and NOTHING derived — no standard name, no orientation field. The
 * caller supplies the four `insets`; they default to zero. To write a standard
 * into an EXISTING profile while keeping its insets, use
 * {@link applyStandardPaper}.
 *
 * The result is not validated here (see {@link validatePlotProfile}); a caller
 * that pairs a small format with large insets is responsible for checking it.
 *
 * @param name - The standard format to write.
 * @param orientation - Portrait (default) or landscape.
 * @param insets - The four margin insets, in millimeters (default: all zero).
 * @returns A new Plot Profile carrying the format's millimeters and the insets.
 */
export function standardPaperProfile(
  name: StandardPaperName,
  orientation: PaperOrientation = 'portrait',
  insets: PlotInsets = { top: 0, right: 0, bottom: 0, left: 0 },
): PlotProfile {
  const { width, height } = orientedStandardDimensions(name, orientation)
  return { width, height, insets }
}

/**
 * Write a standard format's authoritative millimeters into an existing profile,
 * PRESERVING the profile's current insets.
 *
 * This is the "select a standard size" operation: it replaces `width`/`height`
 * with the catalog dimensions for `name` at `orientation` and carries the
 * profile's existing `insets` through unchanged. It persists no standard name or
 * orientation — those remain derivable via {@link matchStandardPaper} and
 * {@link derivePaperOrientation}. The input profile is not mutated.
 *
 * @param profile - The profile whose dimensions are being replaced.
 * @param name - The standard format to write.
 * @param orientation - Portrait (default) or landscape.
 * @returns A new profile with the catalog dimensions and the original insets.
 */
export function applyStandardPaper(
  profile: PlotProfile,
  name: StandardPaperName,
  orientation: PaperOrientation = 'portrait',
): PlotProfile {
  return standardPaperProfile(name, orientation, profile.insets)
}

/**
 * Match a profile's (or rectangle's) dimensions against the standard catalog,
 * ORIENTATION-INDEPENDENTLY.
 *
 * Compares the input's sorted `[min, max]` dimensions against each catalog
 * entry's sorted pair within {@link STANDARD_PAPER_MATCH_TOLERANCE_MM}, so a
 * landscape sheet matches the same standard as its portrait twin. A
 * {@link PlotProfile} may be passed directly — its insets are ignored.
 *
 * @param dimensions - A Plot Profile or a bare `{ width, height }` rectangle.
 * @returns The matching {@link StandardPaperName}, or `null` for a custom size.
 */
export function matchStandardPaper(
  dimensions: Dimensions,
): StandardPaperName | null {
  const [min, max] = sortedDimensions(dimensions)
  for (const name of STANDARD_PAPER_NAMES) {
    const [paperMin, paperMax] = sortedDimensions(STANDARD_PAPERS[name])
    if (
      Math.abs(min - paperMin) <= STANDARD_PAPER_MATCH_TOLERANCE_MM &&
      Math.abs(max - paperMax) <= STANDARD_PAPER_MATCH_TOLERANCE_MM
    ) {
      return name
    }
  }
  return null
}

/**
 * Derive the portrait/landscape orientation from a profile's (or rectangle's)
 * stored dimensions.
 *
 * `width > height` is landscape; everything else — including a SQUARE sheet — is
 * portrait. Orientation is never stored; it is always resolved this way.
 *
 * @param dimensions - A Plot Profile or a bare `{ width, height }` rectangle.
 * @returns `'landscape'` when wider than tall, otherwise `'portrait'`.
 */
export function derivePaperOrientation(
  dimensions: Dimensions,
): PaperOrientation {
  return dimensions.width > dimensions.height ? 'landscape' : 'portrait'
}

/**
 * Swap a Plot Profile's orientation by transposing WIDTH AND HEIGHT ONLY.
 *
 * Portrait/landscape is a convenience over the stored dimensions, so this returns
 * a new profile with `width`/`height` exchanged and the four `insets` carried
 * through UNCHANGED — the insets are not reordered — introducing no new stored
 * state. Swapping twice restores the original. The input profile is not mutated.
 *
 * @param profile - The profile to transpose.
 * @returns A new profile with transposed dimensions and the same insets.
 */
export function swapPlotOrientation(profile: PlotProfile): PlotProfile {
  return {
    width: profile.height,
    height: profile.width,
    insets: profile.insets,
  }
}

/**
 * Millimeters per inch — the exact conversion factor. Millimeters are the
 * canonical unit of the model; inches exist only as a display representation
 * derived through this factor.
 */
export const MM_PER_INCH = 25.4

/** Convert a scalar length from millimeters to inches. */
export function mmToInch(mm: number): number {
  return mm / MM_PER_INCH
}

/** Convert a scalar length from inches to millimeters. */
export function inchToMm(inch: number): number {
  return inch * MM_PER_INCH
}

/** Convert every inset with `convert`, returning a new {@link PlotInsets}. */
function convertInsets(
  insets: PlotInsets,
  convert: (value: number) => number,
): PlotInsets {
  return {
    top: convert(insets.top),
    right: convert(insets.right),
    bottom: convert(insets.bottom),
    left: convert(insets.left),
  }
}

/**
 * Produce an inch-valued VIEW of a Plot Profile for display at the model
 * boundary — width, height, and all four insets converted to inches.
 *
 * This is a DISPLAY transform, not a model change: the returned record's numbers
 * are inches, not canonical millimeters, so it must be shown/edited and then
 * mapped straight back with {@link plotProfileFromInches} — never persisted. The
 * input (canonical) profile is not mutated.
 *
 * @param profile - A canonical millimeter Plot Profile.
 * @returns A new profile whose dimensions and insets are expressed in inches.
 */
export function plotProfileToInches(profile: PlotProfile): PlotProfile {
  return {
    width: mmToInch(profile.width),
    height: mmToInch(profile.height),
    insets: convertInsets(profile.insets, mmToInch),
  }
}

/**
 * Map an inch-valued profile edit back to a canonical millimeter Plot Profile —
 * the inverse of {@link plotProfileToInches}.
 *
 * Converts width, height, and all four insets from inches to canonical
 * millimeters, returning a new record. Round-tripping a profile out to inches and
 * back returns to the canonical millimeter value within floating-point tolerance;
 * because both directions are pure, the stored model is never overwritten.
 *
 * @param profile - A profile whose numbers are inches (a display-space view).
 * @returns A new canonical millimeter Plot Profile.
 */
export function plotProfileFromInches(profile: PlotProfile): PlotProfile {
  return {
    width: inchToMm(profile.width),
    height: inchToMm(profile.height),
    insets: convertInsets(profile.insets, inchToMm),
  }
}
