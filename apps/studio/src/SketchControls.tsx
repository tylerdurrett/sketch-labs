import { useState } from "react";

import { defaultParams, newSeed, type Sketch } from "@harness/core";

import { ControlPanel } from "./ControlPanel";
import { LiveCanvas } from "./LiveCanvas";

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
 */
export function SketchControls({ sketch }: SketchControlsProps) {
  const [params, setParams] = useState(() => defaultParams(sketch.schema));
  const [seed, setSeed] = useState(() => newSeed(Math.random));

  const setParam = (key: string, value: number) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="sketch-controls">
      <ControlPanel
        schema={sketch.schema}
        params={params}
        onChange={setParam}
      />
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
