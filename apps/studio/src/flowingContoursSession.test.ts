import { describe, expect, it } from "vitest";

import { defaultParams, flowingContours, type Scene } from "@harness/core";

import { createFlowingContoursComputeIdentity } from "./flowingContoursComputeProtocol";
import {
  createFlowingContoursSessionState,
  flowingContoursSessionReducer,
  selectCurrentFlowingContoursResult,
} from "./flowingContoursSession";

const frame = { width: 20, height: 20 };
const scene: Scene = { space: frame, primitives: [] };

function identity(curveDetail: number) {
  return createFlowingContoursComputeIdentity({
    sketchId: flowingContours.id,
    schema: flowingContours.schema,
    params: {
      ...defaultParams(flowingContours.schema),
      curveDetail,
    },
    seed: 1,
    compositionFrame: frame,
  });
}

function completeA() {
  const a = identity(0.5);
  const initial = createFlowingContoursSessionState(a, 1);
  const active = flowingContoursSessionReducer(initial, {
    type: "launched",
    token: 1,
    identity: a,
  });
  return flowingContoursSessionReducer(active, {
    type: "succeeded",
    token: 1,
    identity: a,
    scene,
    computeTimeMs: 10,
  });
}

describe("flowingContoursSessionReducer", () => {
  it("holds stale A during B, then promotes exact A in A→B→A without work", () => {
    const completed = completeA();
    const b = identity(1.5);
    const pendingB = flowingContoursSessionReducer(completed, {
      type: "transaction-settled",
      identity: b,
      sourceInputRevision: 2,
    });
    const activeB = flowingContoursSessionReducer(pendingB, {
      type: "launched",
      token: pendingB.pending!.token,
      identity: b,
    });
    expect(activeB.displayed?.scene).toBe(scene);
    expect(selectCurrentFlowingContoursResult(activeB)).toBeNull();

    const promotedA = flowingContoursSessionReducer(activeB, {
      type: "transaction-settled",
      identity: completed.displayed!.identity,
      sourceInputRevision: 3,
    });
    expect(promotedA.active).toBeNull();
    expect(promotedA.pending).toBeNull();
    expect(promotedA.displayed?.scene).toBe(scene);
    expect(promotedA.displayed?.sourceInputRevision).toBe(3);
    expect(selectCurrentFlowingContoursResult(promotedA)).toBe(
      promotedA.displayed,
    );
  });

  it("ignores stale terminals and supports bounded retry", () => {
    const a = identity(0.5);
    const initial = createFlowingContoursSessionState(a, 1);
    const active = flowingContoursSessionReducer(initial, {
      type: "launched",
      token: 1,
      identity: a,
    });
    const failed = flowingContoursSessionReducer(active, {
      type: "failed",
      token: 1,
      identity: a,
      error: "decode failed",
    });
    const retried = flowingContoursSessionReducer(failed, {
      type: "retry",
      identity: a,
      sourceInputRevision: 1,
    });
    expect(retried.failure).toBeNull();
    expect(retried.pending?.token).toBe(2);
    expect(
      flowingContoursSessionReducer(retried, {
        type: "succeeded",
        token: 1,
        identity: a,
        scene,
        computeTimeMs: 10,
      }),
    ).toBe(retried);
  });

  it("suspends ownership while retaining stale display and resumes only latest", () => {
    const completed = completeA();
    const suspended = flowingContoursSessionReducer(completed, {
      type: "suspend",
    });
    const b = identity(1.5);
    const advanced = flowingContoursSessionReducer(suspended, {
      type: "transaction-settled",
      identity: b,
      sourceInputRevision: 2,
    });
    expect(advanced.displayed).toBe(completed.displayed);
    expect(advanced.pending).toBeNull();
    const resumed = flowingContoursSessionReducer(advanced, {
      type: "resume-latest",
    });
    expect(resumed.pending?.identity).toBe(b);
  });
});
