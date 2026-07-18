import { photoScribble, type Params } from "@harness/core";

import protocolJson from "../../../packages/core/benchmarks/photo-scribble/protocol.json";
import type { ScribbleExecutionLimits } from "../../../packages/core/src/scribbleStrategy/orchestrator";
import {
  canonicalBrowserDiagnosticsHash,
  canonicalBrowserSceneHash,
  canonicalScribbleIdentityHash,
} from "./photoScribbleEvidenceHash";
import {
  type PhotoScribbleEvidenceProfile,
  type PhotoScribbleEvidenceTelemetry,
  type PhotoScribbleEvidenceWorkerConfig,
} from "./photoScribbleEvidenceProtocol";
import {
  createScribbleComputeIdentity,
  isScribbleWorkerMessage,
} from "./scribbleComputeProtocol";
import {
  ScribbleCoordinator,
  type ScribbleProgressUpdate,
  type ScribbleWorkerPort,
} from "./scribbleCoordinator";

interface Scenario {
  readonly scenarioId: string;
  readonly seed: string | number;
  readonly params: Params;
}

interface Candidate extends ScribbleExecutionLimits {
  readonly candidateId: string;
}

const protocol = protocolJson as unknown as {
  readonly rightsGate: { readonly status: string };
  readonly frame: { readonly width: number; readonly height: number };
  readonly scenarios: readonly Scenario[];
  readonly orderedLimitCandidates: readonly Candidate[];
};

interface MainProcessMemory {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize: number;
  readonly jsHeapSizeLimit: number;
}

interface PerformanceWithMemory extends Performance {
  readonly memory?: MainProcessMemory;
}

interface RunOptions {
  readonly rightsEvidence: string;
}

export interface PhotoScribbleEvidenceRun {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly scenarioId: string;
  readonly identityHash: string;
  readonly profile: PhotoScribbleEvidenceProfile;
  readonly fullTuple: Readonly<ScribbleExecutionLimits>;
  readonly result: {
    readonly sceneHash: string;
    readonly diagnosticsHash: string;
    readonly diagnostics: unknown;
    readonly primitiveCount: number;
    readonly smoothedPointCount: number;
    readonly serializedResultBytes: number;
    readonly coordinatorComputeTimeMs: number;
    readonly mainWallDurationMs: number;
    readonly responseReadyToMainReceiptEpochProxyMs: number;
  };
  readonly progress: {
    readonly count: number;
    readonly terminalCount: number;
    readonly receiptTimesMs: readonly number[];
  };
  readonly telemetry: PhotoScribbleEvidenceTelemetry;
  readonly protocolBoundary: {
    readonly invalidMessageCount: number;
    readonly allCoordinatorMessagesValid: boolean;
  };
  readonly memory: {
    readonly scope: "page-main-process-only-worker-heap-unavailable";
    readonly before: MainProcessMemory | null;
    readonly after: MainProcessMemory | null;
  };
}

export interface PhotoScribbleExactEquivalence {
  readonly scenarioId: string;
  readonly identityHashMatches: boolean;
  readonly resolvedTuple: Readonly<ScribbleExecutionLimits>;
  readonly productionResolverSelectedTuple: boolean;
  readonly productionOracleExactValueEquality: boolean;
  readonly sceneHashMatches: boolean;
  readonly diagnosticsHashMatches: boolean;
  readonly production: PhotoScribbleEvidenceRun;
  readonly injectedResolvedTuple: PhotoScribbleEvidenceRun;
}

function memorySample(): MainProcessMemory | null {
  const memory = (performance as PerformanceWithMemory).memory;
  return memory === undefined
    ? null
    : {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      };
}

function assertRightsEvidence(options: RunOptions): void {
  if (options.rightsEvidence.trim().length < 8) {
    throw new Error(
      `Browser execution blocked: ${protocol.rightsGate.status}. Supply the dated attestation or replacement-fixture provenance identifier.`,
    );
  }
}

function scenarioById(scenarioId: string): Scenario {
  const scenario = protocol.scenarios.find(
    (candidate) => candidate.scenarioId === scenarioId,
  );
  if (scenario === undefined) throw new Error(`Unknown scenario ${scenarioId}`);
  return scenario;
}

