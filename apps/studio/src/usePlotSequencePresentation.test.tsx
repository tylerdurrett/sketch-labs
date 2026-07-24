// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PlotSequenceDeclaration,
  PlotStageGenerator,
  Scene,
} from "@harness/core";

import type { PlotStageRegistrationIdentity } from "./plotStagePreparationProtocol";
import type { PlotSequencePresentation } from "./plotSequencePresentation";
import type {
  RegisteredStageRecord,
  RegisteredStageRecordMap,
} from "./useRegisteredStagePreparation";
import {
  usePlotSequencePresentation,
  type PlotSequencePresentationController,
} from "./usePlotSequencePresentation";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const frame = Object.freeze({ width: 20, height: 10 });
const generate: PlotStageGenerator = () => scene("generated");
const declaration: PlotSequenceDeclaration = {
  sharedParameters: [],
  stages: [
    {
      id: "watercolor",
      name: "Watercolor",
      source: { kind: "generator", generatorId: "watercolor", generate },
      parameters: [],
      dependencies: { usesSeed: false, usesTime: false },
    },
    {
      id: "ink",
      name: "Ink",
      source: { kind: "primary", generatorId: "ink" },
      parameters: [],
      dependencies: { usesSeed: true, usesTime: false },
    },
  ],
};

function scene(label: string): Scene {
  return {
    space: frame,
    primitives: [
      {
        points: [
          [label.length, 0],
          [label.length + 1, 1],
        ],
      },
    ],
  };
}

function registration(revision: number): PlotStageRegistrationIdentity {
  return {
    params: [{ key: "asset", value: revision }],
    compositionFrame: frame,
  };
}

function record(
  stageId: "ink" | "watercolor",
  retained: Scene,
  revision: number,
): RegisteredStageRecord {
  const identity = registration(revision);
  return {
    stageId,
    sourceKind: stageId === "ink" ? "primary" : "generator",
    registrationIdentity: identity,
    preparationIdentity: {
      sketchId: "sequence",
      stageId,
      params: [],
      compositionFrame: frame,
    },
    expectedRegistrationIdentity: identity,
    expectedPreparationIdentity: {
      sketchId: "sequence",
      stageId,
      params: [],
      compositionFrame: frame,
    },
    scene: retained,
    freshness: "current",
    activity: { kind: "idle" },
    outputReady: true,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: PlotSequencePresentationController | null = null;

function Probe({
  records,
  demand,
  initialPresentation,
}: {
  readonly records: RegisteredStageRecordMap;
  readonly demand: (stageId: string) => void;
  readonly initialPresentation?: PlotSequencePresentation;
}) {
  latest = usePlotSequencePresentation({
    declaration,
    records,
    demand,
    ...(initialPresentation === undefined ? {} : { initialPresentation }),
  });
  return null;
}

function mount(node: ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

function rerender(node: ReactNode): void {
  act(() => root!.render(node));
}

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
});

describe("usePlotSequencePresentation", () => {
  it("defaults to isolated Primary with zero generated demand", () => {
    const demand = vi.fn();
    const ink = scene("ink");
    mount(<Probe records={{ ink: record("ink", ink, 1) }} demand={demand} />);

    expect(latest!.presentation).toEqual({
      kind: "isolated",
      stageId: "ink",
    });
    expect(latest!.snapshot.scene).toBe(ink);
    expect(demand).not.toHaveBeenCalled();
  });

  it("demands supporting and Combined views without cancelling on exit", () => {
    const demand = vi.fn();
    mount(<Probe records={{}} demand={demand} />);

    act(() =>
      latest!.setPresentation({
        kind: "isolated",
        stageId: "watercolor",
      }),
    );
    expect(demand).toHaveBeenLastCalledWith("watercolor");

    act(() => latest!.setPresentation({ kind: "isolated", stageId: "ink" }));
    expect(demand).toHaveBeenCalledTimes(1);

    act(() =>
      latest!.setPresentation({
        kind: "combined",
        stageIds: ["ink", "watercolor"],
      }),
    );
    expect(demand).toHaveBeenCalledTimes(2);
    expect(demand).toHaveBeenLastCalledWith("watercolor");
  });

  it("holds the last coherent Combined while shared revisions arrive separately", () => {
    const demand = vi.fn();
    const combined: PlotSequencePresentation = {
      kind: "combined",
      stageIds: ["ink", "watercolor"],
    };
    const oldInk = scene("old-ink");
    const oldWatercolor = scene("old-watercolor");
    const oldRecords = {
      ink: record("ink", oldInk, 1),
      watercolor: record("watercolor", oldWatercolor, 1),
    };
    mount(
      <Probe
        records={oldRecords}
        demand={demand}
        initialPresentation={combined}
      />,
    );
    const coherent = latest!.snapshot.scene;
    expect(coherent?.primitives).toEqual([
      oldInk.primitives[0],
      oldWatercolor.primitives[0],
    ]);

    rerender(
      <Probe
        records={{
          ink: record("ink", scene("new-ink"), 2),
          watercolor: oldRecords.watercolor,
        }}
        demand={demand}
        initialPresentation={combined}
      />,
    );

    expect(latest!.snapshot.held).toBe(true);
    expect(latest!.snapshot.scene).toBe(coherent);
  });
});
