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

import type { Params, Seed } from './sketch'

/**
 * The current (and only) Preset schema version.
 *
 * `version` is the migration escape hatch: every persisted Preset carries it so
 * a future shape change can be detected and migrated rather than silently
 * mis-read. Only `1` exists today; {@link deserialize} asserts it.
 */
export const PRESET_VERSION = 1

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
 * - `version` is the literal {@link PRESET_VERSION} migration escape hatch.
 */
export interface Preset {
  /** The migration escape hatch. Literal {@link PRESET_VERSION} (`1`) today. */
  version: typeof PRESET_VERSION
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
 * Pure: it copies `params` (never aliases the caller's live object) and stamps
 * the current {@link PRESET_VERSION}.
 *
 * @param sketch - The Sketch id slug (matches `SketchBase.id`).
 * @param name - This Preset's record name / filename stem.
 * @param params - The live inhabited param values; copied, not mutated.
 * @param seed - The live {@link Seed}.
 * @param locks - The live locked-keys Set; only READ, emitted SORTED.
 * @returns A fresh {@link Preset} record with `locks` sorted ascending.
 */
export function makePreset(
  sketch: string,
  name: string,
  params: Params,
  seed: Seed,
  locks: ReadonlySet<string>,
): Preset {
  return {
    version: PRESET_VERSION,
    sketch,
    name,
    seed,
    params: { ...params },
    locks: [...locks].sort(),
  }
}

/**
 * Serialize a {@link Preset} record to its plain transport object.
 *
 * The string boundary (`JSON.stringify`) is the Studio's / Remotion's concern;
 * this stays at the OBJECT level so it remains headless and testable. It is a
 * defensive copy — `params` and `locks` are cloned (and `locks` re-sorted) so
 * the returned object never aliases the input's mutable members. Composes with
 * {@link deserialize}: `deserialize(serialize(p))` round-trips a Preset.
 *
 * @param preset - The Preset record to serialize.
 * @returns A plain, defensively-copied {@link Preset} object.
 */
export function serialize(preset: Preset): Preset {
  return {
    version: preset.version,
    sketch: preset.sketch,
    name: preset.name,
    seed: preset.seed,
    params: { ...preset.params },
    locks: [...preset.locks].sort(),
  }
}

/**
 * Validate an unknown / parsed-JSON value into a {@link Preset} record.
 *
 * The trust boundary for anything coming off disk or the wire. It operates on a
 * parsed OBJECT (the caller owns `JSON.parse`) so it stays headless, and it
 * THROWS on a structural mismatch rather than returning a partial record —
 * better to fail loudly than to silently apply a malformed Preset.
 *
 * The `version` check is the migration gate: only {@link PRESET_VERSION} (`1`)
 * is known today, so any other value is rejected here. This is the deserialize
 * leg of the version assertion; {@link applyPreset} re-asserts so the public
 * apply path cannot be reached with a wrong version even if a caller skips
 * deserialize.
 *
 * @param value - An unknown value (typically the result of `JSON.parse`).
 * @returns The validated {@link Preset} record.
 * @throws If `value` is not an object, the version is not `1`, or any required
 *   field is missing / mistyped.
 */
export function deserialize(value: unknown): Preset {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Preset deserialize: expected an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== PRESET_VERSION) {
    throw new Error(
      `Preset deserialize: unsupported version ${String(record.version)} (expected ${PRESET_VERSION})`,
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
  return {
    version: PRESET_VERSION,
    sketch: record.sketch,
    name: record.name,
    seed: record.seed,
    params: record.params as Params,
    locks: [...(record.locks as string[])].sort(),
  }
}

