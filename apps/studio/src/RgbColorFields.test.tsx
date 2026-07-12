// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { RgbColorFields, type RgbColorFieldsProps } from "./RgbColorFields";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const callbacks = () => ({
  onEditBegin: vi.fn<[], void>(),
  onLocalPreview: vi.fn<[string], void>(),
  onSettle: vi.fn<[string], void>(),
  onCancel: vi.fn<[string], void>(),
});

function mount(props: RgbColorFieldsProps): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<RgbColorFields {...props} />));
  return container;
}

function rerender(props: RgbColorFieldsProps) {
  act(() => root!.render(<RgbColorFields {...props} />));
}

function enter(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(input: HTMLInputElement, value: string) {
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
  );
}

function inputs(element: HTMLElement) {
  return Array.from(element.querySelectorAll<HTMLInputElement>("input"));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("RgbColorFields markup", () => {
  it("provides labelled, constrained, keyboard-accessible text fields", () => {
    const events = callbacks();
    const html = renderToStaticMarkup(
      <RgbColorFields paramKey="ink" color="#0a141e" {...events} />,
    );

    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="ink RGB channels"');
    expect(html).toContain('aria-label="ink red channel"');
    expect(html).toContain('aria-label="ink green channel"');
    expect(html).toContain('aria-label="ink blue channel"');
    expect(html.match(/type="text"/g)).toHaveLength(3);
    expect(html.match(/inputMode="numeric"/g)).toHaveLength(3);
    expect(html.match(/min="0"/g)).toHaveLength(3);
    expect(html.match(/max="255"/g)).toHaveLength(3);
    expect(html).toContain('value="10"');
    expect(html).toContain('value="20"');
    expect(html).toContain('value="30"');
  });
});

describe("RgbColorFields drafts", () => {
  it("begins once, clamps valid integers, previews canonical color, and syncs siblings", () => {
    const events = callbacks();
    const el = mount({ paramKey: "ink", color: "#0a141e", ...events });
    const [red, green, blue] = inputs(el);

    act(() => {
      red!.focus();
      enter(red!, "999");
      enter(red!, "0042");
    });

    expect(events.onEditBegin).toHaveBeenCalledTimes(1);
    expect(events.onLocalPreview.mock.calls).toEqual([
      ["#ff141e"],
      ["#2a141e"],
    ]);
    expect(red!.value).toBe("0042");
    expect(green!.value).toBe("20");
    expect(blue!.value).toBe("30");
  });

  it.each(["", "1.5", "1e2", "hello", "+", "-"])(
    "keeps invalid draft %j local without preview",
    (draft) => {
      const events = callbacks();
      const el = mount({ paramKey: "ink", color: "#0a141e", ...events });
      const [red, green, blue] = inputs(el);

      act(() => {
        green!.focus();
        enter(green!, draft);
      });

      expect(events.onEditBegin).toHaveBeenCalledTimes(1);
      expect(events.onLocalPreview).not.toHaveBeenCalled();
      expect(red!.value).toBe("10");
      expect(green!.value).toBe(draft);
      expect(blue!.value).toBe("30");
    },
  );

  it("settles the latest valid color once on Enter despite the resulting blur", () => {
    const events = callbacks();
    const el = mount({ paramKey: "ink", color: "#0a141e", ...events });
    const [red] = inputs(el);

    act(() => {
      red!.focus();
      enter(red!, "40");
      enter(red!, "50");
      key(red!, "Enter");
    });

    expect(events.onSettle).toHaveBeenCalledTimes(1);
    expect(events.onSettle).toHaveBeenCalledWith("#32141e");
    expect(events.onCancel).not.toHaveBeenCalled();
    expect(red!.value).toBe("50");
  });

  it("settles a valid blur exactly once", () => {
    const events = callbacks();
    const el = mount({ paramKey: "ink", color: "#0a141e", ...events });
    const [, green] = inputs(el);

    act(() => {
      green!.focus();
      enter(green!, "255");
      green!.blur();
    });

    expect(events.onSettle).toHaveBeenCalledTimes(1);
    expect(events.onSettle).toHaveBeenCalledWith("#0aff1e");
  });

  it("cancels an invalid Enter and restores all channels from the focus snapshot", () => {
    const events = callbacks();
    const el = mount({ paramKey: "ink", color: "#0a141e", ...events });
    const [, green] = inputs(el);

    act(() => {
      green!.focus();
      enter(green!, "77");
      enter(green!, "1.5");
      key(green!, "Enter");
    });

    expect(events.onLocalPreview).toHaveBeenCalledWith("#0a4d1e");
    expect(events.onCancel).toHaveBeenCalledTimes(1);
    expect(events.onCancel).toHaveBeenCalledWith("#0a141e");
    expect(events.onSettle).not.toHaveBeenCalled();
    expect(inputs(el).map((input) => input.value)).toEqual(["10", "20", "30"]);
  });

  it("cancels an invalid blur instead of settling the last preview", () => {
    const events = callbacks();
    const el = mount({ paramKey: "ink", color: "#0a141e", ...events });
    const [, , blue] = inputs(el);

    act(() => {
      blue!.focus();
      enter(blue!, "200");
      enter(blue!, "1e2");
      blue!.blur();
    });

    expect(events.onLocalPreview).toHaveBeenCalledWith("#0a14c8");
    expect(events.onCancel).toHaveBeenCalledTimes(1);
    expect(events.onCancel).toHaveBeenCalledWith("#0a141e");
    expect(events.onSettle).not.toHaveBeenCalled();
    expect(inputs(el).map((input) => input.value)).toEqual(["10", "20", "30"]);
  });

  it("Escape stops dismissal, restores the full snapshot, stays focused, and cannot settle on blur", () => {
    const events = callbacks();
    const el = mount({ paramKey: "ink", color: "#0a141e", ...events });
    const [red] = inputs(el);
    const bubbled = vi.fn();
    document.addEventListener("keydown", bubbled);
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      red!.focus();
      enter(red!, "200");
      red!.dispatchEvent(escape);
    });

    document.removeEventListener("keydown", bubbled);
    expect(bubbled).not.toHaveBeenCalled();
    expect(escape.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(red);
    expect(events.onCancel).toHaveBeenCalledTimes(1);
    expect(events.onCancel).toHaveBeenCalledWith("#0a141e");
    expect(inputs(el).map((input) => input.value)).toEqual(["10", "20", "30"]);

    act(() => red!.blur());
    expect(events.onCancel).toHaveBeenCalledTimes(1);
    expect(events.onSettle).not.toHaveBeenCalled();
  });

  it("syncs idle controlled changes, including while focused", () => {
    const events = callbacks();
    const first = { paramKey: "ink", color: "#0a141e", ...events };
    const el = mount(first);
    const [red] = inputs(el);

    act(() => red!.focus());
    rerender({ ...first, color: "#28323c" });

    expect(inputs(el).map((input) => input.value)).toEqual(["40", "50", "60"]);
    expect(events.onEditBegin).not.toHaveBeenCalled();
  });

  it("keeps an active draft authoritative over controlled prop changes", () => {
    const events = callbacks();
    const first = { paramKey: "ink", color: "#0a141e", ...events };
    const el = mount(first);
    const [, green] = inputs(el);

    act(() => {
      green!.focus();
      enter(green!, "1.5");
    });
    rerender({ ...first, color: "#28323c" });

    expect(inputs(el).map((input) => input.value)).toEqual(["10", "1.5", "30"]);
  });

  it("Escape restores the whole original focus color after valid local previews", () => {
    const events = callbacks();
    const el = mount({ paramKey: "ink", color: "#102030", ...events });
    const [, , blue] = inputs(el);

    act(() => {
      blue!.focus();
      enter(blue!, "255");
      key(blue!, "Escape");
    });

    expect(events.onLocalPreview).toHaveBeenCalledWith("#1020ff");
    expect(events.onCancel).toHaveBeenCalledWith("#102030");
    expect(inputs(el).map((input) => input.value)).toEqual(["16", "32", "48"]);
  });
});
