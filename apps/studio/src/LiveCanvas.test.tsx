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

/** The most recent `t` the Sketch was asked to render (the drawn frame). */
function lastDrawnT(generate: { mock: { calls: unknown[][] } }): number {
  const calls = generate.mock.calls;
  if (calls.length === 0) throw new Error("generate was never called");
  return calls[calls.length - 1]![2] as number;
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
