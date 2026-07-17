import { describe, expect, it } from "vitest";

import type { ParamSchema, PlotProfile, Scene } from "@harness/core";

import {
  createHiddenLineExportSnapshot,
  createOutlineComputeIdentity,
} from "./outlineComputeProtocol";
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
const profile: PlotProfile = {
  width: 200,
  height: 160,
  insets: { top: 10, right: 10, bottom: 10, left: 10 },
  includeFrame: false,
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

function exportSnapshot(amount = 1, width = profile.width) {
  return createHiddenLineExportSnapshot({
    identity: identity(amount),
    profile: { ...profile, width },
    metadata: "metadata",
    includePaperMargins: true,
    filename: "test-hidden-line.svg",
  });
}

function completedSession(): OutlineSessionState {
  const active = activeSession();
  return outlineSessionReducer(active, {
    type: "succeeded",
    token: active.active!.token,
    identity: active.active!.identity,
    scene: outline,
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

  it("waits for acknowledged Scribble content and preserves provenance through completion", () => {
    const waiting = outlineSessionReducer(createOutlineSessionState(), {
      type: "request-outline",
      launch: false,
    });
    expect(waiting.capture).toBeNull();

    const provenance = { sourceInputRevision: 4, contentRevision: 7 };
    const requested = outlineSessionReducer(waiting, {
      type: "source-ready",
      provenance,
    });
    expect(requested.capture).toMatchObject(provenance);

    const active = outlineSessionReducer(requested, {
      type: "fill-captured",
      token: requested.capture!.token,
      inputRevision: requested.inputRevision,
      identity: identity(),
      scene: fill,
      t: 2,
      ...provenance,
    });
    expect(active.phase).toMatchObject({
      kind: "fill-held-pending",
      ...provenance,
    });
    expect(active.active).toMatchObject(provenance);

    const complete = outlineSessionReducer(active, {
      type: "succeeded",
      token: active.active!.token,
      identity: active.active!.identity,
      scene: outline,
    });
    expect(complete.phase).toMatchObject({ kind: "outline", ...provenance });
    expect(complete.cache).toMatchObject(provenance);

    const fillMode = outlineSessionReducer(complete, { type: "request-fill" });
    const changedProvenance = { sourceInputRevision: 5, contentRevision: 8 };
    const changedRequest = outlineSessionReducer(fillMode, {
      type: "request-outline",
      provenance: changedProvenance,
    });
    const notReused = outlineSessionReducer(changedRequest, {
      type: "fill-captured",
      token: changedRequest.capture!.token,
      inputRevision: changedRequest.inputRevision,
      identity: identity(),
      scene: fill,
      t: 2,
      ...changedProvenance,
    });
    expect(notReused.active).not.toBeNull();
    expect(notReused.phase).toMatchObject(changedProvenance);
  });

  it("keeps desired Outline through transaction previews and launches once on settle", () => {
    const outlined = activeSession();
    const begun = outlineSessionReducer(outlined, {
      type: "transaction-began",
    });
    expect(begun.desired).toBe("outline");
    expect(begun.phase).toEqual({ kind: "fill-live" });
    expect(begun.capture).toBeNull();
    expect(begun.active).toBeNull();
    expect(begun.cache).toBe(outlined.cache);

    const preview = outlineSessionReducer(begun, {
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

  it("gives an immutable export sole slot ownership while edits coalesce one latest Outline intent", () => {
    const requested = outlineSessionReducer(
      { ...createOutlineSessionState(), desired: "outline" },
      { type: "request-export", snapshot: exportSnapshot() },
    );
    const token = requested.exportActive!.token;
    const frozenSnapshot = requested.exportActive!.snapshot;

    expect(requested.slot).toEqual({ owner: "hidden-line-export", token });
    expect(requested.exportActive).toMatchObject({ phase: "deriving" });
    expect(
      outlineSessionReducer(requested, {
        type: "request-export",
        snapshot: exportSnapshot(2),
      }),
    ).toBe(requested);
    expect(
      outlineSessionReducer(requested, { type: "cancelled", token }),
    ).toBe(requested);

    const begun = outlineSessionReducer(requested, {
      type: "transaction-began",
    });
    const firstPreview = outlineSessionReducer(begun, {
      type: "inputs-changed",
      launch: false,
    });
    const latestPreview = outlineSessionReducer(firstPreview, {
      type: "inputs-changed",
      launch: false,
    });
    const committed = outlineSessionReducer(latestPreview, {
      type: "inputs-changed",
      launch: true,
    });
    expect(committed.slot).toEqual(requested.slot);
    expect(committed.exportActive?.snapshot).toBe(frozenSnapshot);
    expect(committed.transactionOpen).toBe(false);
    expect(committed.deferredOutline).toEqual({
      inputRevision: committed.inputRevision,
    });
    expect(committed.capture).toBeNull();

    const finalizing = outlineSessionReducer(committed, {
      type: "export-finalizing",
      token,
    });
    expect(finalizing.exportActive?.phase).toBe("finalizing");
  });

  it("waits for an open edit to settle, then emits exactly one latest Outline capture", () => {
    const exporting = outlineSessionReducer(
      { ...createOutlineSessionState(), desired: "outline" },
      { type: "request-export", snapshot: exportSnapshot() },
    );
    const begun = outlineSessionReducer(exporting, {
      type: "transaction-began",
    });
    const previewed = outlineSessionReducer(begun, {
      type: "inputs-changed",
      launch: false,
    });
    const succeeded = outlineSessionReducer(previewed, {
      type: "export-succeeded",
      token: exporting.exportActive!.token,
      completedOutline: { identity: identity(), scene: outline },
    });

    expect(succeeded.slot).toBeNull();
    expect(succeeded.capture).toBeNull();
    expect(succeeded.deferredOutline).toEqual({
      inputRevision: succeeded.inputRevision,
    });
    expect(succeeded.cache?.scene).toEqual(outline);

    const settled = outlineSessionReducer(succeeded, {
      type: "transaction-settled",
    });
    expect(settled.capture).toEqual({
      token: settled.nextToken - 1,
      inputRevision: settled.inputRevision,
    });
    expect(settled.deferredOutline).toBeNull();
  });

  it("reuses an export-completed Outline across profile-only changes but not identity changes", () => {
    const exporting = outlineSessionReducer(
      { ...createOutlineSessionState(), desired: "outline" },
      { type: "request-export", snapshot: exportSnapshot(1, 240) },
    );
    const succeeded = outlineSessionReducer(exporting, {
      type: "export-succeeded",
      token: exporting.exportActive!.token,
      completedOutline: { identity: identity(), scene: outline },
    });
    const sameIdentity = outlineSessionReducer(succeeded, {
      type: "fill-captured",
      token: succeeded.capture!.token,
      inputRevision: succeeded.inputRevision,
      identity: exportSnapshot(1, 300).identity,
      scene: fill,
      t: 2,
    });
    expect(sameIdentity.phase).toEqual({
      kind: "outline",
      scene: succeeded.cache!.scene,
      t: 2,
    });
    expect(sameIdentity.slot).toBeNull();

    const requested = outlineSessionReducer(sameIdentity, {
      type: "request-outline",
    });
    const mismatch = outlineSessionReducer(requested, {
      type: "fill-captured",
      token: requested.capture!.token,
      inputRevision: requested.inputRevision,
      identity: identity(2),
      scene: fill,
      t: 2,
    });
    expect(mismatch.slot).toEqual({
      owner: "outline-preview",
      token: mismatch.active!.token,
    });
  });

  it.each([
    ["success", "export-succeeded"],
    ["cancel", "export-cancelled"],
    ["failure", "export-failed"],
  ] as const)(
    "preserves a displayed completed Outline after export %s without another capture",
    (_label, terminal) => {
      const complete = completedSession();
      const exporting = outlineSessionReducer(complete, {
        type: "request-export",
        snapshot: exportSnapshot(),
      });

      expect(exporting.phase).toBe(complete.phase);
      expect(exporting.deferredOutline).toBeNull();

      const settled = outlineSessionReducer(
        exporting,
        terminal === "export-succeeded"
          ? {
              type: terminal,
              token: exporting.exportActive!.token,
              completedOutline: { identity: identity(), scene: outline },
            }
          : terminal === "export-failed"
            ? {
                type: terminal,
                token: exporting.exportActive!.token,
                error: "safe detail",
              }
            : { type: terminal, token: exporting.exportActive!.token },
      );

      expect(settled.phase).toBe(complete.phase);
      expect(settled.capture).toBeNull();
      expect(settled.deferredOutline).toBeNull();
      expect(settled.slot).toBeNull();
    },
  );

  it.each([
    ["success", "export-succeeded"],
    ["cancel", "export-cancelled"],
    ["failure", "export-failed"],
  ] as const)(
    "releases exactly one latest invalidated Outline after export %s",
    (_label, terminal) => {
      const exporting = outlineSessionReducer(completedSession(), {
        type: "request-export",
        snapshot: exportSnapshot(),
      });
      const firstEdit = outlineSessionReducer(exporting, {
        type: "inputs-changed",
        launch: true,
      });
      const latestEdit = outlineSessionReducer(firstEdit, {
        type: "inputs-changed",
        launch: true,
      });
      const nextTokenBeforeSettlement = latestEdit.nextToken;

      const settled = outlineSessionReducer(
        latestEdit,
        terminal === "export-succeeded"
          ? {
              type: terminal,
              token: exporting.exportActive!.token,
              completedOutline: { identity: identity(), scene: outline },
            }
          : terminal === "export-failed"
            ? {
                type: terminal,
                token: exporting.exportActive!.token,
                error: "safe detail",
              }
            : { type: terminal, token: exporting.exportActive!.token },
      );

      expect(settled.capture).toEqual({
        token: nextTokenBeforeSettlement,
        inputRevision: latestEdit.inputRevision,
      });
      expect(settled.nextToken).toBe(nextTokenBeforeSettlement + 1);
      expect(settled.deferredOutline).toBeNull();
    },
  );

  it("preserves the sole completed cache on export cancel/failure and ignores stale settlement", () => {
    const complete = completedSession();
    const exporting = outlineSessionReducer(complete, {
      type: "request-export",
      snapshot: exportSnapshot(2),
    });
    const stale = outlineSessionReducer(exporting, {
      type: "export-failed",
      token: exporting.exportActive!.token + 1,
      error: "stale",
    });
    expect(stale).toBe(exporting);

    const failed = outlineSessionReducer(exporting, {
      type: "export-failed",
      token: exporting.exportActive!.token,
      error: "safe detail",
    });
    expect(failed.cache).toBe(complete.cache);
    expect(failed.exportFailure).toBe("safe detail");
    expect(failed.capture).toBeNull();

    const fillExport = outlineSessionReducer(
      outlineSessionReducer(failed, { type: "request-fill" }),
      { type: "request-export", snapshot: exportSnapshot(2) },
    );
    const cancelled = outlineSessionReducer(fillExport, {
      type: "export-cancelled",
      token: fillExport.exportActive!.token,
    });
    expect(cancelled.cache).toBe(complete.cache);
    expect(cancelled.capture).toBeNull();
    expect(cancelled.exportFailure).toBeNull();
  });

  it("dispose clears export ownership, failures, deferred work, and the cache", () => {
    const exporting = outlineSessionReducer(completedSession(), {
      type: "request-export",
      snapshot: exportSnapshot(2),
    });
    const editing = outlineSessionReducer(exporting, {
      type: "transaction-began",
    });
    expect(outlineSessionReducer(editing, { type: "dispose" })).toEqual(
      createOutlineSessionState(),
    );
  });
});
