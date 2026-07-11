import { useEffect, useState } from "react";

import { mmToInch, type PlotProfile } from "@harness/core";

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

/**
 * The controlled Paper inspector boundary.
 *
 * The native disclosure is collapsed by default and keeps the active dimensions
 * visible in its summary. Display units are deliberately local presentation
 * state: changing them never rewrites the canonical millimeter profile and never
 * calls {@link PaperSectionProps.onChange}. Later Paper authoring controls use
 * that callback only after converting edits back to canonical millimeters.
 */
export function PaperSection({ profile, onChange }: PaperSectionProps) {
  const [displayUnit, setDisplayUnit] =
    useState<PaperDisplayUnit>(readDisplayUnit);

  useEffect(() => {
    writeDisplayUnit(displayUnit);
  }, [displayUnit]);

  // This first block establishes the controlled authoring seam. Unit selection
  // is presentation-only, so profile edits (and therefore onChange calls) begin
  // with the format/dimension controls added by the next block.
  void onChange;

  const dimensions = `${formatDimension(profile.width, displayUnit)} × ${formatDimension(profile.height, displayUnit)} ${displayUnit}`;

  return (
    <details className="rounded-lg border border-border bg-card px-3 py-2">
      <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium">
        <span>Paper</span>
        <span className="text-muted-foreground tabular-nums">{dimensions}</span>
      </summary>
      <fieldset className="mt-3 flex items-center gap-3 border-0 p-0">
        <legend className="sr-only">Paper display units</legend>
        <span aria-hidden className="text-sm text-muted-foreground">
          units
        </span>
        {(["mm", "in"] as const).map((unit) => (
          <label key={unit} className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="paper-display-unit"
              value={unit}
              checked={displayUnit === unit}
              onChange={() => setDisplayUnit(unit)}
            />
            {unit}
          </label>
        ))}
      </fieldset>
    </details>
  );
}
