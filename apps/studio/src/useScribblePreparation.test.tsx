// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ParamSchema,
  Scene,
  ScribbleDiagnostics,
} from "@harness/core";

import type { ScribbleComputeIdentity } from "./scribbleComputeProtocol";
import type {
  ScribbleComputeResult,
  ScribbleProgressObserver,
} from "./scribbleCoordinator";
import {
  useScribblePreparation,
  type ScribbleAuthoredState,
  type ScribbleIdentitySketch,
  type ScribblePreparationCoordinator,
  type UseScribblePreparationResult,
} from "./useScribblePreparation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const schema: ParamSchema = {
  amount: { kind: "number", min: 0, max: 10, default: 1 },
  color: { kind: "color", default: "#112233" },
};
const sketch: ScribbleIdentitySketch = { id: "scribble-test", schema };
const scene: Scene = {
  space: { width: 20, height: 10 },
  primitives: [{ points: [[0, 0], [10, 10]] }],
};
const diagnostics: ScribbleDiagnostics = {
  termination: "completed",
  residualError: 0.01,
  pathLength: 42,
  polylineCount: 3,
  penLiftCount: 2,
};

function authored(amount: number, inputRevision: number): ScribbleAuthoredState {
  return {
    params: { color: "#112233", amount, ignored: 999 },
    seed: 7,
    compositionFrame: { width: 20, height: 10 },
    inputRevision,
  };
}

interface StartedJob {
  readonly identity: ScribbleComputeIdentity;
  readonly observeProgress: ScribbleProgressObserver | undefined;
  readonly resolve: (result: ScribbleComputeResult) => void;
}

class FakeCoordinator implements ScribblePreparationCoordinator {
  readonly starts: StartedJob[] = [];
  cancelCount = 0;
  disposeCount = 0;

  start(
    identity: ScribbleComputeIdentity,
    observeProgress?: ScribbleProgressObserver,
  ): Promise<ScribbleComputeResult> {
    return new Promise((resolve) => {
      this.starts.push({ identity, observeProgress, resolve });
    });
  }

  cancel(): boolean {
    this.cancelCount += 1;
    return true;
  }

