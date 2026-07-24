import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CoordinateSpace,
  Params,
  Seed,
  Sketch,
} from "@harness/core";

import { createPlotStageWorker } from "./createPlotStageWorker";
import {
  PlotStageCoordinator,
  type PlotStagePreparationInput,
  type PlotStagePreparationResult,
  type PlotStageWorkerFactory,
} from "./plotStageCoordinator";
import {
  createPlotStagePreparationIdentity,
  createPlotStageRegistrationIdentity,
  plotStagePreparationIdentitiesEqual,
  plotStageRegistrationIdentitiesEqual,
} from "./plotStagePreparationProtocol";
import {
  createPlotStageSessionState,
  plotStageSessionReducer,
  selectPlotStage,
  type PlotStageExpectedIdentity,
  type PlotStageSessionAction,
  type PlotStageSessionState,
} from "./plotStageSession";

/** Authored inputs captured after one edit-history transition. */
export interface GeneratedStageAuthoredState {
  readonly params: Readonly<Params>;
  readonly seed: Seed;
  readonly sampledT: number;
  readonly compositionFrame: Readonly<CoordinateSpace>;
}

export type GeneratedStageIdentitySketch = Pick<
  Sketch,
  "id" | "schema" | "plotSequence"
>;

/** Minimal coordinator seam used by the hook and deterministic tests. */
export interface GeneratedStagePreparationCoordinator {
  start(
    input: PlotStagePreparationInput,
  ): Promise<PlotStagePreparationResult>;
  cancel(): boolean;
  dispose(): void;
}

export type GeneratedStagePreparationCoordinatorFactory = (
  workerFactory: PlotStageWorkerFactory,
) => GeneratedStagePreparationCoordinator;

export interface UseGeneratedStagePreparationOptions {
  readonly sketch: GeneratedStageIdentitySketch;
  /** The mounted edit history's initial present state. */
  readonly initial: GeneratedStageAuthoredState;
  readonly workerFactory?: PlotStageWorkerFactory;
  readonly coordinatorFactory?: GeneratedStagePreparationCoordinatorFactory;
}

export interface UseGeneratedStagePreparationResult {
  /** Retained preparation ownership and geometry, addressed only by Stage ID. */
  readonly session: PlotStageSessionState;
  readonly getSessionSnapshot: () => PlotStageSessionState;
  /** Demand one generator-source Stage. Primary and unknown IDs are ignored. */
  readonly demand: (stageId: string) => void;
  /** Stop one Stage's current intent while retaining its last completed Scene. */
  readonly cancel: (stageId: string) => void;
  /** Retry one current Stage-local failure. */
  readonly retry: (stageId: string) => void;
  /**
   * Gate replacement launches while an edit transaction previews values.
   * Omit Stage IDs to preserve the legacy all-generator transaction.
   */
  readonly beginTransaction: (stageIds?: readonly string[]) => void;
  /** Record a transaction preview without launching its replacement work. */
  readonly previewAuthoredState: (
    authored: GeneratedStageAuthoredState,
    stageIds?: readonly string[],
  ) => void;
  /** Launch at most the latest identity after commit or revert settles. */
  readonly settleTransaction: (
    authored: GeneratedStageAuthoredState,
    stageIds?: readonly string[],
  ) => void;
  /** Apply one already-atomic edit. */
  readonly requestAtomic: (
    authored: GeneratedStageAuthoredState,
    stageIds?: readonly string[],
  ) => void;
}

interface CoordinatorOwner {
  readonly coordinator: GeneratedStagePreparationCoordinator;
  readonly generation: number;
}

const defaultCoordinatorFactory: GeneratedStagePreparationCoordinatorFactory = (
  workerFactory,
) => new PlotStageCoordinator(workerFactory);

function safeErrorDetail(error: unknown): string {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return detail.trim() === ""
    ? "Plot Stage preparation failed"
    : detail.slice(0, 500);
}

