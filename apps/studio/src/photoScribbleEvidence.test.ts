import { describe, expect, it } from "vitest";

import * as core from "@harness/core";
import {
  createPhotoScribbleSchema,
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
} from "../../../packages/core/benchmarks/photo-scribble/hash-oracles";
import type { ScribbleExecutionObservation } from "../../../packages/core/src/scribbleStrategy/orchestrator";
import {
  canonicalBrowserDiagnosticsHash,
  canonicalBrowserSceneHash,
} from "./photoScribbleEvidenceHash";
import {
  parsePhotoScribbleEvidenceWorkerConfig,
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

describe("Photo Scribble evidence page seams", () => {
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
    expect("ScribbleExecutionLimits" in core).toBe(false);
  });

  it("parses the benchmark-only Worker profile outside the product message", () => {
    const config: PhotoScribbleEvidenceWorkerConfig = {
      schemaVersion: 1,
      runId: "run-336",
      telemetryChannel: "run-336-telemetry",
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
});
