import { afterEach, describe, expect, it, vi } from "vitest";

import { createScribbleComputeIdentity } from "./scribbleComputeProtocol";

describe("Scribble worker entry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("answers only validated Scribble requests through its dedicated runtime", async () => {
    let messageListener: ((event: MessageEvent<unknown>) => void) | undefined;
    const workerScope = {
      addEventListener: vi.fn(
        (type: string, listener: (event: MessageEvent<unknown>) => void) => {
          if (type === "message") messageListener = listener;
        },
      ),
      postMessage: vi.fn(),
    };
    vi.stubGlobal("self", workerScope);
    await import("./scribbleWorker");

    messageListener?.({ data: null } as MessageEvent<unknown>);
    messageListener?.({
      data: { type: "preview", jobKind: "preview", jobId: 1 },
    } as MessageEvent<unknown>);
    expect(workerScope.postMessage).not.toHaveBeenCalled();

    const identity = createScribbleComputeIdentity({
      sketchId: "circles",
      schema: {},
      params: {},
      seed: 1,
      compositionFrame: { width: 10, height: 10 },
    });
    messageListener?.({
      data: { type: "compute", jobId: 3, identity },
    } as MessageEvent<unknown>);

    expect(workerScope.postMessage).toHaveBeenCalledOnce();
    expect(workerScope.postMessage).toHaveBeenCalledWith({
      type: "failure",
      jobId: 3,
      identity,
      error: "Sketch circles has no Scribble artwork generator",
    });
  });
});
