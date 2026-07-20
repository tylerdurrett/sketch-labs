import type { PreparedImageDetailAnalysis } from "@harness/core";

import {
  DETAIL_PREPARATION_ERROR_MAX_LENGTH,
  detailPreparationIdentitiesEqual,
  type DetailPreparationIdentity,
} from "./detailPreparationProtocol";

export interface DetailPreparationRequestRecord {
  readonly token: number;
  readonly identity: DetailPreparationIdentity;
}

export interface PreparedDetailRecord {
  /** Session token that produced this exact record; guards A -> B -> A reuse. */
  readonly token: number;
  readonly identity: DetailPreparationIdentity;
  readonly prepared: PreparedImageDetailAnalysis;
}

export interface DetailPreparationFailureRecord {
  readonly identity: DetailPreparationIdentity;
  readonly error: string;
}

export interface DetailSessionState {
  /** The exact analysis the current diagnostic view wants, if any. */
  readonly requestedIdentity: DetailPreparationIdentity | null;
  readonly pending: DetailPreparationRequestRecord | null;
  readonly active: DetailPreparationRequestRecord | null;
  /** A deliberately one-entry exact-identity cache. */
  readonly prepared: PreparedDetailRecord | null;
  readonly failure: DetailPreparationFailureRecord | null;
  readonly nextToken: number;
  readonly disposed: boolean;
}

export type DetailSessionAction =
  | {
      readonly type: "requested";
      readonly identity: DetailPreparationIdentity;
    }
  | {
      readonly type: "launched";
      readonly token: number;
      readonly identity: DetailPreparationIdentity;
    }
  | {
      readonly type: "succeeded";
      readonly token: number;
      readonly identity: DetailPreparationIdentity;
      readonly prepared: PreparedImageDetailAnalysis;
    }
  | {
      readonly type: "failed";
      readonly token: number;
      readonly identity: DetailPreparationIdentity;
      readonly error: string;
    }
  | {
      readonly type: "cancelled";
      readonly token: number;
      readonly identity: DetailPreparationIdentity;
    }
  | {
      readonly type: "retry";
      readonly identity: DetailPreparationIdentity;
    }
  | {
      readonly type: "prepared-rejected";
      readonly token: number;
      readonly identity: DetailPreparationIdentity;
      readonly error: string;
    }
  | { readonly type: "unrequested" }
  | { readonly type: "dispose" };

export function createDetailSessionState(): DetailSessionState {
  return {
    requestedIdentity: null,
    pending: null,
    active: null,
    prepared: null,
    failure: null,
    nextToken: 1,
    disposed: false,
  };
}

function identitiesEqual(
  left: DetailPreparationIdentity | null,
  right: DetailPreparationIdentity,
): boolean {
  return left !== null && detailPreparationIdentitiesEqual(left, right);
}

function requestMatches(
  request: DetailPreparationRequestRecord | null,
  token: number,
  identity: DetailPreparationIdentity,
): boolean {
  return (
    request?.token === token &&
    detailPreparationIdentitiesEqual(request.identity, identity)
  );
}

function boundedFailure(error: string): string {
  const detail = error.trim();
  return detail === ""
    ? "Detail preparation failed"
    : detail.slice(0, DETAIL_PREPARATION_ERROR_MAX_LENGTH);
}

function enqueue(
  state: DetailSessionState,
  identity: DetailPreparationIdentity,
): DetailSessionState {
  const token = state.nextToken;
  return {
    ...state,
    requestedIdentity: identity,
    pending: { token, identity },
    active: null,
    prepared: null,
    failure: null,
    nextToken: token + 1,
  };
}

/** Pure latest-input-wins state for explicitly requested Detail preparation. */
export function detailSessionReducer(
  state: DetailSessionState,
  action: DetailSessionAction,
): DetailSessionState {
  if (state.disposed) return state;

  switch (action.type) {
    case "requested":
      if (identitiesEqual(state.prepared?.identity ?? null, action.identity)) {
        if (
          identitiesEqual(state.requestedIdentity, action.identity) &&
          state.pending === null &&
          state.active === null &&
          state.failure === null
        ) {
          return state;
        }
        return {
          ...state,
          requestedIdentity: action.identity,
          pending: null,
          active: null,
          failure: null,
        };
      }
      if (
        identitiesEqual(state.requestedIdentity, action.identity) &&
        (identitiesEqual(state.pending?.identity ?? null, action.identity) ||
          identitiesEqual(state.active?.identity ?? null, action.identity) ||
          identitiesEqual(state.failure?.identity ?? null, action.identity))
      ) {
        return state;
      }
      return enqueue(state, action.identity);

    case "launched":
      if (!requestMatches(state.pending, action.token, action.identity)) {
        return state;
      }
      return { ...state, pending: null, active: state.pending };

    case "succeeded":
      if (!requestMatches(state.active, action.token, action.identity)) {
        return state;
      }
      return {
        ...state,
        active: null,
        prepared: {
          token: action.token,
          identity: action.identity,
          prepared: action.prepared,
        },
        failure: null,
      };

    case "failed":
      if (!requestMatches(state.active, action.token, action.identity)) {
        return state;
      }
      return {
        ...state,
        active: null,
        prepared: null,
        failure: {
          identity: action.identity,
          error: boundedFailure(action.error),
        },
      };

    case "cancelled": {
      if (!requestMatches(state.active, action.token, action.identity)) {
        return state;
      }
      if (!identitiesEqual(state.requestedIdentity, action.identity)) {
        return { ...state, active: null };
      }
      return enqueue({ ...state, active: null }, action.identity);
    }

    case "retry":
      if (
        state.failure === null ||
        !identitiesEqual(state.failure.identity, action.identity) ||
        !identitiesEqual(state.requestedIdentity, action.identity)
      ) {
        return state;
      }
      return enqueue(state, action.identity);

    case "prepared-rejected":
      if (
        state.prepared === null ||
        !requestMatches(state.prepared, action.token, action.identity) ||
        !identitiesEqual(state.requestedIdentity, action.identity)
      ) {
        return state;
      }
      return {
        ...state,
        prepared: null,
        failure: {
          identity: action.identity,
          error: boundedFailure(action.error),
        },
      };

    case "unrequested":
      if (
        state.requestedIdentity === null &&
        state.pending === null &&
        state.active === null &&
        state.failure === null
      ) {
        return state;
      }
      return {
        ...state,
        requestedIdentity: null,
        pending: null,
        active: null,
        failure: null,
      };

    case "dispose":
      return {
        ...state,
        requestedIdentity: null,
        pending: null,
        active: null,
        prepared: null,
        failure: null,
        disposed: true,
      };
  }
}

/** Resolve only the single prepared record matching the requested exact key. */
export function selectPreparedDetailAnalysis(
  state: DetailSessionState,
  identity: DetailPreparationIdentity,
): PreparedImageDetailAnalysis | undefined {
  return identitiesEqual(state.requestedIdentity, identity) &&
    identitiesEqual(state.prepared?.identity ?? null, identity)
    ? state.prepared!.prepared
    : undefined;
}
