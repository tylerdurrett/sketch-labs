// @vitest-environment jsdom
import { act, useImperativeHandle, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PENCIL_CONTOUR_DEFAULT_IMAGE_ASSET_ID,
  PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
  WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID,
  watercolorForms,
  type Preset,
} from "@harness/core";

import { App } from "./App";
import type { LiveCanvasHandle } from "./LiveCanvas";

/**
 * Focus-retention coverage for the App-owned Sketch switcher (#165).
 *
 * The bug: App re-keys SketchControls with `key={selected.id}`, so picking a new
 * Sketch remounts the whole subtree — including the switcher's DOM, which lives
 * in the inspector INSIDE that keyed instance — dropping keyboard focus from the
 * trigger. Selection state survives (it lives in App), the focused element does
 * not. The fix lives in App (the stable parent above the remount): a stable ref
 * on the trigger plus a `selectedId`-keyed layout effect that re-focuses it after
 * the remount, and only on a switcher-driven change (never on first load).
 *
 * These drive the REAL Base UI Select. LiveCanvas is a browser-only sink
 * (canvas2d/ResizeObserver/matchMedia) irrelevant here, so it is stubbed — the
 * same seam SketchControls.test mocks — leaving the switcher wiring under test.
 */

// React 19's `act` requires this flag; vitest's jsdom env does not set it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const appImageResolution = vi.hoisted(() => ({
  ids: [] as string[],
  failure: null as null | "missing",
}));
const appNormalization = vi.hoisted(() => ({ caps: [] as number[] }));
const appCanvas = vi.hoisted(() => ({ captureCalls: 0 }));
const appPresetClient = vi.hoisted(() => ({
  list: vi
    .fn<[string], Promise<string[]>>()
    .mockImplementation(() => new Promise(() => {})),
  load: vi.fn<[string, string], Promise<Preset>>(),
  save: vi.fn<[Preset], Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("./imageAssetNormalization", async (importActual) => {
  const actual =
    await importActual<typeof import("./imageAssetNormalization")>();
  return {
    ...actual,
    normalizeImageAsset: async (
      _file: Blob,
      options: { readonly maxLongEdge: number },
    ) => {
      appNormalization.caps.push(options.maxLongEdge);
      return {
        png: new Blob(["normalized"], { type: "image/png" }),
        width: 12,
        height: 8,
      };
    },
  };
});

vi.mock("./imageAssetResolver", async (importActual) => {
  const actual = await importActual<typeof import("./imageAssetResolver")>();
  return {
    ...actual,
    resolveSketchEnvironment: async (
      _schema: unknown,
      params: Readonly<Record<string, unknown>>,
    ) => {
      const id = String(params.imageAsset);
      appImageResolution.ids.push(id);
      if (appImageResolution.failure !== null) {
        throw new actual.ImageAssetResolutionError(
          appImageResolution.failure,
          id,
        );
      }
      const pixels = {
        width: 1,
        height: 1,
        data: Uint8ClampedArray.from([32, 32, 32, 255]),
      };
      return {
        imageAssets: (requested: string) =>
          requested === id ? pixels : undefined,
      };
    },
  };
});

vi.mock("./presetsClient", () => ({
  listPresets: (sketchId: string) => appPresetClient.list(sketchId),
  loadPreset: (sketchId: string, name: string) =>
    appPresetClient.load(sketchId, name),
  savePreset: (preset: Preset) => appPresetClient.save(preset),
}));

vi.mock("./LiveCanvas", () => ({
  LiveCanvas: ({
    params,
    renderState,
    handleRef,
  }: {
    params: Readonly<Record<string, unknown>>;
    renderState?: {
      kind: string;
      status?: string;
      unresolvedAssetIds?: readonly string[];
    };
    handleRef?: Ref<LiveCanvasHandle>;
  }) => {
    useImperativeHandle(handleRef, () => ({
      getCanvas: () => null,
      getCurrentT: () => 0,
      getDisplayedScene: () => null,
      captureDisplayedFillFrame: () => {
        appCanvas.captureCalls += 1;
        return null;
      },
      captureDisplayedFrame: () => {
        appCanvas.captureCalls += 1;
        const scene = { space: { width: 100, height: 100 }, primitives: [] };
        return {
          scene,
          sourceScene: scene,
          displayedScene: scene,
          t: 0,
          renderMode: "fill" as const,
          tolerance: 0,
          includeFrame: true,
          inputRevision: 0,
        };
      },
    }));
    return (
      <div
        data-testid="canvas"
        data-params={JSON.stringify(params)}
        data-render-state={renderState?.kind ?? "fill-live"}
        data-unavailable-status={renderState?.status ?? ""}
        data-unresolved-asset-ids={
          renderState?.unresolvedAssetIds?.join(",") ?? ""
        }
      />
    );
  },
}));

const exportJob = vi.hoisted(() => ({
  starts: 0,
  resolve: null as null | ((result: {
    status: "cancelled";
    jobId: number;
  }) => void),
}));

vi.mock("./hiddenLineCoordinator", () => ({
  HiddenLineCoordinator: class {
    startExport() {
      exportJob.starts += 1;
      return new Promise((resolve) => {
        exportJob.resolve = resolve;
      });
    }
    cancel() {
      exportJob.resolve?.({ status: "cancelled", jobId: 1 });
      exportJob.resolve = null;
      return true;
    }
    dispose() {
      this.cancel();
    }
  },
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mountApp(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<App />);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  appImageResolution.ids = [];
  appImageResolution.failure = null;
  appNormalization.caps = [];
  appCanvas.captureCalls = 0;
  appPresetClient.list
    .mockReset()
    .mockImplementation(() => new Promise(() => {}));
  appPresetClient.load.mockReset();
  appPresetClient.save.mockReset().mockResolvedValue(undefined);
  exportJob.starts = 0;
  exportJob.resolve = null;
});

/** The switcher's trigger button, resolved fresh each call (it is remounted). */
function trigger(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Sketches"]',
  );
  if (el === null) throw new Error("no switcher trigger");
  return el;
}

/**
 * Commit a Base UI Select option by its visible label. Base UI's item `onClick`
 * bails for a MOUSE pointer unless the row is highlighted (a hover state jsdom
 * can't produce), but commits for a TOUCH pointer regardless — so a touch-typed
 * pointerdown/up before the click drives a real selection headlessly.
 */
function selectOption(label: string): void {
  act(() => {
    trigger().click(); // open the popup
  });
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (o) => o.textContent === label,
  );
  if (option === undefined) throw new Error(`no option labelled ${label}`);
  act(() => {
    for (const type of ["pointerdown", "pointerup"]) {
      const ev = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
      }) as MouseEvent & { pointerType: string; pointerId: number };
      ev.pointerType = "touch";
      ev.pointerId = 1;
      option.dispatchEvent(ev);
    }
    (option as HTMLElement).click();
  });
}

