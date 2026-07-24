// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultParams, photoScribble, type Scene } from "@harness/core";

import type { PlotStageRegistrationIdentity } from "./plotStagePreparationProtocol";
import {
  defaultCombinedStageIds,
  PlotSequenceStageControls,
} from "./PlotSequenceStageControls";
import type { PlotSequencePresentation } from "./plotSequencePresentation";
import type {
  RegisteredStageActivity,
  RegisteredStageFreshness,
  RegisteredStageRecord,
  RegisteredStageRecordMap,
} from "./useRegisteredStagePreparation";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const frame = Object.freeze({ width: 20, height: 10 });
const scene: Scene = Object.freeze({ space: frame, primitives: [] });
const registrationIdentity: PlotStageRegistrationIdentity = Object.freeze({
  params: [],
  compositionFrame: frame,
});

function record(
  stageId: "ink-scribble" | "watercolor-forms",
  freshness: RegisteredStageFreshness,
  activity: RegisteredStageActivity = { kind: "idle" },
): RegisteredStageRecord {
  return {
    stageId,
    sourceKind: stageId === "ink-scribble" ? "primary" : "generator",
    registrationIdentity,
    preparationIdentity: {
      sketchId: photoScribble.id,
      stageId,
      params: [],
      compositionFrame: frame,
    },
    expectedRegistrationIdentity: registrationIdentity,
    expectedPreparationIdentity: {
      sketchId: photoScribble.id,
      stageId,
      params: [],
      compositionFrame: frame,
    },
    scene,
    freshness,
    activity,
    outputReady: freshness === "current",
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latestPresentation: PlotSequencePresentation | null = null;

const params = defaultParams(photoScribble.schema);
const baseControlProps = {
  schema: photoScribble.schema,
  params,
  locks: new Set<string>(),
  onChange: () => {},
  onToggleLock: () => {},
} as const;

function Harness({
  records,
  initial = { kind: "isolated", stageId: "ink-scribble" },
  onCancelStage = () => {},
  onRetryStage = () => {},
}: {
  readonly records: RegisteredStageRecordMap;
  readonly initial?: PlotSequencePresentation;
  readonly onCancelStage?: (stageId: string) => void;
  readonly onRetryStage?: (stageId: string) => void;
}) {
  const [presentation, setPresentation] =
    useState<PlotSequencePresentation>(initial);
  latestPresentation = presentation;
  return (
    <PlotSequenceStageControls
      {...baseControlProps}
      declaration={photoScribble.plotSequence!}
      presentation={presentation}
      records={records}
      onPresentationChange={setPresentation}
      onCancelStage={onCancelStage}
      onRetryStage={onRetryStage}
    />
  );
}

function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

function click(el: HTMLElement, label: string): void {
  const button = [...el.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`missing button ${label}`);
  act(() => button.click());
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latestPresentation = null;
});

describe("PlotSequenceStageControls", () => {
  it("switches transient isolated and Combined control groups without duplicating shared controls", () => {
    const cancel = vi.fn();
    const el = mount(
      <Harness
        records={{
          "ink-scribble": record("ink-scribble", "current"),
          "watercolor-forms": record("watercolor-forms", "missing", {
            kind: "preparing",
            progress: { kind: "indeterminate" },
          }),
        }}
        onCancelStage={cancel}
      />,
    );

    const view = el.querySelector(
      '[role="group"][aria-label="Plot Stage view"]',
    )!;
    expect(view.querySelector('button[aria-pressed="true"]')?.textContent).toBe(
      "Ink Scribble",
    );
    expect(el.querySelector("#control-pathDensity")).not.toBeNull();
    expect(el.querySelector("#control-watercolorGamma")).toBeNull();
    expect(
      el.querySelectorAll('[aria-label="imageAsset image asset identity"]'),
    ).toHaveLength(1);

    click(el, "Watercolor Forms");
    expect(latestPresentation).toEqual({
      kind: "isolated",
      stageId: "watercolor-forms",
    });
    expect(el.querySelector("#control-pathDensity")).toBeNull();
    expect(el.querySelector("#control-watercolorGamma")).not.toBeNull();

    click(el, "Combined");
    expect(latestPresentation).toEqual({
      kind: "combined",
      stageIds: ["ink-scribble", "watercolor-forms"],
    });
    expect(el.querySelector("#control-pathDensity")).not.toBeNull();
    expect(el.querySelector("#control-watercolorGamma")).not.toBeNull();
    expect(
      el.querySelectorAll('[aria-label="imageAsset image asset identity"]'),
    ).toHaveLength(1);
    const inkControls = el.querySelector(
      'section[aria-label="Ink Scribble controls"]',
    )!;
    const watercolorControls = el.querySelector(
      'section[aria-label="Watercolor Forms controls"]',
    )!;
    expect(
      inkControls.compareDocumentPosition(watercolorControls) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    click(el, "Ink Scribble");
    expect(el.querySelectorAll("[data-stage-status]")).toHaveLength(2);
    click(el, "Cancel Watercolor Forms");
    expect(cancel).toHaveBeenCalledWith("watercolor-forms");
  });

  it("renders typed Primary progress and ETA beside independent normalized Stage truth", () => {
    const retry = vi.fn();
    const el = mount(
      <Harness
        records={{
          "ink-scribble": record("ink-scribble", "stale", {
            kind: "preparing",
            progress: {
              kind: "shading",
              snapshot: {
                completedWorkUnits: 25,
                totalWorkUnits: 100,
                terminal: false,
              },
              eta: {
                kind: "remaining",
                revision: 2,
                remainingMs: 12_500,
              },
            },
          }),
          "watercolor-forms": record("watercolor-forms", "missing", {
            kind: "failed",
            error: "Watercolor preparation failed locally",
          }),
        }}
        onRetryStage={retry}
      />,
    );

    const ink = el.querySelector('[data-stage-status="ink-scribble"]')!;
    expect(ink.textContent).toContain("Stale");
    expect(ink.textContent).toContain("Primary Shading");
    expect(ink.textContent).toContain("25%");
    expect(ink.textContent).toContain("13 s");
    const progress = ink.querySelector("progress")!;
    expect(progress.value).toBe(25);
    expect(progress.max).toBe(100);

    const watercolor = el.querySelector(
      '[data-stage-status="watercolor-forms"]',
    )!;
    expect(watercolor.textContent).toContain("Missing");
    expect(watercolor.querySelector('[role="alert"]')?.textContent).toContain(
      "failed locally",
    );
    click(el, "Retry Watercolor Forms");
    expect(retry).toHaveBeenCalledWith("watercolor-forms");
    expect(el.querySelectorAll("progress")).toHaveLength(1);
  });

  it("distinguishes unavailable and absent Stage records without synthesizing activity", () => {
    const el = mount(
      <Harness
        records={{
          "ink-scribble": record("ink-scribble", "unavailable"),
        }}
      />,
    );

    expect(
      el.querySelector('[data-stage-status="ink-scribble"]')?.textContent,
    ).toContain("Unavailable");
    expect(
      el.querySelector('[data-stage-status="watercolor-forms"]')?.textContent,
    ).toContain("Missing");
    expect(el.querySelector("progress")).toBeNull();
    expect(
      [...el.querySelectorAll("button")].some(
        (button) =>
          button.textContent?.startsWith("Cancel") ||
          button.textContent?.startsWith("Retry"),
      ),
    ).toBe(false);
  });

  it("uses an explicit Primary-back Combined order without changing authored physical order", () => {
    const declaration = photoScribble.plotSequence!;
    expect(declaration.stages.map((stage) => stage.id)).toEqual([
      "watercolor-forms",
      "ink-scribble",
    ]);
    expect(defaultCombinedStageIds(declaration)).toEqual([
      "ink-scribble",
      "watercolor-forms",
    ]);
    expect(declaration.stages.map((stage) => stage.id)).toEqual([
      "watercolor-forms",
      "ink-scribble",
    ]);
  });
});
