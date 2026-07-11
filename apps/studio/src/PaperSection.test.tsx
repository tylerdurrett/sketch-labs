// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlotProfile } from "@harness/core";

import {
  PAPER_DISPLAY_UNIT_STORAGE_KEY,
  PaperSection,
} from "./PaperSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const profile: PlotProfile = {
  width: 210,
  height: 297,
  insets: { top: 10, right: 10, bottom: 10, left: 10 },
};

let container: HTMLDivElement;
let root: Root;

function mount(
  onChange = vi.fn(),
): { el: HTMLDivElement; onChange: typeof onChange } {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<PaperSection profile={profile} onChange={onChange} />));
  return { el: container, onChange };
}

function selectUnit(el: HTMLElement, unit: "mm" | "in"): void {
  const input = el.querySelector<HTMLInputElement>(`input[value="${unit}"]`);
  if (input === null) throw new Error(`no ${unit} unit input`);
  act(() => input.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe("PaperSection", () => {
  it("is a native disclosure collapsed by default with active dimensions always in its summary", () => {
    const { el } = mount();
    const details = el.querySelector("details");
    const summary = el.querySelector("summary");

    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(summary?.textContent).toContain("Paper");
    expect(summary?.textContent).toContain("210 × 297 mm");
  });

  it("renders dimensions from the controlled profile prop", () => {
    const onChange = vi.fn();
    const { el } = mount(onChange);

    act(() => {
      root.render(
        <PaperSection
          profile={{ ...profile, width: 420, height: 594 }}
          onChange={onChange}
        />,
      );
    });

    expect(el.querySelector("summary")?.textContent).toContain("420 × 594 mm");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("falls back to millimeters when no valid local preference exists", () => {
    window.localStorage.setItem(PAPER_DISPLAY_UNIT_STORAGE_KEY, "cm");

    const { el } = mount();

    expect(el.querySelector("summary")?.textContent).toContain("210 × 297 mm");
    expect(
      el.querySelector<HTMLInputElement>('input[value="mm"]')?.checked,
    ).toBe(true);
  });

  it("restores inches from Studio local storage as presentation only", () => {
    window.localStorage.setItem(PAPER_DISPLAY_UNIT_STORAGE_KEY, "in");
    const onChange = vi.fn();

    const { el } = mount(onChange);

    expect(el.querySelector("summary")?.textContent).toContain(
      "8.268 × 11.693 in",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("persists a unit change without changing the controlled canonical profile", () => {
    const onChange = vi.fn();
    const before = structuredClone(profile);
    const { el } = mount(onChange);

    selectUnit(el, "in");

    expect(el.querySelector("summary")?.textContent).toContain(
      "8.268 × 11.693 in",
    );
    expect(window.localStorage.getItem(PAPER_DISPLAY_UNIT_STORAGE_KEY)).toBe("in");
    expect(onChange).not.toHaveBeenCalled();
    expect(profile).toEqual(before);
  });

  it("keeps working with the millimeter fallback when local storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    const { el } = mount();

    expect(el.querySelector("summary")?.textContent).toContain("210 × 297 mm");
    selectUnit(el, "in");
    expect(el.querySelector("summary")?.textContent).toContain(
      "8.268 × 11.693 in",
    );
  });
});