function profileForCandidate(candidateId: string): PhotoScribbleEvidenceProfile {
  const candidate = protocol.orderedLimitCandidates.find(
    (value) => value.candidateId === candidateId,
  );
  if (candidate === undefined) throw new Error(`Unknown candidate ${candidateId}`);
  return {
    kind: "injected",
    candidateId,
    limits: {
      maxAcceptedSegments: candidate.maxAcceptedSegments,
      maxPolylines: candidate.maxPolylines,
      maxStagnations: candidate.maxStagnations,
      maxRestarts: candidate.maxRestarts,
    },
  };
}

function telemetryPromise(channel: BroadcastChannel, runId: string) {
  return new Promise<PhotoScribbleEvidenceTelemetry>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error(`Telemetry timed out for ${runId}`)),
      300_000,
    );
    channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      const value = event.data as Partial<PhotoScribbleEvidenceTelemetry>;
      if (value.runId !== runId || value.schemaVersion !== 1) return;
      window.clearTimeout(timeout);
      resolve(value as PhotoScribbleEvidenceTelemetry);
    });
  });
}

function createEvidenceWorker(
  config: PhotoScribbleEvidenceWorkerConfig,
  trace: { invalidMessages: number; finalReceiptEpochMs: number | null },
): ScribbleWorkerPort {
  const worker = new Worker(
    new URL("./photoScribbleEvidenceWorker.ts", import.meta.url),
    { type: "module", name: JSON.stringify(config) },
  );
  return {
    postMessage(message) {
      worker.postMessage(message);
    },
    terminate() {
      worker.terminate();
    },
    addEventListener(type, listener) {
      if (type === "message") {
        worker.addEventListener("message", (event: MessageEvent<unknown>) => {
          if (!isScribbleWorkerMessage(event.data)) trace.invalidMessages++;
          if (
            typeof event.data === "object" &&
            event.data !== null &&
            "type" in event.data &&
            (event.data.type === "success" || event.data.type === "failure")
          ) {
            trace.finalReceiptEpochMs = Date.now();
          }
          listener(event);
        });
      } else {
        worker.addEventListener(type, listener as EventListener);
      }
    },
  };
}

function countPoints(primitives: readonly { readonly points: readonly unknown[] }[]): number {
  return primitives.reduce((total, primitive) => total + primitive.points.length, 0);
}

export async function runPhotoScribbleEvidence(
  scenarioId: string,
  profile: PhotoScribbleEvidenceProfile,
  options: RunOptions,
): Promise<PhotoScribbleEvidenceRun> {
  assertRightsEvidence(options);
  const scenario = scenarioById(scenarioId);
  const identity = createScribbleComputeIdentity({
    sketchId: photoScribble.id,
    schema: photoScribble.schema,
    params: scenario.params,
    seed: scenario.seed,
    compositionFrame: protocol.frame,
  });
  const runId = `issue-336-${scenarioId}-${crypto.randomUUID()}`;
  const telemetryChannelName = `${runId}-telemetry`;
  const channel = new BroadcastChannel(telemetryChannelName);
  const telemetry = telemetryPromise(channel, runId);
  const trace = { invalidMessages: 0, finalReceiptEpochMs: null as number | null };
  const config: PhotoScribbleEvidenceWorkerConfig = {
    schemaVersion: 1,
    runId,
    telemetryChannel: telemetryChannelName,
    profile,
  };
  const coordinator = new ScribbleCoordinator(() =>
    createEvidenceWorker(config, trace),
  );
  const progress: Array<{ readonly update: ScribbleProgressUpdate; readonly at: number }> = [];
  const beforeMemory = memorySample();
  const startedAt = performance.now();
  const outcome = await coordinator.start(identity, (update) => {
    progress.push({ update, at: performance.now() });
  });
  const wallDurationMs = performance.now() - startedAt;
  const workerTelemetry = await telemetry;
  channel.close();
  coordinator.dispose();
  if (outcome.status !== "success") {
    throw new Error(
      outcome.status === "failure" ? outcome.error : "Evidence job was cancelled",
    );
  }
  const serializedResult = JSON.stringify({
    scene: outcome.scene,
    diagnostics: outcome.diagnostics,
  });
  const finalReceipt = trace.finalReceiptEpochMs ?? Date.now();
  return {
    schemaVersion: 1,
    runId,
    scenarioId,
    identityHash: await canonicalScribbleIdentityHash(identity),
    profile,
    fullTuple: workerTelemetry.effectiveLimits,
    result: {
      sceneHash: await canonicalBrowserSceneHash(outcome.scene),
      diagnosticsHash: await canonicalBrowserDiagnosticsHash(outcome.diagnostics),
      diagnostics: outcome.diagnostics,
      primitiveCount: outcome.scene.primitives.length,
      smoothedPointCount: countPoints(outcome.scene.primitives),
      serializedResultBytes: new TextEncoder().encode(serializedResult).byteLength,
      coordinatorComputeTimeMs: outcome.computeTimeMs,
      mainWallDurationMs: wallDurationMs,
      responseReadyToMainReceiptEpochProxyMs: Math.max(
        0,
        finalReceipt - workerTelemetry.responseReadyEpochMs,
      ),
    },
    progress: {
      count: progress.length,
      terminalCount: progress.filter(({ update }) => update.snapshot.terminal)
        .length,
      receiptTimesMs: progress.map(({ at }) => at),
    },
    telemetry: workerTelemetry,
    protocolBoundary: {
      invalidMessageCount: trace.invalidMessages,
      allCoordinatorMessagesValid: trace.invalidMessages === 0,
    },
    memory: {
      scope: "page-main-process-only-worker-heap-unavailable",
      before: beforeMemory,
      after: memorySample(),
    },
  };
}

