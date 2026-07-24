import type {
  PlotSequenceDeclaration,
  PlotStageDeclaration,
  Scene,
} from "@harness/core";

import { primaryPlotStage } from "./plotSequenceProjection";
import {
  plotStageRegistrationIdentitiesEqual,
  type PlotStageRegistrationIdentity,
} from "./plotStagePreparationProtocol";
import type {
  RegisteredStageActivity,
  RegisteredStageFreshness,
  RegisteredStageRecord,
  RegisteredStageRecordMap,
} from "./useRegisteredStagePreparation";

/** A transient Studio view over one or more retained Plot Stages. */
export type PlotSequencePresentation =
  | {
      readonly kind: "isolated";
      readonly stageId: string;
    }
  | {
      readonly kind: "combined";
      /** Explicit painter order: first is the back, last is the front. */
      readonly stageIds: readonly string[];
    };

/**
 * Downstream-only Stage presentation seam.
 *
 * A caller may bind Studio-owned settings around `finalizeStudioPlotStage`.
 * The source remains D3's ordinary retained Scene and is never replaced in its
 * record or assigned a new preparation/registration identity.
 */
export type PlotStagePresentationTransform = (
  stageId: string,
  sourceScene: Scene,
) => Scene;

/** Current D3 truth paired with declaration-owned display metadata. */
export interface PlotStagePresentationStatus {
  readonly stageId: string;
  readonly name: string;
  readonly recordPresent: boolean;
  readonly freshness: RegisteredStageFreshness;
  readonly activity: RegisteredStageActivity | null;
  readonly outputReady: boolean;
  readonly hasRetainedScene: boolean;
}

/**
 * One renderable presentation reduction.
 *
 * `held` means `scene` and `registrationIdentity` came from `previous` because
 * the current Combined records do not form one coherent registration set.
 * `stages` always describes the current D3 records, including failures and
 * unavailable/missing geometry.
 */
export interface PlotSequencePresentationSnapshot {
  readonly presentation: PlotSequencePresentation;
  readonly scene: Scene | null;
  readonly registrationIdentity: PlotStageRegistrationIdentity | null;
  readonly stages: readonly PlotStagePresentationStatus[];
  readonly held: boolean;
}

export interface PlotSequencePresentationInput {
  readonly declaration: PlotSequenceDeclaration;
  readonly records: RegisteredStageRecordMap;
  readonly presentation: PlotSequencePresentation;
  readonly previous?: PlotSequencePresentationSnapshot | null;
  readonly finalizeStudioPlotStage?: PlotStagePresentationTransform;
}

/**
 * Photo Scribble's initial Combined painter order.
 *
 * This is intentionally independent of its authored physical execution order:
 * Ink is painted first and Watercolor Forms is painted on top.
 */
export const PHOTO_SCRIBBLE_COMBINED_PRESENTATION: PlotSequencePresentation =
  Object.freeze({
    kind: "combined",
    stageIds: Object.freeze(["ink-scribble", "watercolor-forms"]),
  });

const OPERATION = "plotSequencePresentation";