function isGeneratedStage(
  sketch: GeneratedStageIdentitySketch,
  stageId: string,
): boolean {
  return (
    sketch.plotSequence?.stages.some(
      (stage) => stage.id === stageId && stage.source.kind === "generator",
    ) ?? false
  );
}

/**
 * Derive the complete current identity set for generator-source Stages.
 *
 * Stage instance IDs are the keys. A reusable generator ID may occur more than
 * once without merging retained ownership or coordinator lifecycles.
 */
export function createGeneratedStageExpectedIdentities(
  sketch: GeneratedStageIdentitySketch,
  authored: GeneratedStageAuthoredState,
): Readonly<Record<string, PlotStageExpectedIdentity>> {
  const declaration = sketch.plotSequence;
  if (declaration === undefined) return Object.freeze({});

  const registrationIdentity = createPlotStageRegistrationIdentity({
    schema: sketch.schema,
    declaration,
    params: authored.params,
    compositionFrame: authored.compositionFrame,
  });
  const expected: Record<string, PlotStageExpectedIdentity> = {};

  for (const stage of declaration.stages) {
    if (stage.source.kind !== "generator") continue;
    Object.defineProperty(expected, stage.id, {
      value: Object.freeze({
        identity: createPlotStagePreparationIdentity({
          sketchId: sketch.id,
          stageId: stage.id,
          schema: sketch.schema,
          declaration,
          params: authored.params,
          seed: authored.seed,
          sampledT: authored.sampledT,
          compositionFrame: authored.compositionFrame,
        }),
        registrationIdentity,
      }),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }

  return Object.freeze(expected);
}

function createInitialSession(
  sketch: GeneratedStageIdentitySketch,
  authored: GeneratedStageAuthoredState,
): PlotStageSessionState {
  let session = createPlotStageSessionState();
  for (const expected of Object.values(
    createGeneratedStageExpectedIdentities(sketch, authored),
  )) {
    session = plotStageSessionReducer(session, {
      type: "identity-changed",
      ...expected,
    });
  }
  return session;
}

/**
 * Drive retained generator-source Stage preparation beside Studio edit history.
 *
 * Mounting is lazy: identities are recorded, but neither coordinators nor
 * workers exist until explicit Stage demand. View selection is deliberately not
 * an input, so leaving a supporting view cannot retire demanded work.
 */
export function useGeneratedStagePreparation({
  sketch,
  initial,
  workerFactory = createPlotStageWorker,
  coordinatorFactory = defaultCoordinatorFactory,
}: UseGeneratedStagePreparationOptions): UseGeneratedStagePreparationResult {
  const factoriesRef = useRef({ workerFactory, coordinatorFactory });
  const sketchRef = useRef(sketch);
  const authoredRef = useRef(initial);
  const [session, setSession] = useState(() =>
    createInitialSession(sketch, initial),
  );
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const transactionStageIdsRef = useRef(new Set<string>());
  const [transactionRevision, setTransactionRevision] = useState(0);
  const ownersRef = useRef(new Map<string, CoordinatorOwner>());
  const nextGenerationRef = useRef(1);
  const startedRef = useRef(
    new Map<string, { readonly generation: number; readonly token: number }>(),
  );

  const dispatch = useCallback(
    (action: PlotStageSessionAction): PlotStageSessionState => {
      const current = sessionRef.current;
      const next = plotStageSessionReducer(current, action);
      if (next !== current) {
        sessionRef.current = next;
        setSession(next);
      }
      return next;
    },
    [],
  );

  const cancelReplacedActive = useCallback(
    (
      stageId: string,
      previous: PlotStageSessionState,
      next: PlotStageSessionState,
    ): void => {
      const previousActive = selectPlotStage(previous, stageId)?.active;
      const nextActive = selectPlotStage(next, stageId)?.active;
      if (
        previousActive !== null &&
        previousActive !== undefined &&
        nextActive?.token !== previousActive.token
      ) {
        ownersRef.current.get(stageId)?.coordinator.cancel();
      }
    },
    [],
  );

  const generatedStageIds = useCallback(
    (stageIds?: readonly string[]): readonly string[] =>
      stageIds === undefined
        ? (sketchRef.current.plotSequence?.stages
            .filter((stage) => stage.source.kind === "generator")
            .map((stage) => stage.id) ?? [])
        : stageIds.filter((stageId) =>
            isGeneratedStage(sketchRef.current, stageId),
          ),
    [],
  );

  const recordAuthoredState = useCallback(
    (
      authored: GeneratedStageAuthoredState,
      stageIds?: readonly string[],
    ): void => {
      authoredRef.current = authored;
      const expectedByStage = createGeneratedStageExpectedIdentities(
        sketchRef.current,
        authored,
      );
      for (const stageId of generatedStageIds(stageIds)) {
        const expected = expectedByStage[stageId];
        if (expected === undefined) continue;
        const previous = sessionRef.current;
        const next = dispatch({ type: "identity-changed", ...expected });
        cancelReplacedActive(stageId, previous, next);
      }
    },
    [cancelReplacedActive, dispatch, generatedStageIds],
  );

  const demand = useCallback(
    (stageId: string): void => {
      if (!isGeneratedStage(sketchRef.current, stageId)) return;
      dispatch({ type: "demanded", stageId });
    },
    [dispatch],
  );

  const cancel = useCallback(
    (stageId: string): void => {
      if (!isGeneratedStage(sketchRef.current, stageId)) return;
      const stage = selectPlotStage(sessionRef.current, stageId);
      const request = stage?.active ?? stage?.pending;
      if (request === null || request === undefined) return;
      const wasActive = stage?.active !== null;
      dispatch({ type: "cancelled", stageId, token: request.token });
      if (wasActive) {
        ownersRef.current.get(stageId)?.coordinator.cancel();
      }
    },
    [dispatch],
  );

  const retry = useCallback(
    (stageId: string): void => {
      if (!isGeneratedStage(sketchRef.current, stageId)) return;
      dispatch({ type: "retry", stageId });
    },
    [dispatch],
  );

  const beginTransaction = useCallback(
    (stageIds?: readonly string[]): void => {
      let changed = false;
      for (const stageId of generatedStageIds(stageIds)) {
        if (transactionStageIdsRef.current.has(stageId)) continue;
        transactionStageIdsRef.current.add(stageId);
        changed = true;
      }
      if (changed) setTransactionRevision((revision) => revision + 1);
    },
    [generatedStageIds],
  );

  const previewAuthoredState = useCallback(
    (
      authored: GeneratedStageAuthoredState,
      stageIds?: readonly string[],
    ): void => {
      recordAuthoredState(authored, stageIds);
    },
    [recordAuthoredState],
  );

  const settleTransaction = useCallback(
    (
      authored: GeneratedStageAuthoredState,
      stageIds?: readonly string[],
    ): void => {
      const settledStageIds = generatedStageIds(stageIds);
      recordAuthoredState(authored, settledStageIds);
      let changed = false;
      for (const stageId of settledStageIds) {
        changed = transactionStageIdsRef.current.delete(stageId) || changed;
      }
      if (changed) setTransactionRevision((revision) => revision + 1);
    },
    [generatedStageIds, recordAuthoredState],
  );

  const requestAtomic = useCallback(
    (
      authored: GeneratedStageAuthoredState,
      stageIds?: readonly string[],
    ): void => {
      recordAuthoredState(authored, stageIds);
    },
    [recordAuthoredState],
  );

  useEffect(() => {
    const owners = ownersRef.current;
    const mountedSketch = sketchRef.current;

    return () => {
      const activeRequests = Object.entries(sessionRef.current.stages)
        .map(([stageId, stage]) => ({ stageId, active: stage.active }))
        .filter(
          (
            entry,
          ): entry is {
            readonly stageId: string;
            readonly active: NonNullable<typeof entry.active>;
          } => entry.active !== null,
        );

      for (const owner of owners.values()) owner.coordinator.dispose();
      owners.clear();

      // React StrictMode rehearses setup -> cleanup -> setup while retaining
      // reducer state. Restore demanded requests only for the same mounted
      // Sketch; a real keyed replacement discards this hook state.
      if (sketchRef.current !== mountedSketch) return;
      for (const { stageId, active } of activeRequests) {
        dispatch({ type: "cancelled", stageId, token: active.token });
        dispatch({ type: "demanded", stageId });
      }
    };
  }, [dispatch]);

  useEffect(() => {
    for (const [stageId, stage] of Object.entries(sessionRef.current.stages)) {
      if (transactionStageIdsRef.current.has(stageId)) continue;
      const pending = stage.pending;
      if (pending === null) continue;

      let owner = ownersRef.current.get(stageId);
      if (owner === undefined) {
        const factories = factoriesRef.current;
        owner = {
          coordinator: factories.coordinatorFactory(factories.workerFactory),
          generation: nextGenerationRef.current++,
        };
        ownersRef.current.set(stageId, owner);
      }

      const started = startedRef.current.get(stageId);
      if (
        started?.generation === owner.generation &&
        started.token === pending.token
      ) {
        continue;
      }
      startedRef.current.set(stageId, {
        generation: owner.generation,
        token: pending.token,
      });

      const launched = dispatch({
        type: "launched",
        stageId,
        token: pending.token,
      });
      const active = selectPlotStage(launched, stageId)?.active;
      if (
        active?.token !== pending.token ||
        !plotStagePreparationIdentitiesEqual(
          active.identity,
          pending.identity,
        ) ||
        !plotStageRegistrationIdentitiesEqual(
          active.registrationIdentity,
          pending.registrationIdentity,
        )
      ) {
        continue;
      }

      const launchedOwner = owner;
      const ownsCallback = (): boolean => {
        const currentOwner = ownersRef.current.get(stageId);
        const currentActive = selectPlotStage(
          sessionRef.current,
          stageId,
        )?.active;
        return (
          currentOwner?.coordinator === launchedOwner.coordinator &&
          currentOwner.generation === launchedOwner.generation &&
          currentActive?.token === pending.token &&
          plotStagePreparationIdentitiesEqual(
            currentActive.identity,
            pending.identity,
          ) &&
          plotStageRegistrationIdentitiesEqual(
            currentActive.registrationIdentity,
            pending.registrationIdentity,
          )
        );
      };
      const fail = (error: unknown): void => {
        if (!ownsCallback()) return;
        dispatch({
          type: "failed",
          stageId,
          token: pending.token,
          identity: pending.identity,
          registrationIdentity: pending.registrationIdentity,
          error: safeErrorDetail(error),
        });
      };

      let result: Promise<PlotStagePreparationResult>;
      try {
        const authored = authoredRef.current;
        result = launchedOwner.coordinator.start({
          identity: pending.identity,
          registrationIdentity: pending.registrationIdentity,
          seed: authored.seed,
          sampledT: authored.sampledT,
        });
      } catch (error) {
        fail(error);
        continue;
      }

      void result
        .then((outcome) => {
          if (!ownsCallback()) return;
          if (outcome.status === "success") {
            dispatch({
              type: "succeeded",
              stageId,
              token: pending.token,
              identity: outcome.identity,
              registrationIdentity: outcome.registrationIdentity,
              scene: outcome.scene,
            });
          } else if (outcome.status === "cancelled") {
            dispatch({ type: "cancelled", stageId, token: pending.token });
          } else {
            fail(outcome.error);
          }
        })
        .catch(fail);
    }
  }, [dispatch, session.stages, transactionRevision]);

  return {
    session,
    getSessionSnapshot: () => sessionRef.current,
    demand,
    cancel,
    retry,
    beginTransaction,
    previewAuthoredState,
    settleTransaction,
    requestAtomic,
  };
}
