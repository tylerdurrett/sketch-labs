// @vitest-environment jsdom
import {
  act,
  StrictMode,
  useEffect,
  useImperativeHandle,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clipSceneToBounds,
  crc32,
  DEFAULT_COMPOSITION_FRAME,
  defaultParams,
  HARNESS_FALLBACK_PLOT_PROFILE,
  hiddenLinePass,
  leafField,
  resolvePlotCompositionFrame,
  type ParamSchema,
  type CoordinateSpace,
  type PlotProfile,
  type Preset,
  type Seed,
} from "@harness/core";

import type {
  DisplayedSceneSnapshot,
  LiveCanvasHandle,
} from "./LiveCanvas";
import { outlineScene } from "./outlineScene";
import { hiddenLineSceneForExport, SketchControls } from "./SketchControls";
import type { EditHistory } from "./editHistory";

// Preview == export seam probe (issue #220): capture the Scene the export path
// hands `renderToSVG`, so a test can prove it is the SAME processed Scene the
// shared {@link outlineScene} seam produces (the exact expression the outline
// preview also consumes). `vi.hoisted` lifts the holder above the hoisted
// `vi.mock` factory below so the factory can close over it.
const exportSceneCapture = vi.hoisted(() => ({
  current: null as unknown,
}));
const plotterExportCapture = vi.hoisted(() => ({
  current: null as null | {
    scene: unknown;
    profile: PlotProfile;
    metadata: string | undefined;
    options: { includePaperMargins?: boolean } | undefined;
  },
}));
const historyCapture = vi.hoisted(() => ({
  atomic: [] as { before: EditHistory; after: EditHistory }[],
  transactionCommits: [] as { before: EditHistory; after: EditHistory }[],
  cancels: [] as { before: EditHistory; after: EditHistory }[],
}));
const outlineJob = vi.hoisted(() => ({
  coordinators: 0,
  disposals: 0,
  starts: 0,
  active: null as null | {
    identity: import("./outlineComputeProtocol").OutlineComputeIdentity;
    resolve: (result: unknown) => void;
  },
}));

vi.mock("./hiddenLineCoordinator", () => ({
  HiddenLineCoordinator: class {
    private disposed = false;

    constructor() {
      outlineJob.coordinators += 1;
    }

    start(identity: import("./outlineComputeProtocol").OutlineComputeIdentity) {
      if (this.disposed) {
        return Promise.reject(new Error("Hidden-line coordinator is disposed"));
      }
      outlineJob.starts += 1;
      return {
        then(resolve: (result: unknown) => void) {
          outlineJob.active = { identity, resolve };
          return Promise.resolve();
        },
      };
    }
    cancel() {
      const active = outlineJob.active;
      if (active === null) return false;
      outlineJob.active = null;
      active.resolve({ status: "cancelled", jobId: 1 });
      return true;
    }
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      outlineJob.disposals += 1;
      this.cancel();
    }
  },
}));

// Probe both SVG serializers while delegating to their real implementations, so
// document assertions exercise core and each wiring test can identify the exact
// Scene/profile it received. Everything else in `@harness/core` is genuine.
vi.mock("@harness/core", async (importActual) => {
  const actual = await importActual<typeof import("@harness/core")>();
  return {
    ...actual,
    renderToSVG: (
      ...args: Parameters<typeof actual.renderToSVG>
    ): ReturnType<typeof actual.renderToSVG> => {
      exportSceneCapture.current = args[0];
      return actual.renderToSVG(...args);
    },
    renderPlotterSVG: (
      ...args: Parameters<typeof actual.renderPlotterSVG>
    ): ReturnType<typeof actual.renderPlotterSVG> => {
      plotterExportCapture.current = {
        scene: args[0],
        profile: args[1],
        metadata: args[2],
        options: args[3],
      };
      return actual.renderPlotterSVG(...args);
    },
  };
});

// Keep the real immutable model while recording the central Studio boundary.
// These integration assertions can distinguish atomic commands and transaction
// settlement without exposing history as product UI or adding a test-only prop.
vi.mock("./editHistory", async (importActual) => {
  const actual = await importActual<typeof import("./editHistory")>();
  return {
    ...actual,
    commitEditState: (...args: Parameters<typeof actual.commitEditState>) => {
      const after = actual.commitEditState(...args);
      historyCapture.atomic.push({ before: args[0], after });
      return after;
    },
    commitEditTransaction: (
      ...args: Parameters<typeof actual.commitEditTransaction>
    ) => {
      const after = actual.commitEditTransaction(...args);
      historyCapture.transactionCommits.push({ before: args[0], after });
      return after;
    },
    cancelEditTransaction: (
      ...args: Parameters<typeof actual.cancelEditTransaction>
    ) => {
      const after = actual.cancelEditTransaction(...args);
      historyCapture.cancels.push({ before: args[0], after });
      return after;
    },
  };
});

// The fake canvas node the mocked LiveCanvas hands back through its handle, with
// a `toBlob` the export test drives. Reassigned per-test so each case controls
// the blob the export receives (or a null blob to exercise the guard).
let fakeCanvasToBlob: HTMLCanvasElement["toBlob"];
// The current-t the mocked handle reports — the export's `-t{t}` source.
let fakeCurrentT = 0;
// Atomic displayed-Scene snapshot exposed by the mocked LiveCanvas handle.
let fakeDisplayedScene: DisplayedSceneSnapshot | null = null;
// #228: the real LiveCanvas signals `onOutlineComputed` when an outline pass has
// drawn, which the owner uses to clear its "Computing…" affordance. The mock
// records the latest callback so a test can drive that signal BY HAND (to observe
// the intermediate "Computing…" state), and — when `autoFireOutlineComputed` is
// true (the default) — fires it in an effect to model the pass completing, so the
// busy label clears exactly as the real component clears it.
let lastOnOutlineComputed: (() => void) | null = null;
let autoFireOutlineComputed = true;
let lastCompositionFrame: CoordinateSpace | null = null;
let lastProfile: PlotProfile | null = null;

// LiveCanvas is a browser-only sink (canvas2d, ResizeObserver, matchMedia) and
// is NOT under test here — these are wiring tests for the control state. Replace
// it with a probe that surfaces the `seed` it is fed into the DOM AND wires the
// `handleRef` to a fake canvas + current-t, so we can assert the seed the canvas
// receives AND drive the PNG export without polyfilling the whole canvas stack.
vi.mock("./LiveCanvas", () => ({
  LiveCanvas: ({
    seed,
    renderState,
    tolerance,
    compositionFrame,
    profile,
    handleRef,
    inputRevision = 0,
    fillCaptureRequest,
    onFillCaptured,
  }: {
    seed: Seed;
    renderState?: { kind: string; scene?: unknown; t?: number };
    tolerance?: number;
    compositionFrame: CoordinateSpace;
    profile: PlotProfile;
    handleRef?: Ref<LiveCanvasHandle>;
    inputRevision?: number;
    fillCaptureRequest?: { token: number; inputRevision: number } | null;
    onFillCaptured?: (capture: unknown) => void;
  }) => {
    useImperativeHandle(handleRef, () => ({
      getCanvas: () =>
        ({ toBlob: fakeCanvasToBlob }) as unknown as HTMLCanvasElement,
      getCurrentT: () => fakeCurrentT,
      getDisplayedScene: () => fakeDisplayedScene,
    }));
    lastOnOutlineComputed = () => {
      const active = outlineJob.active;
      if (active === null) return;
      outlineJob.active = null;
      active.resolve({
        status: "success",
        jobId: 1,
        identity: active.identity,
        scene: active.identity.sourceScene,
      });
    };
    lastCompositionFrame = compositionFrame;
    lastProfile = profile;
    // Model the outline pass finishing: fire the "computed" signal after each
    // outline render so the owner's busy label clears (unless a test opts out to
    // observe the intermediate "Computing…" state itself).
    useEffect(() => {
      if (fillCaptureRequest !== null && fillCaptureRequest !== undefined) {
        onFillCaptured?.({
          ...fillCaptureRequest,
          scene: {
            space: compositionFrame,
            primitives: [],
          },
          t: fakeCurrentT,
        });
      }
    }, [fillCaptureRequest?.token]);
    useEffect(() => {
      if (outlineJob.active !== null && autoFireOutlineComputed) {
        lastOnOutlineComputed?.();
      }
    });
    return (
      <div
        data-testid="canvas-seed"
        data-render-mode={renderState?.kind === "outline" ? "outline" : "fill"}
        data-render-state={renderState?.kind ?? "fill-live"}
        data-tolerance={String(tolerance)}
        data-include-frame={String(profile.includeFrame)}
        data-input-revision={String(inputRevision)}
      >
        {String(seed)}
      </div>
    );
  },
}));

