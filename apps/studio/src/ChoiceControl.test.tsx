// @vitest-environment jsdom
import type { ChoiceParamSpec } from "@harness/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChoiceControl } from "./ChoiceControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const strategySpec: ChoiceParamSpec = {
  kind: "choice",
  default: "scribble",
  options: [
    { value: "scribble", label: "Scribble" },
    { value: "stipple", label: "Stippling" },
  ],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

function choose(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

describe("ChoiceControl", () => {
  it("labels the controlled select by its schema key and maps labels to stable values", () => {
    const html = renderToStaticMarkup(
      <ChoiceControl
        paramKey="strategy"
        spec={strategySpec}
        value="stipple"
        onChange={() => {}}
      />,
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    const label = host.querySelector("label")!;
    const select = host.querySelector("select")!;
    const options = [...select.options];

    expect(label.textContent).toBe("strategy");
    expect(label.htmlFor).toBe("control-strategy");
    expect(select.id).toBe("control-strategy");
    expect(select.value).toBe("stipple");
    expect(options.map((option) => option.textContent)).toEqual([
      "Scribble",
      "Stippling",
    ]);
    expect(options.map((option) => option.value)).toEqual([
      "scribble",
      "stipple",
    ]);
  });

  it("lifts a declared stable value and remains controlled by external props", () => {
    const onChange = vi.fn();
    const el = mount(
      <ChoiceControl
        paramKey="strategy"
        spec={strategySpec}
        value="scribble"
        onChange={onChange}
      />,
    );
    const select = el.querySelector("select")!;

    choose(select, "stipple");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("stipple");

    act(() =>
      root!.render(
        <ChoiceControl
          paramKey="strategy"
          spec={strategySpec}
          value="stipple"
          onChange={onChange}
        />,
      ),
    );
    expect(el.querySelector<HTMLSelectElement>("select")!.value).toBe(
      "stipple",
    );
  });

  it("records one selection through one atomic edit lifecycle", () => {
    const events: string[] = [];
    const onChange = vi.fn();
    const el = mount(
      <ChoiceControl
        paramKey="strategy"
        spec={strategySpec}
        value="scribble"
        onChange={onChange}
        editHistory={{
          onBegin: () => events.push("begin"),
          onPreview: (value) => events.push(`preview:${value}`),
          onCommit: () => events.push("commit"),
          onCancel: () => events.push("cancel"),
        }}
      />,
    );

    choose(el.querySelector("select")!, "stipple");

    expect(events).toEqual(["begin", "preview:stipple", "commit"]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores same-value and undeclared DOM selections", () => {
    const onChange = vi.fn();
    const onBegin = vi.fn();
    const el = mount(
      <ChoiceControl
        paramKey="strategy"
        spec={strategySpec}
        value="scribble"
        onChange={onChange}
        editHistory={{
          onBegin,
          onPreview: vi.fn(),
          onCommit: vi.fn(),
          onCancel: vi.fn(),
        }}
      />,
    );
    const select = el.querySelector("select")!;

    choose(select, "scribble");
    const rogue = document.createElement("option");
    rogue.value = "rogue";
    rogue.textContent = "Rogue";
    select.append(rogue);
    choose(select, "rogue");

    expect(onChange).not.toHaveBeenCalled();
    expect(onBegin).not.toHaveBeenCalled();
  });

  it("has no Lock affordance and renders only the declared options", () => {
    const html = renderToStaticMarkup(
      <ChoiceControl
        paramKey="strategy"
        spec={strategySpec}
        value="scribble"
        onChange={() => {}}
      />,
    );
    const host = document.createElement("div");
    host.innerHTML = html;

    expect(host.querySelectorAll("option")).toHaveLength(2);
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector('[aria-label$=" lock"]')).toBeNull();
    expect(host.textContent).not.toContain("Lock");
  });

  it("fails loudly instead of presenting an undeclared controlled value", () => {
    expect(() =>
      renderToStaticMarkup(
        <ChoiceControl
          paramKey="strategy"
          spec={strategySpec}
          value="rogue"
          onChange={() => {}}
        />,
      ),
    ).toThrow(/Choice param `strategy` value/);
  });
});
