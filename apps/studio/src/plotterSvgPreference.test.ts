// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PLOTTER_SVG_INCLUDE_PAPER_MARGINS_STORAGE_KEY,
  readPlotterSvgIncludePaperMargins,
  writePlotterSvgIncludePaperMargins,
} from "./plotterSvgPreference";

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("plotter SVG paper-margin preference", () => {
  it.each([
    [null, true],
    ["", true],
    ["TRUE", true],
    ["0", true],
    ["true", true],
    ["false", false],
  ] as const)("restores %s as %s", (stored, expected) => {
    if (stored !== null) {
      window.localStorage.setItem(
        PLOTTER_SVG_INCLUDE_PAPER_MARGINS_STORAGE_KEY,
        stored,
      );
    }

    expect(readPlotterSvgIncludePaperMargins()).toBe(expected);
  });

  it.each([true, false])("persists %s as its exact boolean string", (value) => {
    writePlotterSvgIncludePaperMargins(value);

    expect(
      window.localStorage.getItem(
        PLOTTER_SVG_INCLUDE_PAPER_MARGINS_STORAGE_KEY,
      ),
    ).toBe(String(value));
  });

  it("defaults to included when reading local storage fails", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(readPlotterSvgIncludePaperMargins()).toBe(true);
  });

  it("swallows local-storage write failures", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => writePlotterSvgIncludePaperMargins(false)).not.toThrow();
  });
});
