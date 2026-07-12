import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";

import {
  drawSceneFitted,
  prepareSketch,
  type Canvas2DContext,
  type CoordinateSpace,
  type Params,
  type PlotProfile,
  type Scene,
  type Seed,
  type Sketch,
  type TimeMetadata,
} from "@harness/core";

import { outlineScene } from "./outlineScene";

/**
 * Which processed Scene the live preview renders (issue #219, feature #4).
 *
 * `fill` is the default, unchanged live path — `generate` → `drawSceneFitted`.
 * `outline` swaps the fill preview for the Hidden-line pass's stroke-only,
 * occlusion-clipped result (the same processed Scene the hidden-line SVG export
 * emits), drawn through the identical Canvas2D pipeline. The pass is expensive
 * and export-only/on-demand (feature #4's core invariant), so it runs strictly
 * on the static/on-demand redraw path — never inside the live rAF fill loop.
 */
export type RenderMode = "fill" | "outline";

/**
 * Map a wall-clock elapsed time onto the Sketch's timeline per its `mode`
 * (ADR-0002 time semantics): `loop` wraps `elapsed → [0, duration)` for a
 * seamless repeat; `one-shot` clamps at `duration` (plays once and holds). This
 * is the SINGLE owner of the mode→`t` mapping, shared by the rAF loop and the
 * scrubber's range so both honor the same `loop`/`one-shot` contract. Playback
 * (the rAF path) stays loop-only for now (ADR-0005), but this clamp arm is what
 * the scrubber's one-shot range relies on.
 */
function timeForElapsed(elapsedSeconds: number, time: TimeMetadata): number {
  return time.mode === "loop"
    ? elapsedSeconds % time.duration
    : Math.min(elapsedSeconds, time.duration);
}

/**
 * The imperative handle {@link LiveCanvas} exposes to its owner — the read-only
 * window the studio chrome needs to snapshot the DISPLAYED frame for export.
 *
 * LiveCanvas owns both the `<canvas>` DOM node and the live `t` (`tRef`), and
 * keeps them deliberately internal so nothing outside can drive the single-owner
 * draw model. Export, though, is a one-shot user action that must read the frame
 * already on screen WITHOUT entering the per-frame loop — so this handle surfaces
 * exactly two read-only getters and nothing that could mutate state or trigger a
 * draw. The owner (SketchControls) calls them on a button click to rasterize the
 * current backing-store pixels.
 */
export interface LiveCanvasHandle {
  /**
   * The live `<canvas>` element, or `null` before it mounts. Its backing store is
   * already DPR-sized by `sizeToBox`, so a `toBlob` snapshot is crisp by
   * construction (the displayed frame at device resolution).
   */
  getCanvas(): HTMLCanvasElement | null;
  /**
   * The last-drawn `t` (0 for a static Sketch, the held/last frame for an
   * animated one) — the captured moment the export filename's `-t{t}` segment
   * encodes. Read-only; reading it never advances or resets the clock.
   */
  getCurrentT(): number;
}

/**
 * Props for {@link LiveCanvas}.
 *
 * The Sketch and its inputs are passed in (the studio shell hardcodes the
 * circles Sketch for now; the registry/selection is a later task, #35).
 */
export interface LiveCanvasProps {
  /** The Sketch to render. */
  sketch: Sketch;
  /** Param values handed to `generate` (the Sketch falls back to defaults). */
  params: Params;
  /** The explicit Seed all of the Sketch's randomness derives from. */
  seed: Seed;
  /** The caller-resolved, aspect-bearing frame used by every composition path. */
  compositionFrame: CoordinateSpace;
  /** Physical sheet and inset proportions used only by the preview chrome. */
  profile: PlotProfile;
  /**
   * Which processed Scene the preview draws (issue #219). Optional, defaulting to
   * `fill` so the live path is unchanged when a caller omits it: `fill` renders
   * `generate`'s Scene as-is; `outline` derives its Scene from the shared
   * {@link outlineScene} seam (`generate` → Hidden-line pass — the SAME
   * derivation the hidden-line SVG export consumes, issue #220), showing the
   * stroke-only occlusion-clipped result. The outline pass is
   * on-demand only (feature #4 invariant) — it never runs inside the live rAF
   * fill loop; toggling to `outline` suspends that loop and draws once on the
   * static/on-demand redraw path, recomputing on toggle and param-settle.
   */
  renderMode?: RenderMode;
  /**
   * Douglas–Peucker tolerance (issue #232) fed into the Hidden-line pass's final
   * simplification stage via the shared {@link outlineScene} seam. Optional,
   * defaulting to 0 (identity — no simplification), so an omitting caller and the
   * fill path are unchanged. It applies ONLY in `outline` render mode (the fill
   * path never simplifies); a change RE-RUNS the on-demand outline redraw. The
   * owner (SketchControls) drives this AND the export from the SAME state, so
   * preview and export simplify identically (AC2/AC3).
   */
  tolerance?: number;
  /**
   * Optional ref the owner passes to obtain the read-only {@link LiveCanvasHandle}
   * — the live canvas node + current `t` — so the studio chrome can snapshot the
   * displayed frame for export WITHOUT reaching into the draw model. A plain prop
   * (not `forwardRef`) keeps the component a normal function and the handle an
   * explicit, documented part of the contract.
   */
  handleRef?: Ref<LiveCanvasHandle>;
  /**
   * Called once an OUTLINE draw has finished (the Hidden-line pass ran and the
   * result is on the canvas). The owner uses it to clear the "Computing…" busy
   * affordance it surfaces on the render toggle (issue #228). The busy state is
   * SET synchronously by the owner at the trigger (the toggle click / a param
   * edit) so it paints with that commit — before this blocking pass runs; this
   * callback is only the CLEAR half. Never fires for fill draws.
   */
  onOutlineComputed?: () => void;
}

