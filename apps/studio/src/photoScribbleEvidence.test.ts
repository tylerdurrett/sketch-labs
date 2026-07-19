import { afterEach, describe, expect, it, vi } from "vitest";

import * as core from "@harness/core";
import {
  createPhotoScribbleSchema,
  createPhotoScribbleSource,
  generatePhotoScribbleArtwork,
  type DecodedPixels,
  type Params,
  type Scene,
  type ScribbleDiagnostics,
  type SketchEnvironment,
} from "@harness/core";
import {
  generatePhotoScribbleBenchmarkArtwork,
  resolvePhotoScribbleBenchmark,
} from "../../../packages/core/benchmarks/photo-scribble/benchmark-artwork";
import {
  canonicalSceneHash,
  canonicalScribbleDiagnosticsHash,
  canonicalScribbleTargetHash,
} from "../../../packages/core/benchmarks/photo-scribble/hash-oracles";
import type { ScribbleExecutionObservation } from "../../../packages/core/src/scribbleStrategy/orchestrator";
import { executePhotoScribbleEvidenceArtwork } from "./photoScribbleEvidenceExecution";
import {
  canonicalBrowserDiagnosticsHash,
  canonicalBrowserSceneHash,
  canonicalBrowserScribbleTargetHash,
} from "./photoScribbleEvidenceHash";
import {
  parsePhotoScribbleEvidenceWorkerConfig,
  type PhotoScribbleEvidenceTelemetry,
  type PhotoScribbleEvidenceWorkerConfig,
} from "./photoScribbleEvidenceProtocol";
import {
  createScribbleComputeIdentity,
  isScribbleComputeRequest,
} from "./scribbleComputeProtocol";

const assetId = "issue-336-evidence-synthetic";
const frame = { width: 48, height: 32 };
const pixels: DecodedPixels = {
  width: 4,
  height: 3,
  data: Uint8Array.from([
    0, 0, 0, 255, 96, 96, 96, 255, 255, 255, 255, 255, 255, 0, 0, 128,
    0, 0, 255, 255, 32, 32, 32, 255, 0, 255, 0, 192, 0, 0, 0, 255,
    255, 255, 255, 0, 128, 128, 128, 64, 255, 0, 255, 255, 16, 16, 16, 255,
  ]),
};
const params: Params = {
  imageAsset: assetId,
  toneGamma: 0.5,
  toneContrast: 0.5,
  pathDensity: 0.5,
  scribbleScale: 2,
  momentum: 0.5,
  chaos: 0.75,
  toneFidelity: 0,
};
const environment: SketchEnvironment = {
  imageAssets: (id) => (id === assetId ? pixels : undefined),
};

class FakeEvidenceBroadcastChannel {
  static readonly instances: FakeEvidenceBroadcastChannel[] = [];
  readonly listeners: Array<(event: MessageEvent<unknown>) => void> = [];
  closed = false;

  constructor(readonly name: string) {
    FakeEvidenceBroadcastChannel.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (type === "message") this.listeners.push(listener);
  }

  close(): void {
    this.closed = true;
  }

  static deliver(name: string, data: unknown): void {
    for (const channel of this.instances.filter(
      (candidate) => candidate.name === name && !candidate.closed,
    )) {
      for (const listener of channel.listeners) {
        listener({ data } as MessageEvent<unknown>);
      }
    }
  }
}

class FakeEvidenceWorker {
  static mode: "success" | "failure" | "pending" = "success";
  static readonly instances: FakeEvidenceWorker[] = [];
  readonly listeners = new Map<string, Array<(event: any) => void>>();
  readonly config: PhotoScribbleEvidenceWorkerConfig;
  terminated = false;