// downloadBlob is the DOM-coupled file-save seam (tested on its own); stub it so
// the export wiring test can capture the (blob, filename) it is handed.
const downloadBlob = vi.fn<[Blob, string], void>();
vi.mock("./downloadBlob", () => ({
  downloadBlob: (blob: Blob, filename: string) => downloadBlob(blob, filename),
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

/** The render mode SketchControls fed the mocked LiveCanvas this render. */
function canvasRenderMode(el: HTMLElement): string | null {
  return (
    el
      .querySelector('[data-testid="canvas-seed"]')
      ?.getAttribute("data-render-mode") ?? null
  );
}

/** Big-endian 4-byte encoding of an unsigned 32-bit integer. */
function uint32BE(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

/** Frame a PNG chunk: length | type | data | CRC (over type+data). */
function pngChunk(type: string, data: number[]): number[] {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const crc = crc32(Uint8Array.from([...typeBytes, ...data]));
  return [...uint32BE(data.length), ...typeBytes, ...data, ...uint32BE(crc)];
}

/**
 * A minimal, well-formed PNG byte stream (signature + IHDR + IDAT + IEND) the
 * mocked canvas hands back, so the export's `insertPngMetadata` byte-splice has a
 * real PNG to operate on (the live `toBlob` would supply one).
 */
const MINIMAL_PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, // signature
  ...pngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  ...pngChunk("IDAT", [0, 1, 2, 3]),
  ...pngChunk("IEND", []),
]);

beforeEach(() => {
  outlineJob.coordinators = 0;
  outlineJob.disposals = 0;
  outlineJob.starts = 0;
  outlineJob.active = null;
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
  // Sensible defaults so a mount's list-on-mount effect resolves quietly; the
  // save/reload tests override loadPreset/savePreset per case.
  listPresets.mockResolvedValue([]);
  loadPreset.mockReset();
  savePreset.mockReset().mockResolvedValue(undefined);
  // Export defaults: a toBlob that yields a non-null, valid PNG blob, t = 0, and
  // a fresh downloadBlob spy. Per-test overrides drive the time-gated / guard
  // cases. The blob is a real minimal PNG so the metadata byte-splice succeeds.
  fakeCurrentT = 0;
  fakeDisplayedScene = null;
  // #228: default to auto-firing the outline "computed" signal so the busy label
  // clears on its own; the label test opts out to observe "Computing…".
  lastOnOutlineComputed = null;
  lastCompositionFrame = null;
  lastProfile = null;
  autoFireOutlineComputed = true;
  window.localStorage.clear();
  fakeCanvasToBlob = ((cb: BlobCallback) => {
    cb(new Blob([MINIMAL_PNG], { type: "image/png" }));
  }) as HTMLCanvasElement["toBlob"];
  downloadBlob.mockReset();
  // Clear both serializer probes so each test observes only its own export.
  exportSceneCapture.current = null;
  plotterExportCapture.current = null;
  historyCapture.atomic.length = 0;
  historyCapture.transactionCommits.length = 0;
  historyCapture.cancels.length = 0;
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

function pressHistoryShortcut(
  target: EventTarget,
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "z",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => target.dispatchEvent(event));
  return event;
}

function paperMarginsCheckbox(el: HTMLElement): HTMLInputElement {
  const checkbox = [
    ...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].find((input) =>
    input.labels?.[0]?.textContent?.includes(
      "Include paper margins in plotter SVG",
    ),
  );
  if (checkbox === undefined) throw new Error("no paper margins checkbox");
  return checkbox;
}

/**
 * Every primitive point of `scene` that falls OUTSIDE the canvas rectangle
 * `[0, 0, width, height]` (issue #237's acceptance predicate). The export-time
 * clip must leave this empty; an un-clipped Scene with overflowing geometry
 * populates it (so a test can prove the clip was both applied AND meaningful).
 */
function outOfBoundsPoints(
  scene: unknown,
  width: number,
  height: number,
): [number, number][] {
  const s = scene as { primitives: { points: [number, number][] }[] };
  return s.primitives.flatMap((p) =>
    p.points.filter(([x, y]) => x < 0 || x > width || y < 0 || y > height),
  );
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

  it("clearing the seed box is a no-op — does NOT commit seed 0", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const seedInput = el.querySelector("#sketch-seed") as HTMLInputElement;

    // Commit a known non-zero seed, then clear the field. `Number("") === 0`, so
    // without the empty guard the clear would silently overwrite the seed with 0.
    setInput(seedInput, "12345");
    setInput(seedInput, "");

    // The clear was ignored: the last committed seed still feeds the canvas...
    expect(el.querySelector('[data-testid="canvas-seed"]')?.textContent).toBe(
      "12345",
    );
    // The invalid partial draft stays local until this field settles.
    expect((el.querySelector("#sketch-seed") as HTMLInputElement).value).toBe("");
  });
});

describe("SketchControls — central edit-history integration", () => {
  it("handles the non-macOS chord matrix and ignores Meta", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const input = paramInput(el, "radius");

    expect(pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented).toBe(
      false,
    );
    act(() => input.focus());
    setInput(input, "42");
    act(() => input.blur());

    expect(pressHistoryShortcut(window, { metaKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(paramInput(el, "radius").value).toBe("42");
    expect(
      pressHistoryShortcut(window, { metaKey: true, shiftKey: true })
        .defaultPrevented,
    ).toBe(false);
    expect(paramInput(el, "radius").value).toBe("42");

    expect(pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented).toBe(
      true,
    );
    expect(
      pressHistoryShortcut(window, { ctrlKey: true, shiftKey: true })
        .defaultPrevented,
    ).toBe(true);
    expect(paramInput(el, "radius").value).toBe("42");

    pressHistoryShortcut(window, { ctrlKey: true });
    expect(
      pressHistoryShortcut(window, { key: "y", ctrlKey: true })
        .defaultPrevented,
    ).toBe(true);
    expect(paramInput(el, "radius").value).toBe("42");

    expect(
      pressHistoryShortcut(window, { key: "y", ctrlKey: true })
        .defaultPrevented,
    ).toBe(false);
    expect(
      pressHistoryShortcut(window, { ctrlKey: true, altKey: true })
        .defaultPrevented,
    ).toBe(false);
    expect(
      pressHistoryShortcut(window, { key: "x", ctrlKey: true })
        .defaultPrevented,
    ).toBe(false);
  });

  it("handles the macOS chord matrix and ignores Ctrl including Ctrl+Y", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const input = paramInput(el, "radius");
    act(() => input.focus());
    setInput(input, "42");
    act(() => input.blur());

    expect(pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(
      pressHistoryShortcut(window, { key: "y", ctrlKey: true })
        .defaultPrevented,
    ).toBe(false);
    expect(paramInput(el, "radius").value).toBe("42");

    expect(pressHistoryShortcut(window, { metaKey: true }).defaultPrevented).toBe(
      true,
    );
    expect(paramInput(el, "radius").value).toBe("10");
    expect(
      pressHistoryShortcut(window, { metaKey: true, shiftKey: true })
        .defaultPrevented,
    ).toBe(true);
    expect(paramInput(el, "radius").value).toBe("42");
  });

  it("yields to an active numeric edit, then traverses after that field settles", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const input = paramInput(el, "radius");

    act(() => input.focus());
    setInput(input, "20");
    act(() => input.blur());
    act(() => input.focus());
    setInput(input, "30");

    expect(
      pressHistoryShortcut(input, { ctrlKey: true }).defaultPrevented,
    ).toBe(false);
    expect(paramInput(el, "radius").value).toBe("30");

    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(
      pressHistoryShortcut(input, { ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    expect(paramInput(el, "radius").value).toBe("20");
  });

  it("keeps preset-name Undo native even when Studio history is available", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const radius = paramInput(el, "radius");
    act(() => radius.focus());
    setInput(radius, "42");
    act(() => radius.blur());
    const name = el.querySelector<HTMLInputElement>(
      'input[aria-label="preset name"]',
    )!;

    expect(
      pressHistoryShortcut(name, { ctrlKey: true }).defaultPrevented,
    ).toBe(false);
    expect(paramInput(el, "radius").value).toBe("42");
  });

  it("undoes tolerance through Outline invalidation while retaining excluded state", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
    const renderToggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => renderToggle.click());
    act(() => lastOnOutlineComputed?.());
    act(() => paperMarginsCheckbox(el).click());

    const tolerance = el.querySelector<HTMLInputElement>("#sketch-tolerance")!;
    act(() => tolerance.focus());
    setInput(tolerance, "1");
    act(() => tolerance.blur());
    act(() => lastOnOutlineComputed?.());
    expect(tolerance.value).toBe("1");

    pressHistoryShortcut(window, { ctrlKey: true });

    expect(
      el.querySelector<HTMLInputElement>("#sketch-tolerance")?.value,
    ).toBe("0");
    expect(renderToggle.getAttribute("aria-pressed")).toBe("true");
    expect(paperMarginsCheckbox(el).checked).toBe(false);
    expect(renderToggle.textContent).toBe("Outline");
  });

  it("routes lock toggle, Randomize, New seed, and frame toggle as named atomic commands", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          radius: numberSpec({ min: 0, max: 100, default: 10 }),
        })}
      />,
    );
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    act(() => {
      el.querySelector('button[aria-label="radius lock"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    clickButton(el, "Randomize");
    clickButton(el, "New seed");
    act(() => el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());

    expect(historyCapture.atomic).toHaveLength(4);
    const [lock, randomizeCommand, seedCommand, frameCommand] =
      historyCapture.atomic;
    expect(lock!.after.present.locks.has("radius")).toBe(true);
    // Locked randomization is a model-level no-op and therefore adds no entry.
    expect(randomizeCommand!.after).toBe(randomizeCommand!.before);
    expect(seedCommand!.after.present.seed).not.toBe(
      seedCommand!.before.present.seed,
    );
    expect(frameCommand!.after.present.profile.includeFrame).toBe(false);
  });

  it("suppresses an unchanged Randomize command", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          radius: numberSpec({ min: 0, max: 100, default: 50 }),
        })}
      />,
    );
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    clickButton(el, "Randomize");

    expect(historyCapture.atomic).toHaveLength(1);
    expect(historyCapture.atomic[0]!.after).toBe(
      historyCapture.atomic[0]!.before,
    );
    expect(historyCapture.atomic[0]!.after.past).toHaveLength(0);
  });

  it("records a changed Randomize as one atomic transition", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          radius: numberSpec({ min: 0, max: 100, default: 10 }),
        })}
      />,
    );
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    clickButton(el, "Randomize");

    expect(historyCapture.atomic).toHaveLength(1);
    const transition = historyCapture.atomic[0]!;
    expect(transition.after).not.toBe(transition.before);
    expect(transition.after.past).toHaveLength(1);
    expect(transition.after.present.params.radius).toBe(50);
    expect(transition.after.present.seed).toBe(transition.before.present.seed);
  });

  it("settles params, seed, Simplify, and Paper adapters through commitEditTransaction", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );

    const settle = (input: HTMLInputElement, value: string): void => {
      act(() => input.focus());
      setInput(input, value);
      act(() => input.blur());
    };

    settle(paramInput(el, "radius"), "42");
    settle(el.querySelector<HTMLInputElement>("#sketch-seed")!, "4242");
    settle(el.querySelector<HTMLInputElement>("#sketch-tolerance")!, "1.25");
    settle(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Paper width (mm)"]',
      )!,
      "300",
    );

    expect(historyCapture.transactionCommits).toHaveLength(4);
    const [paramsCommit, seedCommit, toleranceCommit, profileCommit] =
      historyCapture.transactionCommits;
    expect(paramsCommit!.after.present.params.radius).toBe(42);
    expect(seedCommit!.after.present.seed).toBe(4242);
    expect(toleranceCommit!.after.present.tolerance).toBe(1.25);
    expect(profileCommit!.after.present.profile.width).toBe(300);
    expect(profileCommit!.after.past).toHaveLength(4);
  });

  it("records one color-key gesture and keeps the mounted picker synced through Undo/Redo", async () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          ink: { kind: "color", default: "#ff0000" },
        })}
      />,
    );
    const colorTrigger = el.querySelector<HTMLButtonElement>(
      'button[aria-label^="ink current color"]',
    )!;
    act(() => colorTrigger.click());
    const hue = document.querySelector<HTMLElement>('[aria-label="ink hue"]')!;
    const hueKey = (type: "keydown" | "keyup") =>
      hue.dispatchEvent(
        new KeyboardEvent(type, {
          bubbles: true,
          cancelable: true,
          key: "ArrowRight",
          code: "ArrowRight",
          keyCode: 39,
        }),
      );

    act(() => hueKey("keydown"));
    act(() => hueKey("keydown"));
    act(() => hueKey("keyup"));

    expect(historyCapture.transactionCommits).toHaveLength(1);
    const gesture = historyCapture.transactionCommits[0]!;
    expect(gesture.after.past).toHaveLength(1);
    expect(gesture.after.present.params.ink).toBe("#ff9900");
    expect(colorTrigger.getAttribute("aria-label")).toBe(
      "ink current color #ff9900",
    );

    pressHistoryShortcut(window, { ctrlKey: true });
    await flush();
    expect(colorTrigger.getAttribute("aria-label")).toBe(
      "ink current color #ff0000",
    );
    expect(hue.getAttribute("aria-valuenow")).toBe("0");

    pressHistoryShortcut(window, { key: "y", ctrlKey: true });
    await flush();
    expect(colorTrigger.getAttribute("aria-label")).toBe(
      "ink current color #ff9900",
    );
    expect(hue.getAttribute("aria-valuenow")).toBe("36");
  });

  it("records a mouse color gesture as one Undo step", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          ink: { kind: "color", default: "#ff0000" },
        })}
      />,
    );
    act(() =>
      el
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="ink current color"]',
        )!
        .click(),
    );
    const saturation = document.querySelector<HTMLElement>(
      '[aria-label="ink saturation and value"]',
    )!;
    saturation.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect;

    act(() => {
      saturation.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          buttons: 1,
          clientX: 100,
          clientY: 25,
        }),
      );
    });
    act(() =>
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })),
    );

    expect(historyCapture.transactionCommits).toHaveLength(1);
    expect(
      historyCapture.transactionCommits[0]!.after.present.params.ink,
    ).toBe("#bf6060");
    expect(historyCapture.transactionCommits[0]!.after.past).toHaveLength(1);

    pressHistoryShortcut(window, { ctrlKey: true });
    expect(
      el
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="ink current color"]',
        )
        ?.getAttribute("aria-label"),
    ).toBe("ink current color #ff0000");
  });

  it("suppresses a color gesture that returns to its starting value", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          ink: { kind: "color", default: "#ff0000" },
        })}
      />,
    );
    act(() =>
      el
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="ink current color"]',
        )!
        .click(),
    );
    const hue = document.querySelector<HTMLElement>('[aria-label="ink hue"]')!;
    const arrow = (type: "keydown" | "keyup") =>
      hue.dispatchEvent(
        new KeyboardEvent(type, {
          bubbles: true,
          key: "ArrowRight",
          code: "ArrowRight",
          keyCode: 39,
        }),
      );

    for (let step = 0; step < 20; step += 1) act(() => arrow("keydown"));
    act(() => arrow("keyup"));

    expect(historyCapture.transactionCommits).toHaveLength(1);
    const noOp = historyCapture.transactionCommits[0]!;
    expect(noOp.after).not.toBe(noOp.before);
    expect(noOp.after.present.params.ink).toBe("#ff0000");
    expect(noOp.after.past).toHaveLength(0);
  });

  it("leaves Undo with an active RGB draft and restores Studio Undo after cancel", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          radius: numberSpec({ default: 10 }),
          ink: { kind: "color", default: "#ff0000" },
        })}
      />,
    );
    const radius = paramInput(el, "radius");
    act(() => radius.focus());
    setInput(radius, "42");
    act(() => radius.blur());
    expect(historyCapture.transactionCommits).toHaveLength(1);

    act(() =>
      el
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="ink current color"]',
        )!
        .click(),
    );
    const red = document.querySelector<HTMLInputElement>(
      'input[aria-label="ink red channel"]',
    )!;
    act(() => red.focus());
    setInput(red, "invalid");
    expect(
      red.closest('[aria-label="ink RGB channels"]')?.getAttribute(
        "data-studio-history",
      ),
    ).toBe("exclude");

    const nativeUndo = pressHistoryShortcut(red, { ctrlKey: true });
    expect(nativeUndo.defaultPrevented).toBe(false);
    expect(radius.value).toBe("42");
    expect(red.value).toBe("invalid");
    expect(historyCapture.transactionCommits).toHaveLength(1);

    act(() =>
      red.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(
      red.closest('[aria-label="ink RGB channels"]')?.getAttribute(
        "data-studio-history",
      ),
    ).toBeNull();

    const studioUndo = pressHistoryShortcut(red, { ctrlKey: true });
    expect(studioUndo.defaultPrevented).toBe(true);
    expect(paramInput(el, "radius").value).toBe("10");
  });

  it("feeds ControlPanel previews from present and Escape restores the whole transaction", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const input = paramInput(el, "radius");
    act(() => input.focus());
    setInput(input, "42");
    expect(paramInput(el, "radius").value).toBe("42");

    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );

    expect(paramInput(el, "radius").value).toBe("10");
    expect(historyCapture.cancels).toHaveLength(1);
    expect(historyCapture.cancels[0]!.after.present.params.radius).toBe(10);
    expect(historyCapture.cancels[0]!.after.past).toHaveLength(0);
  });

  it("routes paper format and orientation as separate atomic commands", () => {
    const sketch = {
      ...sketchWith("a", {}),
      defaultOutputProfile: {
        width: 210,
        height: 297,
        insets: { top: 10, right: 10, bottom: 10, left: 10 },
        includeFrame: true,
      },
    } as Parameters<typeof SketchControls>[0]["sketch"];
    const el = mount(<SketchControls sketch={sketch} />);
    const details = el.querySelector("details")!;
    act(() => details.setAttribute("open", ""));
    const format = details.querySelector("select")!;

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(format, "letter");
      format.dispatchEvent(new Event("change", { bubbles: true }));
    });
    clickButton(details, "Swap to landscape");

    expect(historyCapture.atomic).toHaveLength(2);
    expect(historyCapture.atomic[0]!.after.present.profile).toMatchObject({
      width: 215.9,
      height: 279.4,
    });
    expect(historyCapture.atomic[1]!.after.present.profile).toMatchObject({
      width: 279.4,
      height: 215.9,
    });
  });

  it("shows live Fill for a changed transaction and reuses exact cache on cancel", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => toggle.click());
    act(() => lastOnOutlineComputed?.());
    const initialFrame = lastCompositionFrame;
    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;

    act(() => width.focus());
    expect(canvasRenderMode(el)).toBe("fill");
    setInput(width, "300");
    expect(toggle.textContent).toBe("Outline");
    expect(lastCompositionFrame).not.toBe(initialFrame);
    expect(outlineJob.starts).toBe(1);
    act(() => lastOnOutlineComputed?.());

    act(() =>
      width.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );

    expect(lastProfile?.width).toBe(200);
    expect(lastCompositionFrame).toEqual(initialFrame);
    expect(toggle.textContent).toBe("Outline");
    expect(canvasRenderMode(el)).toBe("outline");
    expect(outlineJob.starts).toBe(1);
    expect(historyCapture.cancels).toHaveLength(1);
    expect(historyCapture.cancels[0]!.after.past).toHaveLength(0);
  });

  it("shows live Fill during a same-identity edit and restores exact cache on cancel", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => toggle.click());
    act(() => lastOnOutlineComputed?.());
    expect(outlineJob.starts).toBe(1);
    expect(
      el.querySelector('[data-testid="canvas-seed"]')?.getAttribute(
        "data-render-state",
      ),
    ).toBe("outline");
    const initialFrame = lastCompositionFrame;
    const margin = el.querySelector<HTMLInputElement>(
      'input[aria-label="Linked paper margin (mm)"]',
    )!;

    act(() => margin.focus());
    expect(canvasRenderMode(el)).toBe("fill");
    setInput(margin, "20");
    expect(lastProfile?.insets).toEqual({
      top: 20,
      right: 20,
      bottom: 20,
      left: 20,
    });
    expect(lastCompositionFrame).toBe(initialFrame);
    expect(toggle.textContent).toBe("Outline");
    expect(outlineJob.starts).toBe(1);
    expect(
      el.querySelector('[data-testid="canvas-seed"]')?.getAttribute(
        "data-render-state",
      ),
    ).toBe("fill-live");

    act(() =>
      margin.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );

    expect(lastProfile?.insets).toEqual({
      top: 10,
      right: 10,
      bottom: 10,
      left: 10,
    });
    expect(lastCompositionFrame).toBe(initialFrame);
    expect(toggle.textContent).toBe("Outline");
    expect(outlineJob.starts).toBe(1);
    expect(
      el.querySelector('[data-testid="canvas-seed"]')?.getAttribute(
        "data-render-state",
      ),
    ).toBe("outline");
    expect(historyCapture.cancels).toHaveLength(1);
  });

  it("shows live Fill for an invalid draft and restores exact cache on settle", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => toggle.click());
    act(() => lastOnOutlineComputed?.());
    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;

    act(() => width.focus());
    setInput(width, "");
    expect(outlineJob.starts).toBe(1);
    expect(
      el.querySelector('[data-testid="canvas-seed"]')?.getAttribute(
        "data-render-state",
      ),
    ).toBe("fill-live");

    act(() =>
      width.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(outlineJob.starts).toBe(1);
    expect(
      el.querySelector('[data-testid="canvas-seed"]')?.getAttribute(
        "data-render-state",
      ),
    ).toBe("outline");
  });
});