function setNumberInput(input: HTMLInputElement, value: string): void {
  act(() => input.focus());
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => input.blur());
}

function setTextInput(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (match === undefined) throw new Error(`no button labelled ${label}`);
  return match;
}

function pressUndo(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "z",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => window.dispatchEvent(event));
  return event;
}

describe("App — switcher focus retention (#165)", () => {
  it("restores focus to the trigger after a sketch selection remounts the subtree", () => {
    mountApp();

    const before = trigger().textContent;
    act(() => {
      trigger().focus();
    });
    expect(document.activeElement).toBe(trigger());

    // Pick a DIFFERENT sketch so `selectedId` changes and SketchControls
    // remounts (key={selected.id}), destroying and recreating the trigger DOM.
    selectOption("Circles");

    // Selection took effect (the trigger now shows the new sketch)...
    expect(trigger().textContent).toBe("Circles");
    expect(trigger().textContent).not.toBe(before);
    // ...and focus was restored to the freshly-remounted trigger — the bug was
    // that the keyed remount dropped it. `trigger()` re-resolves the NEW button.
    expect(document.activeElement).toBe(trigger());
  });

  it("does not steal focus on first load (no switcher-driven change yet)", () => {
    mountApp();

    // On mount the layout effect must NOT grab focus for the trigger — nobody
    // selected anything, so the page's initial focus is left untouched.
    expect(document.activeElement).not.toBe(trigger());
  });
});