  constructor(_url: URL, options: WorkerOptions) {
    this.config = parsePhotoScribbleEvidenceWorkerConfig(options.name!);
    FakeEvidenceWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  terminate(): void {
    this.terminated = true;
  }

  postMessage(request: any): void {
    if (FakeEvidenceWorker.mode === "pending") return;
    if (FakeEvidenceWorker.mode === "failure") {
      this.emit({
        type: "failure",
        jobId: request.jobId,
        identity: request.identity,
        error: "worker failed before telemetry",
      });
      return;
    }
    const limits =
      this.config.profile.kind === "injected"
        ? this.config.profile.limits
        : {
            maxAcceptedSegments: 50_000,
            maxPolylines: 4_000,
            maxStagnations: 8_000,
            maxRestarts: 4_000,
          };
    const measuredProduction =
      this.config.purpose === "measurement" &&
      this.config.profile.kind === "production";
    const telemetry: PhotoScribbleEvidenceTelemetry = {
      schemaVersion: 1,
      runId: this.config.runId,
      sketchId: "photo-scribble",
      imageAssetId: "img-0672-79d639daec62",
      profile: this.config.profile,
      purpose: this.config.purpose,
      resolvedProductionLimits: measuredProduction ? null : limits,
      effectiveLimits: measuredProduction ? null : limits,
      productionResolverSelectedEffectiveTuple: measuredProduction
        ? null
        : true,
      execution: null,
      rawAcceptedSegments: null,
      smoothedEmittedPoints: 2,
      smoothedEmittedPolylines: 1,
      serializedArtworkBytes: 100,
      targetHash: null,
      workerDurationMs: this.config.purpose === "measurement" ? 1 : null,
      preparationCount: 1,
      solverPassCount: 1,
      responseReadyEpochMs: Date.now(),
    };
    FakeEvidenceBroadcastChannel.deliver(
      this.config.telemetryChannel,
      telemetry,
    );
    this.emit({
      type: "progress",
      jobId: request.jobId,
      snapshot: { completedWorkUnits: 0, totalWorkUnits: 1, terminal: false },
    });
    this.emit({
      type: "progress",
      jobId: request.jobId,
      snapshot: { completedWorkUnits: 1, totalWorkUnits: 1, terminal: true },
    });
    this.emit({
      type: "success",
      jobId: request.jobId,
      identity: request.identity,
      scene: {
        space: { width: 1000, height: 1000 },
        primitives: [
          {
            points: [
              [0, 0],
              [1, 1],
            ],
            stroke: { color: "black", width: 1 },
            hiddenLineRole: "source",
          },
        ],
      },
      diagnostics: {
        termination: "completed",
        residualError: 0,
        pathLength: Math.SQRT2,
        polylineCount: 1,
        penLiftCount: 0,
      },
      computeTimeMs: 1,
    });
  }

  private emit(data: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data });
    }
  }
}

function installEvidenceBrowserFakes(): void {
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal("document", { querySelector: () => null });
  vi.stubGlobal("BroadcastChannel", FakeEvidenceBroadcastChannel);
  vi.stubGlobal("Worker", FakeEvidenceWorker);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(performance.now());
    return 1;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEvidenceBroadcastChannel.instances.length = 0;
  FakeEvidenceWorker.instances.length = 0;
  FakeEvidenceWorker.mode = "success";
});

