import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  defaultParams,
  type ParamSchema,
  type ParamSpec,
} from "@harness/core";

import { ControlPanel } from "./ControlPanel";
import { SketchControls } from "./SketchControls";

const numberSpec = (over: Record<string, unknown> = {}): ParamSpec =>
  ({
    kind: "number",
    min: 0,
    max: 100,
    default: 50,
    ...over,
  }) as ParamSpec;

describe("ControlPanel", () => {
  it("renders exactly one control per schema entry", () => {
    const schema: ParamSchema = {
      radius: numberSpec({ default: 10 }),
      count: numberSpec({ default: 5, integer: true }),
      speed: numberSpec({ default: 1 }),
    };
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={defaultParams(schema)}
        locks={new Set()}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    // One number input per param (the slider is also type=range; count number
    // inputs as the per-control marker).
    const numberInputs = html.match(/type="number"/g) ?? [];
    expect(numberInputs.length).toBe(3);
    // Each param's label is present.
    expect(html).toContain("radius");
    expect(html).toContain("count");
    expect(html).toContain("speed");
  });

  it("nests each control row once (no wrapper duplicating NumberControl's root)", () => {
    // NumberControl's own root is `flex flex-col gap-1.5`. The panel must NOT
    // re-wrap each row in a second `flex flex-col gap-1.5` div — that per-row
    // gap is inert around a single child and duplicates the child's own root.
    // So the class appears exactly once per control (not twice).
    const schema: ParamSchema = {
      radius: numberSpec(),
      count: numberSpec(),
      speed: numberSpec(),
    };
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={defaultParams(schema)}
        locks={new Set()}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    const rowRoots = html.match(/class="flex flex-col gap-1\.5"/g) ?? [];
    expect(rowRoots.length).toBe(3);
  });

  it("renders a LOUD visible fallback for an unsupported kind (never silent)", () => {
    // An unknown kind that the open ParamSpec union does not (yet) inhabit.
    const schema = {
      mystery: { kind: "color", default: "#fff" },
    } as unknown as ParamSchema;
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={{}}
        locks={new Set()}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    expect(html).toContain("unsupported control kind: color");
    // The fallback names the offending param and is an alert (not hidden)...
    expect(html).toContain("mystery");
    expect(html).toContain('role="alert"');
    // ...styled LOUD via the destructive theme token (high-contrast, not silent).
    expect(html).toContain("border-destructive");
  });

  it("reflects the supplied param values in the controls", () => {
    const schema: ParamSchema = { radius: numberSpec({ default: 10 }) };
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={{ radius: 73 }}
        locks={new Set()}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    expect(html).toContain('value="73"');
  });

  it("renders a lock affordance per control, reflecting `locks` membership", () => {
    const schema: ParamSchema = {
      radius: numberSpec(),
      count: numberSpec(),
    };
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={{ radius: 10, count: 5 }}
        locks={new Set(["radius"])}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    // One lock toggle per param — each is the only element carrying aria-pressed.
    expect((html.match(/aria-pressed=/g) ?? []).length).toBe(2);
    // The locked param's toggle is pressed; the unlocked one is not.
    expect(html).toContain('aria-label="radius lock" aria-pressed="true"');
    expect(html).toContain('aria-label="count lock" aria-pressed="false"');
  });

  it("a locked control is NOT disabled — lock excludes from Randomize only", () => {
    const schema: ParamSchema = { radius: numberSpec() };
    const html = renderToStaticMarkup(
      <ControlPanel
        schema={schema}
        params={{ radius: 10 }}
        locks={new Set(["radius"])}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    // The lock NEVER gates the input: the control markup carries no `disabled`.
    expect(html).not.toContain("disabled");
  });
});

describe("SketchControls reset-by-defaults", () => {
  const sketchWith = (id: string, schema: ParamSchema) =>
    ({
      id,
      name: id,
      schema,
      generate: () => ({
        space: { width: 100, height: 100 },
        strokes: [],
      }),
    }) as unknown as Parameters<typeof SketchControls>[0]["sketch"];

  it("seeds controls from the Sketch's defaultParams", () => {
    const sketch = sketchWith("a", {
      radius: numberSpec({ default: 42 }),
    });
    const html = renderToStaticMarkup(<SketchControls sketch={sketch} />);
    expect(html).toContain('value="42"');
  });

  it("a different Sketch (the keyed-remount case) seeds its OWN defaults", () => {
    // App mounts SketchControls with key={sketch.id}, so switching Sketch
    // remounts it and the lazy useState re-seeds from the NEW schema's
    // defaults. Rendering each sketch fresh proves the init pulls per-Sketch
    // defaults (the reset mechanism), independent of any prior instance.
    const a = sketchWith("a", { radius: numberSpec({ default: 42 }) });
    const b = sketchWith("b", { radius: numberSpec({ default: 7 }) });
    expect(renderToStaticMarkup(<SketchControls sketch={a} />)).toContain(
      'value="42"',
    );
    expect(renderToStaticMarkup(<SketchControls sketch={b} />)).toContain(
      'value="7"',
    );
  });
});
