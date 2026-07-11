// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolvePlotCompositionFrame,
  type CoordinateSpace,
  type Params,
  type PlotProfile,
  type Preset,
  type Scene,
  type Seed,
  type Sketch,
} from "@harness/core";

import { SketchControls } from "./SketchControls";

const previewCapture = vi.hoisted(() => ({
  paints: [] as Array<{ scene: unknown; width: number; height: number }>,
}));

vi.mock("@harness/core", async (importActual) => {
  const actual = await importActual<typeof import("@harness/core")>();
  return {
    ...actual,
    drawSceneFitted: (
      _ctx: unknown,
      scene: unknown,
      width: number,
      height: number,
    ) => previewCapture.paints.push({ scene, width, height }),
  };
});

const presetClient = vi.hoisted(() => ({
  list: vi.fn<[], Promise<string[]>>(),
  load: vi.fn<[string, string], Promise<Preset>>(),
  save: vi.fn<[Preset], Promise<void>>(),
}));

vi.mock("./presetsClient", () => ({
  isValidName: (name: string) => /^[a-z0-9][a-z0-9_-]*$/.test(name),
  listPresets: () => presetClient.list(),
  loadPreset: (sketchId: string, name: string) =>
    presetClient.load(sketchId, name),
  savePreset: (preset: Preset) => presetClient.save(preset),
}));

const downloadBlob = vi.hoisted(() => vi.fn<[Blob, string], void>());
vi.mock("./downloadBlob", () => ({ downloadBlob }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const A4_PROFILE: PlotProfile = {
  width: 210,
  height: 297,
  insets: { top: 10, right: 10, bottom: 10, left: 10 },
};

const SQUARE_PROFILE: PlotProfile = {
  width: 200,
  height: 200,
  insets: { top: 10, right: 10, bottom: 10, left: 10 },
};

function testSketch(defaultOutputProfile: PlotProfile) {
  const generate = vi.fn(
    (
      params: Params,
      seed: Seed,
      _t: number,
      frame: CoordinateSpace,
    ): Scene => ({
      space: frame,
      primitives: [
        {
          points: [
            [0, 0],
            [Number(params.radius), 0],
            [Number(params.radius), Number(params.radius)],
            [0, Number(params.radius)],
          ],
          closed: true,
          fill: { color: seed === 7 ? "navy" : "tomato" },
        },
      ],
    }),
  );
  const sketch = {
    id: "paper-flow",
    name: "Paper flow",
    schema: {
      radius: { kind: "number", min: 1, max: 100, default: 10 },
    },
    defaultOutputProfile,
    generate,
  } as unknown as Sketch;
  return { sketch, generate };
}

let container: HTMLDivElement;
let root: Root;
let rafCallbacks = new Map<number, (time: number) => void>();
let nextRafId = 1;
let fireResizeObserver: (() => void) | null = null;
let canvasBoxSize = 100;
let pngCanvas: HTMLCanvasElement | null = null;
let pngSnapshotCount = 0;

function mount(sketch: Sketch): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<SketchControls sketch={sketch} />));
  return container;
}

