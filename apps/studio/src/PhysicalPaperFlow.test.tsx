// @vitest-environment jsdom
import { deflateSync, inflateSync } from "node:zlib";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  centeredFixedPageFrame,
  clipSceneToBounds,
  crc32,
  derivePageFramePlotProfile,
  frameScene,
  leafField,
  resolveCompositionFrame,
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
import {
  FIXED_PAGE_PARITY_COMPOSITION,
  FIXED_PAGE_PARITY_FRAME,
  FIXED_PAGE_PARITY_PROFILE,
  fixedPageParityScene,
} from "./fixedPageOutputParity.test-support";

const previewCapture = vi.hoisted(() => ({
  paints: [] as Array<{ scene: unknown; width: number; height: number }>,
  paintThrough: false,
  ordinaryExport: null as null | {
    scene: Scene;
    metadata: string | undefined;
  },
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
      ...args: Parameters<typeof actual.drawSceneFitted>
    ): ReturnType<typeof actual.drawSceneFitted> => {
      const [, scene, width, height] = args;
      previewCapture.paints.push({ scene, width, height });
      if (previewCapture.paintThrough) actual.drawSceneFitted(...args);
    },
    renderToSVG: (
      ...args: Parameters<typeof actual.renderToSVG>
    ): ReturnType<typeof actual.renderToSVG> => {
      previewCapture.ordinaryExport = {
        scene: args[0],
        metadata: args[1],
      };
      return actual.renderToSVG(...args);
    },
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
  const { finalizeOutlineScene, outlineScene } = await import("./outlineScene");
  const { clipSceneToBounds, computePlotMapping, renderPlotterSVG } =
    await import("@harness/core");
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
        const scene = finalizeOutlineScene(
          outlineScene(
            snapshot.identity.sourceScene as Scene,
            snapshot.identity.tolerance,
          ),
          snapshot.pageFrame,
          snapshot.profile.includeFrame,
          {
            kind: "legacy-scene",
            target: {
              toolWidthMillimeters: snapshot.profile.toolWidthMillimeters,
              millimetersPerSceneUnit: computePlotMapping(
                snapshot.pageFrame ?? snapshot.identity.compositionFrame,
                snapshot.profile as PlotProfile,
              ).scale,
            },
          },
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
          completedOutline: {
            identity: snapshot.identity,
            scene: outlineScene(
              snapshot.identity.sourceScene as Scene,
              snapshot.identity.tolerance,
            ),
          },
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
  toolWidthMillimeters: 0.3,
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
  toolWidthMillimeters: 0.3,
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

type Rgba = readonly [number, number, number, number];

interface RasterSurface {
  width: number;
  height: number;
  pixels: Uint8Array;
}

const rasterSurfaces = new WeakMap<HTMLCanvasElement, RasterSurface>();

function rgba(color: string): Rgba {
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return [
      Number.parseInt(color.slice(1, 3), 16),
      Number.parseInt(color.slice(3, 5), 16),
      Number.parseInt(color.slice(5, 7), 16),
      255,
    ];
  }
  if (color === "white") return [255, 255, 255, 255];
  if (color === "black") return [0, 0, 0, 255];
  throw new Error(`unsupported raster-test color ${color}`);
}

function rasterContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  let transform: readonly [number, number, number, number, number, number] = [
    1, 0, 0, 1, 0, 0,
  ];
  let path: Array<readonly [number, number]> = [];
  let pathStart: readonly [number, number] | null = null;
  const stack: Array<{
    transform: typeof transform;
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
  }> = [];

  const surface = (): RasterSurface => {
    const current = rasterSurfaces.get(canvas);
    if (
      current !== undefined &&
      current.width === canvas.width &&
      current.height === canvas.height
    ) {
      return current;
    }
    const created = {
      width: canvas.width,
      height: canvas.height,
      pixels: new Uint8Array(canvas.width * canvas.height * 4),
    };
    rasterSurfaces.set(canvas, created);
    return created;
  };
  const point = (x: number, y: number): readonly [number, number] => [
    transform[0] * x + transform[2] * y + transform[4],
    transform[1] * x + transform[3] * y + transform[5],
  ];
  const paintPixel = (x: number, y: number, color: Rgba): void => {
    const target = surface();
    if (x < 0 || y < 0 || x >= target.width || y >= target.height) return;
    const offset = (y * target.width + x) * 4;
    target.pixels.set(color, offset);
  };
  const context = {
    fillStyle: "black",
    strokeStyle: "black",
    lineWidth: 1,
    save() {
      stack.push({
        transform,
        fillStyle: context.fillStyle,
        strokeStyle: context.strokeStyle,
        lineWidth: context.lineWidth,
      });
    },
    restore() {
      const saved = stack.pop();
      if (saved === undefined) return;
      transform = saved.transform;
      context.fillStyle = saved.fillStyle;
      context.strokeStyle = saved.strokeStyle;
      context.lineWidth = saved.lineWidth;
    },
    beginPath() {
      path = [];
      pathStart = null;
    },
    moveTo(x: number, y: number) {
      const transformed = point(x, y);
      path.push(transformed);
      pathStart = transformed;
    },
    lineTo(x: number, y: number) {
      path.push(point(x, y));
    },
    closePath() {
      if (pathStart !== null) path.push(pathStart);
    },
    fill() {},
    stroke() {
      const color = rgba(context.strokeStyle);
      for (let index = 1; index < path.length; index++) {
        const from = path[index - 1]!;
        const to = path[index]!;
        const steps = Math.max(
          1,
          Math.ceil(Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]))),
        );
        for (let step = 0; step <= steps; step++) {
          const amount = step / steps;
          paintPixel(
            Math.round(from[0] + (to[0] - from[0]) * amount),
            Math.round(from[1] + (to[1] - from[1]) * amount),
            color,
          );
        }
      }
    },
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
      transform = [a, b, c, d, e, f];
    },
    fillRect(x: number, y: number, width: number, height: number) {
      const color = rgba(context.fillStyle);
      const from = point(x, y);
      const to = point(x + width, y + height);
      for (let py = Math.floor(from[1]); py < Math.ceil(to[1]); py++) {
        for (let px = Math.floor(from[0]); px < Math.ceil(to[0]); px++) {
          paintPixel(px, py, color);
        }
      }
    },
    clearRect() {
      surface().pixels.fill(0);
    },
  };
  return context as unknown as CanvasRenderingContext2D;
}

