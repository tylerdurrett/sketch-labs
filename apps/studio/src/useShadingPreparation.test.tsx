// @vitest-environment jsdom
import { act, StrictMode, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultParams,
  photoScribble,
  type ParamSchema,
  type Scene,
  type ShadingDiagnostics,
} from "@harness/core";

import type { ShadingComputeIdentity } from "./shadingComputeProtocol";
import type {
  ShadingComputeResult,
  ShadingProgressObserver,
} from "./shadingCoordinator";
import {
  createShadingIdentityForAuthoredState,
  useShadingPreparation,
  type ShadingAuthoredState,
  type ShadingIdentitySketch,
  type ShadingPreparationCoordinator,
  type UseShadingPreparationResult,
} from "./useShadingPreparation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const schema: ParamSchema = {
  amount: { kind: "number", min: 0, max: 10, default: 1 },
  color: { kind: "color", default: "#112233" },
};
const sketch: ShadingIdentitySketch = { id: "shading-test", schema };
const scene: Scene = {
  space: { width: 20, height: 10 },
  primitives: [{ points: [[0, 0], [10, 10]] }],
};
const diagnostics: ShadingDiagnostics = {
  termination: "completed",
  pathLength: 42,
  polylineCount: 3,
  penLiftCount: 2,
  fidelity: { kind: "scribble", residualError: 0.01 },
};

function authored(amount: number, inputRevision: number): ShadingAuthoredState {
  return {
    params: { color: "#112233", amount, ignored: 999 },
    seed: 7,
    compositionFrame: { width: 20, height: 10 },
    inputRevision,
  };
}

interface StartedJob {
  readonly identity: ShadingComputeIdentity;
  readonly observeProgress: ShadingProgressObserver | undefined;
  readonly resolve: (result: ShadingComputeResult) => void;
}

class FakeCoordinator implements ShadingPreparationCoordinator {
  readonly starts: StartedJob[] = [];
  cancelCount = 0;
  disposeCount = 0;

  start(
    identity: ShadingComputeIdentity,
    observeProgress?: ShadingProgressObserver,
  ): Promise<ShadingComputeResult> {
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
let latest: UseShadingPreparationResult | null = null;

function Probe({
  initial = authored(1, 1),
  createCoordinator,
  suspendOnMount = false,
}: {
  readonly initial?: ShadingAuthoredState;
  readonly createCoordinator: () => FakeCoordinator;
  readonly suspendOnMount?: boolean;
}) {
  const preparation = useShadingPreparation({
    sketch,
    initial,
    coordinatorFactory: createCoordinator,
  });
  latest = preparation;
  useLayoutEffect(() => {
    if (suspendOnMount) preparation.suspend();
  }, [preparation.suspend, suspendOnMount]);
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

describe("useShadingPreparation", () => {
  it("builds Sequence identities from only the Primary shared-plus-owned view", () => {
    const params = defaultParams(photoScribble.schema);
    const current = createShadingIdentityForAuthoredState(
      photoScribble,
      {
        params,
        seed: "seed",
        compositionFrame: { width: 20, height: 10 },
        inputRevision: 1,
      },
    );
    const watercolorEdit = createShadingIdentityForAuthoredState(
      photoScribble,
      {
        params: {
          ...params,
          watercolorBoundaryStrength:
            (params.watercolorBoundaryStrength as number) + 0.25,
        },
        seed: "seed",
        compositionFrame: { width: 20, height: 10 },
        inputRevision: 2,
      },
    );

    expect(current.params.map(({ key }) => key)).not.toContain(
      "watercolorBoundaryStrength",
    );
    expect(watercolorEdit).toEqual(current);
  });

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
      sketchId: "shading-test",
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

  it("retries the current failed identity exactly once", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe createCoordinator={() => coordinator} />);
    coordinator.starts[0]!.resolve({
      status: "failure",
      jobId: 1,
      error: "analysis failed",
    });
    await flush();
    expect(latest!.session.failure).toBe("analysis failed");

    act(() => {
      latest!.retry();
      latest!.retry();
    });

    expect(coordinator.starts).toHaveLength(2);
    expect(coordinator.starts[1]!.identity).toBe(
      coordinator.starts[0]!.identity,
    );
    expect(latest!.session.active).toMatchObject({
      token: 2,
      sourceInputRevision: 1,
    });
    expect(latest!.session.failure).toBeNull();
  });

  it("suspends synchronously, cancels active work once, and rejects its callbacks", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe createCoordinator={() => coordinator} />);
    succeed(coordinator.starts[0]!);
    await flush();

    act(() => latest!.requestAtomic(authored(2, 2)));
    const cancelledJob = coordinator.starts[1]!;
    let snapshotAfterSuspend = latest!.getSessionSnapshot();
    act(() => {
      latest!.suspend();
      snapshotAfterSuspend = latest!.getSessionSnapshot();
      latest!.suspend();
    });

    expect(snapshotAfterSuspend.suspended).toBe(true);
    expect(snapshotAfterSuspend.active).toBeNull();
    expect(snapshotAfterSuspend.pending).toBeNull();
    expect(snapshotAfterSuspend.displayed?.identity.params[0]?.value).toBe(1);
    expect(coordinator.cancelCount).toBe(1);

    act(() => {
      cancelledJob.observeProgress?.({
        snapshot: {
          completedWorkUnits: 1,
          totalWorkUnits: 2,
          terminal: false,
        },
        eta: { kind: "remaining", revision: 1, remainingMs: 10 },
      });
    });
    succeed(cancelledJob, 2);
    await flush();
    expect(latest!.progress).toBeNull();
    expect(latest!.session.displayed?.identity.params[0]?.value).toBe(1);
  });