  dispose(): void {
    this.disposeCount += 1;
    this.cancel();
  }
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: UseScribblePreparationResult | null = null;

function Probe({
  initial = authored(1, 1),
  createCoordinator,
}: {
  readonly initial?: ScribbleAuthoredState;
  readonly createCoordinator: () => FakeCoordinator;
}) {
  latest = useScribblePreparation({
    sketch,
    initial,
    coordinatorFactory: createCoordinator,
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

function succeed(job: StartedJob, jobId = 1): void {
  job.resolve({
    status: "success",
    jobId,
    identity: job.identity,
    scene,
    diagnostics,
    computeTimeMs: 12,
  });
}

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
});

describe("useScribblePreparation", () => {
  it("builds the canonical initial identity and starts it automatically", () => {
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

    expect(coordinators).toHaveLength(1);
    expect(coordinators[0]!.starts).toHaveLength(1);
    expect(coordinators[0]!.starts[0]!.identity).toEqual({
      sketchId: "scribble-test",
      params: [
        { key: "amount", value: 1 },
        { key: "color", value: "#112233" },
      ],
      seed: 7,
      compositionFrame: { width: 20, height: 10 },
    });
    expect(latest!.session.active).toMatchObject({
      token: 1,
      sourceInputRevision: 1,
    });
  });

  it("coalesces batched atomic edits and immediately launches only the latest identity", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe createCoordinator={() => coordinator} />);
    const stale = coordinator.starts[0]!;

    act(() => {
      latest!.requestAtomic(authored(2, 2));
      latest!.requestAtomic(authored(3, 3));
    });

    expect(coordinator.cancelCount).toBe(1);
    expect(coordinator.starts).toHaveLength(2);
    expect(coordinator.starts[1]!.identity.params[0]).toEqual({
      key: "amount",
      value: 3,
    });
    expect(latest!.session.active).toMatchObject({
      token: 3,
      sourceInputRevision: 3,
    });

    // A queued completion from the replaced job cannot overwrite the latest.
    succeed(stale);
    await flush();
    expect(latest!.session.displayed).toBeNull();

    succeed(coordinator.starts[1]!, 2);
    await flush();
    expect(latest!.session.displayed?.identity.params[0]?.value).toBe(3);
    expect(latest!.session.displayed?.sourceInputRevision).toBe(3);
  });

  it("coalesces transaction previews and launches one changed settlement", () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe createCoordinator={() => coordinator} />);

    act(() => {
      latest!.beginTransaction();
      latest!.previewAuthoredState(authored(2, 2));
      latest!.previewAuthoredState(authored(3, 3));
    });
    expect(coordinator.cancelCount).toBe(1);
    expect(coordinator.starts).toHaveLength(1);
    expect(latest!.session.transactionOpen).toBe(true);
    expect(latest!.session.pending).toBeNull();

    act(() => latest!.settleTransaction(authored(3, 3)));
    expect(coordinator.starts).toHaveLength(2);
    expect(coordinator.starts[1]!.identity.params[0]?.value).toBe(3);
    expect(latest!.session.transactionOpen).toBe(false);
  });

  it("uses the one exact cache for an Escape-style revert and recomputes a miss once", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe createCoordinator={() => coordinator} />);
    succeed(coordinator.starts[0]!);
    await flush();
    expect(latest!.session.displayed?.contentRevision).toBe(1);

    act(() => {
      latest!.beginTransaction();
      latest!.previewAuthoredState(authored(2, 2));
      latest!.settleTransaction(authored(1, 3));
    });
    expect(coordinator.starts).toHaveLength(1);
    expect(latest!.session.displayed?.sourceInputRevision).toBe(3);
    expect(latest!.session.displayed?.contentRevision).toBe(2);

    act(() => {
      latest!.beginTransaction();
      latest!.previewAuthoredState(authored(2, 4));
      latest!.settleTransaction(authored(2, 4));
    });
    expect(coordinator.starts).toHaveLength(2);
    expect(coordinator.starts[1]!.identity.params[0]?.value).toBe(2);
  });

  it("matches progress and terminal callbacks to coordinator generation, token, and identity", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe createCoordinator={() => coordinator} />);
    const stale = coordinator.starts[0]!;

    act(() => latest!.requestAtomic(authored(2, 2)));
    const current = coordinator.starts[1]!;
    act(() => {
      stale.observeProgress?.({
        snapshot: {
          completedWorkUnits: 1,
          totalWorkUnits: 2,
          terminal: false,
        },
        eta: { kind: "remaining", revision: 1, remainingMs: 10 },
      });
      current.observeProgress?.({
        snapshot: {
          completedWorkUnits: 1,
          totalWorkUnits: 2,
          terminal: false,
        },
        eta: { kind: "remaining", revision: 1, remainingMs: 10 },
      });
    });
    expect(latest!.progress?.token).toBe(2);

    stale.resolve({ status: "failure", jobId: 1, error: "stale failure" });
    await flush();
    expect(latest!.session.failure).toBeNull();
    expect(latest!.session.active?.token).toBe(2);

    succeed(current, 2);
    await flush();
    expect(latest!.session.displayed?.identity).toBe(current.identity);
    expect(latest!.progress).toBeNull();
  });

  it("replaces the StrictMode rehearsal job once and disposes both coordinator lifetimes", async () => {
    const coordinators: FakeCoordinator[] = [];
    mount(
      <StrictMode>
        <Probe
          createCoordinator={() => {
            const coordinator = new FakeCoordinator();
            coordinators.push(coordinator);
            return coordinator;
          }}
        />
      </StrictMode>,
    );
    await flush();

    expect(coordinators).toHaveLength(2);
    expect(coordinators[0]!.starts).toHaveLength(1);
    expect(coordinators[0]!.disposeCount).toBe(1);
    expect(coordinators[1]!.starts).toHaveLength(1);
    expect(coordinators[1]!.starts[0]!.identity).toEqual(
      coordinators[0]!.starts[0]!.identity,
    );
    expect(latest!.session.active?.token).toBe(2);

    act(() => root!.unmount());
    root = null;
    expect(coordinators[1]!.disposeCount).toBe(1);
  });
});
