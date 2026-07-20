// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultParams,
  type ParamSchema,
  type ParamSpec,
  type Params,
} from "@harness/core";

import { ControlPanel } from "./ControlPanel";
import { SketchControls } from "./SketchControls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

function choose(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const numberSpec = (over: Record<string, unknown> = {}): ParamSpec =>
  ({
    kind: "number",
    min: 0,
    max: 100,
    default: 50,
    ...over,
  }) as ParamSpec;

describe("ControlPanel", () => {
  const conditionalSchema = {
    strategy: {
      kind: "choice",
      options: [
        { value: "scribble", label: "Scribble" },
        { value: "stippling", label: "Stippling" },
      ],
      default: "scribble",
    },
    scribbleDensity: {
      kind: "number",
      min: 0,
      max: 100,
      default: 40,
      activeWhen: { key: "strategy", equals: "scribble" },
    },
    stippleSpacing: {
      kind: "number",
      min: 0,
      max: 100,
      default: 60,
      activeWhen: { key: "strategy", equals: "stippling" },
    },
  } as const satisfies ParamSchema;

  it("renders Choice as a lock-free schema-derived control", () => {
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={conditionalSchema}
        params={{
          strategy: "scribble",
          scribbleDensity: 40,
          stippleSpacing: 60,
        }}
        locks={new Set(["strategy"])}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );

    expect(html).toContain("Scribble");
    expect(html).toContain("Stippling");
    expect(html).toContain('id="control-strategy"');
    expect(html).not.toContain('aria-label="strategy lock"');
    expect(html).not.toContain("unsupported control kind");
  });

  it("switches conditional visibility while retained values reappear", () => {
    const onChange = vi.fn();
    const onToggleLock = vi.fn();
    const scribbleParams = {
      strategy: "scribble",
      scribbleDensity: 27,
      stippleSpacing: 83,
    };
    const el = mount(
      <ControlPanel
        schema={conditionalSchema}
        params={scribbleParams}
        locks={new Set(["strategy", "scribbleDensity", "stippleSpacing"])}
        onChange={onChange}
        onToggleLock={onToggleLock}
      />,
    );

    expect(el.querySelector('#control-scribbleDensity')).not.toBeNull();
    expect(el.querySelector('#control-stippleSpacing')).toBeNull();
    expect(el.querySelectorAll('[aria-label$=" lock"]')).toHaveLength(1);

    choose(el.querySelector<HTMLSelectElement>("#control-strategy")!, "stippling");
    expect(onChange).toHaveBeenCalledWith("strategy", "stippling");
    expect(onToggleLock).not.toHaveBeenCalled();

    act(() =>
      root!.render(
        <ControlPanel
          schema={conditionalSchema}
          params={{ ...scribbleParams, strategy: "stippling" }}
          locks={new Set(["strategy", "scribbleDensity", "stippleSpacing"])}
          onChange={onChange}
          onToggleLock={onToggleLock}
        />,
      ),
    );
    expect(el.querySelector('#control-scribbleDensity')).toBeNull();
    expect(
      el.querySelector<HTMLInputElement>('#control-stippleSpacing')?.value,
    ).toBe("83");
    expect(el.querySelectorAll('[aria-label$=" lock"]')).toHaveLength(1);

    act(() =>
      root!.render(
        <ControlPanel
          schema={conditionalSchema}
          params={scribbleParams}
          locks={new Set(["strategy", "scribbleDensity", "stippleSpacing"])}
          onChange={onChange}
          onToggleLock={onToggleLock}
        />,
      ),
    );
    expect(
      el.querySelector<HTMLInputElement>('#control-scribbleDensity')?.value,
    ).toBe("27");
    expect(el.querySelector('#control-stippleSpacing')).toBeNull();
  });

  it("hides inactive rows without mutating values, locks, or callbacks", () => {
    const params = Object.freeze({
      strategy: "scribble",
      scribbleDensity: 27,
      stippleSpacing: 83,
    });
    const locks = new Set(["stippleSpacing"]);
    const onChange = vi.fn();
    const onToggleLock = vi.fn();

    renderToStaticMarkup(
      <ControlPanel
        schema={conditionalSchema}
        params={params}
        locks={locks}
        onChange={onChange}
        onToggleLock={onToggleLock}
      />,
    );

    expect(params).toEqual({
      strategy: "scribble",
      scribbleDensity: 27,
      stippleSpacing: 83,
    });
    expect([...locks]).toEqual(["stippleSpacing"]);
    expect(onChange).not.toHaveBeenCalled();
    expect(onToggleLock).not.toHaveBeenCalled();
  });

  it("fails loudly for malformed applicability and inactive Choice values", () => {
    const malformedDependency = {
      strategy: conditionalSchema.strategy,
      amount: {
        ...conditionalSchema.scribbleDensity,
        activeWhen: { key: "missing", equals: "scribble" },
      },
    } as const satisfies ParamSchema;
    expect(() =>
      renderToStaticMarkup(
        <ControlPanel
          schema={malformedDependency}
          params={{ strategy: "scribble", amount: 40 }}
          locks={new Set()}
          onChange={() => {}}
          onToggleLock={() => {}}
        />,
      ),
    ).toThrow(/missing controller `missing`/);

    const inactiveChoice = {
      ...conditionalSchema,
      stippleQuality: {
        kind: "choice",
        options: [{ value: "fine", label: "Fine" }],
        default: "fine",
        activeWhen: { key: "strategy", equals: "stippling" },
      },
    } as const satisfies ParamSchema;
    expect(() =>
      renderToStaticMarkup(
        <ControlPanel
          schema={inactiveChoice}
          params={{ strategy: "scribble", stippleQuality: "coarse" }}
          locks={new Set()}
          onChange={() => {}}
          onToggleLock={() => {}}
        />,
      ),
    ).toThrow(/Choice param `stippleQuality` value/);
  });

  it("renders exactly one control per schema entry", () => {
    const schema: ParamSchema = {
      radius: numberSpec({ default: 10 }),
      count: numberSpec({ default: 5, integer: true }),
      speed: numberSpec({ default: 1 }),
    };
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={defaultParams(schema)}
        locks={new Set()}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    // One number input per param (the slider is also type=range; count number
    // inputs as the per-control marker).
    const numberInputs = html.match(/type="number"/g) ?? [];
    expect(numberInputs.length).toBe(3);
    // Each param's label is present.
    expect(html).toContain("radius");
    expect(html).toContain("count");
    expect(html).toContain("speed");
  });

  it("nests each control row once (no wrapper duplicating NumberControl's root)", () => {
    // NumberControl's own root is `flex flex-col gap-1.5`. The panel must NOT
    // re-wrap each row in a second `flex flex-col gap-1.5` div — that per-row
    // gap is inert around a single child and duplicates the child's own root.
    // So the class appears exactly once per control (not twice).
    const schema: ParamSchema = {
      radius: numberSpec(),
      count: numberSpec(),
      speed: numberSpec(),
    };
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={defaultParams(schema)}
        locks={new Set()}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    const rowRoots = html.match(/class="flex flex-col gap-1\.5"/g) ?? [];
    expect(rowRoots.length).toBe(3);
  });

  it("routes locks only to numeric controls in a mixed schema", () => {
    const schema: ParamSchema = {
      ink: { kind: "color", default: "#1a2b3c" },
      radius: numberSpec({ default: 10 }),
    };
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={defaultParams(schema)}
        locks={new Set(["ink", "radius"])}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    // A persisted color key is allowed in the generic Set, but the color branch
    // deliberately does not route lock state or a toggle into ColorControl.
    expect(html).toContain('aria-label="ink current color #1a2b3c"');
    expect(html).not.toContain('type="color"');
    expect(html).not.toContain('aria-label="ink lock"');
    expect(html).not.toContain("unsupported control kind");
    // The numeric sibling still receives the same Set's lock membership.
    expect(html).toContain('type="number"');
    expect(html).toContain('aria-label="radius lock" aria-pressed="true"');
  });

  it("resolves an unset color param to its spec default (same fallback as number)", () => {
    const schema: ParamSchema = {
      ink: { kind: "color", default: "#aabbcc" },
    };
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={{}}
        locks={new Set()}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    expect(html).toContain('aria-label="ink current color #aabbcc"');
  });

  it("renders image-asset as a lock-free schema-derived control", () => {
    const value = "pine-cone-0123456789ab";
    const schema: ParamSchema = {
      source: { kind: "image-asset", default: "default-aaaaaaaaaaaa" },
    };
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={{ source: value }}
        locks={new Set(["source"])}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );

    expect(html).toContain(value);
    expect(html).toContain(`src="/image-assets/${value}.png"`);
    expect(html).not.toContain("unsupported control kind");
    expect(html).not.toContain('aria-label="source lock"');
  });

  it("wires exact Image Asset resolution state and retry without edit history", () => {
    const value = "missing-image-0123456789ab";
    const retry = vi.fn();
    const onChange = vi.fn();
    const onBegin = vi.fn();
    const el = mount(
      <ControlPanel
        schema={{
          source: { kind: "image-asset", default: "default-aaaaaaaaaaaa" },
        }}
        params={{ source: value }}
        locks={new Set()}
        onChange={onChange}
        editHistory={{
          onBegin,
          onPreview: vi.fn(),
          onCommit: vi.fn(),
          onCancel: vi.fn(),
        }}
        onToggleLock={() => {}}
        imageAssetResolution={{
          status: "missing",
          failedId: value,
          retry,
        }}
      />,
    );

    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("code")?.textContent).toBe(value);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "Image Asset is missing",
    );
    act(() => {
      [...el.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) => candidate.textContent === "Retry exact asset")!
        .click();
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(onBegin).not.toHaveBeenCalled();
  });

  it("marks only the exact failed Image Asset in a multi-asset schema", () => {
    const missing = "missing-image-0123456789ab";
    const healthy = "healthy-image-abcdef012345";
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={{
          first: { kind: "image-asset", default: "default-aaaaaaaaaaaa" },
          second: { kind: "image-asset", default: "default-bbbbbbbbbbbb" },
        }}
        params={{ first: missing, second: healthy }}
        locks={new Set()}
        onChange={() => {}}
        onToggleLock={() => {}}
        imageAssetResolution={{
          status: "error",
          failedId: missing,
          retry: () => {},
        }}
      />,
    );

    expect((html.match(/Image Asset is unavailable/g) ?? []).length).toBe(1);
    expect((html.match(/Retry exact asset/g) ?? []).length).toBe(1);
    expect(html).not.toContain(`/image-assets/${missing}.png`);
    expect(html).toContain(`/image-assets/${healthy}.png`);
  });

  it("routes each Image Asset row's exact selected ID and dimensions independently", () => {
    const portraitId = "portrait-image-0123456789ab";
    const landscapeId = "landscape-image-abcdef012345";
    const dimensions = new Map([
      [portraitId, { width: 900, height: 1600 }],
      [landscapeId, { width: 1800, height: 1200 }],
    ]);
    const getImageAssetDimensions = vi.fn((id: string) => dimensions.get(id));
    const onRecomposeToImageAspect = vi.fn();
    const el = mount(
      <ControlPanel
        schema={{
          portrait: {
            kind: "image-asset",
            default: "unused-default-aaaaaaaaaaaa",
          },
          landscape: {
            kind: "image-asset",
            default: "unused-default-bbbbbbbbbbbb",
          },
        }}
        params={{ portrait: portraitId, landscape: landscapeId }}
        locks={new Set()}
        onChange={() => {}}
        onToggleLock={() => {}}
        getImageAssetDimensions={getImageAssetDimensions}
        onRecomposeToImageAspect={onRecomposeToImageAspect}
      />,
    );

    const actions = [
      ...el.querySelectorAll<HTMLButtonElement>("button"),
    ].filter(
      (candidate) =>
        candidate.textContent === "Recompose to this image’s aspect",
    );
    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.disabled)).toEqual([false, false]);
    expect(getImageAssetDimensions).toHaveBeenCalledTimes(2);
    expect(getImageAssetDimensions).toHaveBeenNthCalledWith(1, portraitId);
    expect(getImageAssetDimensions).toHaveBeenNthCalledWith(2, landscapeId);

    act(() => {
      actions[1]!.click();
      actions[0]!.click();
    });

    expect(onRecomposeToImageAspect.mock.calls).toEqual([
      [
        {
          paramKey: "landscape",
          imageAssetId: landscapeId,
          dimensions: { width: 1800, height: 1200 },
        },
      ],
      [
        {
          paramKey: "portrait",
          imageAssetId: portraitId,
          dimensions: { width: 900, height: 1600 },
        },
      ],
    ]);
  });

  it("disables only the Image Asset row whose exact decoded record is absent", () => {
    const unavailableId = "unavailable-image-0123456789ab";
    const availableId = "available-image-abcdef012345";
    const getImageAssetDimensions = vi.fn((id: string) =>
      id === availableId ? { width: 1200, height: 800 } : undefined,
    );
    const onRecomposeToImageAspect = vi.fn();
    const el = mount(
      <ControlPanel
        schema={{
          unavailable: {
            kind: "image-asset",
            default: "first-default-aaaaaaaaaaaa",
          },
          available: {
            kind: "image-asset",
            default: "second-default-bbbbbbbbbbbb",
          },
        }}
        params={{ unavailable: unavailableId, available: availableId }}
        locks={new Set()}
        onChange={() => {}}
        onToggleLock={() => {}}
        getImageAssetDimensions={getImageAssetDimensions}
        onRecomposeToImageAspect={onRecomposeToImageAspect}
      />,
    );

    const actions = [
      ...el.querySelectorAll<HTMLButtonElement>("button"),
    ].filter(
      (candidate) =>
        candidate.textContent === "Recompose to this image’s aspect",
    );
    expect(actions.map((action) => action.disabled)).toEqual([true, false]);
    expect(getImageAssetDimensions.mock.calls).toEqual([
      [unavailableId],
      [availableId],
    ]);

    act(() => actions[1]!.click());
    expect(onRecomposeToImageAspect).toHaveBeenCalledTimes(1);
    expect(onRecomposeToImageAspect).toHaveBeenCalledWith({
      paramKey: "available",
      imageAssetId: availableId,
      dimensions: { width: 1200, height: 800 },
    });
  });

  it("uses each row's effective fallback ID without choosing another image", () => {
    const firstDefault = "first-default-0123456789ab";
    const secondSelected = "second-selected-abcdef012345";
    const getImageAssetDimensions = vi.fn((id: string) =>
      id === firstDefault
        ? { width: 640, height: 480 }
        : id === secondSelected
          ? { width: 1000, height: 1000 }
          : undefined,
    );
    const onRecomposeToImageAspect = vi.fn();
    const el = mount(
      <ControlPanel
        schema={{
          first: { kind: "image-asset", default: firstDefault },
          second: {
            kind: "image-asset",
            default: "ignored-default-bbbbbbbbbbbb",
          },
        }}
        params={{ second: secondSelected }}
        locks={new Set()}
        onChange={() => {}}
        onToggleLock={() => {}}
        getImageAssetDimensions={getImageAssetDimensions}
        onRecomposeToImageAspect={onRecomposeToImageAspect}
      />,
    );

    const actions = [
      ...el.querySelectorAll<HTMLButtonElement>("button"),
    ].filter(
      (candidate) =>
        candidate.textContent === "Recompose to this image’s aspect",
    );
    expect(getImageAssetDimensions.mock.calls).toEqual([
      [firstDefault],
      [secondSelected],
    ]);

    act(() => actions[1]!.click());
    expect(onRecomposeToImageAspect).toHaveBeenCalledTimes(1);
    expect(onRecomposeToImageAspect).toHaveBeenCalledWith({
      paramKey: "second",
      imageAssetId: secondSelected,
      dimensions: { width: 1000, height: 1000 },
    });
    expect(onRecomposeToImageAspect).not.toHaveBeenCalledWith(
      expect.objectContaining({ imageAssetId: firstDefault }),
    );
  });

  it("routes an Image Asset choice through the ordinary lock-free setter", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(JSON.stringify(["apple-tree-bbbbbbbbbbbb"])),
      } as Response),
    );
    const onChange = vi.fn();
    const onBegin = vi.fn();
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const el = mount(
      <ControlPanel
        schema={{
          source: {
            kind: "image-asset",
            default: "default-aaaaaaaaaaaa",
          },
        }}
        params={{ source: "current-cccccccccccc" }}
        locks={new Set(["source"])}
        onChange={onChange}
        editHistory={{
          onBegin,
          onPreview,
          onCommit,
          onCancel: vi.fn(),
        }}
        onToggleLock={vi.fn()}
      />,
    );

    act(() => {
      [...el.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) => candidate.textContent === "Choose image")!
        .click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      el.querySelector<HTMLButtonElement>(
        '[aria-label="Image Assets"] button',
      )!.click();
    });

    expect(onChange).toHaveBeenCalledWith(
      "source",
      "apple-tree-bbbbbbbbbbbb",
    );
    expect(onBegin).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(el.querySelector('[aria-label="source lock"]')).toBeNull();
  });

  it("forwards a non-default Image Asset cap into browser normalization", async () => {
    const bitmap = {
      width: 1_000,
      height: 500,
      close: vi.fn(),
    };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    const drawImage = vi.fn();
    vi.spyOn(window.HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(window.HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback: BlobCallback) => {
        callback(new Blob(["normalized"], { type: "image/png" }));
      },
    );
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify(
              init?.method === "POST"
                ? { id: "control-import-bbbbbbbbbbbb", created: true }
                : [],
            ),
          ),
      } as Response),
    );
    const onChange = vi.fn();
    const el = mount(
      <ControlPanel
        schema={{
          source: {
            kind: "image-asset",
            default: "default-aaaaaaaaaaaa",
          },
        }}
        params={{ source: "current-cccccccccccc" }}
        locks={new Set()}
        onChange={onChange}
        onToggleLock={() => {}}
        imageAssetLongEdgeCap={777}
      />,
    );
    act(() => {
      [...el.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) => candidate.textContent === "Choose image")!
        .click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const fileInput = el.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new File(["source"], "Large.webp")],
    });
    act(() =>
      fileInput.dispatchEvent(new Event("change", { bubbles: true })),
    );
    act(() => {
      [...el.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) => candidate.textContent === "Import Image Asset")!
        .click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 777, 389);
    expect(onChange).toHaveBeenCalledWith(
      "source",
      "control-import-bbbbbbbbbbbb",
    );
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("falls image-asset back only for a missing or nonstring runtime value", () => {
    const fallback = "fallback-image-0123456789ab";
    const malformed = "Present Malformed Identity";
    const schema: ParamSchema = {
      source: { kind: "image-asset", default: fallback },
    };
    const render = (params: Params) =>
      renderToStaticMarkup(
        <ControlPanel
          schema={schema}
          params={params}
          locks={new Set()}
          onChange={() => {}}
          onToggleLock={() => {}}
        />,
      );

    expect(render({})).toContain(fallback);
    expect(render({ source: 42 })).toContain(fallback);

    const malformedHtml = render({ source: malformed });
    expect(malformedHtml).toContain(malformed);
    expect(malformedHtml).not.toContain(fallback);
    expect(malformedHtml).not.toContain("<img");
    expect(malformedHtml).not.toContain("/image-assets/");

    const emptyHtml = render({ source: "" });
    expect(emptyHtml).not.toContain(fallback);
    const host = document.createElement("div");
    host.innerHTML = emptyHtml;
    expect(host.querySelector("code")?.textContent).toBe("");
  });

  it("renders a LOUD visible fallback for an unsupported kind (never silent)", () => {
    // An unknown kind that the open ParamSpec union does not (yet) inhabit
    // (color graduated to a real control, so `boolean` stands in here).
    const schema = {
      mystery: { kind: "boolean", default: true },
    } as unknown as ParamSchema;
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={{}}
        locks={new Set()}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    expect(html).toContain("unsupported control kind: boolean");
    // The fallback names the offending param and is an alert (not hidden)...
    expect(html).toContain("mystery");
    expect(html).toContain('role="alert"');
    // ...styled LOUD via the destructive theme token (high-contrast, not silent).
    expect(html).toContain("border-destructive");
  });

  it("reflects the supplied param values in the controls", () => {
    const schema: ParamSchema = { radius: numberSpec({ default: 10 }) };
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={{ radius: 73 }}
        locks={new Set()}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    expect(html).toContain('value="73"');
  });

  it("renders a lock affordance per numeric control, reflecting `locks` membership", () => {
    const schema: ParamSchema = {
      radius: numberSpec(),
      count: numberSpec(),
    };
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={{ radius: 10, count: 5 }}
        locks={new Set(["radius"])}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    // One lock toggle per param — each is the only element carrying aria-pressed.
    expect((html.match(/aria-pressed=/g) ?? []).length).toBe(2);
    // The locked param's toggle is pressed; the unlocked one is not.
    expect(html).toContain('aria-label="radius lock" aria-pressed="true"');
    expect(html).toContain('aria-label="count lock" aria-pressed="false"');
  });

  it("a locked control is NOT disabled — lock excludes from Randomize only", () => {
    const schema: ParamSchema = { radius: numberSpec() };
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={{ radius: 10 }}
        locks={new Set(["radius"])}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    // The lock NEVER gates the input: the control markup carries no `disabled`.
    expect(html).not.toContain("disabled");
  });

  it("adapts the shared lifecycle to a dynamic schema key and keeps lock atomic", () => {
    const previews: Params[] = [];
    const onBegin = vi.fn<[], void>();
    const onCommit = vi.fn<[], void>();
    const onToggleLock = vi.fn<[string], void>();
    const schema: ParamSchema = {
      futureDynamicKey: numberSpec({ default: 10 }),
    };
    const el = mount(
      <ControlPanel
        schema={schema}
        params={{ futureDynamicKey: 10 }}
        locks={new Set()}
        onChange={() => {}}
        editHistory={{
          onBegin,
          onPreview: (next) => previews.push(next),
          onCommit,
          onCancel: () => {},
        }}
        onToggleLock={onToggleLock}
      />,
    );
    const input = el.querySelector<HTMLInputElement>('input[type="number"]')!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;

    act(() => {
      input.focus();
      setter.call(input, "44");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      el
        .querySelector<HTMLButtonElement>(
          'button[aria-label="futureDynamicKey lock"]',
        )!
        .click();
    });

    expect(onBegin).toHaveBeenCalledTimes(1);
    expect(previews).toEqual([{ futureDynamicKey: 44 }]);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onToggleLock).toHaveBeenCalledTimes(1);
    expect(onToggleLock).toHaveBeenCalledWith("futureDynamicKey");
  });
});

