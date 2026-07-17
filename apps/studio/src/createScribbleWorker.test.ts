import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "vite";

import { createScribbleWorker } from "./createScribbleWorker";

describe("createScribbleWorker", () => {
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

    expect(createScribbleWorker()).toBe(instance);
    expect(WorkerMock).toHaveBeenCalledOnce();
    const [url, options] = WorkerMock.mock.calls[0]!;
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).pathname).toMatch(/scribbleWorker\.ts$/);
    expect(options).toEqual({ type: "module" });
  });

  it("bundles the dedicated worker entry through Vite", async () => {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      build: {
        write: false,
        lib: {
          entry: new URL("./createScribbleWorker.ts", import.meta.url).pathname,
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
        expect.stringMatching(/^assets\/scribbleWorker-[\w-]+\.js$/),
      ]),
    );
  });
});
