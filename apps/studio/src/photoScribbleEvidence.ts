import { photoScribble, type Params } from "@harness/core";

import protocolJson from "../../../packages/core/benchmarks/photo-scribble/protocol.json";
import type { ScribbleExecutionLimits } from "../../../packages/core/src/scribbleStrategy/orchestrator";
import {
  canonicalBrowserDiagnosticsHash,
  canonicalBrowserSceneHash,
  canonicalScribbleIdentityHash,
} from "./photoScribbleEvidenceHash";
import type {
  PhotoScribbleEvidenceProfile,
  PhotoScribbleEvidenceTelemetry,
  PhotoScribbleEvidenceWorkerConfig,
} from "./photoScribbleEvidenceProtocol";
import {
  createScribbleComputeIdentity,
  isScribbleComputeProgress,
  isScribbleWorkerMessage,
} from "./scribbleComputeProtocol";
import {
  ScribbleCoordinator,
  type ScribbleWorkerPort,
} from "./scribbleCoordinator";

interface Scenario {
  readonly scenarioId: string;
  readonly fixtureId: string;
  readonly seed: string | number;
  readonly params: Params;
}

interface Candidate extends ScribbleExecutionLimits {
  readonly candidateId: string;
}

const protocol = protocolJson as unknown as {
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
  /** Host identity copied through so a campaign can reject stale page results. */
  readonly campaignId?: string;
  readonly hostRunId?: string;
}

let activeEvidenceCoordinator: ScribbleCoordinator | null = null;

/**
 * Benchmark-host emergency stop. A Puppeteer timeout cannot cancel a promise
 * already executing in the page, so the host calls this seam before closing
 * the page. ScribbleCoordinator.cancel() synchronously terminates its Worker.
 */
export function abortActivePhotoScribbleEvidence(): boolean {
  return activeEvidenceCoordinator?.cancel() ?? false;
}

export interface PhotoScribbleEvidenceRun {
  readonly schemaVersion: 1;
  readonly campaignId: string | null;
  readonly hostRunId: string | null;
  readonly runId: string;
  readonly scenarioId: string;
  readonly purpose: "measurement" | "equivalence-proof";
  readonly identityHash: string;
  readonly profile: PhotoScribbleEvidenceProfile;
  readonly fullTuple: Readonly<ScribbleExecutionLimits> | null;
  readonly result: {
    readonly sceneHash: string;
    readonly diagnosticsHash: string;
    readonly diagnostics: unknown;
    readonly primitiveCount: number;
    readonly smoothedPointCount: number;
    readonly serializedResultBytes: number;
  };
  readonly measurement: {
    readonly coordinatorComputeTimeMs: number;
    readonly mainWallDurationMs: number;
    readonly responseReadyToMainReceiptEpochProxyMs: number;
    readonly heartbeat: {
      readonly requestPostedAtMs: number;
      readonly progressReceiptTimesMs: readonly number[];
      readonly finalResponseReceivedAtMs: number;
      readonly requestToFirstOrEndMs: number;
      readonly betweenProgressGapsMs: readonly number[];
      readonly lastProgressToEndMs: number | null;
      readonly maximumGapMs: number;
      readonly terminalProgressCount: number;
    };
    readonly memory: {
      readonly scope: "page-main-process-only-worker-heap-unavailable";
      readonly before: MainProcessMemory | null;
      readonly after: MainProcessMemory | null;
    };
  } | null;
  readonly telemetry: PhotoScribbleEvidenceTelemetry;
  readonly protocolBoundary: {
    readonly invalidMessageCount: number;
    readonly allCoordinatorMessagesValid: boolean;
  };
}

export interface PhotoScribbleExactEquivalence {
  readonly scenarioId: string;
  readonly identityHashMatches: boolean;
  readonly resolvedTuple: Readonly<ScribbleExecutionLimits>;
  readonly productionResolverSelectedTuple: boolean;
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

interface TelemetryWaiter {
  readonly promise: Promise<PhotoScribbleEvidenceTelemetry>;
  readonly cancel: () => void;
}

function telemetryWaiter(
  channel: BroadcastChannel,
  runId: string,
): TelemetryWaiter {
  let timeout = 0;
  let rejectWait: ((reason: Error) => void) | undefined;
  const promise = new Promise<PhotoScribbleEvidenceTelemetry>((resolve, reject) => {
    rejectWait = reject;
    timeout = window.setTimeout(
      () => reject(new Error(`Telemetry timed out for ${runId}`)),
      300_000,
    );
    channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      const value = event.data as Partial<PhotoScribbleEvidenceTelemetry>;
      if (value.runId !== runId || value.schemaVersion !== 1) return;
      window.clearTimeout(timeout);
      rejectWait = undefined;
      resolve(value as PhotoScribbleEvidenceTelemetry);
    });
  });
  return {
    promise,
    cancel() {
      window.clearTimeout(timeout);
      rejectWait?.(new Error(`Telemetry wait cancelled for ${runId}`));
      rejectWait = undefined;
    },
  };
}