export async function runPhotoScribbleExactEquivalence(
  scenarioId: string,
  options: RunOptions,
): Promise<PhotoScribbleExactEquivalence> {
  const production = await runPhotoScribbleEvidence(
    scenarioId,
    { kind: "production" },
    options,
  );
  const injectedResolvedTuple = await runPhotoScribbleEvidence(
    scenarioId,
    {
      kind: "injected",
      candidateId: "resolved-production-tuple-equivalence",
      limits: production.telemetry.resolvedProductionLimits,
    },
    options,
  );
  return {
    scenarioId,
    identityHashMatches:
      production.identityHash === injectedResolvedTuple.identityHash,
    resolvedTuple: production.telemetry.resolvedProductionLimits,
    productionResolverSelectedTuple:
      production.telemetry.productionResolverSelectedEffectiveTuple,
    productionOracleExactValueEquality:
      production.telemetry.productionOracle.executed &&
      production.telemetry.productionOracle.exactArtworkValueEquality,
    sceneHashMatches:
      production.result.sceneHash === injectedResolvedTuple.result.sceneHash,
    diagnosticsHashMatches:
      production.result.diagnosticsHash ===
      injectedResolvedTuple.result.diagnosticsHash,
    production,
    injectedResolvedTuple,
  };
}

const globalEvidence = {
  protocol,
  runProduction: (scenarioId: string, options: RunOptions) =>
    runPhotoScribbleEvidence(scenarioId, { kind: "production" }, options),
  runCandidate: (scenarioId: string, candidateId: string, options: RunOptions) =>
    runPhotoScribbleEvidence(
      scenarioId,
      profileForCandidate(candidateId),
      options,
    ),
  runExactEquivalence: runPhotoScribbleExactEquivalence,
};

Object.assign(window, {
  __PHOTO_SCRIBBLE_EVIDENCE__: globalEvidence,
});

const status = document.querySelector<HTMLPreElement>("#status");
if (status !== null) {
  status.textContent = JSON.stringify(
    {
      ready: true,
      rightsGate: protocol.rightsGate.status,
      note: "Worker heap is unavailable; performance.memory samples only the page/main process.",
      api: "window.__PHOTO_SCRIBBLE_EVIDENCE__",
      scenarios: protocol.scenarios.map(({ scenarioId }) => scenarioId),
      candidates: protocol.orderedLimitCandidates.map(({ candidateId }) =>
        candidateId,
      ),
    },
    null,
    2,
  );
}
