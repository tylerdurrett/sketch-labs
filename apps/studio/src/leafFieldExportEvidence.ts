import {
  applyPreset,
  deserialize,
  leafField,
  plotDrawableRectangle,
  resolveCompositionFrame,
  type HiddenLineProgress,
  type Scene,
} from "@harness/core";

import busyLeavesBalls from "../../../packages/core/src/sketches/leaf-field/presets/busy-leaves-balls.json";
import { createOutlineWorker } from "./createOutlineWorker";
import {
  HiddenLineCoordinator,
  type HiddenLineExportProgressUpdate,
  type HiddenLineProgressUpdate,
  type OutlineWorkerPort,
} from "./hiddenLineCoordinator";
import {
  createHiddenLineExportSnapshot,
  createOutlineComputeIdentity,
  isHiddenLineWorkerMessage,
  isOutlineComputeProgress,
  isOutlineComputeResponse,
  type HiddenLineWorkerRequest,
  type ImmutableScene,
  type OutlineComputeRequest,
} from "./outlineComputeProtocol";

const STATUS = document.querySelector<HTMLPreElement>("#status");

interface Trace {
  requestCount: number;
  terminatedCount: number;
  validMessageCount: number;
  invalidMessageCount: number;
  messageCounts: Record<string, number>;
  compactStatus: {
    messageCount: number;
    maxSerializedBytes: number;
    keySets: string[][];
    containsIdentity: boolean;
    containsSourceScene: boolean;
  };
  lastProgress: HiddenLineProgress | null;
}

interface EvidenceGlobal {
  readonly runAll: () => Promise<unknown>;
}

