/**
 * The Sketch contract — what a Sketch file exports.
 *
 * A Sketch is a Parameter Schema plus its frame logic. This module defines the
 * contract types only; reusable source-field sampling lives separately in
 * `shadingFields.ts` (ADR-0013).
 *
 * Two design decisions are load-bearing here:
 *
 * - ADR-0002: a Sketch's output is a pure function of its explicit generation
 *   inputs. The stateless author writes `generate`; randomness flows from the
 *   explicit `Seed`, never from `Math.random()` or the clock, and the drawable
 *   rectangle arrives as an explicit {@link CoordinateSpace} Composition Frame
 *   rather than being self-declared by the Sketch. ADR-0014 adds only an optional
 *   synchronous environment of pre-resolved immutable inputs; fetching and
 *   decoding remain outside the pure generation call.
 * - ADR-0003: a stateful (simulation) Sketch is a deterministic fold the Harness
 *   drives — `initial(params, seed)` + fixed-`dt` `step(state)` + `draw(state)`.
 *   The top-level `Sketch` type is therefore an OPEN union so that future
 *   stateful variant can join WITHOUT reworking the stateless path — and, when it
 *   does, it receives the SAME Composition Frame the stateless seam now takes.
 *
 * The Composition Frame (CONTEXT.md "Composition Frame"; ADR-0012) is the
 * scale-independent, aspect-bearing drawable rectangle the Sketch composes into.
 * It is threaded through the generation seam as an explicit argument so the frame
 * — not any Sketch-declared metadata — is the single source of layout truth. A
 * Sketch that has not yet been taught to compose inside an arbitrary frame simply
 * ignores it and keeps baking into its historical `1000 × 1000` extent; callers
 * that have no real frame yet pass {@link DEFAULT_COMPOSITION_FRAME}.
 */

import type { SketchEnvironment } from './imageAssets'
import type { DetailField } from './detailFields'
import type { PlotProfile } from './plotProfile'
import type { CoordinateSpace, Scene } from './scene'
import type { ShadingTermination } from './shadingStrategy'
import {
  penLiftCount,
  polylineCount,
  totalPathLength,
} from './shadingStrategy'
import type { ToneSource } from './shadingFields'
import type {
  ScribbleObserver,
  ScribbleResult,
} from './scribbleStrategy/index'

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
 * One narrow applicability dependency between parameters.
 *
 * The named controller must be a Choice parameter in the same schema and
 * `equals` must be one of that Choice's declared stable option values. The rule
 * is deliberately direct and nonrecursive: a dependent's activity is decided
 * only by the controller's current value, even when that controller has an
 * applicability rule of its own.
 */
export interface ParamActiveWhen {
  /** Schema key of the Choice parameter that controls applicability. */
  key: string
  /** Stable Choice option value for which this parameter is active. */
  equals: string
}

/**
 * A numeric knob's declaration — a continuous (or whole-number) range with a
 * default. The founding {@link ParamSpec} member (issue #47), joined by
 * {@link ColorParamSpec}, {@link ImageAssetParamSpec}, and
 * {@link ChoiceParamSpec}.
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
  /** Optional direct Choice dependency controlling this parameter's activity. */
  activeWhen?: ParamActiveWhen
}

/**
 * A color knob's declaration — a CSS hex color string with a default.
 *
 * VALUE DOMAIN: the value (and the `default`) is a canonical 7-character hex
 * CSS color string like `'#1a2b3c'`. The Studio-owned picker converts its visual
 * surface and integer RGB fields to and from this one representation, keeping
 * param equality, Preset round-trips, and reproduction metadata deterministic.
 * Any downstream consumer (Canvas2D `fillStyle`, SVG `fill`) accepts hex natively.
 *
 * Randomize NEVER rolls a color (see {@link randomize}): a color is a deliberate
 * aesthetic choice, not a bounded numeric range to explore, so it passes through
 * every roll unchanged — locked or not (ADR-0010).
 */
