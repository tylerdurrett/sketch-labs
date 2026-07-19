import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
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
  type PageFrame,
  type PlotProfile,
  type Scene,
  type Seed,
  type Sketch,
  type TimeMetadata,
  type ToneSource,
} from "@harness/core";

import { rasterizeToneReference } from "./toneReference";

/**
 * Which processed Scene the live preview renders (issue #219, feature #4).
 *
 * `fill` is the default, unchanged live path — prepared sample →
 * `drawSceneFitted`.
 * `outline` swaps the fill preview for the Hidden-line pass's stroke-only,
 * occlusion-clipped result (the same processed Scene the hidden-line SVG export
 * emits), drawn through the identical Canvas2D pipeline. The pass is expensive
 * and export-only/on-demand (feature #4's core invariant), so it runs strictly
 * on the static/on-demand redraw path — never inside the live rAF fill loop.
 */
export type RenderMode = "fill" | "outline";

/** An atomic record of the Scene that most recently reached the live canvas. */
export interface DisplayedSceneSnapshot {
  readonly scene: Scene;
  readonly t: number;
  readonly renderMode: RenderMode;
  readonly tolerance: number;
  readonly includeFrame: boolean;
  /** Authored-input revision from which a Fill Scene was sampled. */
  readonly inputRevision?: number;
  /** Authored-input revision from which this exact Scene originated. */
  readonly sourceInputRevision?: number;
  /** Caller-owned identity for this exact completed Scene content. */
  readonly contentRevision?: number;
}

export interface FillCaptureRequest {
  readonly token: number;
  readonly inputRevision: number;
  /** Provenance expected from caller-owned Fill geometry, when distinct. */
  readonly sourceInputRevision?: number;
  /** Exact caller-owned content expected to answer this request. */
  readonly contentRevision?: number;
}

export interface FillCapture extends FillCaptureRequest {
  readonly scene: Scene;
  readonly t: number;
  readonly sourceInputRevision: number;
  readonly contentRevision?: number;
}

/** Provenance supplied alongside caller-owned, already-derived geometry. */
export interface SuppliedSceneProvenance {
  readonly sourceInputRevision?: number;
  readonly contentRevision?: number;
}

/** Geometry ownership is explicit: LiveCanvas only derives live Fill frames. */
export type LiveCanvasRenderState =
  | { readonly kind: "fill-live" }
  | ({ readonly kind: "fill-held"; readonly scene: Scene; readonly t: number } &
      SuppliedSceneProvenance)
  | ({ readonly kind: "outline"; readonly scene: Scene; readonly t: number } &
      SuppliedSceneProvenance)
  | { readonly kind: "tone-reference"; readonly source: ToneSource }
  | {
      /**
       * Fail-closed presentation for authored Image Asset IDs that are not yet
       * usable. The IDs stay caller-owned and exact; LiveCanvas only presents
       * them and never repairs, resolves, or substitutes one.
       */
      readonly kind: "unavailable";
      readonly status: "loading" | "missing" | "error";
      readonly unresolvedAssetIds: readonly string[];
    };

const LIVE_FILL_RENDER_STATE: LiveCanvasRenderState = { kind: "fill-live" };

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
 * only read-only getters and nothing that could mutate state or trigger a
 * draw. The owner (SketchControls) reads them only from one-shot export handlers.
 */
