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
import { validatePageFrame, type PageFrame } from './pageFrame'
import type { Params, ParamSchema, Seed } from './sketch'

/**
 * The current (and maximum) Preset schema version — the framed shape.
 *
 * `version` is the migration escape hatch: every persisted Preset carries it so
 * a shape change can be detected and reconciled rather than silently mis-read.
 * Three versions exist:
 *
 * - `1` — the original six-field envelope, carrying NO active Output Profile.
 * - `2` — that envelope PLUS one active {@link PlotProfile} (`profile`).
 * - `3` — the v2 envelope PLUS one complete {@link PresetFraming} snapshot.
 *
 * New unframed records deliberately remain v1/v2 so their transport shape and
 * behavior do not change. Only records carrying both a final profile and a
 * framing snapshot take {@link PRESET_VERSION}.
 */
export const PRESET_VERSION = 3

/** The complete framing snapshot required to reproduce a reframed page. */
export interface PresetFraming {
  /** Exact final Page Frame in the generated Composition's coordinates. */
  pageFrame: PageFrame
  /** Original drawable aspect used to generate the Scene. */
  generationAspect: number
  /** Whether proportional Paper resizing was locked when the Preset was saved. */
  aspectLocked: boolean
}

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
 * - `version` is the migration escape hatch (`1`, `2`, or
 *   {@link PRESET_VERSION}).
 * - `profile` is absent on v1 and present on v2/v3.
 * - `framing` is absent on v1/v2 and present on v3.
 */
