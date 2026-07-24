import type { Scene } from "@harness/core";

import {
  flowingContoursComputeIdentitiesEqual,
  type FlowingContoursComputeIdentity,
} from "./flowingContoursComputeProtocol";

export interface PendingFlowingContoursRequest {
  readonly token: number;
  readonly identity: FlowingContoursComputeIdentity;
  readonly sourceInputRevision: number;
}

export type ActiveFlowingContoursRequest = PendingFlowingContoursRequest;

export interface DisplayedFlowingContoursResult {
  readonly identity: FlowingContoursComputeIdentity;
  readonly scene: Scene;
  readonly computeTimeMs: number;
  readonly sourceInputRevision: number;
  /** Changes on worker completion and exact-cache promotion. */
  readonly contentRevision: number;
}

export interface FlowingContoursSessionState {
  readonly desiredIdentity: FlowingContoursComputeIdentity | null;
  readonly sourceInputRevision: number | null;
  readonly transactionOpen: boolean;
  readonly suspended: boolean;
  readonly pending: PendingFlowingContoursRequest | null;
  readonly active: ActiveFlowingContoursRequest | null;
  /** The exact one-entry Scene cache and stale display. */
  readonly displayed: DisplayedFlowingContoursResult | null;
  readonly failure: string | null;
  readonly nextToken: number;
  readonly nextContentRevision: number;
}

export type FlowingContoursSessionAction =
  | { readonly type: "suspend" }
  | { readonly type: "resume-latest" }
  | { readonly type: "transaction-began" }
  | {
      readonly type: "desired-identity-changed";
      readonly identity: FlowingContoursComputeIdentity;
      readonly sourceInputRevision: number;
    }
  | {
      readonly type: "transaction-settled";
      readonly identity: FlowingContoursComputeIdentity;
      readonly sourceInputRevision: number;
    }
  | {
      readonly type: "launched";
      readonly token: number;
      readonly identity: FlowingContoursComputeIdentity;
    }
  | {
      readonly type: "succeeded";
      readonly token: number;
      readonly identity: FlowingContoursComputeIdentity;
      readonly scene: Scene;
      readonly computeTimeMs: number;
    }
  | { readonly type: "cancelled"; readonly token: number }
  | {
      readonly type: "failed";
      readonly token: number;
      readonly identity: FlowingContoursComputeIdentity;
      readonly error: string;
    }
  | {
      readonly type: "retry";
      readonly identity: FlowingContoursComputeIdentity;
      readonly sourceInputRevision: number;
    }
  | { readonly type: "dispose" };

function emptyState(): FlowingContoursSessionState {
  return {
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
  };
}

export function createInactiveFlowingContoursSessionState(): FlowingContoursSessionState {
  return emptyState();
}

export function createFlowingContoursSessionState(
  identity: FlowingContoursComputeIdentity,
  sourceInputRevision: number,
): FlowingContoursSessionState {
  return {
    ...emptyState(),
    desiredIdentity: identity,
    sourceInputRevision,
    pending: { token: 1, identity, sourceInputRevision },
    nextToken: 2,
  };
}

function identitiesEqual(
  left: FlowingContoursComputeIdentity | null,
  right: FlowingContoursComputeIdentity,
): boolean {
  return left !== null && flowingContoursComputeIdentitiesEqual(left, right);
}

function requestMatches(
  request:
    | PendingFlowingContoursRequest
    | ActiveFlowingContoursRequest
    | null,
  identity: FlowingContoursComputeIdentity,
): boolean {
  return request !== null && identitiesEqual(request.identity, identity);
}

function desiredMatches(
  state: FlowingContoursSessionState,
  identity: FlowingContoursComputeIdentity,
  sourceInputRevision: number,
): boolean {
  return (
    state.sourceInputRevision === sourceInputRevision &&
    identitiesEqual(state.desiredIdentity, identity)
  );
}

function staleRevision(
  state: FlowingContoursSessionState,
  sourceInputRevision: number,
): boolean {
  return (
    state.sourceInputRevision !== null &&
    sourceInputRevision < state.sourceInputRevision
  );
}

