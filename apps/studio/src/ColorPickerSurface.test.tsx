// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ColorPickerSurface } from "./ColorPickerSurface";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderPicker(
  color: string,
  onChange = vi.fn(),
  onChangeEnd = vi.fn(),
) {
  act(() =>
    root.render(
      <ColorPickerSurface
        paramKey="stroke"
        color={color}
        onChange={onChange}
        onChangeEnd={onChangeEnd}
      />,
    ),
  );
  const sliders = Array.from(
    container.querySelectorAll<HTMLElement>('[role="slider"]'),
  );
  expect(sliders).toHaveLength(2);
  return { saturation: sliders[0]!, hue: sliders[1]!, onChange, onChangeEnd };
}

describe("ColorPickerSurface", () => {
  it("labels the actual inner controls with synchronized numeric state", () => {
    const { saturation, hue } = renderPicker("#336699");

    expect(saturation.getAttribute("aria-label")).toBe(
      "stroke saturation and value",
    );
    expect(saturation.getAttribute("aria-valuemin")).toBe("0");
    expect(saturation.getAttribute("aria-valuemax")).toBe("100");
    expect(saturation.getAttribute("aria-valuenow")).toBe("67");
    expect(saturation.getAttribute("aria-valuetext")).toBe(
      "Saturation 67%, value 60%",
    );
    expect(hue.getAttribute("aria-label")).toBe("stroke hue");
    expect(hue.getAttribute("aria-valuemin")).toBe("0");
    expect(hue.getAttribute("aria-valuemax")).toBe("360");
    expect(hue.getAttribute("aria-valuenow")).toBe("210");
    expect(hue.getAttribute("aria-valuetext")).toBe("210 degrees");
  });

  it("refreshes accessible state when the controlled color changes", async () => {
    const first = renderPicker("#336699");
    act(() =>
      root.render(
        <ColorPickerSurface
          paramKey="fill"
          color="#00ff00"
          onChange={first.onChange}
          onChangeEnd={first.onChangeEnd}
        />,
      ),
    );
    await act(async () => Promise.resolve());

    const [saturation, hue] = Array.from(
      container.querySelectorAll<HTMLElement>('[role="slider"]'),
    );
    expect(saturation?.getAttribute("aria-label")).toBe(
      "fill saturation and value",
    );
    expect(saturation?.getAttribute("aria-valuetext")).toBe(
      "Saturation 100%, value 100%",
    );
    expect(hue?.getAttribute("aria-label")).toBe("fill hue");
    expect(hue?.getAttribute("aria-valuenow")).toBe("120");
  });

  it("uses react-colorful keyboard behavior and settles on keyup", () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    const { hue } = renderPicker("#ff0000", onChange, onChangeEnd);

    act(() => {
      hue.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowRight",
          code: "ArrowRight",
          keyCode: 39,
        }),
      );
    });
    expect(onChange).toHaveBeenCalledWith("#ff4d00");
    expect(onChangeEnd).not.toHaveBeenCalled();

    act(() => {
      hue.dispatchEvent(
        new KeyboardEvent("keyup", {
          bubbles: true,
          key: "ArrowRight",
          code: "ArrowRight",
          keyCode: 39,
        }),
      );
    });
    expect(onChangeEnd).toHaveBeenCalledWith("#ff4d00");
  });

  it("forwards mouse previews and the final gesture value", () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    const { saturation } = renderPicker("#ff0000", onChange, onChangeEnd);
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
    expect(onChange).toHaveBeenCalledWith("#bf6060");

    act(() =>
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })),
    );
    expect(onChangeEnd).toHaveBeenCalledWith("#bf6060");
  });

  it("preserves touch previews and finalization", () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    const { hue } = renderPicker("#ff0000", onChange, onChangeEnd);
    hue.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 360, height: 16 }) as DOMRect;

    act(() => hue.dispatchEvent(touchEvent("touchstart", 120, 8, true)));
    expect(onChange).toHaveBeenCalledWith("#00ff00");

    act(() => window.dispatchEvent(touchEvent("touchend", 120, 8, false)));
    expect(onChangeEnd).toHaveBeenCalledWith("#00ff00");
  });

  it("renders no alpha control", () => {
    renderPicker("#336699");
    expect(container.querySelector(".react-colorful__alpha")).toBeNull();
    expect(container.querySelector('[aria-label*="Alpha"]')).toBeNull();
  });
});

function touchEvent(
  type: "touchstart" | "touchend",
  pageX: number,
  pageY: number,
  active: boolean,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touch = { identifier: 1, pageX, pageY };
  Object.defineProperties(event, {
    touches: { value: active ? [touch] : [] },
    changedTouches: { value: [touch] },
  });
  return event;
}
