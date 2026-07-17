import type { Scene } from "@harness/core";

import {
  mutableScene,
  outlineComputeIdentitiesEqual,
  type CompletedOutline,
  type HiddenLineExportSnapshot,
  type OutlineComputeIdentity,
} from "./outlineComputeProtocol";

export type OutlineSessionPhase =
  | { readonly kind: "fill-live" }
  | {
      readonly kind: "fill-held-pending";
      readonly scene: Scene;
      readonly t: number;
    } & OutlineSourceProvenance
  | ({ readonly kind: "outline"; readonly scene: Scene; readonly t: number } &
      OutlineSourceProvenance);

export interface OutlineSourceProvenance {
  readonly sourceInputRevision?: number;
  readonly contentRevision?: number;
}

export interface OutlineSessionCache extends OutlineSourceProvenance {
  readonly identity: OutlineComputeIdentity;
  readonly scene: Scene;
  readonly t: number;
}

export interface OutlineSessionActive extends OutlineSourceProvenance {
  readonly token: number;
  readonly identity: OutlineComputeIdentity;
  readonly scene: Scene;
  readonly t: number;
}

export type OutlineSessionSlot =
  | { readonly owner: "outline-preview"; readonly token: number }
  | { readonly owner: "hidden-line-export"; readonly token: number };

export type OutlineExportPhase = "deriving" | "finalizing";

export interface OutlineExportActive extends OutlineSourceProvenance {
  readonly token: number;
  readonly snapshot: HiddenLineExportSnapshot;
  readonly phase: OutlineExportPhase;
}

export interface DeferredOutlineRequest extends OutlineSourceProvenance {
  readonly inputRevision: number;
  /** Present only while caller-owned geometry still needs a paint acknowledgement. */
  readonly waitsForSource?: true;
}

export interface OutlineSessionState {
  readonly desired: "fill" | "outline";
  readonly phase: OutlineSessionPhase;
  readonly inputRevision: number;
  readonly nextToken: number;
  readonly nextExportToken: number;
  readonly capture:
    | ({ readonly token: number; readonly inputRevision: number } &
        OutlineSourceProvenance)
    | null;
  readonly active: OutlineSessionActive | null;
  readonly slot: OutlineSessionSlot | null;
  readonly exportActive: OutlineExportActive | null;
  readonly exportFailure: string | null;
  readonly transactionOpen: boolean;
  readonly deferredOutline: DeferredOutlineRequest | null;
  readonly cache: OutlineSessionCache | null;
  readonly failure: string | null;
}

export type OutlineSessionAction =
  | {
      readonly type: "request-outline";
      readonly launch?: boolean;
      readonly provenance?: OutlineSourceProvenance;
    }
  | {
      readonly type: "source-ready";
      readonly provenance: Required<OutlineSourceProvenance>;
    }
  | { readonly type: "request-fill" }
  | {
      readonly type: "request-export";
      readonly snapshot: HiddenLineExportSnapshot;
      readonly provenance?: OutlineSourceProvenance;
    }
  | {
      readonly type: "export-finalizing";
      readonly token: number;
    }
  | {
      readonly type: "export-succeeded";
      readonly token: number;
      readonly completedOutline: CompletedOutline;
    }
  | { readonly type: "export-cancelled"; readonly token: number }
  | {
      readonly type: "export-failed";
      readonly token: number;
      readonly error: string;
    }
  | {
      readonly type: "fill-captured";
      readonly token: number;
      readonly inputRevision: number;
      readonly identity: OutlineComputeIdentity;
      readonly scene: Scene;
      readonly t: number;
      readonly sourceInputRevision?: number;
      readonly contentRevision?: number;
    }
  | {
      readonly type: "succeeded";
      readonly token: number;
      readonly identity: OutlineComputeIdentity;
      readonly scene: Scene;
    }
  | { readonly type: "cancelled"; readonly token?: number }
  | { readonly type: "failed"; readonly token: number; readonly error: string }
  | { readonly type: "transaction-began" }
  | { readonly type: "transaction-settled"; readonly launch?: boolean }
  | {
      readonly type: "inputs-changed";
      readonly launch: boolean;
      readonly provenance?: OutlineSourceProvenance;
      readonly waitForSource?: boolean;
    }
  | { readonly type: "dispose" };

export function createOutlineSessionState(): OutlineSessionState {
  return {
    desired: "fill",
    phase: { kind: "fill-live" },
    inputRevision: 0,
    nextToken: 1,
    nextExportToken: 1,
    capture: null,
    active: null,
    slot: null,
    exportActive: null,
    exportFailure: null,
    transactionOpen: false,
    deferredOutline: null,
    cache: null,
    failure: null,
  };
}

