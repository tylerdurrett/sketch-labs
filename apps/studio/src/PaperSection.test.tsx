// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STANDARD_PAPER_NAMES, type PlotProfile } from "@harness/core";

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
  initialProfile = profile,
): { el: HTMLDivElement; onChange: typeof onChange } {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <PaperSection profile={initialProfile} onChange={onChange} />,
    ),
  );
  return { el: container, onChange };
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function selectFormat(el: HTMLElement, value: string): void {
  const select = el.querySelector("select");
  if (select === null) throw new Error("no paper format select");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
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
    expect(el.querySelector("select")?.value).toBe("a2");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("derives the format and lists every supported standard plus Custom", () => {
    const { el } = mount();
    const select = el.querySelector("select");

    expect(select?.value).toBe("a4");
    expect(
      [...(select?.options ?? [])].map((option) => option.value),
    ).toEqual([...STANDARD_PAPER_NAMES, "custom"]);
  });

  it("applies a selected standard in the current orientation while preserving insets", () => {
    const onChange = vi.fn();
    const landscape: PlotProfile = { ...profile, width: 300, height: 200 };
    const { el } = mount(onChange, landscape);

    selectFormat(el, "a4");

    expect(onChange).toHaveBeenCalledWith({
      width: 297,
      height: 210,
      insets: profile.insets,
    });
  });

  it("treats Custom as a derived no-op that preserves the current dimensions", () => {
    const onChange = vi.fn();
    const { el } = mount(onChange);

    selectFormat(el, "custom");

    expect(onChange).not.toHaveBeenCalled();
    expect(profile).toMatchObject({ width: 210, height: 297 });
  });

  it("commits a valid dimension as one complete canonical profile", () => {
    const onChange = vi.fn();
    const { el } = mount(onChange);
    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;

    setInput(width, "220");

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({
      width: 220,
      height: 297,
      insets: profile.insets,
    });
    expect(el.querySelector('[role="alert"]')).toBeNull();

    // Once the owner accepts that controlled update, matching is re-derived
    // from the new dimensions rather than stored as separate format state.
    act(() => {
      root.render(
        <PaperSection
          profile={{ ...profile, width: 220 }}
          onChange={onChange}
        />,
      );
    });
    expect(el.querySelector("select")?.value).toBe("custom");
    expect(width.value).toBe("220");
  });

  it("converts inch input back to millimeters without rounding untouched fields", () => {
    window.localStorage.setItem(PAPER_DISPLAY_UNIT_STORAGE_KEY, "in");
    const onChange = vi.fn();
    const { el } = mount(onChange);
    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (in)"]',
    )!;

    setInput(width, "10");

    expect(onChange).toHaveBeenCalledWith({
      width: 254,
      height: 297,
      insets: profile.insets,
    });
  });

  it("keeps invalid transient text editable and rejects every invalid candidate atomically", () => {
    const onChange = vi.fn();
    const { el } = mount(onChange);
    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;

    setInput(width, "");
    const height = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper height (mm)"]',
    )!;
    setInput(height, "300");
    expect(onChange).not.toHaveBeenCalled();

    for (const invalid of ["0", "-1", "1e999", "20"]) {
      setInput(width, invalid);
      // Native number inputs sanitize a non-finite exponent to blank; both forms
      // stay editable invalid drafts and never reach the canonical profile.
      expect(width.value).toBe(invalid === "1e999" ? "" : invalid);
      expect(onChange).not.toHaveBeenCalled();
      expect(width.getAttribute("aria-invalid")).toBe("true");
      expect(el.querySelector('[role="alert"]')?.textContent).not.toBe("");
    }

    setInput(width, "220");
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({
      width: 220,
      height: 300,
      insets: profile.insets,
    });
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("rejects a standard whose dimensions would exhaust the existing insets", () => {
    const onChange = vi.fn();
    const tight: PlotProfile = {
      width: 200,
      height: 200,
      insets: { top: 80, right: 80, bottom: 80, left: 80 },
    };
    const { el } = mount(onChange, tight);

    selectFormat(el, "a5");

    expect(onChange).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "no drawable rectangle",
    );
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
