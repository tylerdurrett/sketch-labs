// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createShadingMask,
  createToneField,
  DEFAULT_COMPOSITION_FRAME,
  frameScene,
  HARNESS_FALLBACK_PLOT_PROFILE,
  resolveCompositionFrame,
  resolvePlotCompositionFrame,
  type PlotProfile,
  type Scene,
  type Sketch,
  type TimeMetadata,
  type ToneSource,
} from "@harness/core";

import {
  LiveCanvas as RawLiveCanvas,
  type LiveCanvasHandle,
  type LiveCanvasProps,
} from "./LiveCanvas";

/** Keep legacy tests terse while the production component requires an explicit frame. */
function LiveCanvas(
  props: Omit<LiveCanvasProps, "compositionFrame" | "profile"> &
    Partial<Pick<LiveCanvasProps, "compositionFrame" | "profile">>,
) {
  return (
    <RawLiveCanvas
      {...props}
      compositionFrame={props.compositionFrame ?? DEFAULT_COMPOSITION_FRAME}
      profile={props.profile ?? HARNESS_FALLBACK_PLOT_PROFILE}
    />
  );
}

/**
 * LiveCanvas IS under test here (unlike SketchControls.test, which mocks it), so
 * the browser stack it touches has to be stood up rather than mocked away:
 *
 *   - `canvas.getContext('2d')` is unimplemented in jsdom and returns `null`, so
 *     we install a recording/no-op context to exercise the real paint boundary.
 *     Time remains observable through the Sketch's `generate` spy, not pixels.
 *   - `ResizeObserver` / `matchMedia` are used by the geometry effect on mount;
 *     jsdom ships neither, so we install controlled stubs. Most tests leave them
 *     inert; the outline-cache regression drives the captured observer callback.
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
const APP_CSS_PATH = [
  resolve(process.cwd(), "src/App.css"),
  resolve(process.cwd(), "apps/studio/src/App.css"),
].find(existsSync);
if (APP_CSS_PATH === undefined) throw new Error("could not locate App.css");
const APP_CSS = readFileSync(APP_CSS_PATH, "utf8");
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
  const prepare = vi.fn(
    (params: Record<string, unknown>, seed: string | number) => {
      // Snapshot preparation inputs so a later caller mutation cannot change which
      // layout this retained sampler represents.
      const value = params.value as number;
      const seededX = value + Number(seed);
      const sampler = vi.fn((t: number): Scene => ({
        space: { width: 100, height: 100 },
        primitives: [
          {
            points: [
              [seededX + t, 0],
              [seededX + t + 10, 0],
              [seededX + t + 10, 10],
              [seededX + t, 10],
            ],
            closed: true,
            fill: { color: "tomato" },
          },
        ],
      }));
      samplers.push(sampler);
      return sampler;
    },
  );
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
  fillRectStyles: unknown[];
  reset: () => void;
} {
  const counts: Record<string, number> = {};
  const fillRectStyles: unknown[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (prop === "fillRect") {
        return (..._args: unknown[]) => {
          counts.fillRect = (counts.fillRect ?? 0) + 1;
          fillRectStyles.push(target.fillStyle);
        };
      }
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
    fillRectStyles.length = 0;
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    counts,
    fillRectStyles,
    reset,
  };
}

/** Point `getContext('2d')` at the given recording context for this test. */
function useRecordingContext(ctx: CanvasRenderingContext2D): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
}

/** A Scene-capable recording context that also retains each pixel-native paint. */
function pixelRecordingContext(): {
  ctx: CanvasRenderingContext2D;
  counts: Record<string, number>;
  images: Uint8ClampedArray[];
} {
  const counts: Record<string, number> = {};
  const images: Uint8ClampedArray[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (prop === "createImageData") {
        return (width: number, height: number) => ({
          width,
          height,
          data: new Uint8ClampedArray(width * height * 4),
        });
      }
      if (prop === "putImageData") {
        return (imageData: ImageData) => {
          counts.putImageData = (counts.putImageData ?? 0) + 1;
          images.push(new Uint8ClampedArray(imageData.data));
        };
      }
      return (..._args: unknown[]) => {
        counts[prop as string] = (counts[prop as string] ?? 0) + 1;
      };
    },
    set: (target, prop, value) => {
      target[prop as string] = value;
      return true;
    },
  });
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    counts,
    images,
  };
}

function toneSource(tone: number): ToneSource {
  return {
    toneField: createToneField(() => tone),
    shadingMask: createShadingMask(() => 1),
  };
}

// --- the hand-driven rAF clock ----------------------------------------------
let now = 0;
let rafCallbacks: Array<(t: number) => void> = [];
let nextRafId = 1;
let fireResizeObserver: (() => void) | null = null;
let fireDprChange: (() => void) | null = null;

/** Advance the fake wall clock to `ms` and flush exactly one rAF generation. */
function tick(ms: number): void {
  now = ms;
  const due = rafCallbacks;
  rafCallbacks = [];
  act(() => {
    for (const cb of due) cb(now);
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

interface PointerInit {
  readonly x: number;
  readonly y: number;
  readonly pointerId?: number;
  readonly isPrimary?: boolean;
  readonly button?: number;
  readonly shiftKey?: boolean;
}

/** Dispatch a pointer-shaped MouseEvent (jsdom does not construct PointerEvent). */
function dispatchPointer(
  target: Element,
  type: string,
  {
    x,
    y,
    pointerId = 1,
    isPrimary = true,
    button = 0,
    shiftKey = false,
  }: PointerInit,
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button,
    shiftKey,
  });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    isPrimary: { value: isPrimary },
  });
  act(() => target.dispatchEvent(event));
}

function installPointerCapture(element: HTMLElement) {
  const captured = new Set<number>();
  const set = vi.fn((pointerId: number) => {
    captured.add(pointerId);
  });
  const release = vi.fn((pointerId: number) => {
    captured.delete(pointerId);
  });
  Object.defineProperties(element, {
    setPointerCapture: { configurable: true, value: set },
    hasPointerCapture: {
      configurable: true,
      value: (pointerId: number) => captured.has(pointerId),
    },
    releasePointerCapture: { configurable: true, value: release },
  });
  return {
    set,
    release,
    lose: (pointerId: number) => captured.delete(pointerId),
  };
}

beforeEach(() => {
  now = 0;
  rafCallbacks = [];
  nextRafId = 1;
  fireResizeObserver = null;
  fireDprChange = null;

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

  // Capture ResizeObserver's callback so resize-specific tests can drive it;
  // other tests leave it inert.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        fireResizeObserver = () =>
          callback([], this as unknown as ResizeObserver);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    const listeners = new Set<EventListener>();
    fireDprChange = () => {
      for (const listener of listeners) listener(new Event("change"));
    };
    return {
        matches: false,
        media: query,
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        if (typeof listener === "function") listeners.add(listener);
      },
      removeEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        if (typeof listener === "function") listeners.delete(listener);
      },
    } as unknown as MediaQueryList;
  });
  // jsdom returns `null` from getContext('2d'). Return an inert context instead:
  // a Proxy whose every method is a no-op and whose fill/strokeStyle accept
  // writes. Most tests observe generated time/geometry rather than pixels; the
  // render-mode cases replace this with a counting context.
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

  it("keys preparation by frame aspect while preserving the animation clock", () => {
    const prepared = explicitlyPreparedSketch({ duration: 10, mode: "loop" });
    const params = {};
    const squareA = { width: 1000, height: 1000 };
    const squareB = { width: 1000, height: 1000 };
    const wide = resolveCompositionFrame(2);

    mount(
      <LiveCanvas
        sketch={prepared.sketch}
        params={params}
        seed={2}
        compositionFrame={squareA}
      />,
    );
    tick(1000);
    expect(prepared.prepare).toHaveBeenCalledTimes(1);

    act(() => {
      root!.render(
        <LiveCanvas
          sketch={prepared.sketch}
          params={params}
          seed={2}
          compositionFrame={squareB}
        />,
      );
    });
    expect(prepared.prepare).toHaveBeenCalledTimes(1);

    act(() => {
      root!.render(
        <LiveCanvas
          sketch={prepared.sketch}
          params={params}
          seed={2}
          compositionFrame={wide}
        />,
      );
    });
    expect(prepared.prepare).toHaveBeenCalledTimes(2);
    expect(prepared.prepare).toHaveBeenLastCalledWith({}, 2, wide);
    tick(1500);
    expect(prepared.samplers[1]).toHaveBeenLastCalledWith(1.5);
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

  it("uses the explicit frame aspect rather than generated Scene space", () => {
    const el = mount(
      <LiveCanvas
        sketch={spacedSketch(200, 1000)}
        params={{}}
        seed={1}
        compositionFrame={resolveCompositionFrame(2)}
      />,
    );
    expect(
      Number(canvasEl(el).style.getPropertyValue("--paper-aspect")),
    ).toBeCloseTo(2);
  });
});

