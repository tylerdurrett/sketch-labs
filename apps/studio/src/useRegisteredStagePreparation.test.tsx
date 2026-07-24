// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ParamSchema,
  PlotSequenceDeclaration,
  Scene,
  ShadingDiagnostics,
} from "@harness/core";

import type {
  PlotStagePreparationInput,
  PlotStagePreparationResult,
} from "./plotStageCoordinator";
import type {
  ShadingComputeResult,
  ShadingProgressObserver,
} from "./shadingCoordinator";
import type { ShadingComputeIdentity } from "./shadingComputeProtocol";
import type { GeneratedStagePreparationCoordinator } from "./useGeneratedStagePreparation";
import {
  useRegisteredStagePreparation,
  type RegisteredStageAuthoredState,
  type RegisteredStagePreparationSketch,
  type UseRegisteredStagePreparationResult,
} from "./useRegisteredStagePreparation";
import type { ShadingPreparationCoordinator } from "./useShadingPreparation";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const frame = { width: 20, height: 10 };
const primaryScene: Scene = {
  space: frame,
  primitives: [
    {
      points: [
        [0, 0],
        [2, 2],
      ],
    },
  ],
};
const generatedScene: Scene = {
  space: frame,
  primitives: [
    {
      points: [
        [3, 3],
        [4, 4],
      ],
    },
  ],
};
const diagnostics: ShadingDiagnostics = {
  termination: "completed",
  pathLength: 2,
  polylineCount: 1,
  penLiftCount: 0,
  fidelity: { kind: "scribble", residualError: 0.1 },
};

const schema: ParamSchema = {
  shared: { kind: "number", min: 0, max: 100, default: 1 },
  ink: { kind: "number", min: 0, max: 100, default: 2 },
  washA: { kind: "number", min: 0, max: 100, default: 3 },
  washB: { kind: "number", min: 0, max: 100, default: 4 },
};
const generator = ({
  frame: outputFrame,
}: {
  readonly frame: typeof frame;
}) => ({
  space: outputFrame,
  primitives: [],
});
const declaration: PlotSequenceDeclaration = {
  sharedParameters: [{ schemaKey: "shared", key: "image" }],
  stages: [
    {
      id: "wash-a",
      name: "Wash A",
      source: {
        kind: "generator",
        generatorId: "reused-wash",
        generate: generator,
      },
      parameters: [{ schemaKey: "washA", key: "amount" }],
      dependencies: { usesSeed: false, usesTime: false },
    },
    {
      id: "ink",
      name: "Ink",
      source: { kind: "primary", generatorId: "ink" },
      parameters: [{ schemaKey: "ink", key: "amount" }],
      dependencies: { usesSeed: true, usesTime: false },
    },
    {
      id: "wash-b",
      name: "Wash B",
      source: {
        kind: "generator",
        generatorId: "reused-wash",
        generate: generator,
      },
      parameters: [{ schemaKey: "washB", key: "amount" }],
      dependencies: { usesSeed: true, usesTime: true },
    },
  ],
};
const sketch: RegisteredStagePreparationSketch = {
  id: "registered-stage-test",
  schema,
  plotSequence: declaration,
  generateShadingArtwork: () => ({
    scene: primaryScene,
    diagnostics,
  }),
};

function authored(
  changes: Partial<{
    shared: number;
    ink: number;
    washA: number;
    washB: number;
    seed: string | number;
    sampledT: number;
    inputRevision: number;
  }> = {},
): RegisteredStageAuthoredState {
  return {
    params: {
      shared: changes.shared ?? 1,
      ink: changes.ink ?? 2,
      washA: changes.washA ?? 3,
      washB: changes.washB ?? 4,
    },
    seed: changes.seed ?? "seed-a",
    sampledT: changes.sampledT ?? 0.25,
    compositionFrame: frame,
    inputRevision: changes.inputRevision ?? 1,
  };
}

interface ShadingJob {
  readonly identity: ShadingComputeIdentity;
  readonly observe: ShadingProgressObserver | undefined;
  readonly resolve: (result: ShadingComputeResult) => void;
}

class FakeShadingCoordinator implements ShadingPreparationCoordinator {
  readonly starts: ShadingJob[] = [];
  cancelCount = 0;

  start(
    identity: ShadingComputeIdentity,
    observe?: ShadingProgressObserver,
  ): Promise<ShadingComputeResult> {
    return new Promise((resolve) => {
      this.starts.push({ identity, observe, resolve });
    });
  }

  cancel(): boolean {
    this.cancelCount += 1;
    return true;
  }

  dispose(): void {}
}

interface GeneratedJob {
  readonly input: PlotStagePreparationInput;
  readonly resolve: (result: PlotStagePreparationResult) => void;
}

