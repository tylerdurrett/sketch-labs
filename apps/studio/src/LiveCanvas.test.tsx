// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Scene, Sketch, TimeMetadata } from "@harness/core";

import { LiveCanvas, type LiveCanvasHandle } from "./LiveCanvas";

/**
 * LiveCanvas IS under test here (unlike SketchControls.test, which mocks it), so
 * the browser stack it touches has to be stood up rather than mocked away:
 *
 *   - `canvas.getContext('2d')` is unimplemented in jsdom and returns `null`;
 *     `drawFrame` early-returns on a null context, so drawing is a harmless
 *     no-op — we observe `t` through the Sketch's `generate` spy, not pixels.
 *   - `ResizeObserver` / `matchMedia` are used by the geometry effect on mount;
 *     jsdom ships neither, so we install inert stubs (we are not testing resize).
 *   - `requestAnimationFrame` and `performance.now()` are STUBBED so the rAF loop
 *     is driven tick-by-tick with a clock we control — that determinism is what
 *     lets us assert the baseline-recapture math (resume-from-scrubbed-t) exactly.
 *
 * The single observable for `t` is the Sketch's `generate(params, seed, t)`: each
 * draw calls it with the exact `t`, so the spy's last-call argument is the frame
 * the canvas would have shown.
 */

// React 19's `act` requires this flag; vitest's jsdom env does not set it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const SCENE: Scene = { space: { width: 100, height: 100 }, primitives: [] };

/** Build a Sketch with the given time metadata and a `generate` spy recording `t`. */
function animatedSketch(time: TimeMetadata | undefined) {
  const generate = vi.fn((_p: unknown, _s: unknown, _t: number): Scene => SCENE);
  const sketch = {
    id: "test",
    name: "Test",
    schema: {},
    time,
    generate,
  } as unknown as Sketch;
  return { sketch, generate };
}

/** A Sketch exposing the prepared-frame fast path, with each retained sampler observable. */
function explicitlyPreparedSketch(time: TimeMetadata) {
  const samplers: Array<(t: number) => Scene> = [];
  const prepare = vi.fn((params: Record<string, unknown>, seed: string | number) => {
    // Snapshot preparation inputs so a later caller mutation cannot change which
    // layout this retained sampler represents.
    const value = params.value as number;
    const sampler = vi.fn((t: number): Scene => ({
      space: { width: 100, height: 100 },
      primitives: [{ points: [[value + Number(seed), t]] }],
    }));
    samplers.push(sampler);
    return sampler;
  });
  const generate = vi.fn((): Scene => {
    throw new Error("prepared Studio path unexpectedly called cold generate");
  });
  const sketch = {
    id: "prepared",
    name: "Prepared",
    schema: {},
    time,
    prepare,
    generate,
  } as unknown as Sketch;
  return { sketch, prepare, generate, samplers };
}

/** Build a static Sketch whose generated Scene has the given coordinate space. */
function spacedSketch(width: number, height: number) {
  const scene: Scene = { space: { width, height }, primitives: [] };
  const generate = vi.fn((_p: unknown, _s: unknown, _t: number): Scene => scene);
  return {
    id: "spaced",
    name: "Spaced",
    schema: {},
    generate,
  } as unknown as Sketch;
}

/** The `<canvas>` the component rendered (LiveCanvas renders exactly one). */
function canvasEl(el: HTMLElement): HTMLCanvasElement {
  const canvas = el.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  return canvas;
}

/** The most recent `t` the Sketch was asked to render (the drawn frame). */
function lastDrawnT(generate: { mock: { calls: unknown[][] } }): number {
  const calls = generate.mock.calls;
  if (calls.length === 0) throw new Error("generate was never called");
  return calls[calls.length - 1]![2] as number;
}

