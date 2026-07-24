import { useCallback, useEffect, useRef, useState } from "react";

import type { CoordinateSpace, Params, Seed, Sketch } from "@harness/core";

import { createFlowingContoursWorker } from "./createFlowingContoursWorker";
import {
  FlowingContoursCoordinator,
  type FlowingContoursComputeResult,
  type FlowingContoursWorkerFactory,
} from "./flowingContoursCoordinator";
import {
  createFlowingContoursComputeIdentity,
  FLOWING_CONTOURS_SKETCH_ID,
  flowingContoursComputeIdentitiesEqual,
  type FlowingContoursComputeIdentity,
} from "./flowingContoursComputeProtocol";
import {
  createFlowingContoursSessionState,
  createInactiveFlowingContoursSessionState,
  flowingContoursSessionReducer,
  type FlowingContoursSessionAction,
  type FlowingContoursSessionState,
} from "./flowingContoursSession";

export interface FlowingContoursAuthoredState {
  readonly params: Readonly<Params>;
  readonly seed: Seed;
  readonly compositionFrame: Readonly<CoordinateSpace>;
  readonly inputRevision: number;
}

export type FlowingContoursIdentitySketch = Pick<Sketch, "id" | "schema">;

export interface FlowingContoursPreparationCoordinator {
  start(
    identity: FlowingContoursComputeIdentity,
  ): Promise<FlowingContoursComputeResult>;
  cancel(): boolean;
  dispose(): void;
}

export type FlowingContoursPreparationCoordinatorFactory = (
  workerFactory: FlowingContoursWorkerFactory,
) => FlowingContoursPreparationCoordinator;

export interface UseFlowingContoursPreparationOptions {
  readonly sketch: FlowingContoursIdentitySketch;
  readonly initial: FlowingContoursAuthoredState;
  readonly workerFactory?: FlowingContoursWorkerFactory;
  readonly coordinatorFactory?: FlowingContoursPreparationCoordinatorFactory;
  readonly enabled?: boolean;
}

export interface UseFlowingContoursPreparationResult {
  readonly session: FlowingContoursSessionState;
  readonly getSessionSnapshot: () => FlowingContoursSessionState;
  readonly suspend: () => void;
  readonly resumeLatest: () => void;
  readonly beginTransaction: () => void;
  readonly previewAuthoredState: (
    authored: FlowingContoursAuthoredState,
  ) => void;
  readonly settleTransaction: (
    authored: FlowingContoursAuthoredState,
  ) => void;
  readonly requestAtomic: (authored: FlowingContoursAuthoredState) => void;
  readonly retry: () => void;
}

const defaultCoordinatorFactory: FlowingContoursPreparationCoordinatorFactory =
  (workerFactory) => new FlowingContoursCoordinator(workerFactory);

export function createFlowingContoursIdentityForAuthoredState(
  sketch: FlowingContoursIdentitySketch,
  authored: FlowingContoursAuthoredState,
): FlowingContoursComputeIdentity {
  return createFlowingContoursComputeIdentity({
    sketchId: sketch.id,
    schema: sketch.schema,
    params: authored.params,
    seed: authored.seed,
    compositionFrame: authored.compositionFrame,
  });
}

function safeError(error: unknown): string {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return detail.trim() === ""
    ? "Flowing Contours worker failed"
    : detail.slice(0, 500);
}

/**
 * Latest-input-wins owner for Flowing Contours' worker-generated static Scene.
 * StrictMode coordinator replacement requeues exactly one latest request.
 */
