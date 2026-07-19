import { describe, expect, it } from "vitest";

import type { ParamSchema, Scene, ScribbleDiagnostics } from "@harness/core";

import {
  createScribbleComputeIdentity,
  type ScribbleComputeIdentity,
} from "./scribbleComputeProtocol";
import {
  createScribbleSessionState,
  scribbleSessionReducer,
  selectCurrentScribbleResult,
  selectExportableScribbleResult,
  type ScribbleSessionState,
} from "./scribbleSession";

const schema: ParamSchema = {
  amount: { kind: "number", min: 0, max: 10, default: 1 },
};
const sceneA: Scene = {
  space: { width: 20, height: 20 },
  primitives: [{ points: [[0, 0], [10, 10]] }],
};
const sceneB: Scene = {
  space: sceneA.space,
  primitives: [{ points: [[10, 0], [0, 10]] }],
};
const completedDiagnostics: ScribbleDiagnostics = {
  termination: "completed",
  residualError: 0.01,
  pathLength: 42,
  polylineCount: 3,
  penLiftCount: 2,
};
function identity(amount: number): ScribbleComputeIdentity {
  return createScribbleComputeIdentity({
    sketchId: "test",
    schema,
    params: { amount },
    seed: 1,
    compositionFrame: sceneA.space,
  });
}

function launch(state: ScribbleSessionState): ScribbleSessionState {
  return scribbleSessionReducer(state, {
    type: "launched",
    token: state.pending!.token,
    identity: state.pending!.identity,
  });
}

function succeed(
  state: ScribbleSessionState,
  scene: Scene = sceneA,
  diagnostics: ScribbleDiagnostics = completedDiagnostics,
): ScribbleSessionState {
  return scribbleSessionReducer(state, {
    type: "succeeded",
    token: state.active!.token,
    identity: state.active!.identity,
    scene,
    diagnostics,
    computeTimeMs: 12,
  });
}

function completedA(): ScribbleSessionState {
  return succeed(launch(createScribbleSessionState(identity(1), 10)));
}