function requestCapture(
  state: OutlineSessionState,
  provenance: OutlineSourceProvenance = {},
): OutlineSessionState {
  const token = state.nextToken;
  return {
    ...state,
    phase: { kind: "fill-live" },
    nextToken: token + 1,
    capture: { token, inputRevision: state.inputRevision, ...provenance },
    active: null,
    slot: null,
    deferredOutline: null,
    failure: null,
  };
}

function sameProvenance(
  left: OutlineSourceProvenance,
  right: OutlineSourceProvenance,
): boolean {
  // Ordinary live Fill revisions are transient capture bookkeeping; exact
  // Outline identity remains sufficient for their historic cache semantics.
  // Caller-owned Scribble content carries a revision and must match both axes.
  if (left.contentRevision === undefined && right.contentRevision === undefined) {
    return true;
  }
  return (
    left.sourceInputRevision === right.sourceInputRevision &&
    left.contentRevision === right.contentRevision
  );
}

function sourceProvenanceOf(
  source: OutlineSourceProvenance,
): OutlineSourceProvenance {
  return {
    ...(source.sourceInputRevision === undefined
      ? {}
      : { sourceInputRevision: source.sourceInputRevision }),
    ...(source.contentRevision === undefined
      ? {}
      : { contentRevision: source.contentRevision }),
  };
}

function deferOutline(
  state: OutlineSessionState,
  provenance: OutlineSourceProvenance = {},
  waitsForSource = false,
): OutlineSessionState {
  return {
    ...state,
    capture: null,
    active: null,
    deferredOutline:
      state.desired === "outline"
        ? {
            inputRevision: state.inputRevision,
            ...sourceProvenanceOf(provenance),
            ...(waitsForSource ? { waitsForSource: true as const } : {}),
          }
        : null,
  };
}

function finishExport(
  state: OutlineSessionState,
  token: number,
  changes: Partial<OutlineSessionState>,
): OutlineSessionState {
  if (
    state.exportActive?.token !== token ||
    state.slot?.owner !== "hidden-line-export" ||
    state.slot.token !== token
  ) {
    return state;
  }
  const settled = {
    ...state,
    ...changes,
    slot: null,
    exportActive: null,
  };
  if (settled.desired !== "outline") {
    return { ...settled, deferredOutline: null };
  }
  if (settled.deferredOutline === null) {
    return settled;
  }
  if (settled.transactionOpen) {
    return deferOutline(
      settled,
      settled.deferredOutline,
      settled.deferredOutline.waitsForSource === true,
    );
  }
  if (settled.deferredOutline.waitsForSource === true) return settled;
  return requestCapture(settled, settled.deferredOutline);
}

