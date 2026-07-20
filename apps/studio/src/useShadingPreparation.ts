import { useCallback, useEffect, useRef, useState } from "react";

import type { CoordinateSpace, Params, Seed, Sketch } from "@harness/core";

import { createShadingWorker } from "./createShadingWorker";
import {
  createShadingComputeIdentity,
  shadingComputeIdentitiesEqual,
  type ShadingComputeIdentity,
} from "./shadingComputeProtocol";
import {
  ShadingCoordinator,
  type ShadingComputeResult,
  type ShadingProgressObserver,
  type ShadingProgressUpdate,
  type ShadingWorkerFactory,
} from "./shadingCoordinator";
import {
  createShadingSessionState,
  shadingSessionReducer,
  type ShadingSessionAction,
  type ShadingSessionState,
} from "./shadingSession";

/** Authored inputs captured after one edit-history transition. */
export interface ShadingAuthoredState {
  readonly params: Readonly<Params>;
  readonly seed: Seed;
  readonly compositionFrame: Readonly<CoordinateSpace>;
  readonly inputRevision: number;
}

export type ShadingIdentitySketch = Pick<Sketch, "id" | "schema">;

/** Minimal coordinator seam used by the hook and its deterministic tests. */
export interface ShadingPreparationCoordinator {
  start(
    identity: ShadingComputeIdentity,
    observeProgress?: ShadingProgressObserver,
  ): Promise<ShadingComputeResult>;
  cancel(): boolean;
  dispose(): void;
}

export type ShadingPreparationCoordinatorFactory = (
  workerFactory: ShadingWorkerFactory,
) => ShadingPreparationCoordinator;

export interface UseShadingPreparationOptions {
  readonly sketch: ShadingIdentitySketch;
  /** The mounted history's initial present state. Later edits use the actions below. */
  readonly initial: ShadingAuthoredState;
  readonly workerFactory?: ShadingWorkerFactory;
  readonly coordinatorFactory?: ShadingPreparationCoordinatorFactory;
  /** Keeps the hook composable for Sketches without the optional capability. */
  readonly enabled?: boolean;
}

export interface ShadingPreparationProgress {
  readonly token: number;
  readonly update: ShadingProgressUpdate;
}

export interface UseShadingPreparationResult {
  readonly session: ShadingSessionState;
  readonly progress: ShadingPreparationProgress | null;
  /** Read the reducer's latest synchronous state, including same-batch edits. */
  readonly getSessionSnapshot: () => ShadingSessionState;
  /** Synchronously pause worker ownership while retaining latest authored state. */
  readonly suspend: () => void;
  /** Resume with no work when current, otherwise one request for the latest state. */
  readonly resumeLatest: () => void;
  /** Cancel active preparation before a history transaction starts previewing. */
  readonly beginTransaction: () => void;
  /** Record the latest transaction preview without launching preparation. */
  readonly previewAuthoredState: (authored: ShadingAuthoredState) => void;
  /** Settle a committed or reverted transaction after historyRef is final. */
  readonly settleTransaction: (authored: ShadingAuthoredState) => void;
  /** Immediately request the latest state after one atomic history command. */
  readonly requestAtomic: (authored: ShadingAuthoredState) => void;
  /** Re-enqueue the exact current identity after a bounded worker failure. */
  readonly retry: () => void;
}

const defaultCoordinatorFactory: ShadingPreparationCoordinatorFactory = (
  workerFactory,
) => new ShadingCoordinator(workerFactory);

/** Canonical identity seam shared by initial, atomic, and transaction requests. */
export function createShadingIdentityForAuthoredState(
  sketch: ShadingIdentitySketch,
  authored: ShadingAuthoredState,
): ShadingComputeIdentity {
  return createShadingComputeIdentity({
    sketchId: sketch.id,
    schema: sketch.schema,
    params: authored.params,
    seed: authored.seed,
    compositionFrame: authored.compositionFrame,
  });
}

function safeErrorDetail(error: unknown): string {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return detail.trim() === ""
    ? "Shading worker failed"
    : detail.slice(0, 500);
}

