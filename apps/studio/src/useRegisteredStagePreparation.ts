import { useCallback, useMemo, useRef } from "react";

import type {
  CoordinateSpace,
  Params,
  PlotSequenceDeclaration,
  PlotStageDeclaration,
  Scene,
  Seed,
  ShadingProgress,
  Sketch,
} from "@harness/core";

import type { PlotStageWorkerFactory } from "./plotStageCoordinator";
import {
  createPlotStagePreparationIdentity,
  createPlotStageRegistrationIdentity,
  plotStagePreparationIdentitiesEqual,
  plotStageRegistrationIdentitiesEqual,
  type PlotStagePreparationIdentity,
  type PlotStageRegistrationIdentity,
} from "./plotStagePreparationProtocol";
import {
  selectPlotStage,
  type PlotStageSessionState,
} from "./plotStageSession";
import type { RollingEtaEstimate } from "./rollingEta";
import type { ShadingWorkerFactory } from "./shadingCoordinator";
import type { ShadingComputeIdentity } from "./shadingComputeProtocol";
import {
  selectCurrentShadingResult,
  type ShadingSessionState,
} from "./shadingSession";
import type { GeneratedStagePreparationCoordinatorFactory } from "./useGeneratedStagePreparation";
import {
  useGeneratedStagePreparation,
  type GeneratedStageAuthoredState,
} from "./useGeneratedStagePreparation";
import type { ShadingPreparationCoordinatorFactory } from "./useShadingPreparation";
import {
  useShadingPreparation,
  type ShadingAuthoredState,
  type ShadingPreparationProgress,
  type UseShadingPreparationResult,
} from "./useShadingPreparation";

export interface RegisteredStageAuthoredState {
  readonly params: Readonly<Params>;
  readonly seed: Seed;
  readonly sampledT: number;
  readonly compositionFrame: Readonly<CoordinateSpace>;
  readonly inputRevision: number;
}

export type RegisteredStagePreparationSketch = Pick<
  Sketch,
  "id" | "schema" | "generateShadingArtwork"
> & {
  readonly plotSequence: PlotSequenceDeclaration;
};

export type RegisteredStageFreshness =
  | "current"
  | "stale"
  | "missing"
  | "unavailable";

export type RegisteredStageProgress =
  | {
      readonly kind: "shading";
      readonly snapshot: ShadingProgress | null;
      readonly eta: RollingEtaEstimate | null;
    }
  | { readonly kind: "indeterminate" };

export type RegisteredStageActivity =
  | { readonly kind: "idle" }
  | {
      readonly kind: "preparing";
      readonly progress: RegisteredStageProgress;
    }
  | { readonly kind: "failed"; readonly error: string };

/**
 * Source-neutral retained preparation state for one authored Stage instance.
 *
 * The retained identities describe `scene`; expected identities describe the
 * latest authored state. Consumers must use `outputReady`, rather than the mere
 * presence of retained geometry, before export or registration-sensitive use.
 */
export interface RegisteredStageRecord {
  readonly stageId: string;
  readonly sourceKind: "primary" | "generator";
  readonly registrationIdentity: PlotStageRegistrationIdentity | null;
  readonly preparationIdentity: PlotStagePreparationIdentity | null;
  readonly expectedRegistrationIdentity: PlotStageRegistrationIdentity;
  readonly expectedPreparationIdentity: PlotStagePreparationIdentity;
  /** Ordinary unfinalized geometry, retained even while stale. */
  readonly scene: Scene | null;
  readonly freshness: RegisteredStageFreshness;
  readonly activity: RegisteredStageActivity;
  readonly outputReady: boolean;
}

export type RegisteredStageRecordMap = Readonly<
  Record<string, RegisteredStageRecord>
>;

