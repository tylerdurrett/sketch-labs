import type { ScribbleDiagnostics, ScribbleProgress } from "@harness/core";

import type { RollingEtaEstimate } from "./rollingEta";

/** Final metrics and provenance for the geometry currently retained on screen. */
export interface DisplayedShadingDiagnostics {
  readonly freshness: "current" | "stale";
  readonly diagnostics: ScribbleDiagnostics;
  readonly computeTimeMs: number;
}

/** Observational state for the current worker job, kept separate from its inputs. */
export type ShadingPreparationDiagnostics =
  | { readonly kind: "idle" }
  | {
      readonly kind: "preparing";
      readonly progress: ScribbleProgress | null;
      readonly eta: RollingEtaEstimate;
    }
  | { readonly kind: "failure"; readonly message: string };

export interface ShadingDiagnosticsProps {
  /** The last complete result, which may intentionally remain visible while stale. */
  readonly displayed: DisplayedShadingDiagnostics | null;
  /** The current replacement job only; it never supplies final-result metrics. */
  readonly preparation: ShadingPreparationDiagnostics;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  const roundedSeconds = Math.round(milliseconds / 1_000);
  if (roundedSeconds < 60) return `${(milliseconds / 1_000).toFixed(1)} s`;

  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

function formatPathLength(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} units`;
}

function progressPercent(progress: ScribbleProgress): number {
  if (progress.totalWorkUnits === 0) return progress.terminal ? 100 : 0;
  return Math.min(
    100,
    Math.max(0, (progress.completedWorkUnits / progress.totalWorkUnits) * 100),
  );
}

function ProgressSummary({
  progress,
}: {
  readonly progress: ScribbleProgress | null;
}) {
  if (progress === null) return <>Preparing</>;
  if (progress.terminal) return <>Preparation complete</>;
  return <>Preparing {Math.round(progressPercent(progress))}%</>;
}

function SummaryStatuses({ displayed, preparation }: ShadingDiagnosticsProps) {
  return (
    <span className="flex min-w-0 flex-wrap justify-end gap-1.5 text-xs">
      {displayed?.freshness === "stale" ? (
        <span
          role="status"
          className="rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-amber-200"
        >
          Displayed result: stale
        </span>
      ) : displayed?.diagnostics.termination === "completed" ? (
        <span
          role="status"
          className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-emerald-200"
        >
          Current result: converged
        </span>
      ) : null}

      {displayed?.diagnostics.termination === "budget-exhausted" ? (
        <span
          role="status"
          className="rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-amber-200"
        >
          {displayed.freshness === "current"
            ? "Current result: budget exhausted"
            : "Displayed result: budget exhausted"}
        </span>
      ) : null}

      {preparation.kind === "preparing" ? (
        <span
          role={preparation.progress?.terminal === true ? "status" : undefined}
          className="rounded-full border border-border bg-muted px-2 py-0.5 text-muted-foreground"
        >
          <ProgressSummary progress={preparation.progress} />
        </span>
      ) : preparation.kind === "failure" ? (
        <span
          role="status"
          className="rounded-full border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-destructive"
        >
          Preparation failed
        </span>
      ) : null}
    </span>
  );
}

function Metric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  );
}

function DisplayedLane({
  displayed,
}: {
  readonly displayed: DisplayedShadingDiagnostics;
}) {
  const { diagnostics } = displayed;
  const laneName =
    displayed.freshness === "stale"
      ? "Displayed result (stale)"
      : "Displayed result";

  return (
    <section aria-label={laneName} className="min-w-0 space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {laneName}
      </h3>
      {diagnostics.termination === "budget-exhausted" ? (
        <p
          role="status"
          className="rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200"
        >
          The safety budget was exhausted. This is a bounded partial result, not
          a computation error.
        </p>
      ) : null}
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
        <Metric
          label="Termination"
          value={
            diagnostics.termination === "completed"
              ? "Converged"
              : "Budget exhausted"
          }
        />
        <Metric
          label="Residual error"
          value={formatPercent(diagnostics.residualError)}
        />
        <Metric
          label="Compute time"
          value={formatDuration(displayed.computeTimeMs)}
        />
        <Metric
          label="Path length"
          value={formatPathLength(diagnostics.pathLength)}
        />
        <Metric
          label="Polylines"
          value={diagnostics.polylineCount.toLocaleString()}
        />
        <Metric
          label="Pen lifts"
          value={diagnostics.penLiftCount.toLocaleString()}
        />
      </dl>
    </section>
  );
}

function PreparingLane({
  preparation,
  replacing,
}: {
  readonly preparation: Extract<
    ShadingPreparationDiagnostics,
    { kind: "preparing" }
  >;
  readonly replacing: boolean;
}) {
  const { progress, eta } = preparation;
  const complete = progress?.terminal === true;
  const laneName = complete
    ? replacing
      ? "Replacement prepared"
      : "Result prepared"
    : replacing
      ? "Preparing replacement"
      : "Preparing result";

  return (
    <section
      aria-label={laneName}
      aria-busy={!complete}
      className="min-w-0 space-y-2"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {laneName}
      </h3>
      {progress === null ? (
        <p className="text-xs text-muted-foreground">
          Waiting for worker progress.
        </p>
      ) : (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-muted-foreground">
              {complete ? "Work budget used" : "Progress"}
            </span>
            <span className="tabular-nums">
              {Math.round(progressPercent(progress))}% (
              {progress.completedWorkUnits.toLocaleString()} of{" "}
              {progress.totalWorkUnits.toLocaleString()} work units)
            </span>
          </div>
          <progress
            aria-label={
              complete ? `${laneName} work budget used` : `${laneName} progress`
            }
            aria-valuetext={
              complete
                ? `Preparation complete; ${progress.completedWorkUnits.toLocaleString()} of ${progress.totalWorkUnits.toLocaleString()} work-budget units used`
                : `${Math.round(progressPercent(progress))}% complete`
            }
            className="block h-1.5 w-full accent-foreground"
            max={Math.max(1, progress.totalWorkUnits)}
            value={
              progress.totalWorkUnits === 0 && progress.terminal
                ? 1
                : progress.completedWorkUnits
            }
          />
        </div>
      )}
      {complete ? (
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="text-muted-foreground">Preparation status</span>
          <span>Complete</span>
        </div>
      ) : (
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="text-muted-foreground">
            Estimated time remaining
          </span>
          <span>
            {eta.kind === "estimating"
              ? "Estimating…"
              : formatDuration(eta.remainingMs)}
          </span>
        </div>
      )}
    </section>
  );
}

function FailureLane({
  message,
  replacing,
}: {
  readonly message: string;
  readonly replacing: boolean;
}) {
  const laneName = replacing ? "Replacement preparation" : "Result preparation";
  return (
    <section aria-label={laneName} className="min-w-0 space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {laneName}
      </h3>
      <p
        role="alert"
        className="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
      >
        <strong>Preparation failed:</strong> {message}
      </p>
    </section>
  );
}

/**
 * Compact, read-only diagnostics for complete Scribble geometry and its current
 * worker job. The disclosure starts collapsed; provenance stays explicit when
 * stale geometry is retained so its final metrics cannot be mistaken for the
 * replacement's observational progress.
 */
export function ShadingDiagnostics({
  displayed,
  preparation,
}: ShadingDiagnosticsProps) {
  const replacing = displayed?.freshness === "stale";

  return (
    <details className="min-w-0 rounded-lg border border-border bg-card px-3 py-2">
      <summary className="flex min-w-0 cursor-pointer items-center justify-between gap-3 text-sm font-medium">
        <span>Shading diagnostics</span>
        <SummaryStatuses displayed={displayed} preparation={preparation} />
      </summary>
      <div className="mt-3 min-w-0 space-y-3 border-t border-border pt-3">
        {displayed !== null ? <DisplayedLane displayed={displayed} /> : null}
        {preparation.kind === "preparing" ? (
          <PreparingLane preparation={preparation} replacing={replacing} />
        ) : preparation.kind === "failure" ? (
          <FailureLane message={preparation.message} replacing={replacing} />
        ) : displayed === null ? (
          <p className="text-xs text-muted-foreground">
            No shading result yet.
          </p>
        ) : null}
      </div>
    </details>
  );
}
