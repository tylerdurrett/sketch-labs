import { afterEach, describe, expect, it, vi } from "vitest";

import { createOutlineWorker } from "./createOutlineWorker";

describe("createOutlineWorker", () => {
  const originalWorker = globalThis.Worker;

  afterEach(() => {
    globalThis.Worker = originalWorker;
  });

  it("constructs the Vite-resolved module worker entry", () => {
    const instance = {} as Worker;
    const WorkerMock = vi.fn<
      [url: string | URL, options?: WorkerOptions],
      Worker
    >(() => instance);
    globalThis.Worker = WorkerMock as unknown as typeof Worker;

    expect(createOutlineWorker()).toBe(instance);
    expect(WorkerMock).toHaveBeenCalledOnce();
    const [url, options] = WorkerMock.mock.calls[0]!;
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).pathname).toMatch(/outlineWorker\.ts$/);
    expect(options).toEqual({ type: "module" });
  });
});