  it("accepts authored updates without launching while suspended, then starts only the latest", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe createCoordinator={() => coordinator} />);
    succeed(coordinator.starts[0]!);
    await flush();

    act(() => {
      latest!.suspend();
      latest!.requestAtomic(authored(2, 2));
      latest!.beginTransaction();
      latest!.previewAuthoredState(authored(3, 3));
      latest!.previewAuthoredState(authored(4, 4));
      latest!.settleTransaction(authored(5, 5));
    });
    expect(coordinator.starts).toHaveLength(1);
    expect(latest!.session.suspended).toBe(true);
    expect(latest!.session.desiredIdentity?.params[0]?.value).toBe(5);
    expect(latest!.session.sourceInputRevision).toBe(5);

    act(() => {
      latest!.resumeLatest();
      latest!.resumeLatest();
    });
    expect(coordinator.starts).toHaveLength(2);
    expect(coordinator.starts[1]!.identity.params[0]?.value).toBe(5);
    expect(latest!.session.active?.sourceInputRevision).toBe(5);

    succeed(coordinator.starts[1]!, 2);
    await flush();
    expect(latest!.session.displayed?.sourceInputRevision).toBe(5);
  });

  it("resumes without work when the displayed result is already current", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe createCoordinator={() => coordinator} />);
    succeed(coordinator.starts[0]!);
    await flush();

    act(() => {
      latest!.suspend();
      latest!.resumeLatest();
    });
    expect(coordinator.starts).toHaveLength(1);
    expect(latest!.session.suspended).toBe(false);
    expect(latest!.session.active).toBeNull();
  });

  it("keeps StrictMode recreation suspended until one explicit latest resume", () => {
    const coordinators: FakeCoordinator[] = [];
    mount(
      <StrictMode>
        <Probe
          suspendOnMount
          createCoordinator={() => {
            const coordinator = new FakeCoordinator();
            coordinators.push(coordinator);
            return coordinator;
          }}
        />
      </StrictMode>,
    );

    expect(coordinators).toHaveLength(2);
    expect(coordinators[0]!.starts).toHaveLength(0);
    expect(coordinators[0]!.disposeCount).toBe(1);
    expect(coordinators[1]!.starts).toHaveLength(0);
    expect(latest!.getSessionSnapshot().suspended).toBe(true);

    act(() => latest!.resumeLatest());
    expect(coordinators[1]!.starts).toHaveLength(1);
    expect(coordinators[1]!.starts[0]!.identity.params[0]?.value).toBe(1);
  });

  it("disposes the coordinator without restarting work while suspended", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe createCoordinator={() => coordinator} />);
    const stale = coordinator.starts[0]!;
    act(() => latest!.suspend());
    expect(coordinator.cancelCount).toBe(1);

    act(() => root!.unmount());
    root = null;
    expect(coordinator.disposeCount).toBe(1);
    expect(coordinator.starts).toHaveLength(1);

    succeed(stale);
    await flush();
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