export interface ColorParamSpec {
  /** Discriminant. The open {@link ParamSpec} union is keyed on this. */
  kind: 'color'
  /**
   * The hex color string {@link defaultParams} seeds this knob with, e.g.
   * `'#1a2b3c'` (see the type doc for why the domain is hex).
   */
  default: string
  /** Optional direct Choice dependency controlling this parameter's activity. */
  activeWhen?: ParamActiveWhen
}

/**
 * An Image Asset knob's declaration — a stable logical asset ID with a default.
 *
 * The string is an identity, never a file path or decoded raster payload. Core
 * intentionally does not validate or resolve it here: the Parameter Schema and
 * Preset spine must preserve even an unavailable ID verbatim so a caller never
 * reproduces different bytes by silently substituting another asset.
 *
 * Randomize NEVER changes an Image Asset selection (see {@link randomize}). Like
 * a color, it has no numeric range to sample; its current string passes through
 * every roll unchanged, whether or not a generic persisted Lock names it.
 */
export interface ImageAssetParamSpec {
  /** Discriminant. The open {@link ParamSpec} union is keyed on this. */
  kind: 'image-asset'
  /** The stable logical Image Asset ID seeded by {@link defaultParams}. */
  default: string
  /** Optional direct Choice dependency controlling this parameter's activity. */
  activeWhen?: ParamActiveWhen
}

/**
 * One stable, user-facing option in a {@link ChoiceParamSpec}.
 *
 * `value` is the deterministic value stored in Params and Presets. `label` is
 * presentation only: changing a label must not migrate persisted state, while a
 * value must remain stable once published.
 */
export interface ChoiceOption {
  /** Stable string identity stored as the inhabited parameter value. */
  value: string
  /** Human-readable text exposed by schema-derived controls. */
  label: string
}

/**
 * A lock-free selection from a finite set of stable, labelled string values.
 *
 * Choice options are authored in display order. Their values are unique stable
 * identities; labels are presentation text and therefore need not be unique.
 * The default must name one declared option. Call
 * {@link validateChoiceParamSpec} at runtime boundaries before consuming a
 * declaration that did not originate in type-checked source.
 */
export interface ChoiceParamSpec {
  /** Discriminant. The open {@link ParamSpec} union is keyed on this. */
  kind: 'choice'
  /** Nonempty, ordered set of labelled stable values. */
  options: readonly ChoiceOption[]
  /** The declared option value seeded by {@link defaultParams}. */
  default: string
  /** Optional direct Choice dependency controlling this parameter's activity. */
  activeWhen?: ParamActiveWhen
}

/**
 * One tweakable knob's declaration within a {@link ParamSchema}.
 *
 * An OPEN union discriminated on `kind`, mirroring the open {@link Sketch} union
 * in this same file: {@link NumberParamSpec} (`kind: 'number'`, the founding
 * member, issue #47), {@link ColorParamSpec} (`kind: 'color'`, the first
 * non-numeric widening, ADR-0010), {@link ImageAssetParamSpec}
 * (`kind: 'image-asset'`), and {@link ChoiceParamSpec} (`kind: 'choice'`) are the
 * inhabited members today. Future control kinds join as new `kind`-tagged
 * members WITHOUT reworking these —
 * purely additive. The control panel, Randomize, and Preset shape are derived
 * views that widen alongside the union; affordances such as numeric-only Lock
 * remain meaningful only for the kinds they affect.
 */
export type ParamSpec =
  | NumberParamSpec
  | ColorParamSpec
  | ImageAssetParamSpec
  | ChoiceParamSpec

/**
 * The single declaration a Sketch makes of its tweakable knobs — the spine of
 * the Harness. The control panel, applicable Lock toggles, Randomize, and Preset
 * shape are all derived views over this one schema.
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
 * Validate the Choice-specific declaration invariants at a runtime boundary.
 *
 * This deliberately does not validate Number, Color, or Image Asset specs: it
 * is the narrow loud boundary needed by Choice consumers, not a retrofit of new
 * semantics onto the existing parameter kinds.
 *
 * @param spec - The Choice declaration to validate.
 * @param key - Optional schema key included in diagnostics.
 * @throws If options are empty or malformed, option values repeat, or the
 *   default is not one of the declared values.
 */
