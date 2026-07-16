// @vitest-environment jsdom
import { act, useImperativeHandle, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { LiveCanvasHandle } from "./LiveCanvas";

/**
 * Focus-retention coverage for the App-owned Sketch switcher (#165).
 *
 * The bug: App re-keys SketchControls with `key={selected.id}`, so picking a new
 * Sketch remounts the whole subtree — including the switcher's DOM, which lives
 * in the inspector INSIDE that keyed instance — dropping keyboard focus from the
 * trigger. Selection state survives (it lives in App), the focused element does
 * not. The fix lives in App (the stable parent above the remount): a stable ref
 * on the trigger plus a `selectedId`-keyed layout effect that re-focuses it after
 * the remount, and only on a switcher-driven change (never on first load).
 *
 * These drive the REAL Base UI Select. LiveCanvas is a browser-only sink
 * (canvas2d/ResizeObserver/matchMedia) irrelevant here, so it is stubbed — the
 * same seam SketchControls.test mocks — leaving the switcher wiring under test.
 */

// React 19's `act` requires this flag; vitest's jsdom env does not set it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("./LiveCanvas", () => ({
  LiveCanvas: ({
    params,
    renderState,
    handleRef,
  }: {
    params: Readonly<Record<string, unknown>>;
    renderState?: { kind: string };
    handleRef?: Ref<LiveCanvasHandle>;
  }) => {
    useImperativeHandle(handleRef, () => ({
      getCanvas: () => null,
      getCurrentT: () => 0,
      getDisplayedScene: () => null,
      captureDisplayedFrame: () => ({
        scene: { space: { width: 100, height: 100 }, primitives: [] },
        t: 0,
        renderMode: "fill" as const,
        tolerance: 0,
        includeFrame: true,
        inputRevision: 0,
      }),
    }));
    return (
      <div
        data-testid="canvas"
        data-params={JSON.stringify(params)}
        data-render-state={renderState?.kind ?? "fill-live"}
      />
    );
  },
}));

const exportJob = vi.hoisted(() => ({
  resolve: null as null | ((result: {
    status: "cancelled";
    jobId: number;
  }) => void),
}));

vi.mock("./hiddenLineCoordinator", () => ({
  HiddenLineCoordinator: class {
    startExport() {
      return new Promise((resolve) => {
        exportJob.resolve = resolve;
      });
    }
    cancel() {
      exportJob.resolve?.({ status: "cancelled", jobId: 1 });
      exportJob.resolve = null;
      return true;
    }
    dispose() {
      this.cancel();
    }
  },
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mountApp(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<App />);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
  exportJob.resolve = null;
});

/** The switcher's trigger button, resolved fresh each call (it is remounted). */
function trigger(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Sketches"]',
  );
  if (el === null) throw new Error("no switcher trigger");
  return el;
}

/**
 * Commit a Base UI Select option by its visible label. Base UI's item `onClick`
 * bails for a MOUSE pointer unless the row is highlighted (a hover state jsdom
 * can't produce), but commits for a TOUCH pointer regardless — so a touch-typed
 * pointerdown/up before the click drives a real selection headlessly.
 */
function selectOption(label: string): void {
  act(() => {
    trigger().click(); // open the popup
  });
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (o) => o.textContent === label,
  );
  if (option === undefined) throw new Error(`no option labelled ${label}`);
  act(() => {
    for (const type of ["pointerdown", "pointerup"]) {
      const ev = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
      }) as MouseEvent & { pointerType: string; pointerId: number };
      ev.pointerType = "touch";
      ev.pointerId = 1;
      option.dispatchEvent(ev);
    }
    (option as HTMLElement).click();
  });
}

function setNumberInput(input: HTMLInputElement, value: string): void {
  act(() => input.focus());
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => input.blur());
}

function pressUndo(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "z",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => window.dispatchEvent(event));
  return event;
}

describe("App — switcher focus retention (#165)", () => {
  it("restores focus to the trigger after a sketch selection remounts the subtree", () => {
    mountApp();

    const before = trigger().textContent;
    act(() => {
      trigger().focus();
    });
    expect(document.activeElement).toBe(trigger());

    // Pick a DIFFERENT sketch so `selectedId` changes and SketchControls
    // remounts (key={selected.id}), destroying and recreating the trigger DOM.
    selectOption("Circles");

    // Selection took effect (the trigger now shows the new sketch)...
    expect(trigger().textContent).toBe("Circles");
    expect(trigger().textContent).not.toBe(before);
    // ...and focus was restored to the freshly-remounted trigger — the bug was
    // that the keyed remount dropped it. `trigger()` re-resolves the NEW button.
    expect(document.activeElement).toBe(trigger());
  });

  it("does not steal focus on first load (no switcher-driven change yet)", () => {
    mountApp();

    // On mount the layout effect must NOT grab focus for the trigger — nobody
    // selected anything, so the page's initial focus is left untouched.
    expect(document.activeElement).not.toBe(trigger());
  });
});