describe("SketchControls — collapsed-state a11y (#165)", () => {
  it("keeps #inspector mounted while collapsed so aria-controls resolves", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
        collapsed={true}
      />,
    );

    // The toggle references the inspector by id; while collapsed that target
    // MUST still exist (it is the affordance a screen-reader user uses to
    // re-open the panel) — present but `hidden`, not removed from the DOM.
    const toggle = el.querySelector<HTMLButtonElement>("button[aria-controls]");
    expect(toggle?.getAttribute("aria-controls")).toBe("inspector");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    const inspector = el.querySelector("#inspector");
    expect(inspector).not.toBeNull();
    // `hidden` collapses it (and drops it from the a11y tree) without unmounting.
    expect((inspector as HTMLElement).hidden).toBe(true);
  });

  it("shows #inspector (present, not hidden) when expanded", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
        collapsed={false}
      />,
    );

    const toggle = el.querySelector<HTMLButtonElement>("button[aria-controls]");
    expect(toggle?.getAttribute("aria-controls")).toBe("inspector");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");

    const inspector = el.querySelector("#inspector");
    expect(inspector).not.toBeNull();
    expect((inspector as HTMLElement).hidden).toBe(false);
  });
});

describe("SketchControls — Paper inspector integration (#248)", () => {
  it("places a collapsed Paper disclosure immediately after the switcher and before schema controls", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
        switcher={<div data-testid="sketch-switcher">Sketch switcher</div>}
      />,
    );
    const inspector = el.querySelector("#inspector")!;
    const switcher = inspector.querySelector('[data-testid="sketch-switcher"]');
    const paper = inspector.querySelector("details");
    const schemaControls = paramInput(el, "radius").closest(
      ".flex.flex-col.gap-4",
    );

    expect(paper?.open).toBe(false);
    expect(paper?.querySelector("summary")?.textContent).toContain("Paper");
    expect(paper?.previousElementSibling).toBe(switcher);
    expect(paper?.nextElementSibling).toBe(schemaControls);
  });

  it("keeps Paper mounted and collapsed when the whole inspector is hidden", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
        collapsed
      />,
    );
    const inspector = el.querySelector<HTMLElement>("#inspector")!;
    const paper = inspector.querySelector("details")!;

    expect(inspector.hidden).toBe(true);
    expect(paper.open).toBe(false);
    expect(paper.querySelector("summary")?.textContent).toContain(
      "200 × 200 mm",
    );
  });

  it("preserves the global display-unit preference across a keyed Sketch remount", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <SketchControls
          key="a"
          sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
        />,
      );
    });

    const inches = container.querySelector<HTMLInputElement>(
      'input[type="radio"][value="in"]',
    )!;
    act(() => inches.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector("details summary")?.textContent).toContain(
      "in",
    );

    act(() => {
      root!.render(
        <SketchControls
          key="b"
          sketch={sketchWith("b", { radius: numberSpec({ default: 20 }) })}
        />,
      );
    });

    expect(
      container.querySelector<HTMLInputElement>(
        'input[type="radio"][value="in"]',
      )?.checked,
    ).toBe(true);
    expect(container.querySelector("details summary")?.textContent).toContain(
      "in",
    );
  });

  it("persists the export-only margin preference across a full unmount/remount without changing Scene inputs", () => {
    autoFireOutlineComputed = false;
    const generate = vi.fn(() => ({
      space: { width: 100, height: 100 },
      primitives: [],
    }));
    const firstSketch = {
      ...sketchWith("a", { radius: numberSpec({ default: 10 }) }),
      generate,
    } as Parameters<typeof SketchControls>[0]["sketch"];
    const el = mount(<SketchControls sketch={firstSketch} />);
    const renderToggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => renderToggle.click());
    act(() => lastOnOutlineComputed?.());
    expect(renderToggle.textContent).toBe("Outline");
    expect(renderToggle.disabled).toBe(false);
    const profileBefore = lastProfile;
    const profileValueBefore = structuredClone(lastProfile);
    const frameBefore = lastCompositionFrame;

    expect(paperMarginsCheckbox(el).checked).toBe(true);
    act(() => paperMarginsCheckbox(el).click());

    expect(paperMarginsCheckbox(el).checked).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(lastProfile).toBe(profileBefore);
    expect(lastProfile).toEqual(profileValueBefore);
    expect(lastCompositionFrame).toBe(frameBefore);
    expect(renderToggle.textContent).toBe("Outline");
    expect(renderToggle.disabled).toBe(false);
    expect(historyCapture.atomic).toHaveLength(0);
    expect(historyCapture.transactionCommits).toHaveLength(0);

    act(() => root!.unmount());
    container!.remove();
    root = null;
    container = null;

    const remounted = mount(
      <SketchControls
        sketch={sketchWith("b", { radius: numberSpec({ default: 20 }) })}
      />,
    );
    expect(paperMarginsCheckbox(remounted).checked).toBe(false);
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
    const loadedProfile: PlotProfile = {
      width: 210,
      height: 297,
      insets: { top: 12, right: 13, bottom: 14, left: 15 },
      includeFrame: false,
    };
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "a",
      name: "warm",
      seed: 999,
      params: { radius: 77, count: 88, futureSchemaKey: 66 },
      locks: ["radius", "futureSchemaKey"],
      profile: loadedProfile,
    });
    listPresets.mockResolvedValue(["warm"]);

    const reloadSchema: ParamSchema = {
      ...schema,
      futureSchemaKey: numberSpec({ default: 6 }),
    };
    const el = mount(
      <SketchControls sketch={sketchWith("a", reloadSchema)} />,
    );
    await flush(); // list-on-mount populates the picker
    const initialSeed = el.querySelector('[data-testid="canvas-seed"]')
      ?.textContent;
    const initialProfile = structuredClone(lastProfile);

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
    expect(paramInput(el, "futureSchemaKey").value).toBe("66");
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
    // One Preset reload changes params, seed, and locks together, but records a
    // single whole-state transition.
    expect(historyCapture.atomic).toHaveLength(1);
    const reload = historyCapture.atomic[0]!;
    expect(reload.after.past).toHaveLength(1);
    expect(reload.after.present.params).toEqual({
      radius: 77,
      count: 88,
      futureSchemaKey: 66,
    });
    expect(reload.after.present.seed).toBe(999);
    expect(reload.after.present.locks).toEqual(
      new Set(["radius", "futureSchemaKey"]),
    );
    expect(reload.after.present.profile).toEqual(loadedProfile);
    expect(lastProfile).toEqual(loadedProfile);

    // The atomic reload traverses as one whole-state step, including a key that
    // arrived through the current schema rather than a hard-coded field list.
    pressHistoryShortcut(window, { ctrlKey: true });
    expect(paramInput(el, "radius").value).toBe("10");
    expect(paramInput(el, "count").value).toBe("5");
    expect(paramInput(el, "futureSchemaKey").value).toBe("6");
    expect(el.querySelector('[data-testid="canvas-seed"]')?.textContent).toBe(
      initialSeed,
    );
    expect(
      el
        .querySelector('button[aria-label="radius lock"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(lastProfile).toEqual(initialProfile);

    pressHistoryShortcut(window, { key: "y", ctrlKey: true });
    expect(paramInput(el, "futureSchemaKey").value).toBe("66");
    expect(el.querySelector('[data-testid="canvas-seed"]')?.textContent).toBe(
      "999",
    );
    expect(lastProfile).toEqual(loadedProfile);
  });

  it("preserves a persisted color lock as inert data across reload and save", async () => {
    const mixedSchema: ParamSchema = {
      radius: numberSpec({ min: 0, max: 100, default: 10 }),
      ink: { kind: "color", default: "#1a2b3c" },
    };
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "a",
      name: "legacy-color-lock",
      seed: 999,
      params: { radius: 20, ink: "#abcdef" },
      locks: ["ink"],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
    listPresets.mockResolvedValue(["legacy-color-lock"]);

    const el = mount(
      <SketchControls sketch={sketchWith("a", mixedSchema)} />,
    );
    await flush();
    const picker = el.querySelector<HTMLSelectElement>(
      'select[aria-label="saved presets"]',
    )!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(picker, "legacy-color-lock");
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    clickButton(el, "Reload");
    await flush();

    // Reconciliation keeps a schema-present color key in the generic lock Set,
    // but the mixed control surface exposes Lock only for the numeric sibling.
    expect(historyCapture.atomic.at(-1)?.after.present.locks).toEqual(
      new Set(["ink"]),
    );
    expect(el.querySelector('button[aria-label="ink lock"]')).toBeNull();
    expect(el.querySelector('button[aria-label="radius lock"]')).not.toBeNull();
    expect(
      el.querySelector('button[aria-label^="ink current color #abcdef"]'),
    ).not.toBeNull();

    // The inert color entry does not prevent an unlocked numeric roll and the
    // color still follows Randomize's unconditional pass-through contract.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    clickButton(el, "Randomize");
    expect(paramInput(el, "radius").value).toBe("50");
    expect(
      el.querySelector('button[aria-label^="ink current color #abcdef"]'),
    ).not.toBeNull();

    setInput(
      el.querySelector('input[aria-label="preset name"]') as HTMLInputElement,
      "roundtrip",
    );
    clickButton(el, "Save");
    await flush();

    // Save receives the generic Set unchanged; makePreset serializes the legacy
    // color key normally instead of filtering or migrating it away.
    expect(savePreset).toHaveBeenCalledTimes(1);
    expect(savePreset.mock.calls[0]?.[0]).toMatchObject({
      name: "roundtrip",
      params: { radius: 50, ink: "#abcdef" },
      locks: ["ink"],
    });
  });

  it("saving serializes the live params, seed, locks, AND the active profile under the sketch id", async () => {
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
    const historyWritesBeforeSave =
      historyCapture.atomic.length + historyCapture.transactionCommits.length;
    clickButton(el, "Save");
    await flush();

    expect(savePreset).toHaveBeenCalledTimes(1);
    // The Save now stamps a v2 record (#266) carrying the session's active Plot
    // Profile (#267). This Sketch declares no default, so the active profile is
    // the Harness fallback resolved at mount.
    expect(savePreset.mock.calls[0]?.[0]).toEqual({
      version: 2,
      sketch: "a",
      name: "warm",
      seed: 4242,
      params: { radius: 10, count: 33 },
      locks: ["radius"],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
    expect(
      historyCapture.atomic.length + historyCapture.transactionCommits.length,
    ).toBe(historyWritesBeforeSave);
  });

  it("rejects an invalid (non-slug) name inline and does not save", async () => {
    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush();

    setInput(
      el.querySelector('input[aria-label="preset name"]') as HTMLInputElement,
      "Not A Slug",
    );
    // Inline hint shown; Save is disabled and clicking it is a no-op. The hint
    // is the only alert in this invalid-name scenario (no error <p> renders), so
    // a class-independent role + hint-text match pins it.
    const hint = el.querySelector('p[role="alert"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain("Name must be a lowercase slug");
    const save = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Save",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    clickButton(el, "Save");
    await flush();
    expect(savePreset).not.toHaveBeenCalled();
  });
});

describe("SketchControls — Plot Profile session wiring (#267)", () => {
  const schema: ParamSchema = {
    radius: numberSpec({ min: 0, max: 100, default: 10 }),
  };

  // A profile that differs from the Harness fallback (200×200, 10mm insets) on
  // every field, so "the active profile IS / is NOT this value" is unambiguous.
  const customProfile: PlotProfile = {
    width: 420,
    height: 297,
    insets: { top: 15, right: 12, bottom: 9, left: 6 },
    includeFrame: false,
  };

  // A Sketch that DECLARES its own default Output Profile. No registered sketch
  // does today, so this variant is the only way to exercise #265's middle
  // precedence rung (the Sketch default) — the fallback-only `sketchWith` always
  // resolves straight to the Harness fallback.
  const sketchWithDefault = (id: string, profile: PlotProfile) =>
    ({
      ...(sketchWith(id, schema) as unknown as Record<string, unknown>),
      defaultOutputProfile: profile,
    }) as unknown as Parameters<typeof SketchControls>[0]["sketch"];

  /** Type a valid name, Save, and return the Preset the client last received. */
  async function saveAndCapture(
    el: HTMLElement,
    presetName: string,
  ): Promise<Preset> {
    setInput(
      el.querySelector('input[aria-label="preset name"]') as HTMLInputElement,
      presetName,
    );
    clickButton(el, "Save");
    await flush();
    const calls = savePreset.mock.calls;
    return calls[calls.length - 1]![0];
  }

  /** Select `presetName` in the picker and click Reload. */
  function reloadInUi(el: HTMLElement, presetName: string): void {
    const picker = el.querySelector(
      'select[aria-label="saved presets"]',
    ) as HTMLSelectElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(picker, presetName);
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    clickButton(el, "Reload");
  }

  it("resolves the active profile from the Sketch's own declared default at mount (#265 sketch-default rung)", async () => {
    // The declared default wins over the Harness fallback — a plain Save (no
    // reload) stamps a v2 record carrying THIS Sketch's declared profile.
    const el = mount(
      <SketchControls sketch={sketchWithDefault("a", customProfile)} />,
    );
    await flush();

    const preset = await saveAndCapture(el, "declared");
    expect(preset).toMatchObject({ version: 2, profile: customProfile });
  });

  it("re-resolves per Sketch on a keyed remount, never reusing the prior Sketch's active profile (#267)", async () => {
    // App mounts this with key={sketch.id}, so a Sketch switch remounts it and
    // re-runs the lazy initializer against the NEW Sketch's own default. Render
    // Sketch A (declares customProfile), then remount under a DIFFERENT key onto
    // Sketch B (no declared default): B must resolve to the Harness fallback, NOT
    // carry over A's customProfile. The keyed remount IS the per-Sketch reset.
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <SketchControls key="a" sketch={sketchWithDefault("a", customProfile)} />,
      );
    });
    await flush();

    // A's active profile is its declared default.
    const presetA = await saveAndCapture(container, "from-a");
    expect(presetA).toMatchObject({
      version: 2,
      sketch: "a",
      profile: customProfile,
    });

    // Switch Sketch: remount under a new key onto B (declares no default).
    savePreset.mockClear();
    act(() => {
      root!.render(<SketchControls key="b" sketch={sketchWith("b", schema)} />);
    });
    await flush();

    const presetB = await saveAndCapture(container, "from-b");
    // B re-resolved from its OWN default (the Harness fallback) — it did NOT
    // inherit A's active customProfile.
    expect(presetB).toMatchObject({
      version: 2,
      sketch: "b",
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
    expect(presetB.profile).not.toEqual(customProfile);
  });

  it("reloading a v2 Preset adopts its stored profile (it wins) and a subsequent Save re-emits it (#265 v2 rung)", async () => {
    // A v2 preset carrying customProfile, reloaded onto a Sketch with no declared
    // default: the stored profile must WIN over the Sketch default / Harness
    // fallback (the top rung of #265's precedence).
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "a",
      name: "wide",
      seed: 7,
      params: { radius: 10 },
      locks: [],
      profile: customProfile,
    });
    listPresets.mockResolvedValue(["wide"]);

    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush();

    reloadInUi(el, "wide");
    await flush();

    expect(lastProfile).toEqual(customProfile);
    // A Save now re-emits the reloaded profile — the stored v2 profile won.
    const preset = await saveAndCapture(el, "again");
    expect(preset).toMatchObject({ version: 2, profile: customProfile });
  });

  it("reloading a v1 Preset (no profile) falls back to the Harness fallback when the Sketch declares no default (#265 v1 fallback)", async () => {
    // A v1 preset carries no profile, so the reload resolves through the fallback
    // — here the Harness fallback (this Sketch declares no default).
    loadPreset.mockResolvedValue({
      version: 1,
      sketch: "a",
      name: "legacy",
      seed: 3,
      params: { radius: 10 },
      locks: [],
    });
    listPresets.mockResolvedValue(["legacy"]);

    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush();

    reloadInUi(el, "legacy");
    await flush();

    expect(lastProfile).toEqual(HARNESS_FALLBACK_PLOT_PROFILE);
    const preset = await saveAndCapture(el, "resaved");
    expect(preset).toMatchObject({
      version: 2,
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
  });

  it("reloading a v1 Preset falls back to the Sketch's declared default when it has one (#265 middle rung)", async () => {
    // Same v1 (profile-less) preset, but reloaded onto a Sketch that DECLARES a
    // default: the fallback resolves to that Sketch default, not the Harness
    // fallback — the middle rung of #265's precedence.
    loadPreset.mockResolvedValue({
      version: 1,
      sketch: "a",
      name: "legacy",
      seed: 3,
      params: { radius: 10 },
      locks: [],
    });
    listPresets.mockResolvedValue(["legacy"]);

    const el = mount(
      <SketchControls sketch={sketchWithDefault("a", customProfile)} />,
    );
    await flush();

    reloadInUi(el, "legacy");
    await flush();

    const preset = await saveAndCapture(el, "resaved");
    expect(preset).toMatchObject({ version: 2, profile: customProfile });
  });

  it("an SVG export's reproduction metadata carries the session's active (reloaded) profile (#247)", async () => {
    // Prove the EXPORT path reflects the session's active profile, not just the
    // mount default: reload a v2 preset carrying customProfile, then export SVG
    // and assert the embedded envelope is a v2 record carrying that profile.
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "a",
      name: "wide",
      seed: 7,
      params: { radius: 10 },
      locks: [],
      profile: customProfile,
    });
    listPresets.mockResolvedValue(["wide"]);

    // A Sketch whose generate yields a serializable (empty-primitives) Scene, so
    // the SVG export path runs to a real <metadata>-bearing document.
    const svgSketch = {
      ...(sketchWith("a", schema) as unknown as Record<string, unknown>),
      generate: () => ({ space: { width: 100, height: 100 }, primitives: [] }),
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];

    const el = mount(<SketchControls sketch={svgSketch} />);
    await flush();

    reloadInUi(el, "wide");
    await flush();

    clickButton(el, "Export SVG");

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob] = downloadBlob.mock.calls[0]!;
    const svg = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    const meta = svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1];
    expect(meta).toBeDefined();
    expect(JSON.parse(meta!)).toMatchObject({
      version: 2,
      sketch: "a",
      profile: customProfile,
    });
  });

  it("threads one profile-resolved frame through preview and plain SVG at the captured t", async () => {
    const generate = vi.fn(() => ({
      space: { width: 100, height: 100 },
      primitives: [],
    }));
    const sketch = {
      ...(sketchWith("a", schema) as unknown as Record<string, unknown>),
      time: { duration: 4, mode: "loop" },
      generate,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "a",
      name: "wide",
      seed: 7,
      params: { radius: 10 },
      locks: [],
      profile: customProfile,
    });
    listPresets.mockResolvedValue(["wide"]);
    fakeCurrentT = 2.5;

    const el = mount(<SketchControls sketch={sketch} />);
    await flush();
    reloadInUi(el, "wide");
    await flush();

    const expected = resolvePlotCompositionFrame(customProfile);
    expect(lastProfile).toEqual(customProfile);
    expect(lastCompositionFrame).toEqual(expected);
    clickButton(el, "Export SVG");
    expect(generate).toHaveBeenLastCalledWith({ radius: 10 }, 7, 2.5, expected);
  });

  it("keeps the resolved frame identity when profile magnitude changes at the same drawable aspect", async () => {
    const sameAspectProfile: PlotProfile = {
      width: 400,
      height: 400,
      insets: { top: 20, right: 20, bottom: 20, left: 20 },
      includeFrame: false,
    };
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "a",
      name: "larger-square",
      seed: 7,
      params: { radius: 10 },
      locks: [],
      profile: sameAspectProfile,
    });
    listPresets.mockResolvedValue(["larger-square"]);

    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush();
    const initialFrame = lastCompositionFrame;
    reloadInUi(el, "larger-square");
    await flush();

    expect(lastProfile).toEqual(sameAspectProfile);
    expect(lastCompositionFrame).toBe(initialFrame);
  });

  it("refreshes same-aspect paper layout without replacing geometry or recomputing Outline", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;

    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => lastOnOutlineComputed?.());
    expect(toggle.textContent).toBe("Outline");
    const initialFrame = lastCompositionFrame;

    // The fallback sheet is square. Changing all linked insets together keeps
    // its drawable rectangle square, while still changing the preview's sheet
    // layout ratios and active physical profile.
    setInput(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Linked paper margin (mm)"]',
      )!,
      "20",
    );

    expect(lastProfile).toEqual({
      width: 200,
      height: 200,
      insets: { top: 20, right: 20, bottom: 20, left: 20 },
      includeFrame: true,
    });
    expect(lastCompositionFrame).toBe(initialFrame);
    expect(toggle.textContent).toBe("Outline");
    expect(toggle.disabled).toBe(false);
  });

  it("marks Outline recomputing when the composition-frame option changes", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    const frameOption = el.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;

    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => lastOnOutlineComputed?.());
    const initialFrame = lastCompositionFrame;
    expect(frameOption.checked).toBe(true);

    act(() => frameOption.click());

    expect(lastProfile?.includeFrame).toBe(false);
    expect(lastCompositionFrame).toBe(initialFrame);
    expect(
      el.querySelector('[data-testid="canvas-seed"]')?.getAttribute(
        "data-include-frame",
      ),
    ).toBe("false");
    expect(toggle.textContent).toBe("Outline");
    expect(toggle.disabled).toBe(false);
  });

  it("restores includeFrame from a Preset and recomputes the visible Outline", async () => {
    autoFireOutlineComputed = false;
    listPresets.mockResolvedValue(["without-frame"]);
    const profileWithoutFrame: PlotProfile = {
      ...HARNESS_FALLBACK_PLOT_PROFILE,
      includeFrame: false,
    };
    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush();
    const seed = Number(
      el.querySelector<HTMLInputElement>("#sketch-seed")!.value,
    );
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "a",
      name: "without-frame",
      seed,
      params: { radius: 10 },
      locks: [],
      profile: profileWithoutFrame,
    });
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => lastOnOutlineComputed?.());

    reloadInUi(el, "without-frame");
    await flush();

    expect(lastProfile).toEqual(profileWithoutFrame);
    expect(el.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(
      false,
    );
    expect(toggle.textContent).toBe("Outline");
    expect(toggle.disabled).toBe(false);
  });

  it("marks Outline recomputing only when a committed paper edit changes drawable aspect", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => lastOnOutlineComputed?.());
    const initialFrame = lastCompositionFrame;
    const initialProfile = lastProfile;
    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;

    // A draft that cannot commit remains PaperSection-local: neither profile nor
    // geometry changes, and the expensive outline pass stays idle.
    setInput(width, "");
    expect(lastProfile).toBe(initialProfile);
    expect(lastCompositionFrame).toBe(initialFrame);
    expect(toggle.textContent).toBe("Outline");

    // Completing a valid width edit changes the drawable aspect. The one shared
    // frame is replaced and the busy affordance is raised before regeneration.
    setInput(width, "300");
    expect(lastProfile).toMatchObject({ width: 300, height: 200 });
    expect(lastCompositionFrame).not.toBe(initialFrame);
    expect(lastCompositionFrame).toEqual(
      resolvePlotCompositionFrame(lastProfile!),
    );
    expect(toggle.textContent).toBe("Outline");
    expect(toggle.disabled).toBe(false);
  });
});