export function validateChoiceParamSpec(
  spec: ChoiceParamSpec,
  key = '<choice>',
): void {
  if (!Array.isArray(spec.options) || spec.options.length === 0) {
    throw new Error(`Choice param \`${key}\` must declare at least one option`)
  }

  const values = new Set<string>()
  for (const [index, option] of spec.options.entries()) {
    if (
      typeof option !== 'object' ||
      option === null ||
      typeof option.value !== 'string' ||
      option.value.trim().length === 0
    ) {
      throw new Error(
        `Choice param \`${key}\` option ${index} must have a nonempty string value`,
      )
    }
    if (typeof option.label !== 'string' || option.label.trim().length === 0) {
      throw new Error(
        `Choice param \`${key}\` option ${index} must have a nonempty string label`,
      )
    }
    if (values.has(option.value)) {
      throw new Error(
        `Choice param \`${key}\` has duplicate option value \`${option.value}\``,
      )
    }
    values.add(option.value)
  }

  if (typeof spec.default !== 'string' || !values.has(spec.default)) {
    throw new Error(
      `Choice param \`${key}\` default must be one of its declared option values`,
    )
  }
}

/**
 * Validate and return one present runtime value for a Choice declaration.
 *
 * The declaration is checked first via {@link validateChoiceParamSpec}; the
 * value must then be a string identity from its option set. Missing-value
 * fallback is intentionally not handled here because only a Params-aware caller
 * can distinguish an absent key from an explicitly present invalid value.
 *
 * @param spec - The Choice declaration whose option set defines the domain.
 * @param value - The explicitly present runtime value to validate.
 * @param key - Optional schema key included in diagnostics.
 * @returns The validated value, narrowed to the declaration's option values.
 * @throws If the declaration is malformed or the value is not declared.
 */
export function validateChoiceParamValue<Spec extends ChoiceParamSpec>(
  spec: Spec,
  value: unknown,
  key = '<choice>',
): Spec['options'][number]['value'] {
  validateChoiceParamSpec(spec, key)
  if (
    typeof value !== 'string' ||
    !spec.options.some((option) => option.value === value)
  ) {
    throw new Error(
      `Choice param \`${key}\` value must be one of its declared option values`,
    )
  }
  return value as Spec['options'][number]['value']
}

/**
 * Validate the Choice and applicability invariants of a Parameter Schema.
 *
 * This is intentionally a narrow boundary: it validates Choice declarations
 * and `activeWhen` relationships only. It does not add runtime validation for
 * the established Number, Color, or Image Asset value domains.
 *
 * @param schema - The complete Parameter Schema whose relationships to check.
 * @throws If a Choice declaration is malformed, or an `activeWhen` controller
 *   is missing, is not a Choice, names the dependent itself, or compares to an
 *   undeclared stable option value.
 */
export function validateParamSchema(schema: ParamSchema): void {
  for (const [key, spec] of Object.entries(schema)) {
    if (spec.kind === 'choice') validateChoiceParamSpec(spec, key)
    validateParamApplicability(schema, key, spec)
  }
}

/** Validate one spec's direct applicability relationship. */
function validateParamApplicability(
  schema: ParamSchema,
  key: string,
  spec: ParamSpec,
): void {
  const dependency = spec.activeWhen
  if (dependency === undefined) return

  if (typeof dependency !== 'object' || dependency === null) {
    throw new Error(`Param \`${key}\` activeWhen must be an object`)
  }
  if (typeof dependency.key !== 'string' || dependency.key.length === 0) {
    throw new Error(`Param \`${key}\` activeWhen key must name a parameter`)
  }
  if (dependency.key === key) {
    throw new Error(`Param \`${key}\` activeWhen cannot reference itself`)
  }

  if (!Object.prototype.hasOwnProperty.call(schema, dependency.key)) {
    throw new Error(
      `Param \`${key}\` activeWhen references missing controller \`${dependency.key}\``,
    )
  }
  const controller = schema[dependency.key]!
  if (controller.kind !== 'choice') {
    throw new Error(
      `Param \`${key}\` activeWhen controller \`${dependency.key}\` must be a Choice param`,
    )
  }

  validateChoiceParamSpec(controller, dependency.key)
  if (
    typeof dependency.equals !== 'string' ||
    !controller.options.some((option) => option.value === dependency.equals)
  ) {
    throw new Error(
      `Param \`${key}\` activeWhen equals must be a declared option of Choice param \`${dependency.key}\``,
    )
  }
}

