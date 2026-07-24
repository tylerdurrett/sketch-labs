import type {
  PlotSequenceDeclaration,
  PlotStageDeclaration,
  ShadingProgress,
} from "@harness/core";

import { Button } from "./components/ui/button";
import type { PlotSequencePresentation } from "./plotSequencePresentation";
import { primaryPlotStage } from "./plotSequenceProjection";
import {
  StageControlSections,
  type StageControlSectionsProps,
} from "./StageControlSections";
import type {
  RegisteredStageActivity,
  RegisteredStageFreshness,
  RegisteredStageRecord,
  RegisteredStageRecordMap,
} from "./useRegisteredStagePreparation";

export interface PlotSequenceStageControlsProps extends Omit<
  StageControlSectionsProps,
  "plotSequence" | "presentation"
> {
  readonly declaration: PlotSequenceDeclaration;
  readonly presentation: PlotSequencePresentation;
  readonly records: RegisteredStageRecordMap;
  readonly onPresentationChange: (
    presentation: PlotSequencePresentation,
  ) => void;
  readonly onCancelStage: (stageId: string) => void;
  readonly onRetryStage: (stageId: string) => void;
}

function stagesInStudioOrder(
  declaration: PlotSequenceDeclaration,
): readonly PlotStageDeclaration[] {
  const primary = primaryPlotStage(declaration);
  return Object.freeze([
    primary,
    ...declaration.stages.filter((stage) => stage.id !== primary.id),
  ]);
}

/**
 * Explicit painter order for the transient Combined view.
 *
 * Primary is the back layer and supporting Stages follow as front layers. The
 * resulting Stage-ID collection is passed through presentation state as-is; it
 * never mutates the declaration's physical Sequence order.
 */
export function defaultCombinedStageIds(
  declaration: PlotSequenceDeclaration,
): readonly string[] {
  return Object.freeze(
    stagesInStudioOrder(declaration).map((stage) => stage.id),
  );
}

function presentationSelectsStage(
  presentation: PlotSequencePresentation,
  stageId: string,
): boolean {
  return presentation.kind === "isolated" && presentation.stageId === stageId;
}

function presentationIsCombined(
  presentation: PlotSequencePresentation,
  combinedStageIds: readonly string[],
): boolean {
  return (
    presentation.kind === "combined" &&
    presentation.stageIds.length === combinedStageIds.length &&
    presentation.stageIds.every(
      (stageId, index) => stageId === combinedStageIds[index],
    )
  );
}

function freshnessLabel(freshness: RegisteredStageFreshness): string {
  switch (freshness) {
    case "current":
      return "Current";
    case "stale":
      return "Stale";
    case "missing":
      return "Missing";
    case "unavailable":
      return "Unavailable";
  }
}

function freshnessClasses(freshness: RegisteredStageFreshness): string {
  switch (freshness) {
    case "current":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
    case "stale":
      return "border-amber-500/50 bg-amber-500/10 text-amber-200";
    case "missing":
    case "unavailable":
      return "border-border bg-muted text-muted-foreground";
  }
}

