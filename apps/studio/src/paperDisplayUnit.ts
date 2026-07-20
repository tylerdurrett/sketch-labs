import { mmToInch } from "@harness/core";

/** The Studio-local preference key. Display units are never Plot Profile state. */
export const PAPER_DISPLAY_UNIT_STORAGE_KEY = "sketch-labs.paper-display-unit";

export type PaperDisplayUnit = "mm" | "in";

/** Read the presentation-only unit preference without assuming storage is usable. */
export function readPaperDisplayUnit(): PaperDisplayUnit {
  if (typeof window === "undefined") return "mm";

  try {
    const stored = window.localStorage.getItem(PAPER_DISPLAY_UNIT_STORAGE_KEY);
    return stored === "mm" || stored === "in" ? stored : "mm";
  } catch {
    return "mm";
  }
}

/** Persist the presentation-only unit preference when browser storage permits it. */
export function writePaperDisplayUnit(unit: PaperDisplayUnit): void {
  try {
    window.localStorage.setItem(PAPER_DISPLAY_UNIT_STORAGE_KEY, unit);
  } catch {
    // Storage can be unavailable (privacy mode, denied access, quota). The
    // in-memory preference still works for this Studio session.
  }
}

/** Keep dimensions compact while preserving useful custom-size precision. */
export function formatPaperDimension(
  millimeters: number,
  unit: PaperDisplayUnit,
): string {
  const displayed = unit === "in" ? mmToInch(millimeters) : millimeters;
  return String(Number(displayed.toFixed(unit === "in" ? 3 : 2)));
}
