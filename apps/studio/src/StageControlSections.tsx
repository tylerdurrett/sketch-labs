import type { PlotSequenceDeclaration } from "@harness/core";

import { ControlPanel, type ControlPanelProps } from "./ControlPanel";
import {
  plotStageProjection,
  type PlotStageProjection,
} from "./plotSequenceProjection";

/** Which Stage-owned control groups the Studio should present. */
export type StageControlPresentation =
  | {
      readonly kind: "isolated";
      readonly stageId: string;
    }
  | {
      readonly kind: "combined";
      /** Explicit presentation order; independent of physical Sequence order. */
      readonly stageIds: readonly string[];
    };

export interface StageControlSectionsProps
  extends Omit<ControlPanelProps, "orderedKeys"> {
  /** Optional declaration owned by the same Sketch as the complete `schema`. */
  readonly plotSequence?: PlotSequenceDeclaration | undefined;
  /** Required for a Plot Sequence and absent for an ordinary Sketch. */
  readonly presentation?: StageControlPresentation | undefined;
}

function fail(message: string): never {
  throw new Error(`StageControlSections: ${message}`);
}

function stageProjections(
  schema: ControlPanelProps["schema"],
  declaration: PlotSequenceDeclaration,
  presentation: StageControlPresentation,
): readonly PlotStageProjection[] {
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
      fail("Stage ids must be nonempty strings");
    }
    if (seen.has(stageId)) {
      fail(`duplicate presented Stage id \`${stageId}\``);
    }
    seen.add(stageId);
  }

  return stageIds.map((stageId) =>
    plotStageProjection(schema, declaration, stageId),
  );
}

/**
 * Present a complete owning schema as shared and Stage-owned control groups.
 *
 * Shared controls render exactly once. Isolated presentation follows them with
 * the selected Stage; Combined follows them with every requested Stage in the
 * caller's explicit presentation order. Each nested panel still receives the
 * complete owning schema and params so filtering cannot change applicability,
 * transaction, Lock, Image Asset, or recomposition semantics.
 */
export function StageControlSections({
  plotSequence,
  presentation,
  ...controlPanelProps
}: StageControlSectionsProps) {
  if (plotSequence === undefined) {
    if (presentation !== undefined) {
      fail("a Stage presentation requires a Plot Sequence declaration");
    }
    return <ControlPanel {...controlPanelProps} />;
  }
  if (presentation === undefined) {
    fail("a Plot Sequence declaration requires a Stage presentation");
  }

  const projections = stageProjections(
    controlPanelProps.schema,
    plotSequence,
    presentation,
  );
  const sharedKeys = projections[0]!.shared.schemaKeys;

  return (
    <div className="flex flex-col gap-6">
      {sharedKeys.length > 0 ? (
        <ControlPanel {...controlPanelProps} orderedKeys={sharedKeys} />
      ) : null}
      {projections.map(({ stage, owned }) => (
        <section
          key={stage.id}
          aria-label={`${stage.name} controls`}
          data-stage-controls={stage.id}
          className="flex flex-col gap-4"
        >
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {stage.name}
          </h3>
          <ControlPanel
            {...controlPanelProps}
            orderedKeys={owned.schemaKeys}
          />
        </section>
      ))}
    </div>
  );
}
