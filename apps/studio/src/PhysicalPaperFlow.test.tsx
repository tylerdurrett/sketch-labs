// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clipSceneToBounds,
  leafField,
  resolvePlotCompositionFrame,
  type CoordinateSpace,
  type Params,
  type PlotProfile,
  type Preset,
  type Scene,
  type Seed,
  type Sketch,
} from "@harness/core";
import leafFieldNice1 from "../../../packages/core/src/sketches/leaf-field/presets/nice1.json";

import { SketchControls } from "./SketchControls";

const previewCapture = vi.hoisted(() => ({
  paints: [] as Array<{ scene: unknown; width: number; height: number }>,
  plotterExport: null as null | {
    scene: Scene;
    profile: PlotProfile;
    metadata: string | undefined;
    options: { includePaperMargins?: boolean } | undefined;
  },
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
    renderPlotterSVG: (
      ...args: Parameters<typeof actual.renderPlotterSVG>
    ): ReturnType<typeof actual.renderPlotterSVG> => {
      previewCapture.plotterExport = {
        scene: args[0],
        profile: args[1],
        metadata: args[2],
        options: args[3],
      };
      return actual.renderPlotterSVG(...args);
    },
  };
});

const presetClient = vi.hoisted(() => ({
  list: vi.fn<[], Promise<string[]>>(),
  load: vi.fn<[string, string], Promise<Preset>>(),
  save: vi.fn<[Preset], Promise<void>>(),
}));

vi.mock("./presetsClient", () => ({
  listPresets: () => presetClient.list(),
  loadPreset: (sketchId: string, name: string) =>
    presetClient.load(sketchId, name),
  savePreset: (preset: Preset) => presetClient.save(preset),
}));

vi.mock("./hiddenLineCoordinator", async () => {
  const { outlineScene } = await import("./outlineScene");
  const { clipSceneToBounds, renderPlotterSVG } = await import("@harness/core");
  return {
    HiddenLineCoordinator: class {
      start(identity: import("./outlineComputeProtocol").OutlineComputeIdentity) {
        if (identity.sourceKind !== "legacy-scene") {
          throw new Error("PhysicalPaperFlow uses only legacy Scene identities");
        }
        return {
          then(resolve: (result: unknown) => void) {
            resolve({
              status: "success",
              jobId: 1,
              identity,
              scene: outlineScene(
                identity.sourceScene as Scene,
                identity.tolerance,
                identity.includeFrame,
              ),
            });
            return Promise.resolve();
          },
        };
      }
      startExport(
        snapshot: import("./outlineComputeProtocol").HiddenLineExportSnapshot,
      ) {
        if (snapshot.identity.sourceKind !== "legacy-scene") {
          throw new Error("PhysicalPaperFlow uses only legacy Scene identities");
        }
        const scene = outlineScene(
          snapshot.identity.sourceScene as Scene,
          snapshot.identity.tolerance,
          snapshot.identity.includeFrame,
        );
        const payload = {
          status: "success" as const,
          jobId: 1,
          identity: snapshot.identity,
          svg: renderPlotterSVG(
            clipSceneToBounds(scene),
            snapshot.profile as PlotProfile,
            snapshot.metadata,
            { includePaperMargins: snapshot.includePaperMargins },
          ),
          filename: snapshot.filename,
          completedOutline: { identity: snapshot.identity, scene },
        };
        return {
          then(resolve: (result: typeof payload) => void) {
            resolve(payload);
            return { catch() {} };
          },
        };
      }
      cancel() {
        return false;
      }
      dispose() {}
    },
  };
});