describe("App — keyed edit-history sessions", () => {
  it("cannot traverse an old sketch's history after switching or fresh remounting", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
    mountApp();
    selectOption("Scribble Moon");
    const firstSketch = trigger().textContent!;
    const input = document.querySelector<HTMLInputElement>(
      '#inspector input[id^="control-"]',
    )!;
    const inputId = input.id;
    const initial = input.value;
    const changed = String(
      Math.min(
        Number(input.max),
        Math.max(Number(input.min), Number(initial) + 1),
      ),
    );
    setNumberInput(
      input,
      changed === initial ? String(Number(initial) - 1) : changed,
    );
    expect(
      document.querySelector<HTMLInputElement>(`#${inputId}`)?.value,
    ).not.toBe(initial);

    selectOption("Circles");
    const circlesBefore = document
      .querySelector('[data-testid="canvas"]')
      ?.getAttribute("data-params");
    expect(pressUndo().defaultPrevented).toBe(false);
    expect(
      document
        .querySelector('[data-testid="canvas"]')
        ?.getAttribute("data-params"),
    ).toBe(circlesBefore);

    selectOption(firstSketch);
    expect(document.querySelector<HTMLInputElement>(`#${inputId}`)?.value).toBe(
      initial,
    );
    expect(pressUndo().defaultPrevented).toBe(false);

    act(() => root!.unmount());
    root = createRoot(container!);
    act(() => root!.render(<App />));
    expect(pressUndo().defaultPrevented).toBe(false);
  });
});

describe("App — Photo Scribble integration (#333)", () => {
  it("opens on the bundled source and resets all authored controls after switching", async () => {
    mountApp();
    await act(async () => Promise.resolve());
    appImageResolution.ids = [];
    selectOption("Photo Scribble");
    await act(async () => Promise.resolve());

    expect(trigger().textContent).toBe("Photo Scribble");
    expect(appImageResolution.ids).toEqual([
      PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
    ]);
    expect(
      document.querySelector(
        '[aria-label="imageAsset image asset identity"]',
      )?.textContent,
    ).toBe(PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID);
    expect(
      [...document.querySelectorAll('#inspector input[id^="control-"]')].map(
        (input) => input.id,
      ),
    ).toEqual([
      "control-toneContrast",
      "control-tonePivot",
      "control-toneGamma",
      "control-detailSensitivity",
      "control-detailInfluence",
      "control-pathDensity",
      "control-scribbleScale",
      "control-momentum",
      "control-chaos",
      "control-toneFidelity",
      "control-stopPoint",
    ]);
    expect(
      document
        .querySelector('[data-testid="canvas"]')
        ?.getAttribute("data-params"),
    ).toBe(
      JSON.stringify({
        imageAsset: PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
        toneContrast: 0.5,
        tonePivot: 0.5,
        toneGamma: 0.5,
        detailSensitivity: 0.5,
        detailInfluence: 0,
        pathDensity: 1,
        scribbleScale: 1,
        momentum: 0.75,
        chaos: 0.25,
        toneFidelity: 0.9,
        stopPoint: 100,
      }),
    );
    expect(
      [...document.querySelectorAll("summary")].find(
        (summary) => summary.textContent?.includes("Paper"),
      ),
    ).toBeDefined();
    expect(document.querySelector("#sketch-seed")).not.toBeNull();
    expect(document.querySelector("#sketch-tolerance")).not.toBeNull();
    const buttonLabels = [...document.querySelectorAll("button")].map(
      (button) => button.textContent,
    );
    expect(buttonLabels).toEqual(
      expect.arrayContaining([
        "New seed",
        "Randomize",
        "Export PNG",
        "Export SVG",
        "Export Hidden-line SVG",
      ]),
    );

    const tone = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Tone",
    )!;
    act(() => tone.click());
    expect(
      document
        .querySelector('[data-testid="canvas"]')
        ?.getAttribute("data-render-state"),
    ).toBe("tone-reference");

    selectOption("Circles");
    selectOption("Photo Scribble");
    await act(async () => Promise.resolve());

    expect(
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Fill",
      )?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      document
        .querySelector('[data-testid="canvas"]')
        ?.getAttribute("data-render-state"),
    ).toBe("fill-held");
    expect(
      document.querySelectorAll('#inspector input[id^="control-"]'),
    ).toHaveLength(11);
    expect(
      document.querySelector(
        '[aria-label="imageAsset image asset identity"]',
      )?.textContent,
    ).toBe(PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID);
    expect(appImageResolution.ids).toEqual([
      PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
      PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
    ]);
  });

  it("wires the default 2048px normalization cap into image import", async () => {
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify(
              init?.method === "POST"
                ? { id: "app-import-bbbbbbbbbbbb", created: true }
                : [],
            ),
          ),
      } as Response),
    );
    mountApp();
    selectOption("Photo Scribble");
    const choose = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((candidate) => candidate.textContent === "Choose image")!;
    act(() => choose.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const input = document.querySelector<HTMLInputElement>(
      '#inspector input[type="file"]',
    )!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["source"], "App Import.webp")],
    });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((candidate) => candidate.textContent === "Import Image Asset")!;
    act(() => confirm.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(appNormalization.caps).toEqual([2048]);
    expect(
      document.querySelector(
        '[aria-label="imageAsset image asset identity"]',
      )?.textContent,
    ).toBe("app-import-bbbbbbbbbbbb");
  });
});

