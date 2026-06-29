/**
 * The Sketch contract — what a Sketch file exports.
 *
 * A Sketch is a Parameter Schema plus its frame logic. This module defines the
 * contract types only; concrete field formats are deliberately left to emerge
 * (see CONTEXT.md "Deliberately deferred").
 *
 * Two design decisions are load-bearing here:
 *
 * - ADR-0002: a Sketch's output is a pure function of `(params, seed, t)`. The
 *   stateless author writes `generate`; randomness flows from the explicit
 *   `Seed`, never from `Math.random()` or the clock.
 * - ADR-0003: a stateful (simulation) Sketch is a deterministic fold the Harness
 *   drives — `initial(params, seed)` + fixed-`dt` `step(state)` + `draw(state)`.
 *   The top-level `Sketch` type is therefore an OPEN union so that future
 *   stateful variant can join WITHOUT reworking the stateless path.
 */

import type { Scene } from './scene'

/**
 * The single value feeding all of a Sketch's internal randomness.
 *
 * This is the raw seed (the value a Preset captures), not a constructed RNG:
 * ADR-0002 says randomness "flows from the explicit Seed", and `createRandom`
 * turns a `string | number` seed into a {@link Random}. The Harness owns that
 * construction, so the contract stays in terms of the seed itself — keeping
 * `generate` and a future `initial` aligned on the same `(params, seed)` spine.
 */
export type Seed = string | number

/**
 * A numeric knob's declaration — a continuous (or whole-number) range with a
 * default. The only inhabited {@link ParamSpec} member today.
 *
 * `integer` and `step` are ORTHOGONAL and answer different questions:
 *
 * - `integer` is a VALUE-DOMAIN constraint: when `true`, the legal values of
 *   this param are whole numbers (the control panel and Randomize must only ever
 *   hand the Sketch an integer). It is about *which values are valid*.
 * - `step` is a UI DRAG-GRANULARITY HINT ONLY: how coarsely a slider/drag should
 *   advance. It says nothing about which values are legal. A `step` of 10 on a
 *   non-integer param is perfectly legal — it just means the UI nudges by 10
 *   while any real number in `[min, max]` remains a valid value.
 *
 * Because they are orthogonal, neither implies the other: an `integer` param may
 * omit `step`, and a `step` does not make a param integer.
 */
export interface NumberParamSpec {
  /** Discriminant. The open {@link ParamSpec} union is keyed on this. */
  kind: 'number'
  /** Inclusive lower bound of the legal range. */
  min: number
  /** Inclusive upper bound of the legal range. */
  max: number
  /** The value {@link defaultParams} seeds this knob with. */
  default: number
  /**
   * UI drag-granularity hint ONLY — how coarsely a slider advances. Does NOT
   * constrain which values are legal (see the type doc). Optional.
   */
  step?: number
  /**
   * VALUE-DOMAIN constraint: when `true`, only whole-number values are legal.
   * Orthogonal to {@link NumberParamSpec.step} (see the type doc). Optional;
   * absent ⇒ any real in `[min, max]` is legal.
   */
  integer?: boolean
}

/**
 * One tweakable knob's declaration within a {@link ParamSchema}.
 *
 * An OPEN union discriminated on `kind`, mirroring the open {@link Sketch} union
 * in this same file: today {@link NumberParamSpec} (`kind: 'number'`) is the
 * ONLY inhabited member, and future control kinds (boolean, color, enum, …) join
 * as new `kind`-tagged members WITHOUT reworking this one — purely additive. The
 * control panel, Lock, Randomize, and Preset shape are all derived views that
 * widen alongside the union, never against it.
 */
export type ParamSpec = NumberParamSpec

/**
 * The single declaration a Sketch makes of its tweakable knobs — the spine of
 * the Harness. The control panel, Lock toggles, Randomize, and Preset shape are
 * all derived views over this one schema.
 *
 * Modeled as a loose record keyed by param name, per the brief: keep the format
 * minimal and emergent rather than freezing it now.
 */
export type ParamSchema = Record<string, ParamSpec>

/**
 * The runtime param values handed to the frame logic — the inhabited form of a
 * {@link ParamSchema}. Kept open for the same reason `ParamSpec` is: the value
 * shape emerges alongside the schema field format.
 */
export type Params = Record<string, unknown>

/**
 * How the Harness should drive time `t` for a Sketch, declared alongside the
 * Parameter Schema (ADR-0002). Its ABSENCE means the Sketch is static — a single
 * frame, with no timeline.
 */
export interface TimeMetadata {
  /** Total length of one play-through, in seconds. */
  duration: number
  /**
   * Playback intent: `'loop'` seamlessly repeats (animation expressed as a
   * function of `t`, e.g. periodic noise), `'one-shot'` plays once and holds.
   */
  mode: 'loop' | 'one-shot'
}

/**
 * Fields every Sketch carries regardless of variant: its Parameter Schema and
 * optional time metadata. Shared base for the stateless/stateful members so the
 * union below only has to differ on the frame logic.
 */
export interface SketchBase {
  /**
   * Stable slug identifying this Sketch. ONE id serves two roles so they can
   * never drift: it is the navigation/URL slug the Studio selects by, AND the
   * slug naming the Sketch's preset folder on disk (`sketches/{id}/presets/`,
   * per CONTEXT.md). Unique across the registry; lowercase-slug form (e.g.
   * `"circles"`).
   */
  id: string
  /** Human-readable display label, shown in navigation (e.g. `"Circles"`). */
  name: string
  /** The Sketch's tweakable knobs — the spine of the Harness. */
  schema: ParamSchema
  /**
   * Optional time metadata. Absent ⇒ a static Sketch (ADR-0002); present ⇒ the
   * Harness drives `t` over `duration` with the given `mode`.
   */
  time?: TimeMetadata
}

/**
 * A stateless Sketch (ADR-0002): its entire output is a pure
 * `generate(params, seed, t) → Scene`. Same inputs, same frame, always — no
 * per-frame or cross-frame mutable state. The one function serves every caller
 * (live exploration, Remotion, plotter export); only how the Harness samples `t`
 * varies.
 */
export interface StatelessSketch extends SketchBase {
  /**
   * Produce the Scene at time `t` for the given params and seed.
   *
   * @param params - Inhabited param values for this Sketch's schema.
   * @param seed - The explicit Seed; all internal randomness derives from it.
   * @param t - Time in seconds; for a static Sketch (no `time`) callers pass 0.
   */
  generate(params: Params, seed: Seed, t: number): Scene
}

/**
 * The contract a Sketch file exports.
 *
 * An OPEN union (ADR-0003): today the only member is {@link StatelessSketch}.
 * A future `StatefulSketch` — the `initial(params, seed)` / fixed-`dt`
 * `step(state)` / `draw(state) → Scene` triple — joins this union WITHOUT
 * touching the stateless member: members are distinguished structurally
 * (a stateless Sketch has `generate`; a stateful one has `initial`/`step`/`draw`),
 * so adding the variant is purely additive.
 */
export type Sketch = StatelessSketch