export interface LiveCanvasHandle {
  /** Atomically read the retained record for the last committed canvas frame. */
  captureDisplayedFrame(): DisplayedSceneSnapshot | null;
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
  /**
   * The exact Scene most recently derived and painted, or `null` while geometry
   * inputs are awaiting their next draw. Read-only and caller-owned: export may
   * reuse it without asking the Sketch to regenerate the displayed frame.
   */
  getDisplayedScene(): DisplayedSceneSnapshot | null;
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
  /** Monotonic identity of the authored inputs used by live Fill sampling. */
  inputRevision?: number;
  /** One-shot request for the exact Fill Scene and time displayed at a revision. */
  fillCaptureRequest?: FillCaptureRequest | null;
  /** Answers a capture token at most once, and only from its matching revision. */
  onFillCaptured?: (capture: FillCapture) => void;
  /** Reports a Scene only after that exact Scene was successfully painted. */
  onDisplayedSceneCommitted?: (snapshot: DisplayedSceneSnapshot) => void;
  /**
   * Selects live Fill sampling, caller-owned held/Outline geometry, a
   * pixel-native Tone reference, or an explicit fail-closed unavailable state.
   * No non-live state invokes the Sketch generator.
   */
  renderState?: LiveCanvasRenderState;
  /** Export identity metadata retained in the displayed-scene handle. */
  tolerance?: number;
  /** Transient Page Frame draft; present only while Studio is editing framing. */
  pageFrameDraft?: PageFrame | null;
  /**
   * Optional ref the owner passes to obtain the read-only {@link LiveCanvasHandle}
   * — the live canvas node + current `t` — so the studio chrome can snapshot the
   * displayed frame for export WITHOUT reaching into the draw model. A plain prop
   * (not `forwardRef`) keeps the component a normal function and the handle an
   * explicit, documented part of the contract.
   */
  handleRef?: Ref<LiveCanvasHandle>;
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
function paintFrame(canvas: HTMLCanvasElement, rendered: Scene): boolean {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return false;

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
  return true;
}

/** Paint a Tone reference directly into the canvas backing store. */
function paintToneReference(
  canvas: HTMLCanvasElement,
  source: ToneSource,
  compositionFrame: CoordinateSpace,
): boolean {
  const ctx = canvas.getContext("2d");
  if (ctx === null || canvas.width === 0 || canvas.height === 0) return false;

  const raster = rasterizeToneReference(
    source,
    compositionFrame,
    canvas.width,
    canvas.height,
  );
  const imageData = ctx.createImageData(raster.width, raster.height);
  imageData.data.set(raster.data);
  ctx.putImageData(imageData, 0, 0);
  return true;
}

/** Remove every previously painted pixel without deriving replacement content. */
function neutralizeCanvas(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    // Assigning a canvas dimension clears its backing store even when no 2D
    // context is available. Retain the current export resolution.
    canvas.width = canvas.width;
    return;
  }
  ctx.resetTransform();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
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
 * Live Fill is the only state that samples a Sketch. Held Fill and completed
 * Outline states paint exact caller-supplied geometry; Tone reference samples
 * only its headless source into pixels. All non-live states suspend animation.
 * Resize and DPR changes repaint or re-rasterize without deriving geometry.
 */
export function LiveCanvas({
  sketch,
  params,
  seed,
  compositionFrame,
  profile,
  inputRevision = 0,
  fillCaptureRequest = null,
  onFillCaptured,
  onDisplayedSceneCommitted,
  renderState = LIVE_FILL_RENDER_STATE,
  tolerance = 0,
  pageFrameDraft = null,
  handleRef,
}: LiveCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The exact Scene most recently painted, exposed read-only to one-shot export.
  const displayedSceneRef = useRef<DisplayedSceneSnapshot | null>(null);
  // Capture reads Fill only: a completed Outline may be displayed while the
  // most recent exact Fill snapshot remains available to the session handshake.
  const displayedFillRef = useRef<DisplayedSceneSnapshot | null>(null);
  const captureRequestRef = useRef(fillCaptureRequest);
  const onFillCapturedRef = useRef(onFillCaptured);
  const onDisplayedSceneCommittedRef = useRef(onDisplayedSceneCommitted);
  const inputRevisionRef = useRef(inputRevision);
  const servedCaptureTokensRef = useRef(new Set<number>());

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
  const compositionWidth = compositionFrame.width;
  const compositionHeight = compositionFrame.height;
  const toneReferenceSource =
    renderState.kind === "tone-reference" ? renderState.source : null;
  const preparedFrame = useMemo(
    () =>
      renderState.kind === "fill-live"
        ? prepareSketch(sketch, params, seed, compositionFrame)
        : null,
    [sketch, params, seed, compositionAspect, renderState.kind],
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

  const pageFrameEditGeometry = useMemo(() => {
    if (pageFrameDraft === null) return null;
    const minX = Math.min(0, pageFrameDraft.x);
    const minY = Math.min(0, pageFrameDraft.y);
    const maxX = Math.max(
      compositionFrame.width,
      pageFrameDraft.x + pageFrameDraft.width,
    );
    const maxY = Math.max(
      compositionFrame.height,
      pageFrameDraft.y + pageFrameDraft.height,
    );
    const width = maxX - minX;
    const height = maxY - minY;
    const intersectionX = Math.max(0, pageFrameDraft.x);
    const intersectionY = Math.max(0, pageFrameDraft.y);
    const intersectionWidth = Math.max(
      0,
      Math.min(compositionFrame.width, pageFrameDraft.x + pageFrameDraft.width) -
        intersectionX,
    );
    const intersectionHeight = Math.max(
      0,
      Math.min(
        compositionFrame.height,
        pageFrameDraft.y + pageFrameDraft.height,
      ) - intersectionY,
    );
    const compositionPath = `M 0 0 H ${compositionFrame.width} V ${compositionFrame.height} H 0 Z`;
    const retainedPath =
      intersectionWidth > 0 && intersectionHeight > 0
        ? ` M ${intersectionX} ${intersectionY} H ${intersectionX + intersectionWidth} V ${intersectionY + intersectionHeight} H ${intersectionX} Z`
        : "";
    return {
      style: {
        "--page-frame-edit-aspect": width / height,
        "--page-frame-composition-left": `${((0 - minX) / width) * 100}%`,
        "--page-frame-composition-top": `${((0 - minY) / height) * 100}%`,
        "--page-frame-composition-width": `${(compositionFrame.width / width) * 100}%`,
        "--page-frame-composition-height": `${(compositionFrame.height / height) * 100}%`,
      } as CSSProperties,
      viewBox: `${minX} ${minY} ${width} ${height}`,
      dimPath: `${compositionPath}${retainedPath}`,
    };
  }, [compositionFrame, pageFrameDraft]);

  // The latest caller-owned sampler follows the same post-commit ref discipline
  // as the other live inputs. The rAF effect does not depend on it, so
  // invalidating preparation never resets the animation clock; the next tick
  // samples the new immutable layout at the continuing `t`.
  const preparedFrameRef = useRef(preparedFrame);
  const renderStateRef = useRef(renderState);
  const compositionFrameRef = useRef(compositionFrame);
  // `toleranceRef` lets the stable on-demand draw callbacks (rebuild/repaint,
  // scrubTo) read the current tolerance without a `tolerance` dependency, so the
  // clock effect and rAF baseline stay untouched by a knob change (issue #232).
  // Kept in sync by the same post-commit effect so a StrictMode double-render
  // can't desync it. The static outline-redraw effect lists `tolerance` directly
  // in its deps so a change RE-RUNS the pass.
  const toleranceRef = useRef(tolerance);
  // The composition-frame path is Outline-only geometry. Read it through a ref
  // so it shares the on-demand derivation path without perturbing Fill's loop.
  const includeFrame = profile.includeFrame;
  const includeFrameRef = useRef(includeFrame);
  useLayoutEffect(() => {
    preparedFrameRef.current = preparedFrame;
    renderStateRef.current = renderState;
    compositionFrameRef.current = compositionFrame;
    toleranceRef.current = tolerance;
    includeFrameRef.current = includeFrame;
    inputRevisionRef.current = inputRevision;
    captureRequestRef.current = fillCaptureRequest;
    onFillCapturedRef.current = onFillCaptured;
    onDisplayedSceneCommittedRef.current = onDisplayedSceneCommitted;
  }, [
    preparedFrame,
    renderState,
    compositionFrame,
    tolerance,
    includeFrame,
    inputRevision,
    fillCaptureRequest,
    onFillCaptured,
    onDisplayedSceneCommitted,
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
      getDisplayedScene: () => displayedSceneRef.current,
      captureDisplayedFrame: () => displayedSceneRef.current,
    }),
    [],
  );

  // Unavailable Image Asset input is a hard content boundary, not merely an
  // overlay. Clear both retained snapshots in a layout effect so a newly supplied
  // capture request cannot observe the previous Fill from the passive capture
  // effect below. Neutralize the actual backing store in the same pre-paint phase
  // so getCanvas()/PNG cannot expose stale artwork either.
  useLayoutEffect(() => {
    if (renderState.kind !== "unavailable") return;
    displayedSceneRef.current = null;
    displayedFillRef.current = null;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    sizeToBox(canvas, window.devicePixelRatio || 1);
    neutralizeCanvas(canvas);
  }, [renderState]);

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

  const answerCapture = useCallback((snapshot: DisplayedSceneSnapshot) => {
    const request = captureRequestRef.current;
    if (
      request === null ||
      servedCaptureTokensRef.current.has(request.token) ||
      snapshot.renderMode !== "fill" ||
      snapshot.sourceInputRevision !==
        (request.sourceInputRevision ?? request.inputRevision) ||
      (request.contentRevision !== undefined &&
        snapshot.contentRevision !== request.contentRevision)
    ) {
      return;
    }
    const onCaptured = onFillCapturedRef.current;
    if (onCaptured === undefined) return;
    servedCaptureTokensRef.current.add(request.token);
    onCaptured({
      token: request.token,
      inputRevision: request.inputRevision,
      scene: snapshot.scene,
      t: snapshot.t,
      sourceInputRevision: snapshot.sourceInputRevision,
      ...(snapshot.contentRevision === undefined
        ? {}
        : { contentRevision: snapshot.contentRevision }),
    });
  }, []);

  const commitDisplayedScene = useCallback(
    (snapshot: DisplayedSceneSnapshot, retainAsFill: boolean) => {
      displayedSceneRef.current = snapshot;
      if (retainAsFill) displayedFillRef.current = snapshot;
      if (retainAsFill) answerCapture(snapshot);
      onDisplayedSceneCommittedRef.current?.(snapshot);
    },
    [answerCapture],
  );

  const commitFillFrame = useCallback(
    (scene: Scene, t: number) => {
      const snapshot: DisplayedSceneSnapshot = {
        scene,
        t,
        renderMode: "fill",
        tolerance: toleranceRef.current,
        includeFrame: includeFrameRef.current,
        inputRevision: inputRevisionRef.current,
        sourceInputRevision: inputRevisionRef.current,
      };
      commitDisplayedScene(snapshot, true);
    },
    [commitDisplayedScene],
  );

  // Only live Fill derives geometry. Held Fill and completed Outline are
  // caller-owned immutable frames and travel through `paintSuppliedFrame`.
  const rebuildAndDrawFillAt = useCallback((t: number) => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const sampleFrame = preparedFrameRef.current;
    if (sampleFrame === null) return;
    const rendered = sampleFrame(t);
    if (paintFrame(canvas, rendered)) {
      commitFillFrame(rendered, t);
    }
  }, [commitFillFrame]);