function fail(message: string): never {
  throw new Error(`${OPERATION}: ${message}`);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stageMap(
  declaration: PlotSequenceDeclaration,
): ReadonlyMap<string, PlotStageDeclaration> {
  if (!Array.isArray(declaration.stages)) {
    fail("declaration.stages must be an array");
  }

  const stages = new Map<string, PlotStageDeclaration>();
  for (const [index, stage] of declaration.stages.entries()) {
    if (typeof stage.id !== "string" || stage.id.trim().length === 0) {
      fail(`stages[${index}].id must be a nonempty string`);
    }
    if (stages.has(stage.id)) {
      fail(`duplicate Stage id \`${stage.id}\``);
    }
    stages.set(stage.id, stage);
  }
  return stages;
}

function presentationStageIds(
  presentation: PlotSequencePresentation,
): readonly string[] {
  const stageIds =
    presentation.kind === "isolated"
      ? [presentation.stageId]
      : [...presentation.stageIds];

  if (stageIds.length === 0) {
    fail("Combined presentation requires at least one Stage");
  }

  const seen = new Set<string>();
  for (const stageId of stageIds) {
    if (typeof stageId !== "string" || stageId.trim().length === 0) {
      fail("presented Stage ids must be nonempty strings");
    }
    if (seen.has(stageId)) {
      fail(`duplicate presented Stage id \`${stageId}\``);
    }
    seen.add(stageId);
  }
  return Object.freeze(stageIds);
}

function canonicalPresentation(
  presentation: PlotSequencePresentation,
  stageIds: readonly string[],
): PlotSequencePresentation {
  return presentation.kind === "isolated"
    ? Object.freeze({ kind: "isolated", stageId: stageIds[0]! })
    : Object.freeze({ kind: "combined", stageIds });
}

function stageRecord(
  records: RegisteredStageRecordMap,
  stageId: string,
): RegisteredStageRecord | null {
  if (!hasOwn(records, stageId)) return null;
  const record = records[stageId];
  if (record === undefined) return null;
  if (record.stageId !== stageId) {
    fail(`record key \`${stageId}\` contains Stage \`${record.stageId}\``);
  }
  return record;
}

function stageStatus(
  stage: PlotStageDeclaration,
  record: RegisteredStageRecord | null,
): PlotStagePresentationStatus {
  return Object.freeze({
    stageId: stage.id,
    name: stage.name,
    recordPresent: record !== null,
    freshness: record?.freshness ?? "missing",
    activity: record?.activity ?? null,
    outputReady: record?.outputReady ?? false,
    hasRetainedScene: record?.scene !== null && record?.scene !== undefined,
  });
}

function presentationsEqual(
  left: PlotSequencePresentation,
  right: PlotSequencePresentation,
): boolean {
  if (left.kind === "isolated" && right.kind === "isolated") {
    return left.stageId === right.stageId;
  }
  if (left.kind === "combined" && right.kind === "combined") {
    return (
      left.stageIds.length === right.stageIds.length &&
      left.stageIds.every(
        (stageId, index) => stageId === right.stageIds[index],
      )
    );
  }
  return false;
}

function coherentRegistration(
  records: readonly RegisteredStageRecord[],
): PlotStageRegistrationIdentity | null {
  const first = records[0]?.registrationIdentity;
  if (first === null || first === undefined) return null;

  for (const record of records) {
    if (
      record.scene === null ||
      record.registrationIdentity === null ||
      !plotStageRegistrationIdentitiesEqual(
        first,
        record.registrationIdentity,
      )
    ) {
      return null;
    }
  }
  return first;
}

function combineScenes(scenes: readonly Scene[]): Scene {
  const back = scenes[0]!;
  const primitives = scenes.flatMap((scene) => scene.primitives);
  return back.background !== undefined
    ? {
        space: back.space,
        primitives,
        background: back.background,
      }
    : { space: back.space, primitives };
}

/** Return the declaration's unique Primary Stage as the transient default. */
export function defaultPlotSequencePresentation(
  declaration: PlotSequenceDeclaration,
): PlotSequencePresentation {
  return Object.freeze({
    kind: "isolated",
    stageId: primaryPlotStage(declaration).id,
  });
}

/**
 * Reduce D3 registered records to one isolated or registration-coherent Scene.
 *
 * The function owns no cache or lifecycle. Callers feed the prior snapshot back
 * in when they want atomic Combined presentation across independently arriving
 * shared revisions.
 */
export function plotSequencePresentation({
  declaration,
  records,
  presentation,
  previous = null,
  finalizeStudioPlotStage = (_stageId, sourceScene) => sourceScene,
}: PlotSequencePresentationInput): PlotSequencePresentationSnapshot {
  const declaredStages = stageMap(declaration);
  const stageIds = presentationStageIds(presentation);
  const canonical = canonicalPresentation(presentation, stageIds);
  const selected = stageIds.map((stageId) => {
    const stage = declaredStages.get(stageId);
    if (stage === undefined) {
      fail(`missing Stage \`${stageId}\``);
    }
    return { stage, record: stageRecord(records, stageId) };
  });
  const statuses = Object.freeze(
    selected.map(({ stage, record }) => stageStatus(stage, record)),
  );

  if (canonical.kind === "isolated") {
    const record = selected[0]!.record;
    const sourceScene = record?.scene ?? null;
    return Object.freeze({
      presentation: canonical,
      scene:
        sourceScene === null
          ? null
          : finalizeStudioPlotStage(canonical.stageId, sourceScene),
      registrationIdentity: record?.registrationIdentity ?? null,
      stages: statuses,
      held: false,
    });
  }

  const selectedRecords = selected.flatMap(({ record }) =>
    record === null ? [] : [record],
  );
  const registration =
    selectedRecords.length === selected.length
      ? coherentRegistration(selectedRecords)
      : null;

  if (registration !== null) {
    const scenes = selectedRecords.map((record) =>
      finalizeStudioPlotStage(record.stageId, record.scene!),
    );
    return Object.freeze({
      presentation: canonical,
      scene: scenes.length === 1 ? scenes[0]! : combineScenes(scenes),
      registrationIdentity: registration,
      stages: statuses,
      held: false,
    });
  }

  if (
    previous !== null &&
    previous.scene !== null &&
    previous.registrationIdentity !== null &&
    previous.presentation.kind === "combined" &&
    presentationsEqual(previous.presentation, canonical)
  ) {
    return Object.freeze({
      presentation: canonical,
      scene: previous.scene,
      registrationIdentity: previous.registrationIdentity,
      stages: statuses,
      held: true,
    });
  }

  return Object.freeze({
    presentation: canonical,
    scene: null,
    registrationIdentity: null,
    stages: statuses,
    held: false,
  });
}