describe("LiveCanvas full-sheet preview chrome (#248)", () => {
  const asymmetricProfile: PlotProfile = {
    width: 200,
    height: 100,
    insets: { top: 10, right: 20, bottom: 30, left: 40 },
    includeFrame: true,
    toolWidthMillimeters: 0.3,
  };

  it("contain-fits the full sheet and positions the drawable region from all four inset ratios", () => {
    const el = mount(
      <LiveCanvas
        sketch={spacedSketch(100, 100)}
        params={{}}
        seed={1}
        profile={asymmetricProfile}
        compositionFrame={resolvePlotCompositionFrame(asymmetricProfile)}
      />,
    );
    const sheet = el.querySelector(".plot-sheet") as HTMLElement;
    const drawable = el.querySelector(".plot-drawable") as HTMLElement;

    expect(sheet.getAttribute("aria-label")).toBe("Plot sheet preview");
    expect(sheet.style.getPropertyValue("--sheet-aspect")).toBe("2");
    expect(sheet.style.getPropertyValue("--plot-inset-top")).toBe("10%");
    expect(sheet.style.getPropertyValue("--plot-inset-right")).toBe("10%");
    expect(sheet.style.getPropertyValue("--plot-inset-bottom")).toBe("30%");
    expect(sheet.style.getPropertyValue("--plot-inset-left")).toBe("20%");
    expect(drawable.querySelector("canvas")).toBe(canvasEl(el));
    expect(
      Number(canvasEl(el).style.getPropertyValue("--paper-aspect")),
    ).toBeCloseTo(140 / 60);
  });

  it("keeps Fill and Outline on the same drawable canvas inside the sheet", () => {
    const sketch = spacedSketch(100, 100);
    const params = {};
    const compositionFrame = resolvePlotCompositionFrame(asymmetricProfile);
    const el = mount(
      <LiveCanvas
        sketch={sketch}
        params={params}
        seed={1}
        profile={asymmetricProfile}
        compositionFrame={compositionFrame}
        renderState={{ kind: "fill-live" }}
      />,
    );
    const sheet = el.querySelector(".plot-sheet");
    const drawable = el.querySelector(".plot-drawable");
    const canvas = canvasEl(el);

    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={params}
          seed={1}
          profile={asymmetricProfile}
          compositionFrame={compositionFrame}
          renderState={{
            kind: "outline",
            scene: { space: compositionFrame, primitives: [] },
            t: 0,
          }}
        />,
      );
    });

    expect(el.querySelector(".plot-sheet")).toBe(sheet);
    expect(el.querySelector(".plot-drawable")).toBe(drawable);
    expect(canvasEl(el)).toBe(canvas);
  });

  it("keeps the export handle pointed at the drawable canvas, not its sheet chrome", () => {
    const handle = createRef<LiveCanvasHandle>();
    const el = mount(
      <LiveCanvas
        handleRef={handle}
        sketch={spacedSketch(100, 100)}
        params={{}}
        seed={1}
        profile={asymmetricProfile}
        compositionFrame={resolvePlotCompositionFrame(asymmetricProfile)}
      />,
    );

    expect(handle.current?.getCanvas()).toBe(canvasEl(el));
    expect(handle.current?.getCanvas()).not.toBe(el.querySelector(".plot-sheet"));
  });
});

describe("LiveCanvas Page Frame edit view", () => {
  const compositionFrame = { width: 200, height: 100 };

  it("contains the whole Composition and an outward draft in one padded extent", () => {
    const el = mount(
      <LiveCanvas
        sketch={spacedSketch(200, 100)}
        params={{}}
        seed={1}
        compositionFrame={compositionFrame}
        pageFrameDraft={{ x: -50, y: -10, width: 300, height: 130 }}
      />,
    );
    const view = el.querySelector<HTMLElement>(".page-frame-edit-view")!;
    const composition = el.querySelector<HTMLElement>(
      ".page-frame-edit-composition",
    )!;
    const boundary = el.querySelector("[data-testid='page-frame-boundary']")!;

    expect(el.querySelector(".plot-sheet")).toBeNull();
    expect(view.getAttribute("aria-label")).toBe("Page Frame edit preview");
    expect(view.style.getPropertyValue("--page-frame-edit-aspect")).toBe(
      String(300 / 130),
    );
    expect(view.style.getPropertyValue("--page-frame-composition-left")).toBe(
      `${(50 / 300) * 100}%`,
    );
    expect(view.style.getPropertyValue("--page-frame-composition-top")).toBe(
      `${(10 / 130) * 100}%`,
    );
    expect(composition.querySelector("canvas")).toBe(canvasEl(el));
    expect(boundary.getAttribute("x")).toBe("-50");
    expect(boundary.getAttribute("y")).toBe("-10");
    expect(boundary.getAttribute("width")).toBe("300");
    expect(boundary.getAttribute("height")).toBe("130");
  });

  it("dims only discarded Composition content for crop and mixed drafts", () => {
    const sketch = spacedSketch(200, 100);
    const el = mount(
      <LiveCanvas
        sketch={sketch}
        params={{}}
        seed={1}
        compositionFrame={compositionFrame}
        pageFrameDraft={{ x: 20, y: 10, width: 100, height: 50 }}
      />,
    );
    const cropPath = el
      .querySelector("[data-testid='page-frame-discarded']")!
      .getAttribute("d");
    expect(cropPath).toContain("M 0 0 H 200 V 100 H 0 Z");
    expect(cropPath).toContain("M 20 10 H 120 V 60 H 20 Z");

    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={{}}
          seed={1}
          compositionFrame={compositionFrame}
          pageFrameDraft={{ x: 40, y: -20, width: 220, height: 80 }}
        />,
      );
    });
    const mixedPath = el
      .querySelector("[data-testid='page-frame-discarded']")!
      .getAttribute("d");
    expect(mixedPath).toContain("M 40 0 H 200 V 60 H 40 Z");
  });

  it("preserves the ordinary full-sheet path when no edit draft is present", () => {
    const el = mount(
      <LiveCanvas
        sketch={spacedSketch(200, 100)}
        params={{}}
        seed={1}
        compositionFrame={compositionFrame}
      />,
    );

    expect(el.querySelector(".plot-sheet")).not.toBeNull();
    expect(el.querySelector(".page-frame-edit-view")).toBeNull();
  });
});

