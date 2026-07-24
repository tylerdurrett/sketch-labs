// @vitest-environment jsdom
import {
  act,
  StrictMode,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ParamSchema,
  PlotSequenceDeclaration,
  Scene,
} from "@harness/core";

import type {
  PlotStagePreparationInput,
  PlotStagePreparationResult,
} from "./plotStageCoordinator";
import { selectPlotStage } from "./plotStageSession";
import {
  createGeneratedStageExpectedIdentities,
  useGeneratedStagePreparation,
  type GeneratedStageAuthoredState,
  type GeneratedStageIdentitySketch,
  type GeneratedStagePreparationCoordinator,
  type UseGeneratedStagePreparationResult,
} from "./useGeneratedStagePreparation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const schema: ParamSchema = {
  shared: { kind: "number", min: 0, max: 100, default: 1 },
  primary: { kind: "number", min: 0, max: 100, default: 2 },
  localA: { kind: "number", min: 0, max: 100, default: 3 },
  localB: { kind: "number", min: 0, max: 100, default: 4 },
};
const declaration: PlotSequenceDeclaration = {
  sharedParameters: [{ schemaKey: "shared", key: "shared" }],
  stages: [
    {
      id: "primary",
      name: "Primary",
      source: { kind: "primary", generatorId: "ink" },
      parameters: [{ schemaKey: "primary", key: "amount" }],
      dependencies: { usesSeed: true, usesTime: true },
    },
    {
      id: "stage-a",
      name: "Stage A",
      source: {
        kind: "generator",
        generatorId: "shared-generator",
        generate: ({ frame }) => ({ space: frame, primitives: [] }),
      },
      parameters: [{ schemaKey: "localA", key: "amount" }],
      dependencies: { usesSeed: false, usesTime: false },
    },
    {
      id: "stage-b",
      name: "Stage B",
      source: {
        kind: "generator",
        generatorId: "shared-generator",
        generate: ({ frame }) => ({ space: frame, primitives: [] }),
      },
      parameters: [{ schemaKey: "localB", key: "amount" }],
      dependencies: { usesSeed: true, usesTime: true },
    },
  ],
};
const sketch: GeneratedStageIdentitySketch = {
  id: "generated-stage-test",
  schema,
  plotSequence: declaration,
};
const frame = { width: 20, height: 10 };
const scene: Scene = {
  space: frame,
  primitives: [{ points: [[0, 0], [1, 1]] }],
};

function authored(
  changes: Partial<{
    shared: number;
    primary: number;
    localA: number;
    localB: number;
    seed: string | number;
    sampledT: number;
    width: number;
  }> = {},
): GeneratedStageAuthoredState {
  return {
    params: {
      shared: changes.shared ?? 1,
      primary: changes.primary ?? 2,
      localA: changes.localA ?? 3,
      localB: changes.localB ?? 4,
    },
    seed: changes.seed ?? "seed-a",
    sampledT: changes.sampledT ?? 0.25,
    compositionFrame: {
      width: changes.width ?? frame.width,
      height: frame.height,
    },
  };
}

interface StartedJob {
  readonly input: PlotStagePreparationInput;
  readonly resolve: (result: PlotStagePreparationResult) => void;
}

class FakeCoordinator implements GeneratedStagePreparationCoordinator {
  readonly starts: StartedJob[] = [];
  cancelCount = 0;
  disposeCount = 0;

  start(input: PlotStagePreparationInput): Promise<PlotStagePreparationResult> {
    return new Promise((resolve) => {
      this.starts.push({ input, resolve });
    });
  }

