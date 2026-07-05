// @vitest-environment jsdom
import { act, useImperativeHandle, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { crc32, type ParamSchema, type Preset, type Seed } from "@harness/core";

import type { LiveCanvasHandle } from "./LiveCanvas";
import { SketchControls } from "./SketchControls";

// The fake canvas node the mocked LiveCanvas hands back through its handle, with
// a `toBlob` the export test drives. Reassigned per-test so each case controls
// the blob the export receives (or a null blob to exercise the guard).
let fakeCanvasToBlob: HTMLCanvasElement["toBlob"];
// The current-t the mocked handle reports — the export's `-t{t}` source.
let fakeCurrentT = 0;

// LiveCanvas is a browser-only sink (canvas2d, ResizeObserver, matchMedia) and
// is NOT under test here — these are wiring tests for the control state. Replace
// it with a probe that surfaces the `seed` it is fed into the DOM AND wires the
// `handleRef` to a fake canvas + current-t, so we can assert the seed the canvas
// receives AND drive the PNG export without polyfilling the whole canvas stack.
vi.mock("./LiveCanvas", () => ({
  LiveCanvas: ({
    seed,
    handleRef,
  }: {
    seed: Seed;
    handleRef?: Ref<LiveCanvasHandle>;
  }) => {
    useImperativeHandle(handleRef, () => ({
      getCanvas: () =>
        ({ toBlob: fakeCanvasToBlob }) as unknown as HTMLCanvasElement,
      getCurrentT: () => fakeCurrentT,
    }));
    return <div data-testid="canvas-seed">{String(seed)}</div>;
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
  // Sensible defaults so a mount's list-on-mount effect resolves quietly; the
  // save/reload tests override loadPreset/savePreset per case.
  listPresets.mockResolvedValue([]);
  loadPreset.mockReset();
  savePreset.mockReset().mockResolvedValue(undefined);
  // Export defaults: a toBlob that yields a non-null, valid PNG blob, t = 0, and
  // a fresh downloadBlob spy. Per-test overrides drive the time-gated / guard
  // cases. The blob is a real minimal PNG so the metadata byte-splice succeeds.
  fakeCurrentT = 0;
  fakeCanvasToBlob = ((cb: BlobCallback) => {
    cb(new Blob([MINIMAL_PNG], { type: "image/png" }));
  }) as HTMLCanvasElement["toBlob"];
  downloadBlob.mockReset();
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
    // ...and the controlled input reflects that unchanged state (not "" or "0").
    expect((el.querySelector("#sketch-seed") as HTMLInputElement).value).toBe(
      "12345",
    );
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

describe("SketchControls — SVG export wiring", () => {
  // A Scene the mocked sketch.generate returns — its single Primitive lets the
  // test assert the downloaded SVG is the serialized vector of THAT Scene.
  const svgScene = {
    space: { width: 100, height: 100 },
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
    expect(svg).toMatch(/<path\b[^>]*fill="tomato"/);
    // Static sketch ⇒ no `-t` segment, `.svg` extension.
    expect(filename).toBe(`circles-seed${seed}.svg`);

    // The SVG embeds the reproduction envelope in a <metadata> element (#76),
    // round-tripping back to the displayed (seed, params, name-stem) — no t.
    const meta = svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1];
    expect(meta).toBeDefined();
    expect(JSON.parse(meta!)).toMatchObject({
      version: 1,
      sketch: "circles",
      name: `circles-seed${seed}`,
      seed: Number(seed),
      params: { radius: 10 },
      locks: [],
    });
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
    // round-tripping back to the displayed (seed, params, name-stem) — no t.
    const json = JSON.parse(readITxtText(await blobBytes(blob)));
    expect(json).toMatchObject({
      version: 1,
      sketch: "circles",
      name: `circles-seed${seed}`,
      seed: Number(seed),
      params: { radius: 10 },
      locks: [],
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