export interface Preset {
  /**
   * The migration escape hatch — v1 has no profile, v2 adds a profile, and v3
   * adds framing to that profile-bearing shape.
   */
  version: 1 | 2 | 3
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
   * The active Output Profile captured with this Preset. Present on v2/v3 and
   * absent on v1. {@link applyPreset} returns a defensive copy without resolving
   * Sketch-default / Harness fallback precedence.
   */
  profile?: PlotProfile
  /**
   * Reframing state, present exactly on a v3 record. A v3 record also carries
   * the final Output Profile; v1/v2 records remain unframed.
   */
  framing?: PresetFraming
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
 * Omitting `profile` and `framing` stamps v1. Supplying only `profile` stamps v2.
 * Supplying both stamps v3; framing without a final profile is rejected.
 *
 * Pure: it copies `params`, `profile`, and `framing` — never aliases the caller's
 * live objects.
 *
 * @param sketch - The Sketch id slug (matches `SketchBase.id`).
 * @param name - This Preset's record name / filename stem.
 * @param params - The live inhabited param values; copied, not mutated.
 * @param seed - The live {@link Seed}.
 * @param locks - The live locked-keys Set; only READ, emitted SORTED.
 * @param profile - Active {@link PlotProfile}; stamps v2 unless framing is supplied.
 * @param framing - Complete framing state; requires `profile` and stamps v3.
 * @returns A fresh versioned record with `locks` sorted ascending.
 */
export function makePreset(
  sketch: string,
  name: string,
  params: Params,
  seed: Seed,
  locks: ReadonlySet<string>,
  profile?: PlotProfile,
  framing?: PresetFraming,
): Preset {
  const base = {
    sketch,
    name,
    seed,
    params: { ...params },
    locks: [...locks].sort(),
  }
  if (framing !== undefined && profile === undefined) {
    throw new Error('makePreset: `framing` requires a `profile`')
  }
  if (profile === undefined) {
    return { version: 1, ...base }
  }
  if (framing !== undefined) {
    return {
      version: PRESET_VERSION,
      ...base,
      profile: normalizePlotProfile(profile),
      framing: normalizePresetFraming(framing, 'makePreset'),
    }
  }
  return { version: 2, ...base, profile: normalizePlotProfile(profile) }
}

/**
 * Serialize a {@link Preset} record to its plain transport object.
 *
 * The string boundary (`JSON.stringify`) is the Studio's / Remotion's concern;
 * this stays at the OBJECT level so it remains headless and testable. It is a
 * defensive copy — `params`, `locks`, `profile`, and `framing` are cloned when
 * present (and `locks` re-sorted) so the returned object never aliases the
 * input's mutable members. Version/field combinations are validated. Composes with
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
  if (preset.version === 1) {
    assertPresetFields(preset, false, false, 'serialize')
    return base
  }
  if (preset.version === 2) {
    assertPresetFields(preset, true, false, 'serialize')
    return { ...base, profile: normalizePlotProfile(preset.profile!) }
  }
  if (preset.version === PRESET_VERSION) {
    assertPresetFields(preset, true, true, 'serialize')
    return {
      ...base,
      profile: normalizePlotProfile(preset.profile!),
      framing: normalizePresetFraming(preset.framing, 'serialize'),
    }
  }
  throw new Error(
    `serialize: unsupported Preset version ${String(preset.version)} (expected 1, 2, or ${PRESET_VERSION})`,
  )
}

/**
 * Validate an unknown / parsed-JSON value into a {@link Preset} record.
 *
 * The trust boundary for anything coming off disk or the wire. It operates on a
 * parsed OBJECT (the caller owns `JSON.parse`) so it stays headless, and it
 * THROWS on a structural mismatch rather than returning a partial record —
 * better to fail loudly than to silently apply a malformed Preset.
 *
 * The migration gate accepts exactly v1/v2/v3 and enforces their field
 * combinations. Profiles run through {@link normalizePlotProfile}; framing
 * validates the Page Frame, positive generation aspect, and lock flag. Both are
 * defensively copied. {@link applyPreset} re-asserts these invariants if a caller
 * skips deserialize.
 *
 * @param value - An unknown value (typically the result of `JSON.parse`).
 * @returns The validated {@link Preset} record.
 * @throws If the record, version/field combination, profile, or framing is invalid.
 */
export function deserialize(value: unknown): Preset {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Preset deserialize: expected an object')
  }
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 &&
    record.version !== 2 &&
    record.version !== PRESET_VERSION
  ) {
    throw new Error(
      `Preset deserialize: unsupported version ${String(record.version)} (expected 1, 2, or ${PRESET_VERSION})`,
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
    params: { ...(record.params as Params) },
    locks: [...(record.locks as string[])].sort(),
  }
  // Enforce each version's exact field combination before trusting its payload.
  const hasProfile = record.profile !== undefined
  const hasFraming = record.framing !== undefined
  if (record.version === 1) {
    if (hasProfile) {
      throw new Error(
        'Preset deserialize: a version 1 record must not carry a `profile`',
      )
    }
    if (hasFraming) {
      throw new Error(
        'Preset deserialize: a version 1 record must not carry `framing`',
      )
    }
    return { version: 1, ...base }
  }
  if (!hasProfile) {
    throw new Error(
      `Preset deserialize: a version ${record.version} record must carry a \`profile\``,
    )
  }
  if (typeof record.profile !== 'object' || record.profile === null) {
    throw new Error('Preset deserialize: `profile` must be an object')
  }
  // Normalizes the backward-compatible persisted shape, defensively copies it,
  // and rejects a structurally-broken profile with a Plot-Profile-specific
  // message. Profiles written before `includeFrame` existed default it on.
  const profile = normalizePlotProfile(record.profile as LegacyPlotProfile)
  if (record.version === 2) {
    if (hasFraming) {
      throw new Error(
        'Preset deserialize: a version 2 record must not carry `framing`',
      )
    }
    return { version: 2, ...base, profile }
  }
  if (!hasFraming) {
    throw new Error(
      'Preset deserialize: a version 3 record must carry `framing`',
    )
  }
  return {
    version: PRESET_VERSION,
    ...base,
    profile,
    framing: normalizePresetFraming(record.framing, 'Preset deserialize'),
  }
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
   * A defensive copy of the stored Output Profile, present for v2/v3 and absent
   * for v1. No Sketch-default / Harness fallback is resolved here.
   */
  profile?: PlotProfile | undefined
  /** A defensive copy of the v3 framing snapshot, or absent for v1/v2. */
  framing?: PresetFraming | undefined
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
 * (Lock is Randomize-exclusion only), and the Studio converts it to a Set.
 * Stored profile and framing are validated and defensively copied without
 * resolving Sketch-default / Harness fallback precedence.
 *
 * @param schema - The Sketch's CURRENT Parameter Schema — the authority.
 * @param preset - The Preset record to load.
 * @returns The reconciled {@link PresetState}.
 * @throws If the version or its profile/framing field combination is invalid.
 */
export function applyPreset(schema: ParamSchema, preset: Preset): PresetState {
  if (
    preset.version !== 1 &&
    preset.version !== 2 &&
    preset.version !== PRESET_VERSION
  ) {
    throw new Error(
      `applyPreset: unsupported Preset version ${String(preset.version)} (expected 1, 2, or ${PRESET_VERSION})`,
    )
  }
  assertPresetFields(
    preset,
    preset.version !== 1,
    preset.version === PRESET_VERSION,
    'applyPreset',
  )
  const params: Params = {}
  for (const [key, spec] of Object.entries(schema)) {
    // Prefer the stored value (loaded AS-IS, unclamped); else fall back to the
    // spec default. Iterating the schema is what drops preset-only keys.
    params[key] = key in preset.params ? preset.params[key] : spec.default
  }
  const state: PresetState = {
    params,
    seed: preset.seed,
    locks: [...preset.locks],
    profile:
      preset.profile === undefined
        ? undefined
        : normalizePlotProfile(preset.profile),
  }
  return preset.framing === undefined
    ? state
    : {
        ...state,
        framing: normalizePresetFraming(preset.framing, 'applyPreset'),
      }
}

function assertPresetFields(
  preset: Preset,
  expectsProfile: boolean,
  expectsFraming: boolean,
  operation: string,
): void {
  const hasProfile = preset.profile !== undefined
  const hasFraming = preset.framing !== undefined
  if (hasProfile !== expectsProfile) {
    throw new Error(
      `${operation}: a version ${preset.version} record must ${expectsProfile ? '' : 'not '}carry a \`profile\``,
    )
  }
  if (hasFraming !== expectsFraming) {
    throw new Error(
      `${operation}: a version ${preset.version} record must ${expectsFraming ? '' : 'not '}carry \`framing\``,
    )
  }
}

function normalizePresetFraming(
  value: unknown,
  operation: string,
): PresetFraming {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${operation}: \`framing\` must be an object`)
  }
  const framing = value as Record<string, unknown>
  if (typeof framing.pageFrame !== 'object' || framing.pageFrame === null) {
    throw new Error(`${operation}: \`framing.pageFrame\` must be an object`)
  }
  const pageFrameRecord = framing.pageFrame as Record<string, unknown>
  const pageFrame: PageFrame = {
    x: pageFrameRecord.x as number,
    y: pageFrameRecord.y as number,
    width: pageFrameRecord.width as number,
    height: pageFrameRecord.height as number,
  }
  validatePageFrame(pageFrame)
  if (
    typeof framing.generationAspect !== 'number' ||
    !Number.isFinite(framing.generationAspect) ||
    framing.generationAspect <= 0
  ) {
    throw new Error(
      `${operation}: \`framing.generationAspect\` must be a finite positive number`,
    )
  }
  if (typeof framing.aspectLocked !== 'boolean') {
    throw new Error(
      `${operation}: \`framing.aspectLocked\` must be a boolean`,
    )
  }
  return {
    pageFrame,
    generationAspect: framing.generationAspect,
    aspectLocked: framing.aspectLocked,
  }
}