// --- render-mode fixtures (#219) --------------------------------------------
// TWO overlapping FILLED squares in painter's order (the same shape the
// SketchControls hidden-line export test uses): the nearer square covers part of
// the farther one, so `hiddenLinePass` MUST clip part of the farther outline. The
// two are FILL-ONLY, so the real @harness/core renderer paints them via `fill()`
// in fill mode; the pass rewrites them to STROKE-ONLY primitives, so outline mode
// paints via `stroke()` and never `fill()`. That fill-vs-stroke split is the
// observable that proves — through the REAL pass and REAL renderer, no mock —
// whether the export-only pass ran for a given draw.
const OVERLAP_SCENE = {
  space: { width: 100, height: 100 },
  primitives: [
    {
      points: [
        [0, 0],
        [40, 0],
        [40, 40],
        [0, 40],
      ],
      closed: true,
      fill: { color: "tomato" },
    },
    {
      points: [
        [20, 0],
        [60, 0],
        [60, 40],
        [20, 40],
      ],
      closed: true,
      fill: { color: "steelblue" },
    },
  ],
} as unknown as Scene;

/** A Sketch (static or animated) whose `generate` yields {@link OVERLAP_SCENE}. */
function overlapSketch(time: TimeMetadata | undefined) {
  const generate = vi.fn(
    (_p: unknown, _s: unknown, _t: number): Scene => OVERLAP_SCENE,
  );
  const sketch = {
    id: "overlap",
    name: "Overlap",
    schema: {},
    time,
    generate,
  } as unknown as Sketch;
  return { sketch, generate };
}

/**
 * An inert 2D-context stub that COUNTS each method call by name (so `fill` and
 * `stroke` invocation counts are observable) and stores property writes. It
 * stands in for the real `CanvasRenderingContext2D` jsdom does not implement, and
 * lets a draw be classified: a fill-mode draw of {@link OVERLAP_SCENE} calls
 * `fill()` (never `stroke()`), an outline-mode draw calls `stroke()` (never
 * primitive `fill()`). `reset()` zeroes the counts between draw phases. Note the
 * background paint uses `fillRect` — a separate key from primitive `fill`.
 */
function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  counts: Record<string, number>;
  reset: () => void;
} {
  const counts: Record<string, number> = {};
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      return (..._args: unknown[]) => {
        counts[prop as string] = (counts[prop as string] ?? 0) + 1;
      };
    },
    set: (target, prop, value) => {
      target[prop as string] = value;
      return true;
    },
  });
  const reset = () => {
    for (const key of Object.keys(counts)) delete counts[key];
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, counts, reset };
}

/** Point `getContext('2d')` at the given recording context for this test. */
function useRecordingContext(ctx: CanvasRenderingContext2D): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
}

// --- the hand-driven rAF clock ----------------------------------------------
let now = 0;
let rafCallbacks: Array<(t: number) => void> = [];
let nextRafId = 1;

/** Advance the fake wall clock to `ms` and flush exactly one rAF generation. */
function tick(ms: number): void {
  now = ms;
  const due = rafCallbacks;
  rafCallbacks = [];
  act(() => {
    for (const cb of due) cb(now);
  });
}

/**
 * Flush pending rAF callbacks WITHOUT advancing the clock, draining nested
 * generations — the #228 outline pass is deferred behind a DOUBLE rAF (the outer
 * frame only schedules the inner one; the pass runs in the inner). Bounded so a
 * self-rescheduling loop can't spin forever: outline-mode tests suspend the live
 * rAF loop, so a couple of generations always drains to empty.
 */
