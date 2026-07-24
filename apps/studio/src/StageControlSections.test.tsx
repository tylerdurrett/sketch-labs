// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultParams,
  photoScribble,
  type ParamSchema,
  type Params,
} from "@harness/core";

import { StageControlSections } from "./StageControlSections";

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

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

const params = defaultParams(photoScribble.schema);
const baseProps = {
  schema: photoScribble.schema,
  params,
  locks: new Set<string>(),
  onChange: () => {},
  onToggleLock: () => {},
  plotSequence: photoScribble.plotSequence,
} as const;

const watercolorKeys = [
  "watercolorGamma",
  "watercolorContrast",
  "watercolorPivot",
  "watercolorFormDetail",
  "watercolorColorSensitivity",
  "watercolorBoundaryStrength",
  "watercolorBoundarySmoothing",
] as const;

const inkKeys = [
  "toneContrast",
  "tonePivot",
  "toneGamma",
  "detailSensitivity",
  "detailInfluence",
  "pathDensity",
  "scribbleScale",
  "momentum",
  "chaos",
  "toneFidelity",
  "stopPoint",
] as const;

describe("StageControlSections", () => {
  it("renders shared Image Asset once plus the complete isolated Watercolor Stage", () => {
    const html = renderToStaticMarkup(
      <StageControlSections
        {...baseProps}
        presentation={{ kind: "isolated", stageId: "watercolor-forms" }}
      />,
    );

    expect(
      (html.match(/aria-label="imageAsset image asset identity"/g) ?? []),
    ).toHaveLength(1);
    for (const key of watercolorKeys) {
      expect(html).toContain(`id="control-${key}"`);
    }
    for (const key of inkKeys) {
      expect(html).not.toContain(`id="control-${key}"`);
    }
  });

  it("renders shared Image Asset once plus the complete isolated Ink Stage", () => {
    const html = renderToStaticMarkup(
      <StageControlSections
        {...baseProps}
        presentation={{ kind: "isolated", stageId: "ink-scribble" }}
      />,
    );

    expect(
      (html.match(/aria-label="imageAsset image asset identity"/g) ?? []),
    ).toHaveLength(1);
    for (const key of inkKeys) {
      expect(html).toContain(`id="control-${key}"`);
    }
    for (const key of watercolorKeys) {
      expect(html).not.toContain(`id="control-${key}"`);
    }
  });

  it("labels complete Combined Stage sections in explicit presentation order", () => {
    const html = renderToStaticMarkup(
      <StageControlSections
        {...baseProps}
        presentation={{
          kind: "combined",
          stageIds: ["ink-scribble", "watercolor-forms"],
        }}
      />,
    );

    expect(
      (html.match(/aria-label="imageAsset image asset identity"/g) ?? []),
    ).toHaveLength(1);
    expect(html).toContain('aria-label="Ink Scribble controls"');
    expect(html).toContain('aria-label="Watercolor Forms controls"');
    expect(html.indexOf("Ink Scribble controls")).toBeLessThan(
      html.indexOf("Watercolor Forms controls"),
    );
    for (const key of [...inkKeys, ...watercolorKeys]) {
      expect(html).toContain(`id="control-${key}"`);
    }
  });

  it("preserves edit transactions, Locks, and shared Image Asset recomposition", () => {
    const previews: Params[] = [];
    const onParamEditBegin = vi.fn();
    const onCommit = vi.fn();
    const onToggleLock = vi.fn();
    const onRecomposeToImageAspect = vi.fn();
    const el = mount(
      <StageControlSections
        {...baseProps}
        locks={new Set(["watercolorGamma"])}
        editHistory={{
          onBegin: vi.fn(),
          onPreview: (next) => previews.push(next),
          onCommit,
          onCancel: vi.fn(),
        }}
        onParamEditBegin={onParamEditBegin}
        onToggleLock={onToggleLock}
        getImageAssetDimensions={() => ({ width: 900, height: 1_600 })}
        onRecomposeToImageAspect={onRecomposeToImageAspect}
        presentation={{
          kind: "combined",
          stageIds: ["watercolor-forms", "ink-scribble"],
        }}
      />,
    );

    const input = el.querySelector<HTMLInputElement>(
      "#control-watercolorGamma",
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      input.focus();
      setter.call(input, "0.75");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      el
        .querySelector<HTMLButtonElement>(
          'button[aria-label="watercolorGamma lock"]',
        )!
        .click();
      [...el.querySelectorAll<HTMLButtonElement>("button")]
        .find(
          (button) =>
            button.textContent === "Recompose to this image’s aspect",
        )!
        .click();
    });

    expect(onParamEditBegin).toHaveBeenCalledWith("watercolorGamma");
    expect(previews).toHaveLength(1);
    expect(previews[0]).toEqual({ ...params, watercolorGamma: 0.75 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onToggleLock).toHaveBeenCalledWith("watercolorGamma");
    expect(onRecomposeToImageAspect).toHaveBeenCalledWith({
      paramKey: "imageAsset",
      imageAssetId: params.imageAsset,
      dimensions: { width: 900, height: 1_600 },
    });
  });

  it("leaves ordinary non-Sequence schemas as one unchanged ControlPanel", () => {
    const schema = {
      alpha: { kind: "number", min: 0, max: 10, default: 2 },
      beta: { kind: "number", min: 0, max: 10, default: 3 },
    } as const satisfies ParamSchema;
    const html = renderToStaticMarkup(
      <StageControlSections
        schema={schema}
        params={defaultParams(schema)}
        locks={new Set()}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );

    expect(html).toContain('id="control-alpha"');
    expect(html).toContain('id="control-beta"');
    expect(html).not.toContain("data-stage-controls");
  });
});