describe("scribbleSessionReducer", () => {
  it("enqueues the initial identity once with explicit authored provenance", () => {
    const initial = createScribbleSessionState(identity(1), 10);

    expect(initial.pending).toEqual({
      token: 1,
      identity: initial.desiredIdentity,
      sourceInputRevision: 10,
    });
    expect(initial.nextToken).toBe(2);

    const repeatedDesired = scribbleSessionReducer(initial, {
      type: "desired-identity-changed",
      identity: identity(1),
      sourceInputRevision: 10,
    });
    expect(repeatedDesired).toBe(initial);

    const settled = scribbleSessionReducer(initial, {
      type: "transaction-settled",
      identity: identity(1),
      sourceInputRevision: 10,
    });
    expect(settled).toBe(initial);
  });

  it("moves only the matching pending token and identity into active ownership", () => {
    const pending = createScribbleSessionState(identity(1), 10);
    expect(
      scribbleSessionReducer(pending, {
        type: "launched",
        token: 2,
        identity: identity(1),
      }),
    ).toBe(pending);
    expect(
      scribbleSessionReducer(pending, {
        type: "launched",
        token: 1,
        identity: identity(2),
      }),
    ).toBe(pending);

    const active = launch(pending);
    expect(active.pending).toBeNull();
    expect(active.active).toBe(pending.pending);
  });

  it("invalidates active work at transaction begin but retains the completed display stale", () => {
    const completed = completedA();
    const replacement = scribbleSessionReducer(completed, {
      type: "transaction-settled",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    const active = launch(replacement);
    const begun = scribbleSessionReducer(active, {
      type: "transaction-began",
    });

    expect(begun.transactionOpen).toBe(true);
    expect(begun.active).toBeNull();
    expect(begun.pending).toBeNull();
    expect(begun.displayed).toBe(completed.displayed);
    expect(selectCurrentScribbleResult(begun)).toBeNull();
  });

  it("coalesces previews without launching and settles exactly one latest request", () => {
    const begun = scribbleSessionReducer(completedA(), {
      type: "transaction-began",
    });
    const firstPreview = scribbleSessionReducer(begun, {
      type: "desired-identity-changed",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    const latestPreview = scribbleSessionReducer(firstPreview, {
      type: "desired-identity-changed",
      identity: identity(3),
      sourceInputRevision: 12,
    });

    expect(firstPreview.pending).toBeNull();
    expect(latestPreview.pending).toBeNull();
    expect(latestPreview.nextToken).toBe(begun.nextToken);

    const settled = scribbleSessionReducer(latestPreview, {
      type: "transaction-settled",
      identity: identity(3),
      sourceInputRevision: 12,
    });
    expect(settled.pending).toEqual({
      token: settled.nextToken - 1,
      identity: settled.desiredIdentity,
      sourceInputRevision: 12,
    });
    expect(
      scribbleSessionReducer(settled, {
        type: "transaction-settled",
        identity: identity(3),
        sourceInputRevision: 12,
      }),
    ).toBe(settled);
  });

  it("ignores delayed authored actions older than the pending or active generation", () => {
    const begun = scribbleSessionReducer(completedA(), {
      type: "transaction-began",
    });
    const previewed = scribbleSessionReducer(begun, {
      type: "desired-identity-changed",
      identity: identity(3),
      sourceInputRevision: 12,
    });
    const pending = scribbleSessionReducer(previewed, {
      type: "transaction-settled",
      identity: identity(3),
      sourceInputRevision: 12,
    });

    const delayedPreview = scribbleSessionReducer(pending, {
      type: "desired-identity-changed",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    expect(delayedPreview).toBe(pending);
    expect(delayedPreview.pending?.sourceInputRevision).toBe(12);

    const active = launch(pending);
    const delayedSettle = scribbleSessionReducer(active, {
      type: "transaction-settled",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    expect(delayedSettle).toBe(active);
    expect(delayedSettle.active?.sourceInputRevision).toBe(12);
  });

  it("cannot roll a current display back or make stale geometry exportable", () => {
    const current = succeed(
      launch(createScribbleSessionState(identity(3), 12)),
    );
    const delayed = scribbleSessionReducer(current, {
      type: "transaction-settled",
      identity: identity(2),
      sourceInputRevision: 11,
    });

    expect(delayed).toBe(current);
    expect(delayed.sourceInputRevision).toBe(12);
    expect(selectExportableScribbleResult(delayed)).toBe(current.displayed);
  });

  it("does not duplicate exact active work and advances its provenance", () => {
    const active = launch(createScribbleSessionState(identity(1), 10));
    const settled = scribbleSessionReducer(active, {
      type: "transaction-settled",
      identity: identity(1),
      sourceInputRevision: 11,
    });

    expect(settled.active).toEqual({
      token: active.active!.token,
      identity: settled.desiredIdentity,
      sourceInputRevision: 11,
    });
    expect(settled.pending).toBeNull();
    expect(settled.nextToken).toBe(active.nextToken);
  });

  it("accepts success only when both active token and identity match", () => {
    const active = launch(createScribbleSessionState(identity(1), 10));
    expect(
      scribbleSessionReducer(active, {
        type: "succeeded",
        token: active.active!.token + 1,
        identity: active.active!.identity,
        scene: sceneA,
        diagnostics: completedDiagnostics,
        computeTimeMs: 12,
      }),
    ).toBe(active);
    expect(
      scribbleSessionReducer(active, {
        type: "succeeded",
        token: active.active!.token,
        identity: identity(2),
        scene: sceneB,
        diagnostics: completedDiagnostics,
        computeTimeMs: 12,
      }),
    ).toBe(active);

    const completed = succeed(active);
    expect(completed.displayed).toMatchObject({
      identity: active.active!.identity,
      scene: sceneA,
      sourceInputRevision: 10,
      contentRevision: 1,
    });
    expect(completed.nextContentRevision).toBe(2);
  });

  it("promotes exact cached A after A to B to A with current provenance and fresh content", () => {
    const a = completedA();
    const begunB = scribbleSessionReducer(a, { type: "transaction-began" });
    const previewB = scribbleSessionReducer(begunB, {
      type: "desired-identity-changed",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    const pendingB = scribbleSessionReducer(previewB, {
      type: "transaction-settled",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    const activeB = launch(pendingB);
    const begunA = scribbleSessionReducer(activeB, {
      type: "transaction-began",
    });
    const previewA = scribbleSessionReducer(begunA, {
      type: "desired-identity-changed",
      identity: identity(1),
      sourceInputRevision: 12,
    });
    const promoted = scribbleSessionReducer(previewA, {
      type: "transaction-settled",
      identity: identity(1),
      sourceInputRevision: 12,
    });

    expect(promoted.pending).toBeNull();
    expect(promoted.active).toBeNull();
    expect(promoted.displayed?.scene).toBe(a.displayed?.scene);
    expect(promoted.displayed?.sourceInputRevision).toBe(12);
    expect(promoted.displayed?.contentRevision).toBe(2);
    expect(promoted.nextContentRevision).toBe(3);
    expect(selectCurrentScribbleResult(promoted)).toBe(promoted.displayed);
    expect(
      scribbleSessionReducer(promoted, {
        type: "transaction-settled",
        identity: identity(1),
        sourceInputRevision: 12,
      }),
    ).toBe(promoted);
  });

  it("retains stale completion through cancellation and failure", () => {
    const completed = completedA();
    const pendingB = scribbleSessionReducer(completed, {
      type: "transaction-settled",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    const activeB = launch(pendingB);
    const cancelled = scribbleSessionReducer(activeB, {
      type: "cancelled",
      token: activeB.active!.token,
    });
    expect(cancelled.displayed).toBe(completed.displayed);
    expect(cancelled.failure).toBeNull();
    expect(selectCurrentScribbleResult(cancelled)).toBeNull();

    const pendingAgain = scribbleSessionReducer(cancelled, {
      type: "transaction-settled",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    const activeAgain = launch(pendingAgain);
    const failed = scribbleSessionReducer(activeAgain, {
      type: "failed",
      token: activeAgain.active!.token,
      identity: activeAgain.active!.identity,
      error: "safe detail",
    });
    expect(failed.displayed).toBe(completed.displayed);
    expect(failed.failure).toBe("safe detail");
    expect(selectCurrentScribbleResult(failed)).toBeNull();
  });

  it("rejects stale cancellation and failure terminals", () => {
    const active = launch(createScribbleSessionState(identity(1), 10));
    expect(
      scribbleSessionReducer(active, { type: "cancelled", token: 99 }),
    ).toBe(active);
    expect(
      scribbleSessionReducer(active, {
        type: "failed",
        token: active.active!.token,
        identity: identity(2),
        error: "wrong job",
      }),
    ).toBe(active);
  });

  it("records an initial failure without fabricating a display", () => {
    const active = launch(createScribbleSessionState(identity(1), 10));
    const failed = scribbleSessionReducer(active, {
      type: "failed",
      token: active.active!.token,
      identity: active.active!.identity,
      error: "safe detail",
    });

    expect(failed.displayed).toBeNull();
    expect(failed.failure).toBe("safe detail");
    expect(selectExportableScribbleResult(failed)).toBeNull();
  });

  it.each(["stopped-early", "budget-exhausted"] as const)(
    "exports a current %s terminal result but never its stale display",
    (termination) => {
      const current = succeed(
        launch(createScribbleSessionState(identity(1), 10)),
        sceneA,
        { ...completedDiagnostics, termination, residualError: 0.2 },
      );
      expect(selectExportableScribbleResult(current)).toBe(current.displayed);

      const begun = scribbleSessionReducer(current, {
        type: "transaction-began",
      });
      expect(selectExportableScribbleResult(begun)).toBeNull();
      const preview = scribbleSessionReducer(begun, {
        type: "desired-identity-changed",
        identity: identity(2),
        sourceInputRevision: 11,
      });
      expect(selectExportableScribbleResult(preview)).toBeNull();
    },
  );

  it("disposal clears desired, work, display, failures, and counters", () => {
    const active = launch(createScribbleSessionState(identity(1), 10));
    const disposed = scribbleSessionReducer(active, { type: "dispose" });

    expect(disposed).toEqual({
      desiredIdentity: null,
      sourceInputRevision: null,
      transactionOpen: false,
      pending: null,
      active: null,
      displayed: null,
      failure: null,
      nextToken: 1,
      nextContentRevision: 1,
    });
    expect(selectCurrentScribbleResult(disposed)).toBeNull();
  });
});
