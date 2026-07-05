// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

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
  LiveCanvas: () => <div data-testid="canvas" />,
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
