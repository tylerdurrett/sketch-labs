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
 * One tweakable knob's declaration within a {@link ParamSchema}.
 *
 * Deliberately open: the concrete field format (control kind, bounds, default,
 * lock metadata, …) is left to emerge during implementation — CONTEXT.md
 * "Deliberately deferred" calls out the Parameter Schema field format as not yet
 * frozen. An open record with `unknown` values: authoring code should treat a
 * `ParamSpec` as opaque for now, and the format can widen (never rework) as the
 * control panel, Lock, Randomize, and Preset shape derive their needs from it.
 */
export type ParamSpec = Record<string, unknown>

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
 * Forward declaration of the renderer-agnostic Scene IR.
 *
 * The real Scene type ("coordinate space + draw-ordered Primitives") is owned by
 * issue #26 and is not yet landed. This placeholder lets the Sketch contract
 * compile and name its return type now; replace this with the re-exported Scene
 * once the IR lands. Kept structurally empty on purpose so nothing accidentally
 * depends on a guessed shape.
 */
// TODO(#26): replace with the real Scene IR once the Scene/Primitive record
// shape lands; this is a sanctioned thin forward declaration.
export type Scene = Record<string, unknown>

/**
 * Fields every Sketch carries regardless of variant: its Parameter Schema and
 * optional time metadata. Shared base for the stateless/stateful members so the
 * union below only has to differ on the frame logic.
 */
export interface SketchBase {
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
