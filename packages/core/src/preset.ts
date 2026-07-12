/**
 * The Preset model — a self-describing envelope that reproduces a Sketch frame
 * and resumes a Studio session.
 *
 * Pure and headless: no DOM, no `fetch`, no `JSON.parse` coupling. It mirrors
 * the injected-purity style of `randomize` / `newSeed` in `sketch.ts` — a
 * sibling of the core engine functions, testable without a browser. Persisting
 * a Preset to disk and reading it back are the Studio's / Remotion's concern;
 * this module owns only the in-memory record shape and the schema-authoritative
 * reconcile that BOTH callers must run identically (which is exactly why it
 * lives in `core`, not in either consumer).
 *
 * Two ideas are load-bearing across every export here:
 *
 * - ADR-0002 determinism spine: `seed` + `params` reproduce the image. A Preset
 *   captures the raw {@link Seed} (not a constructed RNG) plus the inhabited
 *   {@link Params}, so applying it re-renders the exact same frame.
 * - Exact-image fidelity beats clamping. {@link applyPreset} loads values
 *   AS-IS, never re-clamping to the schema's `[min, max]` — silently snapping a
 *   stored value would reproduce a DIFFERENT frame than the one the Preset was
 *   saved from, defeating the entire point of a Preset.
 */

import {
  normalizePlotProfile,
  type LegacyPlotProfile,
  type PlotProfile,
} from './plotProfile'
import type { Params, ParamSchema, Seed } from './sketch'

/**
 * The current (and maximum) Preset schema version — the profile-bearing shape.
 *
 * `version` is the migration escape hatch: every persisted Preset carries it so
 * a shape change can be detected and reconciled rather than silently mis-read.
 * Two versions exist:
 *
 * - `1` — the original six-field envelope, carrying NO active Output Profile.
 * - `2` — that envelope PLUS one active {@link PlotProfile} (`profile`).
 *
 * The version TRACKS the presence of the profile: `profile` present ⇔
 * `version === 2`. There is no "v2 without a profile" and no "v1 with a profile"
 * state — {@link makePreset} stamps the version from whether a profile was
 * supplied, and {@link deserialize} enforces the invariant both ways. New
 * records take {@link PRESET_VERSION} (`2`) when a profile is supplied; old v1
 * records still load, surfacing the profile as absent.
 */
export const PRESET_VERSION = 2

/**
 * A persisted Preset record — the self-describing envelope.
 *
 * Everything needed to (a) reproduce the image and (b) resume the session:
 *
 * - `seed` + `params` are the ADR-0002 determinism spine — together they
 *   re-render the exact frame the Preset was saved from.
 * - `locks` is a SORTED list of param keys. It resumes the session (which knobs
 *   were pinned against Randomize) and DOES NOT affect the rendered frame —
 *   Lock is Randomize-exclusion only (see `randomize` in `sketch.ts`). Sorted so
 *   the serialized form is stable/diffable regardless of Set iteration order.
 * - `sketch` is the Sketch id slug (the `SketchBase.id` that also names the
 *   on-disk preset folder); `name` is this Preset's record name / filename stem.
 * - `version` is the migration escape hatch (`1` or {@link PRESET_VERSION}).
 * - `profile` is the OPTIONAL active Output Profile (a {@link PlotProfile}). It
 *   is present exactly on a v2 record and absent on a v1 record — the version
 *   TRACKS its presence (`profile` present ⇔ `version === 2`).
 */
export interface Preset {
  /**
   * The migration escape hatch — `1` (no profile) or {@link PRESET_VERSION}
   * (`2`, carries a `profile`). The value equals `2` iff `profile` is present.
   */
  version: 1 | 2
  /** The Sketch id slug this Preset belongs to (matches `SketchBase.id`). */
  sketch: string
  /** This Preset's record name / filename stem. */
  name: string
  /** The explicit {@link Seed} — half of the ADR-0002 determinism spine. */
  seed: Seed
  /** The inhabited param values — the other half of the determinism spine. */
  params: Params
  /**
   * Locked param keys, SORTED. Resumes the session; does NOT affect the frame
   * (Lock is Randomize-exclusion only). An array, not a Set: this is the
   * serializable form — the Studio turns it back into a `Set<string>`.
   */
  locks: string[]
  /**
   * The active Output Profile captured with this Preset, or absent. Present
   * EXACTLY on a v2 record (`version === 2`) and absent on a v1 record — the
   * invariant `profile` present ⇔ `version === 2` is enforced by
   * {@link makePreset} and {@link deserialize}. Passed through untouched by
   * {@link applyPreset}; the Sketch-default / Harness-fallback resolution is the
   * session's concern (issue #265), NOT this envelope's.
   */
  profile?: PlotProfile
}

