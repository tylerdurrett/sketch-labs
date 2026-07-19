// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PageFrame, PlotProfile } from "@harness/core";

import { PageFrameEditor } from "./PageFrameEditor";
import type { PageFrameAspectConstraint } from "./pageFrameManipulation";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const COMPOSITION = { width: 200, height: 100 };
const FULL_FRAME: PageFrame = { x: 0, y: 0, width: 200, height: 100 };
const PROFILE: PlotProfile = {
  width: 220,
  height: 120,
  insets: { top: 10, right: 10, bottom: 10, left: 10 },
  includeFrame: false,
  toolWidthMillimeters: 0.3,
};
const PHYSICAL_PROPS = {
  profile: PROFILE,
  representedFrame: FULL_FRAME,
  displayUnit: "mm" as const,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mountEditor(initialFrame: PageFrame = FULL_FRAME) {
  const callbacks = {
    onDraftChange: vi.fn(),
    onAspectConstraintChange: vi.fn(),
    onApply: vi.fn(),
    onCancel: vi.fn(),
    onReset: vi.fn(),
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  function ControlledEditor() {
    const [frame, setFrame] = useState(initialFrame);
    return (
      <PageFrameEditor
        compositionFrame={COMPOSITION}
        frame={frame}
        {...PHYSICAL_PROPS}
        onDraftChange={(next) => {
          callbacks.onDraftChange(next);
          setFrame(next);
        }}
        onAspectConstraintChange={callbacks.onAspectConstraintChange}
        onApply={callbacks.onApply}
        onCancel={callbacks.onCancel}
        onReset={callbacks.onReset}
      />
    );
  }

  act(() => {
    root!.render(<ControlledEditor />);
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

function selectOption(el: HTMLElement, value: string): void {
  const select = el.querySelector<HTMLSelectElement>(
    'select[name="aspectConstraint"]',
  );
  if (select === null) throw new Error("No aspect constraint select");
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
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

  it("starts from the exact supplied frame and explains direct manipulation", () => {
    const { el } = mountEditor({ x: -20, y: 10, width: 300, height: 75 });

    expect(el.querySelector("h2")?.textContent).toBe("Edit Page Frame");
    expect(input(el, "x").value).toBe("-10");
    expect(input(el, "y").value).toBe("10");
    expect(input(el, "width").value).toBe("150");
    expect(input(el, "height").value).toBe("75");
    expect(
      [...el.querySelectorAll("button")].map((button) => button.textContent),
    ).toEqual(["Apply", "Cancel", "Reset Frame"]);
    expect(el.textContent).toMatch(/drag an edge or corner/i);
    expect(el.textContent).toMatch(/drag inside.*pan/i);
    expect(el.textContent).toMatch(/hold shift/i);
  });

  it("syncs external frame changes into all four numeric fields", () => {
    const { el, callbacks } = mountEditor();
    setInput(input(el, "x"), "");

    act(() => {
      root!.render(
        <PageFrameEditor
          compositionFrame={COMPOSITION}
          frame={{ x: -50, y: 25, width: 100, height: 75 }}
          {...PHYSICAL_PROPS}
          {...callbacks}
        />,
      );
    });

    expect(input(el, "x").value).toBe("-25");
    expect(input(el, "y").value).toBe("25");
    expect(input(el, "width").value).toBe("50");
    expect(input(el, "height").value).toBe("75");
  });

  it("does not normalize a partial numeric draft when its controlled echo arrives", () => {
    const onDraftChange = vi.fn();

    function Harness() {
      const [frame, setFrame] = useState(FULL_FRAME);
      return (
        <PageFrameEditor
          compositionFrame={COMPOSITION}
          frame={frame}
          {...PHYSICAL_PROPS}
          onDraftChange={(next) => {
            onDraftChange(next);
            setFrame(next);
          }}
          onApply={vi.fn()}
          onCancel={vi.fn()}
          onReset={vi.fn()}
        />
      );
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<Harness />));

    setInput(input(container, "x"), "001");

    expect(onDraftChange).toHaveBeenLastCalledWith({
      x: 2,
      y: 0,
      width: 200,
      height: 100,
    });
    expect(input(container, "x").value).toBe("001");
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

  it("routes a physical paper edit only through the transient draft callback", () => {
    const { el, callbacks } = mountEditor();

    setInput(input(el, "physical-width"), "120");

    expect(callbacks.onDraftChange).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(callbacks.onApply).not.toHaveBeenCalled();
    expect(callbacks.onReset).not.toHaveBeenCalled();
  });

  it("blocks Apply while a physical draft is invalid, then applies its correction", () => {
    const { el, callbacks } = mountEditor();
    const physicalWidth = input(el, "physical-width");

    setInput(physicalWidth, "");
    click(el, "Apply");

    expect(callbacks.onApply).not.toHaveBeenCalled();
    expect(el.querySelector("h2")?.textContent).toBe("Edit Page Frame");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "finite positive",
    );

    setInput(physicalWidth, "120");
    click(el, "Apply");

    expect(callbacks.onApply).toHaveBeenCalledOnce();
    expect(callbacks.onApply).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it.each([
    ["1:1", 1],
    ["4:3", 4 / 3],
    ["3:2", 3 / 2],
    ["16:9", 16 / 9],
  ])("publishes the common %s aspect constraint", (preset, ratio) => {
    const { el, callbacks } = mountEditor();

    selectOption(el, preset);

    expect(callbacks.onAspectConstraintChange).toHaveBeenLastCalledWith({
      kind: "ratio",
      ratio,
    });
  });

  it("pairs W and H percentages under the persistent aspect until Freeform", () => {
    const { el, callbacks } = mountEditor();
    selectOption(el, "4:3");

    setInput(input(el, "width"), "60");

    expect(input(el, "height").value).toBe("90");
    expect(callbacks.onDraftChange).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 120,
      height: 90,
    });

    setInput(input(el, "height"), "60");
    expect(input(el, "width").value).toBe("40");
    expect(callbacks.onDraftChange).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 80,
      height: 60,
    });

    selectOption(el, "free");
    setInput(input(el, "width"), "50");

    expect(input(el, "height").value).toBe("60");
    expect(callbacks.onAspectConstraintChange).toHaveBeenLastCalledWith({
      kind: "free",
    });
  });

  it("validates and publishes a custom positive finite ratio", () => {
    const { el, callbacks } = mountEditor();
    selectOption(el, "custom");
    const customWidth = input(el, "customAspectWidth");
    const customHeight = input(el, "customAspectHeight");

    expect(callbacks.onAspectConstraintChange).toHaveBeenLastCalledWith({
      kind: "ratio",
      ratio: 2,
    });

    setInput(customWidth, "");
    click(el, "Use Custom Ratio");
    expect(callbacks.onAspectConstraintChange).toHaveBeenCalledOnce();
    expect(el.querySelector('[role="alert"]')?.textContent).toMatch(
      /width.*greater than 0/i,
    );
    expect(customWidth.getAttribute("aria-invalid")).toBe("true");

    setInput(customWidth, "5");
    setInput(customHeight, "4");
    click(el, "Use Custom Ratio");

    expect(callbacks.onAspectConstraintChange).toHaveBeenLastCalledWith({
      kind: "ratio",
      ratio: 1.25,
    });
  });

  it("follows externally controlled aspect changes", () => {
    const { el, callbacks } = mountEditor();
    const renderWithConstraint = (
      aspectConstraint: PageFrameAspectConstraint,
    ): void => {
      act(() => {
        root!.render(
          <PageFrameEditor
            compositionFrame={COMPOSITION}
            frame={FULL_FRAME}
            {...PHYSICAL_PROPS}
            aspectConstraint={aspectConstraint}
            {...callbacks}
          />,
        );
      });
    };

    renderWithConstraint({ kind: "ratio", ratio: 16 / 9 });
    expect(
      el.querySelector<HTMLSelectElement>('select[name="aspectConstraint"]')
        ?.value,
    ).toBe("16:9");

    renderWithConstraint({ kind: "free" });
    expect(
      el.querySelector<HTMLSelectElement>('select[name="aspectConstraint"]')
        ?.value,
    ).toBe("free");
  });
});