  const paintSuppliedFrame = useCallback(
    (state: Extract<LiveCanvasRenderState, { kind: "fill-held" | "outline" }>) => {
      const canvas = canvasRef.current;
      if (canvas === null || !paintFrame(canvas, state.scene)) return;
      const snapshot: DisplayedSceneSnapshot = {
        scene: state.scene,
        t: state.t,
        renderMode: state.kind === "outline" ? "outline" : "fill",
        tolerance: toleranceRef.current,
        includeFrame: includeFrameRef.current,
        ...(state.sourceInputRevision === undefined
          ? {}
          : {
              inputRevision: state.sourceInputRevision,
              sourceInputRevision: state.sourceInputRevision,
            }),
        ...(state.contentRevision === undefined
          ? {}
          : { contentRevision: state.contentRevision }),
      };
      commitDisplayedScene(snapshot, state.kind === "fill-held");
    },
    [commitDisplayedScene],
  );

  // Geometry-only changes repaint the exact displayed Scene. They never sample
  // the Sketch or ask the worker-owned Outline pipeline to derive again.
  const repaintCurrentFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const state = renderStateRef.current;
    if (state.kind === "tone-reference") {
      displayedSceneRef.current = null;
      paintToneReference(canvas, state.source, compositionFrameRef.current);
      return;
    }
    if (state.kind === "unavailable") return;
    const displayed = displayedSceneRef.current;
    if (displayed !== null) paintFrame(canvas, displayed.scene);
  }, []);

  // Re-fit then intentionally rebuild: this path is owned by true geometry
  // inputs (or a mode change), not by ResizeObserver layout repaints.
  const refitAndDrawFill = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    sizeToBox(canvas, window.devicePixelRatio || 1);
    rebuildAndDrawFillAt(tRef.current);
  }, [rebuildAndDrawFillAt]);

  // Supplied geometry freezes time at its captured t. Tone and unavailable
  // states suspend geometry without touching time, so returning to artwork
  // resumes unchanged.
  useEffect(() => {
    if (renderState.kind === "fill-live") {
      resumeTRef.current = tRef.current;
      return;
    }
    if (
      renderState.kind === "tone-reference" ||
      renderState.kind === "unavailable"
    ) {
      return;
    }
    tRef.current = renderState.t;
    resumeTRef.current = renderState.t;
    if (scrubberRef.current !== null) {
      scrubberRef.current.value = String(renderState.t);
    }
  }, [renderState]);

  // A new request can be answered immediately from a matching displayed Fill.
  // Otherwise, the next live Fill commit calls the same ref-only handshake.
  useEffect(() => {
    const displayedFill = displayedFillRef.current;
    if (displayedFill !== null) answerCapture(displayedFill);
  }, [fillCaptureRequest, answerCapture]);

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
    if (renderState.kind !== "fill-live") return;
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
      const sampleFrame = preparedFrameRef.current;
      if (sampleFrame === null) return;
      const rendered = sampleFrame(t);
      if (paintFrame(canvas, rendered)) commitFillFrame(rendered, t);
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [sketch, playing, renderState.kind, commitFillFrame]);

  // Tone depends only on its analytic source and Composition Frame. Keeping it
  // outside the artwork effect prevents Seed, Outline bookkeeping, and unrelated
  // Studio state from re-sampling every backing pixel.
  useEffect(() => {
    if (toneReferenceSource === null) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    sizeToBox(canvas, window.devicePixelRatio || 1);
    displayedSceneRef.current = null;
    paintToneReference(canvas, toneReferenceSource, compositionFrame);
  }, [
    toneReferenceSource,
    compositionAspect,
    compositionWidth,
    compositionHeight,
  ]);

  // Static live Fill derives synchronously. Supplied held/Outline geometry paints
  // atomically as-is. Neither path is sent through hidden-line work.
  useEffect(() => {
    if (
      renderState.kind === "tone-reference" ||
      renderState.kind === "unavailable"
    ) {
      return;
    }
    const canvas = canvasRef.current;
    if (canvas === null) return;
    sizeToBox(canvas, window.devicePixelRatio || 1);

    if (renderState.kind !== "fill-live") {
      paintSuppliedFrame(renderState);
      return;
    }
    if (sketch.time === undefined) refitAndDrawFill();
  }, [
    sketch,
    params,
    seed,
    compositionAspect,
    compositionWidth,
    compositionHeight,
    renderState,
    inputRevision,
    refitAndDrawFill,
    paintSuppliedFrame,
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
    if (renderStateRef.current.kind !== "fill-live") return;
    tRef.current = value;
    resumeTRef.current = value;
    setPlaying(false);
    const canvas = canvasRef.current;
    if (canvas !== null) {
      rebuildAndDrawFillAt(value);
    }
  }, [rebuildAndDrawFillAt]);

  // LAYOUT (#156): LiveCanvas owns a column that FILLS the canvas region — the
  // canvas centered/fitted in the stage on top, the slim transport bar pinned to
  // the bottom. The transport handlers/refs live here alongside the canvas, so
  // keeping the markup together (rather than splitting it across the stage
  // boundary) is what lets the driver stay untouched. The transport shows ONLY
  // for an animated Sketch (`sketch.time` present); a static Sketch renders the
  // canvas alone in the same layout — no clock, no bar (exactly as before).
  const time = sketch.time;
  const unavailableState =
    renderState.kind === "unavailable" ? renderState : null;
  const unavailableSubject =
    unavailableState?.unresolvedAssetIds.length === 1
      ? "Image Asset"
      : "Image Assets";
  const unavailableMessage =
    unavailableState?.status === "loading"
      ? `${unavailableSubject} loading`
      : unavailableState?.status === "missing"
        ? `${unavailableSubject} unavailable`
        : `${unavailableSubject} could not be loaded`;
  const canvasSurface = (
    <>
      <canvas
        ref={canvasRef}
        className="live-canvas"
        style={paperStyle}
        aria-hidden={unavailableState === null ? undefined : true}
      />
      {unavailableState !== null && (
        <div
          className="live-canvas-unavailable"
          role={unavailableState.status === "loading" ? "status" : "alert"}
          aria-live={
            unavailableState.status === "loading" ? "polite" : "assertive"
          }
          aria-atomic="true"
        >
          <strong className="live-canvas-unavailable__message">
            {unavailableMessage}
          </strong>
          <span className="live-canvas-unavailable__label">
            {unavailableState.unresolvedAssetIds.length === 1
              ? "Unresolved ID"
              : "Unresolved IDs"}
          </span>
          <span className="live-canvas-unavailable__ids">
            {unavailableState.unresolvedAssetIds.map((id, index) => (
              <code key={`${index}:${id}`}>{id}</code>
            ))}
          </span>
        </div>
      )}
    </>
  );
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
        {pageFrameEditGeometry === null || pageFrameDraft === null ? (
          <div
            className="plot-sheet"
            style={sheetStyle}
            role="group"
            aria-label="Plot sheet preview"
          >
            <div className="plot-drawable">{canvasSurface}</div>
          </div>
        ) : (
          <div
            className="page-frame-edit-view"
            style={pageFrameEditGeometry.style}
            role="group"
            aria-label="Page Frame edit preview"
          >
            <div className="page-frame-edit-composition">{canvasSurface}</div>
            <svg
              className="page-frame-edit-overlay"
              viewBox={pageFrameEditGeometry.viewBox}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path
                className="page-frame-edit-discarded"
                data-testid="page-frame-discarded"
                d={pageFrameEditGeometry.dimPath}
                fillRule="evenodd"
              />
              <rect
                className="page-frame-edit-boundary"
                data-testid="page-frame-boundary"
                x={pageFrameDraft.x}
                y={pageFrameDraft.y}
                width={pageFrameDraft.width}
                height={pageFrameDraft.height}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </div>
        )}
      </div>
      {/* The slim transport bar, pinned to the bottom of the canvas area (#156). */}
      {time !== undefined && unavailableState === null && (
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