export interface UseRegisteredStagePreparationOptions {
  readonly sketch: RegisteredStagePreparationSketch;
  /** The mounted edit history's initial present state. */
  readonly initial: RegisteredStageAuthoredState;
  /** Gate Primary preparation while caller-owned resources are unavailable. */
  readonly enabled?: boolean;
  readonly shadingWorkerFactory?: ShadingWorkerFactory;
  readonly shadingCoordinatorFactory?: ShadingPreparationCoordinatorFactory;
  readonly generatedWorkerFactory?: PlotStageWorkerFactory;
  readonly generatedCoordinatorFactory?: GeneratedStagePreparationCoordinatorFactory;
}

export interface UseRegisteredStagePreparationResult {
  readonly records: RegisteredStageRecordMap;
  /**
   * Existing Primary diagnostics/provenance seam.
   *
   * D3 owns this one adapted Shading session; Sequence consumers must not mount
   * a parallel legacy owner beside it.
   */
  readonly primaryShadingPreparation: UseShadingPreparationResult;
  /** Rebuild records from both drivers' latest synchronous reducer mirrors. */
  readonly getSnapshot: () => RegisteredStageRecordMap;
  readonly lookup: (stageId: string) => RegisteredStageRecord | undefined;
  readonly demand: (stageId: string) => void;
  readonly cancel: (stageId: string) => void;
  readonly retry: (stageId: string) => void;
  /** Open preparation ownership only for the named Stage instances. */
  readonly beginTransaction: (stageIds: readonly string[]) => void;
  /** Open only the Stages whose declared identity binds this schema key. */
  readonly beginParamTransaction: (schemaKey: string) => void;
  /** Open only Stages whose preparation identity depends on Seed. */
  readonly beginSeedTransaction: () => void;
  /** Compare against the facade's latest authored identity snapshot. */
  readonly changedStageIds: (
    authored: RegisteredStageAuthoredState,
  ) => readonly string[];
  readonly previewAuthoredState: (
    authored: RegisteredStageAuthoredState,
  ) => void;
  readonly settleTransaction: (authored: RegisteredStageAuthoredState) => void;
  readonly requestAtomic: (authored: RegisteredStageAuthoredState) => void;
}

interface RetainedStageIdentities {
  readonly preparationIdentity: PlotStagePreparationIdentity;
  readonly registrationIdentity: PlotStageRegistrationIdentity;
}

const IDLE_ACTIVITY: RegisteredStageActivity = Object.freeze({ kind: "idle" });
const INDETERMINATE_PROGRESS: RegisteredStageProgress = Object.freeze({
  kind: "indeterminate",
});

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function toShadingAuthored(
  authored: RegisteredStageAuthoredState,
): ShadingAuthoredState {
  return {
    params: authored.params,
    seed: authored.seed,
    compositionFrame: authored.compositionFrame,
    inputRevision: authored.inputRevision,
  };
}

function toGeneratedAuthored(
  authored: RegisteredStageAuthoredState,
): GeneratedStageAuthoredState {
  return {
    params: authored.params,
    seed: authored.seed,
    sampledT: authored.sampledT,
    compositionFrame: authored.compositionFrame,
  };
}

function expectedIdentities(
  sketch: RegisteredStagePreparationSketch,
  stageId: string,
  authored: RegisteredStageAuthoredState,
): RetainedStageIdentities {
  return {
    preparationIdentity: createPlotStagePreparationIdentity({
      sketchId: sketch.id,
      stageId,
      schema: sketch.schema,
      declaration: sketch.plotSequence,
      params: authored.params,
      seed: authored.seed,
      sampledT: authored.sampledT,
      compositionFrame: authored.compositionFrame,
    }),
    registrationIdentity: createPlotStageRegistrationIdentity({
      schema: sketch.schema,
      declaration: sketch.plotSequence,
      params: authored.params,
      compositionFrame: authored.compositionFrame,
    }),
  };
}

/**
 * Adapt the existing Primary Shading identity to the Stage identity vocabulary.
 * Existing Shading has no sampled-time identity, so a time-dependent Primary
 * is deliberately unavailable through this adapter rather than mislabelled.
 */
