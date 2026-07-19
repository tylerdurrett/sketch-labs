import { useEffect, useState } from "react";

import {
  makePreset,
  type Params,
  type PlotProfile,
  type Preset,
  type PresetFraming,
  type Seed,
} from "@harness/core";

import { Button } from "./components/ui/button";
import {
  isValidPresetName,
  MAX_PRESET_NAME_LENGTH,
  updatePresetNameDraft,
  type PresetNameDraft,
} from "./presetName";
import { listPresets, loadPreset, savePreset } from "./presetsClient";

/**
 * Props for {@link PresetControls}.
 *
 * The component is the studio's save/reload surface. It owns its OWN local UI
 * state — the name field, the selected preset, and the fetched name list — but
 * the live values a Save captures (`params` / `seed` / `locks` / profile /
 * framing) flow IN from the {@link SketchControls} owner, and a Reload's
 * reconciled state flows back OUT through {@link onReload}. It never holds the
 * canonical authored state itself.
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
   * The session's active Plot Profile (#247), captured into a saved Preset so a
   * Save stamps a v2 record carrying the physical-plot output dimensions. The
   * owner ({@link SketchControls}) resolves it per-Sketch through #265's
   * precedence; this component only forwards it verbatim into `makePreset`.
   */
  profile: PlotProfile;
  /** Complete committed Page framing; when present, Save stamps a v3 record. */
  framing?: PresetFraming;
  /**
   * Hand a freshly-loaded Preset to the owner, which reconciles it through
   * `applyPreset` and hydrates its params, seed, locks, profile, and framing.
   * This component does NOT run the reconcile — that transport-to-Studio glue
   * is the owner's.
   */
  onReload: (preset: Preset) => void;
}

/**
 * The Preset save/reload control: a slug-validated name field + Save button, and
 * a preset picker + Reload button driven by the sketch's saved-name list.
 *
 * SAVE builds the record from the live state (`makePreset`), POSTs it via the
 * client, and refreshes the list so the new name appears. ASCII uppercase and
 * whitespace are normalized visibly while unsupported characters remain for
 * inline validation; a name already in the fetched list prompts
 * confirm-before-overwrite.
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
  profile,
  framing,
  onReload,
}: PresetControlsProps) {
  const [nameDraft, setNameDraft] = useState<PresetNameDraft>({
    value: "",
    whitespaceRunEnds: [],
  });
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

  const name = nameDraft.value;
  const nameValid = isValidPresetName(name);

  const onSave = () => {
    if (!nameValid) return;
    if (names.includes(name) && !window.confirm(`Overwrite preset "${name}"?`)) {
      return;
    }
    const preset = makePreset(
      sketchId,
      name,
      params,
      seed,
      locks,
      profile,
      framing,
    );
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
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          className="flex-1 h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          type="text"
          data-studio-history="exclude"
          placeholder="preset name"
          aria-label="preset name"
          value={name}
          onChange={(event) => {
            const browserValue = event.target.value;
            setNameDraft((draft) =>
              updatePresetNameDraft(draft, browserValue),
            );
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onSave}
          disabled={!nameValid}
        >
          Save
        </Button>
      </div>
      {name !== "" && !nameValid && (
        <p
          className="m-0 text-sm text-muted-foreground"
          role="alert"
        >
          Name must start with a-z or 0-9, be at most {MAX_PRESET_NAME_LENGTH}
          characters, and use only a-z, 0-9, hyphen, or underscore.
        </p>
      )}
      <div className="flex items-center gap-2">
        <select
          className="flex-1 h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onReloadClick}
          disabled={selected === ""}
        >
          Reload
        </Button>
      </div>
      {error !== null && (
        <p
          className="m-0 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}
