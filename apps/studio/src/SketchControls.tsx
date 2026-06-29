import { useState } from "react";

import {
  applyPreset,
  defaultParams,
  newSeed,
  randomize,
  type Preset,
  type Sketch,
} from "@harness/core";

import { ControlPanel } from "./ControlPanel";
import { LiveCanvas } from "./LiveCanvas";
import { PresetControls } from "./PresetControls";

/**
 * Props for {@link SketchControls}.
 */
export interface SketchControlsProps {
  /** The selected Sketch whose schema drives the controls and whose Scene renders. */
  sketch: Sketch;
}

/**
 * The single owner of one Sketch's live param values, wiring the control surface
 * to the live canvas.
 *
 * It seeds its state from {@link defaultParams} (the Sketch's schema defaults,
 * #47) and renders the {@link ControlPanel} (which tweaks those values) and the
 * {@link LiveCanvas} (which consumes them) over the SAME `params` state, so a
 * control tweak updates the canvas in real time.
 *
 * RESET-BY-REMOUNT: App mounts this with `key={sketch.id}`, so selecting a
 * different Sketch unmounts this instance and mounts a fresh one — the lazy
 * `useState` initializers re-run against the new Sketch and the params AND seed
 * reset (params to that Sketch's defaults, seed to a fresh roll). There is
 * deliberately NO manual reset effect; the key remount IS the reset mechanism.
 *
 * SEED is the FIRST randomness axis — a plain numeric value (groundwork for
 * Presets #8: the seed is the literal value a Preset captures and copies). The
 * studio backs the engine's `rand` with `Math.random` (the `value()` [0, 1)
 * shape). Editing the seed re-renders the canvas (LiveCanvas reads `seed`
 * through a ref) WITHOUT touching any param value — the two axes are independent.
 *
 * LOCKS are Randomize-EXCLUSION ONLY: the studio owns a `Set<string>` of locked
 * param keys, passed solely into `randomize` so a locked key keeps its value
 * across a roll. A lock NEVER gates editability — a locked control stays fully
 * hand-editable. Like `seed` and `params`, `locks` lives in keyed-remount state,
 * so a Sketch switch clears every lock for free (no manual reset).
 */
export function SketchControls({ sketch }: SketchControlsProps) {
  const [params, setParams] = useState(() => defaultParams(sketch.schema));
  const [seed, setSeed] = useState(() => newSeed(Math.random));
  const [locks, setLocks] = useState<ReadonlySet<string>>(() => new Set());

  const setParam = (key: string, value: number) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  };

  // Toggle a single param's lock membership. Locks are read ONLY by randomize;
  // toggling one never touches the param's value or its editability.
  const toggleLock = (key: string) => {
    setLocks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // New seed: roll a fresh arrangement, leaving every param value untouched —
  // the seed axis is independent of the param (Randomize) axis.
  const rollSeed = () => setSeed(newSeed(Math.random));

  // Randomize: re-roll the unlocked numeric params. The engine reads the current
  // `locks` set (locked keys pass through unchanged) and a `Math.random`-backed
  // source — no roll logic lives here.
  const rollParams = () => {
    setParams((prev) => randomize(sketch.schema, prev, locks, Math.random));
  };

  // Reload a saved Preset: reconcile it against the CURRENT schema via core's
  // `applyPreset` (the authority on which keys exist), then hydrate all three
  // state axes TOGETHER. The array→Set conversion on `locks` is this owner's
  // job — `applyPreset` returns a sorted string[], the studio's live lock state
  // is a Set<string>.
  const reloadPreset = (preset: Preset) => {
    const state = applyPreset(sketch.schema, preset);
    setParams(state.params);
    setSeed(state.seed);
    setLocks(new Set(state.locks));
  };

  return (
    <div className="sketch-controls">
      <ControlPanel
        schema={sketch.schema}
        params={params}
        locks={locks}
        onChange={setParam}
        onToggleLock={toggleLock}
      />
      <div className="sketch-controls__actions">
        <button type="button" className="action-button" onClick={rollSeed}>
          New seed
        </button>
        <button type="button" className="action-button" onClick={rollParams}>
          Randomize
        </button>
        <PresetControls
          sketchId={sketch.id}
          params={params}
          seed={seed}
          locks={locks}
          onReload={reloadPreset}
        />
      </div>
      <div className="seed-box">
        <label className="seed-box__label" htmlFor="sketch-seed">
          seed
        </label>
        <input
          id="sketch-seed"
          className="seed-box__input"
          type="number"
          value={seed}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (Number.isNaN(parsed)) return;
            setSeed(parsed);
          }}
        />
      </div>
      <LiveCanvas sketch={sketch} params={params} seed={seed} />
    </div>
  );
}