interface EvidenceWindow extends Window {
  __LEAF_FIELD_EXPORT_EVIDENCE__?: EvidenceGlobal;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function createTrace(): Trace {
  return {
    requestCount: 0,
    terminatedCount: 0,
    validMessageCount: 0,
    invalidMessageCount: 0,
    messageCounts: {},
    compactStatus: {
      messageCount: 0,
      maxSerializedBytes: 0,
      keySets: [],
      containsIdentity: false,
      containsSourceScene: false,
    },
    lastProgress: null,
  };
}

function messageType(value: unknown): string {
  return typeof value === "object" && value !== null && "type" in value
    ? String(value.type)
    : typeof value;
}

function observeMessage(trace: Trace, value: unknown): void {
  const type = messageType(value);
  trace.messageCounts[type] = (trace.messageCounts[type] ?? 0) + 1;
  const valid =
    isOutlineComputeProgress(value) ||
    isOutlineComputeResponse(value) ||
    isHiddenLineWorkerMessage(value);
  if (valid) trace.validMessageCount++;
  else trace.invalidMessageCount++;

  if (
    typeof value !== "object" ||
    value === null ||
    (type !== "derivation-progress" && type !== "finalizing")
  ) {
    return;
  }
  const record = value as Record<string, unknown>;
  const serializedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  trace.compactStatus.messageCount++;
  trace.compactStatus.maxSerializedBytes = Math.max(
    trace.compactStatus.maxSerializedBytes,
    serializedBytes,
  );
  const keys = Object.keys(record);
  if (!trace.compactStatus.keySets.some((candidate) =>
    candidate.length === keys.length && candidate.every((key, index) => key === keys[index]))) {
    trace.compactStatus.keySets.push(keys);
  }
  trace.compactStatus.containsIdentity ||= "identity" in record;
  trace.compactStatus.containsSourceScene ||=
    "sourceScene" in record || JSON.stringify(value).includes("sourceScene");
  if (type === "derivation-progress") {
    trace.lastProgress = record.snapshot as HiddenLineProgress;
  }
}

function tracedWorkerFactory(traces: Trace[]): () => OutlineWorkerPort {
  return () => {
    const worker = createOutlineWorker();
    const trace = createTrace();
    traces.push(trace);
    return {
      postMessage(message: HiddenLineWorkerRequest | OutlineComputeRequest) {
        trace.requestCount++;
        worker.postMessage(message);
      },
      terminate() {
        trace.terminatedCount++;
        worker.terminate();
      },
      addEventListener(type, listener) {
        if (type === "message") {
          worker.addEventListener("message", (event: MessageEvent<unknown>) => {
            observeMessage(trace, event.data);
            listener(event);
          });
        } else {
          worker.addEventListener(type, listener as EventListener);
        }
      },
    };
  };
}

function pointCount(scene: Scene | ImmutableScene): number {
  return scene.primitives.reduce(
    (total, primitive) => total + primitive.points.length,
    0,
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function describeScene(scene: Scene | ImmutableScene) {
  const serialized = JSON.stringify(scene);
  return {
    serializedBytes: new TextEncoder().encode(serialized).byteLength,
    sha256: await sha256(serialized),
    primitiveCount: scene.primitives.length,
    pointCount: pointCount(scene),
  };
}

async function describeSvg(svg: string) {
  return {
    serializedBytes: new TextEncoder().encode(svg).byteLength,
    sha256: await sha256(svg),
    pathCount: (svg.match(/<path\b/g) ?? []).length,
  };
}

function etaSummary(
  updates: readonly (HiddenLineProgressUpdate | HiddenLineExportProgressUpdate)[],
) {
  const derivation = updates.filter(
    (update): update is HiddenLineProgressUpdate | (HiddenLineExportProgressUpdate & { phase: "derivation" }) =>
      !("phase" in update) || update.phase === "derivation",
  );
  return {
    updateCount: updates.length,
    derivationUpdateCount: derivation.length,
    first: derivation[0]?.eta ?? null,
    last: derivation.at(-1)?.eta ?? null,
    lastWorkUnits: derivation.at(-1)?.snapshot ?? null,
  };
}

async function runAll() {
  const capturedAt = new Date().toISOString();
  const preset = applyPreset(
    leafField.schema,
    deserialize({ ...busyLeavesBalls, version: 2 }),
  );
  assert(preset.profile !== undefined, "busy-leaves-balls must carry a Plot Profile");
  const drawable = plotDrawableRectangle(preset.profile);
  const compositionFrame = resolveCompositionFrame(drawable.width / drawable.height);

  STATUS?.replaceChildren("Generating dense Leaf Field Fill Scene…");
  const fillStartedAt = performance.now();
  const sourceScene = leafField.generate(
    preset.params,
    preset.seed,
    0,
    compositionFrame,
  );
  const fillGenerationMs = performance.now() - fillStartedAt;
  const source = await describeScene(sourceScene);
  const identity = createOutlineComputeIdentity({
    sketchId: leafField.id,
    schema: leafField.schema,
    params: preset.params,
    seed: preset.seed,
    sampledT: 0,
    compositionFrame,
    tolerance: 0,
    sourceScene,
  });
  assert(identity.sourceKind === "legacy-scene", "Leaf Field must use the legacy Scene identity");

  const traces: Trace[] = [];
  const coordinator = new HiddenLineCoordinator(tracedWorkerFactory(traces));

  STATUS?.replaceChildren("Running production Outline preview…");
  const previewUpdates: HiddenLineProgressUpdate[] = [];
  const previewStartedAt = performance.now();
  const preview = await coordinator.startOutline(identity, (update) => {
    previewUpdates.push(update);
  });
  const previewMs = performance.now() - previewStartedAt;
  assert(preview.status === "success", "Outline preview failed");
  const previewScene = await describeScene(preview.scene);

  const coldSnapshot = createHiddenLineExportSnapshot({
    identity,
    profile: preset.profile,
    metadata: "Leaf Field issue #302 browser evidence",
    includePaperMargins: true,
    filename: "busy-leaves-balls-hidden-line.svg",
  });
  assert(coldSnapshot.reusableOutline === undefined, "cold export unexpectedly captured a cache candidate");

  STATUS?.replaceChildren("Running cold direct hidden-line export…");
  const coldUpdates: HiddenLineExportProgressUpdate[] = [];
  const coldStartedAt = performance.now();
  const cold = await coordinator.startExport(coldSnapshot, (update) => {
    coldUpdates.push(update);
  });
  const coldMs = performance.now() - coldStartedAt;
  assert(cold.status === "success", "cold hidden-line export failed");
  const coldScene = await describeScene(cold.completedOutline.scene);
  assert(coldScene.sha256 === previewScene.sha256, "preview and cold export derived different Outline Scenes");

  const warmSnapshot = createHiddenLineExportSnapshot({
    identity,
    profile: preset.profile,
    metadata: "Leaf Field issue #302 warm reuse evidence",
    includePaperMargins: true,
    filename: "busy-leaves-balls-hidden-line-warm.svg",
    reusableOutline: cold.completedOutline,
  });
  assert(warmSnapshot.reusableOutline !== undefined, "exact completed Outline was not captured");

  STATUS?.replaceChildren("Running warm exact-cache hidden-line export…");
  const warmUpdates: HiddenLineExportProgressUpdate[] = [];
  const warmStartedAt = performance.now();
  const warm = await coordinator.startExport(warmSnapshot, (update) => {
    warmUpdates.push(update);
  });
  const warmMs = performance.now() - warmStartedAt;
  assert(warm.status === "success", "warm hidden-line export failed");
  const warmScene = await describeScene(warm.completedOutline.scene);
  assert(warmScene.sha256 === coldScene.sha256, "warm export did not reuse exact Outline geometry");

  STATUS?.replaceChildren("Starting and cancelling a separate cold export…");
  const cancelCoordinator = new HiddenLineCoordinator(tracedWorkerFactory(traces));
  let cancelRequested = false;
  const cancelStartedAt = performance.now();
  const cancelledPromise = cancelCoordinator.startExport(coldSnapshot, (update) => {
    if (update.phase === "derivation" && !cancelRequested) {
      cancelRequested = cancelCoordinator.cancel();
    }
  });
  const cancelled = await cancelledPromise;
  const cancelMs = performance.now() - cancelStartedAt;
  assert(cancelRequested && cancelled.status === "cancelled", "cold export cancellation failed");

  const [previewTrace, coldTrace, warmTrace, cancelTrace] = traces;
  assert(previewTrace !== undefined && coldTrace !== undefined && warmTrace !== undefined && cancelTrace !== undefined, "expected four real Workers");
  assert(coldTrace.invalidMessageCount === 0, "cold export emitted an invalid message");
  assert(coldTrace.compactStatus.messageCount > 0, "cold export emitted no compact status");
  assert(!coldTrace.compactStatus.containsIdentity, "compact status carried identity");
  assert(!coldTrace.compactStatus.containsSourceScene, "compact status carried sourceScene");
  assert((warmTrace.messageCounts["derivation-progress"] ?? 0) === 0, "warm export rederived geometry");

  const evidence = {
    schemaVersion: 1,
    issue: 302,
    referenceId: "leaf-field-busy-leaves-balls-compact-export-progress",
    capturedAt,
    warning: "One browser/machine observation. Timings are evidence only, never pass/fail limits or SLAs.",
    machine: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      logicalCpuCount: navigator.hardwareConcurrency ?? null,
    },
    input: {
      preset: "busy-leaves-balls",
      identityKind: identity.sourceKind,
      source,
    },
    timingsMs: {
      fillGeneration: fillGenerationMs,
      preview: previewMs,
      coldExport: coldMs,
      warmExactReuse: warmMs,
      cancellation: cancelMs,
    },
    preview: {
      status: preview.status,
      scene: previewScene,
      messages: previewTrace.messageCounts,
      progress: etaSummary(previewUpdates),
      derivationCount: (previewTrace.messageCounts.progress ?? 0) > 0 ? 1 : 0,
    },
    coldExport: {
      status: cold.status,
      scene: coldScene,
      svg: await describeSvg(cold.svg),
      messages: coldTrace.messageCounts,
      compactStatus: coldTrace.compactStatus,
      progress: etaSummary(coldUpdates),
      derivationCount: (coldTrace.messageCounts["derivation-progress"] ?? 0) > 0 ? 1 : 0,
      matchesPreviewScene: coldScene.sha256 === previewScene.sha256,
    },
    warmExactReuse: {
      status: warm.status,
      scene: warmScene,
      messages: warmTrace.messageCounts,
      progress: etaSummary(warmUpdates),
      derivationCount: (warmTrace.messageCounts["derivation-progress"] ?? 0) > 0 ? 1 : 0,
      matchesColdScene: warmScene.sha256 === coldScene.sha256,
    },
    cancellation: {
      status: cancelled.status,
      cancelRequested,
      messagesBeforeTermination: cancelTrace.messageCounts,
      compactStatus: cancelTrace.compactStatus,
      lastWorkUnits: cancelTrace.lastProgress,
      workerTerminatedCount: cancelTrace.terminatedCount,
    },
  };
  coordinator.dispose();
  cancelCoordinator.dispose();
  STATUS?.replaceChildren(JSON.stringify(evidence, null, 2));
  return evidence;
}

(window as EvidenceWindow).__LEAF_FIELD_EXPORT_EVIDENCE__ = Object.freeze({ runAll });
STATUS?.replaceChildren("Ready. Call __LEAF_FIELD_EXPORT_EVIDENCE__.runAll().");
