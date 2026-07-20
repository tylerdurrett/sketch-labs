import { describe, expect, it } from "vitest";

import type { ParamSchema, Scene, ShadingDiagnostics } from "@harness/core";

import {
  createShadingComputeIdentity,
  type ShadingComputeIdentity,
} from "./shadingComputeProtocol";
import {
  createShadingSessionState,
  shadingSessionReducer,
  selectCurrentShadingResult,
  selectExportableShadingResult,
  type ShadingSessionState,
} from "./shadingSession";

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
const completedDiagnostics: ShadingDiagnostics = {
  termination: "completed",
  pathLength: 42,
  polylineCount: 3,
  penLiftCount: 2,
  fidelity: { kind: "scribble", residualError: 0.01 },
};
const exhaustedDiagnostics: ShadingDiagnostics = {
  ...completedDiagnostics,
  termination: "budget-exhausted",
  fidelity: { kind: "scribble", residualError: 0.2 },
};
const stoppedEarlyDiagnostics: ShadingDiagnostics = {
  ...completedDiagnostics,
  termination: "stopped-early",
  fidelity: { kind: "scribble", residualError: 0.1 },
};

function identity(amount: number): ShadingComputeIdentity {
  return createShadingComputeIdentity({
    sketchId: "test",
    schema,
    params: { amount },
    seed: 1,
    compositionFrame: sceneA.space,
  });
}

function launch(state: ShadingSessionState): ShadingSessionState {
  return shadingSessionReducer(state, {
    type: "launched",
    token: state.pending!.token,
    identity: state.pending!.identity,
  });
}

function succeed(
  state: ShadingSessionState,
  scene: Scene = sceneA,
  diagnostics: ShadingDiagnostics = completedDiagnostics,
): ShadingSessionState {
  return shadingSessionReducer(state, {
    type: "succeeded",
    token: state.active!.token,
    identity: state.active!.identity,
    scene,
    diagnostics,
    computeTimeMs: 12,
  });
}

function completedA(): ShadingSessionState {
  return succeed(launch(createShadingSessionState(identity(1), 10)));
}

