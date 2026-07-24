import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "vite";

import {
  createPlotStageWorker,
  type PlotStageWorkerFactory,
} from "./createPlotStageWorker";

describe("createPlotStageWorker", () => {
  const originalWorker = globalThis.Worker;

  afterEach(() => {
    globalThis.Worker = originalWorker;
  });

  it("constructs the Vite-resolved dedicated module worker entry", () => {
    const instance = {} as Worker;
    const WorkerMock = vi.fn<
      [url: string | URL, options?: WorkerOptions],
      Worker
    >(() => instance);
    globalThis.Worker = WorkerMock as unknown as typeof Worker;
    const factory: PlotStageWorkerFactory = createPlotStageWorker;

    expect(factory()).toBe(instance);
    const [url, options] = WorkerMock.mock.calls[0]!;
    expect((url as URL).pathname).toMatch(/plotStageWorker\.ts$/);
    expect(options).toEqual({ type: "module" });
  });

  it("leaves constructor failures for the shared worker boundary to normalize", () => {
    const constructionError = new DOMException(
      "Worker construction was blocked",
      "SecurityError",
    );
    const WorkerMock = vi.fn(() => {
      throw constructionError;
    });
    globalThis.Worker = WorkerMock as unknown as typeof Worker;

    expect(() => createPlotStageWorker()).toThrow(constructionError);
    expect(WorkerMock).toHaveBeenCalledOnce();
  });

  it("bundles the worker entry through Vite", async () => {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      build: {
        write: false,
        lib: {
          entry: new URL("./createPlotStageWorker.ts", import.meta.url)
            .pathname,
          formats: ["es"],
        },
      },
    });
    if ("close" in result) throw new Error("expected completed Vite build");
    const outputs = Array.isArray(result)
      ? result.flatMap(({ output }) => output)
      : result.output;
    expect(outputs.map(({ fileName }) => fileName)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^assets\/plotStageWorker-[\w-]+\.js$/),
      ]),
    );
  });
});