/** Pure, stale-safe state machine for one keyed Sketch's one-slot Outline work. */
export function outlineSessionReducer(
  state: OutlineSessionState,
  action: OutlineSessionAction,
): OutlineSessionState {
  switch (action.type) {
    case "request-outline":
      if (state.slot?.owner === "hidden-line-export") {
        return deferOutline(
          {
            ...state,
            desired: "outline",
            phase: { kind: "fill-live" },
            failure: null,
          },
          action.provenance,
          action.launch === false,
        );
      }
      return action.launch === false
        ? deferOutline(
            { ...state, desired: "outline", failure: null },
            action.provenance,
            true,
          )
        : requestCapture(
            { ...state, desired: "outline" },
            action.provenance,
          );
    case "source-ready":
      if (
        state.desired === "outline" &&
        state.slot?.owner === "hidden-line-export"
      ) {
        return deferOutline(state, action.provenance);
      }
      if (
        state.desired !== "outline" ||
        state.transactionOpen ||
        state.slot !== null ||
        state.capture !== null ||
        (state.phase.kind === "outline" &&
          sameProvenance(state.phase, action.provenance))
      ) {
        return state;
      }
      return requestCapture(state, action.provenance);
    case "request-fill":
      return {
        ...state,
        desired: "fill",
        phase: { kind: "fill-live" },
        capture: null,
        active:
          state.slot?.owner === "outline-preview" ? null : state.active,
        slot:
          state.slot?.owner === "outline-preview" ? null : state.slot,
        deferredOutline: null,
        failure: null,
      };
    case "request-export": {
      if (state.slot !== null) return state;
      const token = state.nextExportToken;
      const preservesCompletedOutline =
        state.desired === "outline" && state.phase.kind === "outline";
      return {
        ...state,
        phase: preservesCompletedOutline ? state.phase : { kind: "fill-live" },
        nextExportToken: token + 1,
        capture: null,
        active: null,
        slot: { owner: "hidden-line-export", token },
        exportActive: {
          token,
          snapshot: action.snapshot,
          phase: "deriving",
          ...sourceProvenanceOf(action.provenance ?? {}),
        },
        exportFailure: null,
        deferredOutline:
          state.desired === "outline" && !preservesCompletedOutline
            ? { inputRevision: state.inputRevision }
            : null,
      };
    }
    case "export-finalizing":
      if (
        state.exportActive?.token !== action.token ||
        state.slot?.owner !== "hidden-line-export"
      ) {
        return state;
      }
      return {
        ...state,
        exportActive: { ...state.exportActive, phase: "finalizing" },
      };
    case "export-succeeded": {
      const exportProvenance = sourceProvenanceOf(state.exportActive ?? {});
      const cacheProvenance =
        exportProvenance.contentRevision === undefined &&
        state.cache !== null &&
        outlineComputeIdentitiesEqual(
          state.cache.identity,
          action.completedOutline.identity,
        )
          ? sourceProvenanceOf(state.cache)
          : exportProvenance;
      return finishExport(state, action.token, {
        cache: {
          identity: action.completedOutline.identity,
          scene: mutableScene(action.completedOutline.scene),
          t: action.completedOutline.identity.sampledT,
          ...cacheProvenance,
        },
        exportFailure: null,
      });
    }
    case "export-cancelled":
      return finishExport(state, action.token, { exportFailure: null });
    case "export-failed":
      return finishExport(state, action.token, {
        exportFailure: action.error,
      });
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
        outlineComputeIdentitiesEqual(state.cache.identity, action.identity) &&
        sameProvenance(state.cache, action)
      ) {
        return {
          ...state,
          phase: {
            kind: "outline",
            scene: state.cache.scene,
            t: state.cache.t,
            ...sourceProvenanceOf(state.cache),
          },
          capture: null,
          active: null,
          failure: null,
        };
      }
      return {
        ...state,
        phase: {
          kind: "fill-held-pending",
          scene: action.scene,
          t: action.t,
          ...sourceProvenanceOf(action),
        },
        capture: null,
        active: {
          token: action.token,
          identity: action.identity,
          scene: action.scene,
          t: action.t,
          ...sourceProvenanceOf(action),
        },
        slot: { owner: "outline-preview", token: action.token },
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
        ...sourceProvenanceOf(active),
      };
      return {
        ...state,
        phase: {
          kind: "outline",
          scene: action.scene,
          t: active.t,
          ...sourceProvenanceOf(active),
        },
        active: null,
        slot: null,
        cache,
        failure: null,
      };
    }
    case "cancelled":
      if (state.slot?.owner === "hidden-line-export") return state;
      if (action.token !== undefined && state.active?.token !== action.token) {
        return state;
      }
      return {
        ...state,
        desired: "fill",
        phase: { kind: "fill-live" },
        capture: null,
        active: null,
        slot: null,
        failure: null,
      };
    case "failed":
      if (
        state.active?.token !== action.token ||
        state.slot?.owner !== "outline-preview"
      ) {
        return state;
      }
      return {
        ...state,
        desired: "fill",
        phase: { kind: "fill-live" },
        active: null,
        slot: null,
        failure: action.error,
      };
    case "transaction-began":
      if (state.slot?.owner === "hidden-line-export") {
        return deferOutline({
          ...state,
          transactionOpen: true,
          phase: { kind: "fill-live" },
          failure: null,
        });
      }
      return {
        ...state,
        phase: { kind: "fill-live" },
        capture: null,
        active: null,
        slot: null,
        transactionOpen: true,
        failure: null,
      };
    case "transaction-settled": {
      const settled = { ...state, transactionOpen: false };
      if (state.slot?.owner === "hidden-line-export") {
        const deferred = state.deferredOutline;
        return deferOutline(
          settled,
          deferred ?? {},
          deferred?.waitsForSource === true ||
            (deferred === null && action.launch === false),
        );
      }
      return state.desired === "outline" && action.launch !== false
        ? requestCapture(settled)
        : settled;
    }
    case "inputs-changed": {
      const changed = {
        ...state,
        inputRevision: state.inputRevision + 1,
        phase: { kind: "fill-live" } as const,
        capture: null,
        active:
          state.slot?.owner === "hidden-line-export" ? state.active : null,
        slot:
          state.slot?.owner === "hidden-line-export" ? state.slot : null,
        transactionOpen: action.launch ? false : state.transactionOpen,
        failure: null,
      };
      if (state.slot?.owner === "hidden-line-export") {
        return deferOutline(
          changed,
          action.provenance,
          action.waitForSource === true,
        );
      }
      return action.launch && state.desired === "outline"
        ? requestCapture(changed)
        : changed;
    }
    case "dispose":
      return createOutlineSessionState();
  }
}
