import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";

import {
  applyPreset,
  buildReproMetadata,
  clamp,
  clipSceneToBounds,
  defaultParams,
  exportFilename,
  insertPngMetadata,
  newSeed,
  plotDrawableRectangle,
  randomize,
  renderToSVG,
  resolveOutputProfile,
  resolvePlotCompositionFrame,
  type PlotProfile,
  type Preset,
  type Sketch,
} from "@harness/core";

import { ControlPanel } from "./ControlPanel";
import { Button } from "./components/ui/button";
import { Slider } from "./components/ui/slider";
import { downloadBlob } from "./downloadBlob";
import {
  LiveCanvas,
  type LiveCanvasHandle,
  type RenderMode,
} from "./LiveCanvas";
import { outlineScene } from "./outlineScene";
import { PaperSection } from "./PaperSection";
import { PresetControls } from "./PresetControls";

/**
 * Upper bound of the studio simplification-tolerance knob (issue #232), in the
 * Scene's coordinate-space units. The Hidden-line pass runs in Scene space, and
 * the studio's sketches use spaces on the order of ~100 units, so a max of 20 is
 * a generous ceiling: it spans from 0 (identity — no simplification) through
 * aggressive vertex reduction while keeping the slider's useful range on the low
 * end where plotter-relevant reductions live. Non-integer (continuous) so fine
 * tolerances are reachable.
 */