/**
 * Report whether one parameter is applicable for the current complete Params.
 *
 * Parameters without `activeWhen` are always active. A dependent uses exact
 * equality against its direct Choice controller's validated current value. If
 * that controller key is absent from Params, its validated schema default is
 * used. The controller's own applicability is never traversed.
 *
 * @param schema - The complete Parameter Schema.
 * @param params - Current values; read only and never completed or mutated.
 * @param key - Schema key whose activity to evaluate.
 * @returns Whether the parameter is active.
 * @throws If `key`, its applicability relationship, the Choice declaration, or
 *   a present Choice value is malformed.
 */
export function isParamActive(
  schema: ParamSchema,
  params: Params,
  key: string,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(schema, key)) {
    throw new Error(`Unknown param \`${key}\``)
  }
  const spec = schema[key]!

  validateParamApplicability(schema, key, spec)
  const dependency = spec.activeWhen
  if (dependency === undefined) return true

  const controller = schema[dependency.key] as ChoiceParamSpec
  let controllerValue: string
  if (Object.prototype.hasOwnProperty.call(params, dependency.key)) {
    controllerValue = validateChoiceParamValue(
      controller,
      params[dependency.key],
      dependency.key,
    )
  } else {
    validateChoiceParamSpec(controller, dependency.key)
    controllerValue = controller.default
  }

  return controllerValue === dependency.equals
}

/**
 * Project the current Params down to the schema keys that are active.
 *
 * The projection iterates the schema's own enumerable keys, preserving schema
 * order and excluding Params-only extras. Present non-Choice values are copied
 * exactly; an absent value falls back to its spec default. Present Choice values
 * pass through the same loud declared-option validation as other Choice
 * consumers. The schema and input Params are only read, and the result is a new
 * object.
 *
 * @param schema - The complete Parameter Schema and ordering authority.
 * @param params - Current parameter values; never mutated.
 * @returns A fresh Params object containing only active schema keys.
 * @throws If a Choice declaration/value or applicability relationship is
 *   malformed.
 */
export function activeParams(schema: ParamSchema, params: Params): Params {
  validateParamSchema(schema)
  const choiceValues = new Map<string, string>()
  for (const [key, spec] of Object.entries(schema)) {
    if (
      spec.kind === 'choice' &&
      Object.prototype.hasOwnProperty.call(params, key)
    ) {
      choiceValues.set(key, validateChoiceParamValue(spec, params[key], key))
    }
  }

  const entries: [string, unknown][] = []

  for (const [key, spec] of Object.entries(schema)) {
    if (!isParamActive(schema, params, key)) continue

    let value: unknown
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      value = spec.kind === 'choice' ? choiceValues.get(key)! : params[key]
    } else {
      value = spec.default
    }
    entries.push([key, value])
  }

  return Object.fromEntries(entries)
}

/**
 * Derive the inhabited default params from a schema: every key set to its spec's
 * `default`. Pure and headless — the first of the core engine functions
 * (randomize / newSeed are siblings), and the value the Harness starts a Sketch
 * from before any Randomize or Preset is applied.
 *
 * @param schema - The Sketch's Parameter Schema.
 * @returns A {@link Params} with one entry per schema key, each its spec default.
 */
export function defaultParams(schema: ParamSchema): Params {
  validateParamSchema(schema)
  const params: Params = {}
  for (const [key, spec] of Object.entries(schema)) {
    params[key] = spec.default
  }
  return params
}

