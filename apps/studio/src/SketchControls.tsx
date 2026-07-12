import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  applyPreset,
  buildReproMetadata,
  clipSceneToBounds,
  defaultParams,
  exportFilename,
  insertPngMetadata,
  newSeed,
  plotDrawableAspectsEquivalent,
  plotDrawableRectangle,
  randomize,
  renderPlotterSVG,
  renderToSVG,
  resolveOutputProfile,
  resolvePlotCompositionFrame,
  type Preset,
  type Scene,
  type Sketch,
} from "@harness/core";

import { ControlPanel } from "./ControlPanel";
import { Button } from "./components/ui/button";
import { downloadBlob } from "./downloadBlob";
import {
  beginEditTransaction,
  canRedo,
  canUndo,
  cancelEditTransaction,
  commitEditState,
  commitEditTransaction,
  createEditHistory,
  hasActiveTransaction,
  previewEditState,
  redoEdit,
  undoEdit,
  type EditHistory,
  type StudioEditState,
} from "./editHistory";
import {
  fieldOwnsHistoryShortcut,
  historyShortcutFor,
} from "./historyShortcuts";
import {
  LiveCanvas,
  type DisplayedSceneSnapshot,
  type LiveCanvasHandle,
  type RenderMode,
} from "./LiveCanvas";
import { outlineScene } from "./outlineScene";
import { PaperSection } from "./PaperSection";
import {
  readPlotterSvgIncludePaperMargins,
  writePlotterSvgIncludePaperMargins,
} from "./plotterSvgPreference";
import { PresetControls } from "./PresetControls";
import { SeedControl } from "./SeedControl";
import { SimplifyControl } from "./SimplifyControl";

/** Select the exact hidden-line export input, lazily falling back on a cache miss. */
export function hiddenLineSceneForExport({
  displayed,
  currentT,
  renderMode,
  tolerance,
  includeFrame,
  generate,
}: {
  displayed: DisplayedSceneSnapshot | null;
  currentT: number;
  renderMode: RenderMode;
  tolerance: number;
  includeFrame: boolean;
  generate: () => Scene;
}): Scene {
  const cacheMatches =
    displayed !== null &&
    displayed.t === currentT &&
    displayed.renderMode === renderMode &&
    displayed.tolerance === tolerance &&
    displayed.includeFrame === includeFrame;
  if (!cacheMatches) return outlineScene(generate(), tolerance, includeFrame);
  return displayed.renderMode === "outline"
    ? displayed.scene
    : outlineScene(displayed.scene, tolerance, includeFrame);
}

/** Preset params are flat schema values; preserve identity when reload is equal. */
function sameParams(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]),
    )
  );
}

