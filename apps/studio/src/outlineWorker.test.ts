import { afterEach, describe, expect, it, vi } from "vitest";

import type { ParamSchema, Scene } from "@harness/core";

import { createOutlineComputeIdentity } from "./outlineComputeProtocol";

describe("outline worker entry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("handles worker messages and posts the runtime response", async () => {
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
    await import("./outlineWorker");

    const scene: Scene = { space: { width: 10, height: 10 }, primitives: [] };
    const schema: ParamSchema = {};
    const identity = createOutlineComputeIdentity({
      sketchId: "empty",
      schema,
      params: {},
      seed: 1,
      sampledT: 0,
      compositionFrame: scene.space,
      tolerance: 0,
      includeFrame: false,
      sourceScene: scene,
    });
    messageListener?.({
      data: { type: "compute", jobId: 3, identity },
    } as MessageEvent<unknown>);

    expect(workerScope.postMessage).toHaveBeenCalledTimes(2);
    expect(workerScope.postMessage.mock.calls[0]?.[0]).toEqual({
      type: "progress",
      jobId: 3,
      snapshot: {
        completedWorkUnits: 0,
        totalWorkUnits: 0,
        terminal: true,
      },
    });
    expect(workerScope.postMessage.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ type: "success", jobId: 3 }),
    );
    expect(Object.keys(workerScope.postMessage.mock.calls[0]?.[0])).toEqual([
      "type",
      "jobId",
      "snapshot",
    ]);
  });

  it("does not answer malformed messages", async () => {
    let messageListener: ((event: MessageEvent<unknown>) => void) | undefined;
    const workerScope = {
      addEventListener: (
        _type: string,
        listener: (event: MessageEvent<unknown>) => void,
      ) => {
        messageListener = listener;
      },
      postMessage: vi.fn(),
    };
    vi.stubGlobal("self", workerScope);
    await import("./outlineWorker");
    messageListener?.({ data: null } as MessageEvent<unknown>);
    expect(workerScope.postMessage).not.toHaveBeenCalled();
  });
});
