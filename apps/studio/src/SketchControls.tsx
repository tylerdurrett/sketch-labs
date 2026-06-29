import { useState } from "react";

import { defaultParams, type Sketch } from "@harness/core";

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
 * `useState` initializer re-runs against the new Sketch's schema and the params
 * reset to that Sketch's defaults. There is deliberately NO manual reset effect;
 * the key remount IS the reset mechanism.
 */
export function SketchControls({ sketch }: SketchControlsProps) {
  const [params, setParams] = useState(() => defaultParams(sketch.schema));

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
      <LiveCanvas sketch={sketch} params={params} seed={`${sketch.id}-demo`} />
    </div>
  );
}