function flushRaf(): void {
  act(() => {
    for (
      let generation = 0;
      generation < 5 && rafCallbacks.length > 0;
      generation++
    ) {
      const due = rafCallbacks;
      rafCallbacks = [];
      for (const cb of due) cb(now);
    }
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

function scrubber(el: HTMLElement): HTMLInputElement {
  const input = el.querySelector<HTMLInputElement>(".transport__scrubber");
  if (input === null) throw new Error("no scrubber input");
  return input;
}

/** Fire a React-observed `input` on the scrubber with a string value (a scrub). */
function scrub(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButton(el: HTMLElement, text: string): void {
  const button = [...el.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  if (button === undefined) throw new Error(`no button labelled ${text}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  now = 0;
  rafCallbacks = [];
  nextRafId = 1;

  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void): number => {
    rafCallbacks.push(cb);
    return nextRafId++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    // The loop schedules one frame at a time; on cancel we drop all pending
    // callbacks so a paused loop truly stops advancing (id is unused — there is
    // never more than one in flight).
    void id;
    rafCallbacks = [];
  });

  // Inert geometry-effect deps (not under test).
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  // jsdom returns `null` from getContext('2d'), and `drawFrame` early-returns on
  // a null context — which would skip the `sketch.generate` call we observe `t`
  // through. Return an inert 2D-context stub instead: a Proxy whose every method
  // is a no-op and whose fill/strokeStyle accept writes. The renderer's pixel
  // output is not under test; we only need `drawFrame` to reach `generate(...t)`.
  const ctxStub = new Proxy(
    {} as Record<string, unknown>,
    {
      get: (target, prop) => {
        if (prop in target) return target[prop as string];
        return () => {};
      },
      set: (target, prop, value) => {
        target[prop as string] = value;
        return true;
      },
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctxStub as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LiveCanvas transport — visibility (AC1)", () => {
  it("hides the scrubber for a static Sketch (no time metadata)", () => {
    const { sketch } = animatedSketch(undefined);
    const el = mount(
      <LiveCanvas sketch={sketch} params={{}} seed={1} />,
    );
    expect(el.querySelector(".transport")).toBeNull();
    expect(el.querySelector(".transport__scrubber")).toBeNull();
  });

  it("shows the scrubber and play/pause for an animated Sketch", () => {
    const { sketch } = animatedSketch({ duration: 4, mode: "loop" });
    const el = mount(
      <LiveCanvas sketch={sketch} params={{}} seed={1} />,
    );
    const input = scrubber(el);
    // Range is metadata-driven: [0, duration] seconds.
    expect(input.min).toBe("0");
    expect(input.max).toBe("4");
    expect(el.querySelector(".transport__play")?.textContent).toBe("Pause");
  });
});

describe("LiveCanvas transport — scrubbing pauses & sets t (AC2)", () => {
  it("an animated Sketch mounts playing and the loop advances t", () => {
    const { sketch, generate } = animatedSketch({ duration: 4, mode: "loop" });
    mount(<LiveCanvas sketch={sketch} params={{}} seed={1} />);

    // start = performance.now() = 0; advance the clock 1s → t = 1.
    tick(1000);
    expect(lastDrawnT(generate)).toBeCloseTo(1, 5);
    // ...and the loop keeps going (3.5s elapsed wraps below duration).
    tick(3500);
    expect(lastDrawnT(generate)).toBeCloseTo(3.5, 5);
  });

  it("grabbing the scrubber pauses the loop and sets t to the scrubbed value", () => {
    const { sketch, generate } = animatedSketch({ duration: 4, mode: "loop" });
    const el = mount(<LiveCanvas sketch={sketch} params={{}} seed={1} />);

    tick(1000); // running: t = 1
    scrub(scrubber(el), "2.5");

    // t is now the scrubbed value, and THAT exact frame re-rendered.
    expect(lastDrawnT(generate)).toBeCloseTo(2.5, 5);
    // Paused: the toggle reads "Play", and further clock advance does NOT move t
    // (the loop is cancelled — no rAF callback was left pending to fire).
    expect(el.querySelector(".transport__play")?.textContent).toBe("Play");
    const drawsBefore = generate.mock.calls.length;
    tick(9999);
    expect(generate.mock.calls.length).toBe(drawsBefore);
    expect(lastDrawnT(generate)).toBeCloseTo(2.5, 5);
  });
});

describe("LiveCanvas caller-owned frame preparation", () => {
  it("prepares once per sketch/params/seed and continues the same clock after invalidation", () => {
    const firstParams = { value: 1 };
    const secondParams = { value: 4 };
    const prepared = explicitlyPreparedSketch({ duration: 10, mode: "loop" });
    mount(<LiveCanvas sketch={prepared.sketch} params={firstParams} seed={2} />);

    expect(prepared.prepare).toHaveBeenCalledTimes(1);
    expect(prepared.generate).not.toHaveBeenCalled();

    // The aspect no longer samples the prepared frame (it derives from the
    // Composition Frame), so an animated Sketch does not draw until the first rAF
    // tick — the sampler is exercised then, at the live `t`.
    tick(1000);
    expect(prepared.samplers[0]).toHaveBeenLastCalledWith(1);

    // A parent rerender with the same identities reuses the retained sampler.
    act(() => {
      root!.render(
        <LiveCanvas sketch={prepared.sketch} params={firstParams} seed={2} />,
      );
    });
    expect(prepared.prepare).toHaveBeenCalledTimes(1);

    // New params invalidate preparation, but the rAF baseline is not recaptured:
    // the new sampler's next live frame continues at t=1.5, not t=0.5.
    act(() => {
      root!.render(
        <LiveCanvas sketch={prepared.sketch} params={secondParams} seed={2} />,
      );
    });
    expect(prepared.prepare).toHaveBeenCalledTimes(2);
    tick(1500);
    expect(prepared.samplers[1]).toHaveBeenLastCalledWith(1.5);

    act(() => {
      root!.render(
        <LiveCanvas sketch={prepared.sketch} params={secondParams} seed={9} />,
      );
    });
    expect(prepared.prepare).toHaveBeenCalledTimes(3);
    expect(prepared.generate).not.toHaveBeenCalled();

    const replacement = explicitlyPreparedSketch({ duration: 10, mode: "loop" });
    act(() => {
      root!.render(
        <LiveCanvas sketch={replacement.sketch} params={secondParams} seed={9} />,
      );
    });
    expect(replacement.prepare).toHaveBeenCalledTimes(1);
    expect(replacement.generate).not.toHaveBeenCalled();
  });
});

describe("LiveCanvas transport — resume from scrubbed t, no snap to 0 (AC3)", () => {
  it("Play resumes wall-clock advance from the scrubbed t", () => {
    const { sketch, generate } = animatedSketch({ duration: 10, mode: "loop" });
    const el = mount(<LiveCanvas sketch={sketch} params={{}} seed={1} />);

    tick(1000); // running: t = 1
    scrub(scrubber(el), "4"); // pause, hold at t = 4
    expect(lastDrawnT(generate)).toBeCloseTo(4, 5);

    // Resume. The baseline must be recaptured NET of the scrubbed offset:
    // start = now(5000) - 4*1000 = 1000. The next tick at now = 6000 then yields
    // elapsed = (6000 - 1000)/1000 = 5 — continuous from the scrubbed 4, NOT a
    // snap back to ~0 then +1.
    now = 5000;
    clickButton(el, "Play");
    expect(el.querySelector(".transport__play")?.textContent).toBe("Pause");

    tick(6000);
    expect(lastDrawnT(generate)).toBeCloseTo(5, 5);
  });
});

describe("LiveCanvas export handle — read-only canvas + current t", () => {
  it("exposes the live canvas node and current t without disturbing the loop", () => {
    const handle = createRef<LiveCanvasHandle>();
    const { sketch, generate } = animatedSketch({ duration: 10, mode: "loop" });
    const el = mount(
      <LiveCanvas
        handleRef={handle}
        sketch={sketch}
        params={{}}
        seed={1}
      />,
    );

    // The handle surfaces the SAME canvas node the component rendered.
    expect(handle.current).not.toBeNull();
    expect(handle.current!.getCanvas()).toBe(el.querySelector("canvas"));

    // getCurrentT tracks the last-drawn t — the loop advanced to 2s here — and
    // reading it does NOT advance the clock (no extra generate call).
    tick(2000);
    const drawsAfterTick = generate.mock.calls.length;
    expect(handle.current!.getCurrentT()).toBeCloseTo(2, 5);
    expect(generate.mock.calls.length).toBe(drawsAfterTick);
  });

  it("reports t = 0 for a static Sketch", () => {
    const handle = createRef<LiveCanvasHandle>();
    const { sketch } = animatedSketch(undefined);
    mount(<LiveCanvas handleRef={handle} sketch={sketch} params={{}} seed={1} />);

    expect(handle.current!.getCurrentT()).toBe(0);
    expect(handle.current!.getCanvas()).not.toBeNull();
  });
});

describe("LiveCanvas paper aspect — sized to the Composition Frame (#155/#253)", () => {
  // The preview box aspect now derives from the COMPOSITION FRAME, not from the
  // Sketch's own generated space (#253, slice #246). Studio hands the square
  // Harness fallback (`DEFAULT_COMPOSITION_FRAME`, 1000×1000) for now, so the box
  // is a square (`--paper-aspect` === 1) no matter what coordinate space the
  // Sketch's `generate` yields. A real frame (#247/#248) will change the ratio at
  // that single seam; the assertions below pin the fallback-square behavior and,
  // crucially, that the Sketch's own space does NOT drive the box anymore (AC3).
  it("follows the Composition Frame (square fallback ⇒ 1) for a landscape Sketch space", () => {
    // A 1600x900 (16:9) generated space must NOT leak into the box: the frame is
    // square, so `--paper-aspect` is 1, not 1600/900.
    const el = mount(
      <LiveCanvas sketch={spacedSketch(1600, 900)} params={{}} seed={1} />,
    );
    expect(Number(canvasEl(el).style.getPropertyValue("--paper-aspect"))).toBe(1);
  });

  it("follows the Composition Frame (square fallback ⇒ 1) for a portrait Sketch space", () => {
    // A tall 200x1000 generated space likewise does not drive the box — the same
    // square frame yields 1, proving the derivation ignores `sketch.space`
    // entirely (the degenerate-space case is moot: the frame is always valid).
    const el = mount(
      <LiveCanvas sketch={spacedSketch(200, 1000)} params={{}} seed={1} />,
    );
    expect(Number(canvasEl(el).style.getPropertyValue("--paper-aspect"))).toBe(1);
  });
});

describe("LiveCanvas transport — one-shot range/clamp via synthetic fixture (AC4)", () => {
  it("a one-shot Sketch's scrubber clamps its range at duration", () => {
    // No real one-shot Sketch exists yet — construct the fixture to exercise the
    // metadata-driven clamp path (ADR-0005: scrubber range honors one-shot).
    const { sketch } = animatedSketch({ duration: 6, mode: "one-shot" });
    const el = mount(<LiveCanvas sketch={sketch} params={{}} seed={1} />);

    const input = scrubber(el);
    // Range is [0, duration] regardless of mode; the clamp at duration is the
    // one-shot semantic the input's `max` bound enforces.
    expect(input.min).toBe("0");
    expect(input.max).toBe("6");
  });

  it("one-shot playback clamps elapsed at duration (holds the last frame)", () => {
    const { sketch, generate } = animatedSketch({ duration: 3, mode: "one-shot" });
    mount(<LiveCanvas sketch={sketch} params={{}} seed={1} />);

    // Before duration: t tracks elapsed.
    tick(2000);
    expect(lastDrawnT(generate)).toBeCloseTo(2, 5);
    // Past duration: clamped at 3 (one-shot holds), never wrapping back toward 0.
    tick(5000);
    expect(lastDrawnT(generate)).toBeCloseTo(3, 5);
  });
});

describe("LiveCanvas render mode — outline runs the Hidden-line pass on demand (#219)", () => {
  it("fill draws fills; outline draws the stroke-only result; toggling recomputes on demand (AC1)", () => {
    const { ctx, counts, reset } = recordingContext();
    useRecordingContext(ctx);
    const { sketch } = overlapSketch(undefined); // static

    // Fill mode: the two FILLED squares are painted as FILLS, never stroked (the
    // export-only pass did NOT run). The `fillRect` background is a separate key.
    mount(<LiveCanvas sketch={sketch} params={{}} seed={1} renderMode="fill" />);
    expect(counts.fill ?? 0).toBeGreaterThan(0);
    expect(counts.stroke ?? 0).toBe(0);

    // Toggle to outline: the pass runs ON DEMAND for this redraw — the fills are
    // rewritten to stroke-only geometry, so the draw strokes and never fills.
    reset();
    act(() => {
      root!.render(
        <LiveCanvas sketch={sketch} params={{}} seed={1} renderMode="outline" />,
      );
    });
    // #228: the outline pass is deferred one frame; flush it before asserting.
    flushRaf();
    expect(counts.stroke ?? 0).toBeGreaterThan(0);
    expect(counts.fill ?? 0).toBe(0);

    // Toggle back to fill: fills again, the pass no longer runs.
    reset();
    act(() => {
      root!.render(
        <LiveCanvas sketch={sketch} params={{}} seed={1} renderMode="fill" />,
      );
    });
    expect(counts.fill ?? 0).toBeGreaterThan(0);
    expect(counts.stroke ?? 0).toBe(0);
  });

  it("the rAF fill loop NEVER runs the pass — every animated frame stays a fill (AC2/AC3)", () => {
    const { ctx, counts, reset } = recordingContext();
    useRecordingContext(ctx);
    const { sketch, generate } = overlapSketch({ duration: 4, mode: "loop" });

    mount(<LiveCanvas sketch={sketch} params={{}} seed={1} renderMode="fill" />);

    // Drive many rAF frames; every one must draw FILLS and never the stroke-only
    // pass output. A single `stroke()` here would mean the pass leaked into the
    // live loop — the invariant this asserts it never does.
    reset();
    for (const ms of [500, 1000, 1500, 2000, 2500]) tick(ms);
    // The loop advanced (frames were drawn) and stayed fill throughout.
    expect(lastDrawnT(generate)).toBeCloseTo(2.5, 5);
    expect(counts.fill ?? 0).toBeGreaterThan(0);
    expect(counts.stroke ?? 0).toBe(0);
  });

  it("outline mode SUSPENDS the live loop and draws the stroke-only outline once, on demand (AC2)", () => {
    const { ctx, counts, reset } = recordingContext();
    useRecordingContext(ctx);
    const { sketch } = overlapSketch({ duration: 4, mode: "loop" });

    // An ANIMATED Sketch mounted in outline mode: the on-demand redraw path runs
    // the pass (stroke-only, no fills)...
    mount(
      <LiveCanvas sketch={sketch} params={{}} seed={1} renderMode="outline" />,
    );
    // #228: the outline pass is deferred one frame; flush it before asserting.
    flushRaf();
    expect(counts.stroke ?? 0).toBeGreaterThan(0);
    expect(counts.fill ?? 0).toBe(0);

    // ...and the rAF loop is SUSPENDED — no frame was scheduled, so advancing the
    // clock draws nothing at all (the pass cannot run per frame because the loop
    // that would call `drawFrame` never starts).
    reset();
    tick(1000);
    tick(2000);
    expect(counts.stroke ?? 0).toBe(0);
    expect(counts.fill ?? 0).toBe(0);
  });

  it("an outline→fill round-trip while playing PRESERVES t — the clock continues, never snapping to 0 (#223)", () => {
    const { sketch, generate } = animatedSketch({ duration: 10, mode: "loop" });
    mount(<LiveCanvas sketch={sketch} params={{}} seed={1} renderMode="fill" />);

    // Playing in fill: advance the live loop to t = 2.
    tick(2000);
    expect(lastDrawnT(generate)).toBeCloseTo(2, 5);

    // Flip to outline (which SUSPENDS the loop) and straight back to fill, WITHOUT
    // advancing the wall clock. The render-mode-change sync must carry the frozen
    // t = 2 into resumeTRef so the loop effect's baseline recapture continues from
    // there when it re-runs on the flip back to fill.
    act(() => {
      root!.render(
        <LiveCanvas sketch={sketch} params={{}} seed={1} renderMode="outline" />,
      );
    });
    act(() => {
      root!.render(
        <LiveCanvas sketch={sketch} params={{}} seed={1} renderMode="fill" />,
      );
    });

    // Advance 0.5s past the flip. Continuous playback ⇒ t = 2 + 0.5 = 2.5. The
    // pre-fix bug left resumeTRef at 0 (never synced on a mode flip), so the
    // baseline restarted from the flip moment and this tick would read ~0.5 — a
    // snap back toward 0. Asserting t ≈ 2.5 (and > 2) pins the continuation.
    tick(2500);
    expect(lastDrawnT(generate)).toBeCloseTo(2.5, 5);
    expect(lastDrawnT(generate)).toBeGreaterThan(2);
  });

  it("fires onOutlineComputed AFTER the deferred outline pass, never for a fill draw (AC1/AC3, #228)", () => {
    const { ctx, counts } = recordingContext();
    useRecordingContext(ctx);
    const { sketch } = overlapSketch(undefined); // static
    const onOutlineComputed = vi.fn();

    // Fill mount: the synchronous fill path draws and never signals a compute —
    // the owner keeps its render toggle in the idle (not "Computing…") state.
    mount(
      <LiveCanvas
        sketch={sketch}
        params={{}}
        seed={1}
        renderMode="fill"
        onOutlineComputed={onOutlineComputed}
      />,
    );
    expect(onOutlineComputed).not.toHaveBeenCalled();

    // Flip to outline: the pass is deferred, so nothing has drawn or signalled
    // yet. The owner's "Computing…" affordance (set synchronously at the trigger)
    // is what covers this gap — LiveCanvas only signals when the draw lands.
    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={{}}
          seed={1}
          renderMode="outline"
          onOutlineComputed={onOutlineComputed}
        />,
      );
    });
    expect(counts.stroke ?? 0).toBe(0);
    expect(onOutlineComputed).not.toHaveBeenCalled();

    // The deferred frames fire: the pass strokes, THEN the "computed" signal lands
    // so the owner can clear its "Computing…" affordance.
    flushRaf();
    expect(counts.stroke ?? 0).toBeGreaterThan(0);
    expect(onOutlineComputed).toHaveBeenCalledTimes(1);
  });

  it("signals onOutlineComputed again after a param settle WHILE in outline (AC2, #228)", () => {
    const { ctx } = recordingContext();
    useRecordingContext(ctx);
    const { sketch } = overlapSketch(undefined);
    const onOutlineComputed = vi.fn();

    mount(
      <LiveCanvas
        sketch={sketch}
        params={{ a: 1 }}
        seed={1}
        renderMode="outline"
        onOutlineComputed={onOutlineComputed}
      />,
    );
    flushRaf(); // settle the initial outline draw
    expect(onOutlineComputed).toHaveBeenCalledTimes(1);

    // A param change while STILL in outline re-triggers a deferred pass...
    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={{ a: 2 }}
          seed={1}
          renderMode="outline"
          onOutlineComputed={onOutlineComputed}
        />,
      );
    });
    // ...not signalled until it actually draws.
    expect(onOutlineComputed).toHaveBeenCalledTimes(1);
    flushRaf();
    expect(onOutlineComputed).toHaveBeenCalledTimes(2);
  });

  it("a tolerance change WHILE in outline re-runs the on-demand pass (#232)", () => {
    const { ctx } = recordingContext();
    useRecordingContext(ctx);
    const { sketch } = overlapSketch(undefined);
    const onOutlineComputed = vi.fn();

    mount(
      <LiveCanvas
        sketch={sketch}
        params={{ a: 1 }}
        seed={1}
        renderMode="outline"
        tolerance={0}
        onOutlineComputed={onOutlineComputed}
      />,
    );
    flushRaf(); // settle the initial outline draw
    expect(onOutlineComputed).toHaveBeenCalledTimes(1);

    // Bumping the studio tolerance knob (nothing else changed) must re-trigger a
    // deferred pass so the simplification is recomputed and repainted...
    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={{ a: 1 }}
          seed={1}
          renderMode="outline"
          tolerance={5}
          onOutlineComputed={onOutlineComputed}
        />,
      );
    });
    // ...not signalled until it actually draws.
    expect(onOutlineComputed).toHaveBeenCalledTimes(1);
    flushRaf();
    expect(onOutlineComputed).toHaveBeenCalledTimes(2);
  });

  it("rapid successive outline triggers supersede the pending pass — passes never stack (AC5, #228)", () => {
    const { ctx } = recordingContext();
    useRecordingContext(ctx);
    const { sketch } = overlapSketch(undefined);

    mount(<LiveCanvas sketch={sketch} params={{ v: 1 }} seed={1} renderMode="fill" />);
    // Fill mount schedules no rAF (static fill is synchronous).
    expect(rafCallbacks.length).toBe(0);

    // First outline trigger schedules exactly one deferred pass.
    act(() => {
      root!.render(
        <LiveCanvas sketch={sketch} params={{ v: 1 }} seed={1} renderMode="outline" />,
      );
    });
    expect(rafCallbacks.length).toBe(1);

    // A second trigger before the frame fires cancels the first and schedules a
    // fresh one — still exactly one pending pass, not two (no stacking).
    act(() => {
      root!.render(
        <LiveCanvas sketch={sketch} params={{ v: 2 }} seed={1} renderMode="outline" />,
      );
    });
    expect(rafCallbacks.length).toBe(1);

    // Flushing runs that single pass and leaves nothing pending.
    flushRaf();
    expect(rafCallbacks.length).toBe(0);
  });
});
