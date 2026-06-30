/**
 * The reproduction-metadata payload helper — builds the self-describing envelope
 * embedded into PNG and SVG exports (issue #76) so a downloaded file traces back
 * to the exact frame that produced it.
 *
 * Pure and headless: no DOM, no Blob, no `fetch`. It mirrors the injected-purity
 * style of the Preset helpers in `preset.ts` and the name helper in
 * `exportName.ts` — a sibling of the core engine functions, testable without a
 * browser. The byte-splice (PNG) and the markup injection (SVG) are downstream;
 * this module owns only the JSON STRING both export paths embed, which is why it
 * lives in `core`: one envelope shape, derived identically by every consumer.
 *
 * The payload reuses the existing six-field {@link Preset} envelope —
 * `{ version, sketch, name, seed, params, locks }` — built through
 * {@link makePreset}/{@link serialize} so the shape stays schema-authoritative
 * (NO new schema), PLUS the frame time `t`. Including `name` (the export filename
 * stem) makes the embedded blob a complete, re-importable Preset. Re-import
 * (reading it back to restore Studio state) is explicitly OUT OF SCOPE for #76;
 * this only WRITES the metadata.
 */

import { exportFilename, type ExportNameParts } from './exportName'
import { makePreset, serialize, type Preset } from './preset'
import type { Params, Seed } from './sketch'

/**
 * The embedded reproduction envelope — the full {@link Preset} plus the frame
 * time `t`. This is exactly what {@link buildReproMetadata} serializes to JSON.
 */
export interface ReproMetadata extends Preset {
  /**
   * The captured frame time in seconds, OR `undefined` for a static Sketch (no
   * `sketch.time`). Mirrors {@link ExportNameParts.t}: an absent value is the
   * static case, NOT `t = 0`.
   */
  t?: number | undefined
}

/**
 * The live state a reproduction payload captures — the determinism spine
 * (`sketchId` + `seed` + `params`), the session's `locks`, and the OPTIONAL
 * captured `t`. The `name` (filename stem) is DERIVED here, not passed in, so it
 * always agrees with {@link exportFilename}'s stem.
 */
export interface ReproMetadataInput {
  /** The Sketch id slug (matches `SketchBase.id`). */
  sketchId: string
  /** The explicit {@link Seed} the frame was rendered from. */
  seed: Seed
  /** The inhabited param values; copied, never aliased (via {@link makePreset}). */
  params: Params
  /** The live locked-keys Set; only READ, emitted SORTED (via {@link makePreset}). */
  locks: ReadonlySet<string>
  /**
   * The captured time in seconds. Supplied ONLY for a time-driven Sketch; OMIT
   * it (or pass `undefined`) for a static Sketch so neither the filename stem nor
   * the payload carries a time. An absent value is the static case, NOT `t = 0`.
   */
  t?: number | undefined
}

/**
 * Derive the export filename STEM (the {@link exportFilename} output minus the
 * extension) — the value the envelope's `name` carries, so the embedded Preset's
 * record name matches the file it ships in.
 *
 * @param parts - The frame's `sketchId`, `seed`, and optional captured `t`.
 * @returns The filename stem, e.g. `circles-seed42` or `waves-seed7-t1.5`.
 */
export function reproFilenameStem(parts: ExportNameParts): string {
  // exportFilename appends `.{ext}`; the stem is that output without the suffix.
  // Passing an empty extension yields `{stem}.` — strip the trailing dot.
  return exportFilename(parts, '').slice(0, -1)
}

/**
 * Build the reproduction-metadata JSON string both export paths embed.
 *
 * Constructs the six-field {@link Preset} envelope via {@link makePreset} (so the
 * shape stays authoritative and `params`/`locks` are defensively copied/sorted),
 * stamps the filename stem as `name`, attaches the captured `t`, then
 * `JSON.stringify`s the {@link serialize}d record. The `t` key is OMITTED for a
 * static Sketch (undefined input), matching the filename's time-gating.
 *
 * @param input - The live `{ sketchId, seed, params, locks, t? }` to capture.
 * @returns The UTF-8 JSON string of the envelope + optional `t`.
 */
export function buildReproMetadata(input: ReproMetadataInput): string {
  const { sketchId, seed, params, locks, t } = input
  const name = reproFilenameStem({ sketchId, seed, t })
  const preset = makePreset(sketchId, name, params, seed, locks)
  const payload: ReproMetadata =
    t === undefined
      ? serialize(preset)
      : { ...serialize(preset), t }
  return JSON.stringify(payload)
}
