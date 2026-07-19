// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PageFrame } from "@harness/core";

import { PageFrameEditor } from "./PageFrameEditor";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const COMPOSITION = { width: 200, height: 100 };
const FULL_FRAME: PageFrame = { x: 0, y: 0, width: 200, height: 100 };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mountEditor(initialFrame: PageFrame = FULL_FRAME) {
  const callbacks = {
    onDraftChange: vi.fn(),
    onApply: vi.fn(),
    onCancel: vi.fn(),
    onReset: vi.fn(),
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <PageFrameEditor
        compositionFrame={COMPOSITION}
        initialFrame={initialFrame}
        {...callbacks}
      />,
    );
  });
  return { el: container, callbacks };
}

function input(el: HTMLElement, name: string): HTMLInputElement {
  const found = el.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (found === null) throw new Error(`No ${name} input`);
  return found;
}

function setInput(inputElement: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(inputElement, value);
    inputElement.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: HTMLElement, label: string): void {
  const button = [...el.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`No ${label} button`);
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("PageFrameEditor", () => {
  it("focuses X on entry without stealing focus on draft rerenders", () => {
    const { el } = mountEditor();
    const x = input(el, "x");
    const y = input(el, "y");

    expect(document.activeElement).toBe(x);
    act(() => y.focus());
    setInput(y, "25");
    expect(document.activeElement).toBe(y);
  });

  it("starts from the exact supplied frame and exposes only numeric framing actions", () => {
    const { el } = mountEditor({ x: -20, y: 10, width: 300, height: 75 });

    expect(el.querySelector("h2")?.textContent).toBe("Edit Page Frame");
    expect(input(el, "x").value).toBe("-10");
    expect(input(el, "y").value).toBe("10");
    expect(input(el, "width").value).toBe("150");
    expect(input(el, "height").value).toBe("75");
    expect(
      [...el.querySelectorAll("button")].map((button) => button.textContent),
    ).toEqual(["Apply", "Cancel", "Reset Frame"]);
    expect(el.textContent).not.toMatch(/drag|pan|shift|aspect/i);
  });

  it.each([
    ["inward crop", [10, 20, 60, 50], { x: 20, y: 20, width: 120, height: 50 }],
    [
      "outward padding",
      [-25, -10, 150, 130],
      { x: -50, y: -10, width: 300, height: 130 },
    ],
    [
      "mixed crop and padding",
      [20, -15, 110, 80],
      { x: 40, y: -15, width: 220, height: 80 },
    ],
  ] as const)(
    "accepts %s percentages without clamping",
    (_name, values, expected) => {
      const { el, callbacks } = mountEditor();
      (["x", "y", "width", "height"] as const).forEach((field, index) => {
        setInput(input(el, field), String(values[index]));
      });

      expect(callbacks.onDraftChange).toHaveBeenLastCalledWith(expected);
      click(el, "Apply");
      expect(callbacks.onApply).toHaveBeenCalledOnce();
      expect(callbacks.onApply).toHaveBeenCalledWith(expected);
    },
  );

  it.each([
    ["", "finite number"],
    ["0", "greater than 0%"],
    ["-1", "greater than 0%"],
    ["1e309", "finite number"],
  ])("rejects invalid width %j without committing", (value, message) => {
    const { el, callbacks } = mountEditor();
    const width = input(el, "width");
    setInput(width, value);
    click(el, "Apply");

    expect(callbacks.onApply).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(width.getAttribute("aria-invalid")).toBe("true");
  });

  it("routes Cancel and Reset without applying the draft", () => {
    const { el, callbacks } = mountEditor();
    setInput(input(el, "x"), "25");
    click(el, "Cancel");
    click(el, "Reset Frame");

    expect(callbacks.onApply).not.toHaveBeenCalled();
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(callbacks.onReset).toHaveBeenCalledOnce();
  });
});
