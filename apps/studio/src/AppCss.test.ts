import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const appCss = readFileSync(new URL("./App.css", import.meta.url), "utf8");

/** Return one top-level class rule's declarations for structural CSS checks. */
function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(appCss);
  if (match?.[1] === undefined) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1];
}

describe("full-sheet preview geometry CSS", () => {
  it("keeps the sheet edge paint-only so inset percentages use the exact sheet box", () => {
    const sheet = declarations(".plot-sheet");

    expect(sheet).toMatch(/outline:\s*1px solid/);
    expect(sheet).not.toMatch(/(?:^|[;\s])border(?:-[\w-]+)?:/);
    expect(sheet).not.toMatch(/padding(?:-[\w-]+)?:/);
  });

  it("anchors every drawable edge directly to its profile-ratio custom property", () => {
    const drawable = declarations(".plot-drawable");

    expect(drawable).toMatch(/position:\s*absolute/);
    expect(drawable).toMatch(/top:\s*var\(--plot-inset-top/);
    expect(drawable).toMatch(/right:\s*var\(--plot-inset-right/);
    expect(drawable).toMatch(/bottom:\s*var\(--plot-inset-bottom/);
    expect(drawable).toMatch(/left:\s*var\(--plot-inset-left/);
  });

  it("covers the drawable rectangle with unavailable-state feedback", () => {
    const unavailable = declarations(".live-canvas-unavailable");

    expect(unavailable).toMatch(/position:\s*absolute/);
    expect(unavailable).toMatch(/inset:\s*0/);
    expect(unavailable).toMatch(/background:\s*#fff/);
  });
});

describe("Page Frame edit geometry CSS", () => {
  it("contain-fits the combined edit extent and positions Composition independently", () => {
    const view = declarations(".page-frame-edit-view");
    const composition = declarations(".page-frame-edit-composition");

    expect(view).toMatch(/position:\s*relative/);
    expect(view).toMatch(/aspect-ratio:\s*var\(--page-frame-edit-aspect\)/);
    expect(view).toMatch(/width:\s*min\(100cqw,\s*100cqh/);
    expect(composition).toMatch(/position:\s*absolute/);
    expect(composition).toMatch(/left:\s*var\(--page-frame-composition-left\)/);
    expect(composition).toMatch(/top:\s*var\(--page-frame-composition-top\)/);
  });

  it("keeps the dim and boundary overlay visual-only", () => {
    const overlay = declarations(".page-frame-edit-overlay");
    const discarded = declarations(".page-frame-edit-discarded");
    const boundary = declarations(".page-frame-edit-boundary");

    expect(overlay).toMatch(/pointer-events:\s*none/);
    expect(discarded).toMatch(/fill:\s*rgb\(0 0 0 \/ 55%\)/);
    expect(boundary).toMatch(/fill:\s*none/);
    expect(boundary).toMatch(/stroke:/);
  });
});

describe("viewport scroll ownership", () => {
  it("contains absolutely positioned inspector content inside its scrollport", () => {
    const inspector = declarations(".inspector");

    expect(inspector).toMatch(/position:\s*relative/);
  });
});