describe("LiveCanvas Page Frame direct manipulation (#346)", () => {
  const compositionFrame = { width: 200, height: 100 };
  const initialFrame = { x: 20, y: 10, width: 100, height: 50 };
  const manipulationParams = {};
  const defaultManipulationSketch = spacedSketch(200, 100);

  function ControlledManipulationCanvas({
    constraint = { kind: "free" },
    initial = initialFrame,
    onChange = () => {},
    sketch = defaultManipulationSketch,
  }: {
    constraint?: LiveCanvasProps["pageFrameAspectConstraint"];
    initial?: typeof initialFrame;
    onChange?: (frame: typeof initialFrame) => void;
    sketch?: Sketch;
  }) {
    const [frame, setFrame] = useState(initial);
    return (
      <LiveCanvas
        sketch={sketch}
        params={manipulationParams}
        seed={1}
        compositionFrame={compositionFrame}
        pageFrameDraft={frame}
        pageFrameAspectConstraint={constraint}
        onPageFrameDraftChange={(next) => {
          setFrame(next);
          onChange(next);
        }}
      />
    );
  }

  function interaction(el: HTMLElement) {
    const view = el.querySelector<HTMLElement>(".page-frame-edit-view")!;
    vi.spyOn(view, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    });
    const layer = el.querySelector<HTMLElement>(".page-frame-interaction")!;
    return { view, layer, capture: installPointerCapture(layer) };
  }

  function handle(el: HTMLElement, name: string): HTMLElement {
    const target = el.querySelector<HTMLElement>(
      `[data-page-frame-handle="${name}"]`,
    );
    if (target === null) throw new Error(`missing ${name} handle`);
    return target;
  }

  function pageBoundaryClientRect(el: HTMLElement) {
    const view = el.querySelector<HTMLElement>(".page-frame-edit-view")!;
    const overlay = el.querySelector<SVGSVGElement>(
      ".page-frame-edit-overlay",
    )!;
    const boundary = el.querySelector<SVGRectElement>(
      "[data-testid='page-frame-boundary']",
    )!;
    const [minX, minY, width, height] = overlay
      .getAttribute("viewBox")!
      .split(" ")
      .map(Number);
    const client = view.getBoundingClientRect();
    const x = Number(boundary.getAttribute("x"));
    const y = Number(boundary.getAttribute("y"));
    const boundaryWidth = Number(boundary.getAttribute("width"));
    const boundaryHeight = Number(boundary.getAttribute("height"));
    return {
      left: client.left + ((x - minX!) / width!) * client.width,
      top: client.top + ((y - minY!) / height!) * client.height,
      width: (boundaryWidth / width!) * client.width,
      height: (boundaryHeight / height!) * client.height,
    };
  }

  it("renders one interior pan target and all eight edge/corner handle hooks", () => {
    const el = mount(<ControlledManipulationCanvas />);

    expect(el.querySelectorAll(".page-frame-pan-target")).toHaveLength(1);
    expect(el.querySelectorAll(".page-frame-resize-handle")).toHaveLength(8);
    expect(
      [...el.querySelectorAll<HTMLElement>(".page-frame-resize-handle")].map(
        (node) => node.dataset.pageFrameHandle,
      ),
    ).toEqual([
      "top-left",
      "top",
      "top-right",
      "right",
      "bottom-right",
      "bottom",
      "bottom-left",
      "left",
    ]);
    const interactionLayer = el.querySelector(".page-frame-interaction")!;
    const targets = interactionLayer.querySelectorAll<HTMLElement>(
      ".page-frame-pan-target, .page-frame-resize-handle",
    );
    expect(interactionLayer.getAttribute("aria-hidden")).toBe("true");
    expect(interactionLayer.querySelectorAll("button")).toHaveLength(0);
    expect([...targets].every((target) => target.tabIndex === -1)).toBe(true);
    expect(
      [...targets].every(
        (target) =>
          target.getAttribute("role") === "presentation" &&
          target.getAttribute("aria-label") === null,
      ),
    ).toBe(true);
  });

  it("gives the interaction targets pointer hit testing, capture-safe touch behavior, and resize cursors", () => {
    expect(APP_CSS).toMatch(
      /\.page-frame-pan-target\s*\{[^}]*pointer-events:\s*auto[^}]*touch-action:\s*none/s,
    );
    expect(APP_CSS).toMatch(
      /\.page-frame-resize-handle\s*\{[^}]*pointer-events:\s*auto[^}]*touch-action:\s*none/s,
    );
    expect(APP_CSS).toMatch(
      /data-page-frame-handle="top-left"[^}]*cursor:\s*nwse-resize/s,
    );
    expect(APP_CSS).toMatch(
      /data-page-frame-handle="right"[^}]*cursor:\s*ew-resize/s,
    );
  });

  it("freezes pointer scale and viewBox while resizing beyond the starting extent", () => {
    const changes = vi.fn();
    const el = mount(<ControlledManipulationCanvas onChange={changes} />);
    const { view, layer, capture } = interaction(el);
    const right = handle(el, "right");

    dispatchPointer(right, "pointerdown", { x: 120, y: 35 });
    expect(capture.set).toHaveBeenCalledWith(1);
    expect(
      el.querySelector(".page-frame-edit-overlay")?.getAttribute("viewBox"),
    ).toBe("0 0 200 100");

    // Layout changes after pointerdown do not change the captured 1px:1-unit
    // mapping: x=140 remains +20, not +10 under this wider live rectangle.
    vi.mocked(view.getBoundingClientRect).mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 100,
      x: 0,
      y: 0,
      width: 400,
      height: 100,
      toJSON: () => ({}),
    });
    dispatchPointer(layer, "pointermove", { x: 140, y: 35 });
    expect(changes).toHaveBeenLastCalledWith({
      x: 20,
      y: 10,
      width: 120,
      height: 50,
    });

    dispatchPointer(layer, "pointermove", { x: 300, y: 35 });
    expect(changes).toHaveBeenLastCalledWith({
      x: 20,
      y: 10,
      width: 280,
      height: 50,
    });
    expect(
      el.querySelector(".page-frame-edit-overlay")?.getAttribute("viewBox"),
    ).toBe("0 0 200 100");

    dispatchPointer(layer, "pointerup", { x: 300, y: 35 });
    expect(capture.release).toHaveBeenCalledWith(1);
    expect(
      el.querySelector(".page-frame-edit-overlay")?.getAttribute("viewBox"),
    ).toBe("0 0 300 100");
  });

  it("clamps an edge crossing without flipping and recovers outward from the immutable start", () => {
    const changes = vi.fn();
    const el = mount(<ControlledManipulationCanvas onChange={changes} />);
    const { layer } = interaction(el);

    dispatchPointer(handle(el, "left"), "pointerdown", { x: 20, y: 35 });
    dispatchPointer(layer, "pointermove", { x: 200, y: 35 });
    const crossed = changes.mock.lastCall?.[0] as typeof initialFrame;
    expect(crossed.x).toBeLessThan(120);
    expect(crossed.width).toBeGreaterThan(0);
    expect(crossed.x + crossed.width).toBeCloseTo(120);

    dispatchPointer(layer, "pointermove", { x: -40, y: 35 });
    expect(changes).toHaveBeenLastCalledWith({
      x: -40,
      y: 10,
      width: 160,
      height: 50,
    });
  });

  it("pans Composition behind a stationary Page boundary and never resamples", () => {
    const changes = vi.fn();
    const sketch = spacedSketch(200, 100);
    const generate = vi.mocked(sketch.generate);
    const el = mount(
      <ControlledManipulationCanvas onChange={changes} sketch={sketch} />,
    );
    const { layer } = interaction(el);
    const drawsBefore = generate.mock.calls.length;

    dispatchPointer(el.querySelector(".page-frame-pan-target")!, "pointerdown", {
      x: 60,
      y: 30,
    });
    dispatchPointer(layer, "pointermove", { x: 90, y: 50 });

    expect(changes).toHaveBeenLastCalledWith({
      x: -10,
      y: -10,
      width: 100,
      height: 50,
    });
    const boundary = el.querySelector("[data-testid='page-frame-boundary']")!;
    expect(boundary.getAttribute("x")).toBe("20");
    expect(boundary.getAttribute("y")).toBe("10");
    expect(
      el
        .querySelector<HTMLElement>(".page-frame-edit-view")!
        .style.getPropertyValue("--page-frame-composition-left"),
    ).toBe("15%");
    expect(generate).toHaveBeenCalledTimes(drawsBefore);
  });

  it.each([
    ["full-frame", { x: 0, y: 0, width: 200, height: 100 }, 30, 20],
    ["inward", initialFrame, 30, 20],
    ["outward", { x: -20, y: -10, width: 240, height: 120 }, 36, 24],
  ])(
    "keeps the %s Page boundary stationary after pan settlement",
    (_label, initial, draftDx, draftDy) => {
      const changes = vi.fn();
      const el = mount(
        <ControlledManipulationCanvas initial={initial} onChange={changes} />,
      );
      const { layer } = interaction(el);
      const panTarget = el.querySelector(".page-frame-pan-target")!;
      const before = pageBoundaryClientRect(el);

      dispatchPointer(panTarget, "pointerdown", { x: 60, y: 30 });
      dispatchPointer(layer, "pointermove", { x: 90, y: 50 });
      const during = pageBoundaryClientRect(el);
      dispatchPointer(layer, "pointerup", { x: 90, y: 50 });

      expect(pageBoundaryClientRect(el)).toEqual(during);
      expect(during).toEqual(before);
      expect(changes).toHaveBeenLastCalledWith({
        ...initial,
        x: initial.x - draftDx,
        y: initial.y - draftDy,
      });
    },
  );

  it("reconciles a settled pan across cancel, external drafts, and edit re-entry", () => {
    let replaceDraft = (_frame: typeof initialFrame) => {};
    let setEditing = (_editing: boolean) => {};
    const changes = vi.fn();

    function TransitionCanvas() {
      const [draft, setDraft] = useState(initialFrame);
      const [editing, updateEditing] = useState(true);
      replaceDraft = setDraft;
      setEditing = updateEditing;
      return (
        <LiveCanvas
          sketch={defaultManipulationSketch}
          params={manipulationParams}
          seed={1}
          compositionFrame={compositionFrame}
          pageFrameDraft={editing ? draft : null}
          onPageFrameDraftChange={(next) => {
            setDraft(next);
            changes(next);
          }}
        />
      );
    }

    const el = mount(<TransitionCanvas />);
    let { layer } = interaction(el);
    dispatchPointer(el.querySelector(".page-frame-pan-target")!, "pointerdown", {
      x: 60,
      y: 30,
    });
    dispatchPointer(layer, "pointermove", { x: 90, y: 50 });
    dispatchPointer(layer, "pointerup", { x: 90, y: 50 });
    const settledRect = pageBoundaryClientRect(el);
    const settledDraft = changes.mock.lastCall?.[0] as typeof initialFrame;

    dispatchPointer(el.querySelector(".page-frame-pan-target")!, "pointerdown", {
      x: 60,
      y: 30,
    });
    expect(pageBoundaryClientRect(el)).toEqual(settledRect);
    dispatchPointer(layer, "pointermove", { x: 70, y: 35 });
    dispatchPointer(layer, "pointercancel", { x: 70, y: 35 });
    expect(changes).toHaveBeenLastCalledWith(settledDraft);
    expect(pageBoundaryClientRect(el)).toEqual(settledRect);

    const externalDraft = { x: 40, y: 5, width: 80, height: 40 };
    act(() => replaceDraft(externalDraft));
    expect(
      el
        .querySelector("[data-testid='page-frame-boundary']")
        ?.getAttribute("x"),
    ).toBe("40");

    ({ layer } = interaction(el));
    dispatchPointer(el.querySelector(".page-frame-pan-target")!, "pointerdown", {
      x: 60,
      y: 30,
    });
    dispatchPointer(layer, "pointermove", { x: 70, y: 35 });
    dispatchPointer(layer, "pointerup", { x: 70, y: 35 });
    const latestDraft = changes.mock.lastCall?.[0] as typeof initialFrame;
    act(() => setEditing(false));
    expect(el.querySelector(".page-frame-edit-view")).toBeNull();
    act(() => setEditing(true));
    expect(
      el
        .querySelector("[data-testid='page-frame-boundary']")
        ?.getAttribute("x"),
    ).toBe(String(latestDraft.x));
  });

  it("rebases temporary Shift transitions without jumps during a freeform drag", () => {
    const changes = vi.fn();
    const el = mount(<ControlledManipulationCanvas onChange={changes} />);
    const { layer } = interaction(el);

    dispatchPointer(handle(el, "right"), "pointerdown", { x: 120, y: 35 });
    dispatchPointer(layer, "pointermove", { x: 140, y: 35 });
    expect(changes).toHaveBeenLastCalledWith({
      x: 20,
      y: 10,
      width: 120,
      height: 50,
    });

    dispatchPointer(layer, "pointermove", {
      x: 140,
      y: 35,
      shiftKey: true,
    });
    expect(changes).toHaveBeenLastCalledWith({
      x: 20,
      y: 10,
      width: 120,
      height: 50,
    });
    dispatchPointer(layer, "pointermove", {
      x: 164,
      y: 35,
      shiftKey: true,
    });
    expect(changes).toHaveBeenLastCalledWith({
      x: 20,
      y: 5,
      width: 144,
      height: 60,
    });

    dispatchPointer(layer, "pointermove", { x: 164, y: 35 });
    dispatchPointer(layer, "pointermove", { x: 174, y: 35 });
    expect(changes).toHaveBeenLastCalledWith({
      x: 20,
      y: 5,
      width: 154,
      height: 60,
    });
  });

  it("keeps a persistent ratio authoritative across Shift transitions", () => {
    const changes = vi.fn();
    const el = mount(
      <ControlledManipulationCanvas
        constraint={{ kind: "ratio", ratio: 1 }}
        onChange={changes}
      />,
    );
    const { layer } = interaction(el);

    dispatchPointer(handle(el, "right"), "pointerdown", { x: 120, y: 35 });
    dispatchPointer(layer, "pointermove", { x: 150, y: 35 });
    const withoutShift = changes.mock.lastCall?.[0];
    dispatchPointer(layer, "pointermove", {
      x: 150,
      y: 35,
      shiftKey: true,
    });
    expect(changes.mock.lastCall?.[0]).toEqual(withoutShift);
    expect(withoutShift).toEqual({ x: 20, y: -30, width: 130, height: 130 });
  });

  it("filters non-primary/concurrent pointers and restores the start on cancel or lost capture", () => {
    const changes = vi.fn();
    const el = mount(<ControlledManipulationCanvas onChange={changes} />);
    const { layer, capture } = interaction(el);
    const right = handle(el, "right");

    dispatchPointer(right, "pointerdown", {
      x: 120,
      y: 35,
      pointerId: 2,
      isPrimary: false,
    });
    dispatchPointer(right, "pointerdown", { x: 120, y: 35, button: 2 });
    expect(capture.set).not.toHaveBeenCalled();

    dispatchPointer(right, "pointerdown", { x: 120, y: 35 });
    dispatchPointer(layer, "pointermove", { x: 180, y: 35, pointerId: 2 });
    expect(changes).not.toHaveBeenCalled();
    dispatchPointer(layer, "pointermove", { x: 150, y: 35 });
    expect(changes).toHaveBeenLastCalledWith({
      x: 20,
      y: 10,
      width: 130,
      height: 50,
    });
    dispatchPointer(layer, "pointercancel", { x: 150, y: 35 });
    expect(changes).toHaveBeenLastCalledWith(initialFrame);

    dispatchPointer(right, "pointerdown", { x: 120, y: 35 });
    dispatchPointer(layer, "pointermove", { x: 160, y: 35 });
    capture.lose(1);
    dispatchPointer(layer, "lostpointercapture", { x: 160, y: 35 });
    expect(changes).toHaveBeenLastCalledWith(initialFrame);
    expect(capture.set).toHaveBeenCalledTimes(2);
  });
});