/**
 * Roll a fresh set of param values, leaving locked and non-rolled keys untouched
 * — the engine behind the Studio's Randomize button. Pure and headless, a sibling
 * of {@link defaultParams}; the randomness arrives INJECTED as `rand` so the
 * function is deterministically testable (tests pass a scripted stub; the Studio
 * later passes a `Math.random`-backed one — same shape as `value()` in
 * `random.ts`).
 *
 * For each schema key whose spec is a numeric param (`kind === 'number'`), is
 * active according to {@link isParamActive}, AND is NOT locked, a new value is
 * rolled uniformly across the spec's `[min, max]` via
 * `min + rand() * (max - min)`, then `Math.round`ed iff the spec's `integer` is
 * `true`. Inactive numeric values consume no randomness and pass through
 * unchanged. The spec's `step` is IGNORED — `step` is a UI drag-granularity
 * hint, not a value-domain constraint (see {@link NumberParamSpec}).
 *
 * Everything else passes through from `params` UNCHANGED: locked params (Lock is
 * Randomize-exclusion only), and any non-numeric spec the `kind` check doesn't
 * roll. For `kind: 'color'` this pass-through is a STATED CONTRACT, not an
 * accident of the implementation (ADR-0010): a color is a deliberate aesthetic
 * choice, not a numeric range. The same is true for `kind: 'image-asset'`: its
 * string is a stable asset selection, so Randomize must never replace it. A
 * `kind: 'choice'` value likewise represents an explicit selection and never
 * rolls. Thus Randomize is numeric-only for now and all three string-valued
 * kinds survive every roll untouched, locked or not. (A future palette or
 * asset-selection mechanism would be its own decision.) The narrow
 * `activeWhen` rule controls only numeric Randomize eligibility; there are no
 * broader cross-param constraints (CONTEXT.md "Deliberately deferred"), and a
 * Sketch still owns its own inter-param coherence inside `generate`.
 *
 * @param schema - The Sketch's Parameter Schema.
 * @param params - The current inhabited param values; NOT mutated.
 * @param locks - The generic set of locked param keys; only READ (the Studio
 *   owns the lock state). A locked numeric key keeps its current value. A
 *   persisted color, Image Asset, or Choice key is harmless and inert because
 *   all three kinds already pass through every roll; callers need not filter or
 *   migrate it. Choice controls themselves expose no Lock affordance.
 * @param rand - Injected uniform `[0, 1)` source (matches `value()` in
 *   `random.ts`).
 * @returns A NEW {@link Params}; unlocked numeric keys re-rolled, the rest as-is.
 */
export function randomize(
  schema: ParamSchema,
  params: Params,
  locks: ReadonlySet<string>,
  rand: () => number,
): Params {
  validateParamSchema(schema)
  for (const [key, spec] of Object.entries(schema)) {
    if (
      spec.kind === 'choice' &&
      Object.prototype.hasOwnProperty.call(params, key)
    ) {
      validateChoiceParamValue(spec, params[key], key)
    }
  }

  const next: Params = { ...params }
  for (const [key, spec] of Object.entries(schema)) {
    if (locks.has(key)) continue
    if (spec.kind === 'number' && isParamActive(schema, params, key)) {
      const rolled = spec.min + rand() * (spec.max - spec.min)
      next[key] = spec.integer ? Math.round(rolled) : rolled
    }
  }
  return next
}

/**
 * Produce a fresh random {@link Seed} — the engine behind the Studio's re-seed
 * ("roll the dice on the arrangement"). Pure and headless, a sibling of
 * {@link defaultParams}, with randomness INJECTED as `rand` for the same
 * deterministic-testability reason as {@link randomize}.
 *
 * Returns a RANDOM integer (not monotonic): `alea` takes a number seed natively,
 * and re-seeding is meant to land somewhere new, not advance a counter. Re-seeding
 * is INDEPENDENT of Randomize — a new seed reshuffles a Sketch's internal
 * randomness while leaving every param value untouched.
 *
 * @param rand - Injected uniform `[0, 1)` source (matches `value()` in
 *   `random.ts`).
 * @returns A fresh numeric {@link Seed}.
 */
