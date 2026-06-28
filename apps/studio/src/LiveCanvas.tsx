import { useCallback, useEffect, useRef } from "react";

import {
  renderToCanvas,
  type Canvas2DContext,
  type Params,
  type Seed,
  type Sketch,
} from "@harness/core";

import { computeContainFit } from "./canvas-fit";

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
export function LiveCanvas({ sketch, params, seed }: LiveCanvasProps) {
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

  // The clock-bearing loop. Keyed on `sketch` ONLY: switching Sketch (or, once a
  // replay signal exists, an explicit replay) re-runs this and recaptures
  // `start`, resetting t to 0 — the desired restart. A params/seed change does
  // NOT, so the animation continues from where it was. This effect owns ANIMATED
  // sketches ONLY: the `sketch.time === undefined` early-return is FIRST, before
  // any sizing or drawing, so a static Sketch makes it a complete no-op (the
  // static-redraw effect is the sole owner of static frames — no triple draw).
  useEffect(() => {
    const time = sketch.time;
    if (time === undefined) return;

    const canvas = canvasRef.current;
    if (canvas === null) return;

    // Animated Sketch: size the backing store once, then run the rAF loop. The
    // return value is ignored — this is a fresh mount/Sketch switch, so a draw
    // happens on the first tick regardless.
    sizeToBox(canvas, window.devicePixelRatio || 1);

    let frameId = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const elapsedSeconds = (now - start) / 1000;
      // mode: 'loop' wraps elapsed seconds into [0, duration) for a seamless
      // repeat. one-shot is deferred — there is no one-shot Sketch yet.
      const t =
        time.mode === "loop" ? elapsedSeconds % time.duration : elapsedSeconds;
      tRef.current = t;
      drawFrame(canvas, sketch, paramsRef.current, seedRef.current, t);
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [sketch]);

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

  return <canvas ref={canvasRef} className="live-canvas" />;
}
