import { useEffect, useId, useRef, useState } from "react";

import {
  applyStandardPaper,
  derivePaperOrientation,
  inchToMm,
  matchStandardPaper,
  mmToInch,
  STANDARD_PAPER_NAMES,
  validatePlotProfile,
  type PlotProfile,
  type StandardPaperName,
} from "@harness/core";

/** The Studio-local preference key. Display units are never Plot Profile state. */
export const PAPER_DISPLAY_UNIT_STORAGE_KEY =
  "sketch-labs.paper-display-unit";

export type PaperDisplayUnit = "mm" | "in";

export interface PaperSectionProps {
  /** The authoritative, millimeter-canonical Plot Profile owned by Studio. */
  profile: PlotProfile;
  /** Commit a canonical Plot Profile edit to the owning Studio session. */
  onChange: (profile: PlotProfile) => void;
}

/** Read the presentation-only unit preference without assuming storage is usable. */
function readDisplayUnit(): PaperDisplayUnit {
  if (typeof window === "undefined") return "mm";

  try {
    const stored = window.localStorage.getItem(PAPER_DISPLAY_UNIT_STORAGE_KEY);
    return stored === "mm" || stored === "in" ? stored : "mm";
  } catch {
    return "mm";
  }
}

/** Persist the presentation-only unit preference when browser storage permits it. */
function writeDisplayUnit(unit: PaperDisplayUnit): void {
  try {
    window.localStorage.setItem(PAPER_DISPLAY_UNIT_STORAGE_KEY, unit);
  } catch {
    // Storage can be unavailable (privacy mode, denied access, quota). The
    // in-memory preference still works for this Studio session.
  }
}

/** Keep dimension summaries compact while preserving useful custom-size precision. */
function formatDimension(value: number, unit: PaperDisplayUnit): string {
  const displayed = unit === "in" ? mmToInch(value) : value;
  return String(Number(displayed.toFixed(unit === "in" ? 3 : 2)));
}

type PaperDimension = "width" | "height";
type PaperErrorTarget = "format" | PaperDimension;

interface PaperError {
  target: PaperErrorTarget;
  message: string;
}

function paperName(name: StandardPaperName): string {
  return name.startsWith("a")
    ? name.toUpperCase()
    : `${name[0]!.toUpperCase()}${name.slice(1)}`;
}

/**
 * The controlled Paper inspector boundary.
 *
 * The native disclosure is collapsed by default and keeps the active dimensions
 * visible in its summary. Display units are deliberately local presentation
 * state: changing them never rewrites the canonical millimeter profile and never
 * calls {@link PaperSectionProps.onChange}. Dimension edits convert back to
 * millimeters and validate a complete candidate before committing it atomically.
 */