/**
 * Build a {@link Preset} record from the Studio's live state.
 *
 * The natural serialize entry point: it accepts `locks` as a
 * `ReadonlySet<string>` (matching `randomize`'s `locks` signature — the Studio's
 * live lock state IS a Set) and emits the SORTED `string[]` the record demands.
 * Sorting here is the single place the Set→array boundary is crossed, so the
 * serialized order is deterministic no matter how the Set iterates.
 *
 * The version tracks the profile: supplying `profile` stamps a v2 record that
 * carries it; OMITTING `profile` stamps a v1 record with NO `profile` field.
 * This is the `profile` present ⇔ `version === 2` invariant — there is no
 * "v2 without a profile" and no "v1 with a profile" record. Widening #267's live
 * profile through the save path is that task's concern; this only ACCEPTS it.
 *
 * Pure: it copies `params` and (when supplied) the `profile` — never aliases the
 * caller's live objects.
 *
 * @param sketch - The Sketch id slug (matches `SketchBase.id`).
 * @param name - This Preset's record name / filename stem.
 * @param params - The live inhabited param values; copied, not mutated.
 * @param seed - The live {@link Seed}.
 * @param locks - The live locked-keys Set; only READ, emitted SORTED.
 * @param profile - The active {@link PlotProfile}; when present, stamps a v2
 *   record carrying a defensive copy. Omit it for a v1 record with no profile.
 * @returns A fresh {@link Preset} record with `locks` sorted ascending — v2 with
 *   the profile when supplied, else v1 with no profile.
 */
export function makePreset(
  sketch: string,
  name: string,
  params: Params,
  seed: Seed,
  locks: ReadonlySet<string>,
  profile?: PlotProfile,
): Preset {
  const base = {
    sketch,
    name,
    seed,
    params: { ...params },
    locks: [...locks].sort(),
  }
  if (profile === undefined) {
    return { version: 1, ...base }
  }
  return { version: 2, ...base, profile: normalizePlotProfile(profile) }
}

/**
 * Serialize a {@link Preset} record to its plain transport object.
 *
 * The string boundary (`JSON.stringify`) is the Studio's / Remotion's concern;
 * this stays at the OBJECT level so it remains headless and testable. It is a
 * defensive copy — `params`, `locks`, and (for a v2 record) `profile` are cloned
 * (and `locks` re-sorted) so the returned object never aliases the input's
 * mutable members. `version` is carried through AS-IS and the `profile` key is
 * emitted only for a v2 record (omitted entirely for v1), preserving the
 * `profile` present ⇔ `version === 2` invariant. Composes with
 * {@link deserialize}: `deserialize(serialize(p))` round-trips a Preset.
 *
 * @param preset - The Preset record to serialize.
 * @returns A plain, defensively-copied {@link Preset} object.
 */
export function serialize(preset: Preset): Preset {
  const base = {
    version: preset.version,
    sketch: preset.sketch,
    name: preset.name,
    seed: preset.seed,
    params: { ...preset.params },
    locks: [...preset.locks].sort(),
  }
  return preset.profile === undefined
    ? base
    : { ...base, profile: normalizePlotProfile(preset.profile) }
}

/**
 * Validate an unknown / parsed-JSON value into a {@link Preset} record.
 *
 * The trust boundary for anything coming off disk or the wire. It operates on a
 * parsed OBJECT (the caller owns `JSON.parse`) so it stays headless, and it
 * THROWS on a structural mismatch rather than returning a partial record —
 * better to fail loudly than to silently apply a malformed Preset.
 *
 * The `version` check is the migration gate: `1` and {@link PRESET_VERSION}
 * (`2`) are known, so any other value is rejected here. Beyond the version it
 * enforces the `profile` present ⇔ `version === 2` invariant — a v1 record
 * carrying a `profile` and a v2 record missing one are BOTH rejected — and a v2
 * `profile` is run through {@link normalizePlotProfile}. That defaults a legacy
 * missing `includeFrame` to `true`, preserves an explicit boolean, defensively
 * copies the record, and fails loudly on malformed profiles. This is the
 * deserialize leg of the version assertion; {@link applyPreset} re-asserts so
 * the public apply path cannot be reached with a wrong version even if a caller
 * skips deserialize.
 *
 * @param value - An unknown value (typically the result of `JSON.parse`).
 * @returns The validated {@link Preset} record.
 * @throws If `value` is not an object, the version is not `1` or `2`, any
 *   required field is missing / mistyped, the profile/version invariant is
 *   violated, or a v2 `profile` is structurally invalid.
 */