describe("shadingSessionReducer", () => {
  it("enqueues the initial identity once with explicit authored provenance", () => {
    const initial = createShadingSessionState(identity(1), 10);

    expect(initial.pending).toEqual({
      token: 1,
      identity: initial.desiredIdentity,
      sourceInputRevision: 10,
    });
    expect(initial.nextToken).toBe(2);

    const repeatedDesired = shadingSessionReducer(initial, {
      type: "desired-identity-changed",
      identity: identity(1),
      sourceInputRevision: 10,
    });
    expect(repeatedDesired).toBe(initial);

    const settled = shadingSessionReducer(initial, {
      type: "transaction-settled",
      identity: identity(1),
      sourceInputRevision: 10,
    });
    expect(settled).toBe(initial);
  });

  it("moves only the matching pending token and identity into active ownership", () => {
    const pending = createShadingSessionState(identity(1), 10);
    expect(
      shadingSessionReducer(pending, {
        type: "launched",
        token: 2,
        identity: identity(1),
      }),
    ).toBe(pending);
    expect(
      shadingSessionReducer(pending, {
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
    const replacement = shadingSessionReducer(completed, {
      type: "transaction-settled",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    const active = launch(replacement);
    const begun = shadingSessionReducer(active, {
      type: "transaction-began",
    });

    expect(begun.transactionOpen).toBe(true);
    expect(begun.active).toBeNull();
    expect(begun.pending).toBeNull();
    expect(begun.displayed).toBe(completed.displayed);
    expect(selectCurrentShadingResult(begun)).toBeNull();
  });

  it("coalesces previews without launching and settles exactly one latest request", () => {
    const begun = shadingSessionReducer(completedA(), {
      type: "transaction-began",
    });
    const firstPreview = shadingSessionReducer(begun, {
      type: "desired-identity-changed",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    const latestPreview = shadingSessionReducer(firstPreview, {
      type: "desired-identity-changed",
      identity: identity(3),
      sourceInputRevision: 12,
    });

    expect(firstPreview.pending).toBeNull();
    expect(latestPreview.pending).toBeNull();
    expect(latestPreview.nextToken).toBe(begun.nextToken);

    const settled = shadingSessionReducer(latestPreview, {
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
      shadingSessionReducer(settled, {
        type: "transaction-settled",
        identity: identity(3),
        sourceInputRevision: 12,
      }),
    ).toBe(settled);
  });

  it("ignores delayed authored actions older than the pending or active generation", () => {
    const begun = shadingSessionReducer(completedA(), {
      type: "transaction-began",
    });
    const previewed = shadingSessionReducer(begun, {
      type: "desired-identity-changed",
      identity: identity(3),
      sourceInputRevision: 12,
    });
    const pending = shadingSessionReducer(previewed, {
      type: "transaction-settled",
      identity: identity(3),
      sourceInputRevision: 12,
    });

    const delayedPreview = shadingSessionReducer(pending, {
      type: "desired-identity-changed",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    expect(delayedPreview).toBe(pending);
    expect(delayedPreview.pending?.sourceInputRevision).toBe(12);

    const active = launch(pending);
    const delayedSettle = shadingSessionReducer(active, {
      type: "transaction-settled",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    expect(delayedSettle).toBe(active);
    expect(delayedSettle.active?.sourceInputRevision).toBe(12);
  });

  it("cannot roll a current display back or make stale geometry exportable", () => {
    const current = succeed(
      launch(createShadingSessionState(identity(3), 12)),
    );
    const delayed = shadingSessionReducer(current, {
      type: "transaction-settled",
      identity: identity(2),
      sourceInputRevision: 11,
    });

    expect(delayed).toBe(current);
    expect(delayed.sourceInputRevision).toBe(12);
    expect(selectExportableShadingResult(delayed)).toBe(current.displayed);
  });

  it("does not duplicate exact active work and advances its provenance", () => {
    const active = launch(createShadingSessionState(identity(1), 10));
    const settled = shadingSessionReducer(active, {
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
    const active = launch(createShadingSessionState(identity(1), 10));
    expect(
      shadingSessionReducer(active, {
        type: "succeeded",
        token: active.active!.token + 1,
        identity: active.active!.identity,
        scene: sceneA,
        diagnostics: completedDiagnostics,
        computeTimeMs: 12,
      }),
    ).toBe(active);
    expect(
      shadingSessionReducer(active, {
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
    const begunB = shadingSessionReducer(a, { type: "transaction-began" });
    const previewB = shadingSessionReducer(begunB, {
      type: "desired-identity-changed",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    const pendingB = shadingSessionReducer(previewB, {
      type: "transaction-settled",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    const activeB = launch(pendingB);
    const begunA = shadingSessionReducer(activeB, {
      type: "transaction-began",
    });
    const previewA = shadingSessionReducer(begunA, {
      type: "desired-identity-changed",
      identity: identity(1),
      sourceInputRevision: 12,
    });
    const promoted = shadingSessionReducer(previewA, {
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
    expect(selectCurrentShadingResult(promoted)).toBe(promoted.displayed);
    expect(
      shadingSessionReducer(promoted, {
        type: "transaction-settled",
        identity: identity(1),
        sourceInputRevision: 12,
      }),
    ).toBe(promoted);
  });

  it("retains stale completion through cancellation and failure", () => {
    const completed = completedA();
    const pendingB = shadingSessionReducer(completed, {
      type: "transaction-settled",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    const activeB = launch(pendingB);
    const cancelled = shadingSessionReducer(activeB, {
      type: "cancelled",
      token: activeB.active!.token,
    });
    expect(cancelled.displayed).toBe(completed.displayed);
    expect(cancelled.failure).toBeNull();
    expect(selectCurrentShadingResult(cancelled)).toBeNull();

    const pendingAgain = shadingSessionReducer(cancelled, {
      type: "transaction-settled",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    const activeAgain = launch(pendingAgain);
    const failed = shadingSessionReducer(activeAgain, {
      type: "failed",
      token: activeAgain.active!.token,
      identity: activeAgain.active!.identity,
      error: "safe detail",
    });
    expect(failed.displayed).toBe(completed.displayed);
    expect(failed.failure).toBe("safe detail");
    expect(selectCurrentShadingResult(failed)).toBeNull();
  });

  it("keeps the displayed fidelity variant attached while desired controls change", () => {
    const completed = completedA();
    const replacement = shadingSessionReducer(completed, {
      type: "transaction-settled",
      identity: identity(2),
      sourceInputRevision: 11,
    });

    expect(replacement.desiredIdentity).toEqual(identity(2));
    expect(replacement.displayed?.diagnostics).toBe(completedDiagnostics);
    expect(replacement.displayed?.diagnostics.fidelity).toEqual({
      kind: "scribble",
      residualError: 0.01,
    });
    expect(selectCurrentShadingResult(replacement)).toBeNull();
  });

  it("rejects stale cancellation and failure terminals", () => {
    const active = launch(createShadingSessionState(identity(1), 10));
    expect(
      shadingSessionReducer(active, { type: "cancelled", token: 99 }),
    ).toBe(active);
    expect(
      shadingSessionReducer(active, {
        type: "failed",
        token: active.active!.token,
        identity: identity(2),
        error: "wrong job",
      }),
    ).toBe(active);
  });

  it("records an initial failure without fabricating a display", () => {
    const active = launch(createShadingSessionState(identity(1), 10));
    const failed = shadingSessionReducer(active, {
      type: "failed",
      token: active.active!.token,
      identity: active.active!.identity,
      error: "safe detail",
    });

    expect(failed.displayed).toBeNull();
    expect(failed.failure).toBe("safe detail");
    expect(selectExportableShadingResult(failed)).toBeNull();
  });

  it("re-enqueues one current failed identity and ignores obsolete retries", () => {
    const active = launch(createShadingSessionState(identity(2), 11));
    const failed = shadingSessionReducer(active, {
      type: "failed",
      token: active.active!.token,
      identity: active.active!.identity,
      error: "analysis failed",
    });
    const obsolete = shadingSessionReducer(failed, {
      type: "retry",
      identity: identity(1),
      sourceInputRevision: 10,
    });
    expect(obsolete).toBe(failed);

    const retried = shadingSessionReducer(failed, {
      type: "retry",
      identity: failed.desiredIdentity!,
      sourceInputRevision: failed.sourceInputRevision!,
    });
    expect(retried.pending).toEqual({
      token: failed.nextToken,
      identity: failed.desiredIdentity,
      sourceInputRevision: 11,
    });
    expect(retried.failure).toBeNull();
    expect(retried.nextToken).toBe(failed.nextToken + 1);
    expect(
      shadingSessionReducer(retried, {
        type: "retry",
        identity: retried.desiredIdentity!,
        sourceInputRevision: retried.sourceInputRevision!,
      }),
    ).toBe(retried);
  });

  it("suspends active ownership synchronously while preserving desired state and display", () => {
    const completed = completedA();
    const active = launch(
      shadingSessionReducer(completed, {
        type: "transaction-settled",
        identity: identity(2),
        sourceInputRevision: 11,
      }),
    );
    const suspended = shadingSessionReducer(active, { type: "suspend" });

    expect(suspended.suspended).toBe(true);
    expect(suspended.desiredIdentity).toBe(active.desiredIdentity);
    expect(suspended.sourceInputRevision).toBe(11);
    expect(suspended.displayed).toBe(completed.displayed);
    expect(suspended.pending).toBeNull();
    expect(suspended.active).toBeNull();
    expect(
      shadingSessionReducer(suspended, { type: "suspend" }),
    ).toBe(suspended);

    const staleSuccess = shadingSessionReducer(suspended, {
      type: "succeeded",
      token: active.active!.token,
      identity: active.active!.identity,
      scene: sceneB,
      diagnostics: completedDiagnostics,
      computeTimeMs: 20,
    });
    expect(staleSuccess).toBe(suspended);
  });

  it("records only the latest authored state while suspended and resumes it once", () => {
    const suspended = shadingSessionReducer(completedA(), {
      type: "suspend",
    });
    const begun = shadingSessionReducer(suspended, {
      type: "transaction-began",
    });
    const first = shadingSessionReducer(begun, {
      type: "desired-identity-changed",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    const latest = shadingSessionReducer(first, {
      type: "desired-identity-changed",
      identity: identity(3),
      sourceInputRevision: 12,
    });
    const settled = shadingSessionReducer(latest, {
      type: "transaction-settled",
      identity: identity(3),
      sourceInputRevision: 12,
    });

    expect(settled.suspended).toBe(true);
    expect(settled.transactionOpen).toBe(false);
    expect(settled.pending).toBeNull();
    expect(settled.active).toBeNull();
    expect(settled.nextToken).toBe(suspended.nextToken);
    expect(settled.desiredIdentity).toEqual(identity(3));
    expect(settled.sourceInputRevision).toBe(12);

    const resumed = shadingSessionReducer(settled, {
      type: "resume-latest",
    });
    expect(resumed.suspended).toBe(false);
    expect(resumed.pending).toEqual({
      token: suspended.nextToken,
      identity: settled.desiredIdentity,
      sourceInputRevision: 12,
    });
    expect(resumed.nextToken).toBe(suspended.nextToken + 1);
    expect(
      shadingSessionReducer(resumed, { type: "resume-latest" }),
    ).toBe(resumed);
  });

  it("does not enqueue on resume when the displayed result is already exact", () => {
    const completed = completedA();
    const suspended = shadingSessionReducer(completed, { type: "suspend" });
    const promoted = shadingSessionReducer(suspended, {
      type: "transaction-settled",
      identity: identity(1),
      sourceInputRevision: 11,
    });
    const resumed = shadingSessionReducer(promoted, {
      type: "resume-latest",
    });

    expect(promoted.displayed?.sourceInputRevision).toBe(11);
    expect(resumed.suspended).toBe(false);
    expect(resumed.pending).toBeNull();
    expect(resumed.nextToken).toBe(promoted.nextToken);
    expect(selectCurrentShadingResult(resumed)).toBe(resumed.displayed);
  });

  it.each([
    ["budget-exhausted", exhaustedDiagnostics],
    ["stopped-early", stoppedEarlyDiagnostics],
  ] as const)("exports current %s completion but never stale completion", (_, diagnostics) => {
    const exhausted = succeed(
      launch(createShadingSessionState(identity(1), 10)),
      sceneA,
      diagnostics,
    );
    expect(selectExportableShadingResult(exhausted)).toBe(
      exhausted.displayed,
    );

    const begun = shadingSessionReducer(exhausted, {
      type: "transaction-began",
    });
    expect(selectExportableShadingResult(begun)).toBeNull();
    const preview = shadingSessionReducer(begun, {
      type: "desired-identity-changed",
      identity: identity(2),
      sourceInputRevision: 11,
    });
    expect(selectExportableShadingResult(preview)).toBeNull();
  });

  it("disposal clears desired, work, display, failures, and counters", () => {
    const active = launch(createShadingSessionState(identity(1), 10));
    const disposed = shadingSessionReducer(active, { type: "dispose" });

    expect(disposed).toEqual({
      desiredIdentity: null,
      sourceInputRevision: null,
      transactionOpen: false,
      suspended: false,
      pending: null,
      active: null,
      displayed: null,
      failure: null,
      nextToken: 1,
      nextContentRevision: 1,
    });
    expect(selectCurrentShadingResult(disposed)).toBeNull();
  });
});
