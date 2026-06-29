// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ParamSchema, Seed } from "@harness/core";

import { SketchControls } from "./SketchControls";

// LiveCanvas is a browser-only sink (canvas2d, ResizeObserver, matchMedia) and
// is NOT under test here — these are wiring tests for the control state. Replace
// it with a probe that surfaces the `seed` it is fed into the DOM, so we can
// assert the seed the canvas receives without polyfilling the whole canvas
// stack. The seed feeding the canvas IS the wiring we care about.
vi.mock("./LiveCanvas", () => ({
  LiveCanvas: ({ seed }: { seed: Seed }) => (
    <div data-testid="canvas-seed">{String(seed)}</div>
  ),
}));

/**
 * These are WIRING tests, not roll tests. The determinism / independence /
 * exclusion LOGIC lives in core's `randomize` / `newSeed` and is unit-tested in
 * #48. Here we only prove the Studio threads its React state (params, seed,
 * locks) into those engine calls and back onto the controls/canvas:
 *   - New seed reshuffles the seed while leaving every param value identical.
 *   - Randomize re-rolls params but never touches a locked param.
 *   - A locked control's input stays enabled (lock is exclusion, not disable).
 *   - Editing the seed box updates the seed the canvas is fed.
 *
 * `Math.random` is stubbed per-test so the rolled values are deterministic and
 * the assertions are exact — without re-testing the rolls themselves.
 */

// React 19's `act` requires this flag; vitest's jsdom env does not set it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const numberSpec = (over: Record<string, unknown> = {}) =>
  ({ kind: "number", min: 0, max: 100, default: 50, ...over }) as const;

const sketchWith = (id: string, schema: ParamSchema) =>
  ({
    id,
    name: id,
    schema,
    generate: () => ({ space: { width: 100, height: 100 }, strokes: [] }),
  }) as unknown as Parameters<typeof SketchControls>[0]["sketch"];

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

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

/** The number input for a given param key (the source of truth for its value). */
function paramInput(el: HTMLElement, key: string): HTMLInputElement {
  const input = el.querySelector<HTMLInputElement>(`#control-${key}`);
  if (input === null) throw new Error(`no input for param ${key}`);
  return input;
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

describe("SketchControls — seed axis wiring", () => {
  it("New seed reshuffles the seed while leaving every param value identical", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          radius: numberSpec({ default: 10 }),
          count: numberSpec({ default: 5, integer: true }),
        })}
      />,
    );

    const seedBefore = (
      el.querySelector("#sketch-seed") as HTMLInputElement
    ).value;
    const radiusBefore = paramInput(el, "radius").value;
    const countBefore = paramInput(el, "count").value;

    // Force the engine's newSeed to land somewhere new and deterministic.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    clickButton(el, "New seed");

    const seedAfter = (
      el.querySelector("#sketch-seed") as HTMLInputElement
    ).value;
    // The seed changed (new arrangement)...
    expect(seedAfter).not.toBe(seedBefore);
    expect(seedAfter).toBe(String(Math.floor(0.5 * Number.MAX_SAFE_INTEGER)));
    // ...while NOT a single param value moved (independent axis).
    expect(paramInput(el, "radius").value).toBe(radiusBefore);
    expect(paramInput(el, "count").value).toBe(countBefore);
  });

  it("editing the seed box updates the seed (the value the canvas is fed)", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const seedInput = el.querySelector("#sketch-seed") as HTMLInputElement;

    act(() => {
      // Set the value and fire a React-observed change.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(seedInput, "12345");
      seedInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // The seed box reflects the edit — it is the plain, copyable seed value...
    expect((el.querySelector("#sketch-seed") as HTMLInputElement).value).toBe(
      "12345",
    );
    // ...and that exact value is what SketchControls feeds the canvas (the probe
    // surfaces the `seed` prop LiveCanvas received), so editing re-renders it.
    expect(el.querySelector('[data-testid="canvas-seed"]')?.textContent).toBe(
      "12345",
    );
    // No param value was touched by a seed edit.
    expect(paramInput(el, "radius").value).toBe("10");
  });
});

describe("SketchControls — randomize / lock wiring", () => {
  it("Randomize rolls unlocked params but never touches a locked param", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          radius: numberSpec({ min: 0, max: 100, default: 10 }),
          count: numberSpec({ min: 0, max: 100, default: 5, integer: true }),
        })}
      />,
    );

    // Lock `radius` via its toggle, then Randomize. With a stubbed source the
    // unlocked `count` rolls to a known value; `radius` must pass through.
    const lockRadius = el.querySelector(
      'button[aria-label="radius lock"]',
    ) as HTMLButtonElement;
    act(() => {
      lockRadius.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(lockRadius.getAttribute("aria-pressed")).toBe("true");

    vi.spyOn(Math, "random").mockReturnValue(0.5);
    clickButton(el, "Randomize");

    // Locked radius is excluded from the roll — still its pre-roll value.
    expect(paramInput(el, "radius").value).toBe("10");
    // Unlocked count rolled: 0 + 0.5*(100-0) = 50, rounded (integer) = 50.
    expect(paramInput(el, "count").value).toBe("50");
  });

  it("a locked param stays hand-editable (lock excludes from roll, never disables)", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );

    const lockRadius = el.querySelector(
      'button[aria-label="radius lock"]',
    ) as HTMLButtonElement;
    act(() => {
      lockRadius.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(lockRadius.getAttribute("aria-pressed")).toBe("true");

    const input = paramInput(el, "radius");
    // The control is NOT disabled by the lock...
    expect(input.disabled).toBe(false);

    // ...and a hand edit still commits while locked.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "42");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(paramInput(el, "radius").value).toBe("42");
  });
});