export function useFlowingContoursPreparation({
  sketch,
  initial,
  workerFactory = createFlowingContoursWorker,
  coordinatorFactory = defaultCoordinatorFactory,
  enabled = true,
}: UseFlowingContoursPreparationOptions): UseFlowingContoursPreparationResult {
  const factoriesRef = useRef({ workerFactory, coordinatorFactory });
  const sketchRef = useRef(sketch);
  const [session, setSession] = useState(() =>
    sketch.id === FLOWING_CONTOURS_SKETCH_ID
      ? createFlowingContoursSessionState(
          createFlowingContoursIdentityForAuthoredState(sketch, initial),
          initial.inputRevision,
        )
      : createInactiveFlowingContoursSessionState(),
  );
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const coordinatorRef = useRef<{
    readonly coordinator: FlowingContoursPreparationCoordinator;
    readonly generation: number;
  } | null>(null);
  const nextCoordinatorGenerationRef = useRef(1);
  const startedRequestRef = useRef<{
    readonly coordinatorGeneration: number;
    readonly token: number;
  } | null>(null);

  const dispatch = useCallback(
    (
      action: FlowingContoursSessionAction,
    ): FlowingContoursSessionState => {
      const current = sessionRef.current;
      const next = flowingContoursSessionReducer(current, action);
      if (next !== current) {
        sessionRef.current = next;
        setSession(next);
      }
      return next;
    },
    [],
  );

  const identityFor = useCallback(
    (authored: FlowingContoursAuthoredState) =>
      createFlowingContoursIdentityForAuthoredState(
        sketchRef.current,
        authored,
      ),
    [],
  );

  const cancelReplaced = useCallback(
    (
      previous: FlowingContoursSessionState,
      next: FlowingContoursSessionState,
    ): void => {
      if (
        previous.active !== null &&
        next.active?.token !== previous.active.token
      ) {
        coordinatorRef.current?.coordinator.cancel();
      }
    },
    [],
  );

  const suspend = useCallback(() => {
    const previous = sessionRef.current;
    const next = dispatch({ type: "suspend" });
    cancelReplaced(previous, next);
  }, [cancelReplaced, dispatch]);

  const resumeLatest = useCallback(() => {
    dispatch({ type: "resume-latest" });
  }, [dispatch]);

  const beginTransaction = useCallback(() => {
    const previous = sessionRef.current;
    const next = dispatch({ type: "transaction-began" });
    cancelReplaced(previous, next);
  }, [cancelReplaced, dispatch]);

  const previewAuthoredState = useCallback(
    (authored: FlowingContoursAuthoredState) => {
      const previous = sessionRef.current;
      const next = dispatch({
        type: "desired-identity-changed",
        identity: identityFor(authored),
        sourceInputRevision: authored.inputRevision,
      });
      cancelReplaced(previous, next);
    },
    [cancelReplaced, dispatch, identityFor],
  );

  const settleTransaction = useCallback(
    (authored: FlowingContoursAuthoredState) => {
      const previous = sessionRef.current;
      const next = dispatch({
        type: "transaction-settled",
        identity: identityFor(authored),
        sourceInputRevision: authored.inputRevision,
      });
      cancelReplaced(previous, next);
    },
    [cancelReplaced, dispatch, identityFor],
  );

  const retry = useCallback(() => {
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
    const { workerFactory: makeWorker, coordinatorFactory: makeCoordinator } =
      factoriesRef.current;
    const coordinator = makeCoordinator(makeWorker);
    coordinatorRef.current = { coordinator, generation };
    return () => {
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
      !flowingContoursComputeIdentitiesEqual(
        launched.active.identity,
        pending.identity,
      )
    ) {
      return;
    }

    const ownsCallback = (): boolean => {
      const currentOwner = coordinatorRef.current;
      const active = sessionRef.current.active;
      return (
        currentOwner?.coordinator === owner.coordinator &&
        currentOwner.generation === owner.generation &&
        active?.token === pending.token &&
        flowingContoursComputeIdentitiesEqual(
          active.identity,
          pending.identity,
        )
      );
    };
    const reportFailure = (error: unknown): void => {
      if (!ownsCallback()) return;
      dispatch({
        type: "failed",
        token: pending.token,
        identity: pending.identity,
        error: safeError(error),
      });
    };

    let result: Promise<FlowingContoursComputeResult>;
    try {
      result = owner.coordinator.start(pending.identity);
    } catch (error) {
      reportFailure(error);
      return;
    }
    void result
      .then((outcome) => {
        if (!ownsCallback()) return;
        if (outcome.status === "success") {
          dispatch({
            type: "succeeded",
            token: pending.token,
            identity: outcome.identity,
            scene: outcome.scene,
            computeTimeMs: outcome.computeTimeMs,
          });
        } else if (outcome.status === "cancelled") {
          dispatch({ type: "cancelled", token: pending.token });
        } else {
          reportFailure(outcome.error);
        }
      })
      .catch(reportFailure);
  }, [dispatch, enabled, session.pending]);

  return {
    session,
    getSessionSnapshot: () => sessionRef.current,
    suspend,
    resumeLatest,
    beginTransaction,
    previewAuthoredState,
    settleTransaction,
    requestAtomic: settleTransaction,
    retry,
  };
}
