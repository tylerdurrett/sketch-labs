import {
  applyPreset,
  computePlotMapping,
  deserialize,
  grassHills,
  plotDrawableRectangle,
  resolveCompositionFrame,
  type Params,
  type PlotProfile,
  type Scene,
} from "@harness/core";

import denseGrassPreset from "../../../packages/core/src/sketches/grass-hills/presets/dense-grass.json";
import { createOutlineWorker } from "./createOutlineWorker";
import {
  HiddenLineCoordinator,
  type HiddenLineProgressUpdate,
  type OutlineWorkerPort,
} from "./hiddenLineCoordinator";
import {
  createHiddenLineExportSnapshot,
  createOutlineComputeIdentity,
  isHiddenLineWorkerMessage,
  isOutlineComputeProgress,
  isOutlineComputeResponse,
  outlineComputeIdentitiesEqual,
  type HiddenLineWorkerRequest,
  type ImmutableScene,
  type OutlineComputeRequest,
} from "./outlineComputeProtocol";
import {
  createOutlineSessionState,
  outlineSessionReducer,
} from "./outlineSession";

const OUTLINE_TOOL_WIDTH_MILLIMETERS = 0.3;
const STATUS = document.querySelector<HTMLPreElement>("#status");

interface WorkerTrace {
  request: HiddenLineWorkerRequest | OutlineComputeRequest | null;
  postMessageCount: number;
  responseTypeCounts: Record<string, number>;
  terminalProgressCount: number;
  validatedResponseCount: number;
  invalidResponseCount: number;
  finalMessage: unknown;
  terminatedCount: number;
}

interface BrowserMemorySample {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize: number;
  readonly jsHeapSizeLimit: number;
}

interface BrowserMemoryPerformance extends Performance {
  readonly memory?: BrowserMemorySample;
}

interface EvidenceNavigator extends Navigator {
  readonly userAgentData?: { readonly platform?: string };
  readonly deviceMemory?: number;
}

interface EvidenceGlobal {
  readonly runAll: () => Promise<BrowserWorkerEvidence>;
}

interface WindowWithEvidence extends Window {
  __GRASS_HILLS_OUTLINE_WORKER_EVIDENCE__?: EvidenceGlobal;
}

