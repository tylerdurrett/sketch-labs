/** Studio-local preference for the physical plotter SVG document wrapper. */
export const PLOTTER_SVG_INCLUDE_PAPER_MARGINS_STORAGE_KEY =
  "sketch-labs.plotter-svg-include-paper-margins";

/**
 * Restore whether plotter SVGs include the full paper extent.
 *
 * Defaulting every unavailable or invalid value to `true` preserves the export
 * contract that predates this preference.
 */
export function readPlotterSvgIncludePaperMargins(): boolean {
  if (typeof window === "undefined") return true;

  try {
    const stored = window.localStorage.getItem(
      PLOTTER_SVG_INCLUDE_PAPER_MARGINS_STORAGE_KEY,
    );
    if (stored === "true") return true;
    if (stored === "false") return false;
    return true;
  } catch {
    return true;
  }
}

/** Persist the preference when browser storage is available. */
export function writePlotterSvgIncludePaperMargins(value: boolean): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      PLOTTER_SVG_INCLUDE_PAPER_MARGINS_STORAGE_KEY,
      String(value),
    );
  } catch {
    // Storage can be unavailable (privacy mode, denied access, quota). The
    // owning Studio session still keeps its in-memory preference.
  }
}