function settle(
  state: FlowingContoursSessionState,
  identity: FlowingContoursComputeIdentity,
  sourceInputRevision: number,
): FlowingContoursSessionState {
  const unchanged = desiredMatches(state, identity, sourceInputRevision);

  // A→B→A promotes the sole cached A Scene immediately and cancels B. This is
  // exact identity reuse, not a multi-entry hidden cache.
  if (identitiesEqual(state.displayed?.identity ?? null, identity)) {
    if (
      unchanged &&
      !state.transactionOpen &&
      state.displayed?.sourceInputRevision === sourceInputRevision &&
      state.pending === null &&
      state.active === null
    ) {
      return state;
    }
    const contentRevision = state.nextContentRevision;
    return {
      ...state,
      desiredIdentity: identity,
      sourceInputRevision,
      transactionOpen: false,
      pending: null,
      active: null,
      displayed: {
        ...state.displayed!,
        identity,
        sourceInputRevision,
        contentRevision,
      },
      failure: null,
      nextContentRevision: contentRevision + 1,
    };
  }

  if (state.suspended) {
    return {
      ...state,
      desiredIdentity: identity,
      sourceInputRevision,
      transactionOpen: false,
      pending: null,
      active: null,
      failure: null,
    };
  }

  if (requestMatches(state.active, identity)) {
    return {
      ...state,
      desiredIdentity: identity,
      sourceInputRevision,
      transactionOpen: false,
      pending: null,
      active: { ...state.active!, identity, sourceInputRevision },
      failure: null,
    };
  }
  if (requestMatches(state.pending, identity)) {
    return {
      ...state,
      desiredIdentity: identity,
      sourceInputRevision,
      transactionOpen: false,
      pending: { ...state.pending!, identity, sourceInputRevision },
      active: null,
      failure: null,
    };
  }

  const token = state.nextToken;
  return {
    ...state,
    desiredIdentity: identity,
    sourceInputRevision,
    transactionOpen: false,
    pending: { token, identity, sourceInputRevision },
    active: null,
    failure: null,
    nextToken: token + 1,
  };
}

/** Pure latest-input-wins state for Flowing Contours Scene preparation. */
export function flowingContoursSessionReducer(
  state: FlowingContoursSessionState,
  action: FlowingContoursSessionAction,
): FlowingContoursSessionState {
  switch (action.type) {
    case "suspend":
      if (state.suspended && state.pending === null && state.active === null) {
        return state;
      }
      return {
        ...state,
        suspended: true,
        pending: null,
        active: null,
      };
    case "resume-latest": {
      if (!state.suspended) return state;
      const resumed = { ...state, suspended: false };
      if (
        resumed.transactionOpen ||
        resumed.desiredIdentity === null ||
        resumed.sourceInputRevision === null ||
        (resumed.displayed !== null &&
          resumed.displayed.sourceInputRevision ===
            resumed.sourceInputRevision &&
          identitiesEqual(resumed.displayed.identity, resumed.desiredIdentity))
      ) {
        return resumed;
      }
      const token = resumed.nextToken;
      return {
        ...resumed,
        pending: {
          token,
          identity: resumed.desiredIdentity,
          sourceInputRevision: resumed.sourceInputRevision,
        },
        failure: null,
        nextToken: token + 1,
      };
    }
    case "transaction-began":
      if (
        state.transactionOpen &&
        state.pending === null &&
        state.active === null &&
        state.failure === null
      ) {
        return state;
      }
      return {
        ...state,
        transactionOpen: true,
        pending: null,
        active: null,
        failure: null,
      };
    case "desired-identity-changed":
      if (
        staleRevision(state, action.sourceInputRevision) ||
        desiredMatches(state, action.identity, action.sourceInputRevision)
      ) {
        return state;
      }
      return {
        ...state,
        desiredIdentity: action.identity,
        sourceInputRevision: action.sourceInputRevision,
        pending: null,
        active: null,
        failure: null,
      };
    case "transaction-settled":
      if (staleRevision(state, action.sourceInputRevision)) return state;
      return settle(state, action.identity, action.sourceInputRevision);
    case "launched":
      if (
        state.pending?.token !== action.token ||
        !identitiesEqual(state.pending.identity, action.identity)
      ) {
        return state;
      }
      return { ...state, pending: null, active: state.pending };
    case "succeeded": {
      const active = state.active;
      if (
        active?.token !== action.token ||
        !identitiesEqual(active.identity, action.identity)
      ) {
        return state;
      }
      const contentRevision = state.nextContentRevision;
      return {
        ...state,
        active: null,
        displayed: {
          identity: action.identity,
          scene: action.scene,
          computeTimeMs: action.computeTimeMs,
          sourceInputRevision: active.sourceInputRevision,
          contentRevision,
        },
        failure: null,
        nextContentRevision: contentRevision + 1,
      };
    }
    case "cancelled":
      return state.active?.token === action.token
        ? { ...state, active: null, failure: null }
        : state;
    case "failed":
      if (
        state.active?.token !== action.token ||
        !identitiesEqual(state.active.identity, action.identity)
      ) {
        return state;
      }
      return { ...state, active: null, failure: action.error };
    case "retry": {
      if (
        state.failure === null ||
        state.transactionOpen ||
        state.suspended ||
        state.pending !== null ||
        state.active !== null ||
        !desiredMatches(state, action.identity, action.sourceInputRevision)
      ) {
        return state;
      }
      const token = state.nextToken;
      return {
        ...state,
        pending: {
          token,
          identity: action.identity,
          sourceInputRevision: action.sourceInputRevision,
        },
        failure: null,
        nextToken: token + 1,
      };
    }
    case "dispose":
      return emptyState();
  }
}

export function selectCurrentFlowingContoursResult(
  state: FlowingContoursSessionState,
): DisplayedFlowingContoursResult | null {
  if (
    state.transactionOpen ||
    state.displayed === null ||
    state.sourceInputRevision === null ||
    state.displayed.sourceInputRevision !== state.sourceInputRevision ||
    !identitiesEqual(state.desiredIdentity, state.displayed.identity)
  ) {
    return null;
  }
  return state.displayed;
}
