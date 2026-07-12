import { describe, expect, it } from "vitest";

import type { ParamSchema, Scene } from "@harness/core";

import { createOutlineComputeIdentity } from "./outlineComputeProtocol";
import {
  createOutlineSessionState,
  outlineSessionReducer,
  type OutlineSessionState,
} from "./outlineSession";

const schema: ParamSchema = {
  amount: { kind: "number", min: 0, max: 10, default: 1 },
};
const fill: Scene = {
  space: { width: 20, height: 20 },
  primitives: [{ points: [[0, 0], [10, 10]], stroke: { color: "red", width: 1 } }],
};
const outline: Scene = {
  space: fill.space,
  primitives: [{ points: [[0, 0], [10, 10]], stroke: { color: "black", width: 1 } }],
};

function identity(amount = 1) {
  return createOutlineComputeIdentity({
    sketchId: "test",
    schema,
    params: { amount },
    seed: 1,
    sampledT: 2,
    compositionFrame: fill.space,
    tolerance: 0,
    includeFrame: false,
    sourceScene: fill,
  });
}

function activeSession(): OutlineSessionState {
  const requested = outlineSessionReducer(createOutlineSessionState(), {
    type: "request-outline",
  });
  return outlineSessionReducer(requested, {
    type: "fill-captured",
    token: requested.capture!.token,
    inputRevision: requested.inputRevision,
    identity: identity(),
    scene: fill,
    t: 2,
  });
}

describe("outlineSessionReducer", () => {
  it("holds the exact Fill until success atomically commits Scene and mode", () => {
    const active = activeSession();
    expect(active.phase).toEqual({ kind: "fill-held-pending", scene: fill, t: 2 });

    const complete = outlineSessionReducer(active, {
      type: "succeeded",
      token: active.active!.token,
      identity: active.active!.identity,
      scene: outline,
    });
    expect(complete.phase).toEqual({ kind: "outline", scene: outline, t: 2 });
    expect(complete.active).toBeNull();
    expect(complete.cache?.scene).toBe(outline);
  });

  it("rejects stale capture and success tokens without changing current state", () => {
    const requested = outlineSessionReducer(createOutlineSessionState(), {
      type: "request-outline",
    });
    expect(
      outlineSessionReducer(requested, {
        type: "fill-captured",
        token: requested.capture!.token + 1,
        inputRevision: requested.inputRevision,
        identity: identity(),
        scene: fill,
        t: 2,
      }),
    ).toBe(requested);

    const active = activeSession();
    expect(
      outlineSessionReducer(active, {
        type: "succeeded",
        token: active.active!.token + 1,
        identity: active.active!.identity,
        scene: outline,
      }),
    ).toBe(active);
  });

  it("retains exactly the newest successful cache across cancel and failure", () => {
    const active = activeSession();
    const complete = outlineSessionReducer(active, {
      type: "succeeded",
      token: active.active!.token,
      identity: active.active!.identity,
      scene: outline,
    });
    const changed = outlineSessionReducer(complete, {
      type: "inputs-changed",
      launch: true,
    });
    const captured = outlineSessionReducer(changed, {
      type: "fill-captured",
      token: changed.capture!.token,
      inputRevision: changed.inputRevision,
      identity: identity(2),
      scene: fill,
      t: 3,
    });
    const failed = outlineSessionReducer(captured, {
      type: "failed",
      token: captured.active!.token,
      error: "safe",
    });
    expect(failed.cache).toBe(complete.cache);

    const requestedAgain = outlineSessionReducer(
      { ...failed, desired: "outline" },
      { type: "request-outline" },
    );
    const cancelled = outlineSessionReducer(requestedAgain, {
      type: "cancelled",
    });
    expect(cancelled.cache).toBe(complete.cache);
  });

  it("reuses only an exact cached identity without occupying the slot", () => {
    const active = activeSession();
    const complete = outlineSessionReducer(active, {
      type: "succeeded",
      token: active.active!.token,
      identity: active.active!.identity,
      scene: outline,
    });
    const fillMode = outlineSessionReducer(complete, { type: "request-fill" });
    const requested = outlineSessionReducer(fillMode, { type: "request-outline" });
    const reused = outlineSessionReducer(requested, {
      type: "fill-captured",
      token: requested.capture!.token,
      inputRevision: requested.inputRevision,
      identity: identity(),
      scene: fill,
      t: 2,
    });
    expect(reused.phase).toEqual({ kind: "outline", scene: outline, t: 2 });
    expect(reused.active).toBeNull();
  });

  it("keeps desired Outline through transaction previews and launches once on settle", () => {
    const outlined = { ...createOutlineSessionState(), desired: "outline" as const };
    const preview = outlineSessionReducer(outlined, {
      type: "inputs-changed",
      launch: false,
    });
    expect(preview.desired).toBe("outline");
    expect(preview.capture).toBeNull();

    const settled = outlineSessionReducer(preview, {
      type: "request-outline",
    });
    expect(settled.capture).toEqual({
      token: settled.nextToken - 1,
      inputRevision: settled.inputRevision,
    });
  });

  it("dispose drops active metadata and the one-entry cache", () => {
    const state = activeSession();
    expect(outlineSessionReducer(state, { type: "dispose" })).toEqual(
      createOutlineSessionState(),
    );
  });
});
