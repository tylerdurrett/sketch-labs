import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  prepareImageDetailAnalysis,
} from "@harness/core";

import { createDetailPreparationIdentity } from "./detailPreparationProtocol";

const { handleDetailWorkerMessage } = vi.hoisted(() => ({
  handleDetailWorkerMessage: vi.fn(),
}));

vi.mock("./detailWorkerRuntime", () => ({ handleDetailWorkerMessage }));

describe("Detail worker entry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("posts only validated responses and transfers only prepared scalar storage", async () => {
    let listener: ((event: MessageEvent<unknown>) => void) | undefined;
    const workerScope = {
      addEventListener: vi.fn((type: string, callback: typeof listener) => {
        if (type === "message") listener = callback;
      }),
      postMessage: vi.fn(),
    };
    vi.stubGlobal("self", workerScope);
    await import("./detailWorker");

    handleDetailWorkerMessage.mockResolvedValueOnce(null);
    listener?.({ data: null } as MessageEvent<unknown>);
    await Promise.resolve();
    expect(workerScope.postMessage).not.toHaveBeenCalled();

    const identity = createDetailPreparationIdentity({
      imageAssetId: "pinecone-4330aa0314f7",
      analysisDefinitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
    });
    const prepared = prepareImageDetailAnalysis({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([1, 2, 3, 255]),
    });
    const response = { type: "success", jobId: 3, identity, prepared } as const;
    const request = { type: "compute", jobId: 3, identity } as const;
    handleDetailWorkerMessage.mockResolvedValueOnce(response);
    listener?.({ data: request } as MessageEvent<unknown>);

    expect(handleDetailWorkerMessage).toHaveBeenLastCalledWith(request);
    await vi.waitFor(() => {
      expect(workerScope.postMessage).toHaveBeenLastCalledWith(response, [
        prepared.data.buffer,
      ]);
    });
    expect(workerScope.postMessage.mock.lastCall?.[1]).toEqual([
      prepared.data.buffer,
    ]);

    const failure = {
      type: "failure",
      jobId: 4,
      identity,
      error: "decode failed",
    } as const;
    handleDetailWorkerMessage.mockResolvedValueOnce(failure);
    listener?.({
      data: { type: "compute", jobId: 4, identity },
    } as MessageEvent<unknown>);
    await vi.waitFor(() => {
      expect(workerScope.postMessage).toHaveBeenLastCalledWith(failure);
    });
    expect(workerScope.postMessage.mock.lastCall).toHaveLength(1);
  });
});
