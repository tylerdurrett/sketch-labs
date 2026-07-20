// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PageFrame, PlotProfile } from "@harness/core";

import { PageFramePhysicalFields } from "./PageFramePhysicalFields";
import type { PaperDisplayUnit } from "./paperDisplayUnit";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const PROFILE: PlotProfile = {
  width: 230,
  height: 190,
  insets: { top: 7, right: 11, bottom: 23, left: 19 },
  includeFrame: false,
  toolWidthMillimeters: 0.7,
};
const REPRESENTED_FRAME: PageFrame = {
  x: 0,
  y: 0,
  width: 1_000,
  height: 800,
};
const DRAFT_FRAME: PageFrame = {
  x: 50,
  y: -20,
  width: 900,
  height: 700,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(
  displayUnit: PaperDisplayUnit = "mm",
  initialFrame: PageFrame = DRAFT_FRAME,
) {
  const onFrameChange = vi.fn();

  function ControlledFields() {
    const [frame, setFrame] = useState(initialFrame);
    return (
      <PageFramePhysicalFields
        profile={PROFILE}
        representedFrame={REPRESENTED_FRAME}
        frame={frame}
        displayUnit={displayUnit}
        onFrameChange={(next) => {
          onFrameChange(next);
          setFrame(next);
        }}
      />
    );
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ControlledFields />));
  return { el: container, onFrameChange };
}

function field(
  el: HTMLElement,
  dimension: "width" | "height",
): HTMLInputElement {
  const found = el.querySelector<HTMLInputElement>(
    `input[name="physical-${dimension}"]`,
  );
  if (found === null) throw new Error(`No physical ${dimension} input`);
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

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("PageFramePhysicalFields", () => {
  it("shows total paper dimensions in canonical millimeters", () => {
    const { el } = mount();

    expect(field(el, "width").value).toBe("210");
    expect(field(el, "height").value).toBe("170");
    expect(field(el, "width").getAttribute("aria-label")).toBe(
      "Page width (mm)",
    );
  });

  it("changes only the selected draft extent and preserves its origin", () => {
    const { el, onFrameChange } = mount();

    setInput(field(el, "width"), "130");

    expect(onFrameChange).toHaveBeenLastCalledWith({
      x: 50,
      y: -20,
      width: 500,
      height: 700,
    });
    expect(field(el, "height").value).toBe("170");
  });

  it("converts inch display edits back to canonical millimeters", () => {
    const { el, onFrameChange } = mount("in");

    expect(field(el, "width").value).toBe("8.268");
    expect(field(el, "height").value).toBe("6.693");
    setInput(field(el, "width"), "10");

    expect(onFrameChange).toHaveBeenLastCalledWith({
      ...DRAFT_FRAME,
      width: 1_120,
    });
  });

  it.each(["", "-1", "0", "1e309"])(
    "rejects invalid physical width %j without changing the frame",
    (value) => {
      const { el, onFrameChange } = mount();
      const width = field(el, "width");

      setInput(width, value);

      expect(onFrameChange).not.toHaveBeenCalled();
      expect(width.getAttribute("aria-invalid")).toBe("true");
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(
        "finite positive",
      );
    },
  );

  it("rejects an inch value that overflows during canonical conversion", () => {
    const { el, onFrameChange } = mount("in");
    const width = field(el, "width");

    setInput(width, "1e307");

    expect(onFrameChange).not.toHaveBeenCalled();
    expect(width.getAttribute("aria-invalid")).toBe("true");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "finite positive",
    );
  });

  it("rejects a total dimension exhausted by fixed physical insets", () => {
    const { el, onFrameChange } = mount();
    const width = field(el, "width");

    setInput(width, "30");

    expect(onFrameChange).not.toHaveBeenCalled();
    expect(width.getAttribute("aria-invalid")).toBe("true");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "must exceed the fixed horizontal paper insets",
    );
  });

  it("synchronizes both fields when the controlled frame changes externally", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root!.render(
        <PageFramePhysicalFields
          profile={PROFILE}
          representedFrame={REPRESENTED_FRAME}
          frame={DRAFT_FRAME}
          displayUnit="mm"
          onFrameChange={vi.fn()}
        />,
      ),
    );
    setInput(field(container, "width"), "bad");

    act(() =>
      root!.render(
        <PageFramePhysicalFields
          profile={PROFILE}
          representedFrame={REPRESENTED_FRAME}
          frame={{ ...DRAFT_FRAME, width: 500, height: 400 }}
          displayUnit="mm"
          onFrameChange={vi.fn()}
        />,
      ),
    );

    expect(field(container, "width").value).toBe("130");
    expect(field(container, "height").value).toBe("110");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows exact Page dimensions and every inset as immutable in fixed-page mode", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onFrameChange = vi.fn();

    act(() =>
      root!.render(
        <PageFramePhysicalFields
          profile={PROFILE}
          representedFrame={REPRESENTED_FRAME}
          frame={REPRESENTED_FRAME}
          displayUnit="mm"
          onFrameChange={onFrameChange}
          readOnly
        />,
      ),
    );

    expect(field(container, "width").value).toBe("230");
    expect(field(container, "height").value).toBe("190");
    expect(field(container, "width").readOnly).toBe(true);
    expect(field(container, "height").readOnly).toBe(true);
    const expected = { top: "7", right: "11", bottom: "23", left: "19" };
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const inset = container.querySelector<HTMLInputElement>(
        `input[name="physical-inset-${side}"]`,
      );
      expect(inset?.value).toBe(expected[side]);
      expect(inset?.readOnly).toBe(true);
    }

    setInput(field(container, "width"), "999");
    expect(onFrameChange).not.toHaveBeenCalled();
  });
});
