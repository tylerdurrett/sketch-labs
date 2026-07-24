import { describe, expect, it } from "vitest";

import type { Scene } from "@harness/core";

import {
  PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH,
  type PlotStagePreparationIdentity,
  type PlotStageRegistrationIdentity,
} from "./plotStagePreparationProtocol";
import {
  createPlotStageSessionState,
  plotStageSessionReducer,
  selectCurrentPlotStageScene,
  selectPlotStage,
  selectPlotStageStatus,
  selectRetainedPlotStageScene,
  type PlotStageSessionState,
} from "./plotStageSession";

const frame = { width: 320, height: 180 };

function identities(
  stageId: string,
  imageAsset: string,
  value = 1,
): {
  identity: PlotStagePreparationIdentity;
  registrationIdentity: PlotStageRegistrationIdentity;
} {
  return {
    identity: {
      sketchId: "photo-scribble",
      stageId,
      params: [
        { key: "imageAsset", value: imageAsset },
        { key: "value", value },
      ],
      compositionFrame: frame,
    },
    registrationIdentity: {
      params: [{ key: "imageAsset", value: imageAsset }],
      compositionFrame: frame,
    },
  };
}

function scene(color: string): Scene {
  return {
    space: frame,
    primitives: [
      {
        points: [
          [0, 0],
          [1, 1],
        ],
        stroke: { color, width: 1 },
      },
    ],
  };
}

function changeIdentity(
  state: PlotStageSessionState,
  expected: ReturnType<typeof identities>,
): PlotStageSessionState {
  return plotStageSessionReducer(state, {
    type: "identity-changed",
    ...expected,
  });
}

function demand(
  state: PlotStageSessionState,
  stageId: string,
): PlotStageSessionState {
  return plotStageSessionReducer(state, { type: "demanded", stageId });
}

function launch(
  state: PlotStageSessionState,
  stageId: string,
): PlotStageSessionState {
  const pending = selectPlotStage(state, stageId)!.pending!;
  return plotStageSessionReducer(state, {
    type: "launched",
    stageId,
    token: pending.token,
  });
}

function succeed(
  state: PlotStageSessionState,
  stageId: string,
  completedScene: Scene,
): PlotStageSessionState {
  const active = selectPlotStage(state, stageId)!.active!;
  return plotStageSessionReducer(state, {
    type: "succeeded",
    stageId,
    token: active.token,
    identity: active.identity,
    registrationIdentity: active.registrationIdentity,
    scene: completedScene,
  });
}

function complete(
  expected: ReturnType<typeof identities>,
  completedScene: Scene,
): PlotStageSessionState {
  const stageId = expected.identity.stageId;
  return succeed(
    launch(
      demand(
        changeIdentity(createPlotStageSessionState(), expected),
        stageId,
      ),
      stageId,
    ),
    stageId,
    completedScene,
  );
}

