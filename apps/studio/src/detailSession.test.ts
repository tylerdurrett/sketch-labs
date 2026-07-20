import { describe, expect, it } from "vitest";

import {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  type PreparedImageDetailAnalysis,
} from "@harness/core";

import {
  createDetailPreparationIdentity,
  type DetailPreparationIdentity,
} from "./detailPreparationProtocol";
import {
  createDetailSessionState,
  detailSessionReducer,
  selectPreparedDetailAnalysis,
  type DetailSessionState,
} from "./detailSession";

function identity(imageAssetId: string): DetailPreparationIdentity {
  return createDetailPreparationIdentity({
    imageAssetId,
    analysisDefinitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  });
}

const firstIdentity = identity("pinecone-4330aa0314f7");
const secondIdentity = identity("doggo-2c7b56f9257e");

function prepared(value = 0.5): PreparedImageDetailAnalysis {
  return {
    definitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
    sourceWidth: 1,
    sourceHeight: 1,
    gridWidth: 1,
    gridHeight: 1,
    data: new Float64Array([value]),
  };
}

function request(
  state: DetailSessionState,
  requestedIdentity = firstIdentity,
): DetailSessionState {
  return detailSessionReducer(state, {
    type: "requested",
    identity: requestedIdentity,
  });
}

function launch(state: DetailSessionState): DetailSessionState {
  return detailSessionReducer(state, {
    type: "launched",
    token: state.pending!.token,
    identity: state.pending!.identity,
  });
}

function succeed(
  state: DetailSessionState,
  value = prepared(),
): DetailSessionState {
  return detailSessionReducer(state, {
    type: "succeeded",
    token: state.active!.token,
    identity: state.active!.identity,
    prepared: value,
  });
}

