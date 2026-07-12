// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditTransactionLifecycle } from "./editHistory";
import { SeedControl } from "./SeedControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function lifecycle(): EditTransactionLifecycle<number> {
  return {
    onBegin: vi.fn(),
    onPreview: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
  };
}

function mount(value: number, editHistory: EditTransactionLifecycle<number>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<SeedControl value={value} editHistory={editHistory} />));
  return container.querySelector<HTMLInputElement>("#sketch-seed")!;
}

function enterText(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("SeedControl", () => {
  it("begins on focus, previews valid numbers live, and commits once on blur", () => {
    const history = lifecycle();
    const input = mount(12, history);

    act(() => input.focus());
    enterText(input, "34");
    act(() => input.blur());

    expect(history.onBegin).toHaveBeenCalledTimes(1);
    expect(history.onPreview).toHaveBeenCalledWith(34);
    expect(history.onCommit).toHaveBeenCalledTimes(1);
    expect(history.onCancel).not.toHaveBeenCalled();
  });

  it("keeps blank and invalid numeric drafts out of the preview", () => {
    const history = lifecycle();
    const input = mount(12, history);

    act(() => input.focus());
    enterText(input, "");
    enterText(input, "NaN");

    expect(input.value).toBe("");
    expect(history.onPreview).not.toHaveBeenCalled();
  });

  it("commits once on Enter even though Enter also blurs the field", () => {
    const history = lifecycle();
    const input = mount(12, history);

    act(() => input.focus());
    enterText(input, "34");
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );

    expect(history.onCommit).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(input);
  });

  it("Escape restores the focus-time value, cancels, and suppresses blur commit", () => {
    const history = lifecycle();
    const input = mount(12, history);

    act(() => input.focus());
    enterText(input, "34");
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );

    expect(input.value).toBe("12");
    expect(history.onCancel).toHaveBeenCalledTimes(1);
    expect(history.onCommit).not.toHaveBeenCalled();
  });
});