function uint32BE(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function pngChunk(type: string, data: Uint8Array): number[] {
  const typeBytes = Uint8Array.from([...type].map((value) => value.charCodeAt(0)));
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes);
  crcInput.set(data, typeBytes.length);
  return [
    ...uint32BE(data.length),
    ...typeBytes,
    ...data,
    ...uint32BE(crc32(crcInput)),
  ];
}

function encodeRasterPng(surface: RasterSurface): Uint8Array {
  const scanlines = new Uint8Array(
    surface.height * (1 + surface.width * 4),
  );
  for (let y = 0; y < surface.height; y++) {
    const row = y * (1 + surface.width * 4);
    scanlines[row] = 0;
    scanlines.set(
      surface.pixels.subarray(y * surface.width * 4, (y + 1) * surface.width * 4),
      row + 1,
    );
  }
  const compressed = deflateSync(scanlines);
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...pngChunk(
      "IHDR",
      Uint8Array.from([
        ...uint32BE(surface.width),
        ...uint32BE(surface.height),
        8,
        6,
        0,
        0,
        0,
      ]),
    ),
    ...pngChunk("IDAT", compressed),
    ...pngChunk("IEND", new Uint8Array()),
  ]);
}

function pngChunks(bytes: Uint8Array): Array<{ type: string; data: Uint8Array }> {
  const chunks: Array<{ type: string; data: Uint8Array }> = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset < bytes.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    chunks.push({ type, data: bytes.slice(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

function decodeRasterPng(bytes: Uint8Array): RasterSurface {
  const chunks = pngChunks(bytes);
  const ihdr = chunks.find(({ type }) => type === "IHDR")!.data;
  const header = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  const width = header.getUint32(0);
  const height = header.getUint32(4);
  const compressed = Uint8Array.from(
    chunks.filter(({ type }) => type === "IDAT").flatMap(({ data }) => [...data]),
  );
  const scanlines = inflateSync(compressed);
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    if (scanlines[row] !== 0) throw new Error("expected unfiltered test PNG row");
    pixels.set(scanlines.subarray(row + 1, row + 1 + width * 4), y * width * 4);
  }
  return { width, height, pixels };
}

function pixel(surface: RasterSurface, x: number, y: number): number[] {
  const offset = (y * surface.width + x) * 4;
  return [...surface.pixels.slice(offset, offset + 4)];
}

let container: HTMLDivElement;
let root: Root;
let rafCallbacks = new Map<number, (time: number) => void>();
let nextRafId = 1;
let fireResizeObserver: (() => void) | null = null;
let canvasBoxSize = 100;
let canvasBox: { width: number; height: number } | null = null;
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
  previewCapture.paintThrough = false;
  previewCapture.ordinaryExport = null;
  previewCapture.plotterExport = null;
  presetClient.list.mockReset().mockResolvedValue([]);
  presetClient.load.mockReset();
  presetClient.save.mockReset().mockResolvedValue(undefined);
  downloadBlob.mockReset();
  rafCallbacks = new Map();
  nextRafId = 1;
  fireResizeObserver = null;
  canvasBoxSize = 100;
  canvasBox = null;
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
    () =>
      ({
        width: canvasBox?.width ?? canvasBoxSize,
        height: canvasBox?.height ?? canvasBoxSize,
      }) as DOMRect,
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
      toolWidthMillimeters: 0.3,
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

  it("downloads the shared fixed Page's exact rendered backing pixels after PNG metadata insertion", async () => {
    previewCapture.paintThrough = true;
    canvasBox = { width: 265, height: 159 };
    let serializedSurface: RasterSurface | null = null;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement, contextId: string) {
        return contextId === "2d" ? rasterContext(this) : null;
      } as HTMLCanvasElement["getContext"],
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      function (this: HTMLCanvasElement, callback, type) {
        pngCanvas = this;
        pngSnapshotCount++;
        const backing = rasterSurfaces.get(this);
        if (backing === undefined) throw new Error("canvas was not painted");
        serializedSurface = {
          width: backing.width,
          height: backing.height,
          pixels: backing.pixels.slice(),
        };
        const encoded = encodeRasterPng(serializedSurface);
        callback(
          new Blob([encoded.buffer as ArrayBuffer], {
            type: type ?? "image/png",
          }),
        );
      },
    );
    const source = fixedPageParityScene();
    const generate = vi.fn(() => source);
    const sketch = {
      id: "fixed-page-pixel-parity",
      name: "Fixed Page pixel parity",
      schema: {},
      defaultOutputProfile: FIXED_PAGE_PARITY_PROFILE,
      generate,
    } as unknown as Sketch;
    const el = mount(sketch);
    await flushPromises();

    clickButton(el, "Crop");
    act(() =>
      el
        .querySelector<HTMLInputElement>('input[name="keepPageSizeFixed"]')!
        .click(),
    );
    setInput(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Composition scale percentage"]',
      )!,
      "200",
    );
    setInput(el.querySelector<HTMLInputElement>('input[name="x"]')!, "-10");
    setInput(el.querySelector<HTMLInputElement>('input[name="y"]')!, "25");
    clickButton(el, "Apply");
    flushRaf();

    const expectedScene = frameScene(source, FIXED_PAGE_PARITY_FRAME);
    expect(previewCapture.paints.at(-1)).toEqual({
      scene: expectedScene,
      width: 265,
      height: 159,
    });
    const canvas = el.querySelector<HTMLCanvasElement>("canvas")!;
    expect({ width: canvas.width, height: canvas.height }).toEqual({
      width: 265,
      height: 159,
    });
    const painted = rasterSurfaces.get(canvas)!;
    expect(pixel(painted, 0, 0)).toEqual([244, 239, 230, 255]);
    expect(pixel(painted, 53, 16)).toEqual([18, 52, 86, 255]);
    expect(pixel(painted, 53, 15)).toEqual([244, 239, 230, 255]);

    clickButton(el, "Export PNG");
    await flushPromises();
    await flushPromises();

    expect(pngSnapshotCount).toBe(1);
    expect(pngCanvas).toBe(canvas);
    expect(downloadBlob).toHaveBeenCalledOnce();
    expect(serializedSurface).not.toBeNull();
    const downloadedBlob = downloadBlob.mock.calls[0]![0];
    const downloadedBytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(downloadedBlob);
    });
    const decoded = decodeRasterPng(downloadedBytes);
    expect(decoded).toEqual(serializedSurface);
    expect(pixel(decoded, 0, 0)).toEqual([244, 239, 230, 255]);
    expect(pixel(decoded, 53, 16)).toEqual([18, 52, 86, 255]);
    const metadata = pngChunks(downloadedBytes).find(
      ({ type }) => type === "iTXt",
    );
    expect(new TextDecoder().decode(metadata?.data)).toContain(
      `"pageFrame":{"x":${FIXED_PAGE_PARITY_FRAME.x},"y":${FIXED_PAGE_PARITY_FRAME.y}`,
    );
    expect(generate).toHaveBeenCalledWith(
      {},
      expect.any(Number),
      0,
      FIXED_PAGE_PARITY_COMPOSITION,
    );
  });

  it("keeps framed Fill, PNG, ordinary SVG, and physical paper on one mixed crop/pad output", async () => {
    const { sketch, generate } = testSketch(A4_PROFILE);
    const el = mount(sketch);
    await flushPromises();
    const composition = resolvePlotCompositionFrame(A4_PROFILE);
    const source = generate.mock.results.at(-1)!.value as Scene;
    const callsBeforeFrame = generate.mock.calls.length;

    clickButton(el, "Crop");
    const percentages = { x: 10, y: -20, width: 110, height: 80 };
    for (const [name, value] of Object.entries(percentages)) {
      setInput(
        el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!,
        String(value),
      );
    }
    clickButton(el, "Apply");

    const pageFrame = {
      x: composition.width * 0.1,
      y: composition.height * -0.2,
      width: composition.width * 1.1,
      height: composition.height * 0.8,
    };
    const expectedScene = frameScene(source, pageFrame);
    const expectedProfile = derivePageFramePlotProfile(
      A4_PROFILE,
      { x: 0, y: 0, ...composition },
      pageFrame,
    );

    expect(generate).toHaveBeenCalledTimes(callsBeforeFrame);
    expect(previewCapture.paints.at(-1)!.scene).toEqual(expectedScene);
    expect(previewCapture.paints.at(-1)!.scene).not.toBe(source);
    expect(
      el
        .querySelector<HTMLCanvasElement>("canvas")!
        .style.getPropertyValue("--paper-aspect"),
    ).toBe(String(pageFrame.width / pageFrame.height));
    expect(
      el
        .querySelector<HTMLElement>(".plot-sheet")!
        .style.getPropertyValue("--sheet-aspect"),
    ).toBe(String(expectedProfile.width / expectedProfile.height));
    expect(expectedProfile.insets).toEqual(A4_PROFILE.insets);

    clickButton(el, "Export PNG");
    expect(pngSnapshotCount).toBe(1);
    expect(pngCanvas).toBe(el.querySelector(".plot-drawable > canvas"));
    expect(generate).toHaveBeenCalledTimes(callsBeforeFrame);

    clickButton(el, "Export SVG");
    expect(generate).toHaveBeenCalledTimes(callsBeforeFrame);
    expect(previewCapture.ordinaryExport?.scene).toEqual(expectedScene);
    expect(previewCapture.ordinaryExport?.scene.space).toEqual({
      width: pageFrame.width,
      height: pageFrame.height,
    });
    expect(
      JSON.parse(previewCapture.ordinaryExport!.metadata!).profile,
    ).toEqual(expectedProfile);
    await flushPromises();

    // Re-Apply restores the lock without changing Composition or regenerating.
    const lock = el.querySelector<HTMLInputElement>(
      'input[aria-label="Lock Page aspect"]',
    )!;
    expect(lock.checked).toBe(true);
    act(() => lock.click());
    expect(lock.checked).toBe(false);
    clickButton(el, "Crop");
    clickButton(el, "Apply");
    expect(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Lock Page aspect"]',
      )?.checked,
    ).toBe(true);
    expect(generate).toHaveBeenCalledTimes(callsBeforeFrame);

    // A locked physical resize changes only scale: the frozen Page and generation
    // basis survive, and the Sketch itself is not asked to generate again.
    const generationFrame = generate.mock.calls.at(-1)![3];
    const paperAspect = el
      .querySelector<HTMLCanvasElement>("canvas")!
      .style.getPropertyValue("--paper-aspect");
    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;
    act(() => width.focus());
    setInput(width, String(expectedProfile.width * 1.2));
    act(() => width.blur());
    flushRaf();
    expect(generate).toHaveBeenCalledTimes(callsBeforeFrame);
    expect(
      el
        .querySelector<HTMLCanvasElement>("canvas")!
        .style.getPropertyValue("--paper-aspect"),
    ).toBe(paperAspect);

    // Content changes may regenerate, but every generation stays on the exact
    // frozen Composition object and leaves the committed Page visible.
    const radius = el.querySelector<HTMLInputElement>("#control-radius")!;
    act(() => radius.focus());
    setInput(radius, "25");
    act(() => radius.blur());
    clickButton(el, "New seed");
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    clickButton(el, "Randomize");
    flushRaf();
    expect(generate.mock.calls.length).toBeGreaterThan(callsBeforeFrame);
    for (const call of generate.mock.calls.slice(callsBeforeFrame)) {
      expect(call[3]).toBe(generationFrame);
    }
    expect(
      el
        .querySelector<HTMLCanvasElement>("canvas")!
        .style.getPropertyValue("--paper-aspect"),
    ).toBe(paperAspect);
  });

  it("retains a committed Page and frozen Composition across animated ticks", async () => {
    const base = testSketch(A4_PROFILE);
    const sketch = {
      ...base.sketch,
      time: { duration: 4, mode: "loop" as const },
    } as Sketch;
    const el = mount(sketch);
    await flushPromises();
    flushRaf();
    const generationFrame = base.generate.mock.calls.at(-1)![3];

    clickButton(el, "Crop");
    setInput(el.querySelector<HTMLInputElement>('input[name="x"]')!, "10");
    setInput(el.querySelector<HTMLInputElement>('input[name="width"]')!, "80");
    clickButton(el, "Apply");
    const paperAspect = el
      .querySelector<HTMLCanvasElement>("canvas")!
      .style.getPropertyValue("--paper-aspect");
    const callsAfterApply = base.generate.mock.calls.length;

    act(() => {
      for (const time of [250, 500, 1_000]) {
        const due = [...rafCallbacks.values()];
        rafCallbacks.clear();
        for (const callback of due) callback(time);
      }
    });

    expect(base.generate.mock.calls.length).toBeGreaterThan(callsAfterApply);
    for (const call of base.generate.mock.calls.slice(callsAfterApply)) {
      expect(call[3]).toBe(generationFrame);
    }
    expect(
      el
        .querySelector<HTMLCanvasElement>("canvas")!
        .style.getPropertyValue("--paper-aspect"),
    ).toBe(paperAspect);
    expect(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Lock Page aspect"]',
      )?.checked,
    ).toBe(true);
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

  it("restores a saved fixed-page result before exporting matching ordinary and plotter v3 metadata", async () => {
    presetClient.list.mockReset().mockResolvedValue(["fixed-page"]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const initialProfile: PlotProfile = {
      width: 260,
      height: 190,
      insets: { top: 11, right: 19, bottom: 23, left: 7 },
      includeFrame: false,
      toolWidthMillimeters: 0.45,
    };
    const lockedProfile: PlotProfile = {
      ...initialProfile,
      width: 333.125,
      height: 250,
      insets: { ...initialProfile.insets },
    };
    const { sketch, generate } = testSketch(initialProfile);
    const el = mount(sketch);
    await flushPromises();
    const generationFrame = generate.mock.calls.at(-1)![3];

    clickButton(el, "Crop");
    setInput(
      el.querySelector<HTMLInputElement>('input[name="physical-width"]')!,
      String(lockedProfile.width),
    );
    setInput(
      el.querySelector<HTMLInputElement>('input[name="physical-height"]')!,
      String(lockedProfile.height),
    );
    act(() =>
      el
        .querySelector<HTMLInputElement>('input[name="keepPageSizeFixed"]')!
        .click(),
    );
    for (const side of ["top", "right", "bottom", "left"] as const) {
      expect(
        el.querySelector<HTMLInputElement>(
          `input[name="physical-inset-${side}"]`,
        )?.value,
      ).toBe(String(lockedProfile.insets[side]));
    }
    setInput(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Composition scale percentage"]',
      )!,
      "175",
    );
    setInput(el.querySelector<HTMLInputElement>('input[name="x"]')!, "12.5");
    setInput(el.querySelector<HTMLInputElement>('input[name="y"]')!, "-8");
    clickButton(el, "Apply");
    setInput(
      el.querySelector<HTMLInputElement>('input[aria-label="preset name"]')!,
      "fixed-page",
    );
    clickButton(el, "Save");
    await flushPromises();
    await flushPromises();

    const saved = presetClient.save.mock.calls[0]![0];
    const fitFrame = centeredFixedPageFrame(lockedProfile, generationFrame);
    const expectedPageFrame = {
      x: generationFrame.width * 0.125,
      y: generationFrame.height * -0.08,
      width: fitFrame.width / 1.75,
      height: fitFrame.height / 1.75,
    };
    expect(saved).toEqual({
      version: 3,
      sketch: sketch.id,
      name: "fixed-page",
      seed: expect.any(Number),
      params: { radius: 10 },
      locks: [],
      profile: lockedProfile,
      framing: {
        pageFrame: expectedPageFrame,
        generationAspect: 3 / 2,
        aspectLocked: true,
      },
    });
    const framing = saved.framing;
    if (saved.version !== 3 || framing === undefined) {
      throw new Error("expected framed v3 preset");
    }
    expect(Object.keys(framing).sort()).toEqual([
      "aspectLocked",
      "generationAspect",
      "pageFrame",
    ]);
    expect(Object.keys(framing.pageFrame).sort()).toEqual([
      "height",
      "width",
      "x",
      "y",
    ]);
    for (const field of [
      "scale",
      "center",
      "fitReference",
      "editMode",
      "compositionTransform",
    ]) {
      expect(field in saved).toBe(false);
      expect(field in framing).toBe(false);
    }

    // Move every relevant live axis away from the saved snapshot, including
    // clearing the final Page, before proving Reload is the export authority.
    const radius = el.querySelector<HTMLInputElement>("#control-radius")!;
    act(() => radius.focus());
    setInput(radius, "25");
    act(() => radius.blur());
    const paperWidth = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;
    act(() => paperWidth.focus());
    setInput(paperWidth, "333");
    act(() => paperWidth.blur());
    clickButton(el, "Crop");
    clickButton(el, "Reset Frame");
    await flushPromises();
    expect(
      el.querySelector('input[aria-label="Lock Page aspect"]'),
    ).toBeNull();

    presetClient.load.mockResolvedValue(saved);
    const picker = el.querySelector<HTMLSelectElement>(
      'select[aria-label="saved presets"]',
    )!;
    expect([...picker.options].map((option) => option.value)).toContain("fixed-page");
    selectValue(picker, "fixed-page");
    expect(picker.value).toBe("fixed-page");
    clickButton(el, "Reload");
    await flushPromises();
    flushRaf();

    expect(presetClient.load).toHaveBeenCalledWith(sketch.id, "fixed-page");
    expect(el.querySelector<HTMLInputElement>("#control-radius")!.value).toBe(
      String(saved.params.radius),
    );

    const reloadedGenerationFrame = resolveCompositionFrame(
      framing.generationAspect,
    );
    expect(generate).toHaveBeenLastCalledWith(
      saved.params,
      saved.seed,
      0,
      reloadedGenerationFrame,
    );
    expect(saved.profile).toEqual(lockedProfile);
    expect(framing.pageFrame).toEqual(expectedPageFrame);
    const source = generate.mock.results.at(-1)!.value as Scene;
    expect(previewCapture.paints.at(-1)!.scene).toEqual(
      frameScene(source, framing.pageFrame),
    );
    expect(
      (previewCapture.paints.at(-1)!.scene as Scene).space,
    ).toEqual({
      width: framing.pageFrame.width,
      height: framing.pageFrame.height,
    });

    const expectedMetadata = {
      ...saved,
      name: `paper-flow-seed${saved.seed}`,
    };
    clickButton(el, "Export SVG");
    expect(JSON.parse(previewCapture.ordinaryExport!.metadata!)).toEqual(
      expectedMetadata,
    );
    clickButton(el, "Export Hidden-line SVG");
    await flushPromises();
    expect(JSON.parse(previewCapture.plotterExport!.metadata!)).toEqual(
      expectedMetadata,
    );
    expect(previewCapture.plotterExport!.scene.space).toEqual({
      width: framing.pageFrame.width,
      height: framing.pageFrame.height,
    });
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
      toolWidthMillimeters: 0.3,
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
    // The preview is already the one cheap finalization of the cached base;
    // export adds only explicit vector clipping, never a second Page boundary.
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
    // Frame visibility is cheap preview/export finalization state, not cached
    // Outline input: hiding it removes exactly the final Page rectangle.
    expect(disabledPreview).toEqual({
      ...enabledPreview,
      primitives: enabledPreview.primitives.slice(0, -1),
    });

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