export function newSeed(rand: () => number): Seed {
  return Math.floor(rand() * Number.MAX_SAFE_INTEGER)
}

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
 * Physical output-tool values available to an opt-in Outline representation.
 *
 * The tool remains fixed in millimeters while the mapping states how many
 * millimeters one unit of the current Composition Frame occupies. Keeping both
 * values explicit makes a specialized source generator deterministic and keeps
 * physical-output policy out of live Fill sampling.
 *
 * An Outline source hook may use this target to change stroke width only. Every
 * emitted stroked Primitive must use exactly
 * `toolWidthMillimeters / millimetersPerSceneUnit`; stroke presence and color,
 * coordinate space, geometry, primitive order, closure, fills, background, and
 * `hiddenLineRole` values must be invariant across valid targets. This makes the
 * hook an explicit physical-tool opt-in: completed Hidden-line geometry and its
 * invariant styling can be retained while finalization applies a newer width.
 * Sketches without either Outline source hook remain legacy Scene sources and
 * make no such retargeting guarantee.
 */
export interface OutlineTarget {
  readonly toolWidthMillimeters: number
  readonly millimetersPerSceneUnit: number
}

/** Scalar diagnostics for one complete Scribble artwork preparation. */
export interface ScribbleDiagnostics {
  /** Truthful convergence or deterministic safety-budget stop condition. */
  readonly termination: ShadingTermination
  /** Remaining normalized source error after the last accepted segment. */
  readonly residualError: number
  /** Sum of Scribble segment lengths in Composition Frame units. */
  readonly pathLength: number
  /** Number of generated Scribble polylines, excluding structural artwork. */
  readonly polylineCount: number
  /** Pen lifts between generated Scribble polylines. */
  readonly penLiftCount: number
}

/** One complete Scene plus compact diagnostics, without duplicate geometry. */
export interface ScribbleArtwork {
  readonly scene: Scene
  readonly diagnostics: ScribbleDiagnostics
}

/** Derive immutable scalar diagnostics from a completed Scribble pass. */
export function createScribbleDiagnostics(
  result: Readonly<ScribbleResult>,
): ScribbleDiagnostics {
  return Object.freeze({
    termination: result.termination,
    residualError: result.residualError,
    pathLength: totalPathLength(result.polylines),
    polylineCount: polylineCount(result.polylines),
    penLiftCount: penLiftCount(result.polylines),
  })
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
  /**
   * Optional default Output Profile this Sketch declares (CONTEXT.md "Output
   * Profile"). A {@link PlotProfile} today — the only concrete Output Profile —
   * naming the physical sheet the Sketch is authored to plot onto.
   *
   * Purely ADDITIVE and open-union-safe (ADR-0003): a Sketch that omits it
   * (circles, scatter, flow-field, leaf-field) keeps compiling unchanged, and its
   * absence simply means `resolveOutputProfile` (see `./outputProfile`) falls
   * through to the Harness's square fallback. It participates ONLY as a
   * precedence input — a Preset's captured Output Profile still wins on reload;
   * this declared default wins otherwise, with the Harness fallback terminal.
   * Nothing here selects or validates the profile; that is the resolver's and
   * the caller's concern.
   */
  defaultOutputProfile?: PlotProfile
  /**
   * Optionally produce deterministic source fields for a Tone reference or a
   * reusable Shading Strategy.
   *
   * Seed, time, output resolution, and physical-output values are deliberately
   * absent. The target is authored only from Parameter Schema values and the
   * scale-independent Composition Frame, so re-seeding may vary future strategy
   * geometry without changing what that strategy is asked to match. A final
   * environment argument may synchronously expose Image Assets that the caller
   * already resolved and decoded; no fetching or decoding enters this hook.
   */
  generateToneSource?(
    params: Params,
    frame: CoordinateSpace,
    environment?: SketchEnvironment,
  ): ToneSource
  /**
   * Optionally produce deterministic local visual detail for a diagnostic view
   * or a source-side strategy adapter.
   *
   * Like the Tone-source seam, this hook depends only on schema params, the
   * Composition Frame, and synchronous pre-resolved environment inputs. Seed,
   * time, output resolution, and physical-output values are deliberately
   * absent, and fetching, decoding, or analysis must not happen here.
   */
  generateDetailField?(
    params: Params,
    frame: CoordinateSpace,
    environment?: SketchEnvironment,
  ): DetailField
}

