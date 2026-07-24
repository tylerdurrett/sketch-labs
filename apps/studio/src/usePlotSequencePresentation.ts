import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { PlotSequenceDeclaration } from "@harness/core";

import {
  defaultPlotSequencePresentation,
  plotSequencePresentation,
  type PlotSequencePresentation,
  type PlotSequencePresentationSnapshot,
  type PlotStagePresentationTransform,
} from "./plotSequencePresentation";
import type {
  RegisteredStageRecordMap,
  UseRegisteredStagePreparationResult,
} from "./useRegisteredStagePreparation";

export interface UsePlotSequencePresentationOptions {
  readonly declaration: PlotSequenceDeclaration;
  readonly records: RegisteredStageRecordMap;
  readonly demand: UseRegisteredStagePreparationResult["demand"];
  /**
   * Internal deterministic seam for wiring tests. Production omits this so a
   * keyed Sketch mount always starts on its declaration's unique Primary.
   */
  readonly initialPresentation?: PlotSequencePresentation;
  readonly finalizeStudioPlotStage?: PlotStagePresentationTransform;
}

export interface PlotSequencePresentationController {
  readonly presentation: PlotSequencePresentation;
  readonly setPresentation: (presentation: PlotSequencePresentation) => void;
  readonly snapshot: PlotSequencePresentationSnapshot;
}

function presentedStageIds(
  presentation: PlotSequencePresentation,
): readonly string[] {
  return presentation.kind === "isolated"
    ? [presentation.stageId]
    : presentation.stageIds;
}

/**
 * Own transient Plot Sequence view selection without entering edit history.
 *
 * Supporting work is demanded on entry and never cancelled on exit. E1 receives
 * its last coherent Combined snapshot so independently arriving shared
 * revisions remain atomic on screen.
 */
export function usePlotSequencePresentation({
  declaration,
  records,
  demand,
  initialPresentation,
  finalizeStudioPlotStage,
}: UsePlotSequencePresentationOptions): PlotSequencePresentationController {
  const [presentation, setPresentationState] =
    useState<PlotSequencePresentation>(
      () => initialPresentation ?? defaultPlotSequencePresentation(declaration),
    );
  const previousCombinedRef = useRef<PlotSequencePresentationSnapshot | null>(
    null,
  );

  const snapshot = plotSequencePresentation({
    declaration,
    records,
    presentation,
    previous: previousCombinedRef.current,
    ...(finalizeStudioPlotStage === undefined
      ? {}
      : { finalizeStudioPlotStage }),
  });
  useLayoutEffect(() => {
    if (
      snapshot.presentation.kind === "combined" &&
      snapshot.scene !== null &&
      !snapshot.held
    ) {
      previousCombinedRef.current = snapshot;
    }
  }, [snapshot]);

  useEffect(() => {
    const stages = new Map(
      declaration.stages.map((stage) => [stage.id, stage]),
    );
    for (const stageId of presentedStageIds(presentation)) {
      if (stages.get(stageId)?.source.kind === "generator") demand(stageId);
    }
  }, [declaration, demand, presentation]);

  const setPresentation = useCallback(
    (next: PlotSequencePresentation): void => {
      setPresentationState(next);
    },
    [],
  );

  return { presentation, setPresentation, snapshot };
}
