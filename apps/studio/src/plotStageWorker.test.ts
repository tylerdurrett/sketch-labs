import { afterEach, describe, expect, it, vi } from "vitest";

const { handlePlotStageWorkerMessage } = vi.hoisted(() => ({
  handlePlotStageWorkerMessage: vi.fn(),
}));

vi.mock("./plotStageWorkerRuntime", () => ({ handlePlotStageWorkerMessage }));

async function loadWorkerEntry() {
  let listener: ((event: MessageEvent<unknown>) => void) | undefined;
  const workerScope = {
    addEventListener: vi.fn((type: string, callback: typeof listener) => {
      if (type === "message") listener = callback;
    }),
    postMessage: vi.fn(),
  };
  vi.stubGlobal("self", workerScope);
  await import("./plotStageWorker");
  return {
    emit(data: unknown) {
      listener?.({ data } as MessageEvent<unknown>);
    },
    workerScope,
  };
}

const identity = {
  sketchId: "photo-scribble",
  stageId: "watercolor-forms",
  params: [],
  compositionFrame: { width: 10, height: 8 },
} as const;
const registrationIdentity = {
  params: [],
  compositionFrame: identity.compositionFrame,
} as const;

describe("Plot Stage worker entry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("ignores foreign top-level messages without posting a result", async () => {
    const entry = await loadWorkerEntry();

    const foreignMessage = { type: "preview" };
    handlePlotStageWorkerMessage.mockResolvedValueOnce(null);
    entry.emit(foreignMessage);

    expect(handlePlotStageWorkerMessage).toHaveBeenCalledWith(foreignMessage);
    await vi.waitFor(() => {
      expect(entry.workerScope.postMessage).not.toHaveBeenCalled();
    });
  });

  it("posts a validated Scene as ordinary structured-clone data", async () => {
    const entry = await loadWorkerEntry();
    const success = {
      type: "success",
      jobId: 3,
      identity,
      registrationIdentity,
      scene: {
        space: identity.compositionFrame,
        primitives: [{ points: [[1, 2], [3, 4]] }],
      },
    } as const;
    const request = {
      type: "compute",
      jobId: success.jobId,
      identity,
      registrationIdentity,
      seed: "ink-seed",
      sampledT: 0,
    } as const;
    handlePlotStageWorkerMessage.mockResolvedValueOnce(success);

    entry.emit(request);

    expect(handlePlotStageWorkerMessage).toHaveBeenLastCalledWith(request);
    await vi.waitFor(() => {
      expect(entry.workerScope.postMessage).toHaveBeenLastCalledWith(success);
    });
    expect(entry.workerScope.postMessage.mock.lastCall).toHaveLength(1);
  });

  it("posts the runtime's validated typed failure without translation", async () => {
    const entry = await loadWorkerEntry();
    const failure = {
      type: "failure",
      jobId: 4,
      identity,
      registrationIdentity,
      error: "Image Asset could not be decoded",
    } as const;
    handlePlotStageWorkerMessage.mockResolvedValueOnce(failure);

    entry.emit({
      type: "compute",
      jobId: failure.jobId,
      identity,
      registrationIdentity,
      seed: "ink-seed",
      sampledT: 0,
    });

    await vi.waitFor(() => {
      expect(entry.workerScope.postMessage).toHaveBeenLastCalledWith(failure);
    });
  });
});