interface WorkerTrace {
  invalidMessages: number;
  requestPostedAtMs: number | null;
  progressReceiptTimesMs: number[];
  terminalProgressCount: number;
  finalResponseReceivedAtMs: number | null;
  finalReceiptEpochMs: number | null;
}

function createEvidenceWorker(
  config: PhotoScribbleEvidenceWorkerConfig,
  trace: WorkerTrace,
): ScribbleWorkerPort {
  const worker = new Worker(
    new URL("./photoScribbleEvidenceWorker.ts", import.meta.url),
    { type: "module", name: JSON.stringify(config) },
  );
  return {
    postMessage(message) {
      trace.requestPostedAtMs = performance.now();
      worker.postMessage(message);
    },
    terminate() {
      worker.terminate();
    },
    addEventListener(type, listener) {
      if (type === "message") {
        worker.addEventListener("message", (event: MessageEvent<unknown>) => {
          const receivedAt = performance.now();
          if (!isScribbleWorkerMessage(event.data)) trace.invalidMessages++;
          if (isScribbleComputeProgress(event.data)) {
            trace.progressReceiptTimesMs.push(receivedAt);
            if (event.data.snapshot.terminal) trace.terminalProgressCount++;
          }
          if (
            typeof event.data === "object" &&
            event.data !== null &&
            "type" in event.data &&
            (event.data.type === "success" || event.data.type === "failure")
          ) {
            trace.finalResponseReceivedAtMs = receivedAt;
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

function heartbeatMeasurement(trace: WorkerTrace) {
  const request = trace.requestPostedAtMs;
  const end = trace.finalResponseReceivedAtMs;
  if (request === null || end === null) {
    throw new Error("Evidence Worker trace lacks request/response anchors");
  }
  const receipts = [...trace.progressReceiptTimesMs];
  const requestToFirstOrEndMs = (receipts[0] ?? end) - request;
  const betweenProgressGapsMs = receipts
    .slice(1)
    .map((receipt, index) => receipt - receipts[index]!);
  const lastProgressToEndMs =
    receipts.length === 0 ? null : end - receipts[receipts.length - 1]!;
  const gaps = [
    requestToFirstOrEndMs,
    ...betweenProgressGapsMs,
    ...(lastProgressToEndMs === null ? [] : [lastProgressToEndMs]),
  ];
  return {
    requestPostedAtMs: request,
    progressReceiptTimesMs: receipts,
    finalResponseReceivedAtMs: end,
    requestToFirstOrEndMs,
    betweenProgressGapsMs,
    lastProgressToEndMs,
    maximumGapMs: Math.max(0, ...gaps),
    terminalProgressCount: trace.terminalProgressCount,
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
  return runPhotoScribbleEvidenceOperation(
    scenarioId,
    profile,
    options,
    "measurement",
  );
}

async function runPhotoScribbleEvidenceOperation(
  scenarioId: string,
  profile: PhotoScribbleEvidenceProfile,
  options: RunOptions,
  purpose: "measurement" | "equivalence-proof",
): Promise<PhotoScribbleEvidenceRun> {
  const scenario = scenarioById(scenarioId);
  const identity = createScribbleComputeIdentity({
    sketchId: photoScribble.id,
    schema: photoScribble.schema,
    params: scenario.params,
    seed: scenario.seed,
    compositionFrame: protocol.frame,
  });
  const campaignId = options.campaignId ?? null;
  const hostRunId = options.hostRunId ?? null;
  const runId = `${hostRunId ?? `issue-336-${scenarioId}`}-${crypto.randomUUID()}`;
  const telemetryChannelName = `${runId}-telemetry`;
  const channel = new BroadcastChannel(telemetryChannelName);
  const telemetry = telemetryWaiter(channel, runId);
  const trace: WorkerTrace = {
    invalidMessages: 0,
    requestPostedAtMs: null,
    progressReceiptTimesMs: [],
    terminalProgressCount: 0,
    finalResponseReceivedAtMs: null,
    finalReceiptEpochMs: null,
  };
  const config: PhotoScribbleEvidenceWorkerConfig = {
    schemaVersion: 1,
    runId,
    telemetryChannel: telemetryChannelName,
    purpose,
    profile,
  };
  const coordinator = new ScribbleCoordinator(() =>
    createEvidenceWorker(config, trace),
  );
  if (activeEvidenceCoordinator !== null) {
    coordinator.dispose();
    throw new Error("A Photo Scribble evidence operation is already active");
  }
  activeEvidenceCoordinator = coordinator;
  const beforeMemory = memorySample();
  const startedAt = performance.now();
  try {
    const successfulOutcome = coordinator
      .start(identity)
      .then((outcome) => {
        if (outcome.status !== "success") {
          throw new Error(
            outcome.status === "failure"
              ? outcome.error
              : "Evidence job was cancelled",
          );
        }
        return outcome;
      });
    // Promise.all rejects immediately on a Worker failure; it never waits for
    // the absent telemetry timeout before surfacing the original failure.
    const [outcome, workerTelemetry] = await Promise.all([
      successfulOutcome,
      telemetry.promise,
    ]);
    const wallDurationMs = performance.now() - startedAt;
    const serializedResult = JSON.stringify({
      scene: outcome.scene,
      diagnostics: outcome.diagnostics,
    });
    const finalReceipt = trace.finalReceiptEpochMs ?? Date.now();
    return {
    schemaVersion: 1,
    campaignId,
    hostRunId,
    runId,
    scenarioId,
    purpose,
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
    },
    measurement:
      purpose === "equivalence-proof"
        ? null
        : {
            coordinatorComputeTimeMs: outcome.computeTimeMs,
            mainWallDurationMs: wallDurationMs,
            responseReadyToMainReceiptEpochProxyMs: Math.max(
              0,
              finalReceipt - workerTelemetry.responseReadyEpochMs,
            ),
            heartbeat: heartbeatMeasurement(trace),
            memory: {
              scope: "page-main-process-only-worker-heap-unavailable",
              before: beforeMemory,
              after: memorySample(),
            },
          },
    telemetry: workerTelemetry,
    protocolBoundary: {
      invalidMessageCount: trace.invalidMessages,
      allCoordinatorMessagesValid: trace.invalidMessages === 0,
    },
    };
  } finally {
    try {
      telemetry.cancel();
    } catch {
      // Cleanup cannot replace the original Worker/telemetry/hash failure.
    }
    try {
      channel.close();
    } catch {
      // Cleanup cannot replace the original Worker/telemetry/hash failure.
    }
    try {
      coordinator.dispose();
    } catch {
      // Cleanup cannot replace the original Worker/telemetry/hash failure.
    }
    if (activeEvidenceCoordinator === coordinator) {
      activeEvidenceCoordinator = null;
    }
  }
}

export async function runPhotoScribbleExactEquivalence(
  scenarioId: string,
  options: RunOptions,
): Promise<PhotoScribbleExactEquivalence> {
  const production = await runPhotoScribbleEvidenceOperation(
    scenarioId,
    { kind: "production" },
    options,
    "equivalence-proof",
  );
  const resolvedTuple = production.telemetry.resolvedProductionLimits;
  if (resolvedTuple === null) {
    throw new Error("Equivalence proof did not resolve the production tuple");
  }
  const injectedResolvedTuple = await runPhotoScribbleEvidenceOperation(
    scenarioId,
    {
      kind: "injected",
      candidateId: "resolved-production-tuple-equivalence",
      limits: resolvedTuple,
    },
    options,
    "equivalence-proof",
  );
  return {
    scenarioId,
    identityHashMatches:
      production.identityHash === injectedResolvedTuple.identityHash,
    resolvedTuple,
    productionResolverSelectedTuple:
      production.telemetry.productionResolverSelectedEffectiveTuple === true,
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
  abortActive: abortActivePhotoScribbleEvidence,
};

Object.assign(window, {
  __PHOTO_SCRIBBLE_EVIDENCE__: globalEvidence,
});

const status = document.querySelector<HTMLPreElement>("#status");
if (status !== null) {
  status.textContent = JSON.stringify(
    {
      ready: true,
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