/**
 * A stateless Sketch (ADR-0002): its entire output is a pure
 * `generate(params, seed, t, frame, environment?) → Scene`. Same inputs, same
 * frame, always — no per-frame or cross-frame mutable state. An optional
 * environment contains only synchronous, pre-resolved immutable inputs; async
 * loading remains the caller's concern (ADR-0014). The one function serves every
 * caller (live exploration, Remotion, plotter export); only how the Harness
 * samples `t`, which Composition Frame it supplies, and which assets it resolves
 * vary.
 */
export interface StatelessSketch extends SketchBase {
  /**
   * Produce the Scene at time `t` for the given params, seed, and Composition
   * Frame.
   *
   * @param params - Inhabited param values for this Sketch's schema.
   * @param seed - The explicit Seed; all internal randomness derives from it.
   * @param t - Time in seconds; for a static Sketch (no `time`) callers pass 0.
   * @param frame - The Composition Frame: the drawable rectangle to compose into.
   *   The source of layout truth; callers with no real frame yet pass
   *   {@link DEFAULT_COMPOSITION_FRAME}.
   * @param environment - Optional synchronous, pre-resolved Harness inputs.
   */
  generate(
    params: Params,
    seed: Seed,
    t: number,
    frame: CoordinateSpace,
    environment?: SketchEnvironment,
  ): Scene

  /**
   * Optionally prepare this Sketch's complete Scribble-backed artwork.
   *
   * The observer is diagnostic only. Implementations return the same complete
   * Scene as cold `generate`, alongside scalar Scribble metrics; they do not
   * duplicate the generated polylines outside the Scene.
   */
  generateScribbleArtwork?(
    params: Params,
    seed: Seed,
    frame: CoordinateSpace,
    observer?: ScribbleObserver,
    environment?: SketchEnvironment,
  ): ScribbleArtwork

  /**
   * Optionally split time-invariant preparation from repeated sampling in `t`.
   *
   * The Composition Frame and optional environment are time-invariant, so they
   * join the `(params, seed)` prep spine and are captured when the sampler is
   * built. The returned sampler is owned by the caller that requested it. It
   * must remain a pure function of `t`: preparation may retain immutable data
   * derived from `(params, seed, frame, environment)`, but it may not accumulate
   * frame-to-frame state. Callers that sample sequentially can retain one sampler
   * until params, seed, frame, or resolved environment inputs change;
   * random-access callers can continue using {@link generate} unchanged.
   */
  prepare?(
    params: Params,
    seed: Seed,
    frame: CoordinateSpace,
    environment?: SketchEnvironment,
  ): PreparedFrame

  /**
   * Optionally opt into a physical-tool-aware source Scene for on-demand
   * Outline processing.
   *
   * The result is still generic Scene geometry: explicit `hiddenLineRole`
   * values describe sources and occluders, and the Harness's ordinary
   * Hidden-line pass produces the completed stroke-only Scene. The
   * {@link OutlineTarget} may affect stroke width only. Every emitted stroke
   * must use its exact physical-width quotient; stroke presence and color,
   * geometry, primitive order, closure, fills, background, and Hidden-line roles
   * must be invariant across valid targets. This hook never runs in the live Fill
   * loop. Sketches that omit both Outline source hooks retain the non-opt-in
   * legacy behavior of processing their sampled Fill Scene directly.
   */
  generateOutlineSource?(
    params: Params,
    seed: Seed,
    t: number,
    frame: CoordinateSpace,
    target: OutlineTarget,
    environment?: SketchEnvironment,
  ): Scene