  cancel(): boolean {
    this.cancelCount += 1;
    return true;
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

function succeed(job: StartedJob, jobId = 1): void {
  job.resolve({
    status: "success",
    jobId,
    identity: job.input.identity,
    registrationIdentity: job.input.registrationIdentity,
    scene,
  });
}

function fail(job: StartedJob, error = "stage failed", jobId = 1): void {
  job.resolve({ status: "failure", jobId, error });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: UseGeneratedStagePreparationResult | null = null;

function Probe({
  activeSketch = sketch,
  initial = authored(),
  createCoordinator,
  view = "primary",
  demandOnMount,
}: {
  readonly activeSketch?: GeneratedStageIdentitySketch;
  readonly initial?: GeneratedStageAuthoredState;
  readonly createCoordinator: () => FakeCoordinator;
  readonly view?: string;
  readonly demandOnMount?: string;
}) {
  void view;
  const preparation = useGeneratedStagePreparation({
    sketch: activeSketch,
    initial,
    coordinatorFactory: createCoordinator,
  });
  latest = preparation;
  useLayoutEffect(() => {
    if (demandOnMount !== undefined) preparation.demand(demandOnMount);
  }, [demandOnMount, preparation.demand]);
  return null;
}

function mount(node: ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

async function flush(): Promise<void> {
  await act(async () => Promise.resolve());
}

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
});

describe("useGeneratedStagePreparation", () => {
  it("derives only generator Stage identities with dependency-aware Seed and time", () => {
    const expected = createGeneratedStageExpectedIdentities(sketch, authored());

    expect(Object.keys(expected)).toEqual(["stage-a", "stage-b"]);
    expect(expected["stage-a"]!.identity).toMatchObject({
      sketchId: sketch.id,
      stageId: "stage-a",
      params: [
        { key: "shared", value: 1 },
        { key: "amount", value: 3 },
      ],
    });
    expect(expected["stage-a"]!.identity).not.toHaveProperty("seed");
    expect(expected["stage-a"]!.identity).not.toHaveProperty("sampledT");
    expect(expected["stage-b"]!.identity).toMatchObject({
      stageId: "stage-b",
      seed: "seed-a",
      sampledT: 0.25,
      params: [
        { key: "shared", value: 1 },
        { key: "amount", value: 4 },
      ],
    });
    expect(expected["stage-a"]!.registrationIdentity).toBe(
      expected["stage-b"]!.registrationIdentity,
    );
  });

  it("stays worker-lazy in Primary and constructs only an explicitly demanded supporting Stage", () => {
    const coordinators: FakeCoordinator[] = [];
    mount(
      <Probe
        createCoordinator={() => {
          const coordinator = new FakeCoordinator();
          coordinators.push(coordinator);
          return coordinator;
        }}
      />,
    );

    expect(coordinators).toHaveLength(0);
    expect(selectPlotStage(latest!.session, "stage-a")).toMatchObject({
      demanded: false,
      pending: null,
      active: null,
    });

    act(() => {
      latest!.demand("primary");
      latest!.demand("missing");
    });
    expect(coordinators).toHaveLength(0);

    act(() => latest!.demand("stage-a"));
    expect(coordinators).toHaveLength(1);
    expect(coordinators[0]!.starts).toHaveLength(1);
    expect(coordinators[0]!.starts[0]!.input.identity.stageId).toBe("stage-a");
    expect(selectPlotStage(latest!.session, "stage-b")?.demanded).toBe(false);
  });

  it("invalidates only local owners, but shared and Composition Frame edits invalidate both", async () => {
    const coordinators: FakeCoordinator[] = [];
    mount(
      <Probe
        createCoordinator={() => {
          const coordinator = new FakeCoordinator();
          coordinators.push(coordinator);
          return coordinator;
        }}
      />,
    );
    act(() => {
      latest!.demand("stage-a");
      latest!.demand("stage-b");
    });
    succeed(coordinators[0]!.starts[0]!);
    succeed(coordinators[1]!.starts[0]!);
    await flush();

    act(() => latest!.requestAtomic(authored({ localA: 8, primary: 9 })));
    expect(coordinators[0]!.starts).toHaveLength(2);
    expect(coordinators[1]!.starts).toHaveLength(1);
    succeed(coordinators[0]!.starts[1]!, 2);
    await flush();

    act(() => latest!.requestAtomic(authored({ shared: 7, width: 30 })));
    expect(coordinators[0]!.starts).toHaveLength(3);
    expect(coordinators[1]!.starts).toHaveLength(2);
    expect(
      coordinators[0]!.starts[2]!.input.registrationIdentity,
    ).toMatchObject({
      params: [{ key: "shared", value: 7 }],
      compositionFrame: { width: 30, height: 10 },
    });
  });

  it("uses declared Seed and time dependencies without invalidating an unseeded Stage", async () => {
    const coordinators: FakeCoordinator[] = [];
    mount(
      <Probe
        createCoordinator={() => {
          const coordinator = new FakeCoordinator();
          coordinators.push(coordinator);
          return coordinator;
        }}
      />,
    );
    act(() => {
      latest!.demand("stage-a");
      latest!.demand("stage-b");
    });
    succeed(coordinators[0]!.starts[0]!);
    succeed(coordinators[1]!.starts[0]!);
    await flush();

    act(() =>
      latest!.requestAtomic(authored({ seed: "seed-b", sampledT: 0.75 })),
    );

    expect(coordinators[0]!.starts).toHaveLength(1);
    expect(coordinators[1]!.starts).toHaveLength(2);
    expect(coordinators[1]!.starts[1]!.input).toMatchObject({
      seed: "seed-b",
      sampledT: 0.75,
      identity: { seed: "seed-b", sampledT: 0.75 },
    });
  });

  it("coalesces transaction previews and launches only the settled identity", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe createCoordinator={() => coordinator} />);
    act(() => latest!.demand("stage-a"));
    succeed(coordinator.starts[0]!);
    await flush();

    act(() => latest!.beginTransaction());
    act(() => latest!.previewAuthoredState(authored({ localA: 5 })));
    act(() => latest!.previewAuthoredState(authored({ localA: 6 })));
    expect(coordinator.starts).toHaveLength(1);

    act(() => latest!.settleTransaction(authored({ localA: 7 })));
    expect(coordinator.starts).toHaveLength(2);
    expect(coordinator.starts[1]!.input.identity.params).toEqual([
      { key: "shared", value: 1 },
      { key: "amount", value: 7 },
    ]);
  });

  it("does not cancel demanded work when only the current view changes", () => {
    const coordinator = new FakeCoordinator();
    const render = (view: string) => (
      <Probe view={view} createCoordinator={() => coordinator} />
    );
    mount(render("primary"));
    act(() => latest!.demand("stage-a"));

    act(() => root!.render(render("stage-a")));
    act(() => root!.render(render("primary")));

    expect(coordinator.cancelCount).toBe(0);
    expect(selectPlotStage(latest!.session, "stage-a")?.active).not.toBeNull();
  });

  it("cancels superseded ownership and relaunches only while demand remains", () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe createCoordinator={() => coordinator} />);
    act(() => latest!.demand("stage-a"));

    act(() => latest!.requestAtomic(authored({ localA: 8 })));
    expect(coordinator.cancelCount).toBe(1);
    expect(coordinator.starts).toHaveLength(2);
    expect(coordinator.starts[1]!.input.identity.params[1]!.value).toBe(8);

    act(() => latest!.cancel("stage-a"));
    expect(coordinator.cancelCount).toBe(2);
    act(() => latest!.requestAtomic(authored({ localA: 9 })));
    expect(coordinator.starts).toHaveLength(2);
    expect(selectPlotStage(latest!.session, "stage-a")?.demanded).toBe(false);
  });

  it("keeps Stage-local retry and cancel intent stable across view changes", async () => {
    const coordinator = new FakeCoordinator();
    const render = (view: string) => (
      <Probe view={view} createCoordinator={() => coordinator} />
    );
    mount(render("stage-a"));
    act(() => latest!.demand("stage-a"));
    fail(coordinator.starts[0]!);
    await flush();
    expect(selectPlotStage(latest!.session, "stage-a")?.failure?.error).toBe(
      "stage failed",
    );

    act(() => root!.render(render("primary")));
    act(() => latest!.retry("stage-a"));
    expect(coordinator.starts).toHaveLength(2);

    act(() => latest!.cancel("stage-a"));
    act(() => root!.render(render("combined")));
    expect(selectPlotStage(latest!.session, "stage-a")?.demanded).toBe(false);
    expect(coordinator.starts).toHaveLength(2);
  });

  it("owns duplicate-generator Stages separately and disposes every demanded coordinator on replacement", () => {
    const coordinators: FakeCoordinator[] = [];
    const createCoordinator = () => {
      const coordinator = new FakeCoordinator();
      coordinators.push(coordinator);
      return coordinator;
    };
    mount(<Probe key="first" createCoordinator={createCoordinator} />);
    act(() => {
      latest!.demand("stage-a");
      latest!.demand("stage-b");
    });

    expect(coordinators).toHaveLength(2);
    expect(
      coordinators.map(
        (coordinator) => coordinator.starts[0]!.input.identity.stageId,
      ),
    ).toEqual(["stage-a", "stage-b"]);
    expect(Object.keys(latest!.session.stages)).toEqual(["stage-a", "stage-b"]);

    act(() =>
      root!.render(
        <Probe key="replacement" createCoordinator={createCoordinator} />,
      ),
    );
    expect(coordinators[0]!.disposeCount).toBe(1);
    expect(coordinators[1]!.disposeCount).toBe(1);
    expect(coordinators).toHaveLength(2);
    expect(selectPlotStage(latest!.session, "stage-a")?.demanded).toBe(false);
  });

  it("recreates one demanded job after StrictMode rehearsal and disposes the retiring coordinator", () => {
    const coordinators: FakeCoordinator[] = [];
    mount(
      <StrictMode>
        <Probe
          demandOnMount="stage-a"
          createCoordinator={() => {
            const coordinator = new FakeCoordinator();
            coordinators.push(coordinator);
            return coordinator;
          }}
        />
      </StrictMode>,
    );

    expect(coordinators).toHaveLength(2);
    expect(coordinators[0]!.disposeCount).toBe(1);
    expect(coordinators[0]!.starts).toHaveLength(1);
    expect(coordinators[1]!.starts).toHaveLength(1);
    expect(selectPlotStage(latest!.session, "stage-a")?.active?.token).toBe(2);
  });
});