describe("SketchControls — SVG export wiring", () => {
  // A Scene the mocked sketch.generate returns — its single Primitive lets the
  // test assert the downloaded SVG is the serialized vector of THAT Scene.
  const svgScene = {
    space: { width: 100, height: 100 },
    background: { color: "mintcream" },
    primitives: [
      {
        points: [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        closed: true,
        fill: { color: "tomato" },
      },
    ],
  };

  // A static sketch whose generate yields svgScene (overriding the no-op default).
  const svgStaticSketch = (id: string) => {
    const base = sketchWith(id, {
      radius: numberSpec({ default: 10 }),
    }) as unknown as Record<string, unknown>;
    return {
      ...base,
      generate: () => svgScene,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  // A time-driven variant so the export carries a `-t{t}` segment.
  const svgTimedSketch = (id: string) => {
    const base = svgStaticSketch(id) as unknown as Record<string, unknown>;
    return {
      ...base,
      time: { duration: 4, mode: "loop" },
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  /** Read the text of the Blob the export handed downloadBlob (jsdom-safe). */
  function blobText(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
  }

  it("downloads a vector SVG of the displayed Scene named for a STATIC sketch (no -t)", async () => {
    const el = mount(<SketchControls sketch={svgStaticSketch("circles")} />);
    const seed = (el.querySelector("#sketch-seed") as HTMLInputElement).value;

    clickButton(el, "Export SVG");

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlob.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/svg+xml");
    // The Blob is the serialized vector of the generated Scene.
    const svg = await blobText(blob);
    expect(svg).toMatch(/<svg\b[^>]*viewBox="0 0 100 100"/);
    expect(svg).toContain(
      '<rect x="0" y="0" width="100" height="100" fill="mintcream" />',
    );
    expect(svg).toMatch(/<path\b[^>]*fill="tomato"/);
    expect(exportSceneCapture.current).not.toBeNull();
    expect(plotterExportCapture.current).toBeNull();
    // Static sketch ⇒ no `-t` segment, `.svg` extension.
    expect(filename).toBe(`circles-seed${seed}.svg`);

    // The SVG embeds the reproduction envelope in a <metadata> element (#76),
    // round-tripping back to the displayed (seed, params, name-stem) — no t. The
    // envelope is now a v2 record (#266) carrying the active Plot Profile (#267);
    // this Sketch declares no default, so it is the Harness fallback.
    const meta = svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1];
    expect(meta).toBeDefined();
    expect(JSON.parse(meta!)).toMatchObject({
      version: 2,
      sketch: "circles",
      name: `circles-seed${seed}`,
      seed: Number(seed),
      params: { radius: 10 },
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });

    // The plotter export of the SAME fixture deliberately drops the Scene
    // background along with all other non-path preview/image chrome.
    clickButton(el, "Export Hidden-line SVG");
    const plotterSvg = await blobText(downloadBlob.mock.calls[1]![0]);
    expect(plotterSvg).not.toContain("mintcream");
    expect(plotterSvg).not.toMatch(/<rect\b/);
  });

  it("includes the captured -t{t} segment for a time-driven sketch", () => {
    fakeCurrentT = 2.5;
    const el = mount(<SketchControls sketch={svgTimedSketch("waves")} />);
    const seed = (el.querySelector("#sketch-seed") as HTMLInputElement).value;

    clickButton(el, "Export SVG");

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [, filename] = downloadBlob.mock.calls[0]!;
    expect(filename).toBe(`waves-seed${seed}-t2.5.svg`);
  });

  // #237: a Scene whose single Primitive overflows the 100×100 canvas on BOTH
  // sides — a horizontal line from x=-50 to x=150 at y=50. The plain SVG export
  // must clip it to the canvas rectangle before serializing, so the exported
  // geometry is exactly [0,50]→[100,50] and nothing lies outside [0,0,100,100].
  const overflowScene = {
    space: { width: 100, height: 100 },
    primitives: [
      {
        points: [
          [-50, 50],
          [150, 50],
        ],
        stroke: { color: "black" },
      },
    ],
  };

  const overflowSketch = (id: string) => {
    const base = sketchWith(id, {
      radius: numberSpec({ default: 10 }),
    }) as unknown as Record<string, unknown>;
    return {
      ...base,
      generate: () => overflowScene,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  it("clips overflowing geometry to the canvas bounds before serializing (#237)", async () => {
    // Pin the mount-time `useState(() => newSeed(Math.random))` seed so the
    // repro-metadata envelope embedded in the SVG is deterministic (0.5 ->
    // 4503599627370495, which contains neither "150" nor "-50"). Without this
    // the random seed's digits collide with the overflow-coordinate substring
    // assertions below ~1.4% of runs (#240). `vi.restoreAllMocks()` in
    // afterEach undoes the stub.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const el = mount(<SketchControls sketch={overflowSketch("circles")} />);

    clickButton(el, "Export SVG");

    // The Scene handed `renderToSVG` is the CLIPPED Scene: no point outside the
    // canvas rectangle survives.
    const exported = exportSceneCapture.current;
    expect(exported).not.toBeNull();
    expect(outOfBoundsPoints(exported, 100, 100)).toEqual([]);
    // The clip was MEANINGFUL — the raw generated Scene did overflow the canvas —
    // and the export applied core's clip exactly.
    expect(outOfBoundsPoints(overflowScene, 100, 100)).not.toEqual([]);
    expect(exported).toEqual(
      clipSceneToBounds(
        overflowScene as unknown as Parameters<typeof clipSceneToBounds>[0],
      ),
    );

    // The overflowing coordinates never reach the serialized SVG string either.
    const [blob] = downloadBlob.mock.calls[0]!;
    const svg = await blobText(blob);
    expect(svg).not.toContain("-50");
    expect(svg).not.toContain("150");
  });
});

describe("SketchControls — Hidden-line SVG export wiring", () => {
  // A Scene with TWO overlapping filled squares in painter's order: the nearer
  // (second) square covers the far-left region of the farther (first) one, so
  // the Hidden-line pass MUST clip part of the farther square's outline away —
  // the surviving stroke geometry is strictly less than the raw outline, which
  // proves the export ran the pass rather than serializing the raw Scene.
  const hlScene = {
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
  };

  const hlStaticSketch = (id: string) => {
    const base = sketchWith(id, {
      radius: numberSpec({ default: 10 }),
    }) as unknown as Record<string, unknown>;
    return {
      ...base,
      generate: () => hlScene,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  const hlTimedSketch = (id: string) => {
    const base = hlStaticSketch(id) as unknown as Record<string, unknown>;
    return {
      ...base,
      time: { duration: 4, mode: "loop" },
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  it("returns a matching displayed outline by identity without invoking fallback", () => {
    const processed = outlineScene(
      hlScene as unknown as DisplayedSceneSnapshot["scene"],
    );
    const generate = vi.fn();

    expect(
      hiddenLineSceneForExport({
        displayed: {
          scene: processed,
          t: 2.5,
          renderMode: "outline",
          tolerance: 3,
          includeFrame: false,
        },
        currentT: 2.5,
        renderMode: "outline",
        tolerance: 3,
        includeFrame: false,
        generate,
      }),
    ).toBe(processed);
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects a displayed Scene whose composition-frame identity is stale", () => {
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const withoutFrame = outlineScene(source, 0, false);
    const generate = vi.fn(() => source);

    const selected = hiddenLineSceneForExport({
      displayed: {
        scene: withoutFrame,
        t: 0,
        renderMode: "outline",
        tolerance: 0,
        includeFrame: false,
      },
      currentT: 0,
      renderMode: "outline",
      tolerance: 0,
      includeFrame: true,
      generate,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(selected).toEqual(outlineScene(source, 0, true));
    expect(selected).not.toBe(withoutFrame);
  });

  function blobText(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
  }

  it("downloads a stroke-only hidden-line SVG named -hidden-line for a STATIC sketch", async () => {
    const el = mount(<SketchControls sketch={hlStaticSketch("circles")} />);
    const seed = (el.querySelector("#sketch-seed") as HTMLInputElement).value;

    clickButton(el, "Export Hidden-line SVG");

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlob.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/svg+xml");

    const svg = await blobText(blob);
    expect(svg).toMatch(
      /<svg\b[^>]*width="200mm" height="200mm" viewBox="0 0 200 200"/,
    );
    // The pass ran: its output is STROKE-ONLY (fill-free primitives), so the raw
    // fill colors never reach the serialized SVG and every path is stroked.
    expect(svg).not.toContain('fill="tomato"');
    expect(svg).not.toContain('fill="steelblue"');
    expect(svg).toMatch(/<path\b[^>]*stroke="black"/);

    // Static sketch ⇒ the variant segment sits right after the seed, no -t.
    expect(filename).toBe(`circles-seed${seed}-hidden-line.svg`);

    // The reproduction envelope still round-trips to the displayed frame — now a
    // v2 record (#266) carrying the active Plot Profile (#267), the Harness
    // fallback for this default-less Sketch.
    const meta = svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1];
    expect(meta).toBeDefined();
    expect(JSON.parse(meta!)).toMatchObject({
      version: 2,
      sketch: "circles",
      name: `circles-seed${seed}`,
      seed: Number(seed),
      params: { radius: 10 },
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
  });

  it("exports the cold Outline seam onto a non-square asymmetric physical sheet as paths only", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const profile: PlotProfile = {
      width: 250,
      height: 180,
      insets: { top: 15, right: 45, bottom: 15, left: 25 },
      includeFrame: false,
    };
    const source = {
      space: { width: 120, height: 100 },
      background: "papayawhip",
      primitives: [
        {
          points: [
            [0, 0],
            [120, 0],
            [120, 100],
            [0, 100],
          ],
          closed: true,
          fill: { color: "tomato" },
        },
      ],
    } as unknown as DisplayedSceneSnapshot["scene"];
    const generate = vi.fn(() => source);
    const sketch = {
      ...(hlStaticSketch("physical") as unknown as Record<string, unknown>),
      defaultOutputProfile: profile,
      generate,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];

    const el = mount(<SketchControls sketch={sketch} />);
    const seed = Number(
      (el.querySelector("#sketch-seed") as HTMLInputElement).value,
    );
    clickButton(el, "Export Hidden-line SVG");

    expect(generate).toHaveBeenCalledTimes(1);
    expect(plotterExportCapture.current).toEqual({
      scene: clipSceneToBounds(outlineScene(source)),
      profile,
      metadata: expect.any(String),
      options: { includePaperMargins: true },
    });

    const svg = await blobText(downloadBlob.mock.calls[0]![0]);
    expect(svg).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" width="250mm" height="180mm" viewBox="0 0 250 180" data-paper-extent="paper">',
    );
    // 120×100 Scene → 180×150 mm drawable: 1.5×, placed at asymmetric
    // left/right insets 25/45 and top/bottom insets 15/15.
    expect(svg).toContain('d="M25 15 L205 15 L205 165 L25 165 L25 15"');
    expect(svg).toContain('stroke-width="1.5"');
    expect(svg.match(/<path\b/g)).toHaveLength(1);
    expect(svg).not.toMatch(/<(?:rect|circle|ellipse|polygon|polyline|image)\b/);
    expect(svg).not.toContain("papayawhip");
    expect(svg).not.toContain("tomato");

    const encoded = svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1];
    expect(encoded).toBeDefined();
    expect(JSON.parse(encoded!)).toEqual({
      version: 2,
      sketch: "physical",
      name: `physical-seed${seed}`,
      seed,
      params: { radius: 10 },
      locks: [],
      profile,
    });
  });

  it("forwards only the current export preference as the serializer fourth argument", () => {
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const generate = vi.fn(() => source);
    const el = mount(
      <SketchControls sketch={{ ...hlStaticSketch("circles"), generate }} />,
    );

    clickButton(el, "Export Hidden-line SVG");
    const included = plotterExportCapture.current!;
    const metadataBefore = included.metadata;
    const sceneBefore = included.scene;
    const profileBefore = structuredClone(included.profile);
    expect(included.options).toEqual({ includePaperMargins: true });

    act(() => paperMarginsCheckbox(el).click());
    expect(generate).toHaveBeenCalledTimes(1);
    clickButton(el, "Export Hidden-line SVG");

    expect(generate).toHaveBeenCalledTimes(2);
    expect(plotterExportCapture.current?.options).toEqual({
      includePaperMargins: false,
    });
    expect(plotterExportCapture.current?.scene).toEqual(sceneBefore);
    expect(plotterExportCapture.current?.profile).toEqual(profileBefore);
    expect(plotterExportCapture.current?.metadata).toBe(metadataBefore);
  });

  it("atomically scales the physical sheet via Preset reload while reusing the cached Outline Scene", async () => {
    listPresets.mockResolvedValue(["double"]);
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const processed = outlineScene(source, 0, true);
    const processedBefore = structuredClone(processed);
    const generate = vi.fn(() => source);
    const el = mount(
      <SketchControls sketch={{ ...hlStaticSketch("circles"), generate }} />,
    );
    await flush();
    const seed = Number(
      (el.querySelector("#sketch-seed") as HTMLInputElement).value,
    );

    clickButton(el, "Fill");
    fakeDisplayedScene = {
      scene: processed,
      t: 0,
      renderMode: "outline",
      tolerance: 0,
      includeFrame: true,
    };
    clickButton(el, "Export Hidden-line SVG");
    const firstScene = plotterExportCapture.current?.scene;
    const firstSvg = await blobText(downloadBlob.mock.calls[0]![0]);

    // Reload through the real v2 Preset path so width, height, and every inset
    // commit atomically. Doubling all five magnitudes preserves drawable aspect.
    const doubledProfile: PlotProfile = {
      width: 400,
      height: 400,
      insets: { top: 20, right: 20, bottom: 20, left: 20 },
      includeFrame: true,
    };
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "circles",
      name: "double",
      seed,
      params: { radius: 10 },
      locks: [],
      profile: doubledProfile,
    });
    const picker = el.querySelector(
      'select[aria-label="saved presets"]',
    ) as HTMLSelectElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(picker, "double");
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    clickButton(el, "Reload");
    await flush();

    clickButton(el, "Export Hidden-line SVG");
    const secondScene = plotterExportCapture.current?.scene;
    const secondSvg = await blobText(downloadBlob.mock.calls[1]![0]);

    expect(generate).not.toHaveBeenCalled();
    expect(fakeDisplayedScene?.scene).toBe(processed);
    expect(processed).toEqual(processedBefore);
    expect(firstScene).toEqual(secondScene);
    expect(plotterExportCapture.current?.profile).toEqual(doubledProfile);
    expect(firstSvg).toContain(
      'width="200mm" height="200mm" viewBox="0 0 200 200"',
    );
    expect(secondSvg).toContain(
      'width="400mm" height="400mm" viewBox="0 0 400 400"',
    );
    expect(firstSvg).toContain('d="M10 10 L46 10"');
    expect(secondSvg).toContain('d="M20 20 L92 20"');
    expect(firstSvg).toContain('stroke-width="1.8"');
    expect(secondSvg).toContain('stroke-width="3.6"');
    expect(secondSvg).not.toBe(firstSvg);
  });

  it("carries the -t{t} segment before -hidden-line for a time-driven sketch", () => {
    fakeCurrentT = 2.5;
    const el = mount(<SketchControls sketch={hlTimedSketch("waves")} />);
    const seed = (el.querySelector("#sketch-seed") as HTMLInputElement).value;

    clickButton(el, "Export Hidden-line SVG");

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [, filename] = downloadBlob.mock.calls[0]!;
    expect(filename).toBe(`waves-seed${seed}-t2.5-hidden-line.svg`);
  });

  it("reuses the exact displayed outline Scene without generating or reprocessing", () => {
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const processed = outlineScene(source, 0, true);
    const base = hlStaticSketch("circles");
    const generate = vi.fn(() => source);
    const sketch = { ...base, generate };
    const el = mount(<SketchControls sketch={sketch} />);

    clickButton(el, "Fill");
    fakeDisplayedScene = {
      scene: processed,
      t: 0,
      renderMode: "outline",
      tolerance: 0,
      includeFrame: true,
    };
    clickButton(el, "Export Hidden-line SVG");

    expect(generate).not.toHaveBeenCalled();
    expect(plotterExportCapture.current?.scene).toEqual(
      clipSceneToBounds(processed),
    );
  });

  it("reuses the exact displayed fill Scene and only runs hidden-line processing", () => {
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const base = hlStaticSketch("circles");
    const generate = vi.fn(() => source);
    const sketch = { ...base, generate };
    const el = mount(<SketchControls sketch={sketch} />);
    fakeDisplayedScene = {
      scene: source,
      t: 0,
      renderMode: "fill",
      tolerance: 0,
      includeFrame: true,
    };

    clickButton(el, "Export Hidden-line SVG");

    expect(generate).not.toHaveBeenCalled();
    expect(plotterExportCapture.current?.scene).toEqual(
      clipSceneToBounds(outlineScene(source, 0, true)),
    );
  });

  it("falls back to exact cold generation when no displayed Scene is cached", () => {
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const base = hlStaticSketch("circles");
    const generate = vi.fn(() => source);
    const el = mount(<SketchControls sketch={{ ...base, generate }} />);

    clickButton(el, "Export Hidden-line SVG");

    expect(generate).toHaveBeenCalledTimes(1);
    expect(plotterExportCapture.current?.scene).toEqual(
      clipSceneToBounds(outlineScene(source, 0, true)),
    );
  });

  it("rejects a stale displayed Scene and falls back to exact cold generation", () => {
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const base = hlStaticSketch("circles");
    const generate = vi.fn(() => source);
    const sketch = { ...base, generate };
    const el = mount(<SketchControls sketch={sketch} />);
    fakeDisplayedScene = {
      scene: { space: source.space, primitives: [] },
      t: 99,
      renderMode: "fill",
      tolerance: 0,
      includeFrame: true,
    };

    clickButton(el, "Export Hidden-line SVG");

    expect(generate).toHaveBeenCalledTimes(1);
    expect(plotterExportCapture.current?.scene).toEqual(
      clipSceneToBounds(outlineScene(source, 0, true)),
    );
  });

  // AC (#220): the outline-mode canvas input and the hidden-line SVG export input
  // must be the IDENTICAL processed Scene for the same (params, seed, t). Both
  // call sites now delegate to the ONE shared `outlineScene` seam, so this holds
  // by construction. jsdom's `canvas.getContext('2d')` is null, so LiveCanvas's
  // `drawFrame` early-returns before it would feed the canvas — the preview's
  // Scene isn't directly observable through a live render. The faithful check is
  // therefore: drive the REAL `exportHiddenLineSvg` and assert the Scene it hands
  // `renderPlotterSVG` (captured above) deep-equals
  // `outlineScene(generatedScene)` —
  // the exact processing seam LiveCanvas's outline branch evaluates — for
  // one fixed frame. Locking the export path to the shared seam is what removes
  // the drift risk between preview and export.
  it("export input Scene equals the shared outlineScene seam the preview consumes (#220)", () => {
    const sketch = hlStaticSketch("circles");
    const el = mount(<SketchControls sketch={sketch} />);
    const seed = Number(
      (el.querySelector("#sketch-seed") as HTMLInputElement).value,
    );

    clickButton(el, "Export Hidden-line SVG");

    // The export handed `renderPlotterSVG` a Scene.
    expect(plotterExportCapture.current).not.toBeNull();
    // A static sketch's export passes `t ?? 0` (t is undefined ⇒ 0); params are
    // the schema defaults ({ radius: 10 }); seed is the displayed seed. The
    // outline preview evaluates this SAME expression, so the two inputs match.
    expect(plotterExportCapture.current?.scene).toEqual(
      outlineScene(
        sketch.generate(
          { radius: 10 },
          seed,
          0,
          resolvePlotCompositionFrame(HARNESS_FALLBACK_PLOT_PROFILE),
        ),
        0,
        true,
      ),
    );
  });

  // AC3 (#232): the studio tolerance knob drives the hidden-line EXPORT's final
  // simplification. A scene whose surviving stroke has exactly-collinear interior
  // vertices lets a positive tolerance visibly drop them. Driving the knob then
  // re-exporting must (a) hand `renderPlotterSVG` the SAME seam expression at
  // the new tolerance (preview == export by construction) and (b) actually
  // reduce the exported vertex count versus tolerance 0.
  const redundantScene = {
    space: { width: 100, height: 100 },
    // A single filled Primitive, no occluder ⇒ its whole ring survives as one
    // stroke. [30,0] and [30,40] are collinear on the top/bottom edges, so a
    // positive Douglas–Peucker tolerance removes them.
    primitives: [
      {
        points: [
          [0, 0],
          [30, 0],
          [60, 0],
          [60, 40],
          [30, 40],
          [0, 40],
        ],
        closed: true,
        fill: { color: "tomato" },
      },
    ],
  };

  const redundantSketch = (id: string) => {
    const base = sketchWith(id, {
      radius: numberSpec({ default: 10 }),
    }) as unknown as Record<string, unknown>;
    return {
      ...base,
      generate: () => redundantScene,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  const totalVerts = (scene: unknown): number =>
    (scene as { primitives: { points: unknown[] }[] }).primitives.reduce(
      (sum, p) => sum + p.points.length,
      0,
    );

  it("limits the simplification tolerance controls to the useful 0–2 range", () => {
    const el = mount(<SketchControls sketch={redundantSketch("circles")} />);
    const numberInput = el.querySelector(
      "#sketch-tolerance",
    ) as HTMLInputElement;
    const sliderInput = el.querySelector(
      'input[type="range"][aria-label="Simplification tolerance"]',
    ) as HTMLInputElement;

    expect(numberInput.min).toBe("0");
    expect(numberInput.max).toBe("2");
    expect(sliderInput.min).toBe("0");
    expect(sliderInput.max).toBe("2");
  });

  it("the tolerance knob drives the hidden-line export's simplification (#232, AC3)", () => {
    const sketch = redundantSketch("circles");
    const el = mount(<SketchControls sketch={sketch} />);
    const seed = Number(
      (el.querySelector("#sketch-seed") as HTMLInputElement).value,
    );

    // Baseline export at the default tolerance 0 — no simplification.
    clickButton(el, "Export Hidden-line SVG");
    const atZero = plotterExportCapture.current?.scene;
    expect(atZero).toEqual(
      outlineScene(
        sketch.generate(
          { radius: 10 },
          seed,
          0,
          resolvePlotCompositionFrame(HARNESS_FALLBACK_PLOT_PROFILE),
        ),
        0,
        true,
      ),
    );
    const vertsAtZero = totalVerts(atZero);

    // Drive the studio knob, then re-export.
    setInput(el.querySelector("#sketch-tolerance") as HTMLInputElement, "1");
    clickButton(el, "Export Hidden-line SVG");
    const atOne = plotterExportCapture.current?.scene;

    // preview == export: the export is the SAME seam expression at tolerance 1
    // (the value LiveCanvas's outline preview also receives — asserted below).
    expect(atOne).toEqual(
      outlineScene(
        sketch.generate(
          { radius: 10 },
          seed,
          0,
          resolvePlotCompositionFrame(HARNESS_FALLBACK_PLOT_PROFILE),
        ),
        1,
        true,
      ),
    );
    // ...and simplification actually reduced the exported vertex count.
    expect(totalVerts(atOne)).toBeLessThan(vertsAtZero);
  });

  it("the tolerance knob value is the one fed to the outline preview (#232, AC3)", () => {
    const el = mount(<SketchControls sketch={redundantSketch("circles")} />);

    // The mocked LiveCanvas surfaces the tolerance prop it was fed. Default 0.
    const canvas = () =>
      el.querySelector('[data-testid="canvas-seed"]') as HTMLElement;
    expect(canvas().dataset.tolerance).toBe("0");

    // Driving the knob updates the SAME value the preview consumes — the single
    // state that also drives the export, so the two cannot diverge.
    setInput(el.querySelector("#sketch-tolerance") as HTMLInputElement, "1");
    expect(canvas().dataset.tolerance).toBe("1");
  });

  // #237: a filled square straddling the bottom-right corner (x,y ∈ [50,150]),
  // so half of it lies OUTSIDE the 100×100 canvas. The hidden-line export must
  // clip AFTER the hidden-line pass and BEFORE serialization, so the exported
  // stroke geometry stays inside [0,0,100,100].
  const overflowHlScene = {
    space: { width: 100, height: 100 },
    primitives: [
      {
        points: [
          [50, 50],
          [150, 50],
          [150, 150],
          [50, 150],
        ],
        closed: true,
        fill: { color: "tomato" },
      },
    ],
  };

  const overflowHlSketch = (id: string) => {
    const base = sketchWith(id, {
      radius: numberSpec({ default: 10 }),
    }) as unknown as Record<string, unknown>;
    return {
      ...base,
      generate: () => overflowHlScene,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  it("clips overflowing geometry before physical mapping and keeps it inside the drawable rectangle (#237)", async () => {
    const sketch = overflowHlSketch("circles");
    const el = mount(<SketchControls sketch={sketch} />);
    const seed = Number(
      (el.querySelector("#sketch-seed") as HTMLInputElement).value,
    );

    // The un-clipped seam (generate → hidden-line pass) still overflows the
    // canvas — so the clip that follows is doing real work.
    const seam = outlineScene(
      sketch.generate(
        { radius: 10 },
        seed,
        0,
        resolvePlotCompositionFrame(HARNESS_FALLBACK_PLOT_PROFILE),
      ),
      0,
      true,
    );
    expect(outOfBoundsPoints(seam, 100, 100)).not.toEqual([]);

    clickButton(el, "Export Hidden-line SVG");

    // The Scene handed `renderPlotterSVG` is the seam CLIPPED to bounds: nothing
    // lies outside the canvas, and it is exactly `clipSceneToBounds` of the seam
    // (clip slotted after the hidden-line pass, before serialization).
    const exported = plotterExportCapture.current?.scene;
    expect(exported).not.toBeNull();
    expect(outOfBoundsPoints(exported, 100, 100)).toEqual([]);
    expect(exported).toEqual(clipSceneToBounds(seam));

    const svg = await blobText(downloadBlob.mock.calls[0]![0]);
    const coordinates = [
      ...svg.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g),
    ].map(([, x, y]) => [Number(x), Number(y)] as const);
    expect(coordinates.length).toBeGreaterThan(0);
    // Harness fallback: 200 mm square with 10 mm on every edge.
    expect(
      coordinates.every(
        ([x, y]) => x >= 10 && x <= 190 && y >= 10 && y <= 190,
      ),
    ).toBe(true);
  });

  // #237 AC3 (concrete): the real Leaf Field sketch (core) run through the full
  // hidden-line export path — generate → hiddenLinePass → clipSceneToBounds —
  // must leave NO output path point outside its own canvas rectangle. This is
  // the acceptance check against a production sketch (not a hand-built Scene).
  it("Leaf Field hidden-line export has no point outside the canvas (#237, AC3)", () => {
    const params = defaultParams(leafField.schema);
    const seed = 12345 as Seed;
    // The hidden-line pass is heavy, so run it ONCE and reuse it for both the
    // pre-clip overflow check and the clipped output.
    const preClip = hiddenLinePass(
      leafField.generate(params, seed, 0, DEFAULT_COMPOSITION_FRAME),
      { tolerance: 0 },
    );
    const exported = clipSceneToBounds(preClip);
    const { width, height } = exported.space;
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    // The sketch genuinely overflows before clipping (the pre-clip seam has
    // out-of-bounds points), so the emptiness below is the clip's doing.
    expect(outOfBoundsPoints(preClip, width, height)).not.toEqual([]);
    // ...and after the clip, every path point lies within [0,0,width,height].
    expect(outOfBoundsPoints(exported, width, height)).toEqual([]);
  });
});

describe("SketchControls — PNG export wiring", () => {
  // A static sketch (no time) for the no-`-t` filename case.
  const staticSketch = (id: string) =>
    sketchWith(id, { radius: numberSpec({ default: 10 }) });

  // A time-driven sketch so the export carries a `-t{t}` segment.
  const timedSketch = (id: string) => {
    const base = staticSketch(id) as unknown as Record<string, unknown>;
    return {
      ...base,
      time: { duration: 4, mode: "loop" },
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  /** Read a Blob's bytes (jsdom-safe, via FileReader → ArrayBuffer). */
  function blobBytes(blob: Blob): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
  }

  /** Extract the iTXt chunk's UTF-8 text payload from a PNG byte stream. */
  function readITxtText(png: Uint8Array): string {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let offset = 8; // skip the signature
    while (offset + 8 <= png.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(
        png[offset + 4]!,
        png[offset + 5]!,
        png[offset + 6]!,
        png[offset + 7]!,
      );
      if (type === "iTXt") {
        const data = png.subarray(offset + 8, offset + 8 + length);
        // keyword | NUL | flag | method | lang+NUL | translated+NUL | text.
        const nul = data.indexOf(0);
        const transEnd = data.indexOf(0, data.indexOf(0, nul + 3) + 1);
        return new TextDecoder().decode(data.subarray(transEnd + 1));
      }
      offset += 12 + length;
    }
    throw new Error("no iTXt chunk found");
  }

  it("snapshots the live canvas and downloads a PNG named for a STATIC sketch (no -t)", async () => {
    const el = mount(<SketchControls sketch={staticSketch("circles")} />);
    const seed = (el.querySelector("#sketch-seed") as HTMLInputElement).value;

    clickButton(el, "Export PNG");
    await flush();

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlob.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    // Static sketch ⇒ no `-t` segment.
    expect(filename).toBe(`circles-seed${seed}.png`);

    // The downloaded PNG carries the reproduction envelope in an iTXt chunk,
    // round-tripping back to the displayed (seed, params, name-stem) — no t. The
    // envelope is now a v2 record (#266) carrying the active Plot Profile (#267),
    // the Harness fallback for this default-less Sketch.
    const json = JSON.parse(readITxtText(await blobBytes(blob)));
    expect(json).toMatchObject({
      version: 2,
      sketch: "circles",
      name: `circles-seed${seed}`,
      seed: Number(seed),
      params: { radius: 10 },
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
    expect("t" in json).toBe(false);
  });

  it("includes the captured -t{t} segment for a time-driven sketch", async () => {
    fakeCurrentT = 2.5; // the handle reports the displayed moment
    const el = mount(<SketchControls sketch={timedSketch("waves")} />);
    const seed = (el.querySelector("#sketch-seed") as HTMLInputElement).value;

    clickButton(el, "Export PNG");
    await flush();

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlob.mock.calls[0]!;
    expect(filename).toBe(`waves-seed${seed}-t2.5.png`);
    // The embedded envelope captures the same moment.
    expect(JSON.parse(readITxtText(await blobBytes(blob))).t).toBe(2.5);
  });

  it("does not download when toBlob yields a null blob (export unsupported)", async () => {
    fakeCanvasToBlob = ((cb: BlobCallback) => {
      cb(null);
    }) as HTMLCanvasElement["toBlob"];
    const el = mount(<SketchControls sketch={staticSketch("circles")} />);

    clickButton(el, "Export PNG");
    await flush();

    expect(downloadBlob).not.toHaveBeenCalled();
  });
});

describe("SketchControls — render-mode toggle wiring (#219)", () => {
  const toggleEl = (el: HTMLElement): HTMLButtonElement => {
    const btn = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    );
    if (btn === null) throw new Error("no render-mode toggle");
    return btn;
  };

  it("defaults to fill and flips the renderMode it passes into LiveCanvas on toggle", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const toggle = toggleEl(el);

    // Default: LiveCanvas receives renderMode="fill", the toggle reads unpressed.
    expect(canvasRenderMode(el)).toBe("fill");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).toBe("Fill");

    // Toggle → the outline mode propagates straight into the LiveCanvas prop.
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(canvasRenderMode(el)).toBe("outline");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toBe("Outline");

    // Toggle again → back to fill (a plain view-only flip, both directions).
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(canvasRenderMode(el)).toBe("fill");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the Fill preview and toggle usable during the quiet Outline interval", () => {
    // Opt out of the auto-clear so the intermediate busy state is observable: the
    // real pass runs asynchronously, so the label must read "Computing…" from the
    // click's own commit until LiveCanvas signals `onOutlineComputed`.
    autoFireOutlineComputed = false;
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const toggle = toggleEl(el);
    expect(toggle.textContent).toBe("Fill");
    expect(toggle.disabled).toBe(false);

    // Click to outline: the busy label is set SYNCHRONOUSLY with the flip (so it
    // paints with the click's commit, before the blocking pass), and the button
    // is disabled + aria-busy. renderMode still propagates to LiveCanvas at once.
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toggle.textContent).toBe("Outline");
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-busy")).toBe("true");
    expect(canvasRenderMode(el)).toBe("fill");

    // The pass finishes → LiveCanvas signals done → the label settles on "Outline"
    // and the control re-enables.
    act(() => {
      lastOnOutlineComputed?.();
    });
    expect(toggle.textContent).toBe("Outline");
    expect(toggle.disabled).toBe(false);
  });

  it("flipping render mode touches no param/seed/lock axis", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const seedBefore = (el.querySelector("#sketch-seed") as HTMLInputElement)
      .value;
    const radiusBefore = paramInput(el, "radius").value;

    act(() => {
      toggleEl(el).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The toggle is view-only: it swapped the canvas render mode but left the
    // param and seed axes exactly as they were.
    expect(canvasRenderMode(el)).toBe("outline");
    expect((el.querySelector("#sketch-seed") as HTMLInputElement).value).toBe(
      seedBefore,
    );
    expect(paramInput(el, "radius").value).toBe(radiusBefore);
    expect(historyCapture.atomic).toHaveLength(0);
    expect(historyCapture.transactionCommits).toHaveLength(0);
  });
});

describe("SketchControls — background Outline session (#289)", () => {
  it("creates a live coordinator after StrictMode rehearsal and disposes each lifetime", () => {
    autoFireOutlineComputed = false;
    const el = mount(
      <StrictMode>
        <SketchControls sketch={sketchWith("a", {})} />
      </StrictMode>,
    );

    expect(outlineJob.coordinators).toBe(2);
    expect(outlineJob.disposals).toBe(1);
    clickButton(el, "Fill");
    expect(outlineJob.starts).toBe(1);
    act(() => lastOnOutlineComputed?.());
    expect(canvasRenderMode(el)).toBe("outline");
    expect(el.textContent).not.toContain("Outline failed");

    act(() => root!.unmount());
    root = null;
    expect(outlineJob.disposals).toBe(2);
  });

  it("cancels at edit begin, launches no preview jobs, and starts one final changed job", () => {
    autoFireOutlineComputed = false;
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    clickButton(el, "Fill");
    expect(outlineJob.starts).toBe(1);
    expect(outlineJob.active).not.toBeNull();

    const radius = paramInput(el, "radius");
    act(() => radius.focus());
    setInput(radius, "42");
    expect(outlineJob.starts).toBe(1);
    expect(outlineJob.active).toBeNull();
    expect(canvasRenderMode(el)).toBe("fill");
    expect(
      el
        .querySelector('[data-testid="canvas-seed"]')
        ?.getAttribute("data-render-state"),
    ).toBe("fill-live");

    act(() =>
      radius.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(outlineJob.starts).toBe(2);
    expect(canvasRenderMode(el)).toBe("fill");
    act(() => lastOnOutlineComputed?.());
    expect(canvasRenderMode(el)).toBe("outline");
  });

  it("reveals Cancel outline only after the 750ms quiet period and keeps ordinary actions usable", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
    vi.useFakeTimers();
    try {
      clickButton(el, "Fill");
      expect(el.textContent).not.toContain("Cancel outline");
      act(() => vi.advanceTimersByTime(749));
      expect(el.textContent).not.toContain("Cancel outline");
      act(() => vi.advanceTimersByTime(1));
      expect(el.textContent).toContain("Cancel outline");
      expect(
        [...el.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Export PNG"),
        )?.disabled,
      ).toBe(false);
      expect(
        [...el.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Export SVG"),
        )?.disabled,
      ).toBe(false);
      expect(
        [...el.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Export Hidden-line SVG"),
        )?.disabled,
      ).toBe(true);
      clickButton(el, "Cancel outline");
      expect(el.textContent).not.toContain("Cancel outline");
      expect(
        el.querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle outline render mode"]',
        )?.textContent,
      ).toBe("Fill");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the quiet period for replacements before and after reveal", () => {
    autoFireOutlineComputed = false;
    let randomValue = 0.1;
    vi.spyOn(Math, "random").mockImplementation(() => {
      randomValue += 0.1;
      return randomValue;
    });
    const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
    vi.useFakeTimers();
    try {
      clickButton(el, "Fill");
      expect(outlineJob.starts).toBe(1);
      act(() => vi.advanceTimersByTime(749));
      clickButton(el, "New seed");
      expect(outlineJob.starts).toBe(2);
      act(() => vi.advanceTimersByTime(1));
      expect(el.textContent).not.toContain("Cancel outline");
      act(() => vi.advanceTimersByTime(748));
      expect(el.textContent).not.toContain("Cancel outline");
      act(() => vi.advanceTimersByTime(1));
      expect(el.textContent).toContain("Cancel outline");

      clickButton(el, "New seed");
      expect(outlineJob.starts).toBe(3);
      expect(el.textContent).not.toContain("Cancel outline");
      act(() => vi.advanceTimersByTime(749));
      expect(el.textContent).not.toContain("Cancel outline");
      act(() => vi.advanceTimersByTime(1));
      expect(el.textContent).toContain("Cancel outline");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a sanitized recoverable failure while logging technical detail", () => {
    autoFireOutlineComputed = false;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
    clickButton(el, "Fill");
    const active = outlineJob.active!;
    act(() => {
      outlineJob.active = null;
      active.resolve({
        status: "failure",
        jobId: 1,
        error: "geometry\u0000 exploded",
      });
    });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "Outline failed: geometry  exploded",
    );
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    expect(toggle.textContent).toBe("Fill");
    expect(toggle.disabled).toBe(false);
    expect(consoleError).toHaveBeenCalled();
  });

  it("reports the full active interval and clears it on keyed unmount", () => {
    autoFireOutlineComputed = false;
    const changes: boolean[] = [];
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {})}
        onHiddenLineBusyChange={(busy) => changes.push(busy)}
      />,
    );
    clickButton(el, "Fill");
    expect(changes.at(-1)).toBe(true);
    act(() => root!.unmount());
    root = null;
    expect(changes.at(-1)).toBe(false);
  });
});
