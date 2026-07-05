import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import {
  applyPreset,
  buildReproMetadata,
  defaultParams,
  exportFilename,
  insertPngMetadata,
  newSeed,
  randomize,
  renderToSVG,
  type Preset,
  type Sketch,
} from "@harness/core";

import { ControlPanel } from "./ControlPanel";
import { Button } from "./components/ui/button";
import { downloadBlob } from "./downloadBlob";
import { LiveCanvas, type LiveCanvasHandle } from "./LiveCanvas";
import { PresetControls } from "./PresetControls";

/**
 * Props for {@link SketchControls}.
 */
export interface SketchControlsProps {
  /** The selected Sketch whose schema drives the controls and whose Scene renders. */
  sketch: Sketch;
  /**
   * The Sketch switcher, owned by App (it drives selection, which lives ABOVE
   * this keyed-remount instance) and rendered as a slot at the inspector
   * sidebar's top. Passed in rather than built here so switching Sketch — which
   * remounts this component — never resets the switcher's own selection state.
   * Optional: the control-wiring tests mount this component without a switcher,
   * in which case the sidebar simply renders no switcher slot.
   */
  switcher?: ReactNode;
  /**
   * Whether the inspector sidebar is hidden (#154). Owned by App (above this
   * keyed remount) so it persists across Sketch switches. When true the sidebar
   * is not rendered and the canvas region takes the full width. Defaults to
   * shown for the wiring tests, which mount without this prop.
   */
  collapsed?: boolean;
  /** Toggle the {@link collapsed} state — wired to the canvas-region toggle button. */
  onToggleCollapse?: () => void;
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
export function SketchControls({
  sketch,
  switcher,
  collapsed = false,
  onToggleCollapse,
}: SketchControlsProps) {
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
    // The reproduction envelope embedded into BOTH exports (issue #76), built
    // once from the same displayed `(params, seed, locks, t)` spine.
    const metadata = buildReproMetadata({
      sketchId: sketch.id,
      seed,
      params,
      locks,
      t,
    });
    canvas.toBlob((blob) => {
      if (blob === null) return;
      const filename = exportFilename({ sketchId: sketch.id, seed, t }, "png");
      // Splice the iTXt reproduction chunk into the PNG bytes before saving, so
      // the downloaded file traces back to this exact frame. Byte work is core's
      // (`insertPngMetadata`); the Studio only does the Blob ⇄ ArrayBuffer dance.
      void blob.arrayBuffer().then((buffer) => {
        const withMeta = insertPngMetadata(new Uint8Array(buffer), metadata);
        // `withMeta` spans its whole backing buffer (core's `concat` allocates a
        // fresh, offset-0 array), so `.buffer` is exactly these bytes.
        downloadBlob(
          new Blob([withMeta.buffer as ArrayBuffer], { type: "image/png" }),
          filename,
        );
      });
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
    // Embed the same reproduction envelope as a <metadata> element (issue #76),
    // built from the displayed `(params, seed, locks, t)` spine — core's
    // `renderToSVG` does the injection (ADR-0004: serialization lives in core).
    const metadata = buildReproMetadata({
      sketchId: sketch.id,
      seed,
      params,
      locks,
      t,
    });
    const svg = renderToSVG(scene, metadata);
    const blob = new Blob([svg], { type: "image/svg+xml" });
    downloadBlob(blob, exportFilename({ sketchId: sketch.id, seed, t }, "svg"));
  };

  // TWO-REGION SHELL (#154): the canvas region (left) fills the remaining space
  // and centers the live canvas; the fixed-width inspector sidebar (right,
  // vertically scrollable) houses EVERY per-sketch control. This is a re-housing
  // of the existing controls — their markup/styling is unchanged, only relocated
  // (shadcn restyling is later sibling work). Both regions read the SAME
  // params/seed/locks state this component owns, which is why the layout lives
  // here rather than in App. The canvas stage hands its full height to
  // LiveCanvas's own layout, which centers the canvas and pins the transport to a
  // slim bar at the bottom of the canvas area (#156). The App-owned `switcher`
  // slot renders at the sidebar top.
  return (
    <div className="studio-shell">
      <section className="canvas-region" aria-label="Canvas">
        {/*
         * The collapse toggle lives in the canvas region — NOT inside the
         * collapsing sidebar — so it stays visible (and the sidebar re-openable)
         * while collapsed. `[` is the equivalent keyboard shortcut (owned by App).
         */}
        <div className="canvas-region__bar">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
            aria-expanded={!collapsed}
            aria-controls="inspector"
            aria-label={collapsed ? "Show inspector" : "Hide inspector"}
            onClick={onToggleCollapse}
            title="Toggle inspector ([)"
          >
            {collapsed ? <PanelRightOpen aria-hidden /> : <PanelRightClose aria-hidden />}
          </Button>
        </div>
        <div className="canvas-region__stage">
          <LiveCanvas
            handleRef={canvasHandle}
            sketch={sketch}
            params={params}
            seed={seed}
          />
        </div>
      </section>
      {/*
       * The inspector stays MOUNTED in both states and merely `hidden` while
       * collapsed (#165), rather than being conditionally rendered. The
       * canvas-region toggle carries `aria-controls="inspector"`, so the target
       * element must exist even while collapsed — otherwise the very affordance a
       * screen-reader user relies on to RE-open the panel points at nothing. The
       * `[hidden]` attribute both removes it from the a11y tree and (via the
       * `.inspector[hidden] { display: none }` rule in App.css, which beats the
       * author `display: flex`) collapses it so the canvas takes the full width.
       */}
      <aside
        id="inspector"
        className="inspector"
        aria-label="Inspector"
        hidden={collapsed}
      >
        {switcher}
        <ControlPanel
          schema={sketch.schema}
          params={params}
          locks={locks}
          onChange={setParam}
          onToggleLock={toggleLock}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={rollSeed}
          >
            New seed
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={rollParams}
          >
            Randomize
          </Button>
          <PresetControls
            sketchId={sketch.id}
            params={params}
            seed={seed}
            locks={locks}
            onReload={reloadPreset}
          />
        </div>
        <div className="flex items-center gap-2">
          <label
            className="flex-none min-w-16 text-sm text-muted-foreground"
            htmlFor="sketch-seed"
          >
            seed
          </label>
          <input
            id="sketch-seed"
            className="flex-1 h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            type="number"
            value={seed}
            onChange={(event) => {
              // A blank field is a no-op, not seed 0: `Number("") === 0`, so an
              // empty value would otherwise silently commit 0. A typed 0 stays valid.
              if (event.target.value.trim() === "") return;
              const parsed = Number(event.target.value);
              if (Number.isNaN(parsed)) return;
              setSeed(parsed);
            }}
          />
        </div>
        {/*
         * Export controls — the shared home for both export paths (PNG snapshots
         * the live canvas frame; SVG re-bakes the displayed Scene). `mt-auto`
         * pins this group to the BOTTOM of the flex-column sidebar (#158) so it
         * stays anchored while everything above stacks from the top; the two
         * buttons split the row evenly (`flex-1`).
         */}
        <div className="mt-auto flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={exportPng}
          >
            Export PNG
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={exportSvg}
          >
            Export SVG
          </Button>
        </div>
      </aside>
    </div>
  );
}
