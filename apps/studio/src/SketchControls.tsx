import { useRef, useState } from "react";

import {
  applyPreset,
  defaultParams,
  exportFilename,
  newSeed,
  randomize,
  renderToSVG,
  type Preset,
  type Sketch,
} from "@harness/core";

import { ControlPanel } from "./ControlPanel";
import { downloadBlob } from "./downloadBlob";
import { LiveCanvas, type LiveCanvasHandle } from "./LiveCanvas";
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

  // The read-only window into LiveCanvas (the live <canvas> + current t) the PNG
  // export snapshots. It is a ref, not state — export reads it imperatively on a
  // button click, never during render.
  const canvasHandle = useRef<LiveCanvasHandle>(null);

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

  // Export the CURRENTLY DISPLAYED frame as a PNG — a one-shot user action that
  // lives OUTSIDE the per-frame generate→bake→draw loop (it never re-renders or
  // re-generates). "Option A": snapshot the live canvas's backing-store pixels
  // (already DPR-sized by sizeToBox), so a retina user gets the crisp image they
  // see, not a downscaled one. `toBlob('image/png')` reads those pixels as-is.
  //
  // The filename's `-t{t}` segment is TIME-GATED on `sketch.time`: a time-driven
  // Sketch passes the captured `t` (the last-drawn moment from the handle), a
  // static Sketch omits `t` entirely so the name carries no segment.
  const exportPng = () => {
    const handle = canvasHandle.current;
    const canvas = handle?.getCanvas();
    if (handle == null || canvas == null) return;
    // Time-gate the `-t{t}` filename segment on `sketch.time`: a time-driven
    // Sketch carries its captured moment, a static one omits `t` entirely.
    const t = sketch.time === undefined ? undefined : handle.getCurrentT();
    canvas.toBlob((blob) => {
      if (blob === null) return;
      downloadBlob(blob, exportFilename({ sketchId: sketch.id, seed, t }, "png"));
    }, "image/png");
  };

  // Export the CURRENTLY DISPLAYED frame as a vector SVG — the sibling export
  // path to {@link exportPng}, also a one-shot click OUTSIDE the per-frame loop.
  // Unlike PNG (which snapshots the live canvas's pixels), SVG re-bakes the
  // displayed `(params, seed, t)` into a Scene via `sketch.generate` and serializes
  // it with core's `renderToSVG` — matching the PNG path's pattern keeps
  // LiveCanvas's handle unchanged (no Scene is threaded out of it).
  //
  // `t` is read from the handle and TIME-GATED on `sketch.time` exactly as the
  // PNG path does, so the regenerated Scene and the `-t{t}` filename segment both
  // reflect the same displayed moment (static Sketches pass `undefined`, not 0).
  const exportSvg = () => {
    const handle = canvasHandle.current;
    if (handle == null) return;
    const t = sketch.time === undefined ? undefined : handle.getCurrentT();
    // `generate` takes a concrete `t` (static Sketches conventionally get 0 and
    // ignore it); the gated `t` above — `undefined` for a static Sketch — is the
    // filename's time-segment source, so both reflect the same displayed moment.
    const scene = sketch.generate(params, seed, t ?? 0);
    const svg = renderToSVG(scene);
    const blob = new Blob([svg], { type: "image/svg+xml" });
    downloadBlob(blob, exportFilename({ sketchId: sketch.id, seed, t }, "svg"));
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
        {/*
         * Export controls — the shared home the SVG export sibling reuses. PNG is
         * the first path: it snapshots the live canvas's displayed frame (no
         * re-render, no offscreen canvas).
         */}
        <div className="export-controls">
          <button type="button" className="action-button" onClick={exportPng}>
            Export PNG
          </button>
          <button type="button" className="action-button" onClick={exportSvg}>
            Export SVG
          </button>
        </div>
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
      <LiveCanvas
        handleRef={canvasHandle}
        sketch={sketch}
        params={params}
        seed={seed}
      />
    </div>
  );
}
