import { useEffect, useId, useRef, useState } from "react";

import {
  applyStandardPaper,
  derivePaperOrientation,
  inchToMm,
  matchStandardPaper,
  mmToInch,
  STANDARD_PAPER_NAMES,
  swapPlotOrientation,
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
type PaperErrorTarget = "format" | "orientation" | "margin" | PaperDimension;

interface PaperError {
  target: PaperErrorTarget;
  message: string;
}

function paperName(name: StandardPaperName): string {
  return name.startsWith("a")
    ? name.toUpperCase()
    : `${name[0]!.toUpperCase()}${name.slice(1)}`;
}

function linkedInset(profile: PlotProfile): number | null {
  const { top, right, bottom, left } = profile.insets;
  return top === right && right === bottom && bottom === left ? top : null;
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
  const [marginDraft, setMarginDraft] = useState(() => {
    const inset = linkedInset(profile);
    return inset === null ? "" : formatDimension(inset, displayUnit);
  });
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
    const inset = linkedInset(profile);
    setMarginDraft(
      inset === null ? "" : formatDimension(inset, displayUnit),
    );
    dirtyDimensions.current.clear();
    setError(null);
  }, [
    displayUnit,
    profile.height,
    profile.insets.bottom,
    profile.insets.left,
    profile.insets.right,
    profile.insets.top,
    profile.width,
  ]);

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
        target !== "width" && target !== "height"
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

  const swapOrientation = (): void => {
    commitCandidate(swapPlotOrientation(profile), "orientation");
  };

  const editMargin = (draft: string): void => {
    setMarginDraft(draft);
    if (draft.trim() === "") {
      setError({ target: "margin", message: "Margin is required." });
      return;
    }

    const displayValue = Number(draft);
    const millimeters =
      displayUnit === "in" ? inchToMm(displayValue) : displayValue;
    commitCandidate(
      {
        ...profile,
        insets: {
          top: millimeters,
          right: millimeters,
          bottom: millimeters,
          left: millimeters,
        },
      },
      "margin",
    );
  };

  const dimensions = `${formatDimension(profile.width, displayUnit)} × ${formatDimension(profile.height, displayUnit)} ${displayUnit}`;
  const format = matchStandardPaper(profile) ?? "custom";
  const isExactSquare = profile.width === profile.height;
  const errorId = `${id}-error`;

  return (
    <details className="min-w-0 rounded-lg border border-border bg-card px-3 py-2">
      <summary className="flex min-w-0 cursor-pointer items-center justify-between gap-3 text-sm font-medium">
        <span>Paper</span>
        <span className="min-w-0 text-muted-foreground tabular-nums">
          {dimensions}
        </span>
      </summary>
      <div className="mt-3 min-w-0 space-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <label
            className="min-w-16 text-sm text-muted-foreground"
            htmlFor={`${id}-format`}
          >
            format
          </label>
          <select
            id={`${id}-format`}
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
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
        <fieldset className="flex min-w-0 items-center gap-3 border-0 p-0">
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
        <fieldset className="grid min-w-0 grid-cols-2 gap-3 border-0 p-0">
          <legend className="sr-only">Custom paper dimensions</legend>
          {(["width", "height"] as const).map((dimension) => (
            <label key={dimension} className="grid min-w-0 gap-1 text-sm">
              <span className="text-muted-foreground">{dimension}</span>
              <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
                <input
                  className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-right tabular-nums"
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
        <div className="flex min-w-0 items-center gap-3">
          <span className="min-w-16 text-sm text-muted-foreground">
            orientation
          </span>
          <button
            type="button"
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
            disabled={isExactSquare}
            aria-invalid={error?.target === "orientation"}
            aria-describedby={
              error?.target === "orientation" ? errorId : undefined
            }
            onClick={isExactSquare ? undefined : swapOrientation}
          >
            {isExactSquare
              ? "Square"
              : `Swap to ${derivePaperOrientation(profile) === "portrait" ? "landscape" : "portrait"}`}
          </button>
        </div>
        <label className="grid min-w-0 gap-1 text-sm">
          <span className="text-muted-foreground">linked margin</span>
          <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
            <input
              className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-right tabular-nums"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={marginDraft}
              placeholder={linkedInset(profile) === null ? "mixed" : undefined}
              aria-label={`Linked paper margin (${displayUnit})`}
              aria-invalid={error?.target === "margin"}
              aria-describedby={
                error?.target === "margin" ? errorId : undefined
              }
              onChange={(event) => editMargin(event.target.value)}
            />
            <span aria-hidden className="text-muted-foreground">
              {displayUnit}
            </span>
          </span>
        </label>
        <label className="flex min-w-0 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={profile.includeFrame}
            onChange={(event) =>
              onChange({ ...profile, includeFrame: event.target.checked })
            }
          />
          <span>Include composition frame</span>
        </label>
        {error === null ? null : (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}
      </div>
    </details>
  );
}