describe("LiveCanvas retained Page Frame derivation (#344 PF-06)", () => {
  const compositionFrame = { width: 200, height: 100 };
  const crop = { x: 20, y: 10, width: 100, height: 50 };
  const padding = { x: -20, y: -10, width: 240, height: 120 };
  const mixed = { x: 40, y: -20, width: 200, height: 90 };

  function retainedStaticScene(background?: Scene["background"]) {
    const source: Scene = {
      space: compositionFrame,
      primitives: [
        {
          points: [[0, 0], [200, 0], [200, 100], [0, 100]],
          closed: true,
          fill: { color: "tomato" },
        },
      ],
      ...(background === undefined ? {} : { background }),
    };
    const generate = vi.fn(() => source);
    return {
      source,
      generate,
      sketch: {
        id: "retained-page-frame",
        name: "Retained Page Frame",
        schema: {},
        generate,
      } as unknown as Sketch,
    };
  }

  function usePerCanvasContexts() {
    const contexts = new WeakMap<
      HTMLCanvasElement,
      ReturnType<typeof recordingContext>
    >();
    const canvases: HTMLCanvasElement[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement) {
        let context = contexts.get(this);
        if (context === undefined) {
          context = recordingContext();
          contexts.set(this, context);
          canvases.push(this);
        }
        return context.ctx;
      },
    );
    return { contexts, canvases };
  }

  it("keeps one static canvas live through Crop entry, Cancel, Apply, Reset, resize, and DPR changes", () => {
    let boxWidth = 100;
    let dpr = 1;
    vi.spyOn(
      HTMLCanvasElement.prototype,
      "getBoundingClientRect",
    ).mockImplementation(
      () => ({ width: boxWidth, height: boxWidth / 2 }) as DOMRect,
    );
    vi.spyOn(window, "devicePixelRatio", "get").mockImplementation(() => dpr);
    const { contexts, canvases } = usePerCanvasContexts();
    const handle = createRef<LiveCanvasHandle>();
    const fixture = retainedStaticScene();
    const params = {};
    const render = (
      pageFrame: typeof crop | null,
      pageFrameDraft: typeof crop | null,
    ) => (
      <LiveCanvas
        handleRef={handle}
        sketch={fixture.sketch}
        params={params}
        seed={1}
        compositionFrame={compositionFrame}
        pageFrame={pageFrame}
        pageFrameDraft={pageFrameDraft}
      />
    );
    const el = mount(render(null, null));
    const canvas = canvasEl(el);
    const context = contexts.get(canvas)!;

    const transition = (
      pageFrame: typeof crop | null,
      pageFrameDraft: typeof crop | null,
    ) => {
      act(() => root!.render(render(pageFrame, pageFrameDraft)));
      expect(canvasEl(el)).toBe(canvas);
      expect(handle.current!.getCanvas()).toBe(canvas);
      expect(contexts.get(canvasEl(el))).toBe(context);
    };

    transition(null, crop);
    transition(null, null);
    transition(null, crop);
    transition(crop, null);
    transition(crop, crop);
    transition(null, null);

    boxWidth = 160;
    act(() => fireResizeObserver?.());
    expect(canvasEl(el)).toBe(canvas);
    expect(canvas.width).toBe(160);

    dpr = 2;
    act(() => fireDprChange?.());
    expect(canvasEl(el)).toBe(canvas);
    expect(canvas.width).toBe(320);
    expect(context.counts.fillRect).toBeGreaterThan(0);
    expect(canvases).toEqual([canvas]);
    expect(fixture.generate).toHaveBeenCalledOnce();
  });

  it("keeps the visible animated canvas advancing across Cancel, Apply, and Reset without resetting time", () => {
    const { contexts, canvases } = usePerCanvasContexts();
    const handle = createRef<LiveCanvasHandle>();
    const { sketch, generate } = animatedSketch({
      duration: 10,
      mode: "loop",
    });
    const params = {};
    const render = (
      pageFrame: typeof crop | null,
      pageFrameDraft: typeof crop | null,
    ) => (
      <LiveCanvas
        handleRef={handle}
        sketch={sketch}
        params={params}
        seed={1}
        compositionFrame={compositionFrame}
        pageFrame={pageFrame}
        pageFrameDraft={pageFrameDraft}
      />
    );
    const el = mount(render(null, null));
    const canvas = canvasEl(el);
    tick(0);
    const context = contexts.get(canvas)!;

    const transitionAndAdvance = (
      pageFrame: typeof crop | null,
      pageFrameDraft: typeof crop | null,
      milliseconds: number,
    ) => {
      act(() => root!.render(render(pageFrame, pageFrameDraft)));
      const paintsBeforeTick = context.counts.fillRect ?? 0;
      tick(milliseconds);
      expect(canvasEl(el)).toBe(canvas);
      expect(handle.current!.getCanvas()).toBe(canvas);
      expect(context.counts.fillRect).toBeGreaterThan(paintsBeforeTick);
      expect(lastDrawnT(generate)).toBe(milliseconds / 1000);
    };

    transitionAndAdvance(null, crop, 500);
    transitionAndAdvance(null, null, 1000);
    transitionAndAdvance(null, crop, 1500);
    transitionAndAdvance(crop, null, 2000);
    transitionAndAdvance(crop, crop, 2500);
    transitionAndAdvance(null, null, 3000);

    expect(canvases).toEqual([canvas]);
    expect(handle.current!.getCurrentT()).toBe(3);
  });

  it.each([
    ["crop", crop],
    ["padding", padding],
    ["mixed crop and padding", mixed],
  ] as const)("reframes retained static Fill for %s without sampling again", (_label, frame) => {
    const handle = createRef<LiveCanvasHandle>();
    const fixture = retainedStaticScene();
    const params = {};
    mount(
      <LiveCanvas
        handleRef={handle}
        sketch={fixture.sketch}
        params={params}
        seed={1}
        compositionFrame={compositionFrame}
        inputRevision={12}
      />,
    );
    const sourceSnapshot = handle.current!.captureDisplayedFrame()!;
    expect(sourceSnapshot.scene).toBe(fixture.source);
    expect(sourceSnapshot.sourceScene).toBe(fixture.source);
    expect(sourceSnapshot.displayedScene).toBe(fixture.source);
    expect(fixture.generate).toHaveBeenCalledOnce();

    act(() => {
      root!.render(
        <LiveCanvas
          handleRef={handle}
          sketch={fixture.sketch}
          params={params}
          seed={1}
          compositionFrame={compositionFrame}
          inputRevision={12}
          pageFrame={frame}
        />,
      );
    });

    const framed = handle.current!.captureDisplayedFrame()!;
    expect(fixture.generate).toHaveBeenCalledOnce();
    expect(framed.t).toBe(sourceSnapshot.t);
    expect(framed.sourceInputRevision).toBe(12);
    expect(framed.sourceScene).toBe(fixture.source);
    expect(framed.scene).toBe(framed.displayedScene);
    expect(framed.displayedScene).toEqual(frameScene(fixture.source, frame));
    expect(framed.displayedScene.space).toEqual({
      width: frame.width,
      height: frame.height,
    });
    expect(
      Number(canvasEl(container!).style.getPropertyValue("--paper-aspect")),
    ).toBeCloseTo(frame.width / frame.height);
  });

  it("reframes an animated prepared Fill at the same sampled t without resetting its clock", () => {
    const handle = createRef<LiveCanvasHandle>();
    const fixture = explicitlyPreparedSketch({ duration: 10, mode: "loop" });
    const params = { value: 3 };
    mount(
      <LiveCanvas
        handleRef={handle}
        sketch={fixture.sketch}
        params={params}
        seed={2}
        compositionFrame={compositionFrame}
      />,
    );
    tick(1750);
    const before = handle.current!.captureDisplayedFrame()!;
    expect(fixture.prepare).toHaveBeenCalledOnce();
    expect(fixture.samplers[0]).toHaveBeenCalledOnce();

    act(() => {
      root!.render(
        <LiveCanvas
          handleRef={handle}
          sketch={fixture.sketch}
          params={params}
          seed={2}
          compositionFrame={compositionFrame}
          pageFrame={crop}
        />,
      );
    });

    const after = handle.current!.captureDisplayedFrame()!;
    expect(fixture.prepare).toHaveBeenCalledOnce();
    expect(fixture.samplers[0]).toHaveBeenCalledOnce();
    expect(after.t).toBe(1.75);
    expect(after.sourceScene).toBe(before.sourceScene);
    expect(after.displayedScene).toEqual(frameScene(before.sourceScene, crop));

    tick(2250);
    expect(fixture.samplers[0]).toHaveBeenLastCalledWith(2.25);
  });

  it("enters edit mode by repainting the retained full Composition, then applies and resets paint-only", () => {
    const handle = createRef<LiveCanvasHandle>();
    const fixture = retainedStaticScene();
    const params = {};
    const render = (pageFrame: typeof crop | null, pageFrameDraft: typeof crop | null) => (
      <LiveCanvas
        handleRef={handle}
        sketch={fixture.sketch}
        params={params}
        seed={1}
        compositionFrame={compositionFrame}
        pageFrame={pageFrame}
        pageFrameDraft={pageFrameDraft}
      />
    );
    mount(render(crop, null));
    expect(handle.current!.captureDisplayedFrame()!.displayedScene).not.toBe(
      fixture.source,
    );

    act(() => root!.render(render(crop, crop)));
    expect(handle.current!.captureDisplayedFrame()!.displayedScene).toBe(
      fixture.source,
    );
    act(() => root!.render(render(mixed, null)));
    expect(handle.current!.captureDisplayedFrame()!.displayedScene).toEqual(
      frameScene(fixture.source, mixed),
    );
    act(() => root!.render(render(null, null)));
    expect(handle.current!.captureDisplayedFrame()!.displayedScene).toBe(
      fixture.source,
    );
    expect(fixture.generate).toHaveBeenCalledOnce();
  });

  it("repaints a framed snapshot on resize without replacing its retained Scenes", () => {
    let boxSize = 100;
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width: boxSize, height: boxSize / 2 }) as DOMRect,
    );
    const handle = createRef<LiveCanvasHandle>();
    const fixture = retainedStaticScene();
    mount(
      <LiveCanvas
        handleRef={handle}
        sketch={fixture.sketch}
        params={{}}
        seed={1}
        compositionFrame={compositionFrame}
        pageFrame={crop}
      />,
    );
    const retained = handle.current!.captureDisplayedFrame()!;
    boxSize = 200;
    act(() => fireResizeObserver?.());

    expect(canvasEl(container!).width).toBe(200);
    expect(fixture.generate).toHaveBeenCalledOnce();
    expect(handle.current!.captureDisplayedFrame()).toBe(retained);
  });

  it("uses ADR-0009 background precedence for padded Page and edit padding", () => {
    const { ctx, fillRectStyles } = recordingContext();
    useRecordingContext(ctx);
    const authored = retainedStaticScene({ color: "mintcream" });
    const params = {};
    const handle = createRef<LiveCanvasHandle>();
    mount(
      <LiveCanvas
        handleRef={handle}
        sketch={authored.sketch}
        params={params}
        seed={1}
        compositionFrame={compositionFrame}
        pageFrame={padding}
      />,
    );
    expect(handle.current!.captureDisplayedFrame()!.displayedScene.background)
      .toEqual({ color: "mintcream" });
    expect(fillRectStyles).toContain("mintcream");

    act(() => {
      root!.render(
        <LiveCanvas
          handleRef={handle}
          sketch={authored.sketch}
          params={params}
          seed={1}
          compositionFrame={compositionFrame}
          pageFrame={padding}
          pageFrameDraft={padding}
        />,
      );
    });
    expect(
      container!.querySelector<HTMLElement>(".page-frame-edit-page-ground")!
        .style.backgroundColor,
    ).toBe("mintcream");

    const ordinary = retainedStaticScene();
    act(() => {
      root!.render(
        <LiveCanvas
          handleRef={handle}
          sketch={ordinary.sketch}
          params={params}
          seed={1}
          compositionFrame={compositionFrame}
          pageFrame={padding}
          pageFrameDraft={padding}
        />,
      );
    });
    expect(
      container!.querySelector<HTMLElement>(".page-frame-edit-page-ground")!
        .style.backgroundColor,
    ).toBe("white");
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

describe("LiveCanvas worker handoff contract (#289)", () => {
  it("answers a matching Fill request immediately and only once across later frames", () => {
    const { sketch } = animatedSketch({ duration: 10, mode: "loop" });
    const onFillCaptured = vi.fn();
    mount(
      <LiveCanvas
        sketch={sketch}
        params={{}}
        seed={1}
        inputRevision={7}
        onFillCaptured={onFillCaptured}
      />,
    );
    tick(1000);

    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={{}}
          seed={1}
          inputRevision={7}
          fillCaptureRequest={{ token: 11, inputRevision: 7 }}
          onFillCaptured={onFillCaptured}
        />,
      );
    });

    expect(onFillCaptured).toHaveBeenCalledTimes(1);
    expect(onFillCaptured).toHaveBeenCalledWith(
      expect.objectContaining({ token: 11, inputRevision: 7, t: 1 }),
    );
    tick(2000);
    tick(3000);
    expect(onFillCaptured).toHaveBeenCalledTimes(1);
  });

  it("waits past an old revision and answers from the next matching Fill draw", () => {
    const { sketch } = animatedSketch({ duration: 10, mode: "loop" });
    const onFillCaptured = vi.fn();
    mount(
      <LiveCanvas
        sketch={sketch}
        params={{ value: 1 }}
        seed={1}
        inputRevision={1}
        onFillCaptured={onFillCaptured}
      />,
    );
    tick(1000);

    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={{ value: 2 }}
          seed={1}
          inputRevision={2}
          fillCaptureRequest={{ token: 12, inputRevision: 2 }}
          onFillCaptured={onFillCaptured}
        />,
      );
    });
    expect(onFillCaptured).not.toHaveBeenCalled();
    tick(1500);
    expect(onFillCaptured).toHaveBeenCalledOnce();
    expect(onFillCaptured.mock.calls[0]?.[0]).toMatchObject({
      token: 12,
      inputRevision: 2,
      t: 1.5,
    });
  });

  it("only answers the newest request and never answers a wrong revision", () => {
    const { sketch } = animatedSketch({ duration: 10, mode: "loop" });
    const onFillCaptured = vi.fn();
    mount(
      <LiveCanvas
        sketch={sketch}
        params={{}}
        seed={1}
        inputRevision={3}
        fillCaptureRequest={{ token: 20, inputRevision: 4 }}
        onFillCaptured={onFillCaptured}
      />,
    );
    tick(1000);
    expect(onFillCaptured).not.toHaveBeenCalled();

    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={{}}
          seed={1}
          inputRevision={3}
          fillCaptureRequest={{ token: 21, inputRevision: 3 }}
          onFillCaptured={onFillCaptured}
        />,
      );
    });
    expect(onFillCaptured).toHaveBeenCalledTimes(1);
    expect(onFillCaptured.mock.calls[0]?.[0].token).toBe(21);
  });

  it("never serves the same token twice across an A → B → A request sequence", () => {
    const { sketch } = animatedSketch({ duration: 10, mode: "loop" });
    const onFillCaptured = vi.fn();
    const params = {};
    mount(
      <LiveCanvas
        sketch={sketch}
        params={params}
        seed={1}
        inputRevision={5}
        onFillCaptured={onFillCaptured}
      />,
    );
    tick(1000);

    for (const token of [40, 41, 40]) {
      act(() => {
        root!.render(
          <LiveCanvas
            sketch={sketch}
            params={params}
            seed={1}
            inputRevision={5}
            fillCaptureRequest={{ token, inputRevision: 5 }}
            onFillCaptured={onFillCaptured}
          />,
        );
      });
    }

    expect(onFillCaptured).toHaveBeenCalledTimes(2);
    expect(onFillCaptured.mock.calls.map(([capture]) => capture.token)).toEqual([
      40, 41,
    ]);
  });

  it("does not answer a pending mismatched request after unmount", () => {
    const { sketch } = animatedSketch({ duration: 10, mode: "loop" });
    const onFillCaptured = vi.fn();
    mount(
      <LiveCanvas
        sketch={sketch}
        params={{}}
        seed={1}
        inputRevision={1}
        fillCaptureRequest={{ token: 30, inputRevision: 2 }}
        onFillCaptured={onFillCaptured}
      />,
    );
    act(() => root!.unmount());
    root = null;
    tick(1000);
    expect(onFillCaptured).not.toHaveBeenCalled();
  });

  it("freezes an exact held Fill Scene and t without advancing animation", () => {
    const { sketch, generate } = animatedSketch({ duration: 10, mode: "loop" });
    const handle = createRef<LiveCanvasHandle>();
    mount(<LiveCanvas handleRef={handle} sketch={sketch} params={{}} seed={1} />);
    tick(2000);
    const captured = handle.current!.getDisplayedScene()!;
    const draws = generate.mock.calls.length;

    act(() => {
      root!.render(
        <LiveCanvas
          handleRef={handle}
          sketch={sketch}
          params={{}}
          seed={1}
          renderState={{ kind: "fill-held", scene: captured.scene, t: captured.t }}
        />,
      );
    });
    tick(8000);
    expect(generate).toHaveBeenCalledTimes(draws);
    expect(handle.current?.getDisplayedScene()).toMatchObject({
      scene: captured.scene,
      t: 2,
      renderMode: "fill",
    });
  });

  it("captures animated Scene and t from one retained displayed-frame record", () => {
    const { sketch } = explicitlyPreparedSketch({ duration: 10, mode: "loop" });
    const handle = createRef<LiveCanvasHandle>();
    mount(
      <LiveCanvas handleRef={handle} sketch={sketch} params={{ value: 0 }} seed={1} />,
    );

    tick(1250);
    const first = handle.current!.captureDisplayedFrame()!;
    expect(first.t).toBe(1.25);
    expect(first.scene.primitives[0]?.points[0]?.[0]).toBe(2.25);

    tick(2750);
    const second = handle.current!.captureDisplayedFrame()!;
    expect(second.t).toBe(2.75);
    expect(second.scene.primitives[0]?.points[0]?.[0]).toBe(3.75);
    expect(first.t).toBe(1.25);
  });

  it("answers a matching request from a held Fill while animation is suspended", () => {
    const { sketch, generate } = animatedSketch({ duration: 10, mode: "loop" });
    const held: Scene = { space: { width: 100, height: 100 }, primitives: [] };
    const onFillCaptured = vi.fn();
    mount(
      <LiveCanvas
        sketch={sketch}
        params={{}}
        seed={1}
        inputRevision={6}
        fillCaptureRequest={{ token: 50, inputRevision: 6 }}
        onFillCaptured={onFillCaptured}
        renderState={{
          kind: "fill-held",
          scene: held,
          t: 2.25,
          sourceInputRevision: 6,
          contentRevision: 14,
        }}
      />,
    );

    expect(generate).not.toHaveBeenCalled();
    expect(onFillCaptured).toHaveBeenCalledOnce();
    expect(onFillCaptured).toHaveBeenCalledWith({
      token: 50,
      inputRevision: 6,
      scene: held,
      sourceScene: held,
      t: 2.25,
      sourceInputRevision: 6,
      contentRevision: 14,
    });
    tick(9000);
    expect(onFillCaptured).toHaveBeenCalledOnce();
  });

  it("retains supplied provenance and never serves stale held geometry as current", () => {
    const { sketch, generate } = animatedSketch({ duration: 10, mode: "loop" });
    const held: Scene = { space: { width: 100, height: 100 }, primitives: [] };
    const handle = createRef<LiveCanvasHandle>();
    const onFillCaptured = vi.fn();

    mount(
      <LiveCanvas
        handleRef={handle}
        sketch={sketch}
        params={{}}
        seed={1}
        inputRevision={8}
        fillCaptureRequest={{ token: 51, inputRevision: 8 }}
        onFillCaptured={onFillCaptured}
        renderState={{
          kind: "fill-held",
          scene: held,
          t: 3,
          sourceInputRevision: 7,
          contentRevision: 22,
        }}
      />,
    );

    expect(generate).not.toHaveBeenCalled();
    expect(onFillCaptured).not.toHaveBeenCalled();
    expect(handle.current?.getDisplayedScene()).toMatchObject({
      scene: held,
      inputRevision: 7,
      sourceInputRevision: 7,
      contentRevision: 22,
    });
  });

  it("acknowledges supplied content only after its paint succeeds", () => {
    const { sketch } = animatedSketch({ duration: 10, mode: "loop" });
    const held: Scene = { space: { width: 100, height: 100 }, primitives: [] };
    const handle = createRef<LiveCanvasHandle>();
    const onDisplayedSceneCommitted = vi.fn();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);

    mount(
      <LiveCanvas
        handleRef={handle}
        sketch={sketch}
        params={{}}
        seed={1}
        onDisplayedSceneCommitted={onDisplayedSceneCommitted}
        renderState={{
          kind: "fill-held",
          scene: held,
          t: 3,
          sourceInputRevision: 7,
          contentRevision: 22,
        }}
      />,
    );

    expect(onDisplayedSceneCommitted).not.toHaveBeenCalled();
    expect(handle.current?.getDisplayedScene()).toBeNull();

    const { ctx } = recordingContext();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(ctx);
    act(() => {
      root!.render(
        <LiveCanvas
          handleRef={handle}
          sketch={sketch}
          params={{}}
          seed={1}
          onDisplayedSceneCommitted={onDisplayedSceneCommitted}
          renderState={{
            kind: "fill-held",
            scene: held,
            t: 3,
            sourceInputRevision: 7,
            contentRevision: 23,
          }}
        />,
      );
    });

    expect(onDisplayedSceneCommitted).toHaveBeenCalledOnce();
    expect(onDisplayedSceneCommitted).toHaveBeenCalledWith(
      expect.objectContaining({
        scene: held,
        sourceInputRevision: 7,
        contentRevision: 23,
      }),
    );
    expect(handle.current?.getDisplayedScene()).toBe(
      onDisplayedSceneCommitted.mock.calls[0]?.[0],
    );
  });

  it("paints a completed caller-supplied Outline atomically without sampling the Sketch", () => {
    const { ctx, counts } = recordingContext();
    useRecordingContext(ctx);
    const { sketch, generate } = animatedSketch({ duration: 10, mode: "loop" });
    const outline: Scene = {
      space: { width: 100, height: 100 },
      primitives: [{ points: [[0, 0], [50, 50]], stroke: { color: "black", width: 1 } }],
    };
    const handle = createRef<LiveCanvasHandle>();
    mount(
      <LiveCanvas
        handleRef={handle}
        sketch={sketch}
        params={{}}
        seed={1}
        renderState={{ kind: "outline", scene: outline, t: 4 }}
      />,
    );

    expect(generate).not.toHaveBeenCalled();
    expect(counts.stroke ?? 0).toBeGreaterThan(0);
    expect(handle.current?.getDisplayedScene()).toMatchObject({
      scene: outline,
      t: 4,
      renderMode: "outline",
    });
  });

  it("never prepares or generates the Sketch for supplied Fill, Outline, or Tone", () => {
    const { ctx } = pixelRecordingContext();
    useRecordingContext(ctx);
    const { sketch, prepare, generate } = explicitlyPreparedSketch({
      duration: 10,
      mode: "loop",
    });
    const supplied: Scene = {
      space: { width: 100, height: 100 },
      primitives: [],
    };

    mount(
      <LiveCanvas
        sketch={sketch}
        params={{ value: 1 }}
        seed={1}
        renderState={{
          kind: "fill-held",
          scene: supplied,
          t: 1,
          sourceInputRevision: 1,
          contentRevision: 1,
        }}
      />,
    );
    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={{ value: 1 }}
          seed={1}
          renderState={{
            kind: "outline",
            scene: supplied,
            t: 1,
            sourceInputRevision: 1,
            contentRevision: 2,
          }}
        />,
      );
    });
    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={{ value: 1 }}
          seed={1}
          renderState={{ kind: "tone-reference", source: toneSource(0.5) }}
        />,
      );
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("replaces held Fill with a completed Outline without an empty snapshot", () => {
    const { sketch } = animatedSketch({ duration: 10, mode: "loop" });
    const fill: Scene = { space: { width: 100, height: 100 }, primitives: [] };
    const outline: Scene = {
      space: fill.space,
      primitives: [
        {
          points: [[0, 0], [10, 10]],
          stroke: { color: "black", width: 1 },
        },
      ],
    };
    const handle = createRef<LiveCanvasHandle>();
    mount(
      <LiveCanvas
        handleRef={handle}
        sketch={sketch}
        params={{}}
        seed={1}
        renderState={{ kind: "fill-held", scene: fill, t: 3 }}
      />,
    );
    expect(handle.current?.getDisplayedScene()?.scene).toBe(fill);

    act(() => {
      root!.render(
        <LiveCanvas
          handleRef={handle}
          sketch={sketch}
          params={{}}
          seed={1}
          renderState={{ kind: "outline", scene: outline, t: 3 }}
        />,
      );
    });
    expect(handle.current?.getDisplayedScene()).not.toBeNull();
    expect(handle.current?.getDisplayedScene()?.scene).toBe(outline);
  });

  it("repaints supplied geometry on resize without deriving or replacing it", () => {
    const { ctx, counts, reset } = recordingContext();
    useRecordingContext(ctx);
    const { sketch, generate } = animatedSketch({ duration: 10, mode: "loop" });
    const supplied: Scene = {
      space: { width: 100, height: 100 },
      primitives: [{ points: [[0, 0], [10, 10]], stroke: { color: "black", width: 1 } }],
    };
    let boxSize = 100;
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width: boxSize, height: boxSize }) as DOMRect,
    );
    const el = mount(
      <LiveCanvas
        sketch={sketch}
        params={{}}
        seed={1}
        renderState={{ kind: "outline", scene: supplied, t: 5 }}
      />,
    );
    reset();
    boxSize = 200;
    act(() => fireResizeObserver?.());

    expect(canvasEl(el).width).toBe(200);
    expect(counts.stroke ?? 0).toBeGreaterThan(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns from held Fill to the live clock at the frozen time", () => {
    const { sketch, generate } = animatedSketch({ duration: 10, mode: "loop" });
    const params = {};
    mount(<LiveCanvas sketch={sketch} params={params} seed={1} />);
    tick(2000);
    const heldScene = generate.mock.results.at(-1)?.value as Scene;

    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={params}
          seed={1}
          renderState={{ kind: "fill-held", scene: heldScene, t: 2 }}
        />,
      );
    });
    tick(3000);
    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={params}
          seed={1}
          renderState={{ kind: "fill-live" }}
        />,
      );
    });
    tick(3500);
    expect(lastDrawnT(generate)).toBeCloseTo(2.5, 5);
  });
});