describe("App — Watercolor Forms integration (#402 WF10)", () => {
  it("opens as the newest Sketch with its managed source, authored controls, and a live ordinary preview", async () => {
    mountApp();
    await act(async () => Promise.resolve());

    expect(trigger().textContent).toBe("Watercolor Forms");
    expect(appImageResolution.ids).toEqual([
      WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID,
    ]);
    expect(
      document.querySelector(
        '[aria-label="imageAsset image asset identity"]',
      )?.textContent,
    ).toBe(WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID);
    expect(
      [...document.querySelectorAll('#inspector input[id^="control-"]')].map(
        (input) => input.id,
      ),
    ).toEqual([
      "control-formDetail",
      "control-colorSensitivity",
      "control-boundaryStrength",
      "control-boundarySmoothing",
    ]);
    expect(
      document
        .querySelector('[data-testid="canvas"]')
        ?.getAttribute("data-params"),
    ).toBe(
      JSON.stringify({
        imageAsset: WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID,
        formDetail: 0.5,
        colorSensitivity: 0.5,
        boundaryStrength: 0.5,
        boundarySmoothing: 0.5,
      }),
    );
    expect(
      document
        .querySelector('[data-testid="canvas"]')
        ?.getAttribute("data-render-state"),
    ).toBe("fill-live");

    setNumberInput(
      document.querySelector<HTMLInputElement>("#control-formDetail")!,
      "0.73",
    );
    expect(
      JSON.parse(
        document
          .querySelector('[data-testid="canvas"]')!
          .getAttribute("data-params")!,
      ),
    ).toMatchObject({ formDetail: 0.73 });
    expect(
      ["Save", "Reload", "Export PNG", "Export SVG", "Export Hidden-line SVG"].map(
        (label) => button(label).textContent,
      ),
    ).toEqual([
      "Save",
      "Reload",
      "Export PNG",
      "Export SVG",
      "Export Hidden-line SVG",
    ]);
  });

  it("round-trips its independent controls through the ordinary Preset surface", async () => {
    appPresetClient.list
      .mockResolvedValueOnce([])
      .mockResolvedValue(["watercolor-authored"]);
    mountApp();
    await act(async () => Promise.resolve());

    setNumberInput(
      document.querySelector<HTMLInputElement>("#control-boundaryStrength")!,
      "0.81",
    );
    setTextInput(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="preset name"]',
      )!,
      "watercolor-authored",
    );
    act(() => button("Save").click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(appPresetClient.save).toHaveBeenCalledOnce();
    const saved = appPresetClient.save.mock.calls[0]![0];
    expect(saved).toMatchObject({
      sketch: "watercolor-forms",
      name: "watercolor-authored",
      params: {
        imageAsset: WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID,
        formDetail: 0.5,
        colorSensitivity: 0.5,
        boundaryStrength: 0.81,
        boundarySmoothing: 0.5,
      },
    });

    setNumberInput(
      document.querySelector<HTMLInputElement>("#control-boundaryStrength")!,
      "0.22",
    );
    appPresetClient.load.mockResolvedValue(saved);
    setSelectValue(
      document.querySelector<HTMLSelectElement>(
        'select[aria-label="saved presets"]',
      )!,
      "watercolor-authored",
    );
    act(() => button("Reload").click());
    await act(async () => Promise.resolve());

    expect(appPresetClient.load).toHaveBeenCalledWith(
      "watercolor-forms",
      "watercolor-authored",
    );
    expect(
      document.querySelector<HTMLInputElement>("#control-boundaryStrength")
        ?.value,
    ).toBe("0.81");
    expect(
      JSON.parse(
        document
          .querySelector('[data-testid="canvas"]')!
          .getAttribute("data-params")!,
      ),
    ).toMatchObject({ boundaryStrength: 0.81 });
  });

  it("keeps a missing managed source unresolved without launching work or enabling output actions", async () => {
    appImageResolution.failure = "missing";
    const generate = vi.spyOn(watercolorForms, "generate");
    mountApp();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="canvas"]',
    )!;
    expect(trigger().textContent).toBe("Watercolor Forms");
    expect(appImageResolution.ids).toEqual([
      WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID,
    ]);
    expect(
      document.querySelector(
        '[aria-label="imageAsset image asset identity"]',
      )?.textContent,
    ).toBe(WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID);
    expect(JSON.parse(canvas.dataset.params!)).toMatchObject({
      imageAsset: WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID,
    });
    expect(canvas.dataset.renderState).toBe("unavailable");
    expect(canvas.dataset.unavailableStatus).toBe("missing");
    expect(canvas.dataset.unresolvedAssetIds).toBe(
      WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID,
    );
    expect(document.body.textContent).toContain("Image Asset is missing");
    for (const label of [
      "Fill",
      "Export PNG",
      "Export SVG",
      "Export Hidden-line SVG",
    ]) {
      expect(button(label).disabled).toBe(true);
      act(() => button(label).click());
    }
    expect(generate).not.toHaveBeenCalled();
    expect(appCanvas.captureCalls).toBe(0);
    expect(exportJob.starts).toBe(0);
    expect(appImageResolution.ids).toEqual([
      WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID,
    ]);
    generate.mockRestore();
  });

  it("still navigates to Pencil Contour with its unchanged identity and five-control schema", async () => {
    mountApp();
    await act(async () => Promise.resolve());
    selectOption("Pencil Contour");
    await act(async () => Promise.resolve());

    expect(trigger().textContent).toBe("Pencil Contour");
    expect(
      document.querySelector(
        '[aria-label="imageAsset image asset identity"]',
      )?.textContent,
    ).toBe(PENCIL_CONTOUR_DEFAULT_IMAGE_ASSET_ID);
    expect(
      [...document.querySelectorAll('#inspector input[id^="control-"]')].map(
        (input) => input.id,
      ),
    ).toEqual([
      "control-gamma",
      "control-contrast",
      "control-pivot",
      "control-contourDetail",
      "control-contourSmoothing",
    ]);
    expect(
      document
        .querySelector('[data-testid="canvas"]')
        ?.getAttribute("data-params"),
    ).toBe(
      JSON.stringify({
        imageAsset: PENCIL_CONTOUR_DEFAULT_IMAGE_ASSET_ID,
        gamma: 0.5,
        contrast: 0.5,
        pivot: 0.5,
        contourDetail: 0.5,
        contourSmoothing: 0.5,
      }),
    );
  });
});