const TOLERANCE_MAX = 20;

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
 *
 * PROFILE is the session's ONE active Plot Profile — the physical-plot output
 * dimensions (#247). Like params/seed/locks it lives in keyed-remount state, so
 * it is RESOLVED fresh per Sketch: the lazy initializer runs `resolveOutputProfile`
 * against THIS Sketch's own `defaultOutputProfile` (#265's precedence: preset ??
 * sketch default ?? Harness fallback), so a Sketch switch re-resolves from the
 * newly-mounted Sketch and NEVER reuses the previous Sketch's dimensions. It is
 * threaded through persistence and composition — captured into a saved Preset
 * (via `PresetControls` → `makePreset`), re-resolved on a Preset reload (a v2
 * Preset's stored profile wins; a v1 falls back to the Sketch default / Harness
 * fallback), and embedded into every export's reproduction metadata. Its drawable
 * aspect resolves the ONE Composition Frame shared by preview and vector exports.
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

  // The session's ONE active Plot Profile (#247), resolved per-Sketch in keyed-
  // remount state. The lazy initializer runs #265's precedence against THIS
  // Sketch's own default (no preset in play at mount ⇒ `undefined` first arg), so
  // a Sketch switch re-resolves from the freshly-mounted Sketch's default (or the
  // Harness fallback) and never reuses the previous Sketch's dimensions. See the
  // module header for how it threads through save / reload / export metadata.
  const [profile, setProfile] = useState<PlotProfile>(() =>
    resolveOutputProfile(undefined, sketch.defaultOutputProfile),
  );

  // Physical magnitude belongs to later device mapping. Composition depends only
  // on the drawable rectangle's aspect, so equivalent profiles share this cache
  // boundary and do not rebuild prepared geometry.
  const drawable = plotDrawableRectangle(profile);
  const drawableAspect = drawable.width / drawable.height;
  const compositionFrame = useMemo(
    () => resolvePlotCompositionFrame(profile),
    [drawableAspect],
  );

  // The preview's render mode (issue #219): `fill` (default) shows the live fill
  // preview; `outline` swaps in the Hidden-line pass's stroke-only, occlusion-
  // clipped result — the same processed Scene the hidden-line SVG export emits —
  // recomputed on demand by LiveCanvas, never in its live fill loop. Like params/
  // seed/locks this lives in keyed-remount state, so a Sketch switch resets it to
  // `fill` for free (no manual reset effect).
  const [renderMode, setRenderMode] = useState<RenderMode>("fill");

  // Issue #228: while an outline draw's Hidden-line pass runs, LiveCanvas freezes
  // the main thread for seconds. This flag drives a "Computing…" label on the
  // render toggle so the action registers visibly. It MUST be set synchronously
  // at the trigger (the toggle click / any param-or-seed edit while in outline)
  // so React paints the "Computing…" button with that same commit — before the
  // blocking pass runs. A flag set from inside LiveCanvas's draw effect paints
  // too late (the pass blocks the very frame it would paint on). LiveCanvas CLEARS
  // it via `onOutlineComputed` once the outline is drawn. Lives in keyed-remount
  // state alongside renderMode, so a Sketch switch resets it to `false` for free.
  const [computingOutline, setComputingOutline] = useState(false);

  // The Douglas–Peucker tolerance (issue #232) for the Hidden-line pass's FINAL
  // simplification stage. It is a STUDIO-level knob (NOT a per-sketch schema
  // param): the pass runs AFTER `sketch.generate`, so simplification is a
  // post-generation studio concern, not part of any Sketch's declared inputs.
  // This ONE state feeds BOTH the outline preview (via LiveCanvas's `tolerance`
  // prop) and the hidden-line SVG export (the 5th arg to `outlineScene` in
  // `exportHiddenLineSvg`), so preview and export simplify identically (AC2/AC3).
  // Like the other axes it lives in keyed-remount state, so a Sketch switch
  // resets it to 0 (no simplification) for free. 0 is an identity no-op.
  const [tolerance, setTolerance] = useState(0);

  // Commit a tolerance change from the knob: clamp into [0, TOLERANCE_MAX] and,
  // while in outline mode, mark the outline recomputing so the "Computing…"
  // affordance paints with this commit — mirroring the param-edit path — before
  // LiveCanvas re-runs the (blocking) pass at the new tolerance. A NaN raw is
  // dropped by the input's own guard, so this only receives finite numbers.
  const setToleranceValue = (next: number) => {
    markOutlineRecomputing();
    setTolerance(clamp(next, 0, TOLERANCE_MAX));
  };

  // Any params/seed edit WHILE in outline mode re-runs LiveCanvas's on-demand
  // Hidden-line pass. Mark computing here at the trigger (a slider drag, New seed,
  // Randomize, preset reload, seed field) so the "Computing…" label paints with
  // that edit's commit. A no-op in fill mode (no pass runs). See the flag above.
  const markOutlineRecomputing = () => {
    if (renderMode === "outline") setComputingOutline(true);
  };

  // PaperSection only emits complete, validated profiles. Keep that controlled
  // commit as the boundary between physical preview layout and generated Scene
  // geometry: every profile refreshes the full-sheet chrome, while only a
  // changed drawable aspect invalidates the shared Composition Frame (and thus
  // the outline pass). Same-aspect magnitude/inset edits deliberately leave the
  // frame identity and outline geometry untouched.
  const commitProfile = (next: PlotProfile) => {
    const nextDrawable = plotDrawableRectangle(next);
    const nextDrawableAspect = nextDrawable.width / nextDrawable.height;
    if (nextDrawableAspect !== drawableAspect) markOutlineRecomputing();
    setProfile(next);
  };

  // The read-only window into LiveCanvas (the live <canvas> + current t) the PNG
  // export snapshots. It is a ref, not state — export reads it imperatively on a
  // button click, never during render.
  const canvasHandle = useRef<LiveCanvasHandle>(null);

  // Value type mirrors ControlPanel's onChange seam: `number` from a
  // NumberControl, a hex color `string` from a ColorControl. The params state
  // itself is `Record<string, unknown>`, so only this handler widens.
  const setParam = (key: string, value: number | string) => {
    markOutlineRecomputing();
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

  // Flip the preview between fill and outline (issue #219). A view-only toggle:
  // it swaps which processed Scene LiveCanvas draws and touches no param/seed/lock
  // axis. The heavy Hidden-line pass runs inside LiveCanvas on demand (on this
  // toggle / a param settle), never in its live fill loop.
  const toggleRenderMode = () => {
    const next = renderMode === "outline" ? "fill" : "outline";
    // Set/clear the busy flag SYNCHRONOUSLY with the flip so the button paints its
    // "Computing…" state in this same commit — before LiveCanvas's effect runs the
    // blocking pass (#228). Flipping to fill clears it: no pass runs there.
    setComputingOutline(next === "outline");
    setRenderMode(next);
  };

  // New seed: roll a fresh arrangement, leaving every param value untouched —
  // the seed axis is independent of the param (Randomize) axis.
  const rollSeed = () => {
    markOutlineRecomputing();
    setSeed(newSeed(Math.random));
  };

  // Randomize: re-roll the unlocked numeric params. The engine reads the current
  // `locks` set (locked keys pass through unchanged) and a `Math.random`-backed
  // source — no roll logic lives here.
  const rollParams = () => {
    markOutlineRecomputing();
    setParams((prev) => randomize(sketch.schema, prev, locks, Math.random));
  };

  // Reload a saved Preset: reconcile it against the CURRENT schema via core's
  // `applyPreset` (the authority on which keys exist), then hydrate all three
  // state axes TOGETHER. The array→Set conversion on `locks` is this owner's
  // job — `applyPreset` returns a sorted string[], the studio's live lock state
  // is a Set<string>.
  const reloadPreset = (preset: Preset) => {
    markOutlineRecomputing();
    const state = applyPreset(sketch.schema, preset);
    setParams(state.params);
    setSeed(state.seed);
    setLocks(new Set(state.locks));
    // Resolve the active profile through #265's precedence: a v2 Preset's stored
    // profile (`state.profile`) wins; a v1 Preset (`state.profile === undefined`)
    // falls back to this Sketch's default / the Harness fallback. `applyPreset`
    // passes the stored profile through verbatim WITHOUT resolving the fallback —
    // resolving it here at the session boundary is #267's job.
    setProfile(resolveOutputProfile(state.profile, sketch.defaultOutputProfile));
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
    // once from the same displayed `(params, seed, locks, t)` spine. The active
    // Plot Profile (#247) rides along too, so the exported PNG's metadata is a v2
    // Preset carrying the physical-plot output dimensions.
    const metadata = buildReproMetadata({
      sketchId: sketch.id,
      seed,
      params,
      locks,
      t,
      profile,
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
    const scene = sketch.generate(params, seed, t ?? 0, compositionFrame);
    // Clip the generated geometry to the canvas rectangle so the exported plot
    // contains nothing beyond the Scene's own `space` (issue #237). Export-time
    // ONLY — this pure Scene→Scene transform never runs in the live fill loop.
    const clipped = clipSceneToBounds(scene);
    // Embed the same reproduction envelope as a <metadata> element (issue #76),
    // built from the displayed `(params, seed, locks, t)` spine plus the active
    // Plot Profile (#247) — core's `renderToSVG` does the injection (ADR-0004:
    // serialization lives in core).
    const metadata = buildReproMetadata({
      sketchId: sketch.id,
      seed,
      params,
      locks,
      t,
      profile,
    });
    const svg = renderToSVG(clipped, metadata);
    const blob = new Blob([svg], { type: "image/svg+xml" });
    downloadBlob(blob, exportFilename({ sketchId: sketch.id, seed, t }, "svg"));
  };

  // Export the CURRENTLY DISPLAYED frame as a HIDDEN-LINE SVG — a plotter-ready
  // variant of {@link exportSvg} that derives its stroke-only, occlusion-clipped
  // Scene from the shared {@link outlineScene} seam (`generate` → Hidden-line
  // pass) BEFORE serialization. Routing through that ONE seam — the same
  // derivation LiveCanvas's outline preview consumes — is what makes preview ==
  // export true by construction (issue #220): the two paths cannot drift because
  // there is only one place the processed Scene is derived. It is the same
  // one-shot click OUTSIDE the per-frame loop; the pass is heavy and on-demand
  // only, so it runs HERE inside the handler — never in render or the live loop.
  //
  // Everything else mirrors `exportSvg` exactly (same handle guard, same
  // `sketch.time` time-gating of `t`, same displayed `(params, seed, t)` spine,
  // same reproduction envelope), so both SVG exports reflect the identical
  // displayed moment. The file is tagged with a `-hidden-line` variant segment so
  // it never collides with the plain SVG export's name.
  const exportHiddenLineSvg = () => {
    const handle = canvasHandle.current;
    if (handle == null) return;
    const t = sketch.time === undefined ? undefined : handle.getCurrentT();
    // The shared preview == export seam: `generate` then the occlusion-clipping
    // Hidden-line pass, on-demand only, strictly inside this click handler. The
    // studio `tolerance` knob is forwarded as the 5th arg so the exported paths
    // carry the SAME final Douglas–Peucker simplification the outline preview
    // shows (issue #232) — both read this one state through this one seam.
    // `renderToSVG` then serializes the stroke-only result.
    const hiddenLineScene = outlineScene(
      sketch,
      params,
      seed,
      t ?? 0,
      compositionFrame,
      tolerance,
    );
    // Clip AFTER the hidden-line pass and BEFORE serialization (issue #237): the
    // pass can emit stroke geometry beyond the canvas, so the clip is the last
    // export-only stage that guarantees no plotted line escapes `space`. The clip
    // stays out of `outlineScene` itself — that seam also feeds the live outline
    // preview (LiveCanvas), and clipping must remain export-only.
    const clipped = clipSceneToBounds(hiddenLineScene);
    // Same reproduction envelope + active Plot Profile (#247) as the other exports.
    const metadata = buildReproMetadata({
      sketchId: sketch.id,
      seed,
      params,
      locks,
      t,
      profile,
    });
    const svg = renderToSVG(clipped, metadata);
    const blob = new Blob([svg], { type: "image/svg+xml" });
    downloadBlob(
      blob,
      exportFilename(
        { sketchId: sketch.id, seed, t, variant: "hidden-line" },
        "svg",
      ),
    );
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
            compositionFrame={compositionFrame}
            profile={profile}
            renderMode={renderMode}
            tolerance={tolerance}
            onOutlineComputed={() => setComputingOutline(false)}
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
        <PaperSection profile={profile} onChange={commitProfile} />
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
            profile={profile}
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
              markOutlineRecomputing();
              setSeed(parsed);
            }}
          />
        </div>
        {/*
         * Render-mode toggle (#219) — swaps the whole preview between the live
         * fill render and the on-demand Hidden-line (outline) render. `mt-auto`
         * pins this to the bottom of the flex-column sidebar so it sits just above
         * the export group (the two anchor together as the sidebar's footer). It
         * is a view-only toggle: `aria-pressed` reflects outline, and flipping it
         * changes nothing about params/seed/locks.
         *
         * While an outline pass is running (#228) the label reads "Computing…" and
         * the button is disabled + `aria-busy` — static feedback that the (page-
         * freezing) Hidden-line pass is underway. `computingOutline` is set at the
         * trigger and cleared by LiveCanvas's `onOutlineComputed`.
         */}
        <div className="mt-auto flex items-center gap-2">
          <span className="flex-none min-w-16 text-sm text-muted-foreground">
            render
          </span>
          <Button
            type="button"
            variant={renderMode === "outline" ? "default" : "outline"}
            size="sm"
            className="flex-1"
            aria-pressed={renderMode === "outline"}
            aria-busy={computingOutline}
            disabled={computingOutline}
            aria-label="Toggle outline render mode"
            onClick={toggleRenderMode}
          >
            {computingOutline
              ? "Computing…"
              : renderMode === "outline"
                ? "Outline"
                : "Fill"}
          </Button>
        </div>
        {/*
         * Simplification tolerance knob (#232) — a STUDIO-level control (not a
         * per-sketch schema param) driving the Hidden-line pass's final
         * Douglas–Peucker stage. Its single `tolerance` state feeds BOTH the
         * outline preview (LiveCanvas `tolerance` prop) and the hidden-line SVG
         * export (`outlineScene`'s 5th arg), so simplification is identical in
         * preview and export by construction. Slider + number input are two-way
         * bound to the same value through `setToleranceValue` (continuous, in
         * [0, TOLERANCE_MAX]; 0 = identity, no simplification). It sits between
         * the render toggle and the export group since it only affects the
         * outline preview and the hidden-line export.
         */}
        <div className="flex items-center gap-2">
          <label
            className="flex-none min-w-16 text-sm text-muted-foreground"
            htmlFor="sketch-tolerance"
          >
            simplify
          </label>
          <Slider
            aria-label="Simplification tolerance"
            className="flex-1"
            min={0}
            max={TOLERANCE_MAX}
            step={TOLERANCE_MAX / 1000}
            value={tolerance}
            onValueChange={setToleranceValue}
          />
          <input
            id="sketch-tolerance"
            className="w-16 rounded-md border border-input bg-transparent px-3 py-1 text-right text-sm tabular-nums shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            type="number"
            min={0}
            max={TOLERANCE_MAX}
            step="any"
            value={tolerance}
            onChange={(event) => {
              // A blank field is a no-op (don't commit `Number("") === 0`); a
              // NaN is dropped so only finite values reach the clamp.
              if (event.target.value.trim() === "") return;
              const parsed = Number(event.target.value);
              if (Number.isNaN(parsed)) return;
              setToleranceValue(parsed);
            }}
          />
        </div>
        {/*
         * Export controls — the shared home for every export path (PNG snapshots
         * the live canvas frame; SVG re-bakes the displayed Scene; Hidden-line SVG
         * re-bakes then occlusion-clips it for plotting). The buttons split the row
         * (`flex-1`) and wrap as the group grows.
         */}
        <div className="flex flex-wrap gap-2">
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={exportHiddenLineSvg}
          >
            Export Hidden-line SVG
          </Button>
        </div>
      </aside>
    </div>
  );
}
