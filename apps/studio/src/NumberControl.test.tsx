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
  it("renders a range slider and a number input bound to the same value", () => {
    const html = renderToStaticMarkup(
      <NumberControl
        paramKey="radius"
        spec={numberSpec({ min: 0, max: 100, step: 10 })}
        value={23}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('type="range"');
    expect(html).toContain('type="number"');
    // The slider carries the step attr (UI drag granularity)...
    expect(html).toContain('step="10"');
    // ...while BOTH inputs display the same off-step value 23.
    const matches = html.match(/value="23"/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("uses step=\"any\" on the slider when the spec omits step", () => {
    const html = renderToStaticMarkup(
      <NumberControl
        paramKey="x"
        spec={numberSpec()}
        value={50}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('step="any"');
  });
});