describe("App — hidden-line navigation guard (#289)", () => {
  it("disables Sketch navigation for the full active interval with the exact reason", () => {
    mountApp();
    // Use an immediate live-Fill Sketch here. Shading-capable Sketches now
    // intentionally defer Outline until current worker geometry is painted.
    selectOption("Circles");
    const outlineChoice = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => outlineChoice.click());

    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute("aria-describedby")).toBe(
      "sketch-switch-disabled-reason",
    );
    const wrapper = trigger().parentElement!;
    expect(wrapper.title).toBe(
      "Finish or cancel the hidden-line job before switching Sketches.",
    );
    expect(
      document.querySelector("#sketch-switch-disabled-reason")?.textContent,
    ).toContain(
      "Finish or cancel the hidden-line job before switching Sketches.",
    );

    act(() => outlineChoice.click());
    expect(trigger().disabled).toBe(false);
  });

  it("guards navigation for an export while inspector collapse remains available", async () => {
    mountApp();
    // Export readiness is immediate for an ordinary live-Fill Sketch.
    selectOption("Circles");
    const exportButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Export Hidden-line SVG",
    ) as HTMLButtonElement;
    act(() => exportButton.click());

    expect(trigger().disabled).toBe(true);
    const collapse = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide inspector"]',
    )!;
    expect(collapse.disabled).toBe(false);
    act(() => collapse.click());
    expect(document.querySelector("#inspector")?.hasAttribute("hidden")).toBe(
      true,
    );

    const cancel = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel export",
    ) as HTMLButtonElement;
    await act(async () => {
      cancel.click();
      await Promise.resolve();
    });
    expect(trigger().disabled).toBe(false);
  });
});
