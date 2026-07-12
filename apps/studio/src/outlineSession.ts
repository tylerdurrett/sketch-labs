import type { Scene } from "@harness/core";

import {
  outlineComputeIdentitiesEqual,
  type OutlineComputeIdentity,
} from "./outlineComputeProtocol";

export type OutlineSessionPhase =
  | { readonly kind: "fill-live" }
  | {
      readonly kind: "fill-held-pending";
      readonly scene: Scene;
      readonly t: number;
    }
  | { readonly kind: "outline"; readonly scene: Scene; readonly t: number };

export interface OutlineSessionCache {
  readonly identity: OutlineComputeIdentity;
  readonly scene: Scene;
  readonly t: number;
}

export interface OutlineSessionActive {
  readonly token: number;
  readonly identity: OutlineComputeIdentity;
  readonly scene: Scene;
  readonly t: number;
}

export interface OutlineSessionState {
  readonly desired: "fill" | "outline";
  readonly phase: OutlineSessionPhase;
  readonly inputRevision: number;
  readonly nextToken: number;
  readonly capture: { readonly token: number; readonly inputRevision: number } | null;
  readonly active: OutlineSessionActive | null;
  readonly cache: OutlineSessionCache | null;
  readonly failure: string | null;
}

export type OutlineSessionAction =
  | { readonly type: "request-outline" }
  | { readonly type: "request-fill" }
  | {
      readonly type: "fill-captured";
      readonly token: number;
      readonly inputRevision: number;
      readonly identity: OutlineComputeIdentity;
      readonly scene: Scene;
      readonly t: number;
    }
  | {
      readonly type: "succeeded";
      readonly token: number;
      readonly identity: OutlineComputeIdentity;
      readonly scene: Scene;
    }
  | { readonly type: "cancelled"; readonly token?: number }
  | { readonly type: "failed"; readonly token: number; readonly error: string }
  | { readonly type: "edit-began" }
  | { readonly type: "inputs-changed"; readonly launch: boolean }
  | { readonly type: "dispose" };

export function createOutlineSessionState(): OutlineSessionState {
  return {
    desired: "fill",
    phase: { kind: "fill-live" },
    inputRevision: 0,
    nextToken: 1,
    capture: null,
    active: null,
    cache: null,
    failure: null,
  };
}

function requestCapture(state: OutlineSessionState): OutlineSessionState {
  const token = state.nextToken;
  return {
    ...state,
    phase: { kind: "fill-live" },
    nextToken: token + 1,
    capture: { token, inputRevision: state.inputRevision },
    active: null,
    failure: null,
  };
}

/** Pure, stale-safe state machine for one keyed Sketch's one-slot Outline work. */
export function outlineSessionReducer(
  state: OutlineSessionState,
  action: OutlineSessionAction,
): OutlineSessionState {
  switch (action.type) {
    case "request-outline":
      return requestCapture({ ...state, desired: "outline" });
    case "request-fill":
      return {
        ...state,
        desired: "fill",
        phase: { kind: "fill-live" },
        capture: null,
        active: null,
        failure: null,
      };
    case "fill-captured": {
      if (
        state.desired !== "outline" ||
        state.capture?.token !== action.token ||
        state.capture.inputRevision !== action.inputRevision ||
        state.inputRevision !== action.inputRevision
      ) {
        return state;
      }
      if (
        state.cache !== null &&
        outlineComputeIdentitiesEqual(state.cache.identity, action.identity)
      ) {
        return {
          ...state,
          phase: { kind: "outline", scene: state.cache.scene, t: state.cache.t },
          capture: null,
          active: null,
          failure: null,
        };
      }
      return {
        ...state,
        phase: { kind: "fill-held-pending", scene: action.scene, t: action.t },
        capture: null,
        active: {
          token: action.token,
          identity: action.identity,
          scene: action.scene,
          t: action.t,
        },
        failure: null,
      };
    }
    case "succeeded": {
      const active = state.active;
      if (
        state.desired !== "outline" ||
        active?.token !== action.token ||
        !outlineComputeIdentitiesEqual(active.identity, action.identity)
      ) {
        return state;
      }
      const cache = {
        identity: action.identity,
        scene: action.scene,
        t: active.t,
      };
      return {
        ...state,
        phase: { kind: "outline", scene: action.scene, t: active.t },
        active: null,
        cache,
        failure: null,
      };
    }
    case "cancelled":
      if (action.token !== undefined && state.active?.token !== action.token) {
        return state;
      }
      return {
        ...state,
        desired: "fill",
        phase: { kind: "fill-live" },
        capture: null,
        active: null,
        failure: null,
      };
    case "failed":
      if (state.active?.token !== action.token) return state;
      return {
        ...state,
        desired: "fill",
        phase: { kind: "fill-live" },
        active: null,
        failure: action.error,
      };
    case "edit-began":
      return {
        ...state,
        phase: { kind: "fill-live" },
        capture: null,
        active: null,
        failure: null,
      };
    case "inputs-changed": {
      const changed = {
        ...state,
        inputRevision: state.inputRevision + 1,
        phase: { kind: "fill-live" } as const,
        capture: null,
        active: null,
        failure: null,
      };
      return action.launch && state.desired === "outline"
        ? requestCapture(changed)
        : changed;
    }
    case "dispose":
      return createOutlineSessionState();
  }
}