interface BrowserWorkerEvidence {
  readonly schemaVersion: 1;
  readonly referenceId: "grass-hills-faithful-visible-line";
  readonly capturedAt: string;
  readonly warning: string;
  readonly machine: {
    readonly userAgent: string;
    readonly platform: string;
    readonly logicalCpuCount: number | null;
    readonly deviceMemoryGiB: number | null;
  };
  readonly scenarios: readonly unknown[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function memorySample(): {
  usedJsHeapSize: number;
  totalJsHeapSize: number;
  jsHeapSizeLimit: number;
} | null {
  const memory = (performance as BrowserMemoryPerformance).memory;
  return memory === undefined
    ? null
    : {
        usedJsHeapSize: memory.usedJSHeapSize,
        totalJsHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      };
}

function countPoints(scene: Scene | ImmutableScene): number {
  return scene.primitives.reduce(
    (total, primitive) => total + primitive.points.length,
    0,
  );
}

async function sha256(serialized: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function describeScene(scene: Scene | ImmutableScene) {
  const serialized = JSON.stringify(scene);
  return {
    bytes: new TextEncoder().encode(serialized).byteLength,
    sha256: await sha256(serialized),
    primitiveCount: scene.primitives.length,
    pointCount: countPoints(scene),
  };
}

async function describeSvg(svg: string) {
  return {
    bytes: new TextEncoder().encode(svg).byteLength,
    sha256: await sha256(svg),
    pathCount: (svg.match(/<path\b/g) ?? []).length,
  };
}

function createTrace(): WorkerTrace {
  return {
    request: null,
    postMessageCount: 0,
    responseTypeCounts: {},
    terminalProgressCount: 0,
    validatedResponseCount: 0,
    invalidResponseCount: 0,
    finalMessage: null,
    terminatedCount: 0,
  };
}

/**
 * Observe, but never replace, the real module Worker. The coordinator still
 * owns response validation and lifecycle; this wrapper only retains boundary
 * references and scalar traffic counts for the evidence record.
 */
function tracedWorkerFactory(traces: WorkerTrace[]): () => OutlineWorkerPort {
  return () => {
    const worker = createOutlineWorker();
    const trace = createTrace();
    traces.push(trace);
    const port: OutlineWorkerPort = {
      postMessage(message) {
        trace.request = message;
        trace.postMessageCount++;
        worker.postMessage(message);
      },
      terminate() {
        trace.terminatedCount++;
        worker.terminate();
      },
      addEventListener(type, listener) {
        if (type === "message") {
          worker.addEventListener("message", (event: MessageEvent<unknown>) => {
            const value = event.data;
            const key =
              typeof value === "object" && value !== null && "type" in value
                ? String(value.type)
                : typeof value;
            trace.responseTypeCounts[key] =
              (trace.responseTypeCounts[key] ?? 0) + 1;
            if (
              isOutlineComputeProgress(value) &&
              value.snapshot.terminal
            ) {
              trace.terminalProgressCount++;
            }
            const valid =
              isOutlineComputeProgress(value) ||
              isOutlineComputeResponse(value) ||
              isHiddenLineWorkerMessage(value);
            if (valid) trace.validatedResponseCount++;
            else trace.invalidResponseCount++;
            if (
              isOutlineComputeResponse(value) ||
              (isHiddenLineWorkerMessage(value) && value.type === "complete")
            ) {
              trace.finalMessage = value;
            }
            listener(event);
          });
          return;
        }
        if (type === "error") {
          worker.addEventListener("error", listener as (event: Event) => void);
        } else {
          worker.addEventListener(
            "messageerror",
            listener as (event: Event) => void,
          );
        }
      },
    };
    return port;
  };
}

function paramsAtDensity(density: number): {
  params: Params;
  seed: string | number;
  profile: PlotProfile;
} {
  const preset = applyPreset(
    grassHills.schema,
    deserialize({
      ...denseGrassPreset,
      version: 2,
      params: { ...denseGrassPreset.params, bladeDensity: density },
    }),
  );
  assert(preset.profile !== undefined, "dense-grass must carry a Plot Profile");
  return { params: preset.params, seed: preset.seed, profile: preset.profile };
}

function finalPreviewMessage(trace: WorkerTrace) {
  const message = trace.finalMessage;
  assert(
    isOutlineComputeResponse(message) && message.type === "success",
    "preview Worker did not return a validated success",
  );
  return message;
}

function finalExportMessage(trace: WorkerTrace) {
  const message = trace.finalMessage;
  assert(
    isHiddenLineWorkerMessage(message) &&
      message.type === "complete" &&
      message.jobKind === "export",
    "export Worker did not return a validated completion",
  );
  return message;
}

async function runScenario(id: string, bladeDensity: number) {
  const startedAt = performance.now();
  const beforeMemory = memorySample();
  const { params, seed, profile } = paramsAtDensity(bladeDensity);
  const drawable = plotDrawableRectangle(profile);
  const compositionFrame = resolveCompositionFrame(
    drawable.width / drawable.height,
  );
  const identity = createOutlineComputeIdentity({
    sketchId: grassHills.id,
    schema: grassHills.schema,
    params,
    seed,
    sampledT: 0,
    compositionFrame,
    tolerance: 0,
    outlineTarget: {
      toolWidthMillimeters: OUTLINE_TOOL_WIDTH_MILLIMETERS,
      millimetersPerSceneUnit: computePlotMapping(
        compositionFrame,
        profile,
      ).scale,
    },
  });
  assert(identity.sourceKind === "specialized-sketch", "specialized identity required");
  assert(!("sourceScene" in identity), "specialized identity cannot carry a fallback Scene");

  const fillStartedAt = performance.now();
  const fillScene = grassHills.generate(params, seed, 0, compositionFrame);
  const fillGenerationMs = performance.now() - fillStartedAt;
  const expectedBlades = bladeDensity * 5_000;
  assert(
    fillScene.primitives.filter(({ points }) => points.length === 7).length ===
      expectedBlades,
    `expected ${expectedBlades} Fill blades`,
  );

  let session = outlineSessionReducer(createOutlineSessionState(), {
    type: "request-outline",
  });
  const capture = session.capture;
  assert(capture !== null, "Outline session did not request a Fill capture");
  session = outlineSessionReducer(session, {
    type: "fill-captured",
    token: capture.token,
    inputRevision: capture.inputRevision,
    identity,
    scene: fillScene,
    t: 0,
  });
  const active = session.active;
  assert(active !== null, "Outline session did not acquire its preview slot");

  const traces: WorkerTrace[] = [];
  const coordinator = new HiddenLineCoordinator(tracedWorkerFactory(traces));
  const previewProgress: HiddenLineProgressUpdate[] = [];
  const previewStartedAt = performance.now();
  const previewResult = await coordinator.startOutline(identity, (update) => {
    previewProgress.push(update);
  });
  const previewMs = performance.now() - previewStartedAt;
  assert(previewResult.status === "success", "Outline preview failed");
  assert(traces.length === 1, "preview must create exactly one Worker");
  const previewTrace = traces[0]!;
  const previewMessage = finalPreviewMessage(previewTrace);
  assert(previewTrace.invalidResponseCount === 0, "preview emitted an invalid response");
  assert(previewTrace.postMessageCount === 1, "preview Worker received more than one request");
  assert(previewTrace.terminatedCount === 1, "preview Worker was not released once");
  assert(
    previewProgress.at(-1)?.snapshot.terminal === true,
    "preview did not deliver terminal progress through the coordinator",
  );
  assert(
    previewMessage.identity !== identity &&
      outlineComputeIdentitiesEqual(previewMessage.identity, identity),
    "preview identity did not cross a structured-clone boundary",
  );
  assert(
    previewMessage.scene === previewResult.scene,
    "coordinator did not return the validated Worker Scene",
  );

  session = outlineSessionReducer(session, {
    type: "succeeded",
    token: active.token,
    identity: previewResult.identity,
    scene: previewResult.scene,
  });
  const previewCache = session.cache;
  assert(previewCache !== null, "completed preview was not cached");
  assert(
    previewCache.scene === previewResult.scene &&
      previewCache.identity === previewResult.identity,
    "session cache did not retain the coordinator completion",
  );
  const previewScene = await describeScene(previewResult.scene);

  const snapshotStartedAt = performance.now();
  const snapshot = createHiddenLineExportSnapshot({
    identity,
    profile,
    metadata: `Grass Hills worker evidence ${id}`,
    includePaperMargins: true,
    filename: `${id}-physical-plot.svg`,
    reusableOutline: {
      identity: previewCache.identity,
      scene: previewCache.scene,
    },
  });
  const snapshotMs = performance.now() - snapshotStartedAt;
  assert(snapshot.reusableOutline !== undefined, "matching cache was not captured for reuse");
  assert(
    snapshot.reusableOutline.scene !== previewCache.scene,
    "export snapshot must defensively copy the live cache",
  );

  session = outlineSessionReducer(session, {
    type: "request-export",
    snapshot,
  });
  const exportActive = session.exportActive;
  assert(exportActive !== null, "Outline session did not acquire its export slot");
  const exportUpdates: string[] = [];
  const exportStartedAt = performance.now();
  const exportResult = await coordinator.startExport(snapshot, (update) => {
    exportUpdates.push(update.phase);
  });
  const exportMs = performance.now() - exportStartedAt;
  assert(exportResult.status === "success", "physical export failed");
  assert(Number(traces.length) === 2, "export must create exactly one additional Worker");
  const exportTrace = traces[1]!;
  const exportMessage = finalExportMessage(exportTrace);
  assert(exportTrace.invalidResponseCount === 0, "export emitted an invalid response");
  assert(exportTrace.postMessageCount === 1, "export Worker received more than one request");
  assert(exportTrace.terminatedCount === 1, "export Worker was not released once");
  assert(
    (exportTrace.responseTypeCounts["derivation-progress"] ?? 0) === 0 &&
      exportUpdates.every((phase) => phase === "finalizing"),
    "cached physical export silently rederived Hidden-line geometry",
  );
  assert(
    exportMessage.completedOutline.scene !== snapshot.reusableOutline.scene,
    "export response did not cross a structured-clone boundary",
  );
  assert(
    exportMessage.completedOutline.scene === exportResult.completedOutline.scene,
    "coordinator did not return the validated export completion",
  );
  const exportScene = await describeScene(exportResult.completedOutline.scene);
  assert(
    exportScene.sha256 === previewScene.sha256 &&
      exportScene.bytes === previewScene.bytes &&
      exportScene.primitiveCount === previewScene.primitiveCount &&
      exportScene.pointCount === previewScene.pointCount,
    "physical export did not reuse the completed preview Scene",
  );

  session = outlineSessionReducer(session, {
    type: "export-succeeded",
    token: exportActive.token,
    completedOutline: exportResult.completedOutline,
  });
  assert(session.cache !== null, "export completion did not settle into cache");
  const settledCacheScene = await describeScene(session.cache.scene);
  assert(
    session.cache.scene !== exportResult.completedOutline.scene &&
      settledCacheScene.sha256 === previewScene.sha256,
    "settled cache did not retain an isolated copy of the reused Scene",
  );
  const physicalSvg = await describeSvg(exportResult.svg);
  coordinator.dispose();

  return {
    id,
    bladeDensity,
    expectedBladeCount: expectedBlades,
    contract: "one local browser run; timings and memory are observations, never pass/fail limits or SLAs",
    timingsMs: {
      fillGeneration: fillGenerationMs,
      workerPreview: previewMs,
      exportSnapshotCopy: snapshotMs,
      cachedPhysicalExport: exportMs,
      total: performance.now() - startedAt,
    },
    memory: { before: beforeMemory, after: memorySample() },
    preview: {
      scene: previewScene,
      progressMessageCount: previewTrace.responseTypeCounts.progress ?? 0,
      terminalProgressCount: previewTrace.terminalProgressCount,
      coordinatorProgressCount: previewProgress.length,
      responseValidation: {
        validMessageCount: previewTrace.validatedResponseCount,
        invalidMessageCount: previewTrace.invalidResponseCount,
      },
      structuredClone: {
        responseIdentityReferenceDiffers: previewMessage.identity !== identity,
        responseIdentityValueMatches: outlineComputeIdentitiesEqual(
          previewMessage.identity,
          identity,
        ),
        coordinatorSceneIsWorkerResponseScene:
          previewMessage.scene === previewResult.scene,
      },
    },
    cacheAndPhysicalExportReuse: {
      matchingReusableOutlineCaptured: snapshot.reusableOutline !== undefined,
      previewCacheIsCoordinatorScene: previewCache.scene === previewResult.scene,
      snapshotCopyReferenceDiffers: snapshot.reusableOutline.scene !== previewCache.scene,
      workerResponseCopyReferenceDiffers:
        exportMessage.completedOutline.scene !== snapshot.reusableOutline.scene,
      coordinatorSceneIsWorkerResponseScene:
        exportMessage.completedOutline.scene === exportResult.completedOutline.scene,
      settledCacheCopyReferenceDiffers:
        session.cache.scene !== exportResult.completedOutline.scene,
      previewDerivationCount:
        (previewTrace.responseTypeCounts.progress ?? 0) > 0 ? 1 : 0,
      exportDerivationCount:
        (exportTrace.responseTypeCounts["derivation-progress"] ?? 0) > 0
          ? 1
          : 0,
      exportDerivationProgressMessageCount:
        exportTrace.responseTypeCounts["derivation-progress"] ?? 0,
      finalizingMessageCount: exportTrace.responseTypeCounts.finalizing ?? 0,
      completedSceneMatchesPreviewHash: exportScene.sha256 === previewScene.sha256,
      completedScene: exportScene,
      physicalSvg,
      responseValidation: {
        validMessageCount: exportTrace.validatedResponseCount,
        invalidMessageCount: exportTrace.invalidResponseCount,
      },
    },
    noFallback: {
      specializedSketchIdentity: identity.sourceKind === "specialized-sketch",
      legacySourceSceneAbsent: !("sourceScene" in identity),
      previewStatus: previewResult.status,
      exportStatus: exportResult.status,
    },
  };
}

async function runAll(): Promise<BrowserWorkerEvidence> {
  STATUS?.replaceChildren("Running adopted 10k production Worker path…");
  const adopted = await runScenario("adopted-10k", 2);
  STATUS?.replaceChildren("Running supported-ceiling 50k production Worker path…");
  const ceiling = await runScenario("supported-ceiling-50k", 10);
  const evidence: BrowserWorkerEvidence = {
    schemaVersion: 1,
    referenceId: "grass-hills-faithful-visible-line",
    capturedAt: new Date().toISOString(),
    warning: "Observations from one browser/machine run; not SLAs and not test limits.",
    machine: {
      userAgent: navigator.userAgent,
      platform:
        (navigator as EvidenceNavigator).userAgentData?.platform ??
        navigator.platform,
      logicalCpuCount: navigator.hardwareConcurrency ?? null,
      deviceMemoryGiB: (navigator as EvidenceNavigator).deviceMemory ?? null,
    },
    scenarios: [adopted, ceiling],
  };
  STATUS?.replaceChildren(JSON.stringify(evidence, null, 2));
  return evidence;
}

(window as WindowWithEvidence).__GRASS_HILLS_OUTLINE_WORKER_EVIDENCE__ =
  Object.freeze({ runAll });
STATUS?.replaceChildren("Ready. Call __GRASS_HILLS_OUTLINE_WORKER_EVIDENCE__.runAll().");
