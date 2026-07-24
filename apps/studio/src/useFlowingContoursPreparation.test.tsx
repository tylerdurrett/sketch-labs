// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { defaultParams, flowingContours, type Scene } from "@harness/core";

import type {
  FlowingContoursComputeIdentity,
} from "./flowingContoursComputeProtocol";
import type {
  FlowingContoursComputeResult,
} from "./flowingContoursCoordinator";
import {
  useFlowingContoursPreparation,
  type FlowingContoursAuthoredState,
  type FlowingContoursPreparationCoordinator,
  type UseFlowingContoursPreparationResult,
} from "./useFlowingContoursPreparation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const frame = { width: 20, height: 10 };
const scene: Scene = { space: frame, primitives: [] };

function authored(
  curveDetail: number,
  inputRevision: number,
): FlowingContoursAuthoredState {
  return {
    params: {
      ...defaultParams(flowingContours.schema),
      curveDetail,
    },
    seed: 7,
    compositionFrame: frame,
    inputRevision,
  };
}

interface Started {
  readonly identity: FlowingContoursComputeIdentity;
  readonly resolve: (value: FlowingContoursComputeResult) => void;
}

class FakeCoordinator implements FlowingContoursPreparationCoordinator {
  readonly starts: Started[] = [];
  cancelCount = 0;
  disposeCount = 0;

  start(
    identity: FlowingContoursComputeIdentity,
  ): Promise<FlowingContoursComputeResult> {
    return new Promise((resolve) => this.starts.push({ identity, resolve }));
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
let latest: UseFlowingContoursPreparationResult | null = null;

function Probe({
  createCoordinator,
}: {
  readonly createCoordinator: () => FakeCoordinator;
}) {
  latest = useFlowingContoursPreparation({
    sketch: flowingContours,
    initial: authored(0.5, 1),
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

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
});

describe("useFlowingContoursPreparation", () => {
  it("starts canonical initial work and replaces it with only the latest edit", () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe createCoordinator={() => coordinator} />);
    expect(coordinator.starts).toHaveLength(1);
    expect(coordinator.starts[0]!.identity.sketchId).toBe("flowing-contours");

    act(() => {
      latest!.requestAtomic(authored(1, 2));
      latest!.requestAtomic(authored(2, 3));
    });
    expect(coordinator.cancelCount).toBe(1);
    expect(coordinator.starts).toHaveLength(2);
    expect(
      coordinator.starts[1]!.identity.params.find(
        ({ key }) => key === "curveDetail",
      )?.value,
    ).toBe(2);
  });

  it("ignores a stale completion and retains a completed Scene while replacing", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe createCoordinator={() => coordinator} />);
    const first = coordinator.starts[0]!;
    first.resolve({
      status: "success",
      jobId: 1,
      identity: first.identity,
      scene,
      computeTimeMs: 8,
    });
    await flush();
    expect(latest!.session.displayed?.scene).toBe(scene);

    act(() => latest!.requestAtomic(authored(1.5, 2)));
    expect(latest!.session.displayed?.scene).toBe(scene);
    first.resolve({
      status: "success",
      jobId: 1,
      identity: first.identity,
      scene: { space: frame, primitives: [{ points: [] }] },
      computeTimeMs: 9,
    });
    await flush();
    expect(latest!.session.displayed?.scene).toBe(scene);
  });

  it("requeues one job across StrictMode coordinator rehearsal", async () => {
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
    expect(latest!.session.active?.token).toBe(2);
  });
});