function primaryRetainedIdentities(
  sketch: RegisteredStagePreparationSketch,
  stage: PlotStageDeclaration,
  identity: ShadingComputeIdentity,
): RetainedStageIdentities | null {
  if (stage.dependencies.usesTime) return null;

  const values = new Map(
    identity.params.map((entry) => [entry.key, entry.value]),
  );
  const entries = (bindings: PlotSequenceDeclaration["sharedParameters"]) => {
    const projected = [];
    for (const binding of bindings) {
      if (!values.has(binding.schemaKey)) return null;
      projected.push(
        Object.freeze({
          key: binding.key,
          value: values.get(binding.schemaKey)!,
        }),
      );
    }
    return Object.freeze(projected);
  };
  const registrationParams = entries(sketch.plotSequence.sharedParameters);
  const preparationParams = entries([
    ...sketch.plotSequence.sharedParameters,
    ...stage.parameters,
  ]);
  if (registrationParams === null || preparationParams === null) return null;

  const compositionFrame = Object.freeze({
    width: identity.compositionFrame.width,
    height: identity.compositionFrame.height,
  });
  return {
    registrationIdentity: Object.freeze({
      params: registrationParams,
      compositionFrame,
    }),
    preparationIdentity: Object.freeze({
      sketchId: identity.sketchId,
      stageId: stage.id,
      params: preparationParams,
      compositionFrame,
      ...(stage.dependencies.usesSeed ? { seed: identity.seed } : {}),
    }),
  };
}

function identitiesAreCurrent(
  retained: RetainedStageIdentities | null,
  expected: RetainedStageIdentities,
): boolean {
  return (
    retained !== null &&
    plotStagePreparationIdentitiesEqual(
      retained.preparationIdentity,
      expected.preparationIdentity,
    ) &&
    plotStageRegistrationIdentitiesEqual(
      retained.registrationIdentity,
      expected.registrationIdentity,
    )
  );
}

function changedStageIdsForAuthoredState(
  sketch: RegisteredStagePreparationSketch,
  previous: RegisteredStageAuthoredState,
  next: RegisteredStageAuthoredState,
): readonly string[] {
  return sketch.plotSequence.stages
    .filter((stage) => {
      const previousIdentities = expectedIdentities(
        sketch,
        stage.id,
        previous,
      );
      const nextIdentities = expectedIdentities(sketch, stage.id, next);
      return !identitiesAreCurrent(previousIdentities, nextIdentities);
    })
    .map((stage) => stage.id);
}

function primaryActivity(
  session: ShadingSessionState,
  progress: ShadingPreparationProgress | null,
): RegisteredStageActivity {
  const preparing = session.pending !== null || session.active !== null;
  if (preparing) {
    const currentProgress =
      progress !== null && progress.token === session.active?.token
        ? progress.update
        : null;
    return Object.freeze({
      kind: "preparing",
      progress: Object.freeze({
        kind: "shading",
        snapshot: currentProgress?.snapshot ?? null,
        eta: currentProgress?.eta ?? null,
      }),
    });
  }
  if (session.failure !== null) {
    return Object.freeze({ kind: "failed", error: session.failure });
  }
  return IDLE_ACTIVITY;
}

interface CreateRecordMapInput {
  readonly sketch: RegisteredStagePreparationSketch;
  readonly authored: RegisteredStageAuthoredState;
  readonly primaryAvailable: boolean;
  readonly shadingSession: ShadingSessionState;
  readonly shadingProgress: ShadingPreparationProgress | null;
  readonly generatedSession: PlotStageSessionState;
}