/**
 * Paint an already-derived Scene onto `canvas`.
 *
 * Scene derivation is deliberately outside this pixel-only boundary. In
 * particular, Outline mode caches its expensive hidden-line result so a
 * ResizeObserver repaint can draw the same geometry into a resized backing store
 * without rerunning the pass. This component keeps the CALLER concerns ADR-0004
 * assigns to it: the canvas backing store is sized to its CSS box ×
 * `devicePixelRatio`. Clearing and the opaque background NO LONGER live here —
 * they graduated into `drawSceneFitted`, which resets to identity and paints the
 * full surface (defaulting to opaque white) before the fit, so the studio no
 * longer relies on the page's CSS background and a PNG export snapshots those
 * opaque pixels automatically (ADR-0004 amendment, issue #92). The
 * coordinate-space → pixel mapping itself — contain-fit (uniform scale + centering
 * letterbox), so `Stroke.width` (Scene-space units) scales correctly and the
 * aspect ratio is preserved — lives in that same ONE pipeline the studio and the
 * Remotion renderer both run (#85). The browser `CanvasRenderingContext2D` is
 * structurally assignable to core's `Canvas2DContext` port, so it is passed
 * directly with no adapter.
 */
function paintFrame(canvas: HTMLCanvasElement, rendered: Scene): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;

  // The browser CanvasRenderingContext2D has everything core's Canvas2DContext
  // port needs; its fillStyle/strokeStyle getters are merely typed wider
  // (string | CanvasGradient | CanvasPattern), which TS variance won't accept as
  // the port's `string`. Asserting to the port at this single boundary keeps
  // core headless (no DOM types) without any runtime adapter — the renderer only
  // ever writes color strings to those properties.
  const portCtx = ctx as Canvas2DContext;

  // Hand the background-fit-and-draw to core's shared pipeline: `drawSceneFitted`
  // resets to identity, paints the full surface (opaque white by default — the
  // per-frame clear graduated in with it), computes the contain-fit, and draws.
  // The studio and the Remotion renderer thus run one identical mapping AND one
  // identical backdrop — structural parity, not coincidence (ADR-0004 / #85 / #92).
  drawSceneFitted(portCtx, rendered, canvas.width, canvas.height);
}

/**
 * Size `canvas`'s backing store to its CSS box × `dpr`, keeping the CSS box as
 * the display size. Returns whether it actually changed the backing store.
 *
 * The backing store (`canvas.width`/`height`) is in device pixels so the drawing
 * is crisp on high-DPI displays; the CSS box (set via styling) stays the layout
 * size. Callers pass `window.devicePixelRatio || 1` (it is a parameter, not read
 * internally, so the dedup math is unit-testable with a DOM-free stub).
 *
 * The no-op guard is load-bearing: assigning `canvas.width`/`height` — even to
 * the SAME value — clears the entire backing store (an HTML spec side effect). So
 * when the target dimensions already match, this returns `false` WITHOUT
 * reassigning, leaving the existing pixels intact. That lets callers dedup
 * redundant clears: the geometry effect can size-then-draw only when something
 * really changed (`true`), while a paint-only redraw (params/seed change, no size
 * change) just draws over the untouched store. Only a genuine box or DPR change
 * yields new pixel dimensions → reassignment → `true`.
 *
 * @param canvas - The canvas to size (only `width`/`height`/`getBoundingClientRect`
 *   are read, so a structural stub can stand in for tests).
 * @param dpr - Device pixel ratio to multiply the CSS box by.
 * @returns `true` if the backing store dimensions changed, `false` if already sized.
 */
