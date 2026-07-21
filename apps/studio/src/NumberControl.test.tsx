// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NumberParamSpec } from "@harness/core";

import {
  coerceToDomain,
  NumberControl,
  sliderPositionForValue,
  valueForSliderPosition,
} from "./NumberControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

const numberSpec = (over: Partial<NumberParamSpec> = {}): NumberParamSpec => ({
  kind: "number",
  min: 0,
  max: 100,
  default: 50,
  ...over,
});

describe("coerceToDomain", () => {
  it("clamps a value above max down to max", () => {
    expect(coerceToDomain(250, numberSpec({ min: 0, max: 100 }))).toBe(100);
  });

  it("clamps a value below min up to min", () => {
    expect(coerceToDomain(-30, numberSpec({ min: 10, max: 100 }))).toBe(10);
  });

  it("rounds to a whole number when integer is set", () => {
    expect(coerceToDomain(23.7, numberSpec({ integer: true }))).toBe(24);
  });

  it("preserves a fractional value when integer is not set", () => {
    expect(coerceToDomain(23.7, numberSpec())).toBe(23.7);
  });

  it("accepts an OFF-STEP value within bounds (step is UI-only, not snapped)", () => {
    // step: 10 is a UI drag hint; 23 is a legal, hand-entered value and must
    // pass through untouched (no snap to the 0/10/20/30 grid).
    expect(coerceToDomain(23, numberSpec({ step: 10 }))).toBe(23);
  });

  it("enforces integer on an off-step value (round, still no step snap)", () => {
    // integer rounds 23.4 -> 23; step: 10 must NOT then snap 23 -> 20.
    expect(coerceToDomain(23.4, numberSpec({ step: 10, integer: true }))).toBe(
      23,
    );
  });

  it("clamps THEN rounds at the boundary (round of a clamped max)", () => {
    expect(
      coerceToDomain(100.6, numberSpec({ max: 100, integer: true })),
    ).toBe(100);
  });
});

describe("logarithmic slider mapping", () => {
  it("gives each density decade equal slider travel without changing values", () => {
    const spec = numberSpec({
      min: 0.25,
      max: 400,
      default: 1,
      sliderScale: "logarithmic",
    });

    expect(sliderPositionForValue(0.25, spec)).toBeCloseTo(Math.log10(0.25), 12);
    expect(sliderPositionForValue(1, spec)).toBe(0);
    expect(sliderPositionForValue(10, spec)).toBe(1);
    expect(sliderPositionForValue(100, spec)).toBe(2);
    expect(valueForSliderPosition(Math.log10(400), spec)).toBeCloseTo(400, 12);
  });
});