/**
 * Drives Shading preparation beside (but never owns) Studio edit history.
 *
 * Callers update their synchronous history ref first, then pass that exact
 * authored snapshot to one of these actions. This keeps transaction settlement
 * atomic even when begin/preview/commit arrive in one React batch.
 */
export function useShadingPreparation({
  sketch,
  initial,
  workerFactory = createShadingWorker,
  coordinatorFactory = defaultCoordinatorFactory,
  enabled = true,
}: UseShadingPreparationOptions): UseShadingPreparationResult {
  // A keyed Sketch mount owns these injected factories for its whole lifetime.
  // Capturing them once also prevents an inline test factory from replacing a
  // live coordinator on every render.
  const factoriesRef = useRef({ workerFactory, coordinatorFactory });
  const sketchRef = useRef(sketch);
  const [session, setSession] = useState(() =>
    createShadingSessionState(
      createShadingIdentityForAuthoredState(sketch, initial),
      initial.inputRevision,
    ),
  );
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [progress, setProgress] =
    useState<ShadingPreparationProgress | null>(null);
  const coordinatorRef = useRef<{
    readonly coordinator: ShadingPreparationCoordinator;
    readonly generation: number;
  } | null>(null);
  const nextCoordinatorGenerationRef = useRef(1);
  const startedRequestRef = useRef<{
    readonly coordinatorGeneration: number;
    readonly token: number;
  } | null>(null);

  const dispatch = useCallback(
    (action: ShadingSessionAction): ShadingSessionState => {
      const current = sessionRef.current;
      const next = shadingSessionReducer(current, action);
      if (next !== current) {
        sessionRef.current = next;
        setSession(next);
      }
      return next;
    },
    [],
  );

  const identityFor = useCallback(
    (authored: ShadingAuthoredState) =>
      createShadingIdentityForAuthoredState(sketchRef.current, authored),
    [],
  );

  const cancelReplacedActive = useCallback(
    (previous: ShadingSessionState, next: ShadingSessionState): void => {
      if (
        previous.active !== null &&
        next.active?.token !== previous.active.token
      ) {
        coordinatorRef.current?.coordinator.cancel();
        setProgress(null);
      }
    },
    [],
  );

  const suspend = useCallback((): void => {
    const previous = sessionRef.current;
    const next = dispatch({ type: "suspend" });
    cancelReplacedActive(previous, next);
    setProgress(null);
  }, [cancelReplacedActive, dispatch]);

  const resumeLatest = useCallback((): void => {
    dispatch({ type: "resume-latest" });
  }, [dispatch]);

  const beginTransaction = useCallback((): void => {
    const previous = sessionRef.current;
    const next = dispatch({ type: "transaction-began" });
    cancelReplacedActive(previous, next);
    setProgress(null);
  }, [cancelReplacedActive, dispatch]);

  const previewAuthoredState = useCallback(
    (authored: ShadingAuthoredState): void => {
      const previous = sessionRef.current;
      const next = dispatch({
        type: "desired-identity-changed",
        identity: identityFor(authored),
        sourceInputRevision: authored.inputRevision,
      });
      cancelReplacedActive(previous, next);
    },
    [cancelReplacedActive, dispatch, identityFor],
  );

  const settleTransaction = useCallback(
    (authored: ShadingAuthoredState): void => {
      const previous = sessionRef.current;
      const next = dispatch({
        type: "transaction-settled",
        identity: identityFor(authored),
        sourceInputRevision: authored.inputRevision,
      });
      cancelReplacedActive(previous, next);
    },
    [cancelReplacedActive, dispatch, identityFor],
  );

  const requestAtomic = settleTransaction;

  const retry = useCallback((): void => {
    const current = sessionRef.current;
    if (
      current.failure === null ||
      current.desiredIdentity === null ||
      current.sourceInputRevision === null
    ) {
      return;
    }
    dispatch({
      type: "retry",
      identity: current.desiredIdentity,
      sourceInputRevision: current.sourceInputRevision,
    });
  }, [dispatch]);

  useEffect(() => {
    if (!enabled) return;
    const generation = nextCoordinatorGenerationRef.current++;
    const { coordinatorFactory: createCoordinator, workerFactory: createWorker } =
      factoriesRef.current;
    const coordinator = createCoordinator(createWorker);
    coordinatorRef.current = { coordinator, generation };

    return () => {
      // StrictMode rehearses setup -> cleanup -> setup while retaining reducer
      // state. Put work owned by the retiring coordinator back through normal
      // settlement so the next generation receives one fresh pending token.
      const active = sessionRef.current.active;
      coordinator.dispose();
      if (coordinatorRef.current?.coordinator !== coordinator) return;
      coordinatorRef.current = null;
      if (active === null) return;
      const cancelled = dispatch({ type: "cancelled", token: active.token });
      if (
        cancelled.desiredIdentity !== null &&
        cancelled.sourceInputRevision !== null &&
        !cancelled.transactionOpen &&
        !cancelled.suspended
      ) {
        dispatch({
          type: "transaction-settled",
          identity: cancelled.desiredIdentity,
          sourceInputRevision: cancelled.sourceInputRevision,
        });
      }
    };
  }, [dispatch, enabled]);

  useEffect(() => {
    // Read the synchronous reducer mirror rather than this effect's render
    // closure. During StrictMode's second setup it already contains the fresh
    // replacement request produced by the rehearsal coordinator's cleanup.
    const pending = sessionRef.current.pending;
    const owner = coordinatorRef.current;
    if (
      !enabled ||
      sessionRef.current.suspended ||
      pending === null ||
      owner === null
    ) {
      return;
    }

    const started = startedRequestRef.current;
    if (
      started?.coordinatorGeneration === owner.generation &&
      started.token === pending.token
    ) {
      return;
    }
    startedRequestRef.current = {
      coordinatorGeneration: owner.generation,
      token: pending.token,
    };

    const launched = dispatch({
      type: "launched",
      token: pending.token,
      identity: pending.identity,
    });
    if (
      launched.active?.token !== pending.token ||
      !shadingComputeIdentitiesEqual(
        launched.active.identity,
        pending.identity,
      )
    ) {
      return;
    }
    setProgress(null);

    const ownsCallback = (): boolean => {
      const currentOwner = coordinatorRef.current;
      const active = sessionRef.current.active;
      return (
        currentOwner?.coordinator === owner.coordinator &&
        currentOwner.generation === owner.generation &&
        active?.token === pending.token &&
        shadingComputeIdentitiesEqual(active.identity, pending.identity)
      );
    };
    const observeProgress: ShadingProgressObserver = (update) => {
      if (!ownsCallback()) return;
      setProgress({ token: pending.token, update });
    };
    const reportFailure = (error: unknown): void => {
      if (!ownsCallback()) return;
      setProgress(null);
      dispatch({
        type: "failed",
        token: pending.token,
        identity: pending.identity,
        error: safeErrorDetail(error),
      });
    };

    let result: Promise<ShadingComputeResult>;
    try {
      result = owner.coordinator.start(pending.identity, observeProgress);
    } catch (error) {
      reportFailure(error);
      return;
    }
    void result
      .then((outcome) => {
        if (!ownsCallback()) return;
        setProgress(null);
        if (outcome.status === "success") {
          dispatch({
            type: "succeeded",
            token: pending.token,
            identity: outcome.identity,
            scene: outcome.scene,
            diagnostics: outcome.diagnostics,
            computeTimeMs: outcome.computeTimeMs,
          });
        } else if (outcome.status === "cancelled") {
          dispatch({ type: "cancelled", token: pending.token });
        } else {
          dispatch({
            type: "failed",
            token: pending.token,
            identity: pending.identity,
            error: safeErrorDetail(outcome.error),
          });
        }
      })
      .catch(reportFailure);
  }, [dispatch, enabled, session.pending]);

  return {
    session,
    progress,
    getSessionSnapshot: () => sessionRef.current,
    suspend,
    resumeLatest,
    beginTransaction,
    previewAuthoredState,
    settleTransaction,
    requestAtomic,
    retry,
  };
}
