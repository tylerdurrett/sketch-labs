import type { Scene, ScribbleDiagnostics } from "@harness/core";

import {
  scribbleComputeIdentitiesEqual,
  type ScribbleComputeIdentity,
} from "./scribbleComputeProtocol";

/** Work the driver has not started yet. */
export interface PendingScribbleRequest {
  readonly token: number;
  readonly identity: ScribbleComputeIdentity;
  readonly sourceInputRevision: number;
}

/** Work currently owned by the Scribble worker driver. */
export interface ActiveScribbleRequest {
  readonly token: number;
  readonly identity: ScribbleComputeIdentity;
  readonly sourceInputRevision: number;
}

/** The last complete Scribble record, whether current or intentionally stale. */
export interface DisplayedScribbleResult {
  readonly identity: ScribbleComputeIdentity;
  readonly scene: Scene;
  readonly diagnostics: ScribbleDiagnostics;
  readonly computeTimeMs: number;
  readonly sourceInputRevision: number;
  /** Changes on both worker completion and exact-cache promotion. */
  readonly contentRevision: number;
}

export interface ScribbleSessionState {
  readonly desiredIdentity: ScribbleComputeIdentity | null;
  readonly sourceInputRevision: number | null;
  readonly transactionOpen: boolean;
  /** Whether worker ownership is explicitly paused while authored state advances. */
  readonly suspended: boolean;
  readonly pending: PendingScribbleRequest | null;
  readonly active: ActiveScribbleRequest | null;
  readonly displayed: DisplayedScribbleResult | null;
  readonly failure: string | null;
  readonly nextToken: number;
  readonly nextContentRevision: number;
}

export type ScribbleSessionAction =
  | { readonly type: "suspend" }
  | { readonly type: "resume-latest" }
  | { readonly type: "transaction-began" }
  | {
      readonly type: "desired-identity-changed";
      readonly identity: ScribbleComputeIdentity;
      readonly sourceInputRevision: number;
    }
  | {
      readonly type: "transaction-settled";
      readonly identity: ScribbleComputeIdentity;
      readonly sourceInputRevision: number;
    }
  | {
      readonly type: "launched";
      readonly token: number;
      readonly identity: ScribbleComputeIdentity;
    }
  | {
      readonly type: "succeeded";
      readonly token: number;
      readonly identity: ScribbleComputeIdentity;
      readonly scene: Scene;
      readonly diagnostics: ScribbleDiagnostics;
      readonly computeTimeMs: number;
    }
  | { readonly type: "cancelled"; readonly token: number }
  | {
      readonly type: "failed";
      readonly token: number;
      readonly identity: ScribbleComputeIdentity;
      readonly error: string;
    }
  | {
      readonly type: "retry";
      readonly identity: ScribbleComputeIdentity;
      readonly sourceInputRevision: number;
    }
  | { readonly type: "dispose" };

