// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ColorParamSpec } from "@harness/core";

import { ColorControl, type ColorControlProps } from "./ColorControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const spec: ColorParamSpec = { kind: "color", default: "#1a2b3c" };
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function props(overrides: Partial<ColorControlProps> = {}): ColorControlProps {
  return {
    paramKey: "ink",
    spec,
    value: "#0a141e",
    onChange: vi.fn(),
    ...overrides,
  };
}

function mount(controlProps = props()): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ColorControl {...controlProps} />));
  return container;
}

function rerender(controlProps: ColorControlProps) {
  act(() => root!.render(<ColorControl {...controlProps} />));
}

function trigger(): HTMLButtonElement {
  return container!.querySelector<HTMLButtonElement>(
    'button[aria-label^="ink current color"]',
  )!;
}

function popup(): HTMLElement {
  return document.querySelector<HTMLElement>('[aria-label="ink color picker"]')!;
}

function openPicker() {
  act(() => trigger().click());
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
}

function rgb(channel: "red" | "green" | "blue"): HTMLInputElement {
  return popup().querySelector<HTMLInputElement>(
    `input[aria-label="ink ${channel} channel"]`,
  )!;
}

function enter(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(element: HTMLElement, value: string) {
  const keyCode = value === "ArrowRight" ? 39 : value === "Enter" ? 13 : 27;
  element.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: value,
      code: value,
      keyCode,
      bubbles: true,
      cancelable: true,
    }),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("ColorControl composition", () => {
  it("uses a labelled current-color trigger with no native picker or lock", () => {
    const el = mount();

    expect(trigger().getAttribute("aria-label")).toBe(
      "ink current color #0a141e",
    );
    expect(el.textContent).toContain("ink");
    expect(document.querySelector('input[type="color"]')).toBeNull();
    expect(document.querySelector('[aria-label="ink lock"]')).toBeNull();
  });

  it("keeps the composed picker, RGB fields, then black/white Palette mounted", () => {
    mount();
    const picker = popup();
    const surface = picker.querySelector(".color-picker-surface")!;
    const fields = picker.querySelector('[aria-label="ink RGB channels"]')!;
    const palette = picker.querySelector('[aria-label="ink Palette"]')!;

    expect(picker.getAttribute("role")).toBe("dialog");
    expect(surface.compareDocumentPosition(fields) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(fields.compareDocumentPosition(palette) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(palette.querySelectorAll("button")).toHaveLength(2);
    expect(palette.querySelector('[aria-label="ink Palette Black"]')).toBeTruthy();
    expect(palette.querySelector('[aria-label="ink Palette White"]')).toBeTruthy();
  });
});

describe("ColorControl RGB ownership", () => {
  it("keeps valid and invalid drafts local, then atomically settles once", () => {
    const order: string[] = [];
    mount(
      props({
        editHistory: {
          onBegin: () => order.push("begin"),
          onPreview: (next) => order.push(`preview:${next}`),
          onCommit: () => order.push("commit"),
          onCancel: () => order.push("cancel"),
        },
      }),
    );
    openPicker();
    const red = rgb("red");

    act(() => {
      red.focus();
      enter(red, "40");
      enter(red, "invalid");
    });
    expect(order).toEqual([]);
    expect(trigger().getAttribute("aria-label")).toBe(
      "ink current color #28141e",
    );

    act(() => {
      enter(red, "50");
      key(red, "Enter");
    });
    expect(order).toEqual(["begin", "preview:#32141e", "commit"]);
  });

  it("cancels to the focus snapshot, idles, and keeps RGB Escape inside", () => {
    const initial = props();
    mount(initial);
    openPicker();
    expect(trigger().getAttribute("aria-label")).toBe(
      "ink current color #0a141e",
    );
    const blue = rgb("blue");

    act(() => {
      blue.focus();
      enter(blue, "255");
      key(blue, "Escape");
    });

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-label")).toBe(
      "ink current color #0a141e",
    );
    expect(initial.onChange).not.toHaveBeenCalled();
  });
});

describe("ColorControl Palette", () => {
  it.each([
    ["Black", "#000000"],
    ["White", "#ffffff"],
  ])("applies %s as one atomic edit and closes", (name, color) => {
    const order: string[] = [];
    mount(
      props({
        editHistory: {
          onBegin: () => order.push("begin"),
          onPreview: (next) => order.push(`preview:${next}`),
          onCommit: () => order.push("commit"),
          onCancel: () => order.push("cancel"),
        },
      }),
    );
    openPicker();

    act(() =>
      popup()
        .querySelector<HTMLButtonElement>(`[aria-label="ink Palette ${name}"]`)!
        .click(),
    );

    expect(order).toEqual(["begin", `preview:${color}`, "commit"]);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("uses one fallback onChange and does not steal focus on pointer close", () => {
    const onChange = vi.fn<[string], void>();
    mount(props({ onChange }));
    openPicker();
    const white = popup().querySelector<HTMLButtonElement>(
      '[aria-label="ink Palette White"]',
    )!;
    act(() => {
      white.focus();
      white.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("#ffffff");
    expect(document.activeElement).not.toBe(trigger());
  });
});

describe("ColorControl dismissal and synchronization", () => {
  it("closes on non-field Escape and returns keyboard focus to the trigger", async () => {
    mount();
    openPicker();
    const hue = popup().querySelector<HTMLElement>('[aria-label="ink hue"]')!;
    act(() => {
      hue.focus();
      key(hue, "Escape");
    });
    await act(
      async () => new Promise((resolve) => window.setTimeout(resolve, 0)),
    );

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps settled edits when an outside press closes the popup", () => {
    const onChange = vi.fn<[string], void>();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    mount(props({ onChange }));
    openPicker();
    const red = rgb("red");
    act(() => {
      red.focus();
      enter(red, "40");
      red.blur();
    });
    expect(onChange).toHaveBeenCalledWith("#28141e");

    act(() => {
      outside.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
      outside.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
      outside.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    outside.remove();
    expect(trigger().getAttribute("aria-label")).toBe(
      "ink current color #28141e",
    );
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("synchronizes the keep-mounted trigger, surface, and RGB fields while idle", async () => {
    const initial = props();
    mount(initial);
    rerender({ ...initial, value: "#00ff00" });
    await act(async () => Promise.resolve());

    expect(trigger().getAttribute("aria-label")).toBe(
      "ink current color #00ff00",
    );
    expect(popup().querySelector('[aria-label="ink hue"]')?.getAttribute("aria-valuenow"))
      .toBe("120");
    expect([rgb("red").value, rgb("green").value, rgb("blue").value]).toEqual([
      "0",
      "255",
      "0",
    ]);
  });
});
