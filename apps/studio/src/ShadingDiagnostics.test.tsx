// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ShadingDiagnostics as CoreShadingDiagnostics,
} from "@harness/core";

import {
  ShadingDiagnostics,
  type ShadingDiagnosticsProps,
} from "./ShadingDiagnostics";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const converged: CoreShadingDiagnostics = {
  termination: "completed",
  pathLength: 1_234.567,
  polylineCount: 48,
  penLiftCount: 47,
  fidelity: { kind: "scribble", residualError: 0.0234 },
};

const exhausted: CoreShadingDiagnostics = {
  ...converged,
  termination: "budget-exhausted",
  fidelity: { kind: "scribble", residualError: 0.2 },
};

const stoppedEarly: CoreShadingDiagnostics = {
  ...converged,
  termination: "stopped-early",
  fidelity: { kind: "scribble", residualError: 0.12 },
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: ShadingDiagnosticsProps): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ShadingDiagnostics {...props} />));
  return container;
}

function disclosure(el: HTMLElement): HTMLDetailsElement {
  const details = el.querySelector("details");
  if (details === null) throw new Error("no diagnostics disclosure");
  return details;
}

function expand(el: HTMLElement): void {
  const summary = el.querySelector("summary");
  if (summary === null) throw new Error("no diagnostics summary");
  act(() => summary.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function lane(el: HTMLElement, name: string): HTMLElement {
  const section = el.querySelector<HTMLElement>(
    `section[aria-label="${name}"]`,
  );
  if (section === null) throw new Error(`no ${name} lane`);
  return section;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("ShadingDiagnostics", () => {
  it("starts collapsed and keeps stale replacement status in the summary", () => {
    const el = mount({
      displayed: {
        freshness: "stale",
        diagnostics: exhausted,
        computeTimeMs: 842,
      },
      preparation: {
        kind: "preparing",
        progress: {
          completedWorkUnits: 25,
          totalWorkUnits: 100,
          terminal: false,
        },
        eta: { kind: "remaining", revision: 2, remainingMs: 12_500 },
      },
    });

    const details = disclosure(el);
    expect(details.open).toBe(false);
    const summary = details.querySelector("summary")!;
    expect(summary.textContent).toContain("Shading");
    expect(summary.textContent).toContain("Displayed result: stale");
    expect(summary.textContent).toContain("Displayed result: budget exhausted");
    expect(summary.textContent).toContain("Preparing 25%");
    expect(
      [...summary.querySelectorAll('[role="status"]')].map(
        (status) => status.textContent,
      ),
    ).toEqual([
      "Displayed result: stale",
      "Displayed result: budget exhausted",
    ]);

    expand(el);
    expect(details.open).toBe(true);
  });

  it("splits retained final metrics from replacement progress and ETA", () => {
    const el = mount({
      displayed: {
        freshness: "stale",
        diagnostics: converged,
        computeTimeMs: 842,
      },
      preparation: {
        kind: "preparing",
        progress: {
          completedWorkUnits: 25,
          totalWorkUnits: 100,
          terminal: false,
        },
        eta: { kind: "remaining", revision: 2, remainingMs: 12_500 },
      },
    });
    expand(el);

    const retained = lane(el, "Displayed result (stale)");
    expect(retained.textContent).toContain("Termination");
    expect(retained.textContent).toContain("Converged");
    expect(retained.textContent).toContain("Residual error2.34%");
    expect(retained.textContent).toContain("Compute time842 ms");
    expect(retained.textContent).toContain("Path length1,234.57 units");
    expect(retained.textContent).toContain("Polylines48");
    expect(retained.textContent).toContain("Pen lifts47");
    expect(retained.textContent).not.toContain("Estimated time remaining");
    expect(retained.querySelector("progress")).toBeNull();

    const replacement = lane(el, "Preparing replacement");
    expect(replacement.getAttribute("aria-busy")).toBe("true");
    expect(replacement.textContent).toContain("Progress");
    expect(replacement.textContent).toContain("25% (25 of 100 work units)");
    expect(replacement.textContent).toContain("Estimated time remaining");
    expect(replacement.textContent).toContain("12.5 s");
    expect(replacement.textContent).not.toContain("Residual error");
    expect(replacement.textContent).not.toContain("Compute time");
    expect(replacement.textContent).not.toContain("Path length");

    const progress = replacement.querySelector("progress")!;
    expect(progress.getAttribute("aria-label")).toBe(
      "Preparing replacement progress",
    );
    expect(progress.getAttribute("aria-valuetext")).toBe("25% complete");
    expect(progress.value).toBe(25);
    expect(progress.max).toBe(100);
  });

  it("reports an idle current result as converged", () => {
    const el = mount({
      displayed: {
        freshness: "current",
        diagnostics: converged,
        computeTimeMs: 1_250,
      },
      preparation: { kind: "idle" },
    });

    const summary = el.querySelector("summary")!;
    expect(summary.textContent).toContain("Converged");
    expect(summary.textContent).not.toContain("Current result:");
    expect(summary.querySelectorAll('[role="status"]')).toHaveLength(1);

    expand(el);
    const displayed = lane(el, "Displayed result");
    expect(displayed.textContent).toContain("TerminationConverged");
    expect(displayed.textContent).toContain("Compute time1.3 s");
    expect(
      el.querySelector('section[aria-label="Preparing replacement"]'),
    ).toBeNull();
  });

  it("keeps a current budget-exhausted result visible as a warning, not an error", () => {
    const el = mount({
      displayed: {
        freshness: "current",
        diagnostics: exhausted,
        computeTimeMs: 65_000,
      },
      preparation: { kind: "idle" },
    });

    const details = disclosure(el);
    expect(details.open).toBe(false);
    const warning = details.querySelector('summary [role="status"]');
    expect(warning?.textContent).toContain("Budget exhausted");
    expect(warning?.textContent).not.toContain("Current result:");
    expect(details.querySelector('summary [role="alert"]')).toBeNull();

    expand(el);
    const displayed = lane(el, "Displayed result");
    const boundedWarning = displayed.querySelector('[role="status"]');
    expect(boundedWarning?.textContent).toContain("bounded partial result");
    expect(boundedWarning?.textContent).toContain("not a computation error");
    expect(displayed.querySelector('[role="alert"]')).toBeNull();
    expect(displayed.textContent).toContain("TerminationBudget exhausted");
    expect(displayed.textContent).toContain("Residual error20.00%");
    expect(displayed.textContent).toContain("Compute time1 min 5 s");
  });

  it("presents an authored early stop as a neutral finished result", () => {
    const el = mount({
      displayed: {
        freshness: "current",
        diagnostics: stoppedEarly,
        computeTimeMs: 500,
      },
      preparation: { kind: "idle" },
    });

    const summaryStatus = el.querySelector('summary [role="status"]');
    expect(summaryStatus?.textContent).toBe("Stopped early");
    expect(summaryStatus?.className).not.toContain("amber");

    expand(el);
    const displayed = lane(el, "Displayed result");
    expect(displayed.textContent).toContain("TerminationStopped early");
    expect(displayed.textContent).not.toContain("safety budget");
  });

  it("names the initial preparation and exposes an estimating ETA", () => {
    const el = mount({
      displayed: null,
      preparation: {
        kind: "preparing",
        progress: {
          completedWorkUnits: 0,
          totalWorkUnits: 400,
          terminal: false,
        },
        eta: { kind: "estimating", revision: 0 },
      },
    });
    expand(el);

    const preparing = lane(el, "Preparing result");
    expect(preparing.textContent).toContain("0% (0 of 400 work units)");
    expect(preparing.textContent).toContain(
      "Estimated time remainingEstimating…",
    );
    expect(
      el.querySelector('section[aria-label^="Displayed result"]'),
    ).toBeNull();
  });

  it("presents an early terminal snapshot as complete and keeps its percentage as budget usage", () => {
    const el = mount({
      displayed: {
        freshness: "stale",
        diagnostics: converged,
        computeTimeMs: 500,
      },
      preparation: {
        kind: "preparing",
        progress: {
          completedWorkUnits: 1,
          totalWorkUnits: 6,
          terminal: true,
        },
        eta: { kind: "remaining", revision: 1, remainingMs: 0 },
      },
    });

    const summary = el.querySelector("summary")!;
    expect(summary.textContent).toContain("Displayed result: stale");
    expect(summary.textContent).toContain("Preparation complete");
    expect(summary.textContent).not.toContain("Preparing 17%");

    expand(el);
    const prepared = lane(el, "Replacement prepared");
    expect(prepared.getAttribute("aria-busy")).toBe("false");
    expect(prepared.textContent).toContain("Work budget used");
    expect(prepared.textContent).toContain("17% (1 of 6 work units)");
    expect(prepared.textContent).toContain("Preparation statusComplete");
    expect(prepared.textContent).not.toContain("Estimated time remaining");
    const budget = prepared.querySelector("progress")!;
    expect(budget.getAttribute("aria-label")).toBe(
      "Replacement prepared work budget used",
    );
    expect(budget.getAttribute("aria-valuetext")).toBe(
      "Preparation complete; 1 of 6 work-budget units used",
    );
    expect(budget.value).toBe(1);
    expect(budget.max).toBe(6);
  });

  it("keeps zero-work terminal budget usage empty while reporting completion", () => {
    const el = mount({
      displayed: null,
      preparation: {
        kind: "preparing",
        progress: {
          completedWorkUnits: 0,
          totalWorkUnits: 0,
          terminal: true,
        },
        eta: { kind: "remaining", revision: 1, remainingMs: 0 },
      },
    });

    const summary = el.querySelector("summary")!;
    expect(summary.textContent).toContain("Preparation complete");
    expand(el);

    const prepared = lane(el, "Result prepared");
    expect(prepared.textContent).toContain("Work budget used");
    expect(prepared.textContent).toContain("0% (0 of 0 work units)");
    expect(prepared.textContent).toContain("Preparation statusComplete");
    const budget = prepared.querySelector("progress")!;
    expect(budget.getAttribute("aria-valuetext")).toBe(
      "Preparation complete; 0 of 0 work-budget units used",
    );
    expect(budget.value).toBe(0);
    expect(budget.max).toBe(1);
  });

  it("attributes a safe preparation failure without erasing the stale display warning", () => {
    const retry = vi.fn();
    const el = mount({
      displayed: {
        freshness: "stale",
        diagnostics: exhausted,
        computeTimeMs: 500,
      },
      preparation: {
        kind: "failure",
        message: "Shading worker returned an invalid response",
        onRetry: retry,
      },
    });

    const summary = el.querySelector("summary")!;
    expect(summary.textContent).toContain("Displayed result: stale");
    expect(summary.textContent).toContain("Preparation failed");
    expect(
      [...summary.querySelectorAll('[role="status"]')].map(
        (status) => status.textContent,
      ),
    ).toEqual([
      "Displayed result: stale",
      "Displayed result: budget exhausted",
      "Preparation failed",
    ]);

    expand(el);
    const retained = lane(el, "Displayed result (stale)");
    expect(retained.textContent).toContain("Residual error20.00%");
    const failure = lane(el, "Replacement preparation");
    const alert = failure.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(
      "Preparation failed: Shading worker returned an invalid response",
    );
    expect(failure.textContent).not.toContain("Residual error");
    const retryButton = failure.querySelector<HTMLButtonElement>("button");
    expect(retryButton?.textContent).toBe("Retry");
    act(() => retryButton?.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("shows an accessible empty state without inventing result metrics", () => {
    const el = mount({
      displayed: null,
      preparation: { kind: "idle" },
    });
    expand(el);

    expect(el.textContent).toContain("No shading result yet.");
    expect(el.querySelector("section")).toBeNull();
    expect(el.querySelector("progress")).toBeNull();
  });

  it("normalizes rounded seconds before splitting minute durations", () => {
    const el = mount({
      displayed: {
        freshness: "current",
        diagnostics: converged,
        computeTimeMs: 119_999,
      },
      preparation: { kind: "idle" },
    });
    expand(el);

    const displayed = lane(el, "Displayed result");
    expect(displayed.textContent).toContain("Compute time2 min");
    expect(displayed.textContent).not.toContain("1 min 60 s");
  });
});
