// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditTransactionLifecycle } from "./editHistory";
import { SIMPLIFY_MAX, SimplifyControl } from "./SimplifyControl";

vi.mock("./components/ui/slider", () => ({
  Slider: ({
    value,
    onValueChange,
    onValueCommitted,
  }: {
    value: number;
    onValueChange: (value: number) => void;
    onValueCommitted: (value: number) => void;
  }) => (
    <div data-slider-value={value}>
      <button data-testid="preview-one" onClick={() => onValueChange(0.5)} />
      <button data-testid="preview-two" onClick={() => onValueChange(1.5)} />
      {(["pointer", "track", "keyboard"] as const).map((path) => (
        <button
          key={path}
          data-testid={path}
          onClick={() => {
            onValueChange(1);
            onValueCommitted(1);
          }}
        />
      ))}
      <button data-testid="commit" onClick={() => onValueCommitted(value)} />
    </div>
  ),
}));

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

function mount(initialValue: number, history: EditTransactionLifecycle<number>) {
  function Harness() {
    const [value, setValue] = useState(initialValue);
    return (
      <SimplifyControl
        value={value}
        editHistory={{
          ...history,
          onPreview: (next) => {
            history.onPreview(next);
            setValue(next);
          },
        }}
      />
    );
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Harness />));
  return container;
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

function click(el: HTMLElement, testId: string) {
  act(() =>
    el
      .querySelector<HTMLElement>(`[data-testid="${testId}"]`)!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("SimplifyControl numeric entry", () => {
  it("previews clamped values and commits once on blur", () => {
    const history = lifecycle();
    const el = mount(0, history);
    const input = el.querySelector<HTMLInputElement>("#sketch-tolerance")!;

    act(() => input.focus());
    enterText(input, "9");
    act(() => input.blur());

    expect(history.onBegin).toHaveBeenCalledTimes(1);
    expect(history.onPreview).toHaveBeenCalledWith(SIMPLIFY_MAX);
    expect(history.onCommit).toHaveBeenCalledTimes(1);
  });

  it("keeps blank drafts local and cancels back to the focus-time value", () => {
    const history = lifecycle();
    const el = mount(0.25, history);
    const input = el.querySelector<HTMLInputElement>("#sketch-tolerance")!;

    act(() => input.focus());
    enterText(input, "");
    expect(history.onPreview).not.toHaveBeenCalled();
    enterText(input, "1.25");
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );

    expect(input.value).toBe("0.25");
    expect(history.onCancel).toHaveBeenCalledTimes(1);
    expect(history.onCommit).not.toHaveBeenCalled();
  });

  it("does not duplicate an Enter commit when the field blurs", () => {
    const history = lifecycle();
    const el = mount(0, history);
    const input = el.querySelector<HTMLInputElement>("#sketch-tolerance")!;

    act(() => input.focus());
    enterText(input, "1");
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );

    expect(history.onCommit).toHaveBeenCalledTimes(1);
  });
});

describe("SimplifyControl slider", () => {
  it("begins before the first preview, groups repeated previews, and commits only when settled", () => {
    const history = lifecycle();
    const el = mount(0, history);

    click(el, "preview-one");
    click(el, "preview-two");
    expect(history.onBegin).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(history.onBegin).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(history.onPreview).mock.invocationCallOrder[0]!,
    );
    expect(history.onPreview).toHaveBeenNthCalledWith(1, 0.5);
    expect(history.onPreview).toHaveBeenNthCalledWith(2, 1.5);
    expect(history.onCommit).not.toHaveBeenCalled();

    click(el, "commit");
    expect(history.onCommit).toHaveBeenCalledTimes(1);
  });

  it.each(["pointer", "track", "keyboard"])(
    "uses one begin/preview/commit transaction for %s settlement",
    (path) => {
      const history = lifecycle();
      const el = mount(0, history);

      click(el, path);

      expect(history.onBegin).toHaveBeenCalledTimes(1);
      expect(history.onPreview).toHaveBeenCalledTimes(1);
      expect(history.onCommit).toHaveBeenCalledTimes(1);
    },
  );
});
