import { useEffect, useRef } from "react";

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
 * Size `canvas`'s backing store to its CSS box × `devicePixelRatio`, keeping the
 * CSS box as the display size.
 *
 * The backing store (`canvas.width`/`height`) is in device pixels so the drawing
 * is crisp on high-DPI displays; the CSS box (set via styling) stays the layout
 * size.
 */
function sizeToBox(canvas: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
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
 * The loop effect is keyed on `sketch` ALONE: `params`/`seed` are read through
 * refs inside `tick`, so changing an input feeds the next frame without tearing
 * down the loop and snapping the clock back to `t = 0` (issue #40). Only a Sketch
 * switch (the desired restart) recaptures the `performance.now()` baseline. A
 * static Sketch is redrawn on input change by a separate, clockless effect.
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
  useEffect(() => {
    paramsRef.current = params;
    seedRef.current = seed;
  }, [params, seed]);

  // The clock-bearing loop. Keyed on `sketch` ONLY: switching Sketch (or, once a
  // replay signal exists, an explicit replay) re-runs this and recaptures
  // `start`, resetting t to 0 — the desired restart. A params/seed change does
  // NOT, so the animation continues from where it was.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    sizeToBox(canvas);

    const time = sketch.time;
    if (time === undefined) {
      // Static Sketch: a single frame at t = 0, no animation loop. (Re-draws on
      // params/seed change are handled by the separate static-redraw effect.)
      drawFrame(canvas, sketch, paramsRef.current, seedRef.current, 0);
      return;
    }

    let frameId = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const elapsedSeconds = (now - start) / 1000;
      // mode: 'loop' wraps elapsed seconds into [0, duration) for a seamless
      // repeat. one-shot is deferred — there is no one-shot Sketch yet.
      const t =
        time.mode === "loop" ? elapsedSeconds % time.duration : elapsedSeconds;
      drawFrame(canvas, sketch, paramsRef.current, seedRef.current, t);
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [sketch]);

  // Static Sketches have no clock to advance, so the loop effect above only draws
  // them once. This redraws the single frame when params/seed change so new
  // inputs take effect (AC#1) without introducing a clock. For an animated Sketch
  // it is a harmless no-op redraw at t = 0: the rAF loop overwrites it next frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || sketch.time !== undefined) return;
    drawFrame(canvas, sketch, params, seed, 0);
  }, [sketch, params, seed]);

  return <canvas ref={canvasRef} className="live-canvas" />;
}