export function PaperSection({ profile, onChange }: PaperSectionProps) {
  const [displayUnit, setDisplayUnit] =
    useState<PaperDisplayUnit>(readDisplayUnit);
  const [dimensionDrafts, setDimensionDrafts] = useState(() => ({
    width: formatDimension(profile.width, displayUnit),
    height: formatDimension(profile.height, displayUnit),
  }));
  const [error, setError] = useState<PaperError | null>(null);
  const dirtyDimensions = useRef<Set<PaperDimension>>(new Set());
  const id = useId();

  useEffect(() => {
    writeDisplayUnit(displayUnit);
  }, [displayUnit]);

  // A controlled profile update (including a Preset reload) or a presentation-
  // unit change replaces the drafts from the canonical model. Invalid partial
  // text otherwise remains editable because it does not change these dependencies.
  useEffect(() => {
    setDimensionDrafts({
      width: formatDimension(profile.width, displayUnit),
      height: formatDimension(profile.height, displayUnit),
    });
    dirtyDimensions.current.clear();
    setError(null);
  }, [displayUnit, profile.height, profile.width]);

  const commitCandidate = (
    candidate: PlotProfile,
    target: PaperErrorTarget,
  ): void => {
    try {
      validatePlotProfile(candidate);
      setError(null);
      onChange(candidate);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Invalid paper dimensions";
      // Dimension edits can accumulate as transient drafts, so validation may
      // identify the OTHER dirty dimension. Core's messages name the affected
      // axis; format changes remain owned by the select as a single operation.
      const resolvedTarget =
        target === "format"
          ? target
          : message.includes("width") || message.includes("horizontal")
            ? "width"
            : message.includes("height") || message.includes("vertical")
              ? "height"
              : target;
      setError({ target: resolvedTarget, message });
    }
  };

  const editDimension = (dimension: PaperDimension, draft: string): void => {
    const nextDrafts = { ...dimensionDrafts, [dimension]: draft };
    setDimensionDrafts(nextDrafts);
    dirtyDimensions.current.add(dimension);

    // Validate and commit ALL fields the artist has touched as one profile. An
    // untouched field keeps its exact canonical value (important in inch mode,
    // where its displayed text is rounded); a dirty invalid sibling prevents a
    // partial commit until the whole authored candidate becomes valid.
    const candidate = { ...profile };
    for (const dirty of dirtyDimensions.current) {
      const dirtyDraft = nextDrafts[dirty];
      if (dirtyDraft.trim() === "") {
        setError({
          target: dirty,
          message: `${dirty[0]!.toUpperCase()}${dirty.slice(1)} is required.`,
        });
        return;
      }

      const displayValue = Number(dirtyDraft);
      candidate[dirty] =
        displayUnit === "in" ? inchToMm(displayValue) : displayValue;
    }
    commitCandidate(candidate, dimension);
  };

  const selectFormat = (value: string): void => {
    if (value === "custom") return;

    const name = value as StandardPaperName;
    commitCandidate(
      applyStandardPaper(profile, name, derivePaperOrientation(profile)),
      "format",
    );
  };

  const dimensions = `${formatDimension(profile.width, displayUnit)} × ${formatDimension(profile.height, displayUnit)} ${displayUnit}`;
  const format = matchStandardPaper(profile) ?? "custom";
  const errorId = `${id}-error`;

  return (
    <details className="rounded-lg border border-border bg-card px-3 py-2">
      <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium">
        <span>Paper</span>
        <span className="text-muted-foreground tabular-nums">{dimensions}</span>
      </summary>
      <div className="mt-3 space-y-3">
        <div className="flex items-center gap-3">
          <label
            className="min-w-16 text-sm text-muted-foreground"
            htmlFor={`${id}-format`}
          >
            format
          </label>
          <select
            id={`${id}-format`}
            className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
            value={format}
            aria-invalid={error?.target === "format"}
            aria-describedby={error?.target === "format" ? errorId : undefined}
            onChange={(event) => selectFormat(event.target.value)}
          >
            {STANDARD_PAPER_NAMES.map((name) => (
              <option key={name} value={name}>
                {paperName(name)}
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
        </div>
        <fieldset className="flex items-center gap-3 border-0 p-0">
          <legend className="sr-only">Paper display units</legend>
          <span aria-hidden className="min-w-16 text-sm text-muted-foreground">
            units
          </span>
          {(["mm", "in"] as const).map((unit) => (
            <label key={unit} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name={`${id}-paper-display-unit`}
                value={unit}
                checked={displayUnit === unit}
                onChange={() => setDisplayUnit(unit)}
              />
              {unit}
            </label>
          ))}
        </fieldset>
        <fieldset className="grid grid-cols-2 gap-3 border-0 p-0">
          <legend className="sr-only">Custom paper dimensions</legend>
          {(["width", "height"] as const).map((dimension) => (
            <label key={dimension} className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{dimension}</span>
              <span className="flex items-center gap-1.5">
                <input
                  className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-right tabular-nums"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={dimensionDrafts[dimension]}
                  aria-label={`Paper ${dimension} (${displayUnit})`}
                  aria-invalid={error?.target === dimension}
                  aria-describedby={
                    error?.target === dimension ? errorId : undefined
                  }
                  onChange={(event) =>
                    editDimension(dimension, event.target.value)
                  }
                />
                <span aria-hidden className="text-muted-foreground">
                  {displayUnit}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {error === null ? null : (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}
      </div>
    </details>
  );
}
