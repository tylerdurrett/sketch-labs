import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";

import {
  renderToCanvas,
  type Canvas2DContext,
  type Params,
  type Seed,
  type Sketch,
  type TimeMetadata,
} from "@harness/core";

import { computeContainFit } from "./canvas-fit";

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
 * Draw one frame of `sketch` at time `t` onto `canvas`.
 *
 * This is the WHOLE per-frame path (the slice #6 contract): generate the Scene
 * at `t`, then hand the real `CanvasRenderingContext2D` straight to core's
 * `renderToCanvas` — no HLR, no path simplification, no pen ordering, no export
 * work. The coordinate-space → pixel mapping (ADR-0004) lives here on the caller
 * side: the canvas backing store is sized to its CSS box × `devicePixelRatio`,
 * and a contain-fit transform (uniform scale + centering letterbox) maps the
 * Scene's declared space onto those pixels, so `Stroke.width` (Scene-space units)
 * scales correctly and the aspect ratio is preserved. The browser
 * `CanvasRenderingContext2D` is structurally assignable to core's
 * `Canvas2DContext` port, so it is passed directly with no adapter.
 */
function drawFrame(
  canvas: HTMLCanvasElement,
  sketch: Sketch,
  params: Params,
  seed: Seed,
  t: number,
): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;

  // The browser CanvasRenderingContext2D has everything core's Canvas2DContext
  // port needs; its fillStyle/strokeStyle getters are merely typed wider
  // (string | CanvasGradient | CanvasPattern), which TS variance won't accept as
  // the port's `string`. Asserting to the port at this single boundary keeps
  // core headless (no DOM types) without any runtime adapter — the renderer only
  // ever writes color strings to those properties.
  const portCtx = ctx as Canvas2DContext;

  const scene = sketch.generate(params, seed, t);
  const { scale, offsetX, offsetY } = computeContainFit(
    scene.space.width,
    scene.space.height,
    canvas.width,
    canvas.height,
  );

  // Clear in device pixels (identity transform), then apply the contain-fit
  // transform so renderToCanvas draws in the Scene's own coordinate space.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);

  renderToCanvas(portCtx, scene);
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
 *   - The LOOP effect (keyed `[sketch]`) owns ANIMATED sketches only. Its
 *     `sketch.time === undefined` early-return is at the very top, so a static
 *     Sketch makes it do nothing at all (no size, no draw, no loop). An animated
 *     Sketch sizes once and runs the rAF loop, reading `params`/`seed` through
 *     refs so an input change feeds the next frame without tearing down the loop
 *     and snapping the clock back to `t = 0` (issue #40). Only a Sketch switch
 *     (the desired restart) recaptures the `performance.now()` baseline.
 *   - The STATIC-REDRAW effect (keyed `[sketch, params, seed, refitAndRedraw]`)
 *     owns STATIC sketches only. It is the SOLE path that sizes+draws a static
 *     frame: on mount, on a switch to a static Sketch, and on a params/seed change
 *     (it always draws, since a params/seed change has no size change).
 *   - The GEOMETRY effect (keyed on stable callbacks, NEVER `sketch`) owns
 *     draw-on-actual-resize. It re-sizes on box/DPR change and only redraws when
 *     `sizeToBox` reports a real change — so the `ResizeObserver`'s initial
 *     `.observe()` fire is a no-op (the owner already sized the store to the same
 *     dimensions), while a genuine resize or DPR change repaints. Depending only
 *     on stable callbacks means a resize never re-runs the loop effect or resets
 *     the clock baseline (issue #40 / the #41 resize contract).
 */
export function LiveCanvas({ sketch, params, seed, handleRef }: LiveCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
  useEffect(() => {
    paramsRef.current = params;
    seedRef.current = seed;
    sketchRef.current = sketch;
  }, [params, seed, sketch]);

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

  // Draw the latest frame onto the canvas through the refs WITHOUT touching the
  // backing-store size. Params/seed/the current Sketch and the last drawn t are
  // read through refs so this helper carries no params/seed/sketch dependency —
  // its `[]` deps keep it referentially stable, so any effect that calls it never
  // re-runs the clock effect or resets `start` (issue #40 / the #41 contract).
  // For a static Sketch tRef stays 0; for an animated one it holds the last drawn
  // t, so a resize repaints the current frame (the next rAF tick overwrites it).
  const drawCurrentFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    drawFrame(
      canvas,
      sketchRef.current,
      paramsRef.current,
      seedRef.current,
      tRef.current,
    );
  }, []);

  // Re-fit the backing store to the CSS box × current devicePixelRatio and ALWAYS
  // redraw the latest frame. Owned by the static-redraw effect: it must repaint
  // even when the size is unchanged (a params/seed change has no size change), so
  // the `sizeToBox` return value is intentionally ignored here.
  const refitAndRedraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    sizeToBox(canvas, window.devicePixelRatio || 1);
    drawCurrentFrame();
  }, [drawCurrentFrame]);

  // The clock-bearing loop — the PLAYING half of the transport (ADR-0005). Keyed
  // on `[sketch, playing]`: switching Sketch re-runs this and recaptures `start`
  // (the desired restart); toggling `playing` starts the loop on resume or, via
  // the cleanup, cancels the pending frame on pause so `t` is held at the
  // scrubbed frame. A params/seed change does NOT re-run it (read through refs),
  // so the animation continues from where it was. This effect owns ANIMATED
  // sketches ONLY: the `sketch.time === undefined` early-return is FIRST, before
  // any sizing or drawing, so a static Sketch makes it a complete no-op (the
  // static-redraw effect is the sole owner of static frames — no triple draw).
  useEffect(() => {
    const time = sketch.time;
    if (time === undefined) return;
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
      drawFrame(canvas, sketch, paramsRef.current, seedRef.current, t);
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [sketch, playing]);

  // The SOLE owner of static frames: the loop effect now early-returns for a
  // static Sketch, so this is the only path that sizes+draws one — on mount, on a
  // switch TO a static Sketch, and on a params/seed change — exactly once each,
  // without introducing a clock. For an animated Sketch the early return skips it
  // (the rAF loop owns its frames). `refitAndRedraw` re-fits the box (tRef is 0
  // for a static Sketch) and ALWAYS redraws through the refs, since a params/seed
  // change carries no size change for the geometry effect to react to.
  useEffect(() => {
    if (sketch.time !== undefined) return;
    refitAndRedraw();
  }, [sketch, params, seed, refitAndRedraw]);

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
      if (sizeToBox(canvas, dpr)) drawCurrentFrame();
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
  }, [drawCurrentFrame]);

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
      drawFrame(
        canvas,
        sketchRef.current,
        paramsRef.current,
        seedRef.current,
        value,
      );
    }
  }, []);

  // No time metadata ⇒ a static Sketch: render the canvas alone, no transport.
  const time = sketch.time;
  if (time === undefined) {
    return <canvas ref={canvasRef} className="live-canvas" />;
  }

  return (
    <>
      <canvas ref={canvasRef} className="live-canvas" />
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
    </>
  );
}
