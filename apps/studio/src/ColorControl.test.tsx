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
  vi.useRealTimers();
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
    const order: string[] = [];
    const initial = props({
      editHistory: {
        onBegin: () => order.push("begin"),
        onPreview: (next) => order.push(`preview:${next}`),
        onCommit: () => order.push("commit"),
        onCancel: () => order.push("cancel"),
      },
    });
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
    expect(order).toEqual([]);
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

describe("ColorControl gesture timing", () => {
  function hue(): HTMLElement {
    return popup().querySelector<HTMLElement>('[aria-label="ink hue"]')!;
  }

  function hueKey(type: "keydown" | "keyup") {
    hue().dispatchEvent(
      new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        key: "ArrowRight",
        code: "ArrowRight",
        keyCode: 39,
      }),
    );
  }

  function historyOrder(): {
    order: string[];
    editHistory: NonNullable<ColorControlProps["editHistory"]>;
  } {
    const order: string[] = [];
    return {
      order,
      editHistory: {
        onBegin: () => order.push("begin"),
        onPreview: (next) => order.push(`preview:${next}`),
        onCommit: () => order.push("commit"),
        onCancel: () => order.push("cancel"),
      },
    };
  }

  it("updates the local color immediately without lifting before 100ms", () => {
    vi.useFakeTimers();
    const onChange = vi.fn<[string], void>();
    mount(props({ value: "#ff0000", onChange }));
    openPicker();

    act(() => hueKey("keydown"));

    expect(trigger().getAttribute("aria-label")).toBe(
      "ink current color #ff4d00",
    );
    expect([rgb("red").value, rgb("green").value, rgb("blue").value]).toEqual([
      "255",
      "77",
      "0",
    ]);
    expect(onChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(99));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("restarts the trailing deadline and lifts only the latest color", () => {
    vi.useFakeTimers();
    const onChange = vi.fn<[string], void>();
    mount(props({ value: "#ff0000", onChange }));
    openPicker();

    act(() => hueKey("keydown"));
    act(() => vi.advanceTimersByTime(75));
    act(() => hueKey("keydown"));
    expect(trigger().getAttribute("aria-label")).toBe(
      "ink current color #ff9900",
    );

    act(() => vi.advanceTimersByTime(99));
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("#ff9900");
  });

  it("routes the trailing lift through edit history preview", () => {
    vi.useFakeTimers();
    const order: string[] = [];
    mount(
      props({
        value: "#ff0000",
        editHistory: {
          onBegin: () => order.push("begin"),
          onPreview: (next) => order.push(`preview:${next}`),
          onCommit: () => order.push("commit"),
          onCancel: () => order.push("cancel"),
        },
      }),
    );
    openPicker();

    act(() => hueKey("keydown"));
    expect(order).toEqual(["begin"]);
    act(() => vi.advanceTimersByTime(100));

    expect(order).toEqual(["begin", "preview:#ff4d00"]);
  });

  it("begins once before the timer and commits many changes as one gesture", () => {
    vi.useFakeTimers();
    const { order, editHistory } = historyOrder();
    mount(props({ value: "#ff0000", editHistory }));
    openPicker();

    act(() => hueKey("keydown"));
    act(() => hueKey("keydown"));
    act(() => hueKey("keydown"));
    expect(order).toEqual(["begin"]);

    act(() => vi.advanceTimersByTime(100));
    expect(order).toEqual(["begin", "preview:#ffe500"]);
    act(() => hueKey("keyup"));

    expect(order).toEqual(["begin", "preview:#ffe500", "commit"]);
  });

  it("flushes a new final value after an idle debounce preview", () => {
    vi.useFakeTimers();
    const { order, editHistory } = historyOrder();
    mount(props({ value: "#ff0000", editHistory }));
    openPicker();

    act(() => hueKey("keydown"));
    act(() => vi.advanceTimersByTime(100));
    act(() => hueKey("keydown"));
    act(() => hueKey("keyup"));

    expect(order).toEqual([
      "begin",
      "preview:#ff4d00",
      "preview:#ff9900",
      "commit",
    ]);
    act(() => vi.runOnlyPendingTimers());
    expect(order).toHaveLength(4);
  });

  it("wraps a mouse gesture in the same begin-preview-commit boundary", () => {
    vi.useFakeTimers();
    const { order, editHistory } = historyOrder();
    mount(props({ value: "#ff0000", editHistory }));
    openPicker();
    const saturation = popup().querySelector<HTMLElement>(
      '[aria-label="ink saturation and value"]',
    )!;
    saturation.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect;

    act(() => {
      saturation.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          buttons: 1,
          clientX: 100,
          clientY: 25,
        }),
      );
    });
    expect(order).toEqual(["begin"]);
    act(() =>
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })),
    );

    expect(order).toEqual(["begin", "preview:#bf6060", "commit"]);
    act(() => vi.runOnlyPendingTimers());
    expect(order).toHaveLength(3);
  });

  it("uses the latest fallback callback when the deadline fires", () => {
    vi.useFakeTimers();
    const firstOnChange = vi.fn<[string], void>();
    const replacementOnChange = vi.fn<[string], void>();
    const initial = props({ value: "#ff0000", onChange: firstOnChange });
    mount(initial);
    openPicker();
    act(() => hueKey("keydown"));

    rerender({ ...initial, onChange: replacementOnChange });
    act(() => vi.advanceTimersByTime(100));

    expect(firstOnChange).not.toHaveBeenCalled();
    expect(replacementOnChange).toHaveBeenCalledTimes(1);
    expect(replacementOnChange).toHaveBeenCalledWith("#ff4d00");
  });

  it("uses the latest history lifecycle when the deadline fires", () => {
    vi.useFakeTimers();
    const firstPreview = vi.fn<[string], void>();
    const replacementPreview = vi.fn<[string], void>();
    const initial = props({
      value: "#ff0000",
      editHistory: {
        onBegin: vi.fn(),
        onPreview: firstPreview,
        onCommit: vi.fn(),
        onCancel: vi.fn(),
      },
    });
    mount(initial);
    openPicker();
    act(() => hueKey("keydown"));

    const replacementCommit = vi.fn();
    rerender({
      ...initial,
      editHistory: {
        onBegin: vi.fn(),
        onPreview: replacementPreview,
        onCommit: replacementCommit,
        onCancel: vi.fn(),
      },
    });
    act(() => vi.advanceTimersByTime(100));
    act(() => hueKey("keyup"));

    expect(firstPreview).not.toHaveBeenCalled();
    expect(replacementPreview).toHaveBeenCalledTimes(1);
    expect(replacementPreview).toHaveBeenCalledWith("#ff4d00");
    expect(replacementCommit).toHaveBeenCalledTimes(1);
  });

  it("flushes a final color synchronously when the gesture ends early", () => {
    vi.useFakeTimers();
    const onChange = vi.fn<[string], void>();
    mount(props({ value: "#ff0000", onChange }));
    openPicker();

    act(() => hueKey("keydown"));
    act(() => hueKey("keyup"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("#ff4d00");
    act(() => vi.advanceTimersByTime(100));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not lift the final color twice after the trailing deadline", () => {
    vi.useFakeTimers();
    const onChange = vi.fn<[string], void>();
    mount(props({ value: "#ff0000", onChange }));
    openPicker();

    act(() => hueKey("keydown"));
    act(() => vi.advanceTimersByTime(100));
    act(() => hueKey("keyup"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("#ff4d00");
  });

  it("clears a pending lift on unmount without previewing or committing", () => {
    vi.useFakeTimers();
    const order: string[] = [];
    mount(
      props({
        value: "#ff0000",
        editHistory: {
          onBegin: () => order.push("begin"),
          onPreview: (next) => order.push(`preview:${next}`),
          onCommit: () => order.push("commit"),
          onCancel: () => order.push("cancel"),
        },
      }),
    );
    openPicker();
    act(() => hueKey("keydown"));
    expect(order).toEqual(["begin"]);

    act(() => root!.unmount());
    root = null;
    act(() => vi.advanceTimersByTime(100));

    expect(order).toEqual(["begin"]);
  });

  it("does not let a stale external value overwrite an active draft", () => {
    vi.useFakeTimers();
    const initial = props({ value: "#ff0000" });
    mount(initial);
    openPicker();
    act(() => hueKey("keydown"));

    rerender({ ...initial, value: "#00ff00" });

    expect(trigger().getAttribute("aria-label")).toBe(
      "ink current color #ff4d00",
    );
    expect([rgb("red").value, rgb("green").value, rgb("blue").value]).toEqual([
      "255",
      "77",
      "0",
    ]);
    expect(initial.onChange).not.toHaveBeenCalled();
  });
});

describe("ColorControl dismissal and synchronization", () => {
  function hue(): HTMLElement {
    return popup().querySelector<HTMLElement>('[aria-label="ink hue"]')!;
  }

  function startHistoryGesture(order: string[]) {
    mount(
      props({
        value: "#ff0000",
        editHistory: {
          onBegin: () => order.push("begin"),
          onPreview: (next) => order.push(`preview:${next}`),
          onCommit: () => order.push("commit"),
          onCancel: () => order.push("cancel"),
        },
      }),
    );
    openPicker();
    act(() => key(hue(), "ArrowRight"));
    expect(order).toEqual(["begin"]);
  }

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

  it("idles a fallback gesture on dismissal so external values resynchronize", async () => {
    const initial = props({ value: "#ff0000" });
    mount(initial);
    openPicker();
    const hue = popup().querySelector<HTMLElement>('[aria-label="ink hue"]')!;

    act(() => {
      key(hue, "ArrowRight");
      key(hue, "Escape");
    });
    expect(initial.onChange).toHaveBeenCalledWith("#ff4d00");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    rerender({ ...initial, value: "#00ff00" });
    await act(
      async () => new Promise((resolve) => window.setTimeout(resolve, 0)),
    );

    expect(trigger().getAttribute("aria-label")).toBe(
      "ink current color #00ff00",
    );
    expect(
      popup()
        .querySelector('[aria-label="ink hue"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("120");
    expect([rgb("red").value, rgb("green").value, rgb("blue").value]).toEqual([
      "0",
      "255",
      "0",
    ]);
  });

  it("flushes and commits once when Escape dismisses an active gesture", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    startHistoryGesture(order);

    act(() => key(hue(), "Escape"));
    expect(order).toEqual(["begin", "preview:#ff4d00", "commit"]);
    act(() => vi.runOnlyPendingTimers());
    expect(order).toHaveLength(3);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("flushes and commits once when the trigger dismisses an active gesture", () => {
    vi.useFakeTimers();
    const order: string[] = [];
    startHistoryGesture(order);

    act(() => trigger().click());

    expect(order).toEqual(["begin", "preview:#ff4d00", "commit"]);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    act(() => vi.runOnlyPendingTimers());
    expect(order).toHaveLength(3);
  });

  it("flushes and commits once when an outside press dismisses a gesture", () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    startHistoryGesture(order);

    act(() => {
      outside.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
      outside.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    outside.remove();

    expect(order).toEqual(["begin", "preview:#ff4d00", "commit"]);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).not.toBe(trigger());
    act(() => vi.runOnlyPendingTimers());
    expect(order).toHaveLength(3);
  });

  it("does not commit again when a settled gesture is then dismissed", () => {
    vi.useFakeTimers();
    const order: string[] = [];
    startHistoryGesture(order);

    act(() =>
      hue().dispatchEvent(
        new KeyboardEvent("keyup", {
          bubbles: true,
          key: "ArrowRight",
          code: "ArrowRight",
          keyCode: 39,
        }),
      ),
    );
    act(() => key(hue(), "Escape"));

    expect(order).toEqual(["begin", "preview:#ff4d00", "commit"]);
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