  /**
   * Optionally derive an Outline source from artwork a prepared consumer has
   * already completed.
   *
   * Unlike {@link generateOutlineSource}, this capability receives the exact
   * completed Scene instead of the inputs that could regenerate it. It is for
   * caller-owned preparation paths such as Scribble, where the prepared result
   * is the authoritative artwork and must not be rerun or substituted while
   * applying physical-tool styling. As with {@link generateOutlineSource}, the
   * target may affect stroke width only: every emitted stroke uses the exact
   * physical-width quotient, while stroke presence and color, geometry, and
   * Hidden-line semantics remain invariant across valid targets. The returned
   * Scene still enters the same generic Hidden-line pass as every other Outline
   * source.
   */
  deriveOutlineSource?(
    completedScene: Readonly<Scene>,
    target: OutlineTarget,
  ): Scene
}

/**
 * A caller-owned, deterministic sampler for one fixed
 * `(params, seed, frame, environment)` input. The Composition Frame and any
 * resolved environment inputs are captured when the sampler is built, so the
 * sampler stays a pure function of `t` alone.
 */
export type PreparedFrame = (t: number) => Scene

/** A stateless Sketch that provides the optional prepared-frame fast path. */
export interface PreparedStatelessSketch extends StatelessSketch {
  prepare(
    params: Params,
    seed: Seed,
    frame: CoordinateSpace,
    environment?: SketchEnvironment,
  ): PreparedFrame
}

/**
 * Define a prepared stateless Sketch without duplicating cold and warm frame logic.
 *
 * `generate(params, seed, t, frame, environment)` is derived mechanically as
 * `prepare(params, seed, frame, environment)(t)`. The public ADR-0002 contract
 * therefore remains the source of truth for every random-access caller, while
 * sequential Harness callers can explicitly retain the prepared sampler. No
 * cache lives in the Sketch. When no environment is supplied, the adapter keeps
 * the historical three-argument `prepare` invocation exactly; this preserves
 * compatibility with existing implementations, spies, and call-boundary code.
 */
export function definePreparedSketch(
  definition: SketchBase &
    Pick<
      StatelessSketch,
      | 'deriveOutlineSource'
      | 'generateOutlineSource'
      | 'generateScribbleArtwork'
    > & {
      prepare(
        params: Params,
        seed: Seed,
        frame: CoordinateSpace,
        environment?: SketchEnvironment,
      ): PreparedFrame
    },
): PreparedStatelessSketch {
  return {
    ...definition,
    generate(params, seed, t, frame, environment) {
      return (environment === undefined
        ? definition.prepare(params, seed, frame)
        : definition.prepare(params, seed, frame, environment))(t)
    },
  }
}

/**
 * Prepare any current stateless Sketch for repeated sampling.
 *
 * Sketches without a specialized preparation seam receive a zero-state adapter
 * over their existing `generate`; prepared Sketches hand back their optimized,
 * caller-owned sampler. Either path has identical observable frame semantics. The
 * Composition Frame and optional pre-resolved environment are captured here and
 * threaded to both paths. The absent-environment path retains the historical
 * three-argument `prepare` and four-argument `generate` invocation arities.
 */
export function prepareSketch(
  sketch: StatelessSketch,
  params: Params,
  seed: Seed,
  frame: CoordinateSpace,
  environment?: SketchEnvironment,
): PreparedFrame {
  const prepared =
    environment === undefined
      ? sketch.prepare?.(params, seed, frame)
      : sketch.prepare?.(params, seed, frame, environment)
  if (prepared !== undefined) return prepared

  return environment === undefined
    ? (t) => sketch.generate(params, seed, t, frame)
    : (t) => sketch.generate(params, seed, t, frame, environment)
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
 *
 * The Composition Frame reaches the stateful seam the same way it reaches the
 * stateless one: `initial(params, seed, frame)` receives it alongside the
 * `(params, seed)` spine (the frame is time-invariant, so it belongs to
 * initialization, not `step`), and every `draw(state)` composes into that same
 * frame. The stateful variant is NOT implemented here — this is the reserved
 * contract only.
 */
export type Sketch = StatelessSketch