describe("detailSessionReducer", () => {
  it("stays idle until an exact identity is explicitly requested", () => {
    const idle = createDetailSessionState();

    expect(idle).toMatchObject({
      requestedIdentity: null,
      pending: null,
      active: null,
      prepared: null,
      failure: null,
      nextToken: 1,
    });

    const pending = request(idle);
    expect(pending.pending).toEqual({ token: 1, identity: firstIdentity });
    expect(pending.nextToken).toBe(2);
  });

  it("moves only the matching token and exact identity into active ownership", () => {
    const pending = request(createDetailSessionState());

    expect(
      detailSessionReducer(pending, {
        type: "launched",
        token: 2,
        identity: firstIdentity,
      }),
    ).toBe(pending);
    expect(
      detailSessionReducer(pending, {
        type: "launched",
        token: 1,
        identity: secondIdentity,
      }),
    ).toBe(pending);

    const active = launch(pending);
    expect(active.pending).toBeNull();
    expect(active.active).toBe(pending.pending);
  });

  it("replaces obsolete active work, clears its unusable cache, and queues only latest", () => {
    const completed = succeed(launch(request(createDetailSessionState())));
    const activeAgain = launch(request(completed, secondIdentity));
    const latest = request(activeAgain, firstIdentity);

    expect(latest.requestedIdentity).toBe(firstIdentity);
    expect(latest.active).toBeNull();
    expect(latest.prepared).toBeNull();
    expect(latest.pending).toEqual({ token: 3, identity: firstIdentity });
  });

  it("accepts completion and failure only for the active token and exact identity", () => {
    const active = launch(request(createDetailSessionState()));
    const successAction = {
      type: "succeeded" as const,
      token: active.active!.token,
      identity: firstIdentity,
      prepared: prepared(),
    };

    expect(
      detailSessionReducer(active, { ...successAction, token: 99 }),
    ).toBe(active);
    expect(
      detailSessionReducer(active, {
        ...successAction,
        identity: secondIdentity,
      }),
    ).toBe(active);
    expect(
      detailSessionReducer(active, {
        type: "failed",
        token: active.active!.token,
        identity: secondIdentity,
        error: "stale failure",
      }),
    ).toBe(active);

    const completed = detailSessionReducer(active, successAction);
    expect(selectPreparedDetailAnalysis(completed, firstIdentity)).toBe(
      successAction.prepared,
    );
    expect(selectPreparedDetailAnalysis(completed, secondIdentity)).toBeUndefined();
  });

  it("reuses the one exact prepared record without allocating another token", () => {
    const completed = succeed(launch(request(createDetailSessionState())));

    const repeated = request(completed, identity("pinecone-4330aa0314f7"));
    expect(repeated).toBe(completed);
    expect(repeated.pending).toBeNull();
    expect(repeated.nextToken).toBe(2);
  });

  it("bounds a retryable failure and retries the same identity without mutation", () => {
    const active = launch(request(createDetailSessionState()));
    const failed = detailSessionReducer(active, {
      type: "failed",
      token: active.active!.token,
      identity: firstIdentity,
      error: `  ${"x".repeat(600)}  `,
    });

    expect(failed.failure).toEqual({
      identity: firstIdentity,
      error: "x".repeat(500),
    });
    expect(request(failed)).toBe(failed);

    const retried = detailSessionReducer(failed, {
      type: "retry",
      identity: firstIdentity,
    });
    expect(retried.pending).toEqual({ token: 2, identity: firstIdentity });
    expect(retried.failure).toBeNull();
  });

  it("turns only a current prepared binding rejection into retryable failure", () => {
    const completed = succeed(launch(request(createDetailSessionState())));

    expect(
      detailSessionReducer(completed, {
        type: "prepared-rejected",
        token: completed.prepared!.token,
        identity: secondIdentity,
        error: "stale rejection",
      }),
    ).toBe(completed);

    const rejected = detailSessionReducer(completed, {
      type: "prepared-rejected",
      token: completed.prepared!.token,
      identity: firstIdentity,
      error: "field binding failed",
    });
    expect(rejected.prepared).toBeNull();
    expect(rejected.failure).toEqual({
      identity: firstIdentity,
      error: "field binding failed",
    });
    expect(selectPreparedDetailAnalysis(rejected, firstIdentity)).toBeUndefined();
  });

  it("ignores an A rejection from before an A to B to A cache cycle", () => {
    const firstA = succeed(launch(request(createDetailSessionState())));
    const firstAToken = firstA.prepared!.token;
    const completedB = succeed(launch(request(firstA, secondIdentity)));
    const latestA = succeed(launch(request(completedB, firstIdentity)));

    expect(latestA.prepared).toMatchObject({
      token: 3,
      identity: firstIdentity,
    });
    expect(
      detailSessionReducer(latestA, {
        type: "prepared-rejected",
        token: firstAToken,
        identity: firstIdentity,
        error: "delayed token-one binding error",
      }),
    ).toBe(latestA);

    const rejectedCurrent = detailSessionReducer(latestA, {
      type: "prepared-rejected",
      token: latestA.prepared!.token,
      identity: firstIdentity,
      error: "current binding error",
    });
    expect(rejectedCurrent.prepared).toBeNull();
    expect(rejectedCurrent.failure?.error).toBe("current binding error");
  });

  it("requeues current cancellation and disposal rejects every stale outcome", () => {
    const active = launch(request(createDetailSessionState()));
    const cancelled = detailSessionReducer(active, {
      type: "cancelled",
      token: active.active!.token,
      identity: firstIdentity,
    });
    expect(cancelled.pending).toEqual({ token: 2, identity: firstIdentity });

    const disposed = detailSessionReducer(cancelled, { type: "dispose" });
    expect(disposed).toMatchObject({
      requestedIdentity: null,
      pending: null,
      active: null,
      prepared: null,
      failure: null,
      disposed: true,
    });
    expect(request(disposed)).toBe(disposed);
    expect(
      detailSessionReducer(disposed, {
        type: "succeeded",
        token: 2,
        identity: firstIdentity,
        prepared: prepared(),
      }),
    ).toBe(disposed);
  });
});
