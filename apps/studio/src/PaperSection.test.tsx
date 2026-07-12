// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HARNESS_FALLBACK_PLOT_PROFILE,
  STANDARD_PAPER_NAMES,
  type PlotProfile,
} from "@harness/core";

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
  includeFrame: false,
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
      <PaperSection
        profile={initialProfile}
        onChange={onChange}
        includePaperMargins
        onIncludePaperMarginsChange={() => {}}
      />,
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

function clickButton(el: HTMLElement, label: string): void {
  const button = [...el.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no button labelled ${label}`);
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function selectUnit(el: HTMLElement, unit: "mm" | "in"): void {
  const input = el.querySelector<HTMLInputElement>(`input[value="${unit}"]`);
  if (input === null) throw new Error(`no ${unit} unit input`);
  act(() => input.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function frameCheckbox(el: HTMLElement): HTMLInputElement {
  const input = [
    ...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].find((candidate) =>
    candidate.labels?.[0]?.textContent?.includes("Include composition frame"),
  );
  if (input === undefined) throw new Error("no composition frame checkbox");
  return input;
}

function paperMarginsCheckbox(el: HTMLElement): HTMLInputElement {
  const input = [
    ...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].find((candidate) =>
    candidate.labels?.[0]?.textContent?.includes(
      "Include paper margins in plotter SVG",
    ),
  );
  if (input === undefined) throw new Error("no plotter SVG margins checkbox");
  return input;
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
  it.each([
    [true, false],
    [false, true],
  ] as const)(
    "emits the controlled plotter SVG margin choice from %s to %s without changing the profile",
    (includePaperMargins, expected) => {
      const onChange = vi.fn();
      const onIncludePaperMarginsChange = vi.fn();
      const before = structuredClone(profile);
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      act(() =>
        root.render(
          <PaperSection
            profile={profile}
            onChange={onChange}
            includePaperMargins={includePaperMargins}
            onIncludePaperMarginsChange={onIncludePaperMarginsChange}
          />,
        ),
      );

      act(() =>
        paperMarginsCheckbox(container).dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        ),
      );

      expect(onIncludePaperMarginsChange).toHaveBeenCalledOnce();
      expect(onIncludePaperMarginsChange).toHaveBeenCalledWith(expected);
      expect(onChange).not.toHaveBeenCalled();
      expect(profile).toEqual(before);
    },
  );

  it("reflects controlled plotter SVG margin updates without emitting them", () => {
    const onChange = vi.fn();
    const onIncludePaperMarginsChange = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <PaperSection
          profile={profile}
          onChange={onChange}
          includePaperMargins={false}
          onIncludePaperMarginsChange={onIncludePaperMarginsChange}
        />,
      ),
    );
    expect(paperMarginsCheckbox(container).checked).toBe(false);

    act(() =>
      root.render(
        <PaperSection
          profile={profile}
          onChange={onChange}
          includePaperMargins={true}
          onIncludePaperMarginsChange={onIncludePaperMarginsChange}
        />,
      ),
    );

    expect(paperMarginsCheckbox(container).checked).toBe(true);
    expect(onIncludePaperMarginsChange).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

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
          includePaperMargins
          onIncludePaperMarginsChange={() => {}}
        />,
      );
    });

    expect(el.querySelector("summary")?.textContent).toContain("420 × 594 mm");
    expect(el.querySelector("select")?.value).toBe("a2");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the fallback profile's default-on composition frame option", () => {
    const { el } = mount(vi.fn(), HARNESS_FALLBACK_PLOT_PROFILE);

    expect(frameCheckbox(el).checked).toBe(true);
  });

  it.each([
    [true, false],
    [false, true],
  ] as const)(
    "changes only includeFrame from %s to %s and emits the complete profile",
    (includeFrame, expected) => {
      const onChange = vi.fn();
      const controlled = { ...profile, includeFrame };
      const { el } = mount(onChange, controlled);

      act(() =>
        frameCheckbox(el).dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        ),
      );

      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledWith({
        ...controlled,
        includeFrame: expected,
      });
    },
  );

  it("reloads the composition frame option from the controlled profile", () => {
    const onChange = vi.fn();
    const { el } = mount(onChange, { ...profile, includeFrame: true });

    expect(frameCheckbox(el).checked).toBe(true);
    act(() => {
      root.render(
        <PaperSection
          profile={{ ...profile, includeFrame: false }}
          onChange={onChange}
          includePaperMargins
          onIncludePaperMarginsChange={() => {}}
        />,
      );
    });

    expect(frameCheckbox(el).checked).toBe(false);
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

  it("derives the Harness fallback as Square with no orientation action", () => {
    const onChange = vi.fn();
    const { el } = mount(onChange, HARNESS_FALLBACK_PLOT_PROFILE);
    const button = [...el.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Square",
    );

    expect(el.querySelector("select")?.value).toBe("square");
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    act(() =>
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ["custom", { width: 260, height: 260 }],
    ["portrait", { width: 210, height: 297 }],
    ["landscape", { width: 297, height: 210 }],
  ] as const)(
    "selects Square from a %s profile, preserving insets and disabling orientation after acceptance",
    (_source, dimensions) => {
      const onChange = vi.fn();
      const initialProfile: PlotProfile = {
        ...dimensions,
        insets: { top: 1, right: 2, bottom: 3, left: 4 },
        includeFrame: false,
      };
      const { el } = mount(onChange, initialProfile);

      selectFormat(el, "square");

      const accepted: PlotProfile = {
        width: 200,
        height: 200,
        insets: initialProfile.insets,
        includeFrame: false,
      };
      expect(onChange).toHaveBeenCalledWith(accepted);

      act(() => {
        root.render(
          <PaperSection
            profile={accepted}
            onChange={onChange}
            includePaperMargins
            onIncludePaperMarginsChange={() => {}}
          />,
        );
      });
      const orientation = [...el.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Square",
      );
      expect(el.querySelector("select")?.value).toBe("square");
      expect((orientation as HTMLButtonElement).disabled).toBe(true);
    },
  );

  it("applies a selected standard in the current orientation while preserving insets", () => {
    const onChange = vi.fn();
    const landscape: PlotProfile = { ...profile, width: 300, height: 200 };
    const { el } = mount(onChange, landscape);

    selectFormat(el, "a4");

    expect(onChange).toHaveBeenCalledWith({
      width: 297,
      height: 210,
      insets: profile.insets,
      includeFrame: false,
    });
  });

  it("treats Custom as a derived no-op that preserves the current dimensions", () => {
    const onChange = vi.fn();
    const { el } = mount(onChange);

    selectFormat(el, "custom");

    expect(onChange).not.toHaveBeenCalled();
    expect(profile).toMatchObject({ width: 210, height: 297 });
  });

  it("leaves an invalid draft and its error untouched when Custom is chosen", () => {
    const onChange = vi.fn();
    const { el } = mount(onChange);
    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;

    setInput(width, "");
    const message = el.querySelector('[role="alert"]')?.textContent;
    selectFormat(el, "custom");

    expect(width.value).toBe("");
    expect(width.getAttribute("aria-invalid")).toBe("true");
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(onChange).not.toHaveBeenCalled();
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
      includeFrame: false,
    });
    expect(el.querySelector('[role="alert"]')).toBeNull();

    // Once the owner accepts that controlled update, matching is re-derived
    // from the new dimensions rather than stored as separate format state.
    act(() => {
      root.render(
        <PaperSection
          profile={{ ...profile, width: 220 }}
          onChange={onChange}
          includePaperMargins
          onIncludePaperMarginsChange={() => {}}
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
      includeFrame: false,
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
    expect(width.getAttribute("aria-invalid")).toBe("true");
    expect(width.getAttribute("aria-describedby")).not.toBeNull();
    expect(height.getAttribute("aria-invalid")).toBe("false");
    expect(height.getAttribute("aria-describedby")).toBeNull();
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
      includeFrame: false,
    });
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("rejects a standard whose dimensions would exhaust the existing insets", () => {
    const onChange = vi.fn();
    const tight: PlotProfile = {
      width: 200,
      height: 200,
      insets: { top: 80, right: 80, bottom: 80, left: 80 },
      includeFrame: false,
    };
    const { el } = mount(onChange, tight);

    selectFormat(el, "a5");

    expect(onChange).not.toHaveBeenCalled();
    const error = el.querySelector('[role="alert"]');
    const select = el.querySelector("select")!;
    expect(error?.textContent).toContain(
      "no drawable rectangle",
    );
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(select.getAttribute("aria-describedby")).toBe(error?.id);
    for (const input of el.querySelectorAll('input[type="number"]')) {
      expect(input.getAttribute("aria-invalid")).toBe("false");
      expect(input.getAttribute("aria-describedby")).toBeNull();
    }
  });

  it("swaps only width and height while preserving every inset", () => {
    const onChange = vi.fn();
    const asymmetric: PlotProfile = {
      ...profile,
      insets: { top: 1, right: 2, bottom: 3, left: 4 },
    };
    const { el } = mount(onChange, asymmetric);

    clickButton(el, "Swap to landscape");

    expect(onChange).toHaveBeenCalledWith({
      width: 297,
      height: 210,
      insets: asymmetric.insets,
      includeFrame: false,
    });
  });

  it("keeps a tolerant near-square match swappable while labeling it Square", () => {
    const onChange = vi.fn();
    const nearSquare: PlotProfile = {
      width: 200.2,
      height: 199.8,
      insets: { top: 1, right: 2, bottom: 3, left: 4 },
      includeFrame: false,
    };
    const { el } = mount(onChange, nearSquare);
    const button = [...el.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Swap to portrait",
    );

    expect(el.querySelector("select")?.value).toBe("square");
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    clickButton(el, "Swap to portrait");
    expect(onChange).toHaveBeenCalledWith({
      width: 199.8,
      height: 200.2,
      insets: nearSquare.insets,
      includeFrame: false,
    });
  });

  it("rejects an invalid orientation swap and targets the action accessibly", () => {
    const onChange = vi.fn();
    const swapWouldExhaust: PlotProfile = {
      width: 300,
      height: 100,
      insets: { top: 10, right: 110, bottom: 10, left: 110 },
      includeFrame: false,
    };
    const { el } = mount(onChange, swapWouldExhaust);
    const button = [...el.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Swap to portrait"),
    )!;

    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const alert = el.querySelector<HTMLElement>('[role="alert"]')!;
    expect(onChange).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-invalid")).toBe("true");
    expect(button.getAttribute("aria-describedby")).toBe(alert.id);
    for (const input of el.querySelectorAll('input[type="number"]')) {
      expect(input.getAttribute("aria-invalid")).toBe("false");
      expect(input.getAttribute("aria-describedby")).toBeNull();
    }
  });

  it("writes one linked margin edit to all four canonical insets", () => {
    const onChange = vi.fn();
    const { el } = mount(onChange);
    const margin = el.querySelector<HTMLInputElement>(
      'input[aria-label="Linked paper margin (mm)"]',
    )!;

    expect(margin.value).toBe("10");
    setInput(margin, "12");

    expect(onChange).toHaveBeenCalledWith({
      ...profile,
      insets: { top: 12, right: 12, bottom: 12, left: 12 },
    });
  });

  it("converts a linked inch margin to canonical millimeters", () => {
    window.localStorage.setItem(PAPER_DISPLAY_UNIT_STORAGE_KEY, "in");
    const onChange = vi.fn();
    const { el } = mount(onChange);
    const margin = el.querySelector<HTMLInputElement>(
      'input[aria-label="Linked paper margin (in)"]',
    )!;

    setInput(margin, "1");

    expect(onChange).toHaveBeenCalledWith({
      ...profile,
      insets: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 },
    });
  });

  it("shows an asymmetric profile as mixed until an explicit edit links it", () => {
    const onChange = vi.fn();
    const asymmetric: PlotProfile = {
      ...profile,
      insets: { top: 1, right: 2, bottom: 3, left: 4 },
    };
    const { el } = mount(onChange, asymmetric);
    const margin = el.querySelector<HTMLInputElement>(
      'input[aria-label="Linked paper margin (mm)"]',
    )!;

    expect(margin.value).toBe("");
    expect(margin.placeholder).toBe("mixed");
    expect(el.querySelector('[role="alert"]')).toBeNull();

    setInput(margin, "5");
    expect(onChange).toHaveBeenCalledWith({
      ...asymmetric,
      insets: { top: 5, right: 5, bottom: 5, left: 5 },
    });
  });

  it("rejects invalid linked margins without clamping and targets only the margin input", () => {
    const onChange = vi.fn();
    const { el } = mount(onChange);
    const margin = el.querySelector<HTMLInputElement>(
      'input[aria-label="Linked paper margin (mm)"]',
    )!;

    for (const invalid of ["-1", "1e999", "105"]) {
      setInput(margin, invalid);
      expect(margin.value).toBe(invalid === "1e999" ? "" : invalid);
      expect(onChange).not.toHaveBeenCalled();
      const alert = el.querySelector<HTMLElement>('[role="alert"]')!;
      expect(margin.getAttribute("aria-invalid")).toBe("true");
      expect(margin.getAttribute("aria-describedby")).toBe(alert.id);
      for (const input of el.querySelectorAll(
        'input[aria-label^="Paper "]',
      )) {
        expect(input.getAttribute("aria-invalid")).toBe("false");
      }
    }

    setInput(margin, "0");
    expect(onChange).toHaveBeenCalledWith({
      ...profile,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    expect(el.querySelector('[role="alert"]')).toBeNull();
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

  it("preserves a disabled composition frame through Paper edits", () => {
    const onChange = vi.fn();
    const { el } = mount(onChange);
    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;
    const margin = el.querySelector<HTMLInputElement>(
      'input[aria-label="Linked paper margin (mm)"]',
    )!;

    selectFormat(el, "a3");
    setInput(width, "220");
    clickButton(el, "Swap to landscape");
    setInput(margin, "12");
    selectUnit(el, "in");

    expect(onChange).toHaveBeenCalledTimes(4);
    for (const [emitted] of onChange.mock.calls) {
      expect(emitted).toMatchObject({ includeFrame: false });
    }
    expect(frameCheckbox(el).checked).toBe(false);
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