describe("App — keyed edit-history sessions", () => {
  it("cannot traverse an old sketch's history after switching or fresh remounting", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
    mountApp();
    selectOption("Scribble Moon");
    const firstSketch = trigger().textContent!;
    const input = document.querySelector<HTMLInputElement>(
      '#inspector input[id^="control-"]',
    )!;
    const inputId = input.id;
    const initial = input.value;
    const changed = String(
      Math.min(
        Number(input.max),
        Math.max(Number(input.min), Number(initial) + 1),
      ),
    );
    setNumberInput(
      input,
      changed === initial ? String(Number(initial) - 1) : changed,
    );
    expect(
      document.querySelector<HTMLInputElement>(`#${inputId}`)?.value,
    ).not.toBe(initial);

    selectOption("Circles");
    const circlesBefore = document
      .querySelector('[data-testid="canvas"]')
      ?.getAttribute("data-params");
    expect(pressUndo().defaultPrevented).toBe(false);
    expect(
      document
        .querySelector('[data-testid="canvas"]')
        ?.getAttribute("data-params"),
    ).toBe(circlesBefore);

    selectOption(firstSketch);
    expect(document.querySelector<HTMLInputElement>(`#${inputId}`)?.value).toBe(
      initial,
    );
    expect(pressUndo().defaultPrevented).toBe(false);

    act(() => root!.unmount());
    root = createRoot(container!);
    act(() => root!.render(<App />));
    expect(pressUndo().defaultPrevented).toBe(false);
  });
});

describe("App — Tone Calibration integration (#324)", () => {
  it("opens on the control-free calibration target and resets its diagnostic view after switching", () => {
    mountApp();

    expect(trigger().textContent).toBe("Tone Calibration");
    expect(
      document.querySelector('#inspector input[id^="control-"]'),
    ).toBeNull();
    expect(document.querySelector("#sketch-seed")).not.toBeNull();
    expect(
      [...document.querySelectorAll("button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(expect.arrayContaining(["New seed", "Randomize", "Export PNG"]));

    const tone = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Tone",
    )!;
    act(() => tone.click());
    expect(
      document
        .querySelector('[data-testid="canvas"]')
        ?.getAttribute("data-render-state"),
    ).toBe("tone-reference");

    selectOption("Circles");
    selectOption("Tone Calibration");

    expect(
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Fill",
      )?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      document
        .querySelector('[data-testid="canvas"]')
        ?.getAttribute("data-render-state"),
    ).toBe("fill-live");
  });
});

describe("App — hidden-line navigation guard (#289)", () => {
  it("disables Sketch navigation for the full active interval with the exact reason", () => {
    mountApp();
    const outlineChoice = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Outline",
    ) as HTMLButtonElement;
    act(() => outlineChoice.click());

    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute("aria-describedby")).toBe(
      "sketch-switch-disabled-reason",
    );
    const wrapper = trigger().parentElement!;
    expect(wrapper.title).toBe(
      "Finish or cancel the hidden-line job before switching Sketches.",
    );
    expect(
      document.querySelector("#sketch-switch-disabled-reason")?.textContent,
    ).toContain(
      "Finish or cancel the hidden-line job before switching Sketches.",
    );

    const fillChoice = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Fill",
    ) as HTMLButtonElement;
    act(() => fillChoice.click());
    expect(trigger().disabled).toBe(false);
  });

  it("guards navigation for an export while inspector collapse remains available", async () => {
    mountApp();
    const exportButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Export Hidden-line SVG",
    ) as HTMLButtonElement;
    act(() => exportButton.click());

    expect(trigger().disabled).toBe(true);
    const collapse = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide inspector"]',
    )!;
    expect(collapse.disabled).toBe(false);
    act(() => collapse.click());
    expect(document.querySelector("#inspector")?.hasAttribute("hidden")).toBe(
      true,
    );

    const cancel = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel export",
    ) as HTMLButtonElement;
    await act(async () => {
      cancel.click();
      await Promise.resolve();
    });
    expect(trigger().disabled).toBe(false);
  });
});
