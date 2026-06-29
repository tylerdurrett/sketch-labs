// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ParamSchema, Preset, Seed } from "@harness/core";

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

// The Preset network client is the seam under test for the save/reload wiring:
// stub its three calls so nothing hits `fetch`, and so a test can drive a Reload
// with a Preset of its choosing and capture exactly what a Save serialized.
const listPresets = vi.fn<[string], Promise<string[]>>();
const loadPreset = vi.fn<[string, string], Promise<Preset>>();
const savePreset = vi.fn<[Preset], Promise<void>>();
vi.mock("./presetsClient", () => ({
  // isValidName must stay REAL so the name field validates as in production.
  isValidName: (name: string) => /^[a-z0-9][a-z0-9_-]*$/.test(name),
  listPresets: (id: string) => listPresets(id),
  loadPreset: (id: string, name: string) => loadPreset(id, name),
  savePreset: (preset: Preset) => savePreset(preset),
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

beforeEach(() => {
  // Sensible defaults so a mount's list-on-mount effect resolves quietly; the
  // save/reload tests override loadPreset/savePreset per case.
  listPresets.mockResolvedValue([]);
  loadPreset.mockReset();
  savePreset.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** Flush pending microtasks (resolved client promises) inside React's `act`. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Set a text input's value and fire the React-observed `input` event. */
function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

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

describe("SketchControls — preset save/reload wiring", () => {
  const schema: ParamSchema = {
    radius: numberSpec({ min: 0, max: 100, default: 10 }),
    count: numberSpec({ min: 0, max: 100, default: 5, integer: true }),
  };

  it("reloading a preset hydrates params, seed, AND locks-as-a-Set", async () => {
    // A preset whose values differ from the schema defaults and that locks one
    // key, so each axis hydrating is observable.
    loadPreset.mockResolvedValue({
      version: 1,
      sketch: "a",
      name: "warm",
      seed: 999,
      params: { radius: 77, count: 88 },
      locks: ["radius"],
    });
    listPresets.mockResolvedValue(["warm"]);

    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush(); // list-on-mount populates the picker

    // Pick "warm" and Reload.
    const picker = el.querySelector(
      'select[aria-label="saved presets"]',
    ) as HTMLSelectElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(picker, "warm");
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(loadPreset).not.toHaveBeenCalled(); // not until Reload is clicked
    clickButton(el, "Reload");
    await flush();

    expect(loadPreset).toHaveBeenCalledWith("a", "warm");
    // params hydrated exactly (loaded AS-IS, unclamped through applyPreset)...
    expect(paramInput(el, "radius").value).toBe("77");
    expect(paramInput(el, "count").value).toBe("88");
    // ...seed hydrated (the value the canvas is fed)...
    expect(el.querySelector('[data-testid="canvas-seed"]')?.textContent).toBe(
      "999",
    );
    // ...and the locks array rehydrated as a Set — the locked key's toggle is
    // pressed, the unlocked one is not (this IS the array→Set glue under test).
    expect(
      el
        .querySelector('button[aria-label="radius lock"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      el
        .querySelector('button[aria-label="count lock"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("saving serializes the live params, seed, and locks under the sketch id", async () => {
    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush();

    // Lock `radius`, edit `count`, edit the seed — the live state a Save captures.
    act(() => {
      el.querySelector('button[aria-label="radius lock"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    setInput(paramInput(el, "count"), "33");
    setInput(el.querySelector("#sketch-seed") as HTMLInputElement, "4242");

    // Type a valid slug name, then Save.
    setInput(
      el.querySelector('input[aria-label="preset name"]') as HTMLInputElement,
      "warm",
    );
    clickButton(el, "Save");
    await flush();

    expect(savePreset).toHaveBeenCalledTimes(1);
    expect(savePreset.mock.calls[0]?.[0]).toEqual({
      version: 1,
      sketch: "a",
      name: "warm",
      seed: 4242,
      params: { radius: 10, count: 33 },
      locks: ["radius"],
    });
  });

  it("rejects an invalid (non-slug) name inline and does not save", async () => {
    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush();

    setInput(
      el.querySelector('input[aria-label="preset name"]') as HTMLInputElement,
      "Not A Slug",
    );
    // Inline hint shown; Save is disabled and clicking it is a no-op.
    expect(el.querySelector(".preset-controls__hint")).not.toBeNull();
    const save = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Save",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    clickButton(el, "Save");
    await flush();
    expect(savePreset).not.toHaveBeenCalled();
  });
});