describe("Photo Scribble evidence page seams", () => {
  it("exposes an emergency abort that cancels the coordinator and terminates its Worker", async () => {
    installEvidenceBrowserFakes();
    FakeEvidenceWorker.mode = "pending";
    const evidenceModule = await import("./photoScribbleEvidence");
    const operation = evidenceModule.runPhotoScribbleEvidence(
      "flowers-opaque-fine",
      {
        kind: "injected",
        candidateId: "fine-100k",
        limits: {
          maxAcceptedSegments: 100_000,
          maxPolylines: 8_000,
          maxStagnations: 16_000,
          maxRestarts: 8_000,
        },
      },
      {},
    );
    await Promise.resolve();

    expect(evidenceModule.abortActivePhotoScribbleEvidence()).toBe(true);
    await expect(operation).rejects.toThrow("cancelled");
    expect(FakeEvidenceWorker.instances).toHaveLength(1);
    expect(FakeEvidenceWorker.instances[0]?.terminated).toBe(true);
    expect(evidenceModule.abortActivePhotoScribbleEvidence()).toBe(false);
  });

  it("keeps limits out of every strict product protocol shape", () => {
    const schema = createPhotoScribbleSchema(assetId);
    const identity = createScribbleComputeIdentity({
      sketchId: "photo-scribble",
      schema,
      params,
      seed: 336,
      compositionFrame: frame,
    });
    const request = { type: "compute", jobId: 1, identity } as const;

    expect(Object.keys(identity)).toEqual([
      "sketchId",
      "params",
      "seed",
      "compositionFrame",
    ]);
    expect(Object.keys(request)).toEqual(["type", "jobId", "identity"]);
    expect(isScribbleComputeRequest(request)).toBe(true);
    expect(isScribbleComputeRequest({ ...request, executionLimits: {} })).toBe(
      false,
    );
    expect(
      isScribbleComputeRequest({
        ...request,
        identity: { ...identity, benchmarkRunId: "run" },
      }),
    ).toBe(false);
    expect("generatePhotoScribbleBenchmarkArtwork" in core).toBe(false);
    expect("runPreparedScribbleStrategyForTesting" in core).toBe(false);
    expect("ScribbleExecutionLimits" in core).toBe(false);
  });

  it("parses the benchmark-only Worker profile outside the product message", () => {
    const config: PhotoScribbleEvidenceWorkerConfig = {
      schemaVersion: 1,
      runId: "run-336",
      telemetryChannel: "run-336-telemetry",
      purpose: "measurement",
      profile: {
        kind: "injected",
        candidateId: "test",
        limits: {
          maxAcceptedSegments: 10,
          maxPolylines: 4,
          maxStagnations: 8,
          maxRestarts: 4,
        },
      },
    };
    expect(parsePhotoScribbleEvidenceWorkerConfig(JSON.stringify(config))).toEqual(
      config,
    );
  });

  it("prepares source/model and executes exactly once per measured job", () => {
    const schema = createPhotoScribbleSchema(assetId);
    const identity = createScribbleComputeIdentity({
      sketchId: "photo-scribble",
      schema,
      params,
      seed: 336,
      compositionFrame: frame,
    });
    const artwork = generatePhotoScribbleArtwork(
      params,
      336,
      frame,
      schema,
      undefined,
      environment,
    );
    const productionPreparation = { source: 0, model: 0 };
    const injectedPreparation = { source: 0, model: 0 };
    const productionGenerate = vi.fn(() => {
      productionPreparation.source++;
      productionPreparation.model++;
      return artwork;
    });
    const resolve = vi.fn((nextParams, nextFrame, nextEnvironment) => {
      injectedPreparation.source++;
      injectedPreparation.model++;
      return resolvePhotoScribbleBenchmark(
        nextParams,
        nextFrame,
        nextEnvironment,
      );
    });
    const injectedGenerate = vi.fn(
      (
        _resolution,
        _seed,
        _frame,
        _limits,
        _observer,
        hooks,
      ) => {
        hooks.executionObserver?.({
          stopCause: "budget-reached",
          bindingGuard: "accepted-segment-limit",
          counters: {
            acceptedSegments: 1,
            emittedPolylines: 1,
            stagnations: 0,
            restarts: 0,
          },
        });
        return artwork;
      },
    );
    const baseConfig = {
      schemaVersion: 1,
      runId: "single-solve",
      telemetryChannel: "single-solve-telemetry",
      purpose: "measurement",
    } as const;

    executePhotoScribbleEvidenceArtwork(
      { ...baseConfig, profile: { kind: "production" } },
      productionGenerate,
      identity,
      environment,
      undefined,
      { resolve, generateInjected: injectedGenerate },
    );
    expect(productionGenerate).toHaveBeenCalledOnce();
    expect(productionPreparation).toEqual({ source: 1, model: 1 });
    expect(resolve).not.toHaveBeenCalled();
    expect(injectedPreparation).toEqual({ source: 0, model: 0 });
    expect(injectedGenerate).not.toHaveBeenCalled();

    executePhotoScribbleEvidenceArtwork(
      {
        ...baseConfig,
        profile: {
          kind: "injected",
          candidateId: "one",
          limits: {
            maxAcceptedSegments: 1,
            maxPolylines: 1,
            maxStagnations: 1,
            maxRestarts: 1,
          },
        },
      },
      productionGenerate,
      identity,
      environment,
      undefined,
      { resolve, generateInjected: injectedGenerate },
    );
    expect(productionGenerate).toHaveBeenCalledOnce();
    expect(injectedGenerate).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
    expect(injectedPreparation).toEqual({ source: 1, model: 1 });
  });

  it("surfaces Worker failure immediately and cleans up without telemetry", async () => {
    installEvidenceBrowserFakes();
    FakeEvidenceWorker.mode = "failure";
    const { runPhotoScribbleEvidence } = await import(
      "./photoScribbleEvidence"
    );
    const startedAt = performance.now();
    await expect(
      runPhotoScribbleEvidence(
        "flowers-opaque-control",
        { kind: "production" },
        {},
      ),
    ).rejects.toThrow("worker failed before telemetry");
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(FakeEvidenceWorker.instances[0]!.terminated).toBe(true);
    expect(FakeEvidenceBroadcastChannel.instances[0]!.closed).toBe(true);
  });

  it("returns same-clock heartbeat anchors", async () => {
    installEvidenceBrowserFakes();
    const { runPhotoScribbleEvidence } = await import(
      "./photoScribbleEvidence"
    );
    const run = await runPhotoScribbleEvidence(
      "flowers-opaque-control",
      { kind: "production" },
      { includePresentationEvidence: false },
    );
    expect(run.purpose).toBe("measurement");
    expect(run.fullTuple).toBeNull();
    expect(run.telemetry.resolvedProductionLimits).toBeNull();
    expect(run.measurement).not.toBeNull();
    const heartbeat = run.measurement!.heartbeat;
    expect(heartbeat.progressReceiptTimesMs).toHaveLength(2);
    expect(heartbeat.terminalProgressCount).toBe(1);
    expect(heartbeat.requestPostedAtMs).toBeLessThanOrEqual(
      heartbeat.progressReceiptTimesMs[0]!,
    );
    expect(heartbeat.progressReceiptTimesMs[1]).toBeLessThanOrEqual(
      heartbeat.finalResponseReceivedAtMs,
    );
    expect(heartbeat.betweenProgressGapsMs).toHaveLength(1);
    expect(heartbeat.maximumGapMs).toBeGreaterThanOrEqual(0);
    expect(FakeEvidenceWorker.instances[0]!.terminated).toBe(true);
    expect(FakeEvidenceBroadcastChannel.instances[0]!.closed).toBe(true);
  });

  it("keeps the two equivalence solves in a distinct unmeasured result", async () => {
    installEvidenceBrowserFakes();
    const { runPhotoScribbleExactEquivalence } = await import(
      "./photoScribbleEvidence"
    );
    const proof = await runPhotoScribbleExactEquivalence(
      "flowers-opaque-control",
      {},
    );

    expect(FakeEvidenceWorker.instances).toHaveLength(2);
    expect(proof.production.purpose).toBe("equivalence-proof");
    expect(proof.injectedResolvedTuple.purpose).toBe("equivalence-proof");
    expect(proof.production.measurement).toBeNull();
    expect(proof.injectedResolvedTuple.measurement).toBeNull();
    expect(proof.production.telemetry.workerDurationMs).toBeNull();
    expect(proof.injectedResolvedTuple.telemetry.workerDurationMs).toBeNull();
    expect(proof.identityHashMatches).toBe(true);
    expect(proof.sceneHashMatches).toBe(true);
    expect(proof.diagnosticsHashMatches).toBe(true);
  });

  it("matches the complete production composition at its resolved tuple", async () => {
    const schema = createPhotoScribbleSchema(assetId);
    const production = generatePhotoScribbleArtwork(
      params,
      336,
      frame,
      schema,
      undefined,
      environment,
    );
    const { productionLimits } = resolvePhotoScribbleBenchmark(
      params,
      frame,
      environment,
    );
    let execution: ScribbleExecutionObservation | undefined;
    const injected = generatePhotoScribbleBenchmarkArtwork(
      params,
      336,
      frame,
      environment,
      productionLimits,
      undefined,
      { executionObserver: (value) => (execution = value) },
    );

    expect(injected).toEqual(production);
    expect(execution).toBeDefined();
    expect(execution!.counters.acceptedSegments).toBeGreaterThan(0);
    expect(injected.scene.primitives.length).toBe(
      injected.diagnostics.polylineCount,
    );
    expect(await canonicalBrowserSceneHash(injected.scene)).toBe(
      await canonicalBrowserSceneHash(production.scene),
    );
    expect(await canonicalBrowserDiagnosticsHash(injected.diagnostics)).toBe(
      await canonicalBrowserDiagnosticsHash(production.diagnostics),
    );
  });

  it("matches the frozen Node hash encoding for Scene and diagnostics", async () => {
    const scene: Scene = {
      space: { width: 100, height: 80 },
      background: { color: "#fefefe" },
      primitives: [
        {
          points: [
            [1.25, 2.5],
            [30.75, 4.125],
            [10.5, 25.875],
          ],
          closed: true,
          fill: { color: "#123456" },
          stroke: { color: "#abcdef", width: 0.75 },
          hiddenLineRole: "both",
        },
      ],
    };
    const diagnostics: ScribbleDiagnostics = {
      termination: "budget-exhausted",
      residualError: 0.125,
      pathLength: 42.5,
      polylineCount: 2,
      penLiftCount: 1,
    };
    expect(await canonicalBrowserSceneHash(scene)).toBe(
      canonicalSceneHash(scene),
    );
    expect(await canonicalBrowserDiagnosticsHash(diagnostics)).toBe(
      canonicalScribbleDiagnosticsHash(diagnostics),
    );
  });

  it("matches the frozen Node target hash encoding without running geometry", async () => {
    const schema = createPhotoScribbleSchema(assetId);
    const source = createPhotoScribbleSource(
      params,
      frame,
      schema,
      environment,
    );
    const controls = {
      pathDensity: Number(params.pathDensity),
      scribbleScale: Number(params.scribbleScale),
      momentum: Number(params.momentum),
      chaos: Number(params.chaos),
      toneFidelity: Number(params.toneFidelity),
    };
    expect(
      await canonicalBrowserScribbleTargetHash(source, frame, controls),
    ).toBe(canonicalScribbleTargetHash(source, frame, controls));
  });

  it("matches the frozen Node target hash from the already-prepared model", async () => {
    const resolution = resolvePhotoScribbleBenchmark(params, frame, environment);
    expect(await canonicalBrowserScribbleTargetHash(resolution.model)).toBe(
      canonicalScribbleTargetHash(resolution.source, frame, resolution.controls),
    );
  });
});