const downloadBlob = vi.hoisted(() => vi.fn<[Blob, string], void>());
vi.mock("./downloadBlob", () => ({ downloadBlob }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const A4_PROFILE: PlotProfile = {
  width: 210,
  height: 297,
  insets: { top: 10, right: 10, bottom: 10, left: 10 },
  includeFrame: false,
};

const SCALED_A4_PROFILE: PlotProfile = {
  width: A4_PROFILE.width * 1.2,
  height: A4_PROFILE.height * 1.2,
  insets: {
    top: A4_PROFILE.insets.top * 1.2,
    right: A4_PROFILE.insets.right * 1.2,
    bottom: A4_PROFILE.insets.bottom * 1.2,
    left: A4_PROFILE.insets.left * 1.2,
  },
  includeFrame: false,
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
  previewCapture.plotterExport = null;
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
      includeFrame: false,
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

  it("reloads controls, geometry, and preview together, then preserves exact Outline Scene geometry across a proportional non-square resize", async () => {
    const { sketch, generate } = testSketch(A4_PROFILE);
    const preset: Preset = {
      version: 2,
      sketch: sketch.id,
      name: "paper",
      seed: 7,
      params: { radius: 42 },
      locks: [],
      profile: A4_PROFILE,
    };
    presetClient.list.mockResolvedValue(["paper"]);
    presetClient.load.mockResolvedValue(preset);
    const el = mount(sketch);
    await flushPromises();

    selectValue(
      el.querySelector<HTMLSelectElement>('select[aria-label="saved presets"]')!,
      "paper",
    );
    clickButton(el, "Reload");
    await flushPromises();

    const expectedFrame = resolvePlotCompositionFrame(A4_PROFILE);
    expect(el.querySelector<HTMLInputElement>("#control-radius")?.value).toBe(
      "42",
    );
    expect(el.querySelector<HTMLInputElement>("#sketch-seed")?.value).toBe("7");
    expect(el.querySelector("details summary")?.textContent).toContain(
      "210 × 297 mm",
    );
    expect(generate).toHaveBeenLastCalledWith({ radius: 42 }, 7, 0, expectedFrame);
    expect(
      el
        .querySelector<HTMLElement>(".plot-sheet")
        ?.style.getPropertyValue("--plot-inset-top"),
    ).toBe(`${(10 / 297) * 100}%`);
    expect(
      el
        .querySelector<HTMLElement>("canvas")
        ?.style.getPropertyValue("--paper-aspect"),
    ).toBe(String(expectedFrame.width / expectedFrame.height));

    clickButton(el, "Fill");
    flushRaf();
    const callsAfterOutline = generate.mock.calls.length;
    const cachedOutline = previewCapture.paints.at(-1)!.scene;
    const exactGeometry = structuredClone(cachedOutline);
    const originalFrame = generate.mock.calls.at(-1)![3];

    // Reload the same Scene axes with every physical dimension/inset scaled 1.2×.
    // Its raw drawable quotient differs by one ULP, but its composition does not.
    presetClient.load.mockResolvedValue({
      ...preset,
      profile: SCALED_A4_PROFILE,
    });
    clickButton(el, "Reload");
    await flushPromises();
    expect(el.querySelector("details summary")?.textContent).toContain(
      "252 × 356.4 mm",
    );
    expect(generate).toHaveBeenCalledTimes(callsAfterOutline);
    expect(
      el.querySelector<HTMLButtonElement>(
        'button[aria-label="Toggle outline render mode"]',
      )?.textContent,
    ).toBe("Outline");

    // The changed physical sheet can resize the drawable backing box, but it
    // repaints the exact cached processed Scene rather than regenerating it.
    canvasBoxSize = 80;
    act(() => fireResizeObserver?.());

    const repainted = previewCapture.paints.at(-1)!;
    expect(repainted.width).toBe(80);
    expect(repainted.height).toBe(80);
    expect(repainted.scene).toBe(cachedOutline);
    expect(repainted.scene).toEqual(exactGeometry);
    expect(generate).toHaveBeenCalledTimes(callsAfterOutline);

    // A vector export re-bakes intentionally, and proves the memoized shared
    // frame itself retained identity across the one-ULP profile quotient noise.
    clickButton(el, "Export SVG");
    expect(generate.mock.calls.at(-1)![3]).toBe(originalFrame);
  });

  it("keeps PNG usable while an aspect-changing Outline job holds the prior Fill", async () => {
    const { sketch, generate } = testSketch(A4_PROFILE);
    const el = mount(sketch);
    await flushPromises();
    clickButton(el, "Fill");
    flushRaf();
    const callsBeforeEdit = generate.mock.calls.length;

    setInput(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Paper width (mm)"]',
      )!,
      "220",
    );
    const pngButton = [...el.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Export PNG",
    )!;

    // Ordinary snapshots remain available; only competing hidden-line actions
    // are excluded by the one-slot coordinator.
    expect(pngButton.disabled).toBe(false);
    expect(
      el.querySelector<HTMLButtonElement>(
        'button[aria-label="Toggle outline render mode"]',
      )?.textContent,
    ).toBe("Outline");
    act(() => pngButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(pngSnapshotCount).toBe(1);
    expect(generate.mock.calls.length).toBeGreaterThan(callsBeforeEdit);

    flushRaf();
    expect(generate.mock.calls.length).toBeGreaterThan(callsBeforeEdit);
    expect(pngButton.disabled).toBe(false);
    clickButton(el, "Export PNG");
    expect(pngSnapshotCount).toBe(2);
  });
});

describe("physical plot artifact acceptance flow (#276)", () => {
  it("keeps a saved Leaf Field palette in Fill while frame on/off produces matching monochrome, path-only plot output", async () => {
    const profile: PlotProfile = {
      width: 240,
      height: 180,
      insets: { top: 11, right: 23, bottom: 17, left: 29 },
      includeFrame: true,
    };
    const preset: Preset = {
      version: 2,
      sketch: leafFieldNice1.sketch,
      name: leafFieldNice1.name,
      seed: leafFieldNice1.seed as Seed,
      params: leafFieldNice1.params,
      locks: leafFieldNice1.locks,
      profile,
    };
    presetClient.list.mockResolvedValue([preset.name]);
    presetClient.load.mockResolvedValue(preset);

    const el = mount(leafField);
    await flushPromises();
    selectValue(
      el.querySelector<HTMLSelectElement>('select[aria-label="saved presets"]')!,
      preset.name,
    );
    clickButton(el, "Reload");
    await flushPromises();

    // The real on-disk preset remains an authored-color Fill scene even though
    // Leaf Field's current schema defaults are plot-first black and white.
    for (const [key, color] of Object.entries({
      backgroundColor: "#878787",
      discColor: "#ffffff",
      discStrokeColor: "#ffffff",
      leafColor: "#1a1a1a",
      leafStrokeColor: "#f4f1ea",
    })) {
      expect(
        el.querySelector<HTMLButtonElement>(
          `button[aria-label="${key} current color ${color}"]`,
        ),
      ).not.toBeNull();
    }
    const fillScene = previewCapture.paints.at(-1)!.scene as Scene;
    expect(fillScene.background).toEqual({ color: "#878787" });
    expect(
      new Set(
        fillScene.primitives
          .flatMap((primitive) => [
            primitive.fill?.color,
            primitive.stroke?.color,
          ])
          .filter((color): color is string => color !== undefined),
      ),
    ).toEqual(new Set(["#ffffff", "#1a1a1a", "#f4f1ea"]));

    clickButton(el, "Fill");
    flushRaf();
    const enabledPreview = previewCapture.paints.at(-1)!.scene as Scene;
    expect(enabledPreview).not.toHaveProperty("background");
    expect(
      enabledPreview.primitives.every(
        (primitive) =>
          primitive.fill === undefined && primitive.stroke?.color === "black",
      ),
    ).toBe(true);

    clickButton(el, "Export Hidden-line SVG");
    const enabledExportScene = previewCapture.plotterExport!.scene;
    // Canvas clipping is implicit in preview pixels and explicit for exported
    // vectors; after that boundary step the geometry and styling are identical.
    expect(enabledExportScene).toEqual(clipSceneToBounds(enabledPreview));
    expect(previewCapture.plotterExport?.profile).toEqual(profile);
    const enabledSvg = await downloadBlob.mock.calls.at(-1)![0].text();
    const enabledDocument = new DOMParser().parseFromString(
      enabledSvg,
      "image/svg+xml",
    );
    const enabledRoot = enabledDocument.documentElement;
    const enabledPaths = [...enabledRoot.querySelectorAll(":scope > path")];
    expect(enabledRoot.getAttribute("width")).toBe("240mm");
    expect(enabledRoot.getAttribute("height")).toBe("180mm");
    expect(enabledRoot.getAttribute("viewBox")).toBe("0 0 240 180");
    expect(enabledRoot.getAttribute("data-paper-extent")).toBe("paper");
    expect(enabledPaths).toHaveLength(enabledExportScene.primitives.length);
    expect(enabledPaths.at(-1)?.getAttribute("d")).toBe(
      "M29 11 L217 11 L217 163 L29 163 L29 11",
    );
    expect(enabledPaths.at(-1)?.getAttribute("d")).not.toContain("M0 0");
    expect(
      JSON.parse(enabledRoot.querySelector("metadata")!.textContent!),
    ).toMatchObject({ profile: { ...profile, includeFrame: true } });

    const marginsCheckbox = [
      ...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].find((input) =>
      input.parentElement?.textContent?.includes(
        "Include paper margins in plotter SVG",
      ),
    )!;
    act(() => marginsCheckbox.click());
    clickButton(el, "Export Hidden-line SVG");

    expect(previewCapture.plotterExport?.options).toEqual({
      includePaperMargins: false,
    });
    expect(previewCapture.plotterExport?.scene).toEqual(enabledExportScene);
    const drawableSvg = await downloadBlob.mock.calls.at(-1)![0].text();
    const drawableDocument = new DOMParser().parseFromString(
      drawableSvg,
      "image/svg+xml",
    );
    const drawableRoot = drawableDocument.documentElement;
    const drawablePaths = [...drawableRoot.querySelectorAll(":scope > path")];
    expect(drawableRoot.getAttribute("width")).toBe("188mm");
    expect(drawableRoot.getAttribute("height")).toBe("152mm");
    expect(drawableRoot.getAttribute("viewBox")).toBe("0 0 188 152");
    expect(drawableRoot.getAttribute("data-paper-extent")).toBe("drawable");
    expect(drawablePaths).toHaveLength(enabledPaths.length);
    expect(drawablePaths.at(-1)?.getAttribute("d")).toBe(
      "M0 0 L188 0 L188 152 L0 152 L0 0",
    );
    for (const [index, paperPath] of enabledPaths.entries()) {
      const drawablePath = drawablePaths[index]!;
      const coordinates = (path: Element) => [
        ...path
          .getAttribute("d")!
          .matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g),
      ].map((match) => [Number(match[1]), Number(match[2])] as const);
      const paperCoordinates = coordinates(paperPath);
      const drawableCoordinates = coordinates(drawablePath);
      expect(drawableCoordinates).toEqual(
        paperCoordinates.map(([x, y]) => [
          Number((x - 29).toFixed(4)),
          Number((y - 11).toFixed(4)),
        ]),
      );
      expect(drawablePath.getAttribute("stroke")).toBe(
        paperPath.getAttribute("stroke"),
      );
      expect(drawablePath.getAttribute("stroke-width")).toBe(
        paperPath.getAttribute("stroke-width"),
      );
    }
    expect(drawableRoot.querySelector("metadata")?.textContent).toBe(
      enabledRoot.querySelector("metadata")?.textContent,
    );

    // Restore paper extent before exercising the independent frame preference.
    act(() => marginsCheckbox.click());

    const frameCheckbox = [
      ...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].find((input) =>
      input.parentElement?.textContent?.includes("Include composition frame"),
    )!;
    act(() => frameCheckbox.click());
    flushRaf();
    const disabledPreview = previewCapture.paints.at(-1)!.scene as Scene;
    expect(disabledPreview.primitives).toEqual(
      enabledPreview.primitives.slice(0, -1),
    );

    clickButton(el, "Export Hidden-line SVG");
    const disabledExportScene = previewCapture.plotterExport!.scene;
    expect(disabledExportScene).toEqual(clipSceneToBounds(disabledPreview));
    const disabledSvg = await downloadBlob.mock.calls.at(-1)![0].text();
    const disabledDocument = new DOMParser().parseFromString(
      disabledSvg,
      "image/svg+xml",
    );
    const disabledRoot = disabledDocument.documentElement;
    const disabledPaths = [...disabledRoot.querySelectorAll(":scope > path")];
    expect(disabledPaths).toHaveLength(enabledPaths.length - 1);
    expect(disabledPaths.map((path) => path.outerHTML)).toEqual(
      enabledPaths.slice(0, -1).map((path) => path.outerHTML),
    );
    expect(
      JSON.parse(disabledRoot.querySelector("metadata")!.textContent!),
    ).toMatchObject({ profile: { ...profile, includeFrame: false } });

    for (const root of [enabledRoot, disabledRoot]) {
      expect(
        root.querySelector(
          "rect, polygon, polyline, line, g, circle, ellipse, image",
        ),
      ).toBeNull();
      expect(
        [...root.children].every(
          (child) => child.tagName === "metadata" || child.tagName === "path",
        ),
      ).toBe(true);
      for (const path of root.querySelectorAll(":scope > path")) {
        expect(path.getAttribute("fill")).toBe("none");
        expect(path.getAttribute("stroke")).toBe("black");
        expect(path.getAttribute("d")).not.toMatch(/[zZ]/);
      }
    }

    // Every unbroken contour that returns to its origin in the shared preview
    // remains explicitly closed by an L coordinate in the serialized artifact.
    const completeContours = disabledExportScene.primitives
      .map((primitive, index) => ({ primitive, path: disabledPaths[index]! }))
      .filter(({ primitive }) => {
        const first = primitive.points[0];
        const last = primitive.points.at(-1);
        return (
          first !== undefined &&
          last !== undefined &&
          first[0] === last[0] &&
          first[1] === last[1]
        );
      });
    expect(completeContours.length).toBeGreaterThan(0);
    for (const { path } of completeContours) {
      const coordinates = [
        ...path
          .getAttribute("d")!
          .matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g),
      ].map((match) => [match[1], match[2]]);
      expect(coordinates.at(-1)).toEqual(coordinates[0]);
    }
  }, 60_000);
});