function progressPercent(progress: ShadingProgress): number {
  if (progress.totalWorkUnits === 0) return 0;
  return Math.min(
    100,
    Math.max(0, (progress.completedWorkUnits / progress.totalWorkUnits) * 100),
  );
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000)
    return `${Math.max(0, Math.round(milliseconds))} ms`;
  const seconds = Math.ceil(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes} min` : `${minutes} min ${remainder} s`;
}

function StagePreparation({
  stage,
  activity,
  onCancel,
  onRetry,
}: {
  readonly stage: PlotStageDeclaration;
  readonly activity: RegisteredStageActivity;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
}) {
  if (activity.kind === "idle") return null;

  if (activity.kind === "failed") {
    return (
      <div className="space-y-2">
        <p
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
        >
          {activity.error}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry {stage.name}
        </Button>
      </div>
    );
  }

  if (activity.progress.kind === "indeterminate") {
    return (
      <div className="space-y-2" aria-busy="true">
        <p className="text-xs text-muted-foreground">Preparing…</p>
        <progress
          aria-label={`${stage.name} preparation progress`}
          className="block h-1.5 w-full accent-foreground"
        />
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel {stage.name}
        </Button>
      </div>
    );
  }

  const progress = activity.progress.snapshot;
  const percent =
    progress === null ? null : Math.round(progressPercent(progress));
  const eta = activity.progress.eta;
  return (
    <div className="space-y-2" aria-busy="true">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">Primary Shading</span>
        <span className="tabular-nums">
          {percent === null ? "Preparing…" : `${percent}%`}
        </span>
      </div>
      <progress
        aria-label={`${stage.name} Primary Shading progress`}
        className="block h-1.5 w-full accent-foreground"
        {...(progress === null
          ? {}
          : {
              max: Math.max(1, progress.totalWorkUnits),
              value: progress.completedWorkUnits,
            })}
      />
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">Estimated time remaining</span>
        <span className="tabular-nums">
          {eta?.kind === "remaining"
            ? formatDuration(eta.remainingMs)
            : "Estimating…"}
        </span>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onCancel}>
        Cancel {stage.name}
      </Button>
    </div>
  );
}

function StageStatus({
  stage,
  record,
  onCancel,
  onRetry,
}: {
  readonly stage: PlotStageDeclaration;
  readonly record: RegisteredStageRecord | undefined;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
}) {
  const freshness = record?.freshness ?? "missing";
  const activity = record?.activity ?? { kind: "idle" };

  return (
    <section
      aria-label={`${stage.name} status`}
      data-stage-status={stage.id}
      className="space-y-2 rounded-md border border-border px-3 py-2"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="min-w-0 text-sm font-medium">{stage.name}</h3>
        <span
          role="status"
          className={`rounded-full border px-2 py-0.5 text-xs ${freshnessClasses(freshness)}`}
        >
          {freshnessLabel(freshness)}
        </span>
      </div>
      <StagePreparation
        stage={stage}
        activity={activity}
        onCancel={onCancel}
        onRetry={onRetry}
      />
    </section>
  );
}

/**
 * Plot Sequence inspector chrome over the existing G1 controller and D3 records.
 *
 * View selection, including Combined painter order, is transient presentation
 * state. Every Stage status remains mounted in every view so active cancellation
 * and local retry never disappear when the artist switches away.
 */
export function PlotSequenceStageControls({
  declaration,
  presentation,
  records,
  onPresentationChange,
  onCancelStage,
  onRetryStage,
  ...controlProps
}: PlotSequenceStageControlsProps) {
  const stages = stagesInStudioOrder(declaration);
  const combinedStageIds = defaultCombinedStageIds(declaration);

  return (
    <>
      <div
        role="group"
        aria-label="Plot Stage view"
        className="flex flex-wrap gap-1"
      >
        {stages.map((stage) => (
          <Button
            key={stage.id}
            type="button"
            variant={
              presentationSelectsStage(presentation, stage.id)
                ? "default"
                : "outline"
            }
            size="sm"
            aria-pressed={presentationSelectsStage(presentation, stage.id)}
            onClick={() =>
              onPresentationChange({
                kind: "isolated",
                stageId: stage.id,
              })
            }
          >
            {stage.name}
          </Button>
        ))}
        <Button
          type="button"
          variant={
            presentationIsCombined(presentation, combinedStageIds)
              ? "default"
              : "outline"
          }
          size="sm"
          aria-pressed={presentationIsCombined(presentation, combinedStageIds)}
          onClick={() =>
            onPresentationChange({
              kind: "combined",
              stageIds: combinedStageIds,
            })
          }
        >
          Combined
        </Button>
      </div>
      <div
        role="region"
        aria-label="Plot Stage status"
        className="flex flex-col gap-2"
      >
        {stages.map((stage) => (
          <StageStatus
            key={stage.id}
            stage={stage}
            record={records[stage.id]}
            onCancel={() => onCancelStage(stage.id)}
            onRetry={() => onRetryStage(stage.id)}
          />
        ))}
      </div>
      <StageControlSections
        {...controlProps}
        plotSequence={declaration}
        presentation={presentation}
      />
    </>
  );
}