class FakeGeneratedCoordinator implements GeneratedStagePreparationCoordinator {
  readonly starts: GeneratedJob[] = [];
  cancelCount = 0;

  start(input: PlotStagePreparationInput): Promise<PlotStagePreparationResult> {
    return new Promise((resolve) => {
      this.starts.push({ input, resolve });
    });
  }

  cancel(): boolean {
    this.cancelCount += 1;
    return true;
  }

  dispose(): void {}
}

function succeedShading(job: ShadingJob, jobId = 1): void {
  job.resolve({
    status: "success",
    jobId,
    identity: job.identity,
    scene: primaryScene,
    diagnostics,
    computeTimeMs: 12,
  });
}

function succeedGenerated(job: GeneratedJob, jobId = 1): void {
  job.resolve({
    status: "success",
    jobId,
    identity: job.input.identity,
    registrationIdentity: job.input.registrationIdentity,
    scene: generatedScene,
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: UseRegisteredStagePreparationResult | null = null;

function Probe({
  activeSketch = sketch,
  initial = authored(),
  shadingFactory,
  generatedFactory,
}: {
  readonly activeSketch?: RegisteredStagePreparationSketch;
  readonly initial?: RegisteredStageAuthoredState;
  readonly shadingFactory: () => FakeShadingCoordinator;
  readonly generatedFactory: () => FakeGeneratedCoordinator;
}) {
  latest = useRegisteredStagePreparation({
    sketch: activeSketch,
    initial,
    shadingCoordinatorFactory: shadingFactory,
    generatedCoordinatorFactory: generatedFactory,
  });
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

describe("useRegisteredStagePreparation", () => {
  it("indexes immutable records by Stage ID and never constructs generated work for Primary demand", () => {
    const shadingCoordinators: FakeShadingCoordinator[] = [];
    const generatedCoordinators: FakeGeneratedCoordinator[] = [];
    mount(
      <Probe
        shadingFactory={() => {
          const coordinator = new FakeShadingCoordinator();
          shadingCoordinators.push(coordinator);
          return coordinator;
        }}
        generatedFactory={() => {
          const coordinator = new FakeGeneratedCoordinator();
          generatedCoordinators.push(coordinator);
          return coordinator;
        }}
      />,
    );

    expect(shadingCoordinators).toHaveLength(1);
    expect(generatedCoordinators).toHaveLength(0);
    expect(Object.keys(latest!.records)).toEqual(["wash-a", "ink", "wash-b"]);
    expect(latest!.records["wash-a"]).toMatchObject({
      stageId: "wash-a",
      sourceKind: "generator",
      freshness: "missing",
      outputReady: false,
    });
    expect(
      latest!.records["wash-b"]!.expectedPreparationIdentity,
    ).toMatchObject({
      stageId: "wash-b",
      seed: "seed-a",
      sampledT: 0.25,
    });
    expect(
      latest!.records["wash-a"]!.expectedPreparationIdentity,
    ).not.toHaveProperty("seed");
    expect(Object.isFrozen(latest!.records)).toBe(true);
    expect(Object.isFrozen(latest!.records["ink"])).toBe(true);

    act(() => {
      latest!.demand("ink");
      latest!.demand("unknown");
    });
    expect(generatedCoordinators).toHaveLength(0);
  });

  it("preserves typed Primary progress and indeterminate generator activity, then exposes current retained output", async () => {
    const shadingCoordinator = new FakeShadingCoordinator();
    const generatedCoordinators: FakeGeneratedCoordinator[] = [];
    mount(
      <Probe
        shadingFactory={() => shadingCoordinator}
        generatedFactory={() => {
          const coordinator = new FakeGeneratedCoordinator();
          generatedCoordinators.push(coordinator);
          return coordinator;
        }}
      />,
    );

    act(() => {
      shadingCoordinator.starts[0]!.observe?.({
        snapshot: {
          completedWorkUnits: 4,
          totalWorkUnits: 10,
          terminal: false,
        },
        eta: { kind: "remaining", revision: 2, remainingMs: 90 },
      });
      latest!.demand("wash-a");
    });

    expect(latest!.lookup("ink")!.activity).toEqual({
      kind: "preparing",
      progress: {
        kind: "shading",
        snapshot: {
          completedWorkUnits: 4,
          totalWorkUnits: 10,
          terminal: false,
        },
        eta: { kind: "remaining", revision: 2, remainingMs: 90 },
      },
    });
    expect(latest!.lookup("wash-a")!.activity).toEqual({
      kind: "preparing",
      progress: { kind: "indeterminate" },
    });
    expect(generatedCoordinators).toHaveLength(1);

    succeedShading(shadingCoordinator.starts[0]!);
    succeedGenerated(generatedCoordinators[0]!.starts[0]!);
    await flush();

    expect(latest!.lookup("ink")).toMatchObject({
      scene: primaryScene,
      freshness: "current",
      outputReady: true,
      activity: { kind: "idle" },
    });
    expect(latest!.lookup("wash-a")).toMatchObject({
      scene: generatedScene,
      freshness: "current",
      outputReady: true,
      activity: { kind: "idle" },
    });
    expect(latest!.lookup("wash-a")!.registrationIdentity).not.toBeNull();
    expect(latest!.lookup("wash-a")!.preparationIdentity).not.toBeNull();
  });

  it("keeps Primary current through supporting edits and isolates supporting failure, cancel, and retry", async () => {
    const shadingCoordinator = new FakeShadingCoordinator();
    const generatedCoordinator = new FakeGeneratedCoordinator();
    mount(
      <Probe
        shadingFactory={() => shadingCoordinator}
        generatedFactory={() => generatedCoordinator}
      />,
    );
    succeedShading(shadingCoordinator.starts[0]!);
    await flush();

    act(() => latest!.demand("wash-a"));
    succeedGenerated(generatedCoordinator.starts[0]!);
    await flush();

    act(() => latest!.requestAtomic(authored({ washA: 8, inputRevision: 2 })));
    expect(latest!.getSnapshot()["ink"]).toMatchObject({
      freshness: "current",
      outputReady: true,
    });
    expect(latest!.getSnapshot()["wash-a"]).toMatchObject({
      scene: generatedScene,
      freshness: "stale",
      activity: {
        kind: "preparing",
        progress: { kind: "indeterminate" },
      },
    });

    generatedCoordinator.starts[1]!.resolve({
      status: "failure",
      jobId: 2,
      error: "wash failed",
    });
    await flush();
    expect(latest!.lookup("wash-a")).toMatchObject({
      freshness: "stale",
      activity: { kind: "failed", error: "wash failed" },
    });
    expect(latest!.lookup("ink")).toMatchObject({
      freshness: "current",
      activity: { kind: "idle" },
    });

    act(() => latest!.retry("wash-a"));
    expect(generatedCoordinator.starts).toHaveLength(3);
    act(() => latest!.cancel("wash-a"));
    expect(generatedCoordinator.cancelCount).toBe(1);
    expect(latest!.getSnapshot()["wash-a"]!.activity).toEqual({ kind: "idle" });

    act(() => latest!.demand("wash-a"));
    expect(generatedCoordinator.starts).toHaveLength(4);
  });

  it("routes Primary cancel, demand, and retry only through retained Shading", async () => {
    const shadingCoordinator = new FakeShadingCoordinator();
    const generatedCoordinators: FakeGeneratedCoordinator[] = [];
    mount(
      <Probe
        shadingFactory={() => shadingCoordinator}
        generatedFactory={() => {
          const coordinator = new FakeGeneratedCoordinator();
          generatedCoordinators.push(coordinator);
          return coordinator;
        }}
      />,
    );

    act(() => latest!.cancel("ink"));
    expect(shadingCoordinator.cancelCount).toBe(1);
    expect(shadingCoordinator.starts).toHaveLength(1);

    act(() => latest!.demand("ink"));
    expect(shadingCoordinator.starts).toHaveLength(2);
    shadingCoordinator.starts[1]!.resolve({
      status: "failure",
      jobId: 2,
      error: "ink failed",
    });
    await flush();
    expect(latest!.lookup("ink")!.activity).toEqual({
      kind: "failed",
      error: "ink failed",
    });

    act(() => latest!.retry("ink"));
    expect(shadingCoordinator.starts).toHaveLength(3);
    expect(generatedCoordinators).toHaveLength(0);
  });

  it("marks unsupported Primary preparation unavailable without constructing either source worker", () => {
    const unavailableSketch: RegisteredStagePreparationSketch = {
      id: sketch.id,
      schema,
      plotSequence: declaration,
    };
    const shadingCoordinators: FakeShadingCoordinator[] = [];
    const generatedCoordinators: FakeGeneratedCoordinator[] = [];
    mount(
      <Probe
        activeSketch={unavailableSketch}
        shadingFactory={() => {
          const coordinator = new FakeShadingCoordinator();
          shadingCoordinators.push(coordinator);
          return coordinator;
        }}
        generatedFactory={() => {
          const coordinator = new FakeGeneratedCoordinator();
          generatedCoordinators.push(coordinator);
          return coordinator;
        }}
      />,
    );

    expect(latest!.lookup("ink")).toMatchObject({
      sourceKind: "primary",
      scene: null,
      freshness: "unavailable",
      outputReady: false,
      activity: { kind: "idle" },
    });
    act(() => latest!.demand("ink"));
    expect(shadingCoordinators).toHaveLength(0);
    expect(generatedCoordinators).toHaveLength(0);
  });
});
