import { useEffect, useState } from "react";

import { makePreset, type Params, type Preset, type Seed } from "@harness/core";

import {
  isValidName,
  listPresets,
  loadPreset,
  savePreset,
} from "./presetsClient";

/**
 * Props for {@link PresetControls}.
 *
 * The component is the studio's save/reload surface. It owns its OWN local UI
 * state — the name field, the selected preset, and the fetched name list — but
 * the live values a Save captures (`params` / `seed` / `locks`) flow IN from the
 * {@link SketchControls} owner, and a Reload's reconciled state flows back OUT
 * through {@link onReload}. It never holds the canonical param state itself.
 */
export interface PresetControlsProps {
  /** The active Sketch id slug — the folder a Preset is saved under / read from. */
  sketchId: string;
  /** The live param values, captured verbatim into a saved Preset. */
  params: Params;
  /** The live seed, captured verbatim into a saved Preset. */
  seed: Seed;
  /** The live locked-keys set, emitted SORTED into a saved Preset. */
  locks: ReadonlySet<string>;
  /**
   * Hand a freshly-loaded Preset to the owner, which reconciles it through
   * `applyPreset` and hydrates its `params` / `seed` / `locks` state. This
   * component does NOT run the reconcile — that array→Set glue is the owner's.
   */
  onReload: (preset: Preset) => void;
}

/**
 * The Preset save/reload control: a slug-validated name field + Save button, and
 * a preset picker + Reload button driven by the sketch's saved-name list.
 *
 * SAVE builds the record from the live state (`makePreset`), POSTs it via the
 * client, and refreshes the list so the new name appears. An INVALID name is
 * rejected inline (no silent slugify); a name already in the fetched list
 * prompts confirm-before-overwrite.
 *
 * RELOAD reads the chosen preset as a static file and hands it to {@link
 * onReload} — the owner does the schema-authoritative reconcile + hydration.
 *
 * The fetched name list is keyed to `sketchId`: switching Sketch re-fetches (and
 * the owner remounts this anyway via its `key`).
 */
export function PresetControls({
  sketchId,
  params,
  seed,
  locks,
  onReload,
}: PresetControlsProps) {
  const [name, setName] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Keep the saved-name list in sync with the active Sketch. A failed fetch
  // leaves the list empty rather than wedging the surface.
  const refreshNames = () => {
    listPresets(sketchId)
      .then(setNames)
      .catch(() => setNames([]));
  };

  useEffect(refreshNames, [sketchId]);

  const nameValid = isValidName(name);

  const onSave = () => {
    if (!nameValid) return;
    if (names.includes(name) && !window.confirm(`Overwrite preset "${name}"?`)) {
      return;
    }
    const preset = makePreset(sketchId, name, params, seed, locks);
    savePreset(preset)
      .then(() => {
        setError(null);
        refreshNames();
      })
      .catch((err: unknown) => setError(String(err)));
  };

  const onReloadClick = () => {
    if (selected === "") return;
    loadPreset(sketchId, selected)
      .then((preset) => {
        setError(null);
        onReload(preset);
      })
      .catch((err: unknown) => setError(String(err)));
  };

  return (
    <div className="preset-controls">
      <div className="preset-controls__row">
        <input
          className="preset-controls__name"
          type="text"
          placeholder="preset name"
          aria-label="preset name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="button"
          className="action-button"
          onClick={onSave}
          disabled={!nameValid}
        >
          Save
        </button>
      </div>
      {name !== "" && !nameValid && (
        <p className="preset-controls__hint" role="alert">
          Name must be a lowercase slug: a-z, 0-9, hyphen or underscore (no
          spaces or uppercase).
        </p>
      )}
      <div className="preset-controls__row">
        <select
          className="preset-controls__picker"
          aria-label="saved presets"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">Select a preset…</option>
          {names.map((preset) => (
            <option key={preset} value={preset}>
              {preset}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="action-button"
          onClick={onReloadClick}
          disabled={selected === ""}
        >
          Reload
        </button>
      </div>
      {error !== null && (
        <p className="preset-controls__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
