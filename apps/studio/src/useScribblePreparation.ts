import { useCallback, useEffect, useRef, useState } from "react";

import type { CoordinateSpace, Params, Seed, Sketch } from "@harness/core";

import { createScribbleWorker } from "./createScribbleWorker";
import {
  createScribbleComputeIdentity,
  scribbleComputeIdentitiesEqual,
  type ScribbleComputeIdentity,
} from "./scribbleComputeProtocol";
import {
  ScribbleCoordinator,
  type ScribbleComputeResult,
  type ScribbleProgressObserver,
  type ScribbleProgressUpdate,
  type ScribbleWorkerFactory,
} from "./scribbleCoordinator";
import {
  createScribbleSessionState,
  scribbleSessionReducer,
  type ScribbleSessionAction,
  type ScribbleSessionState,
} from "./scribbleSession";

/** Authored inputs captured after one edit-history transition. */
export interface ScribbleAuthoredState {
  readonly params: Readonly<Params>;
  readonly seed: Seed;
  readonly compositionFrame: Readonly<CoordinateSpace>;
  readonly inputRevision: number;
}

export type ScribbleIdentitySketch = Pick<Sketch, "id" | "schema">;

/** Minimal coordinator seam used by the hook and its deterministic tests. */
export interface ScribblePreparationCoordinator {
  start(
    identity: ScribbleComputeIdentity,
    observeProgress?: ScribbleProgressObserver,
  ): Promise<ScribbleComputeResult>;
  cancel(): boolean;
  dispose(): void;
}

export type ScribblePreparationCoordinatorFactory = (
  workerFactory: ScribbleWorkerFactory,
) => ScribblePreparationCoordinator;

export interface UseScribblePreparationOptions {
  readonly sketch: ScribbleIdentitySketch;
  /** The mounted history's initial present state. Later edits use the actions below. */
  readonly initial: ScribbleAuthoredState;
  readonly workerFactory?: ScribbleWorkerFactory;
  readonly coordinatorFactory?: ScribblePreparationCoordinatorFactory;
}

export interface ScribblePreparationProgress {
  readonly token: number;
  readonly update: ScribbleProgressUpdate;
}

export interface UseScribblePreparationResult {
  readonly session: ScribbleSessionState;
  readonly progress: ScribblePreparationProgress | null;
  /** Cancel active preparation before a history transaction starts previewing. */
  readonly beginTransaction: () => void;
  /** Record the latest transaction preview without launching preparation. */
  readonly previewAuthoredState: (authored: ScribbleAuthoredState) => void;
  /** Settle a committed or reverted transaction after historyRef is final. */
  readonly settleTransaction: (authored: ScribbleAuthoredState) => void;
  /** Immediately request the latest state after one atomic history command. */
  readonly requestAtomic: (authored: ScribbleAuthoredState) => void;
}

const defaultCoordinatorFactory: ScribblePreparationCoordinatorFactory = (
  workerFactory,
) => new ScribbleCoordinator(workerFactory);

/** Canonical identity seam shared by initial, atomic, and transaction requests. */
export function createScribbleIdentityForAuthoredState(
  sketch: ScribbleIdentitySketch,
  authored: ScribbleAuthoredState,
): ScribbleComputeIdentity {
  return createScribbleComputeIdentity({
    sketchId: sketch.id,
    schema: sketch.schema,
    params: authored.params,
    seed: authored.seed,
    compositionFrame: authored.compositionFrame,
  });
}

function safeErrorDetail(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message.slice(0, 500)
    : "Scribble worker failed";
}

/**
 * Drives Scribble preparation beside (but never owns) Studio edit history.
 *
 * Callers update their synchronous history ref first, then pass that exact
 * authored snapshot to one of these actions. This keeps transaction settlement
 * atomic even when begin/preview/commit arrive in one React batch.
 */
export function useScribblePreparation({
  sketch,
  initial,
  workerFactory = createScribbleWorker,
  coordinatorFactory = defaultCoordinatorFactory,
}: UseScribblePreparationOptions): UseScribblePreparationResult {
  // A keyed Sketch mount owns these injected factories for its whole lifetime.
  // Capturing them once also prevents an inline test factory from replacing a
  // live coordinator on every render.
  const factoriesRef = useRef({ workerFactory, coordinatorFactory });
  const sketchRef = useRef(sketch);
  const [session, setSession] = useState(() =>
    createScribbleSessionState(
      createScribbleIdentityForAuthoredState(sketch, initial),
      initial.inputRevision,
    ),
  );
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [progress, setProgress] =
    useState<ScribblePreparationProgress | null>(null);
  const coordinatorRef = useRef<{
    readonly coordinator: ScribblePreparationCoordinator;
    readonly generation: number;
  } | null>(null);
  const nextCoordinatorGenerationRef = useRef(1);
  const startedRequestRef = useRef<{
    readonly coordinatorGeneration: number;
    readonly token: number;
  } | null>(null);

  const dispatch = useCallback(
    (action: ScribbleSessionAction): ScribbleSessionState => {
      const current = sessionRef.current;
      const next = scribbleSessionReducer(current, action);
      if (next !== current) {
        sessionRef.current = next;
        setSession(next);
      }
      return next;
    },
    [],
  );

  const identityFor = useCallback(
    (authored: ScribbleAuthoredState) =>
      createScribbleIdentityForAuthoredState(sketchRef.current, authored),
    [],
  );

  const cancelReplacedActive = useCallback(
    (previous: ScribbleSessionState, next: ScribbleSessionState): void => {
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

  const beginTransaction = useCallback((): void => {
    const previous = sessionRef.current;
    const next = dispatch({ type: "transaction-began" });
    cancelReplacedActive(previous, next);
    setProgress(null);
  }, [cancelReplacedActive, dispatch]);

  const previewAuthoredState = useCallback(
    (authored: ScribbleAuthoredState): void => {
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
    (authored: ScribbleAuthoredState): void => {
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

  useEffect(() => {
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
        !cancelled.transactionOpen
      ) {
        dispatch({
          type: "transaction-settled",
          identity: cancelled.desiredIdentity,
          sourceInputRevision: cancelled.sourceInputRevision,
        });
      }
    };
  }, [dispatch]);

  useEffect(() => {
    // Read the synchronous reducer mirror rather than this effect's render
    // closure. During StrictMode's second setup it already contains the fresh
    // replacement request produced by the rehearsal coordinator's cleanup.
    const pending = sessionRef.current.pending;
    const owner = coordinatorRef.current;
    if (pending === null || owner === null) return;

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
      !scribbleComputeIdentitiesEqual(
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
        scribbleComputeIdentitiesEqual(active.identity, pending.identity)
      );
    };
    const observeProgress: ScribbleProgressObserver = (update) => {
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

    let result: Promise<ScribbleComputeResult>;
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
            error: outcome.error,
          });
        }
      })
      .catch(reportFailure);
  }, [dispatch, session.pending]);

  return {
    session,
    progress,
    beginTransaction,
    previewAuthoredState,
    settleTransaction,
    requestAtomic,
  };
}