describe("SketchControls reset-by-defaults", () => {
  const sketchWith = (id: string, schema: ParamSchema) =>
    ({
      id,
      name: id,
      schema,
      generate: () => ({
        space: { width: 100, height: 100 },
        strokes: [],
      }),
    }) as unknown as Parameters<typeof SketchControls>[0]["sketch"];

  it("seeds controls from the Sketch's defaultParams", () => {
    const sketch = sketchWith("a", {
      radius: numberSpec({ default: 42 }),
    });
    const html = renderToStaticMarkup(<SketchControls sketch={sketch} />);
    expect(html).toContain('value="42"');
  });

  it("a different Sketch (the keyed-remount case) seeds its OWN defaults", () => {
    // App mounts SketchControls with key={sketch.id}, so switching Sketch
    // remounts it and the lazy useState re-seeds from the NEW schema's
    // defaults. Rendering each sketch fresh proves the init pulls per-Sketch
    // defaults (the reset mechanism), independent of any prior instance.
    const a = sketchWith("a", { radius: numberSpec({ default: 42 }) });
    const b = sketchWith("b", { radius: numberSpec({ default: 7 }) });
    expect(renderToStaticMarkup(<SketchControls sketch={a} />)).toContain(
      'value="42"',
    );
    expect(renderToStaticMarkup(<SketchControls sketch={b} />)).toContain(
      'value="7"',
    );
  });
});
