/**
 * Output Profile defaulting — the Harness fallback and the precedence resolver
 * (CONTEXT.md "Output Profile").
 *
 * The Plot Profile domain (`./plotProfile`) deliberately ships ONLY the record
 * shape, its validator, and the Composition Frame derivation; its header
 * disclaims "default/fallback resolution" as a sibling concern. This module is
 * that sibling: it names the Harness's terminal fallback profile and implements
 * the pure precedence a session uses to pick which Output Profile is in effect.
 *
 * The whole point is that resolution is a PURE FUNCTION with no memory: a session
 * never inherits another Sketch's last-selected dimensions. There is deliberately
 * NO module-level mutable / global / "last-selected" state here — the same inputs
 * always yield the same profile.
 *
 * There is no Video Profile model yet, so the only concrete Output Profile is a
 * {@link PlotProfile}; the fallback, the alias, and the resolver are all typed in
 * terms of `PlotProfile` rather than a speculative union. Widening to a real
 * Output Profile union is a later decision, made when a second member exists.
 */

import {
  type PlotProfile,
  validatePlotProfile,
} from './plotProfile'

/**
 * The concept an {@link resolveOutputProfile} call selects — the profile
 * describing the output a session composes into. A thin alias for
 * {@link PlotProfile}: the plot-target Plot Profile is the only concrete Output
 * Profile today, and this name marks the places that reason about "the Output
 * Profile in effect" rather than about plotting specifically. It gains members
 * (e.g. a future Video Profile) as a union only when a second one exists.
 */
export type OutputProfile = PlotProfile

/**
 * The Harness's terminal fallback Output Profile: a square `200 × 200 mm` sheet
 * with linked (symmetric) `10 mm` insets on all four edges (CONTEXT.md "Output
 * Profile" — "the Harness initially supplies a square 200 × 200 mm plot profile
 * with linked 10 mm insets").
 *
 * This is the profile {@link resolveOutputProfile} lands on when neither a
 * Preset's Output Profile nor a Sketch's declared default is present — the
 * bottom of the precedence chain, so a fresh session always has a well-defined,
 * Sketch-agnostic sheet rather than falling back to whatever was last selected.
 *
 * It validates clean through the #263 model ({@link validatePlotProfile} does
 * not throw on it): the `10 mm` insets are non-zero and symmetric, leaving a
 * positive `180 × 180 mm` drawable region.
 */
export const HARNESS_FALLBACK_PLOT_PROFILE: PlotProfile = {
  width: 200,
  height: 200,
  insets: { top: 10, right: 10, bottom: 10, left: 10 },
  includeFrame: true,
}

// Fail loudly at module load if the fallback ever drifts out of the #263 model's
// validity contract — a broken terminal fallback would corrupt every session.
validatePlotProfile(HARNESS_FALLBACK_PLOT_PROFILE)

/**
 * Resolve which Output Profile is in effect, by precedence (CONTEXT.md: "A
 * Preset's Output Profile wins on reload; otherwise a Sketch's declared default
 * wins, with the Harness's square default as the terminal fallback").
 *
 * PURE SELECTION ONLY — it returns the first present argument, else the Harness
 * fallback:
 *
 *   `presetProfile ?? sketchDefault ?? HARNESS_FALLBACK_PLOT_PROFILE`
 *
 * It does NOT validate or transform its inputs (validation is #263's / the
 * caller's concern) and closes over NO mutable state. Because it holds no
 * "last-selected" memory, calling it with a profile and then again with neither
 * argument returns the Harness fallback — never the previously-passed profile.
 * Wiring it in at the Preset (#266) and Studio session (#267) boundaries is a
 * sibling concern; this stays caller-agnostic.
 *
 * @param presetProfile - The Output Profile a loaded Preset captured, if any.
 *   Wins outright — a reloaded Preset restores its own dimensions.
 * @param sketchDefault - The Sketch's declared {@link SketchBase.defaultOutputProfile},
 *   if any. Used when no Preset profile is present.
 * @returns The `presetProfile` if present, else the `sketchDefault` if present,
 *   else {@link HARNESS_FALLBACK_PLOT_PROFILE}.
 */
export function resolveOutputProfile(
  presetProfile?: PlotProfile,
  sketchDefault?: PlotProfile,
): PlotProfile {
  return presetProfile ?? sketchDefault ?? HARNESS_FALLBACK_PLOT_PROFILE
}
