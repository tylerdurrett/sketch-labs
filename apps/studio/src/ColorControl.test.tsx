// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { ColorParamSpec } from "@harness/core";

import { ColorControl } from "./ColorControl";

const colorSpec = (over: Partial<ColorParamSpec> = {}): ColorParamSpec => ({
  kind: "color",
  default: "#1a2b3c",
  ...over,
});

// React 19's `act` requires this flag; vitest's jsdom env does not set it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Mount a node into a fresh jsdom container (the SketchControls test pattern). */
function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("ColorControl markup", () => {
  it("renders ONE line: a labelled native color input showing the value, plus a lock", () => {
    const html = renderToStaticMarkup(
      <ColorControl
        paramKey="ink"
        spec={colorSpec()}
        value="#c0ffee"
        locked={false}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    // The native color input is the whole value surface (no slider line — a
    // color has no [min, max] to drag across) and displays the current hex.
    expect(html).toContain('type="color"');
    expect(html).toContain('value="#c0ffee"');
    expect(html).not.toContain('type="range"');
    // The label ties to the input by the shared control id convention.
    expect(html).toContain('for="control-ink"');
    expect(html).toContain('id="control-ink"');
    expect(html).toContain("ink");
  });

  it("renders the lucide lock as a toggle: aria-pressed reflects lock, never disables", () => {
    const locked = renderToStaticMarkup(
      <ColorControl
        paramKey="ink"
        spec={colorSpec()}
        value="#c0ffee"
        locked={true}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    const unlocked = renderToStaticMarkup(
      <ColorControl
        paramKey="ink"
        spec={colorSpec()}
        value="#c0ffee"
        locked={false}
        onChange={() => {}}
        onToggleLock={() => {}}
      />,
    );
    // The lock keeps its accessible label and toggle semantics (mirroring
    // NumberControl's exactly — colors never roll, but the chrome is uniform)...
    expect(locked).toContain('aria-label="ink lock"');
    expect(locked).toContain('aria-pressed="true"');
    expect(unlocked).toContain('aria-pressed="false"');
    // ...is a lucide icon (an inline svg), not a text button...
    expect(locked).toContain("<svg");
    // ...and NEVER gates the input: a locked control carries no `disabled`.
    expect(locked).not.toContain("disabled");
  });
});

describe("ColorControl wiring", () => {
  it("fires onChange with the newly picked hex string", () => {
    const onChange = vi.fn<[string], void>();
    const el = mount(
      <ColorControl
        paramKey="ink"
        spec={colorSpec()}
        value="#c0ffee"
        locked={false}
        onChange={onChange}
        onToggleLock={() => {}}
      />,
    );

    const input = el.querySelector<HTMLInputElement>("#control-ink")!;
    act(() => {
      // Set the value through the native setter and fire the React-observed
      // `input` event — the same dispatch pattern the SketchControls tests use.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "#123456");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("#123456");
  });

  it("fires onToggleLock when the lock toggle is clicked", () => {
    const onToggleLock = vi.fn<[], void>();
    const el = mount(
      <ColorControl
        paramKey="ink"
        spec={colorSpec()}
        value="#c0ffee"
        locked={false}
        onChange={() => {}}
        onToggleLock={onToggleLock}
      />,
    );

    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="ink lock"]',
    )!;
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onToggleLock).toHaveBeenCalledTimes(1);
  });

  it("previews native input and commits completed change once, not again on blur", () => {
    const order: string[] = [];
    const el = mount(
      <ColorControl
        paramKey="ink"
        spec={colorSpec()}
        value="#c0ffee"
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
    const input = el.querySelector<HTMLInputElement>("#control-ink")!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;

    act(() => {
      setter.call(input, "#123456");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
      input.blur();
    });

    expect(order).toEqual(["begin", "preview:#123456", "commit"]);
  });

  it("begins and previews a change-only color event before committing", () => {
    const order: string[] = [];
    const el = mount(
      <ColorControl
        paramKey="ink"
        spec={colorSpec()}
        value="#c0ffee"
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
    const input = el.querySelector<HTMLInputElement>("#control-ink")!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;

    act(() => {
      setter.call(input, "#654321");
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(order).toEqual(["begin", "preview:#654321", "commit"]);
  });

  it("uses blur as a guarded commit fallback when no change event arrives", () => {
    const onCommit = vi.fn<[], void>();
    const el = mount(
      <ColorControl
        paramKey="ink"
        spec={colorSpec()}
        value="#c0ffee"
        locked={false}
        onChange={() => {}}
        editHistory={{
          onBegin: () => {},
          onPreview: () => {},
          onCommit,
          onCancel: () => {},
        }}
        onToggleLock={() => {}}
      />,
    );
    const input = el.querySelector<HTMLInputElement>("#control-ink")!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;

    act(() => {
      input.focus();
      setter.call(input, "#abcdef");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
