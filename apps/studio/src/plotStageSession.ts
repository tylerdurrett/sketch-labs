import type { Scene } from "@harness/core";

import {
  PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH,
  copyPlotStagePreparationIdentity,
  copyPlotStageRegistrationIdentity,
  plotStagePreparationIdentitiesEqual,
  plotStageRegistrationIdentitiesEqual,
  type PlotStagePreparationIdentity,
  type PlotStageRegistrationIdentity,
} from "./plotStagePreparationProtocol";

export interface PlotStageExpectedIdentity {
  readonly identity: PlotStagePreparationIdentity;
  readonly registrationIdentity: PlotStageRegistrationIdentity;
}

export interface PlotStagePreparationRequest
  extends PlotStageExpectedIdentity {
  readonly token: number;
}

export interface PlotStageCompletedScene extends PlotStageExpectedIdentity {
  readonly token: number;
  /** Ordinary generator output. Styling and finalization remain downstream. */
  readonly scene: Scene;
}

export interface PlotStageFailure extends PlotStageExpectedIdentity {
  readonly error: string;
}

export interface PlotStageState {
  /** The latest authored identity, whether demanded or not. */
  readonly expected: PlotStageExpectedIdentity | null;
  /** Once demanded, identity changes continue preparing this Stage. */
  readonly demanded: boolean;
  readonly pending: PlotStagePreparationRequest | null;
  readonly active: PlotStagePreparationRequest | null;
  /** Deliberately one retained completed Scene, even while it is stale. */
  readonly completed: PlotStageCompletedScene | null;
  readonly failure: PlotStageFailure | null;
  readonly nextToken: number;
}

export interface PlotStageSessionState {
  /**
   * Stage instance ID is the sole address. Reusable generator identity never
   * participates in retained ownership.
   */
  readonly stages: Readonly<Record<string, PlotStageState>>;
  readonly disposed: boolean;
}

export type PlotStageSessionAction =
  | ({
      readonly type: "identity-changed";
    } & PlotStageExpectedIdentity)
  | { readonly type: "demanded"; readonly stageId: string }
  | {
      readonly type: "launched";
      readonly stageId: string;
      readonly token: number;
    }
  | ({
      readonly type: "succeeded";
      readonly stageId: string;
      readonly token: number;
      readonly scene: Scene;
    } & PlotStageExpectedIdentity)
  | ({
      readonly type: "failed";
      readonly stageId: string;
      readonly token: number;
      readonly error: string;
    } & PlotStageExpectedIdentity)
  | {
      readonly type: "cancelled";
      readonly stageId: string;
      readonly token: number;
    }
  | { readonly type: "retry"; readonly stageId: string }
  | { readonly type: "dispose" };

export type PlotStagePreparingState = "idle" | "pending" | "active";

export interface PlotStageStatus {
  readonly demanded: boolean;
  readonly preparing: PlotStagePreparingState;
  /** Whether retained geometry matches the expected preparation identity. */
  readonly current: boolean;
  /** Whether retained geometry is both current and registration-compatible. */
  readonly ready: boolean;
  readonly error: string | null;
}

const EMPTY_STAGE_STATUS: PlotStageStatus = Object.freeze({
  demanded: false,
  preparing: "idle",
  current: false,
  ready: false,
  error: null,
});

const hasOwn = (
  stages: Readonly<Record<string, PlotStageState>>,
  stageId: string,
): boolean => Object.prototype.hasOwnProperty.call(stages, stageId);

function createPlotStageState(): PlotStageState {
  return {
    expected: null,
    demanded: false,
    pending: null,
    active: null,
    completed: null,
    failure: null,
    nextToken: 1,
  };
}

export function createPlotStageSessionState(): PlotStageSessionState {
  return {
    stages: {},
    disposed: false,
  };
}

function identitiesEqual(
  left: PlotStageExpectedIdentity | null,
  right: PlotStageExpectedIdentity,
): boolean {
  return (
    left !== null &&
    plotStagePreparationIdentitiesEqual(left.identity, right.identity) &&
    plotStageRegistrationIdentitiesEqual(
      left.registrationIdentity,
      right.registrationIdentity,
    )
  );
}

function copyExpectedIdentity(
  expected: PlotStageExpectedIdentity,
): PlotStageExpectedIdentity {
  return {
    identity: copyPlotStagePreparationIdentity(expected.identity),
    registrationIdentity: copyPlotStageRegistrationIdentity(
      expected.registrationIdentity,
    ),
  };
}

function requestMatches(
  request: PlotStagePreparationRequest | null,
  action: {
    readonly token: number;
    readonly identity: PlotStagePreparationIdentity;
    readonly registrationIdentity: PlotStageRegistrationIdentity;
  },
): request is PlotStagePreparationRequest {
  return (
    request?.token === action.token &&
    plotStagePreparationIdentitiesEqual(request.identity, action.identity) &&
    plotStageRegistrationIdentitiesEqual(
      request.registrationIdentity,
      action.registrationIdentity,
    )
  );
}

function enqueue(
  stage: PlotStageState,
  expected: PlotStageExpectedIdentity,
): PlotStageState {
  const token = stage.nextToken;
  return {
    ...stage,
    demanded: true,
    pending: { token, ...expected },
    active: null,
    failure: null,
    nextToken: token + 1,
  };
}

