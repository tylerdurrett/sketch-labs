// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPOSITION_SCALE_RANGE_MAX_PERCENT,
  COMPOSITION_SCALE_RANGE_MIN_PERCENT,
  CompositionScaleControl,
  type CompositionScaleControlProps,
} from "./CompositionScaleControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: CompositionScaleControlProps): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<CompositionScaleControl {...props} />));
  return container;
}

function numericInput(el: HTMLElement): HTMLInputElement {
  return el.querySelector<HTMLInputElement>(
    'input[aria-label="Composition scale percentage"]',
  )!;
}

function rangeInput(el: HTMLElement): HTMLInputElement {
  return el.querySelector<HTMLInputElement>(
    'input[aria-label="Composition scale"]',
  )!;
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("CompositionScaleControl", () => {
  it("identifies 100% as the full-Composition fit size and Reset as recentering", () => {
    const el = mount({
      scalePercent: 100,
      onScalePercentChange: vi.fn(),
    });

    expect(numericInput(el).value).toBe("100");
    expect(rangeInput(el).value).toBe("100");
    expect(el.textContent).toContain(
      "100% uses the full-Composition fit size. Reset Frame recenters.",
    );
  });

  it("synchronizes direct range changes through its controlled owner", () => {
    const onScalePercentChange = vi.fn();

    function ControlledScale() {
      const [scalePercent, setScalePercent] = useState(100);
      return (
        <CompositionScaleControl
          scalePercent={scalePercent}
          onScalePercentChange={(next) => {
            onScalePercentChange(next);
            setScalePercent(next);
          }}
        />
      );
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<ControlledScale />));

    setInput(rangeInput(container), "175");

    expect(onScalePercentChange).toHaveBeenCalledWith(175);
    expect(rangeInput(container).value).toBe("175");
    expect(numericInput(container).value).toBe("175");
  });

  it.each([
    ["5", 5, COMPOSITION_SCALE_RANGE_MIN_PERCENT],
    ["725.5", 725.5, COMPOSITION_SCALE_RANGE_MAX_PERCENT],
  ])(
    "accepts typed percentage %s beyond the direct range without clamping",
    (typed, expected, rangeEndpoint) => {
      const onScalePercentChange = vi.fn();
      const onValidityChange = vi.fn();
      const el = mount({
        scalePercent: 100,
        onScalePercentChange,
        onValidityChange,
      });
      const input = numericInput(el);

      act(() => input.focus());
      setInput(input, typed);

      expect(onScalePercentChange).toHaveBeenCalledWith(expected);
      expect(input.value).toBe(typed);
      expect(input.getAttribute("aria-invalid")).toBeNull();

      act(() =>
        root!.render(
          <CompositionScaleControl
            scalePercent={expected}
            onScalePercentChange={onScalePercentChange}
            onValidityChange={onValidityChange}
          />,
        ),
      );

      expect(input.value).toBe(typed);
      expect(rangeInput(el).value).toBe(String(rangeEndpoint));
      expect(onValidityChange).toHaveBeenLastCalledWith(true);
    },
  );

  it.each(["", "0", "-25", "1e309"])(
    "keeps invalid draft %j local and reports invalidity",
    (draft) => {
      const onScalePercentChange = vi.fn();
      const onValidityChange = vi.fn();
      const el = mount({
        scalePercent: 100,
        onScalePercentChange,
        onValidityChange,
      });
      const input = numericInput(el);

      act(() => input.focus());
      setInput(input, draft);

      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(
        "finite positive",
      );
      expect(onScalePercentChange).not.toHaveBeenCalled();
      expect(onValidityChange).toHaveBeenLastCalledWith(false);
    },
  );

  it("preserves a focused partial draft across controlled rerenders, then restores the owner value on blur", () => {
    const onScalePercentChange = vi.fn();
    const onValidityChange = vi.fn();
    const el = mount({
      scalePercent: 100,
      onScalePercentChange,
      onValidityChange,
    });
    const input = numericInput(el);

    act(() => input.focus());
    setInput(input, "");
    act(() =>
      root!.render(
        <CompositionScaleControl
          scalePercent={180}
          onScalePercentChange={onScalePercentChange}
          onValidityChange={onValidityChange}
        />,
      ),
    );

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(rangeInput(el).value).toBe("180");

    act(() => input.blur());

    expect(input.value).toBe("180");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it("synchronizes an unfocused draft to controlled rerenders", () => {
    const onScalePercentChange = vi.fn();
    const el = mount({ scalePercent: 100, onScalePercentChange });

    act(() =>
      root!.render(
        <CompositionScaleControl
          scalePercent={62.5}
          onScalePercentChange={onScalePercentChange}
        />,
      ),
    );

    expect(numericInput(el).value).toBe("62.5");
    expect(rangeInput(el).value).toBe("62.5");
  });

  it("exposes bounded direct manipulation and accessible numeric validation", () => {
    const el = mount({
      scalePercent: 100,
      onScalePercentChange: vi.fn(),
    });
    const range = rangeInput(el);
    const input = numericInput(el);

    expect(range.min).toBe(String(COMPOSITION_SCALE_RANGE_MIN_PERCENT));
    expect(range.max).toBe(String(COMPOSITION_SCALE_RANGE_MAX_PERCENT));
    expect(range.getAttribute("aria-describedby")).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBeTruthy();

    act(() => input.focus());
    setInput(input, "");

    const alert = el.querySelector<HTMLElement>('[role="alert"]')!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(
      alert.id,
    );
  });
});