export function deserialize(value: unknown): Preset {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Preset deserialize: expected an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 && record.version !== 2) {
    throw new Error(
      `Preset deserialize: unsupported version ${String(record.version)} (expected 1 or 2)`,
    )
  }
  if (typeof record.sketch !== 'string') {
    throw new Error('Preset deserialize: `sketch` must be a string')
  }
  if (typeof record.name !== 'string') {
    throw new Error('Preset deserialize: `name` must be a string')
  }
  if (typeof record.seed !== 'string' && typeof record.seed !== 'number') {
    throw new Error('Preset deserialize: `seed` must be a string or number')
  }
  if (typeof record.params !== 'object' || record.params === null) {
    throw new Error('Preset deserialize: `params` must be an object')
  }
  if (
    !Array.isArray(record.locks) ||
    !record.locks.every((k) => typeof k === 'string')
  ) {
    throw new Error('Preset deserialize: `locks` must be a string array')
  }
  const base = {
    sketch: record.sketch,
    name: record.name,
    seed: record.seed,
    params: record.params as Params,
    locks: [...(record.locks as string[])].sort(),
  }
  // The version TRACKS the profile: enforce the invariant both ways before
  // trusting either. A v1 record must carry no profile; a v2 record must carry a
  // well-formed one (validated loudly, matching the fail-loudly discipline here).
  const hasProfile = record.profile !== undefined
  if (record.version === 1) {
    if (hasProfile) {
      throw new Error(
        'Preset deserialize: a version 1 record must not carry a `profile`',
      )
    }
    return { version: 1, ...base }
  }
  if (!hasProfile) {
    throw new Error(
      'Preset deserialize: a version 2 record must carry a `profile`',
    )
  }
  if (typeof record.profile !== 'object' || record.profile === null) {
    throw new Error('Preset deserialize: `profile` must be an object')
  }
  // Normalizes the backward-compatible persisted shape, defensively copies it,
  // and rejects a structurally-broken profile with a Plot-Profile-specific
  // message. Profiles written before `includeFrame` existed default it on.
  const profile = normalizePlotProfile(record.profile as LegacyPlotProfile)
  return { version: 2, ...base, profile }
}

/**
 * The live Studio/engine state a Preset reconciles INTO — `params`, `seed`,
 * `locks` (still the SORTED array; the Studio is the one that turns it into a
 * `Set<string>` when it adopts this result), and the OPTIONAL stored `profile`.
 */
export interface PresetState {
  /** The reconciled inhabited param values. */
  params: Params
  /** The Preset's {@link Seed}, passed through unchanged. */
  seed: Seed
  /** The Preset's SORTED locked keys, passed through unchanged. */
  locks: string[]
  /**
   * The Preset's active Output Profile, passed through VERBATIM — present for a
   * v2 record, `undefined` for a v1 record. {@link applyPreset} does NOT resolve
   * any Sketch-default / Harness fallback here; that precedence is the session's
   * job (issue #265) at #267's boundary, not this envelope's.
   */
  profile?: PlotProfile | undefined
}

/**
 * Reconcile a {@link Preset} against a Sketch's CURRENT schema — the
 * schema-authoritative load.
 *
 * The schema, not the stored record, is the authority on which keys exist. This
 * is what lets a Sketch's knobs evolve (rename, add, remove) without old Presets
 * becoming poison. Three rules, applied by iterating the SCHEMA (never the
 * preset's params):
 *
 * - DROP unknown keys: a param in the Preset but ABSENT from the schema is
 *   discarded. It falls out naturally — iterating schema keys never visits it.
 * - DEFAULT missing keys: a schema key ABSENT from the Preset is filled from its
 *   spec `default` (the same pattern as `defaultParams` in `sketch.ts`).
 * - LOAD out-of-bounds AS-IS, UNCLAMPED: a stored value outside the spec's
 *   `[min, max]` is taken verbatim. Clamping would silently reproduce a
 *   DIFFERENT frame than the Preset was saved from — exact-image fidelity beats
 *   range hygiene. (Range hygiene is the control panel's live concern.)
 *
 * Because Remotion and the Studio both run THIS function, a Preset reconciles
 * identically in every consumer — the reason this lives in `core`.
 *
 * `version` is re-asserted here so the public apply path can never run on a
 * wrong-version record even if a caller skipped {@link deserialize}. `seed` and
 * the sorted `locks` pass through untouched — `locks` does not affect the frame
 * (Lock is Randomize-exclusion only), and the Studio converts it to a Set. The
 * stored `profile` also passes through VERBATIM (present for v2, `undefined` for
 * v1); this does NOT resolve the Sketch-default / Harness fallback — that
 * precedence lives in #265's resolver, invoked at #267's session boundary.
 *
 * @param schema - The Sketch's CURRENT Parameter Schema — the authority.
 * @param preset - The Preset record to load.
 * @returns The reconciled {@link PresetState}.
 * @throws If `preset.version` is not `1` or `2`.
 */
export function applyPreset(schema: ParamSchema, preset: Preset): PresetState {
  if (preset.version !== 1 && preset.version !== 2) {
    throw new Error(
      `applyPreset: unsupported Preset version ${String(preset.version)} (expected 1 or 2)`,
    )
  }
  const params: Params = {}
  for (const [key, spec] of Object.entries(schema)) {
    // Prefer the stored value (loaded AS-IS, unclamped); else fall back to the
    // spec default. Iterating the schema is what drops preset-only keys.
    params[key] = key in preset.params ? preset.params[key] : spec.default
  }
  return {
    params,
    seed: preset.seed,
    locks: preset.locks,
    // Passed through untouched — the fallback resolution is the session's job.
    profile: preset.profile,
  }
}