function createRecordMap({
  sketch,
  authored,
  primaryAvailable,
  shadingSession,
  shadingProgress,
  generatedSession,
}: CreateRecordMapInput): RegisteredStageRecordMap {
  const records: Record<string, RegisteredStageRecord> = {};

  for (const stage of sketch.plotSequence.stages) {
    const expected = expectedIdentities(sketch, stage.id, authored);
    let retained: RetainedStageIdentities | null = null;
    let scene: Scene | null = null;
    let freshness: RegisteredStageFreshness;
    let activity: RegisteredStageActivity;

    if (stage.source.kind === "primary") {
      const displayed = shadingSession.displayed;
      retained =
        displayed === null
          ? null
          : primaryRetainedIdentities(sketch, stage, displayed.identity);
      scene = displayed?.scene ?? null;
      freshness = !primaryAvailable
        ? "unavailable"
        : scene === null || retained === null
          ? "missing"
          : selectCurrentShadingResult(shadingSession) !== null &&
              identitiesAreCurrent(retained, expected)
            ? "current"
            : "stale";
      activity = primaryAvailable
        ? primaryActivity(shadingSession, shadingProgress)
        : IDLE_ACTIVITY;
    } else {
      const generated = selectPlotStage(generatedSession, stage.id);
      const completed = generated?.completed ?? null;
      retained =
        completed === null
          ? null
          : {
              preparationIdentity: completed.identity,
              registrationIdentity: completed.registrationIdentity,
            };
      scene = completed?.scene ?? null;
      freshness =
        scene === null
          ? "missing"
          : identitiesAreCurrent(retained, expected)
            ? "current"
            : "stale";
      activity =
        (generated?.pending !== null && generated?.pending !== undefined) ||
        (generated?.active !== null && generated?.active !== undefined)
          ? Object.freeze({
              kind: "preparing",
              progress: INDETERMINATE_PROGRESS,
            })
          : generated?.failure !== null && generated?.failure !== undefined
            ? Object.freeze({
                kind: "failed",
                error: generated.failure.error,
              })
            : IDLE_ACTIVITY;
    }

    const record = Object.freeze({
      stageId: stage.id,
      sourceKind: stage.source.kind,
      registrationIdentity: retained?.registrationIdentity ?? null,
      preparationIdentity: retained?.preparationIdentity ?? null,
      expectedRegistrationIdentity: expected.registrationIdentity,
      expectedPreparationIdentity: expected.preparationIdentity,
      scene,
      freshness,
      activity,
      outputReady: freshness === "current",
    } satisfies RegisteredStageRecord);
    Object.defineProperty(records, stage.id, {
      value: record,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }

  return Object.freeze(records);
}

/**
 * Present every declared Stage through one Stage-ID-keyed retained-preparation
 * facade while preserving the source-specific worker and progress semantics.
 */
export function useRegisteredStagePreparation({
  sketch,
  initial,
  enabled = true,
  shadingWorkerFactory,
  shadingCoordinatorFactory,
  generatedWorkerFactory,
  generatedCoordinatorFactory,
}: UseRegisteredStagePreparationOptions): UseRegisteredStagePreparationResult {
  const sketchRef = useRef(sketch);
  const authoredRef = useRef(initial);
  const stageByIdRef = useRef(
    new Map(sketch.plotSequence.stages.map((stage) => [stage.id, stage])),
  );
  const primaryAvailable =
    sketch.generateShadingArtwork !== undefined &&
    !sketch.plotSequence.stages.some(
      (stage) => stage.source.kind === "primary" && stage.dependencies.usesTime,
    );

  const shading = useShadingPreparation({
    sketch,
    initial: toShadingAuthored(initial),
    enabled: primaryAvailable && enabled,
    ...(shadingWorkerFactory === undefined
      ? {}
      : { workerFactory: shadingWorkerFactory }),
    ...(shadingCoordinatorFactory === undefined
      ? {}
      : { coordinatorFactory: shadingCoordinatorFactory }),
  });
  const generated = useGeneratedStagePreparation({
    sketch,
    initial: toGeneratedAuthored(initial),
    ...(generatedWorkerFactory === undefined
      ? {}
      : { workerFactory: generatedWorkerFactory }),
    ...(generatedCoordinatorFactory === undefined
      ? {}
      : { coordinatorFactory: generatedCoordinatorFactory }),
  });
  const shadingProgressRef = useRef(shading.progress);
  shadingProgressRef.current = shading.progress;
  const transactionStageIdsRef = useRef(new Set<string>());

  const snapshot = useCallback(
    (): RegisteredStageRecordMap =>
      createRecordMap({
        sketch: sketchRef.current,
        authored: authoredRef.current,
        primaryAvailable,
        shadingSession: shading.getSessionSnapshot(),
        shadingProgress: shadingProgressRef.current,
        generatedSession: generated.getSessionSnapshot(),
      }),
    [
      generated.getSessionSnapshot,
      primaryAvailable,
      shading.getSessionSnapshot,
    ],
  );

  const records = useMemo(
    () =>
      createRecordMap({
        sketch,
        authored: authoredRef.current,
        primaryAvailable,
        shadingSession: shading.session,
        shadingProgress: shading.progress,
        generatedSession: generated.session,
      }),
    [
      generated.session,
      primaryAvailable,
      shading.progress,
      shading.session,
      sketch,
    ],
  );

  const demand = useCallback(
    (stageId: string): void => {
      const stage = stageByIdRef.current.get(stageId);
      if (stage?.source.kind === "primary") {
        shading.resumeLatest();
      } else if (stage?.source.kind === "generator") {
        generated.demand(stageId);
      }
    },
    [generated.demand, shading.resumeLatest],
  );

  const cancel = useCallback(
    (stageId: string): void => {
      const stage = stageByIdRef.current.get(stageId);
      if (stage?.source.kind === "primary") {
        shading.suspend();
      } else if (stage?.source.kind === "generator") {
        generated.cancel(stageId);
      }
    },
    [generated.cancel, shading.suspend],
  );

  const retry = useCallback(
    (stageId: string): void => {
      const stage = stageByIdRef.current.get(stageId);
      if (stage?.source.kind === "primary") {
        if (shading.getSessionSnapshot().suspended) shading.resumeLatest();
        else shading.retry();
      } else if (stage?.source.kind === "generator") {
        generated.retry(stageId);
      }
    },
    [
      generated.retry,
      shading.getSessionSnapshot,
      shading.resumeLatest,
      shading.retry,
    ],
  );

  const sourceStageIds = useCallback(
    (
      stageIds: readonly string[],
      sourceKind: "primary" | "generator",
    ): readonly string[] =>
      stageIds.filter(
        (stageId) =>
          stageByIdRef.current.get(stageId)?.source.kind === sourceKind,
      ),
    [],
  );

  const beginTransaction = useCallback(
    (stageIds: readonly string[]): void => {
      const newlyOpened = stageIds.filter((stageId) => {
        if (
          !stageByIdRef.current.has(stageId) ||
          transactionStageIdsRef.current.has(stageId)
        ) {
          return false;
        }
        transactionStageIdsRef.current.add(stageId);
        return true;
      });
      if (sourceStageIds(newlyOpened, "primary").length > 0) {
        shading.beginTransaction();
      }
      const generatedStageIds = sourceStageIds(newlyOpened, "generator");
      if (generatedStageIds.length > 0) {
        generated.beginTransaction(generatedStageIds);
      }
    },
    [generated.beginTransaction, shading.beginTransaction, sourceStageIds],
  );

  const beginParamTransaction = useCallback(
    (schemaKey: string): void => {
      const declaration = sketchRef.current.plotSequence;
      const shared = declaration.sharedParameters.some(
        (binding) => binding.schemaKey === schemaKey,
      );
      beginTransaction(
        declaration.stages
          .filter(
            (stage) =>
              shared ||
              stage.parameters.some(
                (binding) => binding.schemaKey === schemaKey,
              ),
          )
          .map((stage) => stage.id),
      );
    },
    [beginTransaction],
  );

  const beginSeedTransaction = useCallback((): void => {
    beginTransaction(
      sketchRef.current.plotSequence.stages
        .filter((stage) => stage.dependencies.usesSeed)
        .map((stage) => stage.id),
    );
  }, [beginTransaction]);

  const changedStageIds = useCallback(
    (authored: RegisteredStageAuthoredState): readonly string[] =>
      changedStageIdsForAuthoredState(
        sketchRef.current,
        authoredRef.current,
        authored,
      ),
    [],
  );

  const previewAuthoredState = useCallback(
    (authored: RegisteredStageAuthoredState): void => {
      const changed = changedStageIds(authored);
      beginTransaction(changed);
      authoredRef.current = authored;
      if (sourceStageIds(changed, "primary").length > 0) {
        shading.previewAuthoredState(toShadingAuthored(authored));
      }
      const generatedStageIds = sourceStageIds(changed, "generator");
      if (generatedStageIds.length > 0) {
        generated.previewAuthoredState(
          toGeneratedAuthored(authored),
          generatedStageIds,
        );
      }
    },
    [
      beginTransaction,
      changedStageIds,
      generated.previewAuthoredState,
      shading.previewAuthoredState,
      sourceStageIds,
    ],
  );

  const settleTransaction = useCallback(
    (authored: RegisteredStageAuthoredState): void => {
      const changed = changedStageIds(authored);
      const opened = [...transactionStageIdsRef.current];
      const changedWithoutTransaction = changed.filter(
        (stageId) => !transactionStageIdsRef.current.has(stageId),
      );
      authoredRef.current = authored;
      if (sourceStageIds(opened, "primary").length > 0) {
        shading.settleTransaction(toShadingAuthored(authored));
      } else if (
        sourceStageIds(changedWithoutTransaction, "primary").length > 0
      ) {
        shading.requestAtomic(toShadingAuthored(authored));
      }
      const openedGenerated = sourceStageIds(opened, "generator");
      if (openedGenerated.length > 0) {
        generated.settleTransaction(
          toGeneratedAuthored(authored),
          openedGenerated,
        );
      }
      const atomicGenerated = sourceStageIds(
        changedWithoutTransaction,
        "generator",
      );
      if (atomicGenerated.length > 0) {
        generated.requestAtomic(
          toGeneratedAuthored(authored),
          atomicGenerated,
        );
      }
      transactionStageIdsRef.current.clear();
    },
    [
      changedStageIds,
      generated.requestAtomic,
      generated.settleTransaction,
      shading.requestAtomic,
      shading.settleTransaction,
      sourceStageIds,
    ],
  );

  const requestAtomic = useCallback(
    (authored: RegisteredStageAuthoredState): void => {
      const changed = changedStageIds(authored);
      authoredRef.current = authored;
      if (sourceStageIds(changed, "primary").length > 0) {
        shading.requestAtomic(toShadingAuthored(authored));
      }
      const generatedStageIds = sourceStageIds(changed, "generator");
      if (generatedStageIds.length > 0) {
        generated.requestAtomic(
          toGeneratedAuthored(authored),
          generatedStageIds,
        );
      }
    },
    [
      changedStageIds,
      generated.requestAtomic,
      shading.requestAtomic,
      sourceStageIds,
    ],
  );

  const lookup = useCallback(
    (stageId: string): RegisteredStageRecord | undefined => {
      const current = snapshot();
      return hasOwn(current, stageId) ? current[stageId] : undefined;
    },
    [snapshot],
  );

  return {
    records,
    primaryShadingPreparation: shading,
    getSnapshot: snapshot,
    lookup,
    demand,
    cancel,
    retry,
    beginTransaction,
    beginParamTransaction,
    beginSeedTransaction,
    changedStageIds,
    previewAuthoredState,
    settleTransaction,
    requestAtomic,
  };
}