function flushRaf(): void {
  act(() => {
    for (let generation = 0; generation < 5 && rafCallbacks.size > 0; generation++) {
      const due = [...rafCallbacks.values()];
      rafCallbacks.clear();
      for (const callback of due) callback(0);
    }
  });
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

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

function selectValue(select: HTMLSelectElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function clickButton(el: HTMLElement, text: string): void {
  const button = [...el.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (button === undefined) throw new Error(`no button labelled ${text}`);
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(() => {
  window.localStorage.clear();
  previewCapture.paints = [];
  presetClient.list.mockReset().mockResolvedValue([]);
  presetClient.load.mockReset();
  presetClient.save.mockReset().mockResolvedValue(undefined);
  downloadBlob.mockReset();
  rafCallbacks = new Map();
  nextRafId = 1;
  fireResizeObserver = null;
  canvasBoxSize = 100;
  pngCanvas = null;
  pngSnapshotCount = 0;

  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    const id = nextRafId++;
    rafCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafCallbacks.delete(id);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        fireResizeObserver = () =>
          callback([], this as unknown as ResizeObserver);
      }
      observe(): void {}
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
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockImplementation(
    () => ({ width: canvasBoxSize, height: canvasBoxSize }) as DOMRect,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    function (this: HTMLCanvasElement, callback) {
      pngCanvas = this;
      pngSnapshotCount++;
      callback(null);
    },
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("physical-paper Studio acceptance flow (#248)", () => {
  it("carries standard/custom/unit/orientation/margin authoring through one profile and shared Fill/Outline frame", async () => {
    const { sketch, generate } = testSketch(A4_PROFILE);
    const el = mount(sketch);
    await flushPromises();
    const paper = el.querySelector("details")!;
    const format = paper.querySelector("select")!;

    // Standard → inch-authored Custom → orientation convenience → linked inset.
    selectValue(format, "letter");
    act(() =>
      paper
        .querySelector<HTMLInputElement>('input[type="radio"][value="in"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    setInput(
      paper.querySelector<HTMLInputElement>(
        'input[aria-label="Paper width (in)"]',
      )!,
      "10",
    );
    expect(format.value).toBe("custom");
    clickButton(paper, "Swap to landscape");
    setInput(
      paper.querySelector<HTMLInputElement>(
        'input[aria-label="Linked paper margin (in)"]',
      )!,
      "0.5",
    );

    const expectedProfile: PlotProfile = {
      width: 279.4,
      height: 254,
      insets: { top: 12.7, right: 12.7, bottom: 12.7, left: 12.7 },
    };
    const expectedFrame = resolvePlotCompositionFrame(expectedProfile);
    expect(paper.querySelector("summary")?.textContent).toContain("11 × 10 in");
    expect(generate).toHaveBeenLastCalledWith(
      { radius: 10 },
      expect.any(Number),
      0,
      expectedFrame,
    );

    // Saving observes the same canonical millimeter profile that drove preview.
    setInput(
      el.querySelector<HTMLInputElement>('input[aria-label="preset name"]')!,
      "authored",
    );
    clickButton(el, "Save");
    await flushPromises();
    expect(presetClient.save).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, profile: expectedProfile }),
    );

    const fillScene = previewCapture.paints.at(-1)!.scene as Scene;
    expect(fillScene).toBe(generate.mock.results.at(-1)!.value);
    expect(fillScene.primitives).toHaveLength(1);
    expect(fillScene).not.toHaveProperty("profile");
    expect(el.querySelector(".plot-sheet")).not.toBeNull();
    expect(el.querySelector(".plot-drawable")).not.toBeNull();

    clickButton(el, "Fill");
    flushRaf();
    expect(generate).toHaveBeenLastCalledWith(
      { radius: 10 },
      expect.any(Number),
      0,
      expectedFrame,
    );
    expect(
      el.querySelector<HTMLButtonElement>(
        'button[aria-label="Toggle outline render mode"]',
      )?.textContent,
    ).toBe("Outline");

    // PNG snapshots the sole drawable canvas; paper/margin chrome stays DOM-only.
    clickButton(el, "Export PNG");
    expect(el.querySelectorAll("canvas")).toHaveLength(1);
    expect(pngSnapshotCount).toBe(1);
    expect(pngCanvas).toBe(
      el.querySelector<HTMLCanvasElement>(".plot-drawable > canvas"),
    );
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("reloads controls, geometry, and preview together, then preserves exact Outline Scene geometry across a same-aspect physical resize", async () => {
    const { sketch, generate } = testSketch(A4_PROFILE);
    const preset: Preset = {
      version: 2,
      sketch: sketch.id,
      name: "square",
      seed: 7,
      params: { radius: 42 },
      locks: [],
      profile: SQUARE_PROFILE,
    };
    presetClient.list.mockResolvedValue(["square"]);
    presetClient.load.mockResolvedValue(preset);
    const el = mount(sketch);
    await flushPromises();

    selectValue(
      el.querySelector<HTMLSelectElement>('select[aria-label="saved presets"]')!,
      "square",
    );
    clickButton(el, "Reload");
    await flushPromises();

    const expectedFrame = resolvePlotCompositionFrame(SQUARE_PROFILE);
    expect(el.querySelector<HTMLInputElement>("#control-radius")?.value).toBe(
      "42",
    );
    expect(el.querySelector<HTMLInputElement>("#sketch-seed")?.value).toBe("7");
    expect(el.querySelector("details summary")?.textContent).toContain(
      "200 × 200 mm",
    );
    expect(generate).toHaveBeenLastCalledWith({ radius: 42 }, 7, 0, expectedFrame);
    expect(
      el
        .querySelector<HTMLElement>(".plot-sheet")
        ?.style.getPropertyValue("--plot-inset-top"),
    ).toBe("5%");
    expect(
      el
        .querySelector<HTMLElement>("canvas")
        ?.style.getPropertyValue("--paper-aspect"),
    ).toBe("1");

    clickButton(el, "Fill");
    flushRaf();
    const callsAfterOutline = generate.mock.calls.length;
    const cachedOutline = previewCapture.paints.at(-1)!.scene;
    const exactGeometry = structuredClone(cachedOutline);

    // A linked-inset change alters physical layout but keeps the drawable square.
    setInput(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Linked paper margin (mm)"]',
      )!,
      "20",
    );
    expect(
      el
        .querySelector<HTMLElement>(".plot-sheet")
        ?.style.getPropertyValue("--plot-inset-top"),
    ).toBe("10%");
    canvasBoxSize = 80;
    act(() => fireResizeObserver?.());

    const repainted = previewCapture.paints.at(-1)!;
    expect(repainted.width).toBe(80);
    expect(repainted.height).toBe(80);
    expect(repainted.scene).toBe(cachedOutline);
    expect(repainted.scene).toEqual(exactGeometry);
    expect(generate).toHaveBeenCalledTimes(callsAfterOutline);
    expect(
      el.querySelector<HTMLButtonElement>(
        'button[aria-label="Toggle outline render mode"]',
      )?.textContent,
    ).toBe("Outline");
  });
});