/** Whether moving between two authored states invalidates prepared Outline geometry. */
function outlineInputsChanged(
  previous: StudioEditState,
  next: StudioEditState,
): boolean {
  if (
    !sameParams(previous.params, next.params) ||
    previous.seed !== next.seed ||
    previous.tolerance !== next.tolerance ||
    previous.profile.includeFrame !== next.profile.includeFrame
  ) {
    return true;
  }

  const previousDrawable = plotDrawableRectangle(previous.profile);
  const nextDrawable = plotDrawableRectangle(next.profile);
  return !plotDrawableAspectsEquivalent(
    previousDrawable.width / previousDrawable.height,
    nextDrawable.width / nextDrawable.height,
  );
}

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
  const [history, setHistory] = useState<EditHistory>(() =>
    createEditHistory({
      params: defaultParams(sketch.schema),
      seed: newSeed(Math.random),
      locks: new Set<string>(),
      profile: resolveOutputProfile(undefined, sketch.defaultOutputProfile),
      tolerance: 0,
    }),
  );
  // Event lifecycles can emit begin/preview/commit in one React batch. Mirror the
  // latest transition synchronously so every signal sees the preceding result.
  const historyRef = useRef(history);
  historyRef.current = history;
  const { params, seed, locks, profile, tolerance } = history.present;
  // Export-document intent is Studio-wide and deliberately independent of the
  // keyed Sketch session: remounts lazily restore the persisted preference,
  // while Plot Profile, Preset, reproduction, and composition state stay pure.
  const [includePaperMargins, setIncludePaperMargins] = useState(
    readPlotterSvgIncludePaperMargins,
  );

  const commitIncludePaperMargins = (next: boolean): void => {
    setIncludePaperMargins(next);
    writePlotterSvgIncludePaperMargins(next);
  };

  // Physical magnitude belongs to later device mapping. Composition depends only
  // on the drawable rectangle's aspect, so equivalent profiles share this cache
  // boundary and do not rebuild prepared geometry.
  const drawable = plotDrawableRectangle(profile);
  const drawableAspect = drawable.width / drawable.height;
  // Stabilize the memo key across machine-noise-only quotient differences (for
  // example a 1.2× proportional scale of non-binary A4 dimensions/insets). The
  // same core equivalence drives commit invalidation below, so frame identity and
  // the Computing affordance cannot disagree about whether geometry changed.
  const drawableAspectIdentityRef = useRef(drawableAspect);
  if (
    !plotDrawableAspectsEquivalent(
      drawableAspectIdentityRef.current,
      drawableAspect,
    )
  ) {
    drawableAspectIdentityRef.current = drawableAspect;
  }
  const drawableAspectIdentity = drawableAspectIdentityRef.current;
  const compositionFrame = useMemo(
    () => resolvePlotCompositionFrame(profile),
    [drawableAspectIdentity],
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

  // Any params/seed edit WHILE in outline mode re-runs LiveCanvas's on-demand
  // Hidden-line pass. Mark computing here at the trigger (a slider drag, New seed,
  // Randomize, preset reload, seed field) so the "Computing…" label paints with
  // that edit's commit. A no-op in fill mode (no pass runs). See the flag above.
  const markOutlineRecomputing = () => {
    if (renderMode === "outline") setComputingOutline(true);
  };

  const updateHistory = (
    transition: (current: EditHistory) => EditHistory,
  ): void => {
    const current = historyRef.current;
    const next = transition(current);
    if (next === current) return;
    historyRef.current = next;
    if (outlineInputsChanged(current.present, next.present)) {
      markOutlineRecomputing();
    }
    setHistory(next);
  };

  // History belongs to this keyed Sketch session, so its keyboard listener does
  // too. Text/numeric editors keep native Undo while a preview transaction is
  // active; once Enter/blur settles it, the same focused authored field may
  // traverse Studio history. Explicitly excluded text remains native always.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const command = historyShortcutFor(event);
      if (command === null) return;

      const current = historyRef.current;
      if (
        fieldOwnsHistoryShortcut(
          event.target,
          hasActiveTransaction(current),
        )
      ) {
        return;
      }
      if (command === "undo" ? !canUndo(current) : !canRedo(current)) return;

      event.preventDefault();
      updateHistory(command === "undo" ? undoEdit : redoEdit);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [renderMode]);

  const previewLeaf = <Key extends keyof StudioEditState>(
    key: Key,
    value: StudioEditState[Key],
  ): void => {
    updateHistory((current) =>
      previewEditState(current, { ...current.present, [key]: value }),
    );
  };

  const commitLeaf = <Key extends keyof StudioEditState>(
    key: Key,
    value: StudioEditState[Key],
  ): void => {
    updateHistory((current) =>
      commitEditState(current, { ...current.present, [key]: value }),
    );
  };

  const beginTransaction = (): void =>
    updateHistory(beginEditTransaction);
  const commitTransaction = (): void =>
    updateHistory(commitEditTransaction);
  const cancelTransaction = (): void =>
    updateHistory(cancelEditTransaction);

  // The read-only window into LiveCanvas (the live <canvas> + current t) the PNG
  // export snapshots. It is a ref, not state — export reads it imperatively on a
  // button click, never during render.
  const canvasHandle = useRef<LiveCanvasHandle>(null);

  // Value type mirrors ControlPanel's onChange seam: `number` from a
  // NumberControl, a hex color `string` from a ColorControl. The params state
  // itself is `Record<string, unknown>`, so only this handler widens.
  const setParam = (key: string, value: number | string) => {
    commitLeaf("params", { ...historyRef.current.present.params, [key]: value });
  };

  // Toggle a single param's lock membership. Locks are read ONLY by randomize;
  // toggling one never touches the param's value or its editability.
  const toggleLock = (key: string) => {
    const next = new Set(historyRef.current.present.locks);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    commitLeaf("locks", next);
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
    commitLeaf("seed", newSeed(Math.random));
  };

  // Randomize: re-roll the unlocked numeric params. The engine reads the current
  // `locks` set (locked keys pass through unchanged) and a `Math.random`-backed
  // source — no roll logic lives here.
  const rollParams = () => {
    const current = historyRef.current.present;
    commitLeaf(
      "params",
      randomize(sketch.schema, current.params, current.locks, Math.random),
    );
  };

  // Reload a saved Preset: reconcile it against the CURRENT schema via core's
  // `applyPreset` (the authority on which keys exist), then hydrate all three
  // state axes TOGETHER. The array→Set conversion on `locks` is this owner's
  // job — `applyPreset` returns a sorted string[], the studio's live lock state
  // is a Set<string>.
  const reloadPreset = (preset: Preset) => {
    const current = historyRef.current.present;
    const state = applyPreset(sketch.schema, preset);
    const resolvedProfile = resolveOutputProfile(
      state.profile,
      sketch.defaultOutputProfile,
    );
    // Resolve the active profile through #265's precedence: a v2 Preset's stored
    // profile (`state.profile`) wins; a v1 Preset (`state.profile === undefined`)
    // falls back to this Sketch's default / the Harness fallback. `applyPreset`
    // passes the stored profile through verbatim WITHOUT resolving the fallback —
    // resolving it here at the session boundary is #267's job.
    updateHistory((historyState) =>
      commitEditState(historyState, {
        ...current,
        params: sameParams(current.params, state.params)
          ? current.params
          : state.params,
        seed: state.seed,
        locks: new Set(state.locks),
        profile: resolvedProfile,
      }),
    );
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
    // Outline inputs/profile can commit before LiveCanvas's intentionally
    // deferred two-rAF rebuild lands. Never snapshot those stale pixels with the
    // newly committed reproduction metadata, even if this handler is invoked
    // programmatically while the disabled button cannot be clicked.
    if (computingOutline) return;
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
  // it with core's `renderToSVG`. Plain SVG deliberately keeps this cold path;
  // the displayed-Scene snapshot is consumed only by Hidden-line export, where
  // generation and occlusion processing are materially expensive.
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
  // Scene through the shared {@link outlineScene} processing seam BEFORE
  // serialization. Routing through that ONE seam — the same processing
  // LiveCanvas's outline preview consumes — is what makes preview == export true
  // by construction (issue #220): the two paths cannot drift after sampling. It
  // is the same one-shot click OUTSIDE the per-frame loop; the pass is heavy and
  // on-demand only, so it runs HERE inside the handler — never in render or the
  // live loop.
  //
  // Sampling still mirrors `exportSvg` exactly (same handle guard, time gating,
  // displayed state, and reproduction envelope). Serialization deliberately
  // differs: plotter output maps the clipped Scene through the active physical
  // profile, while ordinary SVG remains on `renderToSVG`. The file keeps its
  // `-hidden-line` variant segment and existing time-gated name.
  const exportHiddenLineSvg = () => {
    const handle = canvasHandle.current;
    if (handle == null) return;
    const displayed = handle.getDisplayedScene();
    const currentT = handle.getCurrentT();
    const t = sketch.time === undefined ? undefined : currentT;
    // Reuse only an atomic snapshot matching the current t/mode/tolerance. An
    // outline snapshot is already the exact processed preview Scene; a fill
    // snapshot is the exact displayed source fed through the shared seam here.
    // A null/stale snapshot falls back to cold generation plus that same seam.
    const hiddenLineScene = hiddenLineSceneForExport({
      displayed,
      currentT,
      renderMode,
      tolerance,
      includeFrame: profile.includeFrame,
      generate: () =>
        sketch.generate(params, seed, t ?? 0, compositionFrame),
    });
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
    const svg = renderPlotterSVG(clipped, profile, metadata, {
      includePaperMargins,
    });
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
        <PaperSection
          profile={profile}
          transaction={{
            onBegin: beginTransaction,
            onPreview: (next) => previewLeaf("profile", next),
            onCommit: commitTransaction,
            onCancel: cancelTransaction,
          }}
          onAtomicChange={(next) => commitLeaf("profile", next)}
          includePaperMargins={includePaperMargins}
          onIncludePaperMarginsChange={commitIncludePaperMargins}
        />
        <ControlPanel
          schema={sketch.schema}
          params={params}
          locks={locks}
          onChange={setParam}
          editHistory={{
            onBegin: beginTransaction,
            onPreview: (next) => previewLeaf("params", next),
            onCommit: commitTransaction,
            onCancel: cancelTransaction,
          }}
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
        <SeedControl
          value={seed}
          editHistory={{
            onBegin: beginTransaction,
            onPreview: (next) => previewLeaf("seed", next),
            onCommit: commitTransaction,
            onCancel: cancelTransaction,
          }}
        />
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
         * export (`outlineScene`'s tolerance arg), so simplification is identical
         * in preview and export by construction. Slider + number input are two-way
         * bound to the same value through `setToleranceValue` (continuous, in
         * [0, TOLERANCE_MAX]; 0 = identity, no simplification). It sits between
         * the render toggle and the export group since it only affects the
         * outline preview and the hidden-line export.
         */}
        <SimplifyControl
          value={tolerance}
          editHistory={{
            onBegin: beginTransaction,
            onPreview: (next) => previewLeaf("tolerance", next),
            onCommit: commitTransaction,
            onCancel: cancelTransaction,
          }}
        />
        {/*
         * Export controls — the shared home for every export path (PNG snapshots
         * the live canvas frame; SVG re-bakes the displayed Scene; Hidden-line SVG
         * reuses an exact displayed Scene when available, then occlusion-clips as
         * needed for plotting). The buttons split the row
         * (`flex-1`) and wrap as the group grows.
         */}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={exportPng}
            disabled={computingOutline}
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
