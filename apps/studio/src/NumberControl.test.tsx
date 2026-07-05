import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NumberParamSpec } from "@harness/core";

import { coerceToDomain, NumberControl } from "./NumberControl";

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
