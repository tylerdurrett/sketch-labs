import { describe, expect, it, vi } from "vitest";

import {
  terminateWorkerOnce,
  workerErrorDetail,
  workerEventDetail,
} from "./workerBoundary";

describe("worker boundary helpers", () => {
  it("returns bounded Error and event details with safe fallbacks", () => {
    const longDetail = "x".repeat(600);

    expect(workerErrorDetail(new Error(longDetail), "fallback")).toBe(
      longDetail.slice(0, 500),
    );
    expect(workerErrorDetail(new Error("  "), "fallback")).toBe("fallback");
    expect(workerErrorDetail("not an Error", "fallback")).toBe("fallback");
    expect(
      workerEventDetail(
        { message: longDetail } as unknown as Event,
        "fallback",
      ),
    ).toBe(longDetail.slice(0, 500));
    expect(workerEventDetail(new Event("error"), "fallback")).toBe(
      "fallback",
    );
  });

  it("terminates a worker exactly once", () => {
    const worker = { terminate: vi.fn() };
    const terminate = terminateWorkerOnce(worker);

    terminate();
    terminate();
    terminate();

    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