export function sizeToBox(canvas: HTMLCanvasElement, dpr: number): boolean {
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

/**
 * A large live canvas that renders a Sketch's Scene through core's Canvas2D
 * Scene Renderer.
 *
 * Time driver (this slice owns it): when `sketch.time` is present the component
 * runs a `requestAnimationFrame` loop feeding `t` as wall-clock ELAPSED SECONDS,
 * measured from a `performance.now()` baseline captured when the loop starts
 * (wall clock, not frame count). For `mode: 'loop'` the elapsed time is wrapped
 * into `[0, duration)` (`t = elapsedSeconds % duration`); one-shot driving is out
 * of scope (no one-shot Sketch exists yet). A STATIC Sketch (`sketch.time`
 * absent) renders ONCE at `t = 0` and starts no loop. The loop is cancelled in
 * the effect cleanup so no frames leak — correct under React StrictMode's
 * dev-only mount→unmount→remount double-invoke (each mount captures its own
 * `frameId` and cancels exactly that frame).
 *
 * Single-owner draw model — each draw concern has exactly ONE effect that owns it,
 * so a static frame reaches the canvas exactly once per relevant change:
 *   - The LOOP effect (keyed `[sketch, playing, renderMode]`) owns ANIMATED
 *     sketches in FILL mode only. Its `sketch.time === undefined` early-return is
 *     at the very top, so a static Sketch makes it do nothing at all (no size, no
 *     draw, no loop); an `outline` early-return (issue #219) likewise suspends it
 *     so the export-only Hidden-line pass never runs per frame. An animated fill
 *     Sketch sizes once and runs the rAF loop, reading `params`/`seed` through
 *     refs so an input change feeds the next frame without tearing down the loop
 *     and snapping the clock back to `t = 0` (issue #40). Only a Sketch switch
 *     (the desired restart) recaptures the `performance.now()` baseline.
 *   - The STATIC-REDRAW effect (keyed by the true geometry inputs) owns STATIC
 *     sketches always, PLUS animated sketches while
 *     in OUTLINE mode (issue #219) — there the rAF loop is suspended, so this
 *     on-demand path is the sole draw owner. It is the SOLE path that sizes+draws
 *     those frames: on mount, on a switch, on a params/seed change, and on a
 *     render-mode toggle (it always draws, since none of those carry a size
 *     change) — recomputing the outline on demand, never per animated frame.
 *   - The GEOMETRY effect (keyed on stable callbacks, NEVER `sketch`) owns
 *     draw-on-actual-resize. It re-sizes on box/DPR change and only redraws when
 *     `sizeToBox` reports a real change — so the `ResizeObserver`'s initial
 *     `.observe()` fire is a no-op (the owner already sized the store to the same
 *     dimensions), while a genuine resize or DPR change repaints. Depending only
 *     on stable callbacks means a resize never re-runs the loop effect or resets
 *     the clock baseline (issue #40 / the #41 resize contract).
 */
export function LiveCanvas({
  sketch,
  params,
  seed,
  compositionFrame,
  profile,
  renderMode = "fill",
  tolerance = 0,
  handleRef,
  onOutlineComputed,
}: LiveCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The latest expensive, processed Outline Scene. Geometry-input changes
  // replace it on the deferred on-demand path; box/DPR/profile-layout changes
  // only repaint this exact Scene into the resized backing store.
  const outlineFrameRef = useRef<Scene | null>(null);

  // Caller-owned preparation is keyed by the time-invariant determinism inputs
  // PLUS the Composition Frame. A prepared Sketch can retain immutable layout
  // derived from `(params, seed, frame)`; an ordinary Sketch receives a zero-state
  // adapter over its existing `generate`. Changing Sketch, params, seed, or the
  // Composition Frame invalidates exactly this sampler without touching the single
  // wall-clock `t` — the rAF baseline/`tRef` reads the sampler through
  // `preparedFrameRef`, which the post-commit effect resyncs, so the new layout is
  // sampled at the continuing `t`, not from 0 (ADR-0002/0005). Fixed-area
  // Composition Frames are determined by aspect, so the aspect — not caller
  // object identity — is the cache boundary. Recreating an equivalent frame does
  // not discard prepared geometry; changing drawable aspect does.
  const compositionAspect = compositionFrame.width / compositionFrame.height;
  const preparedFrame = useMemo(
    () => prepareSketch(sketch, params, seed, compositionFrame),
    [sketch, params, seed, compositionAspect],
  );

  // The paper's CSS-box aspect (#155): the `<canvas>` box is sized to the
  // COMPOSITION FRAME's aspect, not a fixed square and not the Sketch's own
  // generated space. The ratio is the caller-resolved frame's own
  // `width / height`. No throwaway Scene is sampled anymore
  // (the metadata that once short-circuited that probe was removed with the
  // widened contract in #251; the frame supersedes both). The ratio is threaded
  // onto `.live-canvas` as the `--paper-aspect` custom property; the CSS there
  // contain-fits the box against the stage at that ratio. This is a DISPLAY-BOX
  // concern only — the DPR backing store (`sizeToBox`) and the in-canvas
  // contain-fit (`drawSceneFitted`) are untouched, so PNG/SVG export still
  // snapshots the displayed frame. A degenerate frame (zero/non-finite extent)
  // falls back to a square.
  const paperAspect = useMemo(() => {
    const ratio = compositionFrame.width / compositionFrame.height;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  }, [compositionFrame]);

  // Inline the derived ratio as the `--paper-aspect` custom property the
  // `.live-canvas` rule reads for its `aspect-ratio` + contain-fit width. Cast
  // through CSSProperties: React types don't model custom-property keys.
  const paperStyle = { "--paper-aspect": paperAspect } as CSSProperties;

  // Full-sheet preview chrome. These are dimensionless ratios only: the browser
  // contain-fits a paper-shaped box, then positions the drawable frame inside it
  // from all four independent insets. No CSS pixel is claimed to be a physical
  // millimeter; actual device mapping remains an export concern.
  const sheetStyle = {
    "--sheet-aspect": profile.width / profile.height,
    "--plot-inset-top": `${(profile.insets.top / profile.height) * 100}%`,
    "--plot-inset-right": `${(profile.insets.right / profile.width) * 100}%`,
    "--plot-inset-bottom": `${(profile.insets.bottom / profile.height) * 100}%`,
    "--plot-inset-left": `${(profile.insets.left / profile.width) * 100}%`,
  } as CSSProperties;

  // The current params/seed are read through refs inside the rAF `tick` (and the
  // static redraw effect) so the loop effect does NOT depend on them. Keeping the
  // loop keyed on `sketch` alone means a params/seed change feeds new inputs into
  // the next frame WITHOUT tearing down the loop and resetting its wall-clock
  // baseline (issue #40). They are kept up to date by an effect (not assigned
  // during render) so a StrictMode double-render can't desync them.
  const paramsRef = useRef(params);
  const seedRef = useRef(seed);
  // `sketchRef` lets the clockless re-fit helper read the current Sketch without
  // a `sketch` dependency (so a resize never re-runs the clock effect). Kept in
  // sync by the same effect — assigned post-commit, not during render, so a
  // StrictMode double-render can't desync it.
  const sketchRef = useRef(sketch);
  // The latest caller-owned sampler follows the same post-commit ref discipline
  // as params/seed. The rAF effect does not depend on it, so invalidating
  // preparation never resets the animation clock; the next tick samples the new
  // immutable layout at the continuing `t`.
  const preparedFrameRef = useRef(preparedFrame);
  const compositionFrameRef = useRef(compositionFrame);
  // `renderModeRef` lets the stable on-demand draw callbacks (rebuild/repaint,
  // scrubTo) read the current mode without a `renderMode` dependency, so a mode
  // flip never re-runs the clock effect or resets the rAF baseline. Kept in sync
  // by the same post-commit effect so a StrictMode double-render can't desync it.
  const renderModeRef = useRef(renderMode);
  // `toleranceRef` lets the stable on-demand draw callbacks (rebuild/repaint,
  // scrubTo) read the current tolerance without a `tolerance` dependency, so the
  // clock effect and rAF baseline stay untouched by a knob change (issue #232).
  // Kept in sync by the same post-commit effect so a StrictMode double-render
  // can't desync it. The static outline-redraw effect lists `tolerance` directly
  // in its deps so a change RE-RUNS the pass.
  const toleranceRef = useRef(tolerance);
  // `onOutlineComputedRef` lets the outline draw fire the owner's "compute done"
  // callback WITHOUT listing it in the draw effect's deps — otherwise an inline
  // arrow from the parent (new identity each render) would re-run the effect and
  // re-trigger the pass every render. Kept in sync post-commit like the others.
  const onOutlineComputedRef = useRef(onOutlineComputed);
  useEffect(() => {
    paramsRef.current = params;
    seedRef.current = seed;
    sketchRef.current = sketch;
    preparedFrameRef.current = preparedFrame;
    compositionFrameRef.current = compositionFrame;
    renderModeRef.current = renderMode;
    toleranceRef.current = tolerance;
    onOutlineComputedRef.current = onOutlineComputed;
  }, [
    params,
    seed,
    sketch,
    preparedFrame,
    compositionFrame,
    renderMode,
    tolerance,
    onOutlineComputed,
  ]);

  // The latest `t` the loop has drawn (0 for a static Sketch). The resize re-fit
  // redraws THIS frame so a box change repaints the current moment, not t = 0 —
  // and crucially WITHOUT touching the clock's `start` baseline (the rAF loop
  // keeps advancing from where it was). It is a ref, not state, so updating it
  // every frame never re-renders.
  const tRef = useRef(0);

  // Expose the read-only export window to the owner: the live canvas node and the
  // current `t`. Both are READ through the existing refs — the getters never
  // advance the clock, resize the store, or trigger a draw, so the single-owner
  // draw model and the rAF baseline (ADR-0005, issue #40) are untouched. The
  // empty dep array keeps the handle identity stable; the getters always read the
  // latest ref values at call time.
  useImperativeHandle(
    handleRef,
    () => ({
      getCanvas: () => canvasRef.current,
      getCurrentT: () => tRef.current,
    }),
    [],
  );

  // The transport's PLAYING gate. An animated Sketch mounts playing (ADR-0005):
  // the rAF loop drives `t` and the scrubber thumb follows. Grabbing the scrubber
  // flips this to `false`, pausing the loop so `t` is held at the scrubbed frame.
  // This is React STATE (not a ref) because the play/pause control and the loop
  // effect both react to it — flipping it is what starts/stops the loop. Static
  // Sketches never start the loop, so the value is inert for them.
  const [playing, setPlaying] = useState(true);

  // The baseline-recapture offset (ADR-0005): when play RESUMES from a scrubbed
  // frame, the loop must continue from that `t`, not snap back to 0. We carry the
  // resume point as a ref the loop reads on (re)start to set
  // `start = performance.now() - resumeT*1000`, so the first tick computes
  // `elapsed` continuous from where the scrub left off. It is a ref (not a loop
  // dependency) so updating it never re-runs the loop on its own — only the
  // `playing` flip does, and it reads the latest resume point at that moment.
  const resumeTRef = useRef(0);

  // The scrubber range input. While PLAYING its thumb must FOLLOW `t` without
  // forcing a React re-render every frame (the whole reason `t` lives in a ref):
  // the rAF tick writes `scrubberRef.current.value` DOM-direct instead. While
  // PAUSED the user drives it and `onInput` becomes the source of `t`. Held as a
  // ref so the tick can reach the live element imperatively.
  const scrubberRef = useRef<HTMLInputElement>(null);

  // Derive and paint a geometry frame at `t`. Outline derivation runs only here
  // and stores its processed Scene for later pixel-only repaints; fill samples
  // the retained prepared frame directly. The callback stays stable because all
  // live inputs are read through refs.
  const rebuildAndDrawAt = useCallback((t: number) => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const rendered =
      renderModeRef.current === "outline"
        ? outlineScene(
            sketchRef.current,
            paramsRef.current,
            seedRef.current,
            t,
            compositionFrameRef.current,
            toleranceRef.current,
          )
        : preparedFrameRef.current(t);
    if (renderModeRef.current === "outline") {
      outlineFrameRef.current = rendered;
    }
    paintFrame(canvas, rendered);
  }, []);

  // Repaint the current geometry without deriving it again. Fill sampling is
  // cheap and time-aware; Outline must use the last processed cache so a pure
  // box/DPR/profile-layout resize cannot silently rerun hidden-line work without
  // the owner's Computing affordance.
  const repaintCurrentFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    if (renderModeRef.current === "outline") {
      const cached = outlineFrameRef.current;
      if (cached !== null) paintFrame(canvas, cached);
      return;
    }
    paintFrame(canvas, preparedFrameRef.current(tRef.current));
  }, []);

  // Re-fit then intentionally rebuild: this path is owned by true geometry
  // inputs (or a mode change), not by ResizeObserver layout repaints.
  const refitAndRebuild = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    sizeToBox(canvas, window.devicePixelRatio || 1);
    rebuildAndDrawAt(tRef.current);
  }, [rebuildAndDrawAt]);

  // Issue #223: preserve playback position across an outline↔fill flip. The loop
  // effect below re-keys on `renderMode` (#219), so a flip back to `fill` re-runs
  // it and recaptures its `start` baseline from `resumeTRef`. But `resumeTRef` is
  // synced to the live `tRef` only on resume/scrub — never on a mode flip — so
  // without this it still holds the last pause/resume/scrub value and snaps an
  // animated clock back toward 0 on the flip. Mirror togglePlay's resume path:
  // sync `resumeTRef` to the live `tRef` on every render-mode change so the
  // baseline continues from the frame the outline round-trip froze. It sits ABOVE
  // the loop effect on purpose — React runs effects top-to-bottom, so this sync
  // lands before the loop reads `resumeTRef` on the flip back to fill. This does
  // NOT touch the Sketch-switch restart (that keys on `sketch`, not `renderMode`).
  // The fill→outline direction is unaffected: the loop still early-returns for
  // outline and schedules no frame; this only refreshes the resume anchor.
  useEffect(() => {
    resumeTRef.current = tRef.current;
  }, [renderMode]);

  // The clock-bearing loop — the PLAYING half of the transport (ADR-0005). Keyed
  // on `[sketch, playing, renderMode]`: switching Sketch re-runs this and
  // recaptures `start` (the desired restart); toggling `playing` starts the loop
  // on resume or, via the cleanup, cancels the pending frame on pause so `t` is
  // held at the scrubbed frame; flipping `renderMode` suspends the loop for
  // outline and restarts it for fill (#219). A params/seed change does NOT
  // re-run it (read through refs), so the animation continues from where it
  // was. This effect owns ANIMATED
  // sketches ONLY: the `sketch.time === undefined` early-return is FIRST, before
  // any sizing or drawing, so a static Sketch makes it a complete no-op (the
  // static-redraw effect is the sole owner of static frames — no triple draw).
  useEffect(() => {
    const time = sketch.time;
    if (time === undefined) return;
    // Outline mode (issue #219) SUSPENDS the live loop: the Hidden-line pass is
    // export-only/on-demand (feature #4 invariant), so it must never run per
    // animated frame. Gating the whole loop off here — with `renderMode` in the
    // deps — makes the pass provably unreachable from `tick`; the on-demand
    // static-redraw effect draws the outline of the current frame instead, and a
    // flip back to `fill` re-runs this effect to restart the loop.
    if (renderMode === "outline") return;
    // Paused: the scrubber owns `t` (held at `resumeTRef`/`tRef`); run no loop.
    if (!playing) return;

    const canvas = canvasRef.current;
    if (canvas === null) return;

    // Animated Sketch: size the backing store once, then run the rAF loop. The
    // return value is ignored — this is a fresh mount/Sketch switch/resume, so a
    // draw happens on the first tick regardless.
    sizeToBox(canvas, window.devicePixelRatio || 1);

    let frameId = 0;
    // Baseline recapture (ADR-0005): subtract the resume point so the next tick's
    // `elapsed` continues from the scrubbed `t`, NOT from 0. On a fresh mount /
    // Sketch switch `resumeTRef` is 0, so this is `performance.now()` — the
    // original #6 behavior. After a scrub-then-play it is the scrubbed offset.
    const start = performance.now() - resumeTRef.current * 1000;

    const tick = (now: number) => {
      const elapsedSeconds = (now - start) / 1000;
      // Playback is loop-only for now (ADR-0005); `timeForElapsed` still routes
      // through the mode so the day a one-shot Sketch plays, this is correct.
      const t = timeForElapsed(elapsedSeconds, time);
      tRef.current = t;
      // The thumb follows `t` DOM-direct — no React state write, so the loop
      // never triggers a per-frame re-render (the #40 no-per-frame-render
      // property). The scrubber is uncontrolled while playing; React owns it
      // again only when the user grabs it (paused).
      if (scrubberRef.current !== null) scrubberRef.current.value = String(t);
      // `fill` is HARDCODED here (never `renderMode`/`renderModeRef`): this is the
      // live rAF loop, and the Hidden-line pass must never run per frame (feature
      // #4 invariant / AC2). The effect already early-returns in outline mode, so
      // this is doubly unreachable in outline — but hardcoding makes it a static
      // guarantee that `tick` can only ever draw fill. Tolerance is hardcoded 0
      // to match: the fill branch never simplifies, so the live loop stays
      // provably simplify-free (issue #232's on-demand-only invariant).
      paintFrame(canvas, preparedFrameRef.current(t));
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [sketch, playing, renderMode]);

  // The SOLE owner of static frames: the loop effect now early-returns for a
  // static Sketch, so this is the only path that sizes+draws one — on mount, on a
  // switch TO a static Sketch, and on a params/seed change — exactly once each,
  // without introducing a clock. For an animated Sketch the early return skips it
  // (the rAF loop owns its frames). `refitAndRebuild` re-fits the box (tRef is 0
  // for a static Sketch) and ALWAYS redraws through the refs, since a params/seed
  // change carries no size change for the geometry effect to react to.
  //
  // Issue #219 generalizes it to also own ANIMATED sketches WHILE in outline
  // mode: there the rAF loop is suspended (it early-returns for outline), so this
  // on-demand path is the sole draw owner then too — it recomputes the Hidden-line
  // outline on a mode toggle and on a param/seed settle (its deps), but NOT per
  // animated frame. The guard therefore skips only the case the live loop owns:
  // an animated Sketch in fill mode.
  //
  // Issue #228: the outline Hidden-line pass runs synchronously on the main
  // thread and freezes the page for seconds. The owner surfaces a "Computing…"
  // affordance on the render toggle — and it SETS that busy flag synchronously at
  // the trigger (the toggle click / a param edit), so it paints with that commit,
  // BEFORE this effect runs. That placement is load-bearing: a flag set from
  // inside this effect paints too late (the pass blocks the very frame the flag
  // would paint on — the original bug). Here we only need to (a) yield one frame
  // so the browser paints that already-committed busy state before the pass
  // blocks, and (b) CLEAR it via `onOutlineComputed` once the outline is drawn.
  useEffect(() => {
    if (sketch.time !== undefined && renderMode !== "outline") return;

    // FILL draws (a static Sketch in fill mode) stay on the cheap synchronous
    // path — no Hidden-line pass runs, so there is nothing to wait on.
    if (renderMode !== "outline") {
      refitAndRebuild();
      return;
    }

    // OUTLINE draw: let the owner's already-committed "Computing…" state paint
    // before refitAndRebuild runs the blocking Hidden-line pass, then fire
    // `onOutlineComputed` so the owner clears it. A DOUBLE rAF guarantees a full
    // painted frame elapses first: this effect runs in a post-commit macrotask,
    // and a single rAF scheduled from there can still fire in the SAME frame's
    // rendering steps — before that frame paints. The inner rAF runs on the NEXT
    // frame, after the busy state has provably painted, so the freeze never eats
    // its first paint (the ~16ms is nothing against a multi-second pass).
    //
    // Honest limitation (Option A): the page STILL freezes during the pass; the
    // affordance is STATIC feedback that the action registered, not a
    // responsiveness fix, and it does not animate. Moving the pass off the main
    // thread (Web Worker) is the deferred Option B follow-up.
    let innerFrame = 0;
    const outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => {
        refitAndRebuild();
        onOutlineComputedRef.current?.();
      });
    });
    // Supersede pending work: a rapid re-trigger (slider drag in outline, or a
    // flip away before the frames fire) re-runs this effect; cancel whichever
    // frame is pending so passes never stack. Also runs on unmount.
    // `cancelAnimationFrame(0)` is a no-op, so cancelling an unset innerFrame is safe.
    return () => {
      cancelAnimationFrame(outerFrame);
      cancelAnimationFrame(innerFrame);
    };
    // `tolerance` (issue #232) is a dep so a knob change in outline mode RE-RUNS
    // the on-demand pass at the new tolerance; `refitAndRebuild` reads the current
    // value through `toleranceRef`. Harmless for a static fill Sketch (it takes
    // the cheap fill early-return, no pass).
  }, [
    sketch,
    params,
    seed,
    compositionAspect,
    renderMode,
    tolerance,
    refitAndRebuild,
  ]);

  // Re-fit on box-size AND devicePixelRatio change (the #41 contract). DECOUPLED
  // from the clock effect on purpose: it depends on stable callbacks alone, never
  // on `sketch`, so it never tears down the rAF loop or re-captures the `start`
  // baseline — a resize must not snap the animation clock back to 0 (issue #40).
  // It owns draw-on-actual-resize: each signal re-sizes and redraws ONLY when
  // `sizeToBox` reports a real change (`true`). That makes the ResizeObserver's
  // initial `.observe()` fire a no-op skip (the owning effect already sized the
  // store to the same dimensions), so a static/animated mount is not double-drawn,
  // while a genuine box resize or DPR change DOES change the backing-store pixel
  // dimensions → `sizeToBox` returns `true` → exactly one redraw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    // Size to the current box/DPR; redraw only if the backing store actually
    // changed (skips the no-op initial observe fire and any spurious re-fit).
    const refitOnGeometryChange = () => {
      const dpr = window.devicePixelRatio || 1;
      if (sizeToBox(canvas, dpr)) repaintCurrentFrame();
    };

    // ResizeObserver covers CSS-box changes (window/container resize). It also
    // fires on observe; the no-op guard above turns that initial fire into a skip.
    const observer = new ResizeObserver(() => {
      refitOnGeometryChange();
    });
    observer.observe(canvas);

    // A pure DPR change (dragging the window to a different-DPI monitor with the
    // SAME CSS box) does NOT resize the box, so ResizeObserver stays silent. A
    // matchMedia `(resolution: <dpr>dppx)` listener fires exactly on that
    // transition. The query string is DPR-specific, so it must be RE-ARMED after
    // each fire against the new ratio (the old query no longer matches). A
    // recursive arm() keeps a live listener at the current DPR; only the latest
    // MediaQueryList is retained for cleanup.
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = () => {
      refitOnGeometryChange();
      arm();
    };
    const arm = () => {
      dprQuery?.removeEventListener("change", onDprChange);
      dprQuery = window.matchMedia(
        `(resolution: ${window.devicePixelRatio}dppx)`,
      );
      dprQuery.addEventListener("change", onDprChange);
    };
    arm();

    return () => {
      observer.disconnect();
      dprQuery?.removeEventListener("change", onDprChange);
    };
  }, [repaintCurrentFrame]);

  // Play/pause toggle — the transport's mode switch (ADR-0005). Pausing simply
  // flips `playing` to `false`, whose effect cleanup cancels the pending frame
  // and freezes `t` at the last drawn value. Resuming captures that frozen `t`
  // into `resumeTRef` so the loop effect's `start` recapture continues from there
  // (NOT 0), then flips `playing` true to (re)start the loop.
  const togglePlay = useCallback(() => {
    setPlaying((wasPlaying) => {
      if (wasPlaying) return false;
      // Resuming: net the baseline off the held frame so play is continuous.
      resumeTRef.current = tRef.current;
      return true;
    });
  }, []);

  // Grab/drag the scrubber: PAUSE the wall-clock loop and make `t` the scrubber's
  // value directly, re-rendering THAT exact frame (ADR-0005). Pausing flips
  // `playing` false so the loop effect's cleanup cancels the pending frame and
  // stops fighting the user. We write `tRef` AND `resumeTRef` to the scrubbed `t`
  // so the frozen frame is exact AND a later Play resumes from here (not 0), then
  // draw the frame straight away — the `setPlaying` re-render's loop teardown
  // won't draw, so this direct paint is what shows the scrubbed moment.
  const scrubTo = useCallback((value: number) => {
    tRef.current = value;
    resumeTRef.current = value;
    setPlaying(false);
    const canvas = canvasRef.current;
    if (canvas !== null) {
      rebuildAndDrawAt(value);
    }
  }, [rebuildAndDrawAt]);

  // LAYOUT (#156): LiveCanvas owns a column that FILLS the canvas region — the
  // canvas centered/fitted in the stage on top, the slim transport bar pinned to
  // the bottom. The transport handlers/refs live here alongside the canvas, so
  // keeping the markup together (rather than splitting it across the stage
  // boundary) is what lets the driver stay untouched. The transport shows ONLY
  // for an animated Sketch (`sketch.time` present); a static Sketch renders the
  // canvas alone in the same layout — no clock, no bar (exactly as before).
  const time = sketch.time;
  return (
    <div className="live-canvas-layout">
      <div className="live-canvas-stage">
        {/*
         * Full-sheet preview chrome (#248): the outer box follows the profile's
         * physical paper aspect; the inner wrapper follows all four inset ratios;
         * the real canvas fills only that drawable rectangle. The canvas remains
         * the sole rendered/exported pixel surface — neither margin chrome nor the
         * guide enters getCanvas()/PNG.
         */}
        <div
          className="plot-sheet"
          style={sheetStyle}
          role="group"
          aria-label="Plot sheet preview"
        >
          <div className="plot-drawable">
            <canvas ref={canvasRef} className="live-canvas" style={paperStyle} />
          </div>
        </div>
      </div>
      {/* The slim transport bar, pinned to the bottom of the canvas area (#156). */}
      {time !== undefined && (
        <div className="transport">
          <button
            type="button"
            className="transport__play"
            aria-pressed={playing}
            onClick={togglePlay}
          >
            {playing ? "Pause" : "Play"}
          </button>
          {/*
           * The scrubber. Range is metadata-driven: [0, duration] seconds, with
           * `loop`/`one-shot` differing only in how the rAF loop maps elapsed → `t`
           * (`timeForElapsed`) — the input bound stays `duration` either way. It is
           * UNCONTROLLED (no React `value`): while playing the rAF tick writes its
           * `.value` DOM-direct (thumb follows `t`, no per-frame re-render); while
           * grabbed `onInput` drives `t`. A small `step` gives a smooth drag.
           */}
          <input
            ref={scrubberRef}
            className="transport__scrubber"
            type="range"
            aria-label="time scrubber"
            min={0}
            max={time.duration}
            step={time.duration / 1000}
            defaultValue={0}
            onPointerDown={() => setPlaying(false)}
            onInput={(event) => scrubTo(Number(event.currentTarget.value))}
          />
        </div>
      )}
    </div>
  );
}
