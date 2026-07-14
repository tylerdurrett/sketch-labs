/**
 * Headless Preset I/O client for the Studio (slice #8, task #63).
 *
 * A thin, React-free wrapper over the three network calls the studio makes to
 * persist and restore Presets. The Preset SHAPE, (de)serialize, and the
 * schema-authoritative reconcile all live in core (#61) — this module owns ONLY
 * the wire layer (which URL, which verb, which body) plus the `JSON.parse →
 * core.deserialize` trust hop on the read path. Keeping it pure of React lets it
 * unit-test against a stubbed `fetch`.
 *
 * The two-route split mirrors the dev middleware (#62, ADR-0006):
 * - LIST + WRITE are dev middleware under `/__api/presets/{id}`.
 * - READ-ONE is a plain STATIC FILE at `/sketches/{id}/presets/{name}.json`
 *   (NOT the dev GET), so every consumer reads the identical bytes.
 */
import { deserialize, serialize, type Preset } from "@harness/core";

/** URL prefix the list + write middleware routes live under (#62). */
const API_PREFIX = "/__api/presets";

/** Logical URL prefix the sketches root is served at, for static read-one (#62). */
const STATIC_PREFIX = "/sketches";

/**
 * List a sketch's saved Preset names, sorted (the middleware sorts).
 *
 * `GET /__api/presets/{id}` → `string[]`. A sketch that has never been saved
 * returns `[]` (the middleware maps a missing dir to an empty list).
 *
 * @param sketchId - The active Sketch id slug.
 * @returns The sorted preset names.
 * @throws If the request fails or the body is not a string array.
 */
export async function listPresets(sketchId: string): Promise<string[]> {
  const res = await fetch(`${API_PREFIX}/${sketchId}`);
  if (!res.ok) {
    throw new Error(`listPresets: ${res.status} ${res.statusText}`);
  }
  const data: unknown = await res.json();
  if (!Array.isArray(data) || !data.every((n) => typeof n === "string")) {
    throw new Error("listPresets: expected a string array");
  }
  return data as string[];
}

/**
 * Persist a Preset under its sketch.
 *
 * `POST /__api/presets/{id}` with `serialize(preset)` JSON as the body — the
 * `name` travels in the body's `name` field (the middleware reads it from there
 * to name the file). The id in the URL is the Preset's own `sketch` field.
 *
 * @param preset - The Preset record to save (built via core's `makePreset`).
 * @throws If the write request fails.
 */
export async function savePreset(preset: Preset): Promise<void> {
  const res = await fetch(`${API_PREFIX}/${preset.sketch}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(serialize(preset)),
  });
  if (!res.ok) {
    throw new Error(`savePreset: ${res.status} ${res.statusText}`);
  }
}

/**
 * Read one saved Preset as a STATIC FILE and validate it through core.
 *
 * `GET /sketches/{id}/presets/{name}.json` (the static path, NOT the dev GET),
 * then `JSON.parse → core.deserialize` — which throws on a bad shape/version, so
 * a malformed Preset fails loudly rather than reconciling silently.
 *
 * @param sketchId - The active Sketch id slug.
 * @param name - The preset name / filename stem.
 * @returns The validated Preset record.
 * @throws If the request fails or the parsed bytes are not a valid Preset.
 */
export async function loadPreset(
  sketchId: string,
  name: string,
): Promise<Preset> {
  const res = await fetch(`${STATIC_PREFIX}/${sketchId}/presets/${name}.json`);
  if (!res.ok) {
    throw new Error(`loadPreset: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return deserialize(JSON.parse(text));
}