function emptyScribbleSessionState(): ScribbleSessionState {
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

/** Create one session and enqueue its initial identity exactly once. */
export function createScribbleSessionState(
  initialIdentity: ScribbleComputeIdentity,
  initialInputRevision: number,
): ScribbleSessionState {
  const token = 1;
  return {
    ...emptyScribbleSessionState(),
    desiredIdentity: initialIdentity,
    sourceInputRevision: initialInputRevision,
    pending: {
      token,
      identity: initialIdentity,
      sourceInputRevision: initialInputRevision,
    },
    nextToken: token + 1,
  };
}

function identitiesEqual(
  left: ScribbleComputeIdentity | null,
  right: ScribbleComputeIdentity,
): boolean {
  return left !== null && scribbleComputeIdentitiesEqual(left, right);
}

function requestsSameIdentity(
  request: PendingScribbleRequest | ActiveScribbleRequest | null,
  identity: ScribbleComputeIdentity,
): boolean {
  return request !== null && identitiesEqual(request.identity, identity);
}

function desiredMatches(
  state: ScribbleSessionState,
  identity: ScribbleComputeIdentity,
  sourceInputRevision: number,
): boolean {
  return (
    state.sourceInputRevision === sourceInputRevision &&
    identitiesEqual(state.desiredIdentity, identity)
  );
}

function isStaleInputRevision(
  state: ScribbleSessionState,
  sourceInputRevision: number,
): boolean {
  return (
    state.sourceInputRevision !== null &&
    sourceInputRevision < state.sourceInputRevision
  );
}

function settleDesiredIdentity(
  state: ScribbleSessionState,
  identity: ScribbleComputeIdentity,
  sourceInputRevision: number,
): ScribbleSessionState {
  const desiredIsUnchanged = desiredMatches(
    state,
    identity,
    sourceInputRevision,
  );

  if (identitiesEqual(state.displayed?.identity ?? null, identity)) {
    const alreadyCurrent =
      desiredIsUnchanged &&
      !state.transactionOpen &&
      state.displayed?.sourceInputRevision === sourceInputRevision;
    if (alreadyCurrent && state.pending === null && state.active === null) {
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

  // Suspension records settled authored provenance without allocating work.
  // The single latest request, if still necessary, is derived on resume.
  if (state.suspended) {
    if (
      desiredIsUnchanged &&
      !state.transactionOpen &&
      state.pending === null &&
      state.active === null &&
      state.failure === null
    ) {
      return state;
    }
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

  if (requestsSameIdentity(state.active, identity)) {
    const alreadySettled =
      desiredIsUnchanged &&
      !state.transactionOpen &&
      state.active?.sourceInputRevision === sourceInputRevision &&
      state.pending === null;
    if (alreadySettled) return state;
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

  if (requestsSameIdentity(state.pending, identity)) {
    const alreadySettled =
      desiredIsUnchanged &&
      !state.transactionOpen &&
      state.pending?.sourceInputRevision === sourceInputRevision &&
      state.active === null;
    if (alreadySettled) return state;
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

/** Pure, stale-safe state machine for one keyed Sketch's Scribble preparation. */
export function scribbleSessionReducer(
  state: ScribbleSessionState,
  action: ScribbleSessionAction,
): ScribbleSessionState {
  switch (action.type) {
    case "suspend":
      if (
        state.suspended &&
        state.pending === null &&
        state.active === null
      ) {
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
          identitiesEqual(
            resumed.displayed.identity,
            resumed.desiredIdentity,
          ))
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
      if (isStaleInputRevision(state, action.sourceInputRevision)) {
        return state;
      }
      if (
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
      if (isStaleInputRevision(state, action.sourceInputRevision)) {
        return state;
      }
      return settleDesiredIdentity(
        state,
        action.identity,
        action.sourceInputRevision,
      );
    case "launched":
      if (
        state.pending?.token !== action.token ||
        !identitiesEqual(state.pending.identity, action.identity)
      ) {
        return state;
      }
      return {
        ...state,
        pending: null,
        active: state.pending,
      };
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
          diagnostics: action.diagnostics,
          computeTimeMs: action.computeTimeMs,
          sourceInputRevision: active.sourceInputRevision,
          contentRevision,
        },
        failure: null,
        nextContentRevision: contentRevision + 1,
      };
    }
    case "cancelled":
      if (state.active?.token !== action.token) return state;
      return { ...state, active: null, failure: null };
    case "failed":
      if (
        state.active?.token !== action.token ||
        !identitiesEqual(state.active.identity, action.identity)
      ) {
        return state;
      }
      return {
        ...state,
        active: null,
        failure: action.error,
      };
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
      return emptyScribbleSessionState();
  }
}

/** The displayed result is current only for the settled authored provenance. */
export function selectCurrentScribbleResult(
  state: ScribbleSessionState,
): DisplayedScribbleResult | null {
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

/** Budget exhaustion is a truthful completion and remains exportable when current. */
export function selectExportableScribbleResult(
  state: ScribbleSessionState,
): DisplayedScribbleResult | null {
  return selectCurrentScribbleResult(state);
}