describe("LiveCanvas unavailable Image Asset state (#335)", () => {
  it.each([
    ["loading", "status", "Image Assets loading"],
    ["missing", "alert", "Image Assets unavailable"],
    ["error", "alert", "Image Assets could not be loaded"],
  ] as const)(
    "presents bounded %s feedback with every exact unresolved ID",
    (status, role, message) => {
      const { sketch, prepare, generate } = explicitlyPreparedSketch({
        duration: 10,
        mode: "loop",
      });
      const unresolvedAssetIds = [
        "first-asset-000000000001",
        "second-asset-000000000002",
      ];
      const el = mount(
        <LiveCanvas
          sketch={sketch}
          params={{ value: 1 }}
          seed={1}
          renderState={{ kind: "unavailable", status, unresolvedAssetIds }}
        />,
      );

      const feedback = el.querySelector(`[role="${role}"]`);
      expect(feedback?.textContent).toContain(message);
      expect(
        [...el.querySelectorAll(".live-canvas-unavailable__ids code")].map(
          (node) => node.textContent,
        ),
      ).toEqual(unresolvedAssetIds);
      expect(canvasEl(el).getAttribute("aria-hidden")).toBe("true");
      expect(el.querySelector(".transport")).toBeNull();
      expect(prepare).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it("clears stale pixels and every capture seam before an unavailable request can observe them", () => {
    const { ctx, counts, reset } = recordingContext();
    useRecordingContext(ctx);
    const { sketch, generate } = animatedSketch({ duration: 10, mode: "loop" });
    const handle = createRef<LiveCanvasHandle>();
    const onFillCaptured = vi.fn();
    const params = {};
    const el = mount(
      <LiveCanvas
        handleRef={handle}
        sketch={sketch}
        params={params}
        seed={1}
        inputRevision={4}
      />,
    );
    tick(1000);
    expect(handle.current?.captureDisplayedFrame()).not.toBeNull();
    const draws = generate.mock.calls.length;
    reset();

    act(() => {
      root!.render(
        <LiveCanvas
          handleRef={handle}
          sketch={sketch}
          params={params}
          seed={1}
          inputRevision={4}
          fillCaptureRequest={{ token: 99, inputRevision: 4 }}
          onFillCaptured={onFillCaptured}
          renderState={{
            kind: "unavailable",
            status: "missing",
            unresolvedAssetIds: ["missing-asset-000000000004"],
          }}
        />,
      );
    });

    expect(counts.clearRect).toBe(1);
    expect(counts.fill ?? 0).toBe(0);
    expect(counts.stroke ?? 0).toBe(0);
    expect(counts.fillRect ?? 0).toBe(0);
    expect(counts.putImageData ?? 0).toBe(0);
    expect(handle.current?.getDisplayedScene()).toBeNull();
    expect(handle.current?.captureDisplayedFrame()).toBeNull();
    expect(handle.current?.getCanvas()).toBe(canvasEl(el));
    expect(onFillCaptured).not.toHaveBeenCalled();
    tick(5000);
    expect(generate).toHaveBeenCalledTimes(draws);
    expect(onFillCaptured).not.toHaveBeenCalled();
  });

  it("resumes ordinary preparation and rendering when the exact input resolves", () => {
    const { sketch, prepare, generate } = explicitlyPreparedSketch({
      duration: 10,
      mode: "loop",
    });
    const handle = createRef<LiveCanvasHandle>();
    const params = { value: 2 };
    const el = mount(
      <LiveCanvas
        handleRef={handle}
        sketch={sketch}
        params={params}
        seed={3}
        renderState={{
          kind: "unavailable",
          status: "loading",
          unresolvedAssetIds: ["recovering-asset-000000000005"],
        }}
      />,
    );
    expect(prepare).not.toHaveBeenCalled();

    act(() => {
      root!.render(
        <LiveCanvas
          handleRef={handle}
          sketch={sketch}
          params={params}
          seed={3}
          renderState={{ kind: "fill-live" }}
        />,
      );
    });
    expect(prepare).toHaveBeenCalledOnce();
    tick(750);

    expect(generate).not.toHaveBeenCalled();
    expect(handle.current?.captureDisplayedFrame()).toMatchObject({
      t: 0.75,
      renderMode: "fill",
    });
    expect(el.querySelector(".live-canvas-unavailable")).toBeNull();
    expect(el.querySelector(".transport")).not.toBeNull();
    expect(canvasEl(el).hasAttribute("aria-hidden")).toBe(false);
  });
});

describe("LiveCanvas Tone reference pixels (#316)", () => {
  it("bypasses Sketch generation and the Scene renderer and exposes no displayed Scene", () => {
    const { ctx, counts, images } = pixelRecordingContext();
    useRecordingContext(ctx);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(
      { width: 2, height: 1 } as DOMRect,
    );
    const { sketch, generate } = animatedSketch({ duration: 10, mode: "loop" });
    const handle = createRef<LiveCanvasHandle>();

    mount(
      <LiveCanvas
        handleRef={handle}
        sketch={sketch}
        params={{}}
        seed={1}
        renderState={{ kind: "tone-reference", source: toneSource(1) }}
      />,
    );

    expect(generate).not.toHaveBeenCalled();
    expect(counts.putImageData).toBe(1);
    expect(counts.setTransform ?? 0).toBe(0);
    expect(counts.fillRect ?? 0).toBe(0);
    expect([...images[0]!]).toEqual([
      0, 0, 0, 255,
      0, 0, 0, 255,
    ]);
    expect(handle.current?.getDisplayedScene()).toBeNull();
    expect(handle.current?.captureDisplayedFrame()).toBeNull();
  });

  it("repaints immediately when the source or Composition Frame changes", () => {
    const { ctx, images } = pixelRecordingContext();
    useRecordingContext(ctx);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(
      { width: 1, height: 1 } as DOMRect,
    );
    const { sketch } = animatedSketch(undefined);
    const sampled: number[] = [];
    const frameAwareSource: ToneSource = {
      toneField: createToneField(([x]) => {
        sampled.push(x);
        return x / 200;
      }),
      shadingMask: createShadingMask(() => 1),
    };
    const toneState = {
      kind: "tone-reference" as const,
      source: frameAwareSource,
    };

    mount(
      <LiveCanvas
        sketch={sketch}
        params={{}}
        seed={1}
        compositionFrame={{ width: 100, height: 100 }}
        renderState={toneState}
      />,
    );
    expect(sampled.at(-1)).toBe(50);

    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={{}}
          seed={1}
          compositionFrame={{ width: 200, height: 200 }}
          renderState={toneState}
        />,
      );
    });
    expect(sampled.at(-1)).toBe(100);

    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={{}}
          seed={1}
          compositionFrame={{ width: 200, height: 200 }}
          renderState={{ kind: "tone-reference", source: toneSource(0) }}
        />,
      );
    });
    expect([...images.at(-1)!]).toEqual([255, 255, 255, 255]);
  });

  it("does not re-sample an unchanged source for unrelated artwork inputs", () => {
    const { ctx, counts } = pixelRecordingContext();
    useRecordingContext(ctx);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(
      { width: 2, height: 1 } as DOMRect,
    );
    const { sketch } = animatedSketch(undefined);
    const sample = vi.fn(() => 0.5);
    const source: ToneSource = {
      toneField: createToneField(sample),
      shadingMask: createShadingMask(() => 1),
    };

    mount(
      <LiveCanvas
        sketch={sketch}
        params={{ value: 1 }}
        seed={1}
        inputRevision={1}
        renderState={{ kind: "tone-reference", source }}
      />,
    );
    expect(sample).toHaveBeenCalledTimes(2);
    expect(counts.putImageData).toBe(1);

    act(() => {
      root!.render(
        <LiveCanvas
          sketch={sketch}
          params={{ value: 2 }}
          seed={2}
          inputRevision={2}
          renderState={{ kind: "tone-reference", source }}
        />,
      );
    });

    expect(sample).toHaveBeenCalledTimes(2);
    expect(counts.putImageData).toBe(1);
  });

  it("re-samples at the new backing resolution after a box resize", () => {
    const { ctx, images } = pixelRecordingContext();
    useRecordingContext(ctx);
    let width = 2;
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width, height: 1 }) as DOMRect,
    );
    const { sketch, generate } = animatedSketch(undefined);
    const sample = vi.fn(() => 0.5);
    const source: ToneSource = {
      toneField: createToneField(sample),
      shadingMask: createShadingMask(() => 1),
    };
    const el = mount(
      <LiveCanvas
        sketch={sketch}
        params={{}}
        seed={1}
        renderState={{ kind: "tone-reference", source }}
      />,
    );
    expect(sample).toHaveBeenCalledTimes(2);

    width = 4;
    act(() => fireResizeObserver?.());

    expect(canvasEl(el).width).toBe(4);
    expect(sample).toHaveBeenCalledTimes(6);
    expect(images.at(-1)).toHaveLength(16);
    expect(generate).not.toHaveBeenCalled();
  });

  it("suspends and resumes artwork without mutating the selected time", () => {
    const { ctx } = pixelRecordingContext();
    useRecordingContext(ctx);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(
      { width: 1, height: 1 } as DOMRect,
    );
    const { sketch, generate } = animatedSketch({ duration: 10, mode: "loop" });
    const handle = createRef<LiveCanvasHandle>();
    const params = {};
    mount(
      <LiveCanvas handleRef={handle} sketch={sketch} params={params} seed={1} />,
    );
    tick(2000);

    act(() => {
      root!.render(
        <LiveCanvas
          handleRef={handle}
          sketch={sketch}
          params={params}
          seed={1}
          renderState={{ kind: "tone-reference", source: toneSource(0.5) }}
        />,
      );
    });
    const drawsBeforeSuspension = generate.mock.calls.length;
    expect(handle.current?.getCurrentT()).toBe(2);
    tick(8000);
    expect(handle.current?.getCurrentT()).toBe(2);
    expect(generate).toHaveBeenCalledTimes(drawsBeforeSuspension);

    act(() => {
      root!.render(
        <LiveCanvas
          handleRef={handle}
          sketch={sketch}
          params={params}
          seed={1}
          renderState={{ kind: "fill-live" }}
        />,
      );
    });
    tick(8500);
    expect(lastDrawnT(generate)).toBeCloseTo(2.5, 5);
  });
});