describe("NumberControl markup", () => {
  it("renders TWO lines: a number input + lock, and a Slider, bound to one value", () => {
    const html = renderToStaticMarkup(
      <NumberControl
        paramKey="radius"
        spec={numberSpec({ min: 0, max: 100, step: 10 })}
        value={23}
        locked={false}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    // Top line: the free-entry number input. Bottom line: the shadcn Slider,
    // whose Base UI Thumb renders a native range input. Both present == two lines.
    expect(html).toContain('type="number"');
    expect(html).toContain('type="range"');
    // The slider carries the step attr (UI drag granularity)...
    expect(html).toContain('step="10"');
    // ...while BOTH the number input and the slider display the same OFF-STEP
    // value 23 (step is a drag hint, never snapped — 23 stays legal & editable).
    const matches = html.match(/value="23"/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("falls back to a fine sub-integer step (continuous drag) when spec omits step", () => {
    const html = renderToStaticMarkup(
      <NumberControl
        paramKey="x"
        spec={numberSpec({ min: 0, max: 100 })}
        value={50}
        locked={false}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    // No native `step="any"` sentinel on a Base UI slider; an omitted step
    // becomes a fine range-relative increment ((100-0)/1000 = 0.1), standing in
    // for continuous drag — deliberately NOT the coarse default `step="1"`.
    expect(html).toContain('step="0.1"');
    expect(html).not.toContain('step="1"');
  });

  it("renders the lucide lock as a toggle: aria-pressed reflects lock, never disables", () => {
    const locked = renderToStaticMarkup(
      <NumberControl
        paramKey="radius"
        spec={numberSpec()}
        value={10}
        locked={true}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    const unlocked = renderToStaticMarkup(
      <NumberControl
        paramKey="radius"
        spec={numberSpec()}
        value={10}
        locked={false}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    // The lock keeps its accessible label and toggle semantics...
    expect(locked).toContain('aria-label="radius lock"');
    expect(locked).toContain('aria-pressed="true"');
    expect(unlocked).toContain('aria-pressed="false"');
    // ...is a lucide icon (an inline svg), not the old text button...
    expect(locked).toContain("<svg");
    // ...and NEVER gates the inputs: a locked control carries no `disabled`.
    expect(locked).not.toContain("disabled");
  });
});

describe("NumberControl transactions", () => {
  const lifecycle = () => ({
    onBegin: vi.fn<[], void>(),
    onPreview: vi.fn<[number], void>(),
    onCommit: vi.fn<[], void>(),
    onCancel: vi.fn<[], void>(),
  });

  function enter(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("previews valid numeric drafts and commits Enter exactly once despite blur", () => {
    const editHistory = lifecycle();
    const el = mount(
      <NumberControl
        paramKey="radius"
        spec={numberSpec()}
        value={50}
        locked={false}
        onChange={() => {}}
        editHistory={editHistory}
        onToggleLock={() => {}}
      />,
    );
    const input = el.querySelector<HTMLInputElement>('input[type="number"]')!;

    act(() => {
      input.focus();
      enter(input, "60");
      enter(input, "70");
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    expect(editHistory.onBegin).toHaveBeenCalledTimes(1);
    expect(editHistory.onPreview.mock.calls).toEqual([[60], [70]]);
    expect(editHistory.onCommit).toHaveBeenCalledTimes(1);
    expect(editHistory.onCancel).not.toHaveBeenCalled();
  });

  it("cancels Escape and a later blur cannot commit the canceled draft", () => {
    const editHistory = lifecycle();
    const el = mount(
      <NumberControl
        paramKey="radius"
        spec={numberSpec()}
        value={50}
        locked={false}
        onChange={() => {}}
        editHistory={editHistory}
        onToggleLock={() => {}}
      />,
    );
    const input = el.querySelector<HTMLInputElement>('input[type="number"]')!;

    act(() => {
      input.focus();
      enter(input, "75");
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      input.blur();
    });

    expect(editHistory.onBegin).toHaveBeenCalledTimes(1);
    expect(editHistory.onPreview).toHaveBeenCalledWith(75);
    expect(editHistory.onCancel).toHaveBeenCalledTimes(1);
    expect(editHistory.onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("50");
  });

  it("begins an invalid draft immediately, previews nothing, and Escape cancels", () => {
    const editHistory = lifecycle();
    const el = mount(
      <NumberControl
        paramKey="radius"
        spec={numberSpec()}
        value={50}
        locked={false}
        onChange={() => {}}
        editHistory={editHistory}
        onToggleLock={() => {}}
      />,
    );
    const input = el.querySelector<HTMLInputElement>('input[type="number"]')!;

    act(() => {
      input.focus();
      enter(input, "");
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      input.blur();
    });

    expect(editHistory.onBegin).toHaveBeenCalledTimes(1);
    expect(editHistory.onPreview).not.toHaveBeenCalled();
    expect(editHistory.onCancel).toHaveBeenCalledTimes(1);
    expect(editHistory.onCommit).not.toHaveBeenCalled();
  });

  it("commits an invalid draft transaction once on Enter and not again on blur", () => {
    const editHistory = lifecycle();
    const el = mount(
      <NumberControl
        paramKey="radius"
        spec={numberSpec()}
        value={50}
        locked={false}
        onChange={() => {}}
        editHistory={editHistory}
        onToggleLock={() => {}}
      />,
    );
    const input = el.querySelector<HTMLInputElement>('input[type="number"]')!;

    act(() => {
      input.focus();
      // Browsers sanitize a lone "-" in a number input to an empty string;
      // either form is the same temporarily invalid numeric draft.
      enter(input, "-");
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    expect(editHistory.onBegin).toHaveBeenCalledTimes(1);
    expect(editHistory.onPreview).not.toHaveBeenCalled();
    expect(editHistory.onCommit).toHaveBeenCalledTimes(1);
    expect(editHistory.onCancel).not.toHaveBeenCalled();
  });

  it("keeps the original standalone onChange behavior without a lifecycle", () => {
    const onChange = vi.fn<[number], void>();
    const el = mount(
      <NumberControl
        paramKey="radius"
        spec={numberSpec()}
        value={50}
        locked={false}
        onChange={onChange}
        onToggleLock={() => {}}
      />,
    );
    const input = el.querySelector<HTMLInputElement>('input[type="number"]')!;
    act(() => enter(input, "72"));
    expect(onChange).toHaveBeenCalledWith(72);
  });

  it("restores the standalone parent value on Escape after live preview", () => {
    function StandaloneControl() {
      const [current, setCurrent] = useState(50);
      return (
        <NumberControl
          paramKey="radius"
          spec={numberSpec()}
          value={current}
          locked={false}
          onChange={setCurrent}
          onToggleLock={() => {}}
        />
      );
    }

    const el = mount(<StandaloneControl />);
    const input = el.querySelector<HTMLInputElement>('input[type="number"]')!;
    const slider = el.querySelector<HTMLInputElement>('input[type="range"]')!;

    act(() => {
      input.focus();
      enter(input, "75");
    });
    expect(input.value).toBe("75");
    expect(slider.value).toBe("75");

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(input.value).toBe("50");
    expect(slider.value).toBe("50");
  });

  it("begins before slider preview and commits the completed interaction", () => {
    const order: string[] = [];
    const el = mount(
      <NumberControl
        paramKey="radius"
        spec={numberSpec()}
        value={50}
        locked={false}
        onChange={() => {}}
        editHistory={{
          onBegin: () => order.push("begin"),
          onPreview: (next) => order.push(`preview:${next}`),
          onCommit: () => order.push("commit"),
          onCancel: () => order.push("cancel"),
        }}
        onToggleLock={() => {}}
      />,
    );
    const slider = el.querySelector<HTMLInputElement>('input[type="range"]')!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;

    act(() => {
      setter.call(slider, "80");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(order).toEqual(["begin", "preview:80", "commit"]);
  });
});