function isReadyFor(
  completed: PlotStageCompletedScene | null,
  expected: PlotStageExpectedIdentity | null,
): boolean {
  return expected !== null && identitiesEqual(completed, expected);
}

function boundedFailure(error: string): string {
  const detail = error.trim();
  return detail === ""
    ? "Plot Stage preparation failed"
    : detail.slice(0, PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH);
}

function updateStage(
  state: PlotStageSessionState,
  stageId: string,
  update: (stage: PlotStageState) => PlotStageState,
): PlotStageSessionState {
  const previous = hasOwn(state.stages, stageId)
    ? state.stages[stageId]!
    : createPlotStageState();
  const next = update(previous);
  if (next === previous) return state;

  const stages = { ...state.stages };
  Object.defineProperty(stages, stageId, {
    value: next,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return {
    ...state,
    stages,
  };
}

/**
 * Pure latest-identity-wins state for retained supporting Plot Stages.
 *
 * View selection is intentionally absent. Once a Stage is demanded, merely
 * changing views cannot retire its pending/active work or retained outcome.
 */
export function plotStageSessionReducer(
  state: PlotStageSessionState,
  action: PlotStageSessionAction,
): PlotStageSessionState {
  if (state.disposed) return state;

  switch (action.type) {
    case "identity-changed": {
      const stageId = action.identity.stageId;
      return updateStage(state, stageId, (stage) => {
        if (identitiesEqual(stage.expected, action)) return stage;

        const expected = copyExpectedIdentity(action);
        const changed: PlotStageState = {
          ...stage,
          expected,
          pending: null,
          active: null,
          failure: null,
        };
        if (!stage.demanded || isReadyFor(stage.completed, expected)) {
          return changed;
        }
        return enqueue(changed, expected);
      });
    }

    case "demanded":
      return updateStage(state, action.stageId, (stage) => {
        if (stage.demanded) return stage;
        if (
          stage.expected === null ||
          isReadyFor(stage.completed, stage.expected)
        ) {
          return { ...stage, demanded: true };
        }
        return enqueue(stage, stage.expected);
      });

    case "launched":
      return updateStage(state, action.stageId, (stage) => {
        if (stage.pending?.token !== action.token) return stage;
        return {
          ...stage,
          pending: null,
          active: stage.pending,
        };
      });

    case "succeeded":
      return updateStage(state, action.stageId, (stage) => {
        if (!requestMatches(stage.active, action)) return stage;
        return {
          ...stage,
          active: null,
          completed: {
            token: action.token,
            identity: stage.active.identity,
            registrationIdentity: stage.active.registrationIdentity,
            scene: action.scene,
          },
          failure: null,
        };
      });

    case "failed":
      return updateStage(state, action.stageId, (stage) => {
        if (!requestMatches(stage.active, action)) return stage;
        return {
          ...stage,
          active: null,
          failure: {
            identity: stage.active.identity,
            registrationIdentity: stage.active.registrationIdentity,
            error: boundedFailure(action.error),
          },
        };
      });

    case "cancelled":
      return updateStage(state, action.stageId, (stage) => {
        if (
          stage.pending?.token !== action.token &&
          stage.active?.token !== action.token
        ) {
          return stage;
        }
        return {
          ...stage,
          demanded: false,
          pending: null,
          active: null,
        };
      });

    case "retry":
      return updateStage(state, action.stageId, (stage) => {
        if (
          stage.failure === null ||
          stage.expected === null ||
          !identitiesEqual(stage.failure, stage.expected)
        ) {
          return stage;
        }
        return enqueue(stage, stage.expected);
      });

    case "dispose":
      return {
        stages: {},
        disposed: true,
      };
  }
}

export function selectPlotStage(
  state: PlotStageSessionState,
  stageId: string,
): PlotStageState | undefined {
  return hasOwn(state.stages, stageId) ? state.stages[stageId] : undefined;
}

export function selectPlotStageStatus(
  state: PlotStageSessionState,
  stageId: string,
): PlotStageStatus {
  const stage = selectPlotStage(state, stageId);
  if (stage === undefined) return EMPTY_STAGE_STATUS;

  const current =
    stage.expected !== null &&
    stage.completed !== null &&
    plotStagePreparationIdentitiesEqual(
      stage.completed.identity,
      stage.expected.identity,
    );
  const ready =
    current &&
    plotStageRegistrationIdentitiesEqual(
      stage.completed!.registrationIdentity,
      stage.expected!.registrationIdentity,
    );

  return {
    demanded: stage.demanded,
    preparing:
      stage.active !== null
        ? "active"
        : stage.pending !== null
          ? "pending"
          : "idle",
    current,
    ready,
    error: stage.failure?.error ?? null,
  };
}

/** Return retained geometry even when it is intentionally stale. */
export function selectRetainedPlotStageScene(
  state: PlotStageSessionState,
  stageId: string,
): Scene | undefined {
  return selectPlotStage(state, stageId)?.completed?.scene;
}

/** Return geometry only when both preparation and registration are current. */
export function selectCurrentPlotStageScene(
  state: PlotStageSessionState,
  stageId: string,
): Scene | undefined {
  const stage = selectPlotStage(state, stageId);
  return stage !== undefined &&
    selectPlotStageStatus(state, stageId).ready
    ? stage.completed!.scene
    : undefined;
}
