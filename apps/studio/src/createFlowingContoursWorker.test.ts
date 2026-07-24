import { afterEach, describe, expect, it, vi } from "vitest";

import { createFlowingContoursWorker } from "./createFlowingContoursWorker";

describe("createFlowingContoursWorker", () => {
  const original = globalThis.Worker;

  afterEach(() => {
    globalThis.Worker = original;
  });

  it("constructs the dedicated Vite module worker", () => {
    const instance = {} as Worker;
    const WorkerMock = vi.fn<
      [url: string | URL, options?: WorkerOptions],
      Worker
    >(() => instance);
    globalThis.Worker = WorkerMock as unknown as typeof Worker;

    expect(createFlowingContoursWorker()).toBe(instance);
    const [url, options] = WorkerMock.mock.calls[0]!;
    expect((url as URL).pathname).toMatch(/flowingContoursWorker\.ts$/);
    expect(options).toEqual({ type: "module" });
  });
});