describe("plotStageSessionReducer", () => {
  it("records copied expected identity but stays lazy until the Stage is demanded", () => {
    const expected = identities("watercolor-forms", "image-a");
    const idle = changeIdentity(createPlotStageSessionState(), expected);
    const stage = selectPlotStage(idle, "watercolor-forms")!;

    expect(stage).toMatchObject({
      demanded: false,
      pending: null,
      active: null,
      completed: null,
      failure: null,
      nextToken: 1,
    });
    expect(stage.expected).toEqual(expected);
    expect(stage.expected).not.toBe(expected);
    expect(stage.expected!.identity).not.toBe(expected.identity);
    expect(stage.expected!.registrationIdentity).not.toBe(
      expected.registrationIdentity,
    );
    expect(Object.isFrozen(stage.expected!.identity)).toBe(true);
    expect(selectPlotStageStatus(idle, "watercolor-forms")).toEqual({
      demanded: false,
      preparing: "idle",
      current: false,
      ready: false,
      error: null,
    });
  });

  it("queues one per-Stage token on demand and launches only its matching pending owner", () => {
    const expected = identities("watercolor-forms", "image-a");
    const idle = changeIdentity(createPlotStageSessionState(), expected);
    const pending = demand(idle, "watercolor-forms");
    const pendingStage = selectPlotStage(pending, "watercolor-forms")!;

    expect(pendingStage.pending).toEqual({
      token: 1,
      ...pendingStage.expected,
    });
    expect(pendingStage.nextToken).toBe(2);
    expect(selectPlotStageStatus(pending, "watercolor-forms").preparing).toBe(
      "pending",
    );
    expect(demand(pending, "watercolor-forms")).toBe(pending);
    expect(
      plotStageSessionReducer(pending, {
        type: "launched",
        stageId: "watercolor-forms",
        token: 99,
      }),
    ).toBe(pending);

    const active = launch(pending, "watercolor-forms");
    expect(selectPlotStage(active, "watercolor-forms")).toMatchObject({
      pending: null,
      active: pendingStage.pending,
    });
    expect(selectPlotStageStatus(active, "watercolor-forms").preparing).toBe(
      "active",
    );
  });

  it("completes one current, registration-ready unfinalized Scene and reuses it exactly", () => {
    const expected = identities("watercolor-forms", "image-a");
    const completedScene = scene("blue");
    const completed = complete(expected, completedScene);
    const stage = selectPlotStage(completed, "watercolor-forms")!;

    expect(stage.completed).toEqual({
      token: 1,
      ...stage.expected,
      scene: completedScene,
    });
    expect(selectPlotStageStatus(completed, "watercolor-forms")).toEqual({
      demanded: true,
      preparing: "idle",
      current: true,
      ready: true,
      error: null,
    });
    expect(selectCurrentPlotStageScene(completed, "watercolor-forms")).toBe(
      completedScene,
    );
    expect(selectRetainedPlotStageScene(completed, "watercolor-forms")).toBe(
      completedScene,
    );
    expect(demand(completed, "watercolor-forms")).toBe(completed);
    expect(selectPlotStage(completed, "watercolor-forms")!.nextToken).toBe(2);
  });

  it("retires superseded ownership while retaining the last Scene as visibly stale", () => {
    const first = identities("watercolor-forms", "image-a");
    const second = identities("watercolor-forms", "image-b");
    const retained = scene("blue");
    const completed = complete(first, retained);
    const activeSecond = launch(
      changeIdentity(completed, second),
      "watercolor-forms",
    );
    const third = identities("watercolor-forms", "image-c");
    const pendingThird = changeIdentity(activeSecond, third);
    const stage = selectPlotStage(pendingThird, "watercolor-forms")!;

    expect(stage.active).toBeNull();
    expect(stage.pending).toMatchObject({ token: 3 });
    expect(stage.completed!.scene).toBe(retained);
    expect(selectRetainedPlotStageScene(pendingThird, "watercolor-forms")).toBe(
      retained,
    );
    expect(selectCurrentPlotStageScene(pendingThird, "watercolor-forms")).toBe(
      undefined,
    );
    expect(selectPlotStageStatus(pendingThird, "watercolor-forms")).toMatchObject(
      {
        preparing: "pending",
        current: false,
        ready: false,
      },
    );

    expect(
      plotStageSessionReducer(pendingThird, {
        type: "failed",
        stageId: "watercolor-forms",
        token: selectPlotStage(activeSecond, "watercolor-forms")!.active!.token,
        ...second,
        error: "late superseded failure",
      }),
    ).toBe(pendingThird);
  });

  it("promotes retained A without work on A to B to A while B is pending", () => {
    const identityA = identities("watercolor-forms", "image-a");
    const identityB = identities("watercolor-forms", "image-b");
    const retainedA = scene("blue");
    const completedA = complete(identityA, retainedA);
    const pendingB = changeIdentity(completedA, identityB);
    const bToken = selectPlotStage(pendingB, "watercolor-forms")!.pending!.token;
    const reusedA = changeIdentity(
      pendingB,
      identities("watercolor-forms", "image-a"),
    );
    const stage = selectPlotStage(reusedA, "watercolor-forms")!;

    expect(stage.pending).toBeNull();
    expect(stage.active).toBeNull();
    expect(stage.nextToken).toBe(3);
    expect(selectCurrentPlotStageScene(reusedA, "watercolor-forms")).toBe(
      retainedA,
    );

    const lateB = plotStageSessionReducer(reusedA, {
      type: "succeeded",
      stageId: "watercolor-forms",
      token: bToken,
      ...identityB,
      scene: scene("red"),
    });
    expect(lateB).toBe(reusedA);
  });

  it("ignores every success and failure without the exact active token and identities", () => {
    const expected = identities("watercolor-forms", "image-a");
    const active = launch(
      demand(
        changeIdentity(createPlotStageSessionState(), expected),
        "watercolor-forms",
      ),
      "watercolor-forms",
    );
    const token = selectPlotStage(active, "watercolor-forms")!.active!.token;
    const wrongIdentity = identities("watercolor-forms", "image-b");

    expect(
      plotStageSessionReducer(active, {
        type: "succeeded",
        stageId: "watercolor-forms",
        token: token + 1,
        ...expected,
        scene: scene("red"),
      }),
    ).toBe(active);
    expect(
      plotStageSessionReducer(active, {
        type: "succeeded",
        stageId: "watercolor-forms",
        token,
        ...wrongIdentity,
        scene: scene("red"),
      }),
    ).toBe(active);
    expect(
      plotStageSessionReducer(active, {
        type: "failed",
        stageId: "watercolor-forms",
        token,
        ...wrongIdentity,
        error: "stale",
      }),
    ).toBe(active);
  });

  it("bounds a Stage-local failure and retries only its still-current identity", () => {
    const expected = identities("watercolor-forms", "image-a");
    const active = launch(
      demand(
        changeIdentity(createPlotStageSessionState(), expected),
        "watercolor-forms",
      ),
      "watercolor-forms",
    );
    const request = selectPlotStage(active, "watercolor-forms")!.active!;
    const failed = plotStageSessionReducer(active, {
      type: "failed",
      stageId: "watercolor-forms",
      token: request.token,
      identity: request.identity,
      registrationIdentity: request.registrationIdentity,
      error: `  ${"x".repeat(PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH + 100)}  `,
    });

    expect(selectPlotStage(failed, "watercolor-forms")!.failure).toMatchObject({
      error: "x".repeat(PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH),
    });
    expect(selectRetainedPlotStageScene(failed, "watercolor-forms")).toBe(
      undefined,
    );
    expect(selectCurrentPlotStageScene(failed, "watercolor-forms")).toBe(
      undefined,
    );
    expect(selectPlotStageStatus(failed, "watercolor-forms")).toMatchObject({
      preparing: "idle",
      current: false,
      ready: false,
      error: "x".repeat(PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH),
    });

    const retried = plotStageSessionReducer(failed, {
      type: "retry",
      stageId: "watercolor-forms",
    });
    expect(selectPlotStage(retried, "watercolor-forms")).toMatchObject({
      pending: { token: 2 },
      active: null,
      failure: null,
      nextToken: 3,
    });
    expect(
      plotStageSessionReducer(retried, {
        type: "retry",
        stageId: "watercolor-forms",
      }),
    ).toBe(retried);
  });

  it("uses a stable local failure for whitespace and keeps other Stage state intact", () => {
    const watercolor = identities("watercolor-forms", "image-a");
    const contour = identities("contour-a", "image-a");
    const bothPending = demand(
      changeIdentity(
        demand(
          changeIdentity(createPlotStageSessionState(), watercolor),
          "watercolor-forms",
        ),
        contour,
      ),
      "contour-a",
    );
    const activeWatercolor = launch(bothPending, "watercolor-forms");
    const request = selectPlotStage(activeWatercolor, "watercolor-forms")!.active!;
    const failed = plotStageSessionReducer(activeWatercolor, {
      type: "failed",
      stageId: "watercolor-forms",
      token: request.token,
      identity: request.identity,
      registrationIdentity: request.registrationIdentity,
      error: "   ",
    });

    expect(selectPlotStageStatus(failed, "watercolor-forms").error).toBe(
      "Plot Stage preparation failed",
    );
    expect(selectPlotStage(failed, "contour-a")).toBe(
      selectPlotStage(activeWatercolor, "contour-a"),
    );
    expect(selectPlotStageStatus(failed, "contour-a").preparing).toBe(
      "pending",
    );
  });

  it("cancels only exact owned work, then permits a fresh explicit demand", () => {
    const expected = identities("watercolor-forms", "image-a");
    const pending = demand(
      changeIdentity(createPlotStageSessionState(), expected),
      "watercolor-forms",
    );
    const token = selectPlotStage(pending, "watercolor-forms")!.pending!.token;

    expect(
      plotStageSessionReducer(pending, {
        type: "cancelled",
        stageId: "watercolor-forms",
        token: token + 1,
      }),
    ).toBe(pending);

    const cancelled = plotStageSessionReducer(pending, {
      type: "cancelled",
      stageId: "watercolor-forms",
      token,
    });
    expect(selectPlotStage(cancelled, "watercolor-forms")).toMatchObject({
      demanded: false,
      pending: null,
      active: null,
      nextToken: 2,
    });

    const demandedAgain = demand(cancelled, "watercolor-forms");
    expect(selectPlotStage(demandedAgain, "watercolor-forms")).toMatchObject({
      demanded: true,
      pending: { token: 2 },
      nextToken: 3,
    });

    const active = launch(demandedAgain, "watercolor-forms");
    const activeToken = selectPlotStage(active, "watercolor-forms")!.active!
      .token;
    const activeCancelled = plotStageSessionReducer(active, {
      type: "cancelled",
      stageId: "watercolor-forms",
      token: activeToken,
    });
    expect(selectPlotStage(activeCancelled, "watercolor-forms")).toMatchObject({
      demanded: false,
      pending: null,
      active: null,
    });
    expect(
      plotStageSessionReducer(activeCancelled, {
        type: "cancelled",
        stageId: "watercolor-forms",
        token: activeToken,
      }),
    ).toBe(activeCancelled);
  });

  it("keeps duplicate reusable-generator Stage instances wholly independent by Stage ID", () => {
    const first = identities("contour-a", "image-a", 4);
    const duplicate = identities("contour-b", "image-a", 4);
    let state = changeIdentity(createPlotStageSessionState(), first);
    state = changeIdentity(state, duplicate);
    state = demand(state, "contour-a");
    state = demand(state, "contour-b");
    state = launch(state, "contour-a");
    state = succeed(state, "contour-a", scene("blue"));

    expect(Object.keys(state.stages).sort()).toEqual(["contour-a", "contour-b"]);
    expect(selectPlotStage(state, "contour-a")).toMatchObject({
      completed: { token: 1 },
      pending: null,
      nextToken: 2,
    });
    expect(selectPlotStage(state, "contour-b")).toMatchObject({
      completed: null,
      pending: { token: 1 },
      nextToken: 2,
    });
    expect(first.identity).not.toHaveProperty("generatorId");
    expect(duplicate.identity).not.toHaveProperty("generatorId");
  });

  it.each(["constructor", "toString", "__proto__"])(
    "addresses the valid inherited-name Stage ID %s as its own retained entry",
    (stageId) => {
      const expected = identities(stageId, "image-a");
      const identified = changeIdentity(
        createPlotStageSessionState(),
        expected,
      );

      expect(
        Object.prototype.hasOwnProperty.call(identified.stages, stageId),
      ).toBe(true);
      expect(selectPlotStage(identified, stageId)).toMatchObject({
        expected,
        demanded: false,
        nextToken: 1,
      });

      const pending = demand(identified, stageId);
      expect(selectPlotStage(pending, stageId)).toMatchObject({
        demanded: true,
        pending: { token: 1 },
        nextToken: 2,
      });
      expect(selectPlotStageStatus(pending, stageId)).toMatchObject({
        demanded: true,
        preparing: "pending",
        current: false,
        ready: false,
      });

      const active = launch(pending, stageId);
      expect(selectPlotStage(active, stageId)).toMatchObject({
        pending: null,
        active: { token: 1 },
        nextToken: 2,
      });
      expect(selectPlotStageStatus(active, stageId).preparing).toBe("active");
    },
  );

  it("preserves retained Scene and failure independently of unrelated demand/view concerns", () => {
    const watercolor = identities("watercolor-forms", "image-a");
    const retained = scene("blue");
    let state = complete(watercolor, retained);
    const changed = identities("watercolor-forms", "image-b");
    state = launch(changeIdentity(state, changed), "watercolor-forms");
    const request = selectPlotStage(state, "watercolor-forms")!.active!;
    state = plotStageSessionReducer(state, {
      type: "failed",
      stageId: "watercolor-forms",
      token: request.token,
      identity: request.identity,
      registrationIdentity: request.registrationIdentity,
      error: "watercolor failed",
    });
    const unchanged = changeIdentity(
      state,
      identities("contour-a", "image-b"),
    );

    expect(selectRetainedPlotStageScene(unchanged, "watercolor-forms")).toBe(
      retained,
    );
    expect(selectPlotStageStatus(unchanged, "watercolor-forms")).toMatchObject({
      preparing: "idle",
      current: false,
      ready: false,
      error: "watercolor failed",
    });
  });

  it("disposes all retained ownership and ignores every later action", () => {
    const expected = identities("watercolor-forms", "image-a");
    const completed = complete(expected, scene("blue"));
    const disposed = plotStageSessionReducer(completed, { type: "dispose" });

    expect(disposed).toEqual({ stages: {}, disposed: true });
    expect(changeIdentity(disposed, expected)).toBe(disposed);
    expect(demand(disposed, "watercolor-forms")).toBe(disposed);
    expect(
      plotStageSessionReducer(disposed, {
        type: "succeeded",
        stageId: "watercolor-forms",
        token: 1,
        ...expected,
        scene: scene("red"),
      }),
    ).toBe(disposed);
    expect(selectPlotStageStatus(disposed, "watercolor-forms")).toEqual({
      demanded: false,
      preparing: "idle",
      current: false,
      ready: false,
      error: null,
    });
  });
});
