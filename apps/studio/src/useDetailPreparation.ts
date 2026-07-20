import { useCallback, useEffect, useRef, useState } from "react";

import type { PreparedImageDetailAnalysis } from "@harness/core";

import { createDetailWorker } from "./createDetailWorker";
import {
  DetailCoordinator,
  type DetailPreparationResult,
  type DetailWorkerFactory,
} from "./detailCoordinator";
import {
  detailPreparationIdentitiesEqual,
  type DetailPreparationIdentity,
} from "./detailPreparationProtocol";
import {
  createDetailSessionState,
  detailSessionReducer,
  selectPreparedDetailAnalysis,
  type DetailSessionAction,
  type DetailSessionState,
} from "./detailSession";

/** Minimal coordinator seam used by the hook and deterministic tests. */
export interface DetailPreparationCoordinator {
  start(identity: DetailPreparationIdentity): Promise<DetailPreparationResult>;
  cancel(): boolean;
  dispose(): void;
}

export type DetailPreparationCoordinatorFactory = (
  workerFactory: DetailWorkerFactory,
) => DetailPreparationCoordinator;

export interface UseDetailPreparationOptions {
  readonly workerFactory?: DetailWorkerFactory;
  readonly coordinatorFactory?: DetailPreparationCoordinatorFactory;
}

export interface UseDetailPreparationResult {
  readonly session: DetailSessionState;
  readonly getSessionSnapshot: () => DetailSessionState;
  /** Explicitly request analysis; mounting a detail-capable Sketch does no work. */
  readonly request: (identity: DetailPreparationIdentity) => void;
  /** Clear diagnostic intent and work without disposing the reusable hook. */
  readonly unrequest: () => void;
  readonly retry: () => void;
  /** Invalidate a current record that fails later synchronous field binding. */
  readonly rejectPrepared: (
    token: number,
    identity: DetailPreparationIdentity,
    error: unknown,
  ) => void;
  readonly getPrepared: (
    identity: DetailPreparationIdentity,
  ) => PreparedImageDetailAnalysis | undefined;
}

const defaultCoordinatorFactory: DetailPreparationCoordinatorFactory = (
  workerFactory,
) => new DetailCoordinator(workerFactory);

function safeErrorDetail(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : typeof error === "string" && error.trim() !== ""
      ? error
      : "Detail preparation failed";
}

/** Drive explicitly requested Detail analysis without observing authored state. */
export function useDetailPreparation({
  workerFactory = createDetailWorker,
  coordinatorFactory = defaultCoordinatorFactory,
}: UseDetailPreparationOptions = {}): UseDetailPreparationResult {
  const factoriesRef = useRef({ workerFactory, coordinatorFactory });
  const [session, setSession] = useState(createDetailSessionState);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const coordinatorRef = useRef<{
    readonly coordinator: DetailPreparationCoordinator;
    readonly generation: number;
  } | null>(null);
  const nextGenerationRef = useRef(1);
  const startedRef = useRef<{
    readonly generation: number;
    readonly token: number;
  } | null>(null);

  const dispatch = useCallback(
    (action: DetailSessionAction): DetailSessionState => {
      const current = sessionRef.current;
      const next = detailSessionReducer(current, action);
      if (next !== current) {
        sessionRef.current = next;
        setSession(next);
      }
      return next;
    },
    [],
  );

  const request = useCallback(
    (identity: DetailPreparationIdentity): void => {
      const previous = sessionRef.current;
      const next = dispatch({ type: "requested", identity });
      if (
        previous.active !== null &&
        next.active?.token !== previous.active.token
      ) {
        coordinatorRef.current?.coordinator.cancel();
      }
    },
    [dispatch],
  );

  const unrequest = useCallback((): void => {
    const previous = sessionRef.current;
    dispatch({ type: "unrequested" });
    // Pending work has not reached the coordinator and is cleared solely by the
    // reducer. Active ownership is cancelled once; its callback is stale as soon
    // as the synchronous reducer mirror drops the token.
    if (previous.active !== null) {
      coordinatorRef.current?.coordinator.cancel();
    }
  }, [dispatch]);

  const retry = useCallback((): void => {
    const current = sessionRef.current;
    if (current.failure === null) return;
    dispatch({ type: "retry", identity: current.failure.identity });
  }, [dispatch]);

  const rejectPrepared = useCallback(
    (
      token: number,
      identity: DetailPreparationIdentity,
      error: unknown,
    ): void => {
      dispatch({
        type: "prepared-rejected",
        token,
        identity,
        error: safeErrorDetail(error),
      });
    },
    [dispatch],
  );

  const getSessionSnapshot = useCallback(() => sessionRef.current, []);
  const getPrepared = useCallback(
    (identity: DetailPreparationIdentity) =>
      selectPreparedDetailAnalysis(sessionRef.current, identity),
    [],
  );

  useEffect(() => {
    const generation = nextGenerationRef.current++;
    const factories = factoriesRef.current;
    const coordinator = factories.coordinatorFactory(factories.workerFactory);
    coordinatorRef.current = { coordinator, generation };

    return () => {
      const active = sessionRef.current.active;
      coordinator.dispose();
      if (coordinatorRef.current?.coordinator !== coordinator) return;
      coordinatorRef.current = null;
      if (active !== null) {
        dispatch({
          type: "cancelled",
          token: active.token,
          identity: active.identity,
        });
      }
    };
  }, [dispatch]);

  useEffect(() => {
    const pending = sessionRef.current.pending;
    const owner = coordinatorRef.current;
    if (pending === null || owner === null) return;

    const started = startedRef.current;
    if (
      started?.generation === owner.generation &&
      started.token === pending.token
    ) {
      return;
    }
    startedRef.current = { generation: owner.generation, token: pending.token };

    const launched = dispatch({
      type: "launched",
      token: pending.token,
      identity: pending.identity,
    });
    if (
      launched.active?.token !== pending.token ||
      !detailPreparationIdentitiesEqual(
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
        detailPreparationIdentitiesEqual(active.identity, pending.identity)
      );
    };

    const fail = (error: unknown): void => {
      if (!ownsCallback()) return;
      dispatch({
        type: "failed",
        token: pending.token,
        identity: pending.identity,
        error: safeErrorDetail(error),
      });
    };

    let result: Promise<DetailPreparationResult>;
    try {
      result = owner.coordinator.start(pending.identity);
    } catch (error) {
      fail(error);
      return;
    }

    void result.then((outcome) => {
      if (!ownsCallback()) return;
      if (outcome.status === "success") {
        dispatch({
          type: "succeeded",
          token: pending.token,
          identity: outcome.identity,
          prepared: outcome.prepared,
        });
      } else if (outcome.status === "failure") {
        fail(outcome.error);
      } else {
        dispatch({
          type: "cancelled",
          token: pending.token,
          identity: pending.identity,
        });
      }
    }, fail);
  }, [dispatch, session.pending]);

  return {
    session,
    getSessionSnapshot,
    request,
    unrequest,
    retry,
    rejectPrepared,
    getPrepared,
  };
}
