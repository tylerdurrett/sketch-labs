// @vitest-environment jsdom
import {
  act,
  StrictMode,
  useEffect,
  useImperativeHandle,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activeParams,
  applyPreset,
  clipSceneToBounds,
  computePlotMapping,
  createShadingMask,
  createScribbleMoonStructuralScene,
  createToneField,
  crc32,
  DEFAULT_COMPOSITION_FRAME,
  defaultParams,
  frameScene,
  HARNESS_FALLBACK_PLOT_PROFILE,
  hiddenLinePass,
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  leafField,
  newSeed,
  photoScribble,
  prepareImageDetailAnalysis,
  renderPlotterSVG,
  resolveCompositionFrame,
  resolvePlotCompositionFrame,
  scribbleMoon,
  toneCalibration,
  type CoordinateSpace,
  type DetailField,
  type Params,
  type ParamSchema,
  type PageFrame,
  type PlotProfile,
  type Preset,
  type Scene,
  type ShadingDiagnostics,
  type Seed,
  type SketchEnvironment,
  type ToneSource,
} from "@harness/core";

import type {
  DisplayedSceneSnapshot,
  LiveCanvasHandle,
} from "./LiveCanvas";
import { mutableScene } from "./outlineComputeProtocol";
import {
  finalizeOutlineScene,
  outlineScene,
  type OutlineFinalizationStrokePolicy,
} from "./outlineScene";
import { ImageAssetResolutionError } from "./imageAssetResolver";
import {
  beginPageFrameManipulation,
  finishPageFrameManipulation,
  updatePageFrameManipulation,
  type PageFrameAspectConstraint,
  type PageFrameManipulationState,
  type PageFrameManipulationTarget,
  type PageFramePointer,
} from "./pageFrameManipulation";
import type { PageFrameEditDraft } from "./pageFrameEditDraft";
import {
  createShadingComputeIdentity,
  isShadingComputeIdentity,
} from "./shadingComputeProtocol";
import { SketchControls } from "./SketchControls";
import type { EditHistory } from "./editHistory";
import {
  FIXED_PAGE_PARITY_COMPOSITION,
  FIXED_PAGE_PARITY_FRAME,
  FIXED_PAGE_PARITY_PROFILE,
  fixedPageParityScene,
} from "./fixedPageOutputParity.test-support";

// Preview == export seam probe (issue #220): capture the Scene the export path
// hands `renderToSVG`, so a test can prove it is the SAME processed Scene the
// shared {@link outlineScene} seam produces (the exact expression the outline
// preview also consumes). `vi.hoisted` lifts the holder above the hoisted
// `vi.mock` factory below so the factory can close over it.
const exportSceneCapture = vi.hoisted(() => ({
  current: null as unknown,
}));
const plotterExportCapture = vi.hoisted(() => ({
  current: null as null | {
    scene: unknown;
    profile: PlotProfile;
    metadata: string | undefined;
    options: { includePaperMargins?: boolean } | undefined;
  },
}));
const historyCapture = vi.hoisted(() => ({
  atomic: [] as { before: EditHistory; after: EditHistory }[],
  transactionCommits: [] as { before: EditHistory; after: EditHistory }[],
  cancels: [] as { before: EditHistory; after: EditHistory }[],
}));
const outlineJob = vi.hoisted(() => ({
  coordinators: 0,
  disposals: 0,
  starts: 0,
  active: null as null | {
    identity: import("./outlineComputeProtocol").OutlineComputeIdentity;
    resolve: (result: unknown) => void;
    observeProgress: ((
      update: import("./hiddenLineCoordinator").HiddenLineProgressUpdate,
    ) => void) | undefined;
  },
  lastIdentity: null as import("./outlineComputeProtocol").OutlineComputeIdentity | null,
  lastCompletedScene: null as DisplayedSceneSnapshot["scene"] | null,
  exportStarts: 0,
  exportDerivations: 0,
  exportFinalizations: 0,
  lastExportSnapshot:
    null as import("./outlineComputeProtocol").HiddenLineExportSnapshot | null,
  exportMode: "success" as "success" | "pending" | "failure",
  pendingExport: null as null | {
    snapshot: import("./outlineComputeProtocol").HiddenLineExportSnapshot;
    reportProgress: (
      completedWorkUnits: number,
      totalWorkUnits: number,
      eta: import("./rollingEta").RollingEtaEstimate,
    ) => void;
    finalize: () => void;
    succeed: () => void;
    fail: (detail?: string) => void;
    cancel: () => void;
  },
}));
const shadingJob = vi.hoisted(() => ({
  coordinators: 0,
  disposals: 0,
  cancelCount: 0,
  starts: [] as Array<{
    identity: import("./shadingComputeProtocol").ShadingComputeIdentity;
    resolve: (result: unknown) => void;
    observeProgress:
      | import("./shadingCoordinator").ShadingProgressObserver
      | undefined;
  }>,
}));
const detailJob = vi.hoisted(() => ({
  cancelCount: 0,
  resolveOnCancel: true,
  disposals: 0,
  starts: [] as Array<{
    identity: import("./detailPreparationProtocol").DetailPreparationIdentity;
    resolve: (result: unknown) => void;
  }>,
  active: null as null | {
    identity: import("./detailPreparationProtocol").DetailPreparationIdentity;
    resolve: (result: unknown) => void;
  },
}));
const orchestrationEvents = vi.hoisted(() => [] as string[]);
const sketchEnvironmentJob = vi.hoisted(() => ({
  starts: [] as Array<{
    params: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
    resolve: (environment: import("@harness/core").SketchEnvironment) => void;
    reject: (error: unknown) => void;
  }>,
}));
const managedImageAssetJob = vi.hoisted(() => ({
  list: vi.fn(),
  normalize: vi.fn(),
  import: vi.fn(),
}));
const controlPanelCapture = vi.hoisted(() => ({
  recomposeHandlers: [] as Array<(request: {
    readonly paramKey: string;
    readonly imageAssetId: string;
    readonly dimensions: { readonly width: number; readonly height: number };
  }) => void>,
}));

vi.mock("./ControlPanel", async (importActual) => {
  const actual = await importActual<typeof import("./ControlPanel")>();
  const ControlPanel = actual.ControlPanel;
  return {
    ...actual,
    ControlPanel: (props: Parameters<typeof ControlPanel>[0]) => {
      if (props.onRecomposeToImageAspect !== undefined) {
        controlPanelCapture.recomposeHandlers.push(
          props.onRecomposeToImageAspect,
        );
      }
      return <ControlPanel {...props} />;
    },
  };
});

vi.mock("./imageAssetsClient", async (importActual) => {
  const actual = await importActual<typeof import("./imageAssetsClient")>();
  return {
    ...actual,
    listImageAssets: managedImageAssetJob.list,
    importImageAsset: managedImageAssetJob.import,
  };
});

vi.mock("./imageAssetNormalization", async (importActual) => {
  const actual =
    await importActual<typeof import("./imageAssetNormalization")>();
  return {
    ...actual,
    normalizeImageAsset: managedImageAssetJob.normalize,
  };
});

vi.mock("./imageAssetResolver", async (importActual) => {
  const actual = await importActual<typeof import("./imageAssetResolver")>();
  return {
    ...actual,
    resolveSketchEnvironment: (
      _schema: unknown,
      params: Readonly<Record<string, unknown>>,
      _dependencies: unknown,
      signal: AbortSignal,
    ) =>
      new Promise((resolve, reject) => {
        sketchEnvironmentJob.starts.push({ params, signal, resolve, reject });
      }),
  };
});

vi.mock("./shadingCoordinator", () => ({
  ShadingCoordinator: class {
    private disposed = false;

    constructor() {
      shadingJob.coordinators += 1;
    }

    start(
      identity: import("./shadingComputeProtocol").ShadingComputeIdentity,
      observeProgress?: import("./shadingCoordinator").ShadingProgressObserver,
    ) {
      orchestrationEvents.push("shading:start");
      return new Promise((resolve) => {
        shadingJob.starts.push({ identity, resolve, observeProgress });
      });
    }

    cancel() {
      orchestrationEvents.push("shading:cancel");
      shadingJob.cancelCount += 1;
      return true;
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      shadingJob.disposals += 1;
      this.cancel();
    }
  },
}));

vi.mock("./detailCoordinator", () => ({
  DetailCoordinator: class {
    private disposed = false;

    start(
      identity: import("./detailPreparationProtocol").DetailPreparationIdentity,
    ) {
      orchestrationEvents.push("detail:start");
      return new Promise((resolve) => {
        const active = { identity, resolve };
        detailJob.active = active;
        detailJob.starts.push(active);
      });
    }

    cancel() {
      detailJob.cancelCount += 1;
      const active = detailJob.active;
      if (active === null) return false;
      detailJob.active = null;
      if (detailJob.resolveOnCancel) {
        active.resolve({ status: "cancelled", jobId: 1 });
      }
      return true;
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      detailJob.disposals += 1;
      this.cancel();
    }
  },
}));

vi.mock("./hiddenLineCoordinator", () => ({
  HiddenLineCoordinator: class {
    private disposed = false;

    constructor() {
      outlineJob.coordinators += 1;
    }

    start(
      identity: import("./outlineComputeProtocol").OutlineComputeIdentity,
      observeProgress?: (
        update: import("./hiddenLineCoordinator").HiddenLineProgressUpdate,
      ) => void,
    ) {
      if (this.disposed) {
        return Promise.reject(new Error("Hidden-line coordinator is disposed"));
      }
      outlineJob.starts += 1;
      outlineJob.lastIdentity = identity;
      return {
        then(resolve: (result: unknown) => void) {
          outlineJob.active = { identity, resolve, observeProgress };
          return Promise.resolve();
        },
      };
    }
    startExport(
      snapshot: import("./outlineComputeProtocol").HiddenLineExportSnapshot,
      observeProgress?: (
        update: import("./hiddenLineCoordinator").HiddenLineExportProgressUpdate,
      ) => void,
    ) {
      if (this.disposed) {
        return Promise.reject(new Error("Hidden-line coordinator is disposed"));
      }
      outlineJob.exportStarts += 1;
      outlineJob.lastExportSnapshot = snapshot;
      if (snapshot.reusableOutline === undefined) {
        outlineJob.exportDerivations += 1;
      }
      const processed =
        snapshot.reusableOutline === undefined
          ? outlineScene(
              snapshot.identity.sourceKind !== "specialized-sketch"
                ? mutableScene(snapshot.identity.sourceScene)
                : {
                    space: { ...snapshot.identity.compositionFrame },
                    primitives: [],
                  },
              snapshot.identity.tolerance,
            )
          : mutableScene(snapshot.reusableOutline.scene);
      const clipped = clipSceneToBounds(
        finalizeOutlineScene(
          processed,
          snapshot.pageFrame,
          snapshot.profile.includeFrame,
          snapshot.identity.sourceKind === "legacy-scene"
            ? {
                kind: "legacy-scene",
                target: {
                  toolWidthMillimeters:
                    snapshot.profile.toolWidthMillimeters,
                  millimetersPerSceneUnit: computePlotMapping(
                    snapshot.pageFrame === null
                      ? snapshot.identity.compositionFrame
                      : {
                          width: snapshot.pageFrame.width,
                          height: snapshot.pageFrame.height,
                        },
                    snapshot.profile,
                  ).scale,
                },
              }
            : {
                kind: "physical-tool",
                target: snapshot.identity.outlineTarget,
              },
        ),
      );
      outlineJob.exportFinalizations += 1;
      const payload = {
        status: "success" as const,
        jobId: 1,
        identity: snapshot.identity,
        svg: renderPlotterSVG(
          clipped,
          snapshot.profile as PlotProfile,
          snapshot.metadata,
          { includePaperMargins: snapshot.includePaperMargins },
        ),
        filename: snapshot.filename,
        completedOutline: {
          identity: snapshot.identity,
          scene: processed,
        },
      };
      if (outlineJob.exportMode === "pending") {
        return new Promise((resolve) => {
          outlineJob.pendingExport = {
            snapshot,
            reportProgress: (completedWorkUnits, totalWorkUnits, eta) =>
              observeProgress?.({
                phase: "derivation",
                snapshot: {
                  completedWorkUnits,
                  totalWorkUnits,
                  terminal: completedWorkUnits === totalWorkUnits,
                },
                eta,
              }),
            finalize: () => observeProgress?.({ phase: "finalizing" }),
            succeed: () => {
              outlineJob.pendingExport = null;
              resolve(payload);
            },
            fail: (detail = "test failure") => {
              outlineJob.pendingExport = null;
              resolve({ status: "failure", jobId: 1, error: detail });
            },
            cancel: () => {
              outlineJob.pendingExport = null;
              resolve({ status: "cancelled", jobId: 1 });
            },
          };
        });
      }
      observeProgress?.({ phase: "finalizing" });
      if (outlineJob.exportMode === "failure") {
        const failure = { status: "failure" as const, jobId: 1, error: "test failure" };
        return {
          then(resolve: (result: typeof failure) => void) {
            resolve(failure);
            return { catch() {} };
          },
        };
      }
      return {
        then(resolve: (result: typeof payload) => void) {
          resolve(payload);
          return { catch() {} };
        },
      };
    }
    cancel() {
      if (outlineJob.pendingExport !== null) {
        const pending = outlineJob.pendingExport;
        outlineJob.pendingExport = null;
        pending.cancel();
        return true;
      }
      const active = outlineJob.active;
      if (active === null) return false;
      outlineJob.active = null;
      active.resolve({ status: "cancelled", jobId: 1 });
      return true;
    }
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      outlineJob.disposals += 1;
      this.cancel();
    }
  },
}));

// Probe both SVG serializers while delegating to their real implementations, so
// document assertions exercise core and each wiring test can identify the exact
// Scene/profile it received. Everything else in `@harness/core` is genuine.
vi.mock("@harness/core", async (importActual) => {
  const actual = await importActual<typeof import("@harness/core")>();
  return {
    ...actual,
    renderToSVG: (
      ...args: Parameters<typeof actual.renderToSVG>
    ): ReturnType<typeof actual.renderToSVG> => {
      exportSceneCapture.current = args[0];
      return actual.renderToSVG(...args);
    },
    renderPlotterSVG: (
      ...args: Parameters<typeof actual.renderPlotterSVG>
    ): ReturnType<typeof actual.renderPlotterSVG> => {
      plotterExportCapture.current = {
        scene: args[0],
        profile: args[1],
        metadata: args[2],
        options: args[3],
      };
      return actual.renderPlotterSVG(...args);
    },
  };
});

// Keep the real immutable model while recording the central Studio boundary.
// These integration assertions can distinguish atomic commands and transaction
// settlement without exposing history as product UI or adding a test-only prop.
vi.mock("./editHistory", async (importActual) => {
  const actual = await importActual<typeof import("./editHistory")>();
  return {
    ...actual,
    commitEditState: (...args: Parameters<typeof actual.commitEditState>) => {
      const after = actual.commitEditState(...args);
      historyCapture.atomic.push({ before: args[0], after });
      return after;
    },
    commitEditTransaction: (
      ...args: Parameters<typeof actual.commitEditTransaction>
    ) => {
      const after = actual.commitEditTransaction(...args);
      historyCapture.transactionCommits.push({ before: args[0], after });
      return after;
    },
    cancelEditTransaction: (
      ...args: Parameters<typeof actual.cancelEditTransaction>
    ) => {
      const after = actual.cancelEditTransaction(...args);
      historyCapture.cancels.push({ before: args[0], after });
      return after;
    },
  };
});

// The fake canvas node the mocked LiveCanvas hands back through its handle, with
// a `toBlob` the export test drives. Reassigned per-test so each case controls
// the blob the export receives (or a null blob to exercise the guard).
let fakeCanvasToBlob: HTMLCanvasElement["toBlob"];
// The current-t the mocked handle reports — the export's `-t{t}` source.
let fakeCurrentT = 0;
// Atomic displayed-Scene snapshot exposed by the mocked LiveCanvas handle.
type TestDisplayedSceneSnapshot = Omit<
  DisplayedSceneSnapshot,
  "sourceScene" | "displayedScene"
> &
  Partial<Pick<DisplayedSceneSnapshot, "sourceScene" | "displayedScene">>;
let fakeDisplayedScene: TestDisplayedSceneSnapshot | null = null;
let fakeDisplayedFillScene: TestDisplayedSceneSnapshot | null = null;
let fakeFillCaptureScene: DisplayedSceneSnapshot["scene"] | null = null;
// #228: the real LiveCanvas signals `onOutlineComputed` when an outline pass has
// drawn, which the owner uses to clear its "Computing…" affordance. The mock
// records the latest callback so a test can drive that signal BY HAND (to observe
// the intermediate "Computing…" state), and — when `autoFireOutlineComputed` is
// true (the default) — fires it in an effect to model the pass completing, so the
// busy label clears exactly as the real component clears it.
let lastOnOutlineComputed: (() => void) | null = null;
let autoFireOutlineComputed = true;
let lastCompositionFrame: CoordinateSpace | null = null;
let lastProfile: PlotProfile | null = null;
let lastPageFrameDraft: PageFrame | null = null;
let lastPageFrameEditDraft: PageFrameEditDraft | null = null;
let lastCommittedPageFrame: PageFrame | null = null;
let lastPageFrameAspectConstraint: PageFrameAspectConstraint | null = null;
let lastOnPageFrameDraftChange: ((frame: PageFrame) => void) | null = null;
let lastToneSource: ToneSource | null = null;
let lastDetailField: DetailField | null = null;
let lastDetailRetry: (() => void) | null = null;
let lastRenderScene: Scene | null = null;
let lastOutlineFinalizationStrokePolicy:
  | OutlineFinalizationStrokePolicy
  | undefined;
let autoAcknowledgeDisplayedScene = true;
let acknowledgeDisplayedScene: (() => void) | null = null;
let generateDuringLiveCanvasRender = false;

// LiveCanvas is a browser-only sink (canvas2d, ResizeObserver, matchMedia) and
// is NOT under test here — these are wiring tests for the control state. Replace
// it with a probe that surfaces the `seed` it is fed into the DOM AND wires the
// `handleRef` to a fake canvas + current-t, so we can assert the seed the canvas
// receives AND drive the PNG export without polyfilling the whole canvas stack.
vi.mock("./LiveCanvas", () => ({
  LiveCanvas: ({
    sketch,
    params,
    seed,
    renderState,
    tolerance,
    outlineFinalizationStrokePolicy,
    compositionFrame,
    profile,
    pageFrameDraft,
    pageFrameEditDraft,
    onPageFrameDraftChange,
    pageFrameAspectConstraint,
    pageFrame,
    handleRef,
    inputRevision = 0,
    fillCaptureRequest,
    onFillCaptured,
    onDisplayedSceneCommitted,
  }: {
    sketch: Parameters<typeof SketchControls>[0]["sketch"];
    params: Record<string, unknown>;
    seed: Seed;
    renderState?: {
      kind: string;
      scene?: unknown;
      t?: number;
      source?: ToneSource;
      field?: DetailField;
      onRetry?: () => void;
      sourceInputRevision?: number;
      contentRevision?: number;
      status?: string;
      unresolvedAssetIds?: readonly string[];
    };
    tolerance?: number;
    outlineFinalizationStrokePolicy?: OutlineFinalizationStrokePolicy;
    compositionFrame: CoordinateSpace;
    profile: PlotProfile;
    pageFrameDraft?: PageFrame | null;
    pageFrameEditDraft?: PageFrameEditDraft | null;
    onPageFrameDraftChange?: (frame: PageFrame) => void;
    pageFrameAspectConstraint?: PageFrameAspectConstraint;
    pageFrame?: PageFrame | null;
    handleRef?: Ref<LiveCanvasHandle>;
    inputRevision?: number;
    fillCaptureRequest?: {
      token: number;
      inputRevision: number;
      sourceInputRevision?: number;
      contentRevision?: number;
    } | null;
    onFillCaptured?: (capture: unknown) => void;
    onDisplayedSceneCommitted?: (snapshot: DisplayedSceneSnapshot) => void;
  }) => {
    if (
      generateDuringLiveCanvasRender &&
      renderState?.kind !== "unavailable" &&
      renderState?.scene === undefined
    ) {
      sketch.generate(params, seed, fakeCurrentT, compositionFrame);
    }
    const capturedFrame = (
      retained = fakeDisplayedScene,
    ): DisplayedSceneSnapshot => {
      if (retained !== null) {
        return {
          ...retained,
          sourceScene:
            retained.sourceScene ?? retained.scene,
          displayedScene:
            retained.displayedScene ?? retained.scene,
        };
      }
      const scene =
        renderState?.scene === undefined
          ? sketch.generate(params, seed, fakeCurrentT, compositionFrame)
          : (renderState.scene as Scene);
      return renderState?.scene === undefined
        ? {
            scene,
            sourceScene: scene,
            displayedScene: scene,
            t: fakeCurrentT,
            renderMode: "fill",
            tolerance: tolerance ?? 0,
            includeFrame: profile.includeFrame,
            inputRevision,
          }
        : {
            scene,
            sourceScene: scene,
            displayedScene: scene,
            t: renderState.t ?? 0,
            renderMode: renderState.kind === "outline" ? "outline" : "fill",
            tolerance: tolerance ?? 0,
            includeFrame: profile.includeFrame,
            ...(renderState.sourceInputRevision === undefined
              ? {}
              : {
                  inputRevision: renderState.sourceInputRevision,
                  sourceInputRevision: renderState.sourceInputRevision,
                }),
            ...(renderState.contentRevision === undefined
              ? {}
              : { contentRevision: renderState.contentRevision }),
          };
    };
    useImperativeHandle(handleRef, () => ({
      getCanvas: () =>
        ({ toBlob: fakeCanvasToBlob }) as unknown as HTMLCanvasElement,
      getCurrentT: () => fakeCurrentT,
      getDisplayedScene: () =>
        fakeDisplayedScene === null ? null : capturedFrame(),
      captureDisplayedFrame: capturedFrame,
      captureDisplayedFillFrame: () =>
        capturedFrame(fakeDisplayedFillScene ?? fakeDisplayedScene),
    }));
    lastOnOutlineComputed = () => {
      const active = outlineJob.active;
      if (active === null) return;
      outlineJob.active = null;
      const scene = outlineScene(
        active.identity.sourceKind !== "specialized-sketch"
          ? mutableScene(active.identity.sourceScene)
          : {
              space: { ...active.identity.compositionFrame },
              primitives: [],
            },
        active.identity.tolerance,
      );
      outlineJob.lastCompletedScene = scene;
      active.resolve({
        status: "success",
        jobId: 1,
        identity: active.identity,
        scene,
      });
    };
    lastCompositionFrame = compositionFrame;
    lastProfile = profile;
    lastPageFrameEditDraft = pageFrameEditDraft ?? null;
    lastPageFrameDraft = pageFrameEditDraft?.frame ?? pageFrameDraft ?? null;
    lastCommittedPageFrame = pageFrame ?? null;
    lastPageFrameAspectConstraint = pageFrameAspectConstraint ?? null;
    lastOnPageFrameDraftChange = onPageFrameDraftChange ?? null;
    lastToneSource = renderState?.source ?? null;
    lastDetailField = renderState?.field ?? null;
    lastDetailRetry = renderState?.onRetry ?? null;
    lastRenderScene = (renderState?.scene as Scene | undefined) ?? null;
    lastOutlineFinalizationStrokePolicy = outlineFinalizationStrokePolicy;
    // Model the outline pass finishing: fire the "computed" signal after each
    // outline render so the owner's busy label clears (unless a test opts out to
    // observe the intermediate "Computing…" state itself).
    useEffect(() => {
      if (fillCaptureRequest !== null && fillCaptureRequest !== undefined) {
        const sourceScene =
          fakeFillCaptureScene ??
          (renderState?.scene as Scene | undefined) ?? {
            space: compositionFrame,
            primitives: [],
          };
        onFillCaptured?.({
          ...fillCaptureRequest,
          scene: sourceScene,
          sourceScene,
          t: fakeCurrentT,
          sourceInputRevision:
            fillCaptureRequest.sourceInputRevision ??
            fillCaptureRequest.inputRevision,
          ...(fillCaptureRequest.contentRevision === undefined
            ? {}
            : { contentRevision: fillCaptureRequest.contentRevision }),
        });
      }
    }, [fillCaptureRequest?.token]);
    useEffect(() => {
      if (
        renderState?.scene === undefined ||
        renderState.sourceInputRevision === undefined ||
        renderState.contentRevision === undefined
      ) {
        return;
      }
      const snapshot: DisplayedSceneSnapshot = {
        scene: renderState.scene as Scene,
        sourceScene: renderState.scene as Scene,
        displayedScene: renderState.scene as Scene,
        t: renderState.t ?? 0,
        renderMode: renderState.kind === "outline" ? "outline" : "fill",
        tolerance: tolerance ?? 0,
        includeFrame: profile.includeFrame,
        inputRevision: renderState.sourceInputRevision,
        sourceInputRevision: renderState.sourceInputRevision,
        contentRevision: renderState.contentRevision,
      };
      acknowledgeDisplayedScene = () => onDisplayedSceneCommitted?.(snapshot);
      if (autoAcknowledgeDisplayedScene) acknowledgeDisplayedScene();
    }, [
      renderState?.kind,
      renderState?.sourceInputRevision,
      renderState?.contentRevision,
    ]);
    useEffect(() => {
      if (outlineJob.active !== null && autoFireOutlineComputed) {
        lastOnOutlineComputed?.();
      }
    });
    return (
      <div
        data-testid="canvas-seed"
        data-render-mode={renderState?.kind === "outline" ? "outline" : "fill"}
        data-render-state={renderState?.kind ?? "fill-live"}
        data-tolerance={String(tolerance)}
        data-include-frame={String(profile.includeFrame)}
        data-input-revision={String(inputRevision)}
        data-source-input-revision={String(
          renderState?.sourceInputRevision ?? "",
        )}
        data-content-revision={String(renderState?.contentRevision ?? "")}
        data-unavailable-status={renderState?.status ?? ""}
        data-unresolved-asset-ids={
          renderState?.unresolvedAssetIds?.join("|") ?? ""
        }
      >
        {String(seed)}
      </div>
    );
  },
}));

// downloadBlob is the DOM-coupled file-save seam (tested on its own); stub it so
// the export wiring test can capture the (blob, filename) it is handed.
const downloadBlob = vi.fn<[Blob, string], void>();
vi.mock("./downloadBlob", () => ({
  downloadBlob: (blob: Blob, filename: string) => downloadBlob(blob, filename),
}));

// The Preset network client is the seam under test for the save/reload wiring:
// stub its three calls so nothing hits `fetch`, and so a test can drive a Reload
// with a Preset of its choosing and capture exactly what a Save serialized.
const listPresets = vi.fn<[string], Promise<string[]>>();
const loadPreset = vi.fn<[string, string], Promise<Preset>>();
const savePreset = vi.fn<[Preset], Promise<void>>();
vi.mock("./presetsClient", () => ({
  listPresets: (id: string) => listPresets(id),
  loadPreset: (id: string, name: string) => loadPreset(id, name),
  savePreset: (preset: Preset) => savePreset(preset),
}));

/**
 * These are WIRING tests, not roll tests. The determinism / independence /
 * exclusion LOGIC lives in core's `randomize` / `newSeed` and is unit-tested in
 * #48. Here we only prove the Studio threads its React state (params, seed,
 * locks) into those engine calls and back onto the controls/canvas:
 *   - New seed reshuffles the seed while leaving every param value identical.
 *   - Randomize re-rolls params but never touches a locked param.
 *   - A locked control's input stays enabled (lock is exclusion, not disable).
 *   - Editing the seed box updates the seed the canvas is fed.
 *
 * `Math.random` is stubbed per-test so the rolled values are deterministic and
 * the assertions are exact — without re-testing the rolls themselves.
 */

// React 19's `act` requires this flag; vitest's jsdom env does not set it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const numberSpec = (over: Record<string, unknown> = {}) =>
  ({ kind: "number", min: 0, max: 100, default: 50, ...over }) as const;

const sketchWith = (id: string, schema: ParamSchema) =>
  ({
    id,
    name: id,
    schema,
    generate: () => ({ space: { width: 100, height: 100 }, strokes: [] }),
  }) as unknown as Parameters<typeof SketchControls>[0]["sketch"];

const toneSketchWith = (id: string, schema: ParamSchema) => ({
  ...sketchWith(id, schema),
  generate: (
    _params: Readonly<Record<string, unknown>>,
    _seed: Seed,
    _t: number,
    frame: CoordinateSpace,
  ) => ({ space: frame, primitives: [] }),
  generateToneSource: (
    params: Readonly<Record<string, unknown>>,
    frame: CoordinateSpace,
  ): ToneSource => ({
    toneField: createToneField(
      () => Number(params.radius ?? 0) / Math.max(frame.width, 1),
    ),
    shadingMask: createShadingMask(() => 1),
  }),
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

/** The render mode SketchControls fed the mocked LiveCanvas this render. */
function canvasRenderMode(el: HTMLElement): string | null {
  return (
    el
      .querySelector('[data-testid="canvas-seed"]')
      ?.getAttribute("data-render-mode") ?? null
  );
}

/** Big-endian 4-byte encoding of an unsigned 32-bit integer. */
function uint32BE(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

/** Frame a PNG chunk: length | type | data | CRC (over type+data). */
function pngChunk(type: string, data: number[]): number[] {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const crc = crc32(Uint8Array.from([...typeBytes, ...data]));
  return [...uint32BE(data.length), ...typeBytes, ...data, ...uint32BE(crc)];
}

/**
 * A minimal, well-formed PNG byte stream (signature + IHDR + IDAT + IEND) the
 * mocked canvas hands back, so the export's `insertPngMetadata` byte-splice has a
 * real PNG to operate on (the live `toBlob` would supply one).
 */
const MINIMAL_PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, // signature
  ...pngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  ...pngChunk("IDAT", [0, 1, 2, 3]),
  ...pngChunk("IEND", []),
]);

beforeEach(() => {
  outlineJob.coordinators = 0;
  outlineJob.disposals = 0;
  outlineJob.starts = 0;
  outlineJob.exportStarts = 0;
  outlineJob.exportDerivations = 0;
  outlineJob.exportFinalizations = 0;
  outlineJob.lastExportSnapshot = null;
  outlineJob.exportMode = "success";
  outlineJob.pendingExport = null;
  outlineJob.active = null;
  outlineJob.lastIdentity = null;
  outlineJob.lastCompletedScene = null;
  shadingJob.coordinators = 0;
  shadingJob.disposals = 0;
  shadingJob.cancelCount = 0;
  shadingJob.starts = [];
  detailJob.cancelCount = 0;
  detailJob.resolveOnCancel = true;
  detailJob.disposals = 0;
  detailJob.starts = [];
  detailJob.active = null;
  orchestrationEvents.length = 0;
  sketchEnvironmentJob.starts = [];
  managedImageAssetJob.list.mockReset().mockResolvedValue([]);
  managedImageAssetJob.normalize.mockReset().mockResolvedValue({
    png: new Blob([MINIMAL_PNG], { type: "image/png" }),
    width: 1,
    height: 1,
  });
  managedImageAssetJob.import.mockReset().mockResolvedValue({
    id: "imported-image-bbbbbbbbbbbb",
    created: true,
  });
  controlPanelCapture.recomposeHandlers = [];
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
  // Sensible defaults so a mount's list-on-mount effect resolves quietly; the
  // save/reload tests override loadPreset/savePreset per case.
  listPresets.mockResolvedValue([]);
  loadPreset.mockReset();
  savePreset.mockReset().mockResolvedValue(undefined);
  // Export defaults: a toBlob that yields a non-null, valid PNG blob, t = 0, and
  // a fresh downloadBlob spy. Per-test overrides drive the time-gated / guard
  // cases. The blob is a real minimal PNG so the metadata byte-splice succeeds.
  fakeCurrentT = 0;
  fakeDisplayedScene = null;
  fakeDisplayedFillScene = null;
  fakeFillCaptureScene = null;
  // #228: default to auto-firing the outline "computed" signal so the busy label
  // clears on its own; the label test opts out to observe "Computing…".
  lastOnOutlineComputed = null;
  lastCompositionFrame = null;
  lastProfile = null;
  lastPageFrameDraft = null;
  lastPageFrameEditDraft = null;
  lastCommittedPageFrame = null;
  lastPageFrameAspectConstraint = null;
  lastOnPageFrameDraftChange = null;
  lastToneSource = null;
  lastDetailField = null;
  lastDetailRetry = null;
  lastRenderScene = null;
  lastOutlineFinalizationStrokePolicy = undefined;
  autoAcknowledgeDisplayedScene = true;
  acknowledgeDisplayedScene = null;
  generateDuringLiveCanvasRender = false;
  autoFireOutlineComputed = true;
  window.localStorage.clear();
  fakeCanvasToBlob = ((cb: BlobCallback) => {
    cb(new Blob([MINIMAL_PNG], { type: "image/png" }));
  }) as HTMLCanvasElement["toBlob"];
  downloadBlob.mockReset();
  // Clear both serializer probes so each test observes only its own export.
  exportSceneCapture.current = null;
  plotterExportCapture.current = null;
  historyCapture.atomic.length = 0;
  historyCapture.transactionCommits.length = 0;
  historyCapture.cancels.length = 0;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** Flush pending microtasks (resolved client promises) inside React's `act`. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Set a text input's value and fire the React-observed `input` event. */
function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The number input for a given param key (the source of truth for its value). */
function paramInput(el: HTMLElement, key: string): HTMLInputElement {
  const input = el.querySelector<HTMLInputElement>(`#control-${key}`);
  if (input === null) throw new Error(`no input for param ${key}`);
  return input;
}

/** The schema-derived Choice select for a given parameter key. */
function choiceParamSelect(el: HTMLElement, key: string): HTMLSelectElement {
  const select = el.querySelector<HTMLSelectElement>(`select#control-${key}`);
  if (select === null) throw new Error(`no Choice control for param ${key}`);
  return select;
}

/** Set one controlled select through the native setter React observes. */
function selectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function clickButton(el: HTMLElement, text: string): void {
  const button = [...el.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  if (button === undefined) throw new Error(`no button labelled ${text}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function containsBinaryPayload(value: unknown): boolean {
  if (
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.some(containsBinaryPayload);
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some(containsBinaryPayload);
}

function reportOutlineProgress(
  completedWorkUnits: number,
  totalWorkUnits: number,
  eta:
    | { readonly kind: "estimating"; readonly revision: number }
    | {
        readonly kind: "remaining";
        readonly revision: number;
        readonly remainingMs: number;
      } = { kind: "estimating", revision: 1 },
): void {
  const observe = outlineJob.active?.observeProgress;
  if (observe === undefined) throw new Error("no active progress observer");
  act(() => {
    observe({
      snapshot: {
        completedWorkUnits,
        totalWorkUnits,
        terminal: completedWorkUnits === totalWorkUnits,
      },
      eta,
    });
  });
}

function pressHistoryShortcut(
  target: EventTarget,
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "z",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => target.dispatchEvent(event));
  return event;
}

function paperMarginsCheckbox(el: HTMLElement): HTMLInputElement {
  const checkbox = [
    ...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].find((input) =>
    input.labels?.[0]?.textContent?.includes(
      "Include paper margins in plotter SVG",
    ),
  );
  if (checkbox === undefined) throw new Error("no paper margins checkbox");
  return checkbox;
}

function compositionFrameCheckbox(el: HTMLElement): HTMLInputElement {
  const checkbox = [
    ...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].find((input) =>
    input.labels?.[0]?.textContent?.includes("Include composition frame"),
  );
  if (checkbox === undefined) throw new Error("no composition frame checkbox");
  return checkbox;
}

/**
 * Every primitive point of `scene` that falls OUTSIDE the canvas rectangle
 * `[0, 0, width, height]` (issue #237's acceptance predicate). The export-time
 * clip must leave this empty; an un-clipped Scene with overflowing geometry
 * populates it (so a test can prove the clip was both applied AND meaningful).
 */
function outOfBoundsPoints(
  scene: unknown,
  width: number,
  height: number,
): [number, number][] {
  const s = scene as { primitives: { points: [number, number][] }[] };
  return s.primitives.flatMap((p) =>
    p.points.filter(([x, y]) => x < 0 || x > width || y < 0 || y > height),
  );
}

describe("SketchControls — seed axis wiring", () => {
  it("New seed reshuffles the seed while leaving every param value identical", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          radius: numberSpec({ default: 10 }),
          count: numberSpec({ default: 5, integer: true }),
        })}
      />,
    );

    const seedBefore = (
      el.querySelector("#sketch-seed") as HTMLInputElement
    ).value;
    const radiusBefore = paramInput(el, "radius").value;
    const countBefore = paramInput(el, "count").value;

    // Force the engine's newSeed to land somewhere new and deterministic.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    clickButton(el, "New seed");

    const seedAfter = (
      el.querySelector("#sketch-seed") as HTMLInputElement
    ).value;
    // The seed changed (new arrangement)...
    expect(seedAfter).not.toBe(seedBefore);
    expect(seedAfter).toBe(String(Math.floor(0.5 * Number.MAX_SAFE_INTEGER)));
    // ...while NOT a single param value moved (independent axis).
    expect(paramInput(el, "radius").value).toBe(radiusBefore);
    expect(paramInput(el, "count").value).toBe(countBefore);
  });

  it("editing the seed box updates the seed (the value the canvas is fed)", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const seedInput = el.querySelector("#sketch-seed") as HTMLInputElement;

    act(() => {
      // Set the value and fire a React-observed change.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(seedInput, "12345");
      seedInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // The seed box reflects the edit — it is the plain, copyable seed value...
    expect((el.querySelector("#sketch-seed") as HTMLInputElement).value).toBe(
      "12345",
    );
    // ...and that exact value is what SketchControls feeds the canvas (the probe
    // surfaces the `seed` prop LiveCanvas received), so editing re-renders it.
    expect(el.querySelector('[data-testid="canvas-seed"]')?.textContent).toBe(
      "12345",
    );
    // No param value was touched by a seed edit.
    expect(paramInput(el, "radius").value).toBe("10");
  });

  it("clearing the seed box is a no-op — does NOT commit seed 0", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const seedInput = el.querySelector("#sketch-seed") as HTMLInputElement;

    // Commit a known non-zero seed, then clear the field. `Number("") === 0`, so
    // without the empty guard the clear would silently overwrite the seed with 0.
    setInput(seedInput, "12345");
    setInput(seedInput, "");

    // The clear was ignored: the last committed seed still feeds the canvas...
    expect(el.querySelector('[data-testid="canvas-seed"]')?.textContent).toBe(
      "12345",
    );
    // The invalid partial draft stays local until this field settles.
    expect((el.querySelector("#sketch-seed") as HTMLInputElement).value).toBe("");
  });
});

describe("SketchControls — central edit-history integration", () => {
  it("handles the non-macOS chord matrix and ignores Meta", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const input = paramInput(el, "radius");

    expect(pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented).toBe(
      false,
    );
    act(() => input.focus());
    setInput(input, "42");
    act(() => input.blur());

    expect(pressHistoryShortcut(window, { metaKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(paramInput(el, "radius").value).toBe("42");
    expect(
      pressHistoryShortcut(window, { metaKey: true, shiftKey: true })
        .defaultPrevented,
    ).toBe(false);
    expect(paramInput(el, "radius").value).toBe("42");

    expect(pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented).toBe(
      true,
    );
    expect(
      pressHistoryShortcut(window, { ctrlKey: true, shiftKey: true })
        .defaultPrevented,
    ).toBe(true);
    expect(paramInput(el, "radius").value).toBe("42");

    pressHistoryShortcut(window, { ctrlKey: true });
    expect(
      pressHistoryShortcut(window, { key: "y", ctrlKey: true })
        .defaultPrevented,
    ).toBe(true);
    expect(paramInput(el, "radius").value).toBe("42");

    expect(
      pressHistoryShortcut(window, { key: "y", ctrlKey: true })
        .defaultPrevented,
    ).toBe(false);
    expect(
      pressHistoryShortcut(window, { ctrlKey: true, altKey: true })
        .defaultPrevented,
    ).toBe(false);
    expect(
      pressHistoryShortcut(window, { key: "x", ctrlKey: true })
        .defaultPrevented,
    ).toBe(false);
  });

  it("handles the macOS chord matrix and ignores Ctrl including Ctrl+Y", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const input = paramInput(el, "radius");
    act(() => input.focus());
    setInput(input, "42");
    act(() => input.blur());

    expect(pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(
      pressHistoryShortcut(window, { key: "y", ctrlKey: true })
        .defaultPrevented,
    ).toBe(false);
    expect(paramInput(el, "radius").value).toBe("42");

    expect(pressHistoryShortcut(window, { metaKey: true }).defaultPrevented).toBe(
      true,
    );
    expect(paramInput(el, "radius").value).toBe("10");
    expect(
      pressHistoryShortcut(window, { metaKey: true, shiftKey: true })
        .defaultPrevented,
    ).toBe(true);
    expect(paramInput(el, "radius").value).toBe("42");
  });

  it("yields to an active numeric edit, then traverses after that field settles", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const input = paramInput(el, "radius");

    act(() => input.focus());
    setInput(input, "20");
    act(() => input.blur());
    act(() => input.focus());
    setInput(input, "30");

    expect(
      pressHistoryShortcut(input, { ctrlKey: true }).defaultPrevented,
    ).toBe(false);
    expect(paramInput(el, "radius").value).toBe("30");

    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(
      pressHistoryShortcut(input, { ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    expect(paramInput(el, "radius").value).toBe("20");
  });

  it("keeps preset-name Undo native even when Studio history is available", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const radius = paramInput(el, "radius");
    act(() => radius.focus());
    setInput(radius, "42");
    act(() => radius.blur());
    const name = el.querySelector<HTMLInputElement>(
      'input[aria-label="preset name"]',
    )!;

    expect(
      pressHistoryShortcut(name, { ctrlKey: true }).defaultPrevented,
    ).toBe(false);
    expect(paramInput(el, "radius").value).toBe("42");
  });

  it("undoes tolerance through Outline invalidation while retaining excluded state", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
    const renderToggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => renderToggle.click());
    act(() => lastOnOutlineComputed?.());
    act(() => paperMarginsCheckbox(el).click());

    const tolerance = el.querySelector<HTMLInputElement>("#sketch-tolerance")!;
    act(() => tolerance.focus());
    setInput(tolerance, "1");
    act(() => tolerance.blur());
    act(() => lastOnOutlineComputed?.());
    expect(tolerance.value).toBe("1");

    pressHistoryShortcut(window, { ctrlKey: true });

    expect(
      el.querySelector<HTMLInputElement>("#sketch-tolerance")?.value,
    ).toBe("0");
    expect(renderToggle.getAttribute("aria-pressed")).toBe("true");
    expect(paperMarginsCheckbox(el).checked).toBe(false);
    expect(renderToggle.textContent).toBe("Outline");
  });

  it("routes lock toggle, Randomize, New seed, and frame toggle as named atomic commands", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          radius: numberSpec({ min: 0, max: 100, default: 10 }),
        })}
      />,
    );
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    act(() => {
      el.querySelector('button[aria-label="radius lock"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    clickButton(el, "Randomize");
    clickButton(el, "New seed");
    act(() => el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());

    expect(historyCapture.atomic).toHaveLength(4);
    const [lock, randomizeCommand, seedCommand, frameCommand] =
      historyCapture.atomic;
    expect(lock!.after.present.locks.has("radius")).toBe(true);
    // Locked randomization is a model-level no-op and therefore adds no entry.
    expect(randomizeCommand!.after).toBe(randomizeCommand!.before);
    expect(seedCommand!.after.present.seed).not.toBe(
      seedCommand!.before.present.seed,
    );
    expect(frameCommand!.after.present.profile.includeFrame).toBe(false);
  });

  it("suppresses an unchanged Randomize command", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          radius: numberSpec({ min: 0, max: 100, default: 50 }),
        })}
      />,
    );
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    clickButton(el, "Randomize");

    expect(historyCapture.atomic).toHaveLength(1);
    expect(historyCapture.atomic[0]!.after).toBe(
      historyCapture.atomic[0]!.before,
    );
    expect(historyCapture.atomic[0]!.after.past).toHaveLength(0);
  });

  it("records a changed Randomize as one atomic transition", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          radius: numberSpec({ min: 0, max: 100, default: 10 }),
        })}
      />,
    );
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    clickButton(el, "Randomize");

    expect(historyCapture.atomic).toHaveLength(1);
    const transition = historyCapture.atomic[0]!;
    expect(transition.after).not.toBe(transition.before);
    expect(transition.after.past).toHaveLength(1);
    expect(transition.after.present.params.radius).toBe(50);
    expect(transition.after.present.seed).toBe(transition.before.present.seed);
  });

  it("settles params, seed, Simplify, and Paper adapters through commitEditTransaction", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );

    const settle = (input: HTMLInputElement, value: string): void => {
      act(() => input.focus());
      setInput(input, value);
      act(() => input.blur());
    };

    settle(paramInput(el, "radius"), "42");
    settle(el.querySelector<HTMLInputElement>("#sketch-seed")!, "4242");
    settle(el.querySelector<HTMLInputElement>("#sketch-tolerance")!, "1.25");
    settle(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Paper width (mm)"]',
      )!,
      "300",
    );

    expect(historyCapture.transactionCommits).toHaveLength(4);
    const [paramsCommit, seedCommit, toleranceCommit, profileCommit] =
      historyCapture.transactionCommits;
    expect(paramsCommit!.after.present.params.radius).toBe(42);
    expect(seedCommit!.after.present.seed).toBe(4242);
    expect(toleranceCommit!.after.present.tolerance).toBe(1.25);
    expect(profileCommit!.after.present.profile.width).toBe(300);
    expect(profileCommit!.after.past).toHaveLength(4);
  });

  it("records one color-key gesture and keeps the mounted picker synced through Undo/Redo", async () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          ink: { kind: "color", default: "#ff0000" },
        })}
      />,
    );
    const colorTrigger = el.querySelector<HTMLButtonElement>(
      'button[aria-label^="ink current color"]',
    )!;
    act(() => colorTrigger.click());
    const hue = document.querySelector<HTMLElement>('[aria-label="ink hue"]')!;
    const hueKey = (type: "keydown" | "keyup") =>
      hue.dispatchEvent(
        new KeyboardEvent(type, {
          bubbles: true,
          cancelable: true,
          key: "ArrowRight",
          code: "ArrowRight",
          keyCode: 39,
        }),
      );

    act(() => hueKey("keydown"));
    act(() => hueKey("keydown"));
    act(() => hueKey("keyup"));

    expect(historyCapture.transactionCommits).toHaveLength(1);
    const gesture = historyCapture.transactionCommits[0]!;
    expect(gesture.after.past).toHaveLength(1);
    expect(gesture.after.present.params.ink).toBe("#ff9900");
    expect(colorTrigger.getAttribute("aria-label")).toBe(
      "ink current color #ff9900",
    );

    pressHistoryShortcut(window, { ctrlKey: true });
    await flush();
    expect(colorTrigger.getAttribute("aria-label")).toBe(
      "ink current color #ff0000",
    );
    expect(hue.getAttribute("aria-valuenow")).toBe("0");

    pressHistoryShortcut(window, { key: "y", ctrlKey: true });
    await flush();
    expect(colorTrigger.getAttribute("aria-label")).toBe(
      "ink current color #ff9900",
    );
    expect(hue.getAttribute("aria-valuenow")).toBe("36");
  });

  it("records a mouse color gesture as one Undo step", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          ink: { kind: "color", default: "#ff0000" },
        })}
      />,
    );
    act(() =>
      el
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="ink current color"]',
        )!
        .click(),
    );
    const saturation = document.querySelector<HTMLElement>(
      '[aria-label="ink saturation and value"]',
    )!;
    saturation.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect;

    act(() => {
      saturation.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          buttons: 1,
          clientX: 100,
          clientY: 25,
        }),
      );
    });
    act(() =>
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })),
    );

    expect(historyCapture.transactionCommits).toHaveLength(1);
    expect(
      historyCapture.transactionCommits[0]!.after.present.params.ink,
    ).toBe("#bf6060");
    expect(historyCapture.transactionCommits[0]!.after.past).toHaveLength(1);

    pressHistoryShortcut(window, { ctrlKey: true });
    expect(
      el
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="ink current color"]',
        )
        ?.getAttribute("aria-label"),
    ).toBe("ink current color #ff0000");
  });

  it("suppresses a color gesture that returns to its starting value", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          ink: { kind: "color", default: "#ff0000" },
        })}
      />,
    );
    act(() =>
      el
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="ink current color"]',
        )!
        .click(),
    );
    const hue = document.querySelector<HTMLElement>('[aria-label="ink hue"]')!;
    const arrow = (type: "keydown" | "keyup") =>
      hue.dispatchEvent(
        new KeyboardEvent(type, {
          bubbles: true,
          key: "ArrowRight",
          code: "ArrowRight",
          keyCode: 39,
        }),
      );

    for (let step = 0; step < 20; step += 1) act(() => arrow("keydown"));
    act(() => arrow("keyup"));

    expect(historyCapture.transactionCommits).toHaveLength(1);
    const noOp = historyCapture.transactionCommits[0]!;
    expect(noOp.after).not.toBe(noOp.before);
    expect(noOp.after.present.params.ink).toBe("#ff0000");
    expect(noOp.after.past).toHaveLength(0);
  });

  it("leaves Undo with an active RGB draft and restores Studio Undo after cancel", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          radius: numberSpec({ default: 10 }),
          ink: { kind: "color", default: "#ff0000" },
        })}
      />,
    );
    const radius = paramInput(el, "radius");
    act(() => radius.focus());
    setInput(radius, "42");
    act(() => radius.blur());
    expect(historyCapture.transactionCommits).toHaveLength(1);

    act(() =>
      el
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="ink current color"]',
        )!
        .click(),
    );
    const red = document.querySelector<HTMLInputElement>(
      'input[aria-label="ink red channel"]',
    )!;
    act(() => red.focus());
    setInput(red, "invalid");
    expect(
      red.closest('[aria-label="ink RGB channels"]')?.getAttribute(
        "data-studio-history",
      ),
    ).toBe("exclude");

    const nativeUndo = pressHistoryShortcut(red, { ctrlKey: true });
    expect(nativeUndo.defaultPrevented).toBe(false);
    expect(radius.value).toBe("42");
    expect(red.value).toBe("invalid");
    expect(historyCapture.transactionCommits).toHaveLength(1);

    act(() =>
      red.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(
      red.closest('[aria-label="ink RGB channels"]')?.getAttribute(
        "data-studio-history",
      ),
    ).toBeNull();

    const studioUndo = pressHistoryShortcut(red, { ctrlKey: true });
    expect(studioUndo.defaultPrevented).toBe(true);
    expect(paramInput(el, "radius").value).toBe("10");
  });

  it("feeds ControlPanel previews from present and Escape restores the whole transaction", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const input = paramInput(el, "radius");
    act(() => input.focus());
    setInput(input, "42");
    expect(paramInput(el, "radius").value).toBe("42");

    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );

    expect(paramInput(el, "radius").value).toBe("10");
    expect(historyCapture.cancels).toHaveLength(1);
    expect(historyCapture.cancels[0]!.after.present.params.radius).toBe(10);
    expect(historyCapture.cancels[0]!.after.past).toHaveLength(0);
  });

  it("routes paper format and orientation as separate atomic commands", () => {
    const sketch = {
      ...sketchWith("a", {}),
      defaultOutputProfile: {
        width: 210,
        height: 297,
        insets: { top: 10, right: 10, bottom: 10, left: 10 },
        includeFrame: true,
        toolWidthMillimeters: 0.3,
      },
    } as Parameters<typeof SketchControls>[0]["sketch"];
    const el = mount(<SketchControls sketch={sketch} />);
    const details = el.querySelector("details")!;
    act(() => details.setAttribute("open", ""));
    const format = details.querySelector("select")!;

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(format, "letter");
      format.dispatchEvent(new Event("change", { bubbles: true }));
    });
    clickButton(details, "Swap to landscape");

    expect(historyCapture.atomic).toHaveLength(2);
    expect(historyCapture.atomic[0]!.after.present.profile).toMatchObject({
      width: 215.9,
      height: 279.4,
    });
    expect(historyCapture.atomic[1]!.after.present.profile).toMatchObject({
      width: 279.4,
      height: 215.9,
    });
  });

  it("defers a Paper transaction boundary until a geometry value changes", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => toggle.click());
    act(() => lastOnOutlineComputed?.());
    const initialFrame = lastCompositionFrame;
    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;

    act(() => width.focus());
    expect(canvasRenderMode(el)).toBe("outline");
    setInput(width, "300");
    expect(canvasRenderMode(el)).toBe("fill");
    expect(toggle.textContent).toBe("Outline");
    expect(lastCompositionFrame).not.toBe(initialFrame);
    expect(outlineJob.starts).toBe(1);
    act(() => lastOnOutlineComputed?.());

    act(() =>
      width.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );

    expect(lastProfile?.width).toBe(200);
    expect(lastCompositionFrame).toEqual(initialFrame);
    expect(toggle.textContent).toBe("Outline");
    expect(canvasRenderMode(el)).toBe("outline");
    expect(outlineJob.starts).toBe(1);
    expect(historyCapture.cancels).toHaveLength(1);
    expect(historyCapture.cancels[0]!.after.past).toHaveLength(0);
  });

  it("keeps Outline through a placement-only edit and cancel", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => toggle.click());
    act(() => lastOnOutlineComputed?.());
    expect(outlineJob.starts).toBe(1);
    expect(
      el.querySelector('[data-testid="canvas-seed"]')?.getAttribute(
        "data-render-state",
      ),
    ).toBe("outline");
    const initialFrame = lastCompositionFrame;
    const margin = el.querySelector<HTMLInputElement>(
      'input[aria-label="Linked paper margin (mm)"]',
    )!;

    act(() => margin.focus());
    expect(canvasRenderMode(el)).toBe("outline");
    setInput(margin, "20");
    expect(lastProfile?.insets).toEqual({
      top: 20,
      right: 20,
      bottom: 20,
      left: 20,
    });
    expect(lastCompositionFrame).toBe(initialFrame);
    expect(toggle.textContent).toBe("Outline");
    expect(outlineJob.starts).toBe(1);
    expect(
      el.querySelector('[data-testid="canvas-seed"]')?.getAttribute(
        "data-render-state",
      ),
    ).toBe("outline");

    act(() =>
      margin.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );

    expect(lastProfile?.insets).toEqual({
      top: 10,
      right: 10,
      bottom: 10,
      left: 10,
    });
    expect(lastCompositionFrame).toBe(initialFrame);
    expect(toggle.textContent).toBe("Outline");
    expect(outlineJob.starts).toBe(1);
    expect(
      el.querySelector('[data-testid="canvas-seed"]')?.getAttribute(
        "data-render-state",
      ),
    ).toBe("outline");
    expect(historyCapture.cancels).toHaveLength(1);
  });

  it("keeps Outline through an invalid Paper draft", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => toggle.click());
    act(() => lastOnOutlineComputed?.());
    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;

    act(() => width.focus());
    setInput(width, "");
    expect(outlineJob.starts).toBe(1);
    expect(
      el.querySelector('[data-testid="canvas-seed"]')?.getAttribute(
        "data-render-state",
      ),
    ).toBe("outline");

    act(() =>
      width.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(outlineJob.starts).toBe(1);
    expect(
      el.querySelector('[data-testid="canvas-seed"]')?.getAttribute(
        "data-render-state",
      ),
    ).toBe("outline");
  });
});

describe("SketchControls — Page Frame edit mode", () => {
  const fixedPageProfile: PlotProfile = {
    width: 240,
    height: 140,
    insets: { top: 20, right: 20, bottom: 20, left: 20 },
    includeFrame: true,
    toolWidthMillimeters: 0.31,
  };

  function fixedPageSketch(id: string) {
    return {
      ...sketchWith(id, {}),
      defaultOutputProfile: fixedPageProfile,
    } as Parameters<typeof SketchControls>[0]["sketch"];
  }

  function frameInput(el: HTMLElement, name: string): HTMLInputElement {
    const found = el.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (found === null) throw new Error(`no Page Frame ${name} input`);
    return found;
  }

  function selectAspect(el: HTMLElement, value: string): void {
    const select = el.querySelector<HTMLSelectElement>(
      'select[name="aspectConstraint"]',
    );
    if (select === null) throw new Error("no Page Frame aspect selector");
    act(() => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function publishPageFrameDraft(frame: PageFrame): void {
    const publish = lastOnPageFrameDraftChange;
    if (publish === null) throw new Error("LiveCanvas draft callback is absent");
    act(() => publish(frame));
  }

  function beginGesture(
    frame: PageFrame,
    target: PageFrameManipulationTarget,
    pointer: PageFramePointer,
  ): PageFrameManipulationState {
    if (
      lastCompositionFrame === null ||
      lastPageFrameAspectConstraint === null
    ) {
      throw new Error("LiveCanvas Page Frame props are absent");
    }
    return beginPageFrameManipulation({
      frame,
      target,
      pointer,
      constraint: lastPageFrameAspectConstraint,
      compositionFrame: lastCompositionFrame,
      shiftKey: false,
    });
  }

  function moveGesture(
    gesture: PageFrameManipulationState,
    pointer: PageFramePointer,
    shiftKey = false,
  ): PageFrameManipulationState {
    const next = updatePageFrameManipulation(gesture, pointer, shiftKey);
    publishPageFrameDraft(finishPageFrameManipulation(next));
    return next;
  }

  function toggleFixedPage(el: HTMLElement): void {
    act(() => frameInput(el, "keepPageSizeFixed").click());
  }

  it("wires inert entry, freeform edge/corner edits, temporary Shift, numeric sync, and one atomic Apply", () => {
    const el = mount(
      <SketchControls sketch={sketchWith("frame-direct-wiring", {})} />,
    );
    const inputRevision = el
      .querySelector('[data-testid="canvas-seed"]')
      ?.getAttribute("data-input-revision");
    const composition = structuredClone(lastCompositionFrame)!;

    clickButton(el, "Crop");
    const initial = structuredClone(lastPageFrameDraft)!;
    expect(initial).toEqual({
      x: 0,
      y: 0,
      width: composition.width,
      height: composition.height,
    });
    expect(lastPageFrameAspectConstraint).toEqual({ kind: "free" });
    expect(lastPageFrameEditDraft?.mode).toBe("scale-preserving");
    expect(historyCapture.atomic).toHaveLength(0);
    expect(outlineJob.starts).toBe(0);
    expect(
      el
        .querySelector('[data-testid="canvas-seed"]')
        ?.getAttribute("data-input-revision"),
    ).toBe(inputRevision);

    let gesture = beginGesture(
      initial,
      { kind: "resize", handle: "right" },
      { x: initial.width, y: initial.height / 2 },
    );
    gesture = moveGesture(gesture, {
      x: initial.width + composition.width * 0.1,
      y: initial.height / 2,
    });
    expect(Number(frameInput(el, "width").value)).toBeCloseTo(110, 9);
    expect(Number(frameInput(el, "height").value)).toBeCloseTo(100, 9);

    const edgeFrame = finishPageFrameManipulation(gesture);
    gesture = beginGesture(
      edgeFrame,
      { kind: "resize", handle: "bottom-right" },
      { x: edgeFrame.width, y: edgeFrame.height },
    );
    gesture = moveGesture(gesture, {
      x: edgeFrame.width + composition.width * 0.1,
      y: edgeFrame.height + composition.height * 0.05,
    });
    expect(Number(frameInput(el, "width").value)).toBeCloseTo(120, 9);
    expect(Number(frameInput(el, "height").value)).toBeCloseTo(105, 9);

    const freeFrame = finishPageFrameManipulation(gesture);
    const start = {
      x: freeFrame.x + freeFrame.width,
      y: freeFrame.y + freeFrame.height / 2,
    };
    gesture = beginGesture(
      freeFrame,
      { kind: "resize", handle: "right" },
      start,
    );
    const lockAt = { x: start.x + composition.width * 0.05, y: start.y };
    gesture = moveGesture(gesture, lockAt);
    const beforeShift = finishPageFrameManipulation(gesture);
    gesture = moveGesture(gesture, lockAt, true);
    expect(finishPageFrameManipulation(gesture)).toEqual(beforeShift);
    gesture = moveGesture(
      gesture,
      { x: lockAt.x + composition.width * 0.05, y: lockAt.y },
      true,
    );
    const shifted = finishPageFrameManipulation(gesture);
    expect(shifted.width / shifted.height).toBeCloseTo(
      beforeShift.width / beforeShift.height,
      12,
    );
    expect(Number(frameInput(el, "width").value)).toBeCloseTo(
      (shifted.width / composition.width) * 100,
      9,
    );
    expect(Number(frameInput(el, "height").value)).toBeCloseTo(
      (shifted.height / composition.height) * 100,
      9,
    );
    expect(lastPageFrameAspectConstraint).toEqual({ kind: "free" });
    expect(historyCapture.atomic).toHaveLength(0);

    clickButton(el, "Apply");
    expect(historyCapture.atomic).toHaveLength(1);
    const framing = historyCapture.atomic[0]!.after.present.framing;
    if (framing.kind !== "framed") throw new Error("Apply did not frame");
    expect(framing.pageFrame.x).toBeCloseTo(shifted.x, 9);
    expect(framing.pageFrame.y).toBeCloseTo(shifted.y, 9);
    expect(framing.pageFrame.width).toBeCloseTo(shifted.width, 9);
    expect(framing.pageFrame.height).toBeCloseTo(shifted.height, 9);
    expect(framing.aspectLocked).toBe(true);
    expect(Object.keys(framing).sort()).toEqual([
      "aspectLocked",
      "generationAspect",
      "kind",
      "pageFrame",
    ]);
    expect(Object.keys(framing.pageFrame).sort()).toEqual([
      "height",
      "width",
      "x",
      "y",
    ]);
  });

  it("carries exact physical W/H through ordinary → fixed → ordinary, then applies and settles as one complete history state", () => {
    const el = mount(
      <SketchControls sketch={fixedPageSketch("fixed-page-orchestration")} />,
    );
    const originalProfile = structuredClone(lastProfile)!;
    const composition = lastCompositionFrame!;
    const inputRevision = el
      .querySelector("[data-testid='canvas-seed']")
      ?.getAttribute("data-input-revision");

    clickButton(el, "Crop");
    selectAspect(el, "4:3");
    setInput(frameInput(el, "physical-width"), "300");
    setInput(frameInput(el, "physical-height"), "200");

    const exactProfile = {
      ...fixedPageProfile,
      width: 300,
      height: 200,
      insets: { ...fixedPageProfile.insets },
    };
    const ordinary = lastPageFrameEditDraft;
    if (ordinary?.mode !== "scale-preserving") {
      throw new Error("physical Page resize did not remain ordinary framing");
    }
    expect(lastProfile).toEqual(exactProfile);
    expect(ordinary.generationAspect).toBeCloseTo(
      composition.width / composition.height,
      14,
    );
    expect(lastCompositionFrame).toBe(composition);
    expect(historyCapture.atomic).toHaveLength(0);

    toggleFixedPage(el);
    const fixed = lastPageFrameEditDraft;
    if (fixed?.mode !== "fixed-page") {
      throw new Error("fixed Page mode did not open");
    }
    expect(fixed.profile).toEqual(exactProfile);
    expect(lastProfile).toBe(fixed.profile);
    expect(
      el.querySelector<HTMLSelectElement>('select[name="aspectConstraint"]')
        ?.value,
    ).toBe("free");
    expect(
      el.querySelector<HTMLSelectElement>('select[name="aspectConstraint"]')
        ?.disabled,
    ).toBe(true);
    expect(frameInput(el, "width").disabled).toBe(true);
    expect(frameInput(el, "height").disabled).toBe(true);
    expect(frameInput(el, "physical-width").readOnly).toBe(true);
    expect(frameInput(el, "physical-height").readOnly).toBe(true);
    for (const side of ["top", "right", "bottom", "left"] as const) {
      expect(frameInput(el, `physical-inset-${side}`).value).toBe("20");
      expect(frameInput(el, `physical-inset-${side}`).readOnly).toBe(true);
    }

    setInput(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Composition scale percentage"]',
      )!,
      "200",
    );
    setInput(frameInput(el, "x"), "12.5");
    setInput(frameInput(el, "y"), "-10");
    const positioned = lastPageFrameEditDraft;
    if (positioned?.mode !== "fixed-page") {
      throw new Error("fixed Page scale did not remain active");
    }
    expect(positioned.compositionScale).toBeCloseTo(2, 12);
    expect(positioned.profile).toBe(fixed.profile);
    expect(positioned.frame.width).toBeCloseTo(fixed.fitFrame.width / 2, 12);
    expect(positioned.frame.height).toBeCloseTo(
      fixed.fitFrame.height / 2,
      12,
    );
    expect(positioned.frame.x).toBeCloseTo(composition.width * 0.125, 12);
    expect(positioned.frame.y).toBeCloseTo(composition.height * -0.1, 12);
    expect(lastCompositionFrame).toBe(composition);
    expect(historyCapture.atomic).toHaveLength(0);
    expect(outlineJob.starts).toBe(0);

    toggleFixedPage(el);
    const rebased = lastPageFrameEditDraft;
    if (rebased?.mode !== "scale-preserving") {
      throw new Error("fixed Page mode did not return to ordinary framing");
    }
    expect(rebased.profile).toBe(positioned.profile);
    expect(rebased.representedFrame).toEqual(positioned.frame);
    expect(rebased.frame).toEqual(positioned.frame);
    expect(frameInput(el, "physical-width").value).toBe("300");
    expect(frameInput(el, "physical-height").value).toBe("200");
    expect(frameInput(el, "physical-width").readOnly).toBe(false);

    toggleFixedPage(el);
    const reentered = lastPageFrameEditDraft;
    if (reentered?.mode !== "fixed-page") {
      throw new Error("fixed Page mode did not reopen");
    }
    expect(reentered.profile).toBe(positioned.profile);
    expect(reentered.frame).toEqual(positioned.frame);
    expect(reentered.compositionScale).toBeCloseTo(2, 12);

    clickButton(el, "Apply");

    expect(historyCapture.atomic).toHaveLength(1);
    const appliedHistory = historyCapture.atomic[0]!.after;
    expect(appliedHistory.past).toHaveLength(1);
    expect(appliedHistory.future).toEqual([]);
    expect(appliedHistory.present.profile).toBe(reentered.profile);
    expect(appliedHistory.present.profile).toEqual(exactProfile);
    expect(appliedHistory.present.framing).toEqual({
      kind: "framed",
      pageFrame: reentered.frame,
      generationAspect: reentered.generationAspect,
      aspectLocked: true,
    });
    expect(lastCommittedPageFrame).toEqual(reentered.frame);
    expect(lastCompositionFrame).toBe(composition);
    expect(lastPageFrameEditDraft).toBeNull();
    expect(outlineJob.starts).toBe(0);
    expect(
      el
        .querySelector("[data-testid='canvas-seed']")
        ?.getAttribute("data-input-revision"),
    ).toBe(inputRevision);

    clickButton(el, "Crop");
    toggleFixedPage(el);
    const scaleInput = el.querySelector<HTMLInputElement>(
      'input[aria-label="Composition scale percentage"]',
    )!;
    act(() => scaleInput.focus());
    expect(
      pressHistoryShortcut(scaleInput, { ctrlKey: true }).defaultPrevented,
    ).toBe(false);
    expect(lastCommittedPageFrame).toEqual(reentered.frame);
    expect(historyCapture.atomic).toHaveLength(1);
    clickButton(el, "Cancel");

    expect(
      pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    expect(lastProfile).toEqual(originalProfile);
    expect(lastCommittedPageFrame).toBeNull();
    expect(lastCompositionFrame).toBe(composition);

    expect(
      pressHistoryShortcut(window, { key: "y", ctrlKey: true })
        .defaultPrevented,
    ).toBe(true);
    expect(lastProfile).toEqual(exactProfile);
    expect(lastCommittedPageFrame).toEqual(reentered.frame);
    expect(lastCompositionFrame).toBe(composition);
    expect(historyCapture.atomic).toHaveLength(1);
    expect(outlineJob.starts).toBe(0);
  });

  it("discards a fixed-page draft on Cancel without committing its preview profile or frame", () => {
    const el = mount(
      <SketchControls sketch={fixedPageSketch("fixed-page-cancel")} />,
    );
    const originalProfile = structuredClone(lastProfile);
    const composition = lastCompositionFrame;

    clickButton(el, "Crop");
    setInput(frameInput(el, "physical-width"), "300");
    setInput(frameInput(el, "physical-height"), "200");
    toggleFixedPage(el);
    setInput(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Composition scale percentage"]',
      )!,
      "175",
    );
    setInput(frameInput(el, "x"), "-25");
    expect(lastProfile).not.toEqual(originalProfile);
    expect(lastPageFrameEditDraft?.mode).toBe("fixed-page");

    clickButton(el, "Cancel");

    expect(historyCapture.atomic).toHaveLength(0);
    expect(lastProfile).toEqual(originalProfile);
    expect(lastCommittedPageFrame).toBeNull();
    expect(lastPageFrameEditDraft).toBeNull();
    expect(lastCompositionFrame).toBe(composition);
    expect(outlineJob.starts).toBe(0);
  });

  it("resets fixed-page scale to centered fit while preserving the exact locked profile through Undo and Redo", () => {
    const el = mount(
      <SketchControls sketch={fixedPageSketch("fixed-page-reset")} />,
    );
    const originalProfile = structuredClone(lastProfile);
    const composition = lastCompositionFrame;

    clickButton(el, "Crop");
    setInput(frameInput(el, "physical-width"), "300");
    setInput(frameInput(el, "physical-height"), "200");
    toggleFixedPage(el);
    setInput(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Composition scale percentage"]',
      )!,
      "150",
    );
    const edited = lastPageFrameEditDraft;
    if (edited?.mode !== "fixed-page") {
      throw new Error("fixed Page draft was not active");
    }

    clickButton(el, "Reset Frame");

    expect(historyCapture.atomic).toHaveLength(1);
    const reset = historyCapture.atomic[0]!.after.present;
    expect(reset.profile).toBe(edited.profile);
    expect(reset.profile).toEqual({
      ...fixedPageProfile,
      width: 300,
      height: 200,
      insets: { ...fixedPageProfile.insets },
    });
    expect(reset.framing).toEqual({
      kind: "framed",
      pageFrame: edited.fitFrame,
      generationAspect: edited.generationAspect,
      aspectLocked: true,
    });
    expect(lastCommittedPageFrame).toEqual(edited.fitFrame);
    expect(lastCompositionFrame).toBe(composition);
    expect(outlineJob.starts).toBe(0);

    pressHistoryShortcut(window, { ctrlKey: true });
    expect(lastProfile).toEqual(originalProfile);
    expect(lastCommittedPageFrame).toBeNull();
    expect(lastCompositionFrame).toBe(composition);

    pressHistoryShortcut(window, { key: "y", ctrlKey: true });
    expect(lastProfile).toEqual(edited.profile);
    expect(lastCommittedPageFrame).toEqual(edited.fitFrame);
    expect(lastCompositionFrame).toBe(composition);
    expect(historyCapture.atomic).toHaveLength(1);
    expect(outlineJob.starts).toBe(0);
  });

  it("keeps common/custom constraints through Apply, Cancel, and re-entry until Freeform without persisting them", async () => {
    const el = mount(
      <SketchControls sketch={sketchWith("frame-aspect-wiring", {})} />,
    );
    clickButton(el, "Crop");
    selectAspect(el, "4:3");
    expect(lastPageFrameAspectConstraint).toEqual({
      kind: "ratio",
      ratio: 4 / 3,
    });

    clickButton(el, "Apply");
    clickButton(el, "Crop");
    expect(
      el.querySelector<HTMLSelectElement>('select[name="aspectConstraint"]')
        ?.value,
    ).toBe("4:3");
    clickButton(el, "Cancel");
    clickButton(el, "Crop");
    expect(
      el.querySelector<HTMLSelectElement>('select[name="aspectConstraint"]')
        ?.value,
    ).toBe("4:3");

    selectAspect(el, "custom");
    setInput(frameInput(el, "customAspectWidth"), "5");
    setInput(frameInput(el, "customAspectHeight"), "4");
    clickButton(el, "Use Custom Ratio");
    expect(lastPageFrameAspectConstraint).toEqual({
      kind: "ratio",
      ratio: 1.25,
    });
    clickButton(el, "Cancel");

    setInput(
      el.querySelector<HTMLInputElement>('input[aria-label="preset name"]')!,
      "transient-aspect",
    );
    clickButton(el, "Save");
    await flush();
    expect(savePreset).toHaveBeenCalledOnce();
    expect(JSON.stringify(savePreset.mock.calls[0]![0])).not.toContain(
      "aspectConstraint",
    );

    clickButton(el, "Crop");
    expect(
      el.querySelector<HTMLSelectElement>('select[name="aspectConstraint"]')
        ?.value,
    ).toBe("custom");
    expect(lastPageFrameAspectConstraint).toEqual({
      kind: "ratio",
      ratio: 1.25,
    });
    selectAspect(el, "free");
    clickButton(el, "Cancel");
    clickButton(el, "Crop");
    expect(lastPageFrameAspectConstraint).toEqual({ kind: "free" });
    expect(
      el.querySelector<HTMLSelectElement>('select[name="aspectConstraint"]')
        ?.value,
    ).toBe("free");
  });

  it("routes interior pan inversely into the single Page Frame with a stationary composition basis", () => {
    const el = mount(
      <SketchControls sketch={sketchWith("frame-pan-wiring", {})} />,
    );
    const composition = structuredClone(lastCompositionFrame)!;
    clickButton(el, "Crop");
    const initial = structuredClone(lastPageFrameDraft)!;
    const pointer = {
      x: initial.width / 2,
      y: initial.height / 2,
    };
    let gesture = beginGesture(initial, { kind: "pan" }, pointer);
    gesture = moveGesture(gesture, {
      x: pointer.x + composition.width * 0.15,
      y: pointer.y - composition.height * 0.1,
    });
    const panned = finishPageFrameManipulation(gesture);

    expect(panned.x).toBeCloseTo(-composition.width * 0.15, 12);
    expect(panned.y).toBeCloseTo(composition.height * 0.1, 12);
    expect(panned.width).toBe(initial.width);
    expect(panned.height).toBe(initial.height);
    expect(Number(frameInput(el, "x").value)).toBeCloseTo(-15, 9);
    expect(Number(frameInput(el, "y").value)).toBeCloseTo(10, 9);
    expect(lastCompositionFrame).toEqual(composition);

    clickButton(el, "Apply");
    expect(historyCapture.atomic).toHaveLength(1);
    const framing = historyCapture.atomic[0]!.after.present.framing;
    if (framing.kind !== "framed") throw new Error("Apply did not frame");
    expect(framing.pageFrame).toEqual(panned);
    expect(lastCompositionFrame).toEqual(composition);
  });

  it.each(["Apply", "Cancel", "Reset Frame"] as const)(
    "focuses the first field on entry and restores Crop after %s",
    (action) => {
      const el = mount(
        <SketchControls sketch={sketchWith("frame-focus-" + action, {})} />,
      );

      clickButton(el, "Crop");
      const x = frameInput(el, "x");
      const y = frameInput(el, "y");
      expect(document.activeElement).toBe(x);

      act(() => y.focus());
      setInput(y, "12.5");
      expect(document.activeElement).toBe(y);

      clickButton(el, action);
      const crop = [...el.querySelectorAll("button")].find(
        (button) => button.textContent === "Crop",
      );
      expect(crop).toBeDefined();
      expect(document.activeElement).toBe(crop);
    },
  );

  it("applies, cancels, resets, and traverses framing as atomic history", () => {
    const el = mount(<SketchControls sketch={sketchWith("frame", {})} />);
    const originalProfile = structuredClone(lastProfile);
    const originalComposition = structuredClone(lastCompositionFrame);

    clickButton(el, "Crop");
    expect(el.querySelector("h2")?.textContent).toBe("Edit Page Frame");
    expect(frameInput(el, "x").value).toBe("0");
    expect(frameInput(el, "y").value).toBe("0");
    expect(frameInput(el, "width").value).toBe("100");
    expect(frameInput(el, "height").value).toBe("100");
    expect(lastPageFrameDraft).toEqual({
      x: 0,
      y: 0,
      width: originalComposition!.width,
      height: originalComposition!.height,
    });
    expect(
      [...el.querySelectorAll("button")].map((button) => button.textContent),
    ).not.toContain("New seed");

    setInput(frameInput(el, "width"), "0");
    clickButton(el, "Apply");
    expect(historyCapture.atomic).toHaveLength(0);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "greater than 0%",
    );

    setInput(frameInput(el, "width"), "100");
    clickButton(el, "Apply");
    expect(historyCapture.atomic).toHaveLength(1);
    expect(historyCapture.atomic[0]!.after.present.framing).toEqual({
      kind: "framed",
      pageFrame: {
        x: 0,
        y: 0,
        width: originalComposition!.width,
        height: originalComposition!.height,
      },
      generationAspect:
        originalComposition!.width / originalComposition!.height,
      aspectLocked: true,
    });
    expect(lastProfile).toEqual(originalProfile);
    expect(lastCompositionFrame).toEqual(originalComposition);
    expect(lastPageFrameDraft).toBeNull();
    expect(lastCommittedPageFrame).toEqual({
      x: 0,
      y: 0,
      width: originalComposition!.width,
      height: originalComposition!.height,
    });
    expect(outlineJob.starts).toBe(0);
    expect(
      el.querySelector('[data-testid="canvas-seed"]')?.getAttribute(
        "data-input-revision",
      ),
    ).toBe("0");

    clickButton(el, "Crop");
    setInput(frameInput(el, "x"), "10");
    setInput(frameInput(el, "y"), "20");
    setInput(frameInput(el, "width"), "60");
    setInput(frameInput(el, "height"), "50");
    clickButton(el, "Apply");
    expect(historyCapture.atomic).toHaveLength(2);
    const committed = historyCapture.atomic[1]!.after.present;
    expect(committed.framing).toEqual({
      kind: "framed",
      pageFrame: {
        x: originalComposition!.width * 0.1,
        y: originalComposition!.height * 0.2,
        width: originalComposition!.width * 0.6,
        height: originalComposition!.height * 0.5,
      },
      generationAspect:
        originalComposition!.width / originalComposition!.height,
      aspectLocked: true,
    });
    expect(lastCommittedPageFrame).toEqual(
      committed.framing.kind === "framed"
        ? committed.framing.pageFrame
        : null,
    );
    expect(outlineJob.starts).toBe(0);

    clickButton(el, "Crop");
    expect(frameInput(el, "x").value).toBe("10");
    expect(frameInput(el, "width").value).toBe("60");
    setInput(frameInput(el, "x"), "-25");
    clickButton(el, "Cancel");
    expect(historyCapture.atomic).toHaveLength(2);
    expect(lastPageFrameDraft).toBeNull();
    clickButton(el, "Crop");
    expect(frameInput(el, "x").value).toBe("10");

    clickButton(el, "Reset Frame");
    expect(historyCapture.atomic).toHaveLength(3);
    expect(historyCapture.atomic[2]!.after.present.framing).toEqual({
      kind: "unframed",
    });
    expect(lastPageFrameDraft).toBeNull();
    expect(lastCommittedPageFrame).toBeNull();
    expect(outlineJob.starts).toBe(0);

    expect(
      pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    clickButton(el, "Crop");
    expect(frameInput(el, "x").value).toBe("10");
    clickButton(el, "Cancel");

    expect(
      pressHistoryShortcut(window, { key: "y", ctrlKey: true })
        .defaultPrevented,
    ).toBe(true);
    clickButton(el, "Crop");
    expect(frameInput(el, "x").value).toBe("0");
    expect(frameInput(el, "width").value).toBe("100");
  });

  it("routes locked resize and confirm-gated recompose through exact framing history", () => {
    const confirm = vi.spyOn(window, "confirm");
    const el = mount(<SketchControls sketch={sketchWith("page-semantics", {})} />);

    clickButton(el, "Crop");
    setInput(frameInput(el, "x"), "10");
    setInput(frameInput(el, "width"), "60");
    setInput(frameInput(el, "height"), "50");
    clickButton(el, "Apply");

    const applied = historyCapture.atomic.at(-1)!.after.present;
    if (applied.framing.kind !== "framed") {
      throw new Error("Apply did not commit framing");
    }
    const frozenFraming = structuredClone(applied.framing);
    const frozenComposition = structuredClone(lastCompositionFrame);
    const lock = el.querySelector<HTMLInputElement>(
      'input[aria-label="Lock Page aspect"]',
    )!;
    expect(lock.checked).toBe(true);

    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;
    act(() => width.focus());
    setInput(width, String(applied.profile.width * 1.25));
    act(() => width.blur());

    const resized = historyCapture.transactionCommits.at(-1)!.after.present;
    expect(resized.framing).toEqual(frozenFraming);
    expect(lastCompositionFrame).toEqual(frozenComposition);
    expect(confirm).not.toHaveBeenCalled();
    expect(
      (resized.profile.width -
        resized.profile.insets.left -
        resized.profile.insets.right) /
        (resized.profile.height -
          resized.profile.insets.top -
          resized.profile.insets.bottom),
    ).toBeCloseTo(
      frozenFraming.pageFrame.width / frozenFraming.pageFrame.height,
      14,
    );

    act(() => lock.click());
    const unlocked = historyCapture.atomic.at(-1)!.after.present;
    expect(unlocked.framing).toEqual({ ...frozenFraming, aspectLocked: false });

    confirm.mockReturnValueOnce(false);
    const rejectedWidth = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;
    const rejectedDraft = rejectedWidth.value;
    const beforeDecline = historyCapture.atomic.at(-1)!.after;
    act(() => rejectedWidth.focus());
    setInput(rejectedWidth, String(unlocked.profile.width + 17));
    act(() => rejectedWidth.blur());
    expect(rejectedWidth.value).toBe(rejectedDraft);
    expect(historyCapture.atomic.at(-1)!.after).toBe(beforeDecline);
    expect(lastCompositionFrame).toEqual(frozenComposition);

    confirm.mockReturnValueOnce(true);
    act(() => rejectedWidth.focus());
    setInput(rejectedWidth, String(unlocked.profile.width + 17));
    act(() => rejectedWidth.blur());

    const recomposed = historyCapture.atomic.at(-1)!.after;
    expect(recomposed.present.framing).toEqual({ kind: "unframed" });
    expect(recomposed.present.profile.width).toBe(unlocked.profile.width + 17);
    expect(recomposed.past).toHaveLength(beforeDecline.past.length + 1);
    expect(lastCompositionFrame).not.toEqual(frozenComposition);
    expect(
      el.querySelector('input[aria-label="Lock Page aspect"]'),
    ).toBeNull();

    pressHistoryShortcut(window, { ctrlKey: true });
    expect(lastCommittedPageFrame).toEqual(frozenFraming.pageFrame);
    expect(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Lock Page aspect"]',
      )?.checked,
    ).toBe(false);
    pressHistoryShortcut(window, { key: "y", ctrlKey: true });
    expect(lastCommittedPageFrame).toBeNull();
  });

  it("blocks Studio Undo and Redo until the Composition-relative draft settles", () => {
    const sketch = {
      ...sketchWith("frame-history", {}),
      defaultOutputProfile: {
        width: 210,
        height: 297,
        insets: { top: 10, right: 10, bottom: 10, left: 10 },
        includeFrame: true,
        toolWidthMillimeters: 0.3,
      },
    } as Parameters<typeof SketchControls>[0]["sketch"];
    const el = mount(<SketchControls sketch={sketch} />);
    const portraitComposition = structuredClone(lastCompositionFrame)!;

    clickButton(el, "Swap to landscape");
    const landscapeComposition = structuredClone(lastCompositionFrame)!;
    expect(landscapeComposition.width / landscapeComposition.height).not.toBe(
      portraitComposition.width / portraitComposition.height,
    );

    clickButton(el, "Crop");
    const landscapeX = frameInput(el, "x");
    setInput(landscapeX, "12.5");
    act(() => landscapeX.focus());
    expect(
      pressHistoryShortcut(landscapeX, { ctrlKey: true }).defaultPrevented,
    ).toBe(false);
    expect(lastCompositionFrame).toEqual(landscapeComposition);
    expect(landscapeX.value).toBe("12.5");

    clickButton(el, "Apply");
    const landscapeApply = historyCapture.atomic.at(-1)!.after.present;
    if (landscapeApply.framing.kind !== "framed") {
      throw new Error("landscape Apply did not commit framing");
    }
    expect(landscapeApply.framing.pageFrame.x).toBeCloseTo(
      landscapeComposition.width * 0.125,
      12,
    );
    expect(landscapeApply.framing.pageFrame.y).toBe(0);
    expect(landscapeApply.framing.pageFrame.width).toBeCloseTo(
      landscapeComposition.width,
      12,
    );
    expect(landscapeApply.framing.pageFrame.height).toBeCloseTo(
      landscapeComposition.height,
      12,
    );
    expect(landscapeApply.framing.generationAspect).toBeCloseTo(
      landscapeComposition.width / landscapeComposition.height,
      14,
    );

    // Outside the mode, Undo traverses the frame commit and then the earlier
    // aspect-changing Paper command, leaving a meaningful Redo available.
    expect(
      pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    expect(
      pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    expect(lastCompositionFrame).toEqual(portraitComposition);

    clickButton(el, "Crop");
    const portraitX = frameInput(el, "x");
    setInput(portraitX, "-10");
    act(() => portraitX.focus());
    expect(
      pressHistoryShortcut(portraitX, { key: "y", ctrlKey: true })
        .defaultPrevented,
    ).toBe(false);
    expect(lastCompositionFrame).toEqual(portraitComposition);
    expect(portraitX.value).toBe("-10");

    clickButton(el, "Apply");
    const portraitApply = historyCapture.atomic.at(-1)!.after.present;
    if (portraitApply.framing.kind !== "framed") {
      throw new Error("portrait Apply did not commit framing");
    }
    expect(portraitApply.framing.pageFrame.x).toBeCloseTo(
      portraitComposition.width * -0.1,
      12,
    );
    expect(portraitApply.framing.pageFrame.y).toBe(0);
    expect(portraitApply.framing.pageFrame.width).toBeCloseTo(
      portraitComposition.width,
      12,
    );
    expect(portraitApply.framing.pageFrame.height).toBeCloseTo(
      portraitComposition.height,
      12,
    );
    expect(portraitApply.framing.generationAspect).toBeCloseTo(
      portraitComposition.width / portraitComposition.height,
      14,
    );
  });
});

describe("SketchControls — Image Asset aspect recomposition (#349)", () => {
  const assetA = "aspect-alpha-000000000001";
  const assetB = "aspect-beta-bbbbbbbbbbbb";

  function frameInput(el: HTMLElement, name: string): HTMLInputElement {
    const input = el.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (input === null) throw new Error(`no Page Frame ${name} input`);
    return input;
  }

  function aspectActions(el: HTMLElement): HTMLButtonElement[] {
    return [...el.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) => button.textContent === "Recompose to this image’s aspect",
    );
  }

  function environmentWith(
    dimensions: Readonly<Record<string, { width: number; height: number }>>,
  ): SketchEnvironment {
    const records = new Map(
      Object.entries(dimensions).map(([id, { width, height }]) => [
        id,
        {
          width,
          height,
          data: new Uint8ClampedArray(width * height * 4),
        },
      ]),
    );
    return { imageAssets: (id) => records.get(id) };
  }

  async function resolveCurrentEnvironment(
    environment: SketchEnvironment,
  ): Promise<void> {
    await act(async () => {
      sketchEnvironmentJob.starts.at(-1)!.resolve(environment);
      await Promise.resolve();
    });
  }

  function applyAsymmetricFrame(el: HTMLElement): void {
    clickButton(el, "Crop");
    setInput(frameInput(el, "x"), "10");
    setInput(frameInput(el, "y"), "5");
    setInput(frameInput(el, "width"), "70");
    setInput(frameInput(el, "height"), "80");
    clickButton(el, "Apply");
  }

  it("warns and leaves every authored and prepared state untouched when declined", async () => {
    const schema = {
      ...toneCalibration.schema,
      image: { kind: "image-asset", default: assetA },
    } satisfies ParamSchema;
    const generate = vi.fn(toneCalibration.generate);
    const sketch = {
      ...toneCalibration,
      id: "declined-image-aspect",
      schema,
      generate,
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const el = mount(<SketchControls sketch={sketch} />);
    await resolveCurrentEnvironment(
      environmentWith({ [assetA]: { width: 4, height: 3 } }),
    );
    applyAsymmetricFrame(el);

    const beforeHistory = historyCapture.atomic.at(-1)!.after;
    const beforeProfile = structuredClone(lastProfile);
    const beforeFrame = structuredClone(lastCommittedPageFrame);
    const beforeComposition = structuredClone(lastCompositionFrame);
    const beforeGenerateCalls = generate.mock.calls.length;
    const beforeOutlineStarts = outlineJob.starts;
    const beforeShadingStarts = shadingJob.starts.length;
    historyCapture.atomic.length = 0;

    clickButton(el, "Recompose to this image’s aspect");

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      "Recomposing to this image’s aspect will recompose the Scene and reset the Page Frame. Continue?",
    );
    expect(historyCapture.atomic).toHaveLength(0);
    expect(beforeHistory.present.framing).toEqual(
      expect.objectContaining({ kind: "framed", aspectLocked: true }),
    );
    expect(lastProfile).toEqual(beforeProfile);
    expect(lastCommittedPageFrame).toEqual(beforeFrame);
    expect(lastCompositionFrame).toEqual(beforeComposition);
    expect(generate).toHaveBeenCalledTimes(beforeGenerateCalls);
    expect(outlineJob.starts).toBe(beforeOutlineStarts);
    expect(shadingJob.starts).toHaveLength(beforeShadingStarts);
  });

  it("contains the decoded aspect in one atomic recompose and Undo/Redo restores full states", async () => {
    const schema = {
      image: { kind: "image-asset", default: assetA },
    } satisfies ParamSchema;
    const originalProfile: PlotProfile = {
      width: 230,
      height: 180,
      insets: { top: 11, right: 17, bottom: 13, left: 19 },
      includeFrame: true,
      toolWidthMillimeters: 0.42,
    };
    const generate = vi.fn(
      (
        _params: Readonly<Record<string, unknown>>,
        _seed: Seed,
        _t: number,
        frame: CoordinateSpace,
      ): Scene => ({ space: frame, primitives: [] }),
    );
    const sketch = {
      ...sketchWith("confirmed-image-aspect", schema),
      defaultOutputProfile: originalProfile,
      generate,
    };
    generateDuringLiveCanvasRender = true;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const el = mount(<SketchControls sketch={sketch} />);
    await resolveCurrentEnvironment(
      environmentWith({ [assetA]: { width: 4, height: 2 } }),
    );
    applyAsymmetricFrame(el);

    const before = historyCapture.atomic.at(-1)!.after;
    const beforeProfile = before.present.profile;
    const beforeFrame = structuredClone(lastCommittedPageFrame);
    const beforeGenerateCalls = generate.mock.calls.length;
    historyCapture.atomic.length = 0;

    act(() =>
      controlPanelCapture.recomposeHandlers.at(-1)!({
        paramKey: "image",
        imageAssetId: assetA,
        dimensions: { width: 999, height: 1 },
      }),
    );

    expect(historyCapture.atomic).toHaveLength(1);
    const command = historyCapture.atomic[0]!;
    const fitted = command.after.present.profile;
    expect(command.before).toBe(before);
    expect(command.after.present).toEqual({
      ...before.present,
      profile: {
        ...beforeProfile,
        height:
          (beforeProfile.width -
            beforeProfile.insets.left -
            beforeProfile.insets.right) /
            2 +
          beforeProfile.insets.top +
          beforeProfile.insets.bottom,
        insets: { ...beforeProfile.insets },
      },
      framing: { kind: "unframed" },
    });
    expect(command.after.past).toEqual([...before.past, before.present]);
    expect(command.after.future).toEqual([]);
    expect(fitted.width).toBeLessThanOrEqual(beforeProfile.width);
    expect(fitted.height).toBeLessThanOrEqual(beforeProfile.height);
    expect(fitted.width).toBe(beforeProfile.width);
    expect(fitted.insets).toEqual(beforeProfile.insets);
    expect(
      (fitted.width - fitted.insets.left - fitted.insets.right) /
        (fitted.height - fitted.insets.top - fitted.insets.bottom),
    ).toBe(2);
    expect(lastCommittedPageFrame).toBeNull();
    expect(el.querySelector('input[aria-label="Lock Page aspect"]')).toBeNull();
    expect(
      el.querySelector('[aria-label="image image asset identity"]')
        ?.textContent,
    ).toBe(assetA);
    expect(generate).toHaveBeenCalledTimes(beforeGenerateCalls + 1);

    expect(
      pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    expect(lastProfile).toEqual(beforeProfile);
    expect(lastCommittedPageFrame).toEqual(beforeFrame);
    expect(
      el.querySelector<HTMLInputElement>('input[aria-label="Lock Page aspect"]')
        ?.checked,
    ).toBe(true);
    expect(
      el.querySelector('[aria-label="image image asset identity"]')
        ?.textContent,
    ).toBe(assetA);

    expect(
      pressHistoryShortcut(window, { key: "y", ctrlKey: true })
        .defaultPrevented,
    ).toBe(true);
    expect(lastProfile).toEqual(fitted);
    expect(lastCommittedPageFrame).toBeNull();
    expect(el.querySelector('input[aria-label="Lock Page aspect"]')).toBeNull();
    expect(
      el.querySelector('[aria-label="image image asset identity"]')
        ?.textContent,
    ).toBe(assetA);
  });

  it("rejects a stored request after selection/resolution changes and keeps ordinary selection framing until an explicit action", async () => {
    managedImageAssetJob.list.mockResolvedValue([
      {
        id: assetB,
        name: "aspect beta",
        url: `/image-assets/${assetB}.png`,
      },
    ]);
    const schema = {
      image: { kind: "image-asset", default: assetA },
    } satisfies ParamSchema;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const el = mount(
      <SketchControls sketch={sketchWith("stale-image-aspect", schema)} />,
    );
    await resolveCurrentEnvironment(
      environmentWith({ [assetA]: { width: 2, height: 3 } }),
    );
    applyAsymmetricFrame(el);
    const framed = historyCapture.atomic.at(-1)!.after.present;
    const storedHandler = controlPanelCapture.recomposeHandlers.at(-1)!;

    clickButton(el, "Choose image");
    await flush();
    const choice = [
      ...el.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Image Assets"] button',
      ),
    ].find((button) => button.textContent?.includes("aspect beta"));
    if (choice === undefined) throw new Error("no beta asset choice");
    act(() => choice.click());

    const selected = historyCapture.atomic.at(-1)!.after;
    expect(selected.present.params.image).toBe(assetB);
    expect(selected.present.framing).toEqual(framed.framing);
    expect(selected.present.profile).toEqual(framed.profile);
    expect(lastCommittedPageFrame).not.toBeNull();
    const writesAfterSelection = historyCapture.atomic.length;

    act(() =>
      storedHandler({
        paramKey: "image",
        imageAssetId: assetA,
        dimensions: { width: 999, height: 1 },
      }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(historyCapture.atomic).toHaveLength(writesAfterSelection);

    await resolveCurrentEnvironment(
      environmentWith({ [assetB]: { width: 3, height: 1 } }),
    );
    act(() =>
      storedHandler({
        paramKey: "image",
        imageAssetId: assetA,
        dimensions: { width: 999, height: 1 },
      }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(historyCapture.atomic).toHaveLength(writesAfterSelection);
    expect(lastCommittedPageFrame).not.toBeNull();

    clickButton(el, "Recompose to this image’s aspect");
    expect(confirm).toHaveBeenCalledOnce();
    expect(historyCapture.atomic).toHaveLength(writesAfterSelection + 1);
    expect(historyCapture.atomic.at(-1)!.after.present.params.image).toBe(
      assetB,
    );
    expect(historyCapture.atomic.at(-1)!.after.present.framing).toEqual({
      kind: "unframed",
    });
  });

  it("fails closed when authored selection changes inside confirmation", async () => {
    managedImageAssetJob.list.mockResolvedValue([
      {
        id: assetB,
        name: "aspect beta",
        url: `/image-assets/${assetB}.png`,
      },
    ]);
    const schema = {
      image: { kind: "image-asset", default: assetA },
    } satisfies ParamSchema;
    const el = mount(
      <SketchControls
        sketch={sketchWith("confirm-race-image-aspect", schema)}
      />,
    );
    await resolveCurrentEnvironment(
      environmentWith({ [assetA]: { width: 4, height: 3 } }),
    );
    applyAsymmetricFrame(el);
    const framed = historyCapture.atomic.at(-1)!.after.present;
    clickButton(el, "Choose image");
    await flush();
    const choice = [
      ...el.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Image Assets"] button',
      ),
    ].find((button) => button.textContent?.includes("aspect beta"));
    if (choice === undefined) throw new Error("no beta asset choice");
    historyCapture.atomic.length = 0;
    const confirm = vi.spyOn(window, "confirm").mockImplementation(() => {
      choice.click();
      return true;
    });

    clickButton(el, "Recompose to this image’s aspect");

    expect(confirm).toHaveBeenCalledOnce();
    expect(historyCapture.atomic).toHaveLength(1);
    expect(historyCapture.atomic[0]!.after.present.params.image).toBe(assetB);
    expect(historyCapture.atomic[0]!.after.present.profile).toEqual(
      framed.profile,
    );
    expect(historyCapture.atomic[0]!.after.present.framing).toEqual(
      framed.framing,
    );
    expect(lastCommittedPageFrame).not.toBeNull();
    expect(sketchEnvironmentJob.starts.at(-1)!.params.image).toBe(assetB);
  });

  it("uses each row's own decoded record without selecting an image implicitly", async () => {
    const schema = {
      portrait: { kind: "image-asset", default: assetA },
      landscape: { kind: "image-asset", default: assetB },
    } satisfies ParamSchema;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const el = mount(
      <SketchControls sketch={sketchWith("multi-image-aspect", schema)} />,
    );
    await resolveCurrentEnvironment(
      environmentWith({
        [assetA]: { width: 1, height: 2 },
        [assetB]: { width: 4, height: 2 },
      }),
    );
    expect(aspectActions(el).map((button) => button.disabled)).toEqual([
      false,
      false,
    ]);
    historyCapture.atomic.length = 0;

    act(() => aspectActions(el)[1]!.click());

    expect(historyCapture.atomic).toHaveLength(1);
    const present = historyCapture.atomic[0]!.after.present;
    expect(present.params).toEqual({ portrait: assetA, landscape: assetB });
    const { width, height, insets } = present.profile;
    expect(
      (width - insets.left - insets.right) /
        (height - insets.top - insets.bottom),
    ).toBe(2);
    expect(
      el.querySelector('[aria-label="portrait image asset identity"]')
        ?.textContent,
    ).toBe(assetA);
    expect(
      el.querySelector('[aria-label="landscape image asset identity"]')
        ?.textContent,
    ).toBe(assetB);
  });
});

describe("SketchControls — collapsed-state a11y (#165)", () => {
  it("keeps #inspector mounted while collapsed so aria-controls resolves", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
        collapsed={true}
      />,
    );

    // The toggle references the inspector by id; while collapsed that target
    // MUST still exist (it is the affordance a screen-reader user uses to
    // re-open the panel) — present but `hidden`, not removed from the DOM.
    const toggle = el.querySelector<HTMLButtonElement>("button[aria-controls]");
    expect(toggle?.getAttribute("aria-controls")).toBe("inspector");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    const inspector = el.querySelector("#inspector");
    expect(inspector).not.toBeNull();
    // `hidden` collapses it (and drops it from the a11y tree) without unmounting.
    expect((inspector as HTMLElement).hidden).toBe(true);
  });

  it("shows #inspector (present, not hidden) when expanded", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
        collapsed={false}
      />,
    );

    const toggle = el.querySelector<HTMLButtonElement>("button[aria-controls]");
    expect(toggle?.getAttribute("aria-controls")).toBe("inspector");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");

    const inspector = el.querySelector("#inspector");
    expect(inspector).not.toBeNull();
    expect((inspector as HTMLElement).hidden).toBe(false);
  });
});

describe("SketchControls — Paper inspector integration (#248)", () => {
  it("places a collapsed Paper disclosure immediately after the switcher and before schema controls", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
        switcher={<div data-testid="sketch-switcher">Sketch switcher</div>}
      />,
    );
    const inspector = el.querySelector("#inspector")!;
    const switcher = inspector.querySelector('[data-testid="sketch-switcher"]');
    const paper = inspector.querySelector("details");
    const schemaControls = paramInput(el, "radius").closest(
      ".flex.flex-col.gap-4",
    );

    expect(paper?.open).toBe(false);
    expect(paper?.querySelector("summary")?.textContent).toContain("Paper");
    expect(paper?.previousElementSibling).toBe(switcher);
    expect(paper?.nextElementSibling).toBe(schemaControls);
  });

  it("keeps Paper mounted and collapsed when the whole inspector is hidden", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
        collapsed
      />,
    );
    const inspector = el.querySelector<HTMLElement>("#inspector")!;
    const paper = inspector.querySelector("details")!;

    expect(inspector.hidden).toBe(true);
    expect(paper.open).toBe(false);
    expect(paper.querySelector("summary")?.textContent).toContain(
      "200 × 200 mm",
    );
  });

  it("preserves the global display-unit preference across a keyed Sketch remount", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <SketchControls
          key="a"
          sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
        />,
      );
    });

    const inches = container.querySelector<HTMLInputElement>(
      'input[type="radio"][value="in"]',
    )!;
    act(() => inches.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector("details summary")?.textContent).toContain(
      "in",
    );

    act(() => {
      root!.render(
        <SketchControls
          key="b"
          sketch={sketchWith("b", { radius: numberSpec({ default: 20 }) })}
        />,
      );
    });

    expect(
      container.querySelector<HTMLInputElement>(
        'input[type="radio"][value="in"]',
      )?.checked,
    ).toBe(true);
    expect(container.querySelector("details summary")?.textContent).toContain(
      "in",
    );
  });

  it("persists the export-only margin preference across a full unmount/remount without changing Scene inputs", () => {
    autoFireOutlineComputed = false;
    const generate = vi.fn(() => ({
      space: { width: 100, height: 100 },
      primitives: [],
    }));
    const firstSketch = {
      ...sketchWith("a", { radius: numberSpec({ default: 10 }) }),
      generate,
    } as Parameters<typeof SketchControls>[0]["sketch"];
    const el = mount(<SketchControls sketch={firstSketch} />);
    const renderToggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => renderToggle.click());
    act(() => lastOnOutlineComputed?.());
    expect(renderToggle.textContent).toBe("Outline");
    expect(renderToggle.disabled).toBe(false);
    const profileBefore = lastProfile;
    const profileValueBefore = structuredClone(lastProfile);
    const frameBefore = lastCompositionFrame;

    expect(paperMarginsCheckbox(el).checked).toBe(true);
    act(() => paperMarginsCheckbox(el).click());

    expect(paperMarginsCheckbox(el).checked).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(lastProfile).toBe(profileBefore);
    expect(lastProfile).toEqual(profileValueBefore);
    expect(lastCompositionFrame).toBe(frameBefore);
    expect(renderToggle.textContent).toBe("Outline");
    expect(renderToggle.disabled).toBe(false);
    expect(historyCapture.atomic).toHaveLength(0);
    expect(historyCapture.transactionCommits).toHaveLength(0);

    act(() => root!.unmount());
    container!.remove();
    root = null;
    container = null;

    const remounted = mount(
      <SketchControls
        sketch={sketchWith("b", { radius: numberSpec({ default: 20 }) })}
      />,
    );
    expect(paperMarginsCheckbox(remounted).checked).toBe(false);
  });
});

describe("SketchControls — randomize / lock wiring", () => {
  it("Randomize rolls unlocked params but never touches a locked param", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {
          radius: numberSpec({ min: 0, max: 100, default: 10 }),
          count: numberSpec({ min: 0, max: 100, default: 5, integer: true }),
        })}
      />,
    );

    // Lock `radius` via its toggle, then Randomize. With a stubbed source the
    // unlocked `count` rolls to a known value; `radius` must pass through.
    const lockRadius = el.querySelector(
      'button[aria-label="radius lock"]',
    ) as HTMLButtonElement;
    act(() => {
      lockRadius.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(lockRadius.getAttribute("aria-pressed")).toBe("true");

    vi.spyOn(Math, "random").mockReturnValue(0.5);
    clickButton(el, "Randomize");

    // Locked radius is excluded from the roll — still its pre-roll value.
    expect(paramInput(el, "radius").value).toBe("10");
    // Unlocked count rolled: 0 + 0.5*(100-0) = 50, rounded (integer) = 50.
    expect(paramInput(el, "count").value).toBe("50");
  });

  it("a locked param stays hand-editable (lock excludes from roll, never disables)", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );

    const lockRadius = el.querySelector(
      'button[aria-label="radius lock"]',
    ) as HTMLButtonElement;
    act(() => {
      lockRadius.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(lockRadius.getAttribute("aria-pressed")).toBe("true");

    const input = paramInput(el, "radius");
    // The control is NOT disabled by the lock...
    expect(input.disabled).toBe(false);

    // ...and a hand edit still commits while locked.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "42");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(paramInput(el, "radius").value).toBe("42");
  });
});

describe("SketchControls — conditional authored-state acceptance", () => {
  const schema: ParamSchema = {
    strategy: {
      kind: "choice",
      default: "scribble",
      options: [
        { value: "scribble", label: "Scribble" },
        { value: "stipple", label: "Stippling" },
      ],
    },
    scribbleDensity: {
      kind: "number",
      min: 0,
      max: 100,
      default: 10,
      activeWhen: { key: "strategy", equals: "scribble" },
    },
    scribbleFidelity: {
      kind: "number",
      min: 0,
      max: 100,
      default: 20,
      activeWhen: { key: "strategy", equals: "scribble" },
    },
    stippleDensity: {
      kind: "number",
      min: 0,
      max: 100,
      default: 60,
      activeWhen: { key: "strategy", equals: "stipple" },
    },
  };

  const commitNumber = (
    el: HTMLElement,
    key: string,
    value: string,
  ): void => {
    const input = paramInput(el, key);
    act(() => input.focus());
    setInput(input, value);
    act(() => input.blur());
  };

  it("keeps hidden tuning through one-command Choice Undo/Redo and randomizes only active unlocked numbers", async () => {
    const el = mount(
      <SketchControls sketch={sketchWith("conditional-history", schema)} />,
    );
    await flush();

    expect(choiceParamSelect(el, "strategy").value).toBe("scribble");
    expect(paramInput(el, "scribbleDensity").value).toBe("10");
    expect(el.querySelector("#control-stippleDensity")).toBeNull();
    commitNumber(el, "scribbleDensity", "23");

    const commitsBeforeFirstSwitch = historyCapture.transactionCommits.length;
    selectValue(choiceParamSelect(el, "strategy"), "stipple");
    expect(historyCapture.transactionCommits).toHaveLength(
      commitsBeforeFirstSwitch + 1,
    );
    const firstSwitch = historyCapture.transactionCommits.at(-1)!;
    expect(firstSwitch.before.transactionStart?.params.strategy).toBe(
      "scribble",
    );
    expect(firstSwitch.before.present.params.strategy).toBe("stipple");
    expect(firstSwitch.after.present.params.strategy).toBe("stipple");
    expect(firstSwitch.after.past).toHaveLength(
      firstSwitch.before.past.length + 1,
    );
    expect(el.querySelector("#control-scribbleDensity")).toBeNull();
    expect(paramInput(el, "stippleDensity").value).toBe("60");

    commitNumber(el, "stippleDensity", "81");
    const commitsBeforeReturn = historyCapture.transactionCommits.length;
    selectValue(choiceParamSelect(el, "strategy"), "scribble");
    expect(historyCapture.transactionCommits).toHaveLength(
      commitsBeforeReturn + 1,
    );
    expect(paramInput(el, "scribbleDensity").value).toBe("23");

    expect(
      pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    expect(choiceParamSelect(el, "strategy").value).toBe("stipple");
    expect(paramInput(el, "stippleDensity").value).toBe("81");

    expect(
      pressHistoryShortcut(window, { key: "y", ctrlKey: true })
        .defaultPrevented,
    ).toBe(true);
    expect(choiceParamSelect(el, "strategy").value).toBe("scribble");
    expect(paramInput(el, "scribbleDensity").value).toBe("23");

    act(() => {
      el.querySelector('button[aria-label="scribbleDensity lock"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    clickButton(el, "Randomize");

    expect(paramInput(el, "scribbleDensity").value).toBe("23");
    expect(paramInput(el, "scribbleFidelity").value).toBe("50");
    expect(random).toHaveBeenCalledTimes(1);
    const authored = historyCapture.atomic.at(-1)!.after.present.params as Params;
    const authoredSnapshot = { ...authored };
    expect(authored).toEqual({
      strategy: "scribble",
      scribbleDensity: 23,
      scribbleFidelity: 50,
      stippleDensity: 81,
    });
    expect(activeParams(schema, authored)).toEqual({
      strategy: "scribble",
      scribbleDensity: 23,
      scribbleFidelity: 50,
    });
    expect(authored).toEqual(authoredSnapshot);

    selectValue(choiceParamSelect(el, "strategy"), "stipple");
    expect(paramInput(el, "stippleDensity").value).toBe("81");
  });

  it("saves complete conditional state and reloads the selected and hidden branches", async () => {
    const loaded: Preset = {
      version: 2,
      sketch: "conditional-preset",
      name: "authored",
      seed: 777,
      params: {
        strategy: "stipple",
        scribbleDensity: 31,
        scribbleFidelity: 42,
        stippleDensity: 87,
      },
      locks: ["scribbleDensity"],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    };
    listPresets.mockResolvedValue(["authored"]);
    loadPreset.mockResolvedValue(loaded);
    const el = mount(
      <SketchControls sketch={sketchWith("conditional-preset", schema)} />,
    );
    await flush();

    commitNumber(el, "scribbleDensity", "23");
    selectValue(choiceParamSelect(el, "strategy"), "stipple");
    commitNumber(el, "stippleDensity", "81");
    setInput(
      el.querySelector('input[aria-label="preset name"]') as HTMLInputElement,
      "conditional-save",
    );
    clickButton(el, "Save");
    await flush();

    expect(savePreset).toHaveBeenCalledTimes(1);
    expect(savePreset.mock.calls[0]![0]).toMatchObject({
      sketch: "conditional-preset",
      name: "conditional-save",
      params: {
        strategy: "stipple",
        scribbleDensity: 23,
        scribbleFidelity: 20,
        stippleDensity: 81,
      },
    });

    const picker = el.querySelector<HTMLSelectElement>(
      'select[aria-label="saved presets"]',
    )!;
    selectValue(picker, "authored");
    clickButton(el, "Reload");
    await flush();

    expect(choiceParamSelect(el, "strategy").value).toBe("stipple");
    expect(paramInput(el, "stippleDensity").value).toBe("87");
    expect(historyCapture.atomic.at(-1)!.after.present.params).toEqual(
      loaded.params,
    );
    selectValue(choiceParamSelect(el, "strategy"), "scribble");
    expect(paramInput(el, "scribbleDensity").value).toBe("31");
    expect(paramInput(el, "scribbleFidelity").value).toBe("42");
  });

  it("reconciles a legacy Preset missing Choice and dependent fields to live defaults", async () => {
    listPresets.mockResolvedValue(["legacy"]);
    loadPreset.mockResolvedValue({
      version: 1,
      sketch: "conditional-legacy",
      name: "legacy",
      seed: 888,
      params: {},
      locks: [],
    });
    const el = mount(
      <SketchControls sketch={sketchWith("conditional-legacy", schema)} />,
    );
    await flush();

    const picker = el.querySelector<HTMLSelectElement>(
      'select[aria-label="saved presets"]',
    )!;
    selectValue(picker, "legacy");
    clickButton(el, "Reload");
    await flush();

    expect(choiceParamSelect(el, "strategy").value).toBe("scribble");
    expect(paramInput(el, "scribbleDensity").value).toBe("10");
    expect(paramInput(el, "scribbleFidelity").value).toBe("20");
    expect(el.querySelector("#control-stippleDensity")).toBeNull();
    expect(historyCapture.atomic.at(-1)!.after.present.params).toEqual({
      strategy: "scribble",
      scribbleDensity: 10,
      scribbleFidelity: 20,
      stippleDensity: 60,
    });
  });
});

describe("SketchControls — preset save/reload wiring", () => {
  const schema: ParamSchema = {
    radius: numberSpec({ min: 0, max: 100, default: 10 }),
    count: numberSpec({ min: 0, max: 100, default: 5, integer: true }),
  };

  it("reloading a preset hydrates params, seed, AND locks-as-a-Set", async () => {
    // A preset whose values differ from the schema defaults and that locks one
    // key, so each axis hydrating is observable.
    const loadedProfile: PlotProfile = {
      width: 210,
      height: 297,
      insets: { top: 12, right: 13, bottom: 14, left: 15 },
      includeFrame: false,
      toolWidthMillimeters: 0.3,
    };
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "a",
      name: "warm",
      seed: 999,
      params: { radius: 77, count: 88, futureSchemaKey: 66 },
      locks: ["radius", "futureSchemaKey"],
      profile: loadedProfile,
    });
    listPresets.mockResolvedValue(["warm"]);

    const reloadSchema: ParamSchema = {
      ...schema,
      futureSchemaKey: numberSpec({ default: 6 }),
    };
    const el = mount(
      <SketchControls sketch={sketchWith("a", reloadSchema)} />,
    );
    await flush(); // list-on-mount populates the picker
    const initialSeed = el.querySelector('[data-testid="canvas-seed"]')
      ?.textContent;
    const initialProfile = structuredClone(lastProfile);

    // Pick "warm" and Reload.
    const picker = el.querySelector(
      'select[aria-label="saved presets"]',
    ) as HTMLSelectElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(picker, "warm");
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(loadPreset).not.toHaveBeenCalled(); // not until Reload is clicked
    clickButton(el, "Reload");
    await flush();

    expect(loadPreset).toHaveBeenCalledWith("a", "warm");
    // params hydrated exactly (loaded AS-IS, unclamped through applyPreset)...
    expect(paramInput(el, "radius").value).toBe("77");
    expect(paramInput(el, "count").value).toBe("88");
    expect(paramInput(el, "futureSchemaKey").value).toBe("66");
    // ...seed hydrated (the value the canvas is fed)...
    expect(el.querySelector('[data-testid="canvas-seed"]')?.textContent).toBe(
      "999",
    );
    // ...and the locks array rehydrated as a Set — the locked key's toggle is
    // pressed, the unlocked one is not (this IS the array→Set glue under test).
    expect(
      el
        .querySelector('button[aria-label="radius lock"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      el
        .querySelector('button[aria-label="count lock"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    // One Preset reload changes params, seed, and locks together, but records a
    // single whole-state transition.
    expect(historyCapture.atomic).toHaveLength(1);
    const reload = historyCapture.atomic[0]!;
    expect(reload.after.past).toHaveLength(1);
    expect(reload.after.present.params).toEqual({
      radius: 77,
      count: 88,
      futureSchemaKey: 66,
    });
    expect(reload.after.present.seed).toBe(999);
    expect(reload.after.present.locks).toEqual(
      new Set(["radius", "futureSchemaKey"]),
    );
    expect(reload.after.present.profile).toEqual(loadedProfile);
    expect(lastProfile).toEqual(loadedProfile);

    // The atomic reload traverses as one whole-state step, including a key that
    // arrived through the current schema rather than a hard-coded field list.
    pressHistoryShortcut(window, { ctrlKey: true });
    expect(paramInput(el, "radius").value).toBe("10");
    expect(paramInput(el, "count").value).toBe("5");
    expect(paramInput(el, "futureSchemaKey").value).toBe("6");
    expect(el.querySelector('[data-testid="canvas-seed"]')?.textContent).toBe(
      initialSeed,
    );
    expect(
      el
        .querySelector('button[aria-label="radius lock"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(lastProfile).toEqual(initialProfile);

    pressHistoryShortcut(window, { key: "y", ctrlKey: true });
    expect(paramInput(el, "futureSchemaKey").value).toBe("66");
    expect(el.querySelector('[data-testid="canvas-seed"]')?.textContent).toBe(
      "999",
    );
    expect(lastProfile).toEqual(loadedProfile);
  });

  it("reloads v3 profile and framing together so generation and final Page use the stored snapshot", async () => {
    const loadedProfile: PlotProfile = {
      width: 360,
      height: 240,
      insets: { top: 7, right: 11, bottom: 13, left: 17 },
      includeFrame: false,
      toolWidthMillimeters: 0.45,
    };
    const loadedFraming = {
      pageFrame: { x: -12.5, y: 8.25, width: 144.75, height: 92.5 },
      generationAspect: 16 / 9,
      aspectLocked: false,
    };
    loadPreset.mockResolvedValue({
      version: 3,
      sketch: "a",
      name: "framed",
      seed: 999,
      params: { radius: 77, count: 88 },
      locks: ["radius"],
      profile: loadedProfile,
      framing: loadedFraming,
    });
    listPresets.mockResolvedValue(["framed"]);

    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush();
    const initialComposition = structuredClone(lastCompositionFrame);
    const picker = el.querySelector<HTMLSelectElement>(
      'select[aria-label="saved presets"]',
    )!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(picker, "framed");
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });

    clickButton(el, "Reload");
    await flush();

    expect(historyCapture.atomic).toHaveLength(1);
    const reload = historyCapture.atomic[0]!.after;
    expect(reload.past).toHaveLength(1);
    expect(reload.present.profile).toEqual(loadedProfile);
    expect(reload.present.framing).toEqual({
      kind: "framed",
      ...loadedFraming,
    });
    expect(lastProfile).toEqual(loadedProfile);
    expect(lastCompositionFrame).toEqual(
      resolveCompositionFrame(loadedFraming.generationAspect),
    );
    expect(lastCompositionFrame).not.toEqual(initialComposition);
    expect(lastCommittedPageFrame).toEqual(loadedFraming.pageFrame);
    expect(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Lock Page aspect"]',
      )?.checked,
    ).toBe(false);
  });

  it.each([
    ["v1", 1],
    ["v2", 2],
  ] as const)(
    "a legacy %s reload explicitly clears prior v3 framing while preserving profile precedence",
    async (_label, version) => {
      const framedProfile: PlotProfile = {
        width: 360,
        height: 240,
        insets: { top: 7, right: 11, bottom: 13, left: 17 },
        includeFrame: false,
        toolWidthMillimeters: 0.45,
      };
      const sketchDefault: PlotProfile = {
        width: 297,
        height: 210,
        insets: { top: 9, right: 10, bottom: 11, left: 12 },
        includeFrame: true,
        toolWidthMillimeters: 0.35,
      };
      const v2Profile: PlotProfile = {
        width: 210,
        height: 297,
        insets: { top: 14, right: 15, bottom: 16, left: 17 },
        includeFrame: false,
        toolWidthMillimeters: 0.25,
      };
      const framed: Preset = {
        version: 3,
        sketch: "legacy-clear",
        name: "framed",
        seed: 8,
        params: { radius: 22, count: 33 },
        locks: [],
        profile: framedProfile,
        framing: {
          pageFrame: { x: 12, y: -8, width: 140, height: 90 },
          generationAspect: 3 / 2,
          aspectLocked: true,
        },
      };
      const legacy: Preset =
        version === 1
          ? {
              version: 1,
              sketch: "legacy-clear",
              name: "legacy",
              seed: 9,
              params: { radius: 44, count: 55 },
              locks: [],
            }
          : {
              version: 2,
              sketch: "legacy-clear",
              name: "legacy",
              seed: 9,
              params: { radius: 44, count: 55 },
              locks: [],
              profile: v2Profile,
            };
      loadPreset.mockImplementation(async (_id, name) =>
        name === "framed" ? framed : legacy,
      );
      listPresets.mockResolvedValue(["framed", "legacy"]);
      const sketch = {
        ...sketchWith("legacy-clear", schema),
        defaultOutputProfile: sketchDefault,
      } as Parameters<typeof SketchControls>[0]["sketch"];
      const el = mount(<SketchControls sketch={sketch} />);
      await flush();

      const picker = el.querySelector<HTMLSelectElement>(
        'select[aria-label="saved presets"]',
      )!;
      const selectAndReload = async (name: string) => {
        act(() => {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLSelectElement.prototype,
            "value",
          )!.set!;
          setter.call(picker, name);
          picker.dispatchEvent(new Event("change", { bubbles: true }));
        });
        clickButton(el, "Reload");
        await flush();
      };

      await selectAndReload("framed");
      expect(lastCommittedPageFrame).toEqual(framed.framing?.pageFrame);

      await selectAndReload("legacy");

      expect(historyCapture.atomic).toHaveLength(2);
      const legacyReload = historyCapture.atomic[1]!.after;
      expect(legacyReload.past).toHaveLength(2);
      expect(legacyReload.present.framing).toEqual({ kind: "unframed" });
      expect(legacyReload.present.profile).toEqual(
        version === 1 ? sketchDefault : v2Profile,
      );
      expect(lastProfile).toEqual(version === 1 ? sketchDefault : v2Profile);
      expect(lastCommittedPageFrame).toBeNull();
      expect(
        el.querySelector('input[aria-label="Lock Page aspect"]'),
      ).toBeNull();
      expect(lastCompositionFrame).toEqual(
        resolvePlotCompositionFrame(version === 1 ? sketchDefault : v2Profile),
      );
    },
  );

  it("reloads and re-saves the exact non-default Image Asset ID", async () => {
    const defaultAsset = "portrait-default-000000000001";
    const persistedAsset = "portrait-persisted-bbbbbbbbbbbb";
    const imageSchema: ParamSchema = {
      imageAsset: { kind: "image-asset", default: defaultAsset },
    };
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "photo-persist",
      name: "persisted-image",
      seed: 321,
      params: { imageAsset: persistedAsset },
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
    listPresets.mockResolvedValue(["persisted-image"]);

    const el = mount(
      <SketchControls sketch={sketchWith("photo-persist", imageSchema)} />,
    );
    await flush();
    const picker = el.querySelector<HTMLSelectElement>(
      'select[aria-label="saved presets"]',
    )!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(picker, "persisted-image");
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    clickButton(el, "Reload");
    await flush();

    expect(
      el.querySelector('[aria-label="imageAsset image asset identity"]')
        ?.textContent,
    ).toBe(persistedAsset);
    expect(historyCapture.atomic).toHaveLength(1);
    expect(historyCapture.atomic[0]!.before.present.params.imageAsset).toBe(
      defaultAsset,
    );
    expect(historyCapture.atomic[0]!.after.present.params.imageAsset).toBe(
      persistedAsset,
    );

    setInput(
      el.querySelector('input[aria-label="preset name"]') as HTMLInputElement,
      "image-roundtrip",
    );
    clickButton(el, "Save");
    await flush();

    expect(savePreset).toHaveBeenCalledTimes(1);
    expect(savePreset.mock.calls[0]![0]).toMatchObject({
      version: 2,
      sketch: "photo-persist",
      name: "image-roundtrip",
      seed: 321,
      params: { imageAsset: persistedAsset },
    });
  });

  it("preserves a persisted color lock as inert data across reload and save", async () => {
    const mixedSchema: ParamSchema = {
      radius: numberSpec({ min: 0, max: 100, default: 10 }),
      ink: { kind: "color", default: "#1a2b3c" },
    };
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "a",
      name: "legacy-color-lock",
      seed: 999,
      params: { radius: 20, ink: "#abcdef" },
      locks: ["ink"],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
    listPresets.mockResolvedValue(["legacy-color-lock"]);

    const el = mount(
      <SketchControls sketch={sketchWith("a", mixedSchema)} />,
    );
    await flush();
    const picker = el.querySelector<HTMLSelectElement>(
      'select[aria-label="saved presets"]',
    )!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(picker, "legacy-color-lock");
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    clickButton(el, "Reload");
    await flush();

    // Reconciliation keeps a schema-present color key in the generic lock Set,
    // but the mixed control surface exposes Lock only for the numeric sibling.
    expect(historyCapture.atomic.at(-1)?.after.present.locks).toEqual(
      new Set(["ink"]),
    );
    expect(el.querySelector('button[aria-label="ink lock"]')).toBeNull();
    expect(el.querySelector('button[aria-label="radius lock"]')).not.toBeNull();
    expect(
      el.querySelector('button[aria-label^="ink current color #abcdef"]'),
    ).not.toBeNull();

    // The inert color entry does not prevent an unlocked numeric roll and the
    // color still follows Randomize's unconditional pass-through contract.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    clickButton(el, "Randomize");
    expect(paramInput(el, "radius").value).toBe("50");
    expect(
      el.querySelector('button[aria-label^="ink current color #abcdef"]'),
    ).not.toBeNull();

    setInput(
      el.querySelector('input[aria-label="preset name"]') as HTMLInputElement,
      "roundtrip",
    );
    clickButton(el, "Save");
    await flush();

    // Save receives the generic Set unchanged; makePreset serializes the legacy
    // color key normally instead of filtering or migrating it away.
    expect(savePreset).toHaveBeenCalledTimes(1);
    expect(savePreset.mock.calls[0]?.[0]).toMatchObject({
      name: "roundtrip",
      params: { radius: 50, ink: "#abcdef" },
      locks: ["ink"],
    });
  });

  it("saving serializes the live params, seed, locks, AND the active profile under the sketch id", async () => {
    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush();

    // Lock `radius`, edit `count`, edit the seed — the live state a Save captures.
    act(() => {
      el.querySelector('button[aria-label="radius lock"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    setInput(paramInput(el, "count"), "33");
    setInput(el.querySelector("#sketch-seed") as HTMLInputElement, "4242");

    // Type a valid slug name, then Save.
    setInput(
      el.querySelector('input[aria-label="preset name"]') as HTMLInputElement,
      "warm",
    );
    const historyWritesBeforeSave =
      historyCapture.atomic.length + historyCapture.transactionCommits.length;
    clickButton(el, "Save");
    await flush();

    expect(savePreset).toHaveBeenCalledTimes(1);
    // The Save now stamps a v2 record (#266) carrying the session's active Plot
    // Profile (#267). This Sketch declares no default, so the active profile is
    // the Harness fallback resolved at mount.
    expect(savePreset.mock.calls[0]?.[0]).toEqual({
      version: 2,
      sketch: "a",
      name: "warm",
      seed: 4242,
      params: { radius: 10, count: 33 },
      locks: ["radius"],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
    expect(
      historyCapture.atomic.length + historyCapture.transactionCommits.length,
    ).toBe(historyWritesBeforeSave);
  });

  it("rejects an invalid (non-slug) name inline and does not save", async () => {
    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush();

    setInput(
      el.querySelector('input[aria-label="preset name"]') as HTMLInputElement,
      "bad/name",
    );
    // Inline hint shown; Save is disabled and clicking it is a no-op. The hint
    // is the only alert in this invalid-name scenario (no error <p> renders), so
    // a class-independent role + hint-text match pins it.
    const hint = el.querySelector('p[role="alert"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain("use only a-z");
    const save = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Save",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    clickButton(el, "Save");
    await flush();
    expect(savePreset).not.toHaveBeenCalled();
  });
});

describe("SketchControls — Plot Profile session wiring (#267)", () => {
  const schema: ParamSchema = {
    radius: numberSpec({ min: 0, max: 100, default: 10 }),
  };

  // A profile that differs from the Harness fallback (200×200, 10mm insets) on
  // every field, so "the active profile IS / is NOT this value" is unambiguous.
  const customProfile: PlotProfile = {
    width: 420,
    height: 297,
    insets: { top: 15, right: 12, bottom: 9, left: 6 },
    includeFrame: false,
    toolWidthMillimeters: 0.3,
  };

  // A Sketch that DECLARES its own default Output Profile. No registered sketch
  // does today, so this variant is the only way to exercise #265's middle
  // precedence rung (the Sketch default) — the fallback-only `sketchWith` always
  // resolves straight to the Harness fallback.
  const sketchWithDefault = (id: string, profile: PlotProfile) =>
    ({
      ...(sketchWith(id, schema) as unknown as Record<string, unknown>),
      defaultOutputProfile: profile,
    }) as unknown as Parameters<typeof SketchControls>[0]["sketch"];

  /** Type a valid name, Save, and return the Preset the client last received. */
  async function saveAndCapture(
    el: HTMLElement,
    presetName: string,
  ): Promise<Preset> {
    setInput(
      el.querySelector('input[aria-label="preset name"]') as HTMLInputElement,
      presetName,
    );
    clickButton(el, "Save");
    await flush();
    const calls = savePreset.mock.calls;
    return calls[calls.length - 1]![0];
  }

  /** Select `presetName` in the picker and click Reload. */
  function reloadInUi(el: HTMLElement, presetName: string): void {
    const picker = el.querySelector(
      'select[aria-label="saved presets"]',
    ) as HTMLSelectElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(picker, presetName);
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    clickButton(el, "Reload");
  }

  it("resolves the active profile from the Sketch's own declared default at mount (#265 sketch-default rung)", async () => {
    // The declared default wins over the Harness fallback — a plain Save (no
    // reload) stamps a v2 record carrying THIS Sketch's declared profile.
    const el = mount(
      <SketchControls sketch={sketchWithDefault("a", customProfile)} />,
    );
    await flush();

    const preset = await saveAndCapture(el, "declared");
    expect(preset).toMatchObject({ version: 2, profile: customProfile });
  });

  it("re-resolves per Sketch on a keyed remount, never reusing the prior Sketch's active profile (#267)", async () => {
    // App mounts this with key={sketch.id}, so a Sketch switch remounts it and
    // re-runs the lazy initializer against the NEW Sketch's own default. Render
    // Sketch A (declares customProfile), then remount under a DIFFERENT key onto
    // Sketch B (no declared default): B must resolve to the Harness fallback, NOT
    // carry over A's customProfile. The keyed remount IS the per-Sketch reset.
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <SketchControls key="a" sketch={sketchWithDefault("a", customProfile)} />,
      );
    });
    await flush();

    // A's active profile is its declared default.
    const presetA = await saveAndCapture(container, "from-a");
    expect(presetA).toMatchObject({
      version: 2,
      sketch: "a",
      profile: customProfile,
    });

    // Switch Sketch: remount under a new key onto B (declares no default).
    savePreset.mockClear();
    act(() => {
      root!.render(<SketchControls key="b" sketch={sketchWith("b", schema)} />);
    });
    await flush();

    const presetB = await saveAndCapture(container, "from-b");
    // B re-resolved from its OWN default (the Harness fallback) — it did NOT
    // inherit A's active customProfile.
    expect(presetB).toMatchObject({
      version: 2,
      sketch: "b",
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
    expect(presetB.profile).not.toEqual(customProfile);
  });

  it("reloading a v2 Preset adopts its stored profile (it wins) and a subsequent Save re-emits it (#265 v2 rung)", async () => {
    // A v2 preset carrying customProfile, reloaded onto a Sketch with no declared
    // default: the stored profile must WIN over the Sketch default / Harness
    // fallback (the top rung of #265's precedence).
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "a",
      name: "wide",
      seed: 7,
      params: { radius: 10 },
      locks: [],
      profile: customProfile,
    });
    listPresets.mockResolvedValue(["wide"]);

    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush();

    reloadInUi(el, "wide");
    await flush();

    expect(lastProfile).toEqual(customProfile);
    // A Save now re-emits the reloaded profile — the stored v2 profile won.
    const preset = await saveAndCapture(el, "again");
    expect(preset).toMatchObject({ version: 2, profile: customProfile });
  });

  it("reloading a v1 Preset (no profile) falls back to the Harness fallback when the Sketch declares no default (#265 v1 fallback)", async () => {
    // A v1 preset carries no profile, so the reload resolves through the fallback
    // — here the Harness fallback (this Sketch declares no default).
    loadPreset.mockResolvedValue({
      version: 1,
      sketch: "a",
      name: "legacy",
      seed: 3,
      params: { radius: 10 },
      locks: [],
    });
    listPresets.mockResolvedValue(["legacy"]);

    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush();

    reloadInUi(el, "legacy");
    await flush();

    expect(lastProfile).toEqual(HARNESS_FALLBACK_PLOT_PROFILE);
    const preset = await saveAndCapture(el, "resaved");
    expect(preset).toMatchObject({
      version: 2,
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
  });

  it("reloading a v1 Preset falls back to the Sketch's declared default when it has one (#265 middle rung)", async () => {
    // Same v1 (profile-less) preset, but reloaded onto a Sketch that DECLARES a
    // default: the fallback resolves to that Sketch default, not the Harness
    // fallback — the middle rung of #265's precedence.
    loadPreset.mockResolvedValue({
      version: 1,
      sketch: "a",
      name: "legacy",
      seed: 3,
      params: { radius: 10 },
      locks: [],
    });
    listPresets.mockResolvedValue(["legacy"]);

    const el = mount(
      <SketchControls sketch={sketchWithDefault("a", customProfile)} />,
    );
    await flush();

    reloadInUi(el, "legacy");
    await flush();

    const preset = await saveAndCapture(el, "resaved");
    expect(preset).toMatchObject({ version: 2, profile: customProfile });
  });

  it("an SVG export's reproduction metadata carries the session's active (reloaded) profile (#247)", async () => {
    // Prove the EXPORT path reflects the session's active profile, not just the
    // mount default: reload a v2 preset carrying customProfile, then export SVG
    // and assert the embedded envelope is a v2 record carrying that profile.
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "a",
      name: "wide",
      seed: 7,
      params: { radius: 10 },
      locks: [],
      profile: customProfile,
    });
    listPresets.mockResolvedValue(["wide"]);

    // A Sketch whose generate yields a serializable (empty-primitives) Scene, so
    // the SVG export path runs to a real <metadata>-bearing document.
    const svgSketch = {
      ...(sketchWith("a", schema) as unknown as Record<string, unknown>),
      generate: () => ({ space: { width: 100, height: 100 }, primitives: [] }),
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];

    const el = mount(<SketchControls sketch={svgSketch} />);
    await flush();

    reloadInUi(el, "wide");
    await flush();

    clickButton(el, "Export SVG");

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob] = downloadBlob.mock.calls[0]!;
    const svg = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    const meta = svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1];
    expect(meta).toBeDefined();
    expect(JSON.parse(meta!)).toMatchObject({
      version: 2,
      sketch: "a",
      profile: customProfile,
    });
  });

  it("threads one profile-resolved frame through preview and plain SVG at the captured t", async () => {
    const generate = vi.fn(() => ({
      space: { width: 100, height: 100 },
      primitives: [],
    }));
    const sketch = {
      ...(sketchWith("a", schema) as unknown as Record<string, unknown>),
      time: { duration: 4, mode: "loop" },
      generate,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "a",
      name: "wide",
      seed: 7,
      params: { radius: 10 },
      locks: [],
      profile: customProfile,
    });
    listPresets.mockResolvedValue(["wide"]);
    fakeCurrentT = 2.5;

    const el = mount(<SketchControls sketch={sketch} />);
    await flush();
    reloadInUi(el, "wide");
    await flush();

    const expected = resolvePlotCompositionFrame(customProfile);
    expect(lastProfile).toEqual(customProfile);
    expect(lastCompositionFrame).toEqual(expected);
    clickButton(el, "Export SVG");
    expect(generate).toHaveBeenLastCalledWith({ radius: 10 }, 7, 2.5, expected);
  });

  it("keeps the resolved frame identity when profile magnitude changes at the same drawable aspect", async () => {
    const sameAspectProfile: PlotProfile = {
      width: 400,
      height: 400,
      insets: { top: 20, right: 20, bottom: 20, left: 20 },
      includeFrame: false,
      toolWidthMillimeters: 0.3,
    };
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "a",
      name: "larger-square",
      seed: 7,
      params: { radius: 10 },
      locks: [],
      profile: sameAspectProfile,
    });
    listPresets.mockResolvedValue(["larger-square"]);

    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush();
    const initialFrame = lastCompositionFrame;
    reloadInUi(el, "larger-square");
    await flush();

    expect(lastProfile).toEqual(sameAspectProfile);
    expect(lastCompositionFrame).toBe(initialFrame);
  });

  it("refreshes same-aspect paper layout without replacing geometry or recomputing Outline", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;

    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => lastOnOutlineComputed?.());
    expect(toggle.textContent).toBe("Outline");
    const initialFrame = lastCompositionFrame;

    // The fallback sheet is square. Changing all linked insets together keeps
    // its drawable rectangle square, while still changing the preview's sheet
    // layout ratios and active physical profile.
    setInput(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Linked paper margin (mm)"]',
      )!,
      "20",
    );

    expect(lastProfile).toEqual({
      width: 200,
      height: 200,
      insets: { top: 20, right: 20, bottom: 20, left: 20 },
      includeFrame: true,
      toolWidthMillimeters: 0.3,
    });
    expect(lastCompositionFrame).toBe(initialFrame);
    expect(toggle.textContent).toBe("Outline");
    expect(toggle.disabled).toBe(false);
  });

  it("reuses specialized Outline geometry when only its physical target changes", () => {
    autoFireOutlineComputed = false;
    const generateOutlineSource = vi.fn(() => ({
      space: { width: 1_000, height: 1_000 },
      primitives: [],
    }));
    const sketch = {
      ...(sketchWith("physical-specialized", schema) as unknown as Record<
        string,
        unknown
      >),
      generateOutlineSource,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
    const el = mount(<SketchControls sketch={sketch} />);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;

    act(() => toggle.click());
    const firstIdentity = outlineJob.lastIdentity;
    expect(firstIdentity?.sourceKind).toBe("specialized-sketch");
    if (firstIdentity?.sourceKind !== "specialized-sketch") {
      throw new Error("expected specialized identity");
    }
    expect(firstIdentity.outlineTarget.millimetersPerSceneUnit).toBe(0.18);
    expect(firstIdentity.outlineTarget.toolWidthMillimeters).toBe(0.3);
    const initialFrame = lastCompositionFrame;
    act(() => lastOnOutlineComputed?.());

    const margin = el.querySelector<HTMLInputElement>(
      'input[aria-label="Linked paper margin (mm)"]',
    )!;
    act(() => margin.focus());
    setInput(margin, "20");
    expect(outlineJob.starts).toBe(1);
    act(() => margin.blur());

    expect(outlineJob.starts).toBe(1);
    expect(lastCompositionFrame).toBe(initialFrame);
    expect(toggle.textContent).toBe("Outline");

    const toolWidth = el.querySelector<HTMLInputElement>(
      'input[aria-label="Tool width (mm)"]',
    )!;
    act(() => toolWidth.focus());
    setInput(toolWidth, "0.5");
    act(() => toolWidth.blur());

    expect(outlineJob.starts).toBe(1);
    expect(lastProfile?.toolWidthMillimeters).toBe(0.5);
    expect(toggle.textContent).toBe("Outline");
    expect(lastCompositionFrame).toBe(initialFrame);
    expect(generateOutlineSource).not.toHaveBeenCalled();
  });

  it("keeps legacy Outline identity and authored stroke widths exact across tool changes", () => {
    autoFireOutlineComputed = false;
    const source: Scene = {
      space: { width: 1_000, height: 1_000 },
      primitives: [
        {
          points: [[10, 10], [900, 900]],
          stroke: { color: "purple", width: 4 },
          hiddenLineRole: "source",
        },
      ],
    };
    const generate = vi.fn(() => source);
    const el = mount(
      <SketchControls
        sketch={{ ...sketchWith("legacy-exact", schema), generate }}
      />,
    );
    fakeFillCaptureScene = source;
    clickButton(el, "Fill");
    act(() => lastOnOutlineComputed?.());
    const initialIdentity = outlineJob.lastIdentity;
    expect(initialIdentity?.sourceKind).toBe("legacy-scene");
    expect(lastRenderScene?.primitives[0]?.stroke?.width).toBe(4);

    generate.mockClear();
    generateDuringLiveCanvasRender = true;
    const toolWidth = el.querySelector<HTMLInputElement>(
      'input[aria-label="Tool width (mm)"]',
    )!;
    act(() => toolWidth.focus());
    setInput(toolWidth, "0.8");
    act(() => toolWidth.blur());

    expect(outlineJob.starts).toBe(1);
    expect(outlineJob.lastIdentity).toBe(initialIdentity);
    expect(lastRenderScene?.primitives[0]?.stroke?.width).toBe(4);
    expect(generate).not.toHaveBeenCalled();

    clickButton(el, "Export Hidden-line SVG");
    expect(outlineJob.exportDerivations).toBe(0);
    expect(outlineJob.lastExportSnapshot?.identity).toEqual(initialIdentity);
  });

  it("recomputes opt-in Outline for every authored geometry axis", () => {
    autoFireOutlineComputed = false;
    const sketch = {
      ...(sketchWith("geometry-axes", schema) as unknown as Record<
        string,
        unknown
      >),
      time: { duration: 10, mode: "loop" },
      generateOutlineSource: vi.fn(() => ({
        space: { width: 1_000, height: 1_000 },
        primitives: [],
      })),
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
    const el = mount(<SketchControls sketch={sketch} />);

    clickButton(el, "Fill");
    act(() => lastOnOutlineComputed?.());
    expect(outlineJob.starts).toBe(1);

    const radius = paramInput(el, "radius");
    act(() => radius.focus());
    setInput(radius, "11");
    act(() => radius.blur());
    expect(outlineJob.starts).toBe(2);
    expect(outlineJob.lastIdentity?.params).toContainEqual({
      key: "radius",
      value: 11,
    });
    act(() => lastOnOutlineComputed?.());

    const priorSeed = outlineJob.lastIdentity?.seed;
    clickButton(el, "New seed");
    expect(outlineJob.starts).toBe(3);
    expect(outlineJob.lastIdentity?.seed).not.toBe(priorSeed);
    act(() => lastOnOutlineComputed?.());

    const tolerance = el.querySelector<HTMLInputElement>(
      "#sketch-tolerance",
    )!;
    act(() => tolerance.focus());
    setInput(tolerance, "1");
    act(() => tolerance.blur());
    expect(outlineJob.starts).toBe(4);
    expect(outlineJob.lastIdentity?.tolerance).toBe(1);
    act(() => lastOnOutlineComputed?.());

    const priorFrame = outlineJob.lastIdentity?.compositionFrame;
    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;
    act(() => width.focus());
    setInput(width, "300");
    act(() => width.blur());
    expect(outlineJob.starts).toBe(5);
    expect(outlineJob.lastIdentity?.compositionFrame).not.toEqual(priorFrame);
    act(() => lastOnOutlineComputed?.());

    clickButton(el, "Outline");
    fakeCurrentT = 2.5;
    clickButton(el, "Fill");
    expect(outlineJob.starts).toBe(6);
    expect(outlineJob.lastIdentity?.sampledT).toBe(2.5);
  });

  it("does not rederive Outline when the final Page rectangle option changes", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    const frameOption = el.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;

    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => lastOnOutlineComputed?.());
    const initialFrame = lastCompositionFrame;
    expect(frameOption.checked).toBe(true);

    act(() => frameOption.click());

    expect(lastProfile?.includeFrame).toBe(false);
    expect(lastCompositionFrame).toBe(initialFrame);
    expect(outlineJob.starts).toBe(1);
    expect(
      el.querySelector('[data-testid="canvas-seed"]')?.getAttribute(
        "data-include-frame",
      ),
    ).toBe("false");
    expect(toggle.textContent).toBe("Outline");
    expect(toggle.disabled).toBe(false);
  });

  it("restores includeFrame from a Preset without rederiving visible Outline", async () => {
    autoFireOutlineComputed = false;
    listPresets.mockResolvedValue(["without-frame"]);
    const profileWithoutFrame: PlotProfile = {
      ...HARNESS_FALLBACK_PLOT_PROFILE,
      includeFrame: false,
    };
    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    await flush();
    const seed = Number(
      el.querySelector<HTMLInputElement>("#sketch-seed")!.value,
    );
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "a",
      name: "without-frame",
      seed,
      params: { radius: 10 },
      locks: [],
      profile: profileWithoutFrame,
    });
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => lastOnOutlineComputed?.());

    reloadInUi(el, "without-frame");
    await flush();

    expect(lastProfile).toEqual(profileWithoutFrame);
    expect(el.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(
      false,
    );
    expect(outlineJob.starts).toBe(1);
    expect(toggle.textContent).toBe("Outline");
    expect(toggle.disabled).toBe(false);
  });

  it("marks Outline recomputing only when a committed paper edit changes drawable aspect", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", schema)} />);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;
    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => lastOnOutlineComputed?.());
    const initialFrame = lastCompositionFrame;
    const initialProfile = lastProfile;
    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;

    // A draft that cannot commit remains PaperSection-local: neither profile nor
    // geometry changes, and the expensive outline pass stays idle.
    setInput(width, "");
    expect(lastProfile).toBe(initialProfile);
    expect(lastCompositionFrame).toBe(initialFrame);
    expect(toggle.textContent).toBe("Outline");

    // Completing a valid width edit changes the drawable aspect. The one shared
    // frame is replaced and the busy affordance is raised before regeneration.
    setInput(width, "300");
    expect(lastProfile).toMatchObject({ width: 300, height: 200 });
    expect(lastCompositionFrame).not.toBe(initialFrame);
    expect(lastCompositionFrame).toEqual(
      resolvePlotCompositionFrame(lastProfile!),
    );
    expect(toggle.textContent).toBe("Outline");
    expect(toggle.disabled).toBe(false);
  });
});

describe("SketchControls — SVG export wiring", () => {
  // A Scene the mocked sketch.generate returns — its single Primitive lets the
  // test assert the downloaded SVG is the serialized vector of THAT Scene.
  const svgScene = {
    space: { width: 100, height: 100 },
    background: { color: "mintcream" },
    primitives: [
      {
        points: [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        closed: true,
        fill: { color: "tomato" },
      },
    ],
  };

  // A static sketch whose generate yields svgScene (overriding the no-op default).
  const svgStaticSketch = (id: string) => {
    const base = sketchWith(id, {
      radius: numberSpec({ default: 10 }),
    }) as unknown as Record<string, unknown>;
    return {
      ...base,
      generate: () => svgScene,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  // A time-driven variant so the export carries a `-t{t}` segment.
  const svgTimedSketch = (id: string) => {
    const base = svgStaticSketch(id) as unknown as Record<string, unknown>;
    return {
      ...base,
      time: { duration: 4, mode: "loop" },
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  /** Read the text of the Blob the export handed downloadBlob (jsdom-safe). */
  function blobText(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
  }

  it("downloads a vector SVG of the displayed Scene named for a STATIC sketch (no -t)", async () => {
    const el = mount(<SketchControls sketch={svgStaticSketch("circles")} />);
    const seed = (el.querySelector("#sketch-seed") as HTMLInputElement).value;

    clickButton(el, "Export SVG");

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlob.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/svg+xml");
    // The Blob is the serialized vector of the generated Scene.
    const svg = await blobText(blob);
    expect(svg).toMatch(/<svg\b[^>]*viewBox="0 0 100 100"/);
    expect(svg).toContain(
      '<rect x="0" y="0" width="100" height="100" fill="mintcream" />',
    );
    expect(svg).toMatch(/<path\b[^>]*fill="tomato"/);
    expect(exportSceneCapture.current).not.toBeNull();
    expect(plotterExportCapture.current).toBeNull();
    // Static sketch ⇒ no `-t` segment, `.svg` extension.
    expect(filename).toBe(`circles-seed${seed}.svg`);

    // The SVG embeds the reproduction envelope in a <metadata> element (#76),
    // round-tripping back to the displayed (seed, params, name-stem) — no t. The
    // envelope is now a v2 record (#266) carrying the active Plot Profile (#267);
    // this Sketch declares no default, so it is the Harness fallback.
    const meta = svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1];
    expect(meta).toBeDefined();
    expect(JSON.parse(meta!)).toEqual({
      version: 2,
      sketch: "circles",
      name: `circles-seed${seed}`,
      seed: Number(seed),
      params: { radius: 10 },
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });

    // The plotter export of the SAME fixture deliberately drops the Scene
    // background along with all other non-path preview/image chrome.
    clickButton(el, "Export Hidden-line SVG");
    const plotterSvg = await blobText(downloadBlob.mock.calls[1]![0]);
    expect(plotterSvg).not.toContain("mintcream");
    expect(plotterSvg).not.toMatch(/<rect\b/);
  });

  it("includes the captured -t{t} segment for a time-driven sketch", () => {
    fakeCurrentT = 2.5;
    const el = mount(<SketchControls sketch={svgTimedSketch("waves")} />);
    const seed = (el.querySelector("#sketch-seed") as HTMLInputElement).value;

    clickButton(el, "Export SVG");

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [, filename] = downloadBlob.mock.calls[0]!;
    expect(filename).toBe(`waves-seed${seed}-t2.5.svg`);
  });

  it.each([
    ["crop", { x: 25, y: 20, width: 50, height: 60 }],
    ["padding", { x: -25, y: -10, width: 150, height: 120 }],
    ["mixed crop and padding", { x: 25, y: -10, width: 100, height: 80 }],
  ])(
    "frames retained animated Fill for %s without generating or resampling",
    (_label, percentages) => {
      const generate = vi.fn(() => {
        throw new Error("framed SVG must not generate");
      });
      const sketch = {
        ...(sketchWith("framed-svg", {
          radius: numberSpec({ default: 10 }),
        }) as unknown as Record<string, unknown>),
        time: { duration: 4, mode: "loop" },
        generate,
      } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
      const el = mount(<SketchControls sketch={sketch} />);
      const composition = lastCompositionFrame!;
      const source: Scene = {
        space: composition,
        background: { color: "lavender" },
        primitives: [
          {
            points: [
              [-composition.width * 0.1, composition.height * 0.4],
              [composition.width * 1.1, composition.height * 0.4],
              [composition.width * 1.1, composition.height * 0.6],
              [-composition.width * 0.1, composition.height * 0.6],
            ],
            closed: true,
            fill: { color: "navy" },
          },
        ],
      };
      fakeDisplayedFillScene = {
        scene: source,
        sourceScene: source,
        displayedScene: source,
        t: 1.75,
        renderMode: "fill",
        tolerance: 0,
        includeFrame: true,
        inputRevision: 0,
        sourceInputRevision: 0,
      };
      const outline: Scene = { space: composition, primitives: [] };
      fakeDisplayedScene = {
        scene: outline,
        sourceScene: outline,
        displayedScene: outline,
        t: 1.75,
        renderMode: "outline",
        tolerance: 0,
        includeFrame: true,
        inputRevision: 0,
        sourceInputRevision: 0,
      };

      clickButton(el, "Crop");
      for (const [name, value] of Object.entries(percentages)) {
        setInput(
          el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!,
          String(value),
        );
      }
      clickButton(el, "Apply");
      expect(generate).not.toHaveBeenCalled();

      const frame: PageFrame = {
        x: (composition.width * percentages.x) / 100,
        y: (composition.height * percentages.y) / 100,
        width: (composition.width * percentages.width) / 100,
        height: (composition.height * percentages.height) / 100,
      };
      clickButton(el, "Export SVG");

      expect(generate).not.toHaveBeenCalled();
      expect(exportSceneCapture.current).toEqual(frameScene(source, frame));
      expect(exportSceneCapture.current).not.toBe(source);
      expect(downloadBlob.mock.calls[0]![1]).toMatch(/-t1\.75\.svg$/);
      const exported = exportSceneCapture.current as Scene;
      expect(exported.space).toEqual({
        width: frame.width,
        height: frame.height,
      });
      expect(exported.background).toEqual({ color: "lavender" });
      expect(outOfBoundsPoints(exported, frame.width, frame.height)).toEqual([]);
    },
  );

  // #237: a Scene whose single Primitive overflows the 100×100 canvas on BOTH
  // sides — a horizontal line from x=-50 to x=150 at y=50. The plain SVG export
  // must clip it to the canvas rectangle before serializing, so the exported
  // geometry is exactly [0,50]→[100,50] and nothing lies outside [0,0,100,100].
  const overflowScene = {
    space: { width: 100, height: 100 },
    primitives: [
      {
        points: [
          [-50, 50],
          [150, 50],
        ],
        stroke: { color: "black" },
      },
    ],
  };

  const overflowSketch = (id: string) => {
    const base = sketchWith(id, {
      radius: numberSpec({ default: 10 }),
    }) as unknown as Record<string, unknown>;
    return {
      ...base,
      generate: () => overflowScene,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  it("clips overflowing geometry to the canvas bounds before serializing (#237)", async () => {
    // Pin the mount-time `useState(() => newSeed(Math.random))` seed so the
    // repro-metadata envelope embedded in the SVG is deterministic (0.5 ->
    // 4503599627370495, which contains neither "150" nor "-50"). Without this
    // the random seed's digits collide with the overflow-coordinate substring
    // assertions below ~1.4% of runs (#240). `vi.restoreAllMocks()` in
    // afterEach undoes the stub.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const el = mount(<SketchControls sketch={overflowSketch("circles")} />);

    clickButton(el, "Export SVG");

    // The Scene handed `renderToSVG` is the CLIPPED Scene: no point outside the
    // canvas rectangle survives.
    const exported = exportSceneCapture.current;
    expect(exported).not.toBeNull();
    expect(outOfBoundsPoints(exported, 100, 100)).toEqual([]);
    // The clip was MEANINGFUL — the raw generated Scene did overflow the canvas —
    // and the export applied core's clip exactly.
    expect(outOfBoundsPoints(overflowScene, 100, 100)).not.toEqual([]);
    expect(exported).toEqual(
      clipSceneToBounds(
        overflowScene as unknown as Parameters<typeof clipSceneToBounds>[0],
      ),
    );

    // The overflowing coordinates never reach the serialized SVG string either.
    const [blob] = downloadBlob.mock.calls[0]!;
    const svg = await blobText(blob);
    expect(svg).not.toContain("-50");
    expect(svg).not.toContain("150");
  });

  it("preserves the exact unframed cold-generation and clipping path", () => {
    const retained: Scene = {
      space: { width: 100, height: 100 },
      primitives: [{ points: [[90, 90]], fill: { color: "retained" } }],
    };
    fakeDisplayedScene = {
      scene: retained,
      sourceScene: retained,
      displayedScene: retained,
      t: 3,
      renderMode: "fill",
      tolerance: 0,
      includeFrame: true,
      inputRevision: 0,
      sourceInputRevision: 0,
    };
    fakeCurrentT = 2.5;
    const generate = vi.fn(() => overflowScene as Scene);
    const sketch = {
      ...(sketchWith("unframed-regression", {
        radius: numberSpec({ default: 10 }),
      }) as unknown as Record<string, unknown>),
      time: { duration: 4, mode: "loop" },
      generate,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
    const el = mount(<SketchControls sketch={sketch} />);
    const seed = Number(
      el.querySelector<HTMLInputElement>("#sketch-seed")!.value,
    );

    clickButton(el, "Export SVG");

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(
      { radius: 10 },
      seed,
      2.5,
      lastCompositionFrame,
    );
    expect(exportSceneCapture.current).toEqual(
      clipSceneToBounds(overflowScene as Scene),
    );
    expect(exportSceneCapture.current).not.toEqual(retained);
    expect(downloadBlob.mock.calls[0]![1]).toBe(
      `unframed-regression-seed${seed}-t2.5.svg`,
    );
  });
});

function finalizedPlotterScene(base: Scene): Scene {
  const snapshot = outlineJob.lastExportSnapshot;
  if (snapshot === null) throw new Error("expected hidden-line export snapshot");
  const policy: OutlineFinalizationStrokePolicy =
    snapshot.identity.sourceKind === "legacy-scene"
      ? {
          kind: "legacy-scene",
          target: {
            toolWidthMillimeters: snapshot.profile.toolWidthMillimeters,
            millimetersPerSceneUnit: computePlotMapping(
              snapshot.pageFrame === null
                ? snapshot.identity.compositionFrame
                : {
                    width: snapshot.pageFrame.width,
                    height: snapshot.pageFrame.height,
                  },
              snapshot.profile,
            ).scale,
          },
        }
      : {
          kind: "physical-tool",
          target: snapshot.identity.outlineTarget,
        };
  return clipSceneToBounds(
    finalizeOutlineScene(
      base,
      snapshot.pageFrame,
      snapshot.profile.includeFrame,
      policy,
    ),
  );
}

describe("SketchControls — Hidden-line SVG export wiring", () => {
  // A Scene with TWO overlapping filled squares in painter's order: the nearer
  // (second) square covers the far-left region of the farther (first) one, so
  // the Hidden-line pass MUST clip part of the farther square's outline away —
  // the surviving stroke geometry is strictly less than the raw outline, which
  // proves the export ran the pass rather than serializing the raw Scene.
  const hlScene = {
    space: { width: 100, height: 100 },
    primitives: [
      {
        points: [
          [0, 0],
          [40, 0],
          [40, 40],
          [0, 40],
        ],
        closed: true,
        fill: { color: "tomato" },
      },
      {
        points: [
          [20, 0],
          [60, 0],
          [60, 40],
          [20, 40],
        ],
        closed: true,
        fill: { color: "steelblue" },
      },
    ],
  };

  const hlStaticSketch = (id: string) => {
    const base = sketchWith(id, {
      radius: numberSpec({ default: 10 }),
    }) as unknown as Record<string, unknown>;
    return {
      ...base,
      generate: () => hlScene,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  const hlTimedSketch = (id: string) => {
    const base = hlStaticSketch(id) as unknown as Record<string, unknown>;
    return {
      ...base,
      time: { duration: 4, mode: "loop" },
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  it("keeps specialized preview and cached-export identities Scene-free", () => {
    autoFireOutlineComputed = false;
    const generateOutlineSource = vi.fn(() => hlScene);
    const sketch = {
      ...(hlStaticSketch("specialized") as unknown as Record<string, unknown>),
      generateOutlineSource,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
    const el = mount(<SketchControls sketch={sketch} />);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    )!;

    expect(outlineJob.starts).toBe(0);
    expect(generateOutlineSource).not.toHaveBeenCalled();
    act(() => toggle.click());
    expect(outlineJob.lastIdentity?.sourceKind).toBe("specialized-sketch");
    expect(outlineJob.lastIdentity).not.toHaveProperty("sourceScene");
    expect(generateOutlineSource).not.toHaveBeenCalled();
    act(() => lastOnOutlineComputed?.());

    fakeDisplayedScene = {
      scene: outlineJob.lastCompletedScene!,
      t: 0,
      renderMode: "outline",
      tolerance: 0,
      includeFrame: true,
    };
    clickButton(el, "Export Hidden-line SVG");

    expect(outlineJob.lastExportSnapshot?.identity.sourceKind).toBe(
      "specialized-sketch",
    );
    expect(outlineJob.lastExportSnapshot?.identity).not.toHaveProperty(
      "sourceScene",
    );
    expect(outlineJob.lastExportSnapshot?.reusableOutline).toBeDefined();
    expect(outlineJob.exportDerivations).toBe(0);
    expect(generateOutlineSource).not.toHaveBeenCalled();
  });

  function blobText(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
  }

  it("downloads a stroke-only hidden-line SVG named -hidden-line for a STATIC sketch", async () => {
    const el = mount(<SketchControls sketch={hlStaticSketch("circles")} />);
    const seed = (el.querySelector("#sketch-seed") as HTMLInputElement).value;

    clickButton(el, "Export Hidden-line SVG");

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlob.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/svg+xml");

    const svg = await blobText(blob);
    expect(svg).toMatch(
      /<svg\b[^>]*width="200mm" height="200mm" viewBox="0 0 200 200"/,
    );
    // The pass ran: its output is STROKE-ONLY (fill-free primitives), so the raw
    // fill colors never reach the serialized SVG and every path is stroked.
    expect(svg).not.toContain('fill="tomato"');
    expect(svg).not.toContain('fill="steelblue"');
    expect(svg).toMatch(/<path\b[^>]*stroke="black"/);

    // Static sketch ⇒ the variant segment sits right after the seed, no -t.
    expect(filename).toBe(`circles-seed${seed}-hidden-line.svg`);

    // The reproduction envelope still round-trips to the displayed frame — now a
    // v2 record (#266) carrying the active Plot Profile (#267), the Harness
    // fallback for this default-less Sketch.
    const meta = svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1];
    expect(meta).toBeDefined();
    expect(JSON.parse(meta!)).toMatchObject({
      version: 2,
      sketch: "circles",
      name: `circles-seed${seed}`,
      seed: Number(seed),
      params: { radius: 10 },
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
  });

  it("exports the cold Outline seam onto a non-square asymmetric physical sheet as paths only", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const profile: PlotProfile = {
      width: 250,
      height: 180,
      insets: { top: 15, right: 45, bottom: 15, left: 25 },
      includeFrame: false,
      toolWidthMillimeters: 0.3,
    };
    const source = {
      space: { width: 120, height: 100 },
      background: { color: "papayawhip" },
      primitives: [
        {
          points: [
            [0, 0],
            [120, 0],
            [120, 100],
            [0, 100],
          ],
          closed: true,
          fill: { color: "tomato" },
        },
      ],
    } as unknown as DisplayedSceneSnapshot["scene"];
    const generate = vi.fn(() => source);
    const sketch = {
      ...(hlStaticSketch("physical") as unknown as Record<string, unknown>),
      defaultOutputProfile: profile,
      generate,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];

    const el = mount(<SketchControls sketch={sketch} />);
    const seed = Number(
      (el.querySelector("#sketch-seed") as HTMLInputElement).value,
    );
    clickButton(el, "Export Hidden-line SVG");

    expect(generate).toHaveBeenCalledTimes(1);
    expect(plotterExportCapture.current).toEqual({
      scene: clipSceneToBounds(outlineScene(source)),
      profile,
      metadata: expect.any(String),
      options: { includePaperMargins: true },
    });

    const svg = await blobText(downloadBlob.mock.calls[0]![0]);
    expect(svg).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" width="250mm" height="180mm" viewBox="0 0 250 180" data-paper-extent="paper">',
    );
    // 120×100 Scene → 180×150 mm drawable: 1.5×, placed at asymmetric
    // left/right insets 25/45 and top/bottom insets 15/15.
    expect(svg).toContain('d="M25 15 L205 15 L205 165 L25 165 L25 15"');
    expect(svg).toContain('stroke-width="1.5"');
    expect(svg.match(/<path\b/g)).toHaveLength(1);
    expect(svg).not.toMatch(/<(?:rect|circle|ellipse|polygon|polyline|image)\b/);
    expect(svg).not.toContain("papayawhip");
    expect(svg).not.toContain("tomato");

    const encoded = svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1];
    expect(encoded).toBeDefined();
    expect(JSON.parse(encoded!)).toEqual({
      version: 2,
      sketch: "physical",
      name: `physical-seed${seed}`,
      seed,
      params: { radius: 10 },
      locks: [],
      profile,
    });
  });

  it("forwards only the current export preference as the serializer fourth argument", () => {
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const generate = vi.fn(() => source);
    const el = mount(
      <SketchControls sketch={{ ...hlStaticSketch("circles"), generate }} />,
    );

    clickButton(el, "Export Hidden-line SVG");
    const included = plotterExportCapture.current!;
    const metadataBefore = included.metadata;
    const sceneBefore = included.scene;
    const profileBefore = structuredClone(included.profile);
    expect(included.options).toEqual({ includePaperMargins: true });

    act(() => paperMarginsCheckbox(el).click());
    expect(generate).toHaveBeenCalledTimes(1);
    clickButton(el, "Export Hidden-line SVG");

    expect(generate).toHaveBeenCalledTimes(2);
    expect(plotterExportCapture.current?.options).toEqual({
      includePaperMargins: false,
    });
    expect(plotterExportCapture.current?.scene).toEqual(sceneBefore);
    expect(plotterExportCapture.current?.profile).toEqual(profileBefore);
    expect(plotterExportCapture.current?.metadata).toBe(metadataBefore);
  });

  it("atomically scales the physical sheet via Preset reload while reusing the cached Outline Scene", async () => {
    listPresets.mockResolvedValue(["double"]);
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const processed = outlineScene(source, 0);
    const processedBefore = structuredClone(processed);
    const generate = vi.fn(() => source);
    const el = mount(
      <SketchControls sketch={{ ...hlStaticSketch("circles"), generate }} />,
    );
    await flush();
    const seed = Number(
      (el.querySelector("#sketch-seed") as HTMLInputElement).value,
    );

    fakeFillCaptureScene = source;
    clickButton(el, "Fill");
    generate.mockClear();
    fakeDisplayedScene = {
      scene: outlineJob.lastCompletedScene!,
      t: 0,
      renderMode: "outline",
      tolerance: 0,
      includeFrame: true,
    };
    clickButton(el, "Export Hidden-line SVG");
    const firstScene = plotterExportCapture.current?.scene;
    const firstSvg = await blobText(downloadBlob.mock.calls[0]![0]);

    // Reload through the real v2 Preset path so width, height, and every inset
    // commit atomically. Doubling all five magnitudes preserves drawable aspect.
    const doubledProfile: PlotProfile = {
      width: 400,
      height: 400,
      insets: { top: 20, right: 20, bottom: 20, left: 20 },
      includeFrame: true,
      toolWidthMillimeters: 0.3,
    };
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "circles",
      name: "double",
      seed,
      params: { radius: 10 },
      locks: [],
      profile: doubledProfile,
    });
    const picker = el.querySelector(
      'select[aria-label="saved presets"]',
    ) as HTMLSelectElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(picker, "double");
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    clickButton(el, "Reload");
    await flush();

    clickButton(el, "Export Hidden-line SVG");
    const secondScene = plotterExportCapture.current?.scene;
    const secondSvg = await blobText(downloadBlob.mock.calls[1]![0]);

    expect(generate).not.toHaveBeenCalled();
    expect(fakeDisplayedScene?.scene).toEqual(processed);
    expect(processed).toEqual(processedBefore);
    const firstFinalized = firstScene as Scene;
    const secondFinalized = secondScene as Scene;
    expect(firstFinalized.primitives.slice(0, -1)).toEqual(
      secondFinalized.primitives.slice(0, -1),
    );
    expect(firstFinalized.primitives.at(-1)?.points).toEqual(
      secondFinalized.primitives.at(-1)?.points,
    );
    // The worker retargets the optional Page outline in Scene units for each
    // profile; physical serialization keeps both at the configured 0.3 mm.
    expect(firstFinalized.primitives.at(-1)?.stroke?.width).not.toBe(
      secondFinalized.primitives.at(-1)?.stroke?.width,
    );
    expect(plotterExportCapture.current?.profile).toEqual(doubledProfile);
    expect(firstSvg).toContain(
      'width="200mm" height="200mm" viewBox="0 0 200 200"',
    );
    expect(secondSvg).toContain(
      'width="400mm" height="400mm" viewBox="0 0 400 400"',
    );
    expect(firstSvg).toContain('d="M10 10 L46 10"');
    expect(secondSvg).toContain('d="M20 20 L92 20"');
    expect(firstSvg).toContain('stroke-width="1.8"');
    expect(secondSvg).toContain('stroke-width="3.6"');
    expect(secondSvg).not.toBe(firstSvg);
  });

  it("carries the -t{t} segment before -hidden-line for a time-driven sketch", () => {
    fakeCurrentT = 2.5;
    const el = mount(<SketchControls sketch={hlTimedSketch("waves")} />);
    const seed = (el.querySelector("#sketch-seed") as HTMLInputElement).value;

    clickButton(el, "Export Hidden-line SVG");

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [, filename] = downloadBlob.mock.calls[0]!;
    expect(filename).toBe(`waves-seed${seed}-t2.5-hidden-line.svg`);
  });

  it("reuses the exact displayed outline Scene without generating or reprocessing", () => {
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const processed = outlineScene(source, 0);
    const base = hlStaticSketch("circles");
    const generate = vi.fn(() => source);
    const sketch = { ...base, generate };
    const el = mount(<SketchControls sketch={sketch} />);

    fakeFillCaptureScene = source;
    clickButton(el, "Fill");
    generate.mockClear();
    fakeDisplayedScene = {
      scene: outlineJob.lastCompletedScene!,
      t: 0,
      renderMode: "outline",
      tolerance: 0,
      includeFrame: true,
    };
    clickButton(el, "Export Hidden-line SVG");

    expect(generate).not.toHaveBeenCalled();
    expect(plotterExportCapture.current?.scene).toEqual(
      finalizedPlotterScene(processed),
    );
  });

  it("reuses the exact displayed fill Scene and only runs hidden-line processing", () => {
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const base = hlStaticSketch("circles");
    const generate = vi.fn(() => source);
    const sketch = { ...base, generate };
    const el = mount(<SketchControls sketch={sketch} />);
    fakeDisplayedScene = {
      scene: source,
      t: 0,
      renderMode: "fill",
      tolerance: 0,
      includeFrame: true,
    };

    clickButton(el, "Export Hidden-line SVG");

    expect(generate).not.toHaveBeenCalled();
    expect(plotterExportCapture.current?.scene).toEqual(
      finalizedPlotterScene(outlineScene(source, 0)),
    );
  });

  it("reuses a Fill-mode export cache, still finalizes, and derives after a static input mismatch", () => {
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const el = mount(<SketchControls sketch={hlStaticSketch("fill-cache")} />);
    fakeDisplayedScene = {
      scene: source,
      t: 0,
      renderMode: "fill",
      tolerance: 0,
      includeFrame: true,
    };

    clickButton(el, "Export Hidden-line SVG");
    expect(outlineJob.exportDerivations).toBe(1);
    expect(outlineJob.exportFinalizations).toBe(1);

    clickButton(el, "Export Hidden-line SVG");
    expect(outlineJob.exportDerivations).toBe(1);
    expect(outlineJob.exportFinalizations).toBe(2);
    expect(outlineJob.lastExportSnapshot?.reusableOutline).toBeDefined();
    expect(outlineJob.lastExportSnapshot?.identity.sourceKind).toBe(
      "legacy-scene",
    );
    if (outlineJob.lastExportSnapshot?.identity.sourceKind !== "legacy-scene") {
      throw new Error("expected legacy Scene identity");
    }
    expect(outlineJob.lastExportSnapshot.identity.sourceScene).toEqual(source);

    setInput(paramInput(el, "radius"), "14");
    clickButton(el, "Export Hidden-line SVG");
    expect(outlineJob.exportDerivations).toBe(2);
    expect(outlineJob.exportFinalizations).toBe(3);
    expect(outlineJob.lastExportSnapshot?.reusableOutline).toBeUndefined();
  });

  it("reuses an animated Fill frame only at the identical sampled time", () => {
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const el = mount(<SketchControls sketch={hlTimedSketch("timed-cache")} />);
    fakeDisplayedScene = {
      scene: source,
      t: 2.5,
      renderMode: "fill",
      tolerance: 0,
      includeFrame: true,
    };

    clickButton(el, "Export Hidden-line SVG");
    clickButton(el, "Export Hidden-line SVG");
    expect(outlineJob.exportDerivations).toBe(1);
    expect(outlineJob.exportFinalizations).toBe(2);

    fakeDisplayedScene = { ...fakeDisplayedScene, t: 2.75 };
    clickButton(el, "Export Hidden-line SVG");
    expect(outlineJob.exportDerivations).toBe(2);
    expect(outlineJob.exportFinalizations).toBe(3);
  });

  it("falls back to exact cold generation when no displayed Scene is cached", () => {
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const base = hlStaticSketch("circles");
    const generate = vi.fn(() => source);
    const el = mount(<SketchControls sketch={{ ...base, generate }} />);

    clickButton(el, "Export Hidden-line SVG");

    expect(generate).toHaveBeenCalledTimes(1);
    expect(plotterExportCapture.current?.scene).toEqual(
      finalizedPlotterScene(outlineScene(source, 0)),
    );
  });

  it("uses one atomic displayed record without comparing a separately read time", () => {
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    const base = hlStaticSketch("circles");
    const generate = vi.fn(() => source);
    const sketch = { ...base, generate };
    const el = mount(<SketchControls sketch={sketch} />);
    fakeDisplayedScene = {
      scene: { space: source.space, primitives: [] },
      t: 99,
      renderMode: "fill",
      tolerance: 0,
      includeFrame: true,
    };

    clickButton(el, "Export Hidden-line SVG");

    expect(generate).not.toHaveBeenCalled();
    expect(plotterExportCapture.current?.scene).toEqual(
      finalizedPlotterScene(outlineScene(fakeDisplayedScene.scene, 0)),
    );
  });

  // AC (#220): the outline-mode canvas input and the hidden-line SVG export input
  // must be the IDENTICAL processed Scene for the same (params, seed, t). Both
  // call sites now delegate to the ONE shared `outlineScene` seam, so this holds
  // by construction. jsdom's `canvas.getContext('2d')` is null, so LiveCanvas's
  // `drawFrame` early-returns before it would feed the canvas — the preview's
  // Scene isn't directly observable through a live render. The faithful check is
  // therefore: drive the REAL `exportHiddenLineSvg` and assert the Scene it hands
  // `renderPlotterSVG` (captured above) deep-equals
  // `outlineScene(generatedScene)` —
  // the exact processing seam LiveCanvas's outline branch evaluates — for
  // one fixed frame. Locking the export path to the shared seam is what removes
  // the drift risk between preview and export.
  it("export input Scene equals the shared outlineScene seam the preview consumes (#220)", () => {
    const sketch = hlStaticSketch("circles");
    const el = mount(<SketchControls sketch={sketch} />);
    const seed = Number(
      (el.querySelector("#sketch-seed") as HTMLInputElement).value,
    );

    clickButton(el, "Export Hidden-line SVG");

    // The export handed `renderPlotterSVG` a Scene.
    expect(plotterExportCapture.current).not.toBeNull();
    // A static sketch's export passes `t ?? 0` (t is undefined ⇒ 0); params are
    // the schema defaults ({ radius: 10 }); seed is the displayed seed. The
    // outline preview evaluates this SAME expression, so the two inputs match.
    expect(plotterExportCapture.current?.scene).toEqual(
      finalizedPlotterScene(outlineScene(
        sketch.generate(
          { radius: 10 },
          seed,
          0,
          resolvePlotCompositionFrame(HARNESS_FALLBACK_PLOT_PROFILE),
        ),
        0,
      )),
    );
  });

  // AC3 (#232): the studio tolerance knob drives the hidden-line EXPORT's final
  // simplification. A scene whose surviving stroke has exactly-collinear interior
  // vertices lets a positive tolerance visibly drop them. Driving the knob then
  // re-exporting must (a) hand `renderPlotterSVG` the SAME seam expression at
  // the new tolerance (preview == export by construction) and (b) actually
  // reduce the exported vertex count versus tolerance 0.
  const redundantScene = {
    space: { width: 100, height: 100 },
    // A single filled Primitive, no occluder ⇒ its whole ring survives as one
    // stroke. [30,0] and [30,40] are collinear on the top/bottom edges, so a
    // positive Douglas–Peucker tolerance removes them.
    primitives: [
      {
        points: [
          [0, 0],
          [30, 0],
          [60, 0],
          [60, 40],
          [30, 40],
          [0, 40],
        ],
        closed: true,
        fill: { color: "tomato" },
      },
    ],
  };

  const redundantSketch = (id: string) => {
    const base = sketchWith(id, {
      radius: numberSpec({ default: 10 }),
    }) as unknown as Record<string, unknown>;
    return {
      ...base,
      generate: () => redundantScene,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  const totalVerts = (scene: unknown): number =>
    (scene as { primitives: { points: unknown[] }[] }).primitives.reduce(
      (sum, p) => sum + p.points.length,
      0,
    );

  it("limits the simplification tolerance controls to the useful 0–2 range", () => {
    const el = mount(<SketchControls sketch={redundantSketch("circles")} />);
    const numberInput = el.querySelector(
      "#sketch-tolerance",
    ) as HTMLInputElement;
    const sliderInput = el.querySelector(
      'input[type="range"][aria-label="Simplification tolerance"]',
    ) as HTMLInputElement;

    expect(numberInput.min).toBe("0");
    expect(numberInput.max).toBe("2");
    expect(sliderInput.min).toBe("0");
    expect(sliderInput.max).toBe("2");
  });

  it("the tolerance knob drives the hidden-line export's simplification (#232, AC3)", () => {
    const sketch = redundantSketch("circles");
    const el = mount(<SketchControls sketch={sketch} />);
    const seed = Number(
      (el.querySelector("#sketch-seed") as HTMLInputElement).value,
    );

    // Baseline export at the default tolerance 0 — no simplification.
    clickButton(el, "Export Hidden-line SVG");
    const atZero = plotterExportCapture.current?.scene;
    expect(atZero).toEqual(
      finalizedPlotterScene(outlineScene(
        sketch.generate(
          { radius: 10 },
          seed,
          0,
          resolvePlotCompositionFrame(HARNESS_FALLBACK_PLOT_PROFILE),
        ),
        0,
      )),
    );
    const vertsAtZero = totalVerts(atZero);

    // Drive the studio knob, then re-export.
    setInput(el.querySelector("#sketch-tolerance") as HTMLInputElement, "1");
    clickButton(el, "Export Hidden-line SVG");
    const atOne = plotterExportCapture.current?.scene;

    // preview == export: the export is the SAME seam expression at tolerance 1
    // (the value LiveCanvas's outline preview also receives — asserted below).
    expect(atOne).toEqual(
      finalizedPlotterScene(outlineScene(
        sketch.generate(
          { radius: 10 },
          seed,
          0,
          resolvePlotCompositionFrame(HARNESS_FALLBACK_PLOT_PROFILE),
        ),
        1,
      )),
    );
    // ...and simplification actually reduced the exported vertex count.
    expect(totalVerts(atOne)).toBeLessThan(vertsAtZero);
  });

  it("the tolerance knob value is the one fed to the outline preview (#232, AC3)", () => {
    const el = mount(<SketchControls sketch={redundantSketch("circles")} />);

    // The mocked LiveCanvas surfaces the tolerance prop it was fed. Default 0.
    const canvas = () =>
      el.querySelector('[data-testid="canvas-seed"]') as HTMLElement;
    expect(canvas().dataset.tolerance).toBe("0");

    // Driving the knob updates the SAME value the preview consumes — the single
    // state that also drives the export, so the two cannot diverge.
    setInput(el.querySelector("#sketch-tolerance") as HTMLInputElement, "1");
    expect(canvas().dataset.tolerance).toBe("1");
  });

  // #237: a filled square straddling the bottom-right corner (x,y ∈ [50,150]),
  // so half of it lies OUTSIDE the 100×100 canvas. The hidden-line export must
  // clip AFTER the hidden-line pass and BEFORE serialization, so the exported
  // stroke geometry stays inside [0,0,100,100].
  const overflowHlScene = {
    space: { width: 100, height: 100 },
    primitives: [
      {
        points: [
          [50, 50],
          [150, 50],
          [150, 150],
          [50, 150],
        ],
        closed: true,
        fill: { color: "tomato" },
      },
    ],
  };

  const overflowHlSketch = (id: string) => {
    const base = sketchWith(id, {
      radius: numberSpec({ default: 10 }),
    }) as unknown as Record<string, unknown>;
    return {
      ...base,
      generate: () => overflowHlScene,
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  it("clips overflowing geometry before physical mapping and keeps it inside the drawable rectangle (#237)", async () => {
    const sketch = overflowHlSketch("circles");
    const el = mount(<SketchControls sketch={sketch} />);
    const seed = Number(
      (el.querySelector("#sketch-seed") as HTMLInputElement).value,
    );

    // The un-clipped seam (generate → hidden-line pass) still overflows the
    // canvas — so the clip that follows is doing real work.
    const seam = outlineScene(
      sketch.generate(
        { radius: 10 },
        seed,
        0,
        resolvePlotCompositionFrame(HARNESS_FALLBACK_PLOT_PROFILE),
      ),
      0,
    );
    expect(outOfBoundsPoints(seam, 100, 100)).not.toEqual([]);

    clickButton(el, "Export Hidden-line SVG");

    // The Scene handed `renderPlotterSVG` is the seam CLIPPED to bounds: nothing
    // lies outside the canvas, and it is exactly `clipSceneToBounds` of the seam
    // (clip slotted after the hidden-line pass, before serialization).
    const exported = plotterExportCapture.current?.scene;
    expect(exported).not.toBeNull();
    expect(outOfBoundsPoints(exported, 100, 100)).toEqual([]);
    expect(exported).toEqual(finalizedPlotterScene(seam));

    const svg = await blobText(downloadBlob.mock.calls[0]![0]);
    const coordinates = [
      ...svg.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g),
    ].map(([, x, y]) => [Number(x), Number(y)] as const);
    expect(coordinates.length).toBeGreaterThan(0);
    // Harness fallback: 200 mm square with 10 mm on every edge.
    expect(
      coordinates.every(
        ([x, y]) => x >= 10 && x <= 190 && y >= 10 && y <= 190,
      ),
    ).toBe(true);
  });

  // #237 AC3 (concrete): the real Leaf Field sketch (core) run through the full
  // hidden-line export path — generate → hiddenLinePass → clipSceneToBounds —
  // must leave NO output path point outside its own canvas rectangle. This is
  // the acceptance check against a production sketch (not a hand-built Scene).
  it("Leaf Field hidden-line export has no point outside the canvas (#237, AC3)", () => {
    const params = defaultParams(leafField.schema);
    const seed = 12345 as Seed;
    // The hidden-line pass is heavy, so run it ONCE and reuse it for both the
    // pre-clip overflow check and the clipped output.
    const preClip = hiddenLinePass(
      leafField.generate(params, seed, 0, DEFAULT_COMPOSITION_FRAME),
      { tolerance: 0 },
    );
    const exported = clipSceneToBounds(preClip);
    const { width, height } = exported.space;
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    // The sketch genuinely overflows before clipping (the pre-clip seam has
    // out-of-bounds points), so the emptiness below is the clip's doing.
    expect(outOfBoundsPoints(preClip, width, height)).not.toEqual([]);
    // ...and after the clip, every path point lies within [0,0,width,height].
    expect(outOfBoundsPoints(exported, width, height)).toEqual([]);
  });
  it("freezes click-time inputs and downloads exactly once only after success", async () => {
    outlineJob.exportMode = "pending";
    const el = mount(<SketchControls sketch={hlStaticSketch("atomic")} />);
    const seedAtClick = Number(paramInput(el, "radius").value) === 10
      ? Number((el.querySelector("#sketch-seed") as HTMLInputElement).value)
      : -1;

    clickButton(el, "Export Hidden-line SVG");
    const pending = outlineJob.pendingExport!;
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(pending.snapshot.identity.params).toContainEqual({ key: "radius", value: 10 });

    clickButton(el, "New seed");
    pending.succeed();
    pending.succeed();
    await flush();

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(JSON.parse(pending.snapshot.metadata)).toMatchObject({
      seed: seedAtClick,
      params: { radius: 10 },
    });
  });

  it("downloads nothing for failure or a completion made stale by unmount", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    outlineJob.exportMode = "failure";
    let el = mount(<SketchControls sketch={hlStaticSketch("failure")} />);
    clickButton(el, "Export Hidden-line SVG");
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(el.querySelector('[role="status"]')).toBeNull();
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(
      "Export failed: test failure",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "Hidden-line export failed",
      "test failure",
    );
    expect(
      [...el.querySelectorAll("button")].find(
        (button) => button.textContent === "Export Hidden-line SVG",
      )?.disabled,
    ).toBe(false);

    outlineJob.exportMode = "pending";
    act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
    el = mount(<SketchControls sketch={hlStaticSketch("stale")} />);
    clickButton(el, "Export Hidden-line SVG");
    const pending = outlineJob.pendingExport!;
    act(() => root!.unmount());
    root = null;
    pending.succeed();
    await flush();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("settles a transactional edit during export before launching one latest Outline", async () => {
    const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
    fakeFillCaptureScene = source;
    const el = mount(<SketchControls sketch={hlStaticSketch("deferred")} />);
    clickButton(el, "Fill");
    const startsBeforeExport = outlineJob.starts;
    fakeDisplayedScene = {
      scene: outlineScene(source, 0),
      t: 0,
      renderMode: "outline",
      tolerance: 0,
      includeFrame: true,
    };
    outlineJob.exportMode = "pending";
    clickButton(el, "Export Hidden-line SVG");

    const radius = paramInput(el, "radius");
    act(() => radius.focus());
    setInput(radius, "14");
    act(() =>
      radius.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(outlineJob.starts).toBe(startsBeforeExport);

    await act(async () => {
      outlineJob.pendingExport!.succeed();
      await Promise.resolve();
    });
    expect(outlineJob.starts).toBe(startsBeforeExport + 1);
    expect(outlineJob.lastIdentity?.params).toContainEqual({
      key: "radius",
      value: 14,
    });
  });

  it.each(["success", "cancel", "failure"] as const)(
    "keeps a completed Outline displayed after export %s when no edit occurs",
    async (terminal) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const source = hlScene as unknown as DisplayedSceneSnapshot["scene"];
      fakeFillCaptureScene = source;
      const el = mount(
        <SketchControls sketch={hlStaticSketch(`settle-${terminal}`)} />,
      );
      clickButton(el, "Fill");
      expect(canvasRenderMode(el)).toBe("outline");
      const previewStarts = outlineJob.starts;
      fakeDisplayedScene = {
        scene: outlineJob.lastCompletedScene!,
        t: 0,
        renderMode: "outline",
        tolerance: 0,
        includeFrame: true,
      };
      outlineJob.exportMode = "pending";

      clickButton(el, "Export Hidden-line SVG");
      expect(canvasRenderMode(el)).toBe("outline");
      expect(outlineJob.starts).toBe(previewStarts);

      if (terminal === "success") outlineJob.pendingExport!.succeed();
      else if (terminal === "failure") outlineJob.pendingExport!.fail();
      else clickButton(el, "Cancel export");
      await flush();

      expect(canvasRenderMode(el)).toBe("outline");
      expect(outlineJob.starts).toBe(previewStarts);
      expect(outlineJob.pendingExport).toBeNull();
      consoleError.mockRestore();
    },
  );

  it("keeps export status quiet through 749ms, then shows derivation progress and ETA", () => {
    outlineJob.exportMode = "pending";
    vi.useFakeTimers();
    try {
      const el = mount(<SketchControls sketch={hlStaticSketch("progress")} />);
      clickButton(el, "Export Hidden-line SVG");
      const pending = outlineJob.pendingExport!;
      act(() =>
        pending.reportProgress(1, 4, { kind: "estimating", revision: 1 }),
      );

      expect(el.textContent).toContain("Cancel export");
      expect(el.querySelector('[role="status"]')).toBeNull();
      expect(el.querySelector('progress[aria-label="Hidden-line export progress"]')).toBeNull();
      act(() => vi.advanceTimersByTime(749));
      expect(el.textContent).not.toContain("25%");

      act(() => vi.advanceTimersByTime(1));
      const progress = el.querySelector<HTMLProgressElement>(
        'progress[aria-label="Hidden-line export progress"]',
      )!;
      expect(progress.value).toBe(1);
      expect(progress.max).toBe(4);
      expect(el.textContent).toContain("25%");
      expect(el.textContent).toContain("Estimating time remaining…");
      expect(el.querySelectorAll('[role="status"][aria-live="polite"]')).toHaveLength(1);
      expect(progress.closest("[aria-live]")).toBeNull();

      act(() =>
        pending.reportProgress(3, 4, {
          kind: "remaining",
          revision: 2,
          remainingMs: 4_200,
        }),
      );
      expect(
        el.querySelector<HTMLProgressElement>(
          'progress[aria-label="Hidden-line export progress"]',
        )?.value,
      ).toBe(3);
      expect(el.textContent).toContain("75%");
      expect(el.textContent).toContain("5 seconds remaining");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows exact non-percentaged finalizing status, including immediate Outline reuse", () => {
    outlineJob.exportMode = "pending";
    vi.useFakeTimers();
    try {
      const el = mount(<SketchControls sketch={hlStaticSketch("finalizing")} />);
      clickButton(el, "Export Hidden-line SVG");
      const pending = outlineJob.pendingExport!;
      act(() => {
        pending.reportProgress(4, 4, {
          kind: "remaining",
          revision: 2,
          remainingMs: 0,
        });
        pending.finalize();
      });
      expect(el.textContent).not.toContain("Preparing SVG…");

      act(() => vi.advanceTimersByTime(750));
      expect(el.textContent).toContain("Preparing SVG…");
      expect(el.textContent).not.toContain("100%");
      expect(
        el.querySelector('progress[aria-label="Hidden-line export progress"]'),
      ).toBeNull();
      expect(el.textContent).toContain("Cancel export");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels silently during derivation and finalizing, then gives a later job a fresh timer", async () => {
    outlineJob.exportMode = "pending";
    vi.useFakeTimers();
    try {
      const el = mount(<SketchControls sketch={hlStaticSketch("cancel")} />);
      clickButton(el, "Export Hidden-line SVG");
      act(() =>
        outlineJob.pendingExport!.reportProgress(1, 2, {
          kind: "estimating",
          revision: 1,
        }),
      );
      act(() => vi.advanceTimersByTime(749));
      clickButton(el, "Cancel export");
      await flush();
      expect(downloadBlob).not.toHaveBeenCalled();
      expect(el.textContent).not.toContain("Export failed");
      expect(el.textContent).not.toContain("Cancel export");

      clickButton(el, "Export Hidden-line SVG");
      const finalizing = outlineJob.pendingExport!;
      act(() => finalizing.finalize());
      act(() => vi.advanceTimersByTime(1));
      expect(el.textContent).not.toContain("Preparing SVG…");
      act(() => vi.advanceTimersByTime(749));
      expect(el.textContent).toContain("Preparing SVG…");
      clickButton(el, "Cancel export");
      await flush();

      expect(downloadBlob).not.toHaveBeenCalled();
      expect(el.querySelector('[role="alert"]')).toBeNull();
      expect(el.textContent).not.toContain("Preparing SVG…");
      expect(
        [...el.querySelectorAll("button")].find(
          (button) => button.textContent === "Export Hidden-line SVG",
        )?.disabled,
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("downloads fast success without a status flash and clears its timer", async () => {
    outlineJob.exportMode = "pending";
    vi.useFakeTimers();
    try {
      const el = mount(<SketchControls sketch={hlStaticSketch("fast")} />);
      clickButton(el, "Export Hidden-line SVG");
      act(() => vi.advanceTimersByTime(749));
      await act(async () => {
        outlineJob.pendingExport!.succeed();
        await Promise.resolve();
      });
      expect(downloadBlob).toHaveBeenCalledTimes(1);
      expect(el.querySelector('[role="status"]')).toBeNull();

      act(() => vi.advanceTimersByTime(1_000));
      expect(el.textContent).not.toContain("Preparing SVG…");
      expect(
        el.querySelector('progress[aria-label="Hidden-line export progress"]'),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs technical export failures, renders safe detail, and restores the action matrix", async () => {
    outlineJob.exportMode = "pending";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const el = mount(
        <SketchControls
          sketch={hlStaticSketch("failure-ui")}
          onToggleCollapse={() => {}}
        />,
      );
      clickButton(el, "Export Hidden-line SVG");

      const byText = (text: string) =>
        [...el.querySelectorAll("button")].find(
          (button) => button.textContent === text,
        )!;
      expect(byText("Export Hidden-line SVG").disabled).toBe(true);
      expect(
        el.querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle outline render mode"]',
        )?.disabled,
      ).toBe(true);
      expect(byText("Export PNG").disabled).toBe(false);
      expect(byText("Export SVG").disabled).toBe(false);
      expect(byText("New seed").disabled).toBe(false);
      expect(
        el.querySelector<HTMLButtonElement>('button[aria-label="Hide inspector"]')
          ?.disabled,
      ).toBe(false);

      act(() => vi.advanceTimersByTime(750));
      await act(async () => {
        outlineJob.pendingExport!.fail("geometry\u0000 exploded");
        await Promise.resolve();
      });
      expect(downloadBlob).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        "Hidden-line export failed",
        "geometry\u0000 exploded",
      );
      expect(el.querySelector('[role="alert"]')?.textContent).toBe(
        "Export failed: geometry  exploded",
      );
      expect(byText("Export Hidden-line SVG").disabled).toBe(false);
      expect(
        el.querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle outline render mode"]',
        )?.disabled,
      ).toBe(false);
      expect(byText("Export PNG").disabled).toBe(false);
      expect(byText("Export SVG").disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SketchControls — PNG export wiring", () => {
  // A static sketch (no time) for the no-`-t` filename case.
  const staticSketch = (id: string) =>
    sketchWith(id, { radius: numberSpec({ default: 10 }) });

  // A time-driven sketch so the export carries a `-t{t}` segment.
  const timedSketch = (id: string) => {
    const base = staticSketch(id) as unknown as Record<string, unknown>;
    return {
      ...base,
      time: { duration: 4, mode: "loop" },
    } as unknown as Parameters<typeof SketchControls>[0]["sketch"];
  };

  /** Read a Blob's bytes (jsdom-safe, via FileReader → ArrayBuffer). */
  function blobBytes(blob: Blob): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
  }

  /** Extract the iTXt chunk's UTF-8 text payload from a PNG byte stream. */
  function readITxtText(png: Uint8Array): string {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let offset = 8; // skip the signature
    while (offset + 8 <= png.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(
        png[offset + 4]!,
        png[offset + 5]!,
        png[offset + 6]!,
        png[offset + 7]!,
      );
      if (type === "iTXt") {
        const data = png.subarray(offset + 8, offset + 8 + length);
        // keyword | NUL | flag | method | lang+NUL | translated+NUL | text.
        const nul = data.indexOf(0);
        const transEnd = data.indexOf(0, data.indexOf(0, nul + 3) + 1);
        return new TextDecoder().decode(data.subarray(transEnd + 1));
      }
      offset += 12 + length;
    }
    throw new Error("no iTXt chunk found");
  }

  it("snapshots the live canvas and downloads a PNG named for a STATIC sketch (no -t)", async () => {
    const el = mount(<SketchControls sketch={staticSketch("circles")} />);
    const seed = (el.querySelector("#sketch-seed") as HTMLInputElement).value;

    clickButton(el, "Export PNG");
    await flush();

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlob.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    // Static sketch ⇒ no `-t` segment.
    expect(filename).toBe(`circles-seed${seed}.png`);

    // The downloaded PNG carries the reproduction envelope in an iTXt chunk,
    // round-tripping back to the displayed (seed, params, name-stem) — no t. The
    // envelope is now a v2 record (#266) carrying the active Plot Profile (#267),
    // the Harness fallback for this default-less Sketch.
    const json = JSON.parse(readITxtText(await blobBytes(blob)));
    expect(json).toEqual({
      version: 2,
      sketch: "circles",
      name: `circles-seed${seed}`,
      seed: Number(seed),
      params: { radius: 10 },
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
    expect("t" in json).toBe(false);
  });

  it("embeds the same framed v3 snapshot as Save in PNG iTXt", async () => {
    const el = mount(<SketchControls sketch={staticSketch("framed-png")} />);
    clickButton(el, "Crop");
    setInput(el.querySelector<HTMLInputElement>('input[name="x"]')!, "10");
    setInput(el.querySelector<HTMLInputElement>('input[name="y"]')!, "-5");
    setInput(el.querySelector<HTMLInputElement>('input[name="width"]')!, "80");
    setInput(el.querySelector<HTMLInputElement>('input[name="height"]')!, "110");
    clickButton(el, "Apply");

    setInput(
      el.querySelector<HTMLInputElement>('input[aria-label="preset name"]')!,
      "framed-authored",
    );
    clickButton(el, "Save");
    await flush();
    const saved = savePreset.mock.calls[0]![0];
    expect(saved.version).toBe(3);

    clickButton(el, "Export PNG");
    await flush();

    const [blob, filename] = downloadBlob.mock.calls[0]!;
    const embedded = JSON.parse(readITxtText(await blobBytes(blob)));
    expect(filename).toBe(`framed-png-seed${saved.seed}.png`);
    expect(embedded).toEqual({
      ...saved,
      name: `framed-png-seed${saved.seed}`,
    });
  });

  it("includes the captured -t{t} segment for a time-driven sketch", async () => {
    fakeCurrentT = 2.5; // the handle reports the displayed moment
    const el = mount(<SketchControls sketch={timedSketch("waves")} />);
    const seed = (el.querySelector("#sketch-seed") as HTMLInputElement).value;

    clickButton(el, "Export PNG");
    await flush();

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlob.mock.calls[0]!;
    expect(filename).toBe(`waves-seed${seed}-t2.5.png`);
    // The embedded envelope captures the same moment.
    expect(JSON.parse(readITxtText(await blobBytes(blob))).t).toBe(2.5);
  });

  it("does not download when toBlob yields a null blob (export unsupported)", async () => {
    fakeCanvasToBlob = ((cb: BlobCallback) => {
      cb(null);
    }) as HTMLCanvasElement["toBlob"];
    const el = mount(<SketchControls sketch={staticSketch("circles")} />);

    clickButton(el, "Export PNG");
    await flush();

    expect(downloadBlob).not.toHaveBeenCalled();
  });
});

describe("SketchControls — render-mode toggle wiring (#219)", () => {
  const toggleEl = (el: HTMLElement): HTMLButtonElement => {
    const btn = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle outline render mode"]',
    );
    if (btn === null) throw new Error("no render-mode toggle");
    return btn;
  };

  it("defaults to fill and flips the renderMode it passes into LiveCanvas on toggle", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const toggle = toggleEl(el);

    // Default: LiveCanvas receives renderMode="fill", the toggle reads unpressed.
    expect(canvasRenderMode(el)).toBe("fill");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).toBe("Fill");

    // Toggle → the outline mode propagates straight into the LiveCanvas prop.
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(canvasRenderMode(el)).toBe("outline");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toBe("Outline");

    // Toggle again → back to fill (a plain view-only flip, both directions).
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(canvasRenderMode(el)).toBe("fill");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the Fill preview and toggle usable during the quiet Outline interval", () => {
    // Opt out of the auto-clear so the intermediate busy state is observable: the
    // real pass runs asynchronously, so the label must read "Computing…" from the
    // click's own commit until LiveCanvas signals `onOutlineComputed`.
    autoFireOutlineComputed = false;
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const toggle = toggleEl(el);
    expect(toggle.textContent).toBe("Fill");
    expect(toggle.disabled).toBe(false);

    // Click to outline: the busy label is set SYNCHRONOUSLY with the flip (so it
    // paints with the click's commit, before the blocking pass), and the button
    // is disabled + aria-busy. renderMode still propagates to LiveCanvas at once.
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toggle.textContent).toBe("Outline");
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-busy")).toBe("true");
    expect(canvasRenderMode(el)).toBe("fill");

    // The pass finishes → LiveCanvas signals done → the label settles on "Outline"
    // and the control re-enables.
    act(() => {
      lastOnOutlineComputed?.();
    });
    expect(toggle.textContent).toBe("Outline");
    expect(toggle.disabled).toBe(false);
  });

  it("flipping render mode touches no param/seed/lock axis", () => {
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    const seedBefore = (el.querySelector("#sketch-seed") as HTMLInputElement)
      .value;
    const radiusBefore = paramInput(el, "radius").value;

    act(() => {
      toggleEl(el).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The toggle is view-only: it swapped the canvas render mode but left the
    // param and seed axes exactly as they were.
    expect(canvasRenderMode(el)).toBe("outline");
    expect((el.querySelector("#sketch-seed") as HTMLInputElement).value).toBe(
      seedBefore,
    );
    expect(paramInput(el, "radius").value).toBe(radiusBefore);
    expect(historyCapture.atomic).toHaveLength(0);
    expect(historyCapture.transactionCommits).toHaveLength(0);
  });
});

describe("SketchControls — Tone reference mode (#316)", () => {
  const schema: ParamSchema = {
    radius: numberSpec({ default: 10 }),
  };

  function renderState(el: HTMLElement): string | null {
    return el
      .querySelector('[data-testid="canvas-seed"]')
      ?.getAttribute("data-render-state") ?? null;
  }

  function modeButton(el: HTMLElement, label: string): HTMLButtonElement {
    const button = [...el.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === label,
    );
    if (button === undefined) throw new Error(`no ${label} mode button`);
    return button;
  }

  it("adds explicit Fill, Outline, and Tone choices only for capable Sketches", () => {
    const el = mount(
      <SketchControls key="plain" sketch={sketchWith("plain", schema)} />,
    );
    expect(
      el.querySelector('[role="group"][aria-label="Render mode"]'),
    ).toBeNull();
    expect(el.querySelector('[aria-label="Show Tone reference"]')).toBeNull();
    expect(
      el.querySelector('[aria-label="Toggle outline render mode"]'),
    ).not.toBeNull();

    act(() => {
      root!.render(
        <SketchControls key="tone" sketch={toneSketchWith("tone", schema)} />,
      );
    });
    const group = el.querySelector(
      '[role="group"][aria-label="Render mode"]',
    );
    expect(group).not.toBeNull();
    expect(
      [...group!.querySelectorAll("button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["Fill", "Outline", "Tone"]);
    expect(modeButton(el, "Fill").getAttribute("aria-pressed")).toBe("true");
    expect(renderState(el)).toBe("fill-live");
  });

  it("derives Tone directly from live preview params and remains Seed-independent", () => {
    const el = mount(
      <SketchControls sketch={toneSketchWith("tone", schema)} />,
    );
    clickButton(el, "Tone");

    expect(renderState(el)).toBe("tone-reference");
    expect(lastToneSource).not.toBeNull();
    const point: [number, number] = [25, 25];
    const initialSample =
      lastToneSource!.toneField.sample(point) *
      lastToneSource!.shadingMask.sample(point);

    const radius = paramInput(el, "radius");
    act(() => radius.focus());
    setInput(radius, "50");
    const previewSample =
      lastToneSource!.toneField.sample(point) *
      lastToneSource!.shadingMask.sample(point);
    expect(previewSample).not.toBe(initialSample);
    expect(renderState(el)).toBe("tone-reference");

    const sourceBeforeSeed = lastToneSource!;
    const sampleBeforeSeed =
      sourceBeforeSeed.toneField.sample(point) *
      sourceBeforeSeed.shadingMask.sample(point);
    vi.spyOn(Math, "random").mockReturnValue(0.75);
    clickButton(el, "New seed");
    expect(lastToneSource).toBe(sourceBeforeSeed);
    expect(
      lastToneSource!.toneField.sample(point) *
        lastToneSource!.shadingMask.sample(point),
    ).toBe(sampleBeforeSeed);

    act(() => paperMarginsCheckbox(el).click());
    expect(lastToneSource).toBe(sourceBeforeSeed);
    expect(renderState(el)).toBe("tone-reference");
  });

  it("cancels Outline ownership on entry and exits Tone before requesting Outline", () => {
    autoFireOutlineComputed = false;
    const el = mount(
      <SketchControls sketch={toneSketchWith("tone", schema)} />,
    );

    clickButton(el, "Outline");
    expect(outlineJob.starts).toBe(1);
    expect(outlineJob.active).not.toBeNull();

    clickButton(el, "Tone");
    expect(outlineJob.active).toBeNull();
    expect(renderState(el)).toBe("tone-reference");
    expect(modeButton(el, "Tone").getAttribute("aria-pressed")).toBe("true");
    expect(modeButton(el, "Outline").getAttribute("aria-pressed")).toBe("false");

    clickButton(el, "Outline");
    expect(renderState(el)).toBe("fill-held");
    expect(modeButton(el, "Tone").getAttribute("aria-pressed")).toBe("false");
    expect(outlineJob.starts).toBe(2);
    act(() => lastOnOutlineComputed?.());
    expect(renderState(el)).toBe("outline");
  });

  it("keeps mode outside edit history and Presets, including reload", async () => {
    listPresets.mockResolvedValue(["saved"]);
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: "tone",
      name: "saved",
      seed: 99,
      params: { radius: 27 },
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
    const el = mount(
      <SketchControls sketch={toneSketchWith("tone", schema)} />,
    );
    await flush();
    const seedBefore = el.querySelector<HTMLInputElement>(
      "#sketch-seed",
    )!.value;
    const profileBefore = lastProfile;

    clickButton(el, "Tone");
    expect(historyCapture.atomic).toHaveLength(0);
    expect(historyCapture.transactionCommits).toHaveLength(0);
    expect(paramInput(el, "radius").value).toBe("10");
    expect(el.querySelector<HTMLInputElement>("#sketch-seed")!.value).toBe(
      seedBefore,
    );
    expect(lastProfile).toBe(profileBefore);

    setInput(
      el.querySelector('input[aria-label="preset name"]') as HTMLInputElement,
      "tone-view",
    );
    clickButton(el, "Save");
    await flush();
    expect(savePreset).toHaveBeenCalledTimes(1);
    expect(Object.keys(savePreset.mock.calls[0]![0]).sort()).toEqual([
      "locks",
      "name",
      "params",
      "profile",
      "seed",
      "sketch",
      "version",
    ]);

    const picker = el.querySelector(
      'select[aria-label="saved presets"]',
    ) as HTMLSelectElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(picker, "saved");
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    clickButton(el, "Reload");
    await flush();
    expect(paramInput(el, "radius").value).toBe("27");
    expect(renderState(el)).toBe("tone-reference");
    expect(modeButton(el, "Tone").getAttribute("aria-pressed")).toBe("true");
  });

  it("visibly and defensively excludes Tone pixels from every export path", async () => {
    const toBlob = vi.fn();
    fakeCanvasToBlob = toBlob as HTMLCanvasElement["toBlob"];
    const el = mount(
      <SketchControls sketch={toneSketchWith("tone", schema)} />,
    );
    clickButton(el, "Tone");

    const png = modeButton(el, "Export PNG");
    const svg = modeButton(el, "Export SVG");
    const hidden = modeButton(el, "Export Hidden-line SVG");
    expect(png.disabled).toBe(true);
    expect(svg.disabled).toBe(true);
    expect(hidden.disabled).toBe(true);

    // Programmatic native clicks are inert, while the handlers also retain
    // mode guards for callers that bypass the visual disabled state.
    act(() => {
      png.click();
      svg.click();
      hidden.click();
    });
    await flush();
    expect(toBlob).not.toHaveBeenCalled();
    expect(exportSceneCapture.current).toBeNull();
    expect(outlineJob.exportStarts).toBe(0);
    expect(downloadBlob).not.toHaveBeenCalled();

    clickButton(el, "Fill");
    expect(renderState(el)).toBe("fill-live");
    expect(png.disabled).toBe(false);
    expect(svg.disabled).toBe(false);
    expect(hidden.disabled).toBe(false);
    clickButton(el, "Export SVG");
    expect(exportSceneCapture.current).not.toBeNull();
    expect(downloadBlob).toHaveBeenCalledTimes(1);
  });
});

describe("SketchControls — Tone Calibration target (#324)", () => {
  const scribbleControlKeys = [
    "pathDensity",
    "scribbleScale",
    "momentum",
    "chaos",
    "toneFidelity",
    "stopPoint",
  ] as const;
  const stipplingControlKeys = [
    "stippleDensity",
    "distributionFidelity",
    "voronoiRelaxation",
  ] as const;

  function button(el: HTMLElement, label: string): HTMLButtonElement {
    const match = [...el.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === label,
    );
    if (match === undefined) throw new Error(`no ${label} button`);
    return match;
  }

  function visibleNumberKeys(el: HTMLElement): string[] {
    return [...el.querySelectorAll<HTMLInputElement>(
      '#inspector input[id^="control-"]',
    )].map((input) => input.id.slice("control-".length));
  }

  function commitToneNumber(
    el: HTMLElement,
    key: string,
    value: number,
  ): void {
    const input = paramInput(el, key);
    act(() => input.focus());
    setInput(input, String(value));
    act(() => input.blur());
  }

  function toneSamples(source: ToneSource): number[] {
    const frame = lastCompositionFrame!;
    const points: [number, number][] = [
      [0, frame.height * 0.25],
      [frame.width / 2, frame.height * 0.25],
      [frame.width / 2, frame.height * 0.75],
    ];
    return points.flatMap((point) => [
      source.toneField.sample(point),
      source.shadingMask.sample(point),
    ]);
  }

  function blobText(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
  }

  it("defaults to Scribble, exposes only its six controls, and keeps the Tone target fixed across strategies", async () => {
    const el = mount(<SketchControls sketch={toneCalibration} />);
    await flush();
    const strategy = choiceParamSelect(el, "strategy");

    expect(strategy.value).toBe("scribble");
    expect([...strategy.options].map(({ value, text }) => [value, text])).toEqual([
      ["scribble", "Scribble"],
      ["stippling", "Stippling"],
    ]);
    expect(visibleNumberKeys(el)).toEqual(scribbleControlKeys);
    expect(paramInput(el, "pathDensity").value).toBe("1");
    expect(paramInput(el, "pathDensity").max).toBe("20");
    expect(paramInput(el, "scribbleScale").value).toBe("1");
    expect(paramInput(el, "scribbleScale").min).toBe("0.1");
    expect(paramInput(el, "momentum").value).toBe("0.75");
    expect(paramInput(el, "chaos").value).toBe("0.25");
    expect(paramInput(el, "toneFidelity").value).toBe("0.9");
    expect(paramInput(el, "stopPoint").value).toBe("100");
    expect(paramInput(el, "stopPoint").min).toBe("0");
    expect(paramInput(el, "stopPoint").max).toBe("100");
    expect(
      el.querySelector('button[aria-label="voronoiRelaxation lock"]'),
    ).toBeNull();
    expect(
      [...el.querySelectorAll('[role="group"][aria-label="Render mode"] button')].map(
        (candidate) => candidate.textContent,
      ),
    ).toEqual(["Fill", "Outline", "Tone"]);

    clickButton(el, "Tone");
    expect(lastToneSource).not.toBeNull();
    const frame = lastCompositionFrame!;
    const expected = toneCalibration.generateToneSource!(
      defaultParams(toneCalibration.schema),
      frame,
    );
    const points: [number, number][] = [
      [0, frame.height * 0.25],
      [frame.width / 2, frame.height * 0.25],
      [frame.width / 2, frame.height * 0.75],
    ];
    expect(points.map((point) => lastToneSource!.toneField.sample(point))).toEqual(
      points.map((point) => expected.toneField.sample(point)),
    );

    const scribbleTarget = toneSamples(lastToneSource!);
    selectValue(strategy, "stippling");
    expect(visibleNumberKeys(el)).toEqual(stipplingControlKeys);
    expect(paramInput(el, "stippleDensity").value).toBe("1");
    expect(paramInput(el, "distributionFidelity").value).toBe("0.5");
    expect(paramInput(el, "voronoiRelaxation").value).toBe("0");
    expect(
      el.querySelector('button[aria-label="voronoiRelaxation lock"]'),
    ).not.toBeNull();
    expect(lastToneSource).not.toBeNull();
    expect(toneSamples(lastToneSource!)).toEqual(scribbleTarget);
  });

  it("retains both real strategy branches through atomic Choice Undo and Redo", async () => {
    const el = mount(<SketchControls sketch={toneCalibration} />);
    await flush();

    commitToneNumber(el, "pathDensity", 2.5);
    selectValue(choiceParamSelect(el, "strategy"), "stippling");
    commitToneNumber(el, "stippleDensity", 1.75);
    commitToneNumber(el, "distributionFidelity", 0.8);
    const commitsBeforeRelaxation =
      historyCapture.transactionCommits.length;
    commitToneNumber(el, "voronoiRelaxation", 0.6);
    expect(historyCapture.transactionCommits).toHaveLength(
      commitsBeforeRelaxation + 1,
    );
    const relaxationCommit = historyCapture.transactionCommits.at(-1)!;
    expect(
      relaxationCommit.before.transactionStart?.params.voronoiRelaxation,
    ).toBe(0);
    expect(relaxationCommit.after.present.params.voronoiRelaxation).toBe(0.6);
    expect(relaxationCommit.after.past).toHaveLength(
      relaxationCommit.before.past.length + 1,
    );

    expect(
      pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    expect(choiceParamSelect(el, "strategy").value).toBe("stippling");
    expect(paramInput(el, "voronoiRelaxation").value).toBe("0");
    expect(
      pressHistoryShortcut(window, { key: "y", ctrlKey: true })
        .defaultPrevented,
    ).toBe(true);
    expect(choiceParamSelect(el, "strategy").value).toBe("stippling");
    expect(paramInput(el, "voronoiRelaxation").value).toBe("0.6");

    const commitsBeforeReturn = historyCapture.transactionCommits.length;
    selectValue(choiceParamSelect(el, "strategy"), "scribble");
    expect(historyCapture.transactionCommits).toHaveLength(
      commitsBeforeReturn + 1,
    );
    const strategyCommit = historyCapture.transactionCommits.at(-1)!;
    expect(strategyCommit.before.transactionStart?.params.strategy).toBe(
      "stippling",
    );
    expect(strategyCommit.after.past).toHaveLength(
      strategyCommit.before.past.length + 1,
    );
    expect(strategyCommit.after.present.params).toMatchObject({
      strategy: "scribble",
      pathDensity: 2.5,
      stippleDensity: 1.75,
      distributionFidelity: 0.8,
      voronoiRelaxation: 0.6,
    });
    expect(paramInput(el, "pathDensity").value).toBe("2.5");

    expect(
      pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    expect(choiceParamSelect(el, "strategy").value).toBe("stippling");
    expect(paramInput(el, "stippleDensity").value).toBe("1.75");
    expect(paramInput(el, "distributionFidelity").value).toBe("0.8");
    expect(paramInput(el, "voronoiRelaxation").value).toBe("0.6");

    expect(
      pressHistoryShortcut(window, { key: "y", ctrlKey: true })
        .defaultPrevented,
    ).toBe(true);
    expect(choiceParamSelect(el, "strategy").value).toBe("scribble");
    expect(paramInput(el, "pathDensity").value).toBe("2.5");
  });

  it("randomizes only active unlocked Tone numbers with exact branch-local random consumption", async () => {
    const el = mount(<SketchControls sketch={toneCalibration} />);
    await flush();

    selectValue(choiceParamSelect(el, "strategy"), "stippling");
    commitToneNumber(el, "stippleDensity", 2);
    commitToneNumber(el, "distributionFidelity", 0.8);
    commitToneNumber(el, "voronoiRelaxation", 0.6);
    selectValue(choiceParamSelect(el, "strategy"), "scribble");
    act(() => {
      el.querySelector<HTMLButtonElement>(
        'button[aria-label="scribbleScale lock"]',
      )!.click();
    });

    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    clickButton(el, "Randomize");
    expect(random).toHaveBeenCalledTimes(5);
    expect(historyCapture.atomic.at(-1)!.after.present.params).toEqual({
      strategy: "scribble",
      pathDensity: 10.25,
      scribbleScale: 1,
      momentum: 0.5,
      chaos: 0.5,
      toneFidelity: 0.5,
      stopPoint: 50,
      stippleDensity: 2,
      distributionFidelity: 0.8,
      voronoiRelaxation: 0.6,
    });

    selectValue(choiceParamSelect(el, "strategy"), "stippling");
    expect(paramInput(el, "stippleDensity").value).toBe("2");
    expect(paramInput(el, "distributionFidelity").value).toBe("0.8");
    act(() => {
      el.querySelector<HTMLButtonElement>(
        'button[aria-label="distributionFidelity lock"]',
      )!.click();
    });
    random.mockClear().mockReturnValue(0.25);
    clickButton(el, "Randomize");
    expect(random).toHaveBeenCalledTimes(2);
    expect(historyCapture.atomic.at(-1)!.after.present.params).toEqual({
      strategy: "stippling",
      pathDensity: 10.25,
      scribbleScale: 1,
      momentum: 0.5,
      chaos: 0.5,
      toneFidelity: 0.5,
      stopPoint: 50,
      stippleDensity: 0.25 * (400 / 0.25) ** 0.25,
      distributionFidelity: 0.8,
      voronoiRelaxation: 0.25,
    });

    act(() => {
      el.querySelector<HTMLButtonElement>(
        'button[aria-label="voronoiRelaxation lock"]',
      )!.click();
    });
    random.mockClear().mockReturnValue(0.75);
    clickButton(el, "Randomize");
    expect(random).toHaveBeenCalledTimes(1);
    expect(historyCapture.atomic.at(-1)!.after.present.params).toMatchObject({
      distributionFidelity: 0.8,
      voronoiRelaxation: 0.25,
    });
  });

  it("saves and reloads all ten authored Tone fields across both strategies", async () => {
    const reloadedParams: Params = {
      strategy: "stippling",
      pathDensity: 4.5,
      scribbleScale: 1.4,
      momentum: 0.65,
      chaos: 0.35,
      toneFidelity: 0.85,
      stopPoint: 90,
      stippleDensity: 1.8,
      distributionFidelity: 0.7,
      voronoiRelaxation: 0.65,
    };
    listPresets.mockResolvedValue(["authored"]);
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: toneCalibration.id,
      name: "authored",
      seed: 777,
      params: reloadedParams,
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
    const el = mount(<SketchControls sketch={toneCalibration} />);
    await flush();

    const savedParams: Params = {
      strategy: "stippling",
      pathDensity: 2.5,
      scribbleScale: 1.3,
      momentum: 0.6,
      chaos: 0.4,
      toneFidelity: 0.8,
      stopPoint: 80,
      stippleDensity: 2,
      distributionFidelity: 0.75,
      voronoiRelaxation: 0.55,
    };
    for (const key of scribbleControlKeys) {
      commitToneNumber(el, key, Number(savedParams[key]));
    }
    selectValue(choiceParamSelect(el, "strategy"), "stippling");
    for (const key of stipplingControlKeys) {
      commitToneNumber(el, key, Number(savedParams[key]));
    }
    setInput(
      el.querySelector<HTMLInputElement>('input[aria-label="preset name"]')!,
      "complete-tone",
    );
    clickButton(el, "Save");
    await flush();
    expect(savePreset.mock.calls.at(-1)?.[0]).toMatchObject({
      sketch: toneCalibration.id,
      name: "complete-tone",
      params: savedParams,
    });
    expect(Object.keys(savePreset.mock.calls.at(-1)![0].params)).toHaveLength(10);

    const picker = el.querySelector<HTMLSelectElement>(
      'select[aria-label="saved presets"]',
    )!;
    selectValue(picker, "authored");
    clickButton(el, "Reload");
    await flush();
    expect(historyCapture.atomic.at(-1)!.after.present.params).toEqual(
      reloadedParams,
    );
    expect(choiceParamSelect(el, "strategy").value).toBe("stippling");
    expect(stipplingControlKeys.map((key) => paramInput(el, key).value)).toEqual([
      "1.8",
      "0.7",
      "0.65",
    ]);
    selectValue(choiceParamSelect(el, "strategy"), "scribble");
    expect(scribbleControlKeys.map((key) => paramInput(el, key).value)).toEqual([
      "4.5",
      "1.4",
      "0.65",
      "0.35",
      "0.85",
      "90",
    ]);
  });

  it("reconciles the existing neat Preset to Scribble and live Stippling defaults", async () => {
    listPresets.mockResolvedValue(["neat"]);
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: toneCalibration.id,
      name: "neat",
      seed: 6329797832350081,
      params: {
        pathDensity: 19.7,
        scribbleScale: 1,
        momentum: 0.75,
        chaos: 0.25,
        toneFidelity: 0.9,
        stopPoint: 100,
      },
      locks: [],
      profile: {
        width: 200,
        height: 200,
        insets: { top: 10, right: 10, bottom: 10, left: 10 },
        includeFrame: true,
      },
    } as unknown as Preset);
    const el = mount(<SketchControls sketch={toneCalibration} />);
    await flush();

    selectValue(
      el.querySelector<HTMLSelectElement>(
        'select[aria-label="saved presets"]',
      )!,
      "neat",
    );
    clickButton(el, "Reload");
    await flush();

    expect(choiceParamSelect(el, "strategy").value).toBe("scribble");
    expect(historyCapture.atomic.at(-1)!.after.present.params).toEqual({
      strategy: "scribble",
      pathDensity: 19.7,
      scribbleScale: 1,
      momentum: 0.75,
      chaos: 0.25,
      toneFidelity: 0.9,
      stopPoint: 100,
      stippleDensity: 1,
      distributionFidelity: 0.5,
      voronoiRelaxation: 0,
    });
    selectValue(choiceParamSelect(el, "strategy"), "stippling");
    expect(visibleNumberKeys(el)).toEqual(stipplingControlKeys);
    expect(paramInput(el, "stippleDensity").value).toBe("1");
    expect(paramInput(el, "distributionFidelity").value).toBe("0.5");
    expect(paramInput(el, "voronoiRelaxation").value).toBe("0");
  });

  it("retains inactive relaxation through reload and SVG metadata while worker identity stays active-only", async () => {
    const authoredParams: Params = {
      strategy: "scribble",
      pathDensity: 4.5,
      scribbleScale: 1.4,
      momentum: 0.65,
      chaos: 0.35,
      toneFidelity: 0.85,
      stopPoint: 90,
      stippleDensity: 1.8,
      distributionFidelity: 0.7,
      voronoiRelaxation: 0.6,
    };
    listPresets.mockResolvedValue(["metadata"]);
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: toneCalibration.id,
      name: "metadata",
      seed: 999,
      params: authoredParams,
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
    const el = mount(<SketchControls sketch={toneCalibration} />);
    await flush();
    selectValue(
      el.querySelector<HTMLSelectElement>(
        'select[aria-label="saved presets"]',
      )!,
      "metadata",
    );
    clickButton(el, "Reload");
    await flush();

    const jobIndex = shadingJob.starts.length - 1;
    const job = shadingJob.starts[jobIndex]!;
    expect(job.identity.params).toEqual([
      { key: "strategy", value: "scribble" },
      { key: "pathDensity", value: 4.5 },
      { key: "scribbleScale", value: 1.4 },
      { key: "momentum", value: 0.65 },
      { key: "chaos", value: 0.35 },
      { key: "toneFidelity", value: 0.85 },
      { key: "stopPoint", value: 90 },
    ]);
    expect(job.identity.params).not.toContainEqual({
      key: "voronoiRelaxation",
      value: 0.6,
    });
    await act(async () => {
      job.resolve({
        status: "success",
        jobId: jobIndex + 1,
        identity: job.identity,
        scene: {
          space: lastCompositionFrame!,
          primitives: [
            {
              points: [[1, 1], [1.1, 1.1]],
              closed: false,
              stroke: { color: "black", width: 1 },
              hiddenLineRole: "source",
            },
          ],
        },
        diagnostics: {
          termination: "completed",
          pathLength: 0.14,
          polylineCount: 1,
          penLiftCount: 0,
          fidelity: { kind: "scribble", residualError: 0.02 },
        },
        computeTimeMs: 5,
      });
      await Promise.resolve();
    });

    clickButton(el, "Export SVG");
    const svg = await blobText(downloadBlob.mock.calls.at(-1)![0]);
    const encoded = svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1];
    expect(encoded).toBeDefined();
    const metadata = JSON.parse(encoded!) as Preset;
    expect(metadata.params).toEqual(authoredParams);
    expect(Object.keys(metadata.params)).toHaveLength(10);
    expect(applyPreset(toneCalibration.schema, metadata).params).toEqual(
      authoredParams,
    );
  });

  it("keeps Tone pixels inert and exports only nonempty vector Fill artwork", async () => {
    const toBlob = vi.fn((callback: BlobCallback) => {
      callback(new Blob([MINIMAL_PNG], { type: "image/png" }));
    });
    fakeCanvasToBlob = toBlob as HTMLCanvasElement["toBlob"];
    const el = mount(<SketchControls sketch={toneCalibration} />);

    clickButton(el, "Tone");
    const png = button(el, "Export PNG");
    const svg = button(el, "Export SVG");
    const plotter = button(el, "Export Hidden-line SVG");
    expect([png.disabled, svg.disabled, plotter.disabled]).toEqual([
      true,
      true,
      true,
    ]);

    act(() => {
      png.click();
      svg.click();
      plotter.click();
    });
    await flush();
    expect(toBlob).not.toHaveBeenCalled();
    expect(exportSceneCapture.current).toBeNull();
    expect(plotterExportCapture.current).toBeNull();
    expect(outlineJob.exportStarts).toBe(0);
    expect(downloadBlob).not.toHaveBeenCalled();

    clickButton(el, "Fill");
    const prepared: Scene = {
      space: lastCompositionFrame!,
      primitives: [
        {
          points: [[1, 1], [2, 2]],
          closed: false,
          stroke: { color: "black", width: 1 },
          hiddenLineRole: "source",
        },
      ],
    };
    await act(async () => {
      const job = shadingJob.starts[0]!;
      job.resolve({
        status: "success",
        jobId: 1,
        identity: job.identity,
        scene: prepared,
        diagnostics: {
          termination: "completed",
          pathLength: 1,
          polylineCount: 1,
          penLiftCount: 0,
          fidelity: { kind: "scribble", residualError: 0.01 },
        },
        computeTimeMs: 5,
      });
      await Promise.resolve();
    });
    expect([png.disabled, svg.disabled, plotter.disabled]).toEqual([
      false,
      false,
      false,
    ]);

    // PNG is a snapshot of the Fill canvas pixels, not a Scene serialization.
    clickButton(el, "Export PNG");
    await flush();
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(exportSceneCapture.current).toBeNull();
    expect(outlineJob.exportStarts).toBe(0);

    // The ordinary SVG source is the generated Scribble Scene: black open
    // vectors, with no calibration target pixels or boundary guide geometry.
    clickButton(el, "Export SVG");
    const ordinary = exportSceneCapture.current as Scene;
    expect(ordinary.space).toEqual(lastCompositionFrame);
    expect(ordinary.primitives.length).toBeGreaterThan(0);
    expect(ordinary.background).toBeUndefined();
    for (const primitive of ordinary.primitives) {
      expect(primitive.closed).toBe(false);
      expect(primitive.fill).toBeUndefined();
      expect(primitive.stroke).toEqual({ color: "black", width: 1 });
    }

    // A disabled composition frame keeps the plotter assertion isolated from
    // Harness-owned frame geometry. The authored Scribbles explicitly survive
    // the hidden-line pass into the separate plotter export.
    const includeFrame = compositionFrameCheckbox(el);
    expect(includeFrame.checked).toBe(true);
    act(() => includeFrame.click());
    expect(includeFrame.checked).toBe(false);
    clickButton(el, "Export Hidden-line SVG");
    await flush();
    expect(outlineJob.exportStarts).toBe(1);
    expect(outlineJob.lastExportSnapshot?.profile.includeFrame).toBe(false);
    const plotterScene = plotterExportCapture.current?.scene as Scene;
    expect(plotterScene.primitives.length).toBeGreaterThan(0);
    expect(plotterScene.primitives.map(({ points }) => points)).toEqual(
      ordinary.primitives.map(({ points }) => points),
    );
  });
});

describe("SketchControls — Shading preparation composition (#318)", () => {
  const diagnostics = {
    termination: "completed" as const,
    pathLength: 12,
    polylineCount: 2,
    penLiftCount: 1,
    fidelity: {
      kind: "scribble" as const,
      residualError: 0.01,
    },
  };

  async function completeShading(
    index: number,
    scene: Scene,
    resultDiagnostics: ShadingDiagnostics = diagnostics,
  ): Promise<void> {
    const job = shadingJob.starts[index];
    if (job === undefined) throw new Error(`no Shading job ${index}`);
    await act(async () => {
      job.resolve({
        status: "success",
        jobId: index + 1,
        identity: job.identity,
        scene,
        diagnostics: resultDiagnostics,
        computeTimeMs: 5,
      });
      await Promise.resolve();
    });
  }

  async function completeDetail(index: number, value = 128): Promise<void> {
    const job = detailJob.starts[index];
    if (job === undefined) throw new Error(`no Detail job ${index}`);
    const prepared = prepareImageDetailAnalysis({
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([
        value, value, value, 255,
        0, 0, 0, 255,
        255, 255, 255, 255,
        value, value, value, 255,
      ]),
    });
    await act(async () => {
      if (detailJob.active === job) detailJob.active = null;
      job.resolve({
        status: "success",
        jobId: index + 1,
        identity: job.identity,
        prepared,
      });
      await Promise.resolve();
    });
  }

  function reportShadingProgress(
    index: number,
    completedWorkUnits: number,
    totalWorkUnits: number,
    eta: import("./rollingEta").RollingEtaEstimate = {
      kind: "estimating",
      revision: 1,
    },
    terminal = completedWorkUnits === totalWorkUnits,
  ): void {
    const observe = shadingJob.starts[index]?.observeProgress;
    if (observe === undefined) throw new Error(`no Shading observer ${index}`);
    act(() => {
      observe({
        snapshot: {
          completedWorkUnits,
          totalWorkUnits,
          terminal,
        },
        eta,
      });
    });
  }

  async function failShading(index: number, error: string): Promise<void> {
    const job = shadingJob.starts[index];
    if (job === undefined) throw new Error(`no Shading job ${index}`);
    await act(async () => {
      job.resolve({ status: "failure", jobId: index + 1, error });
      await Promise.resolve();
    });
  }

  function preparedScene(label: number): Scene {
    return {
      space: { width: 100, height: 100 },
      primitives: [
        {
          points: [[label, label], [label + 1, label + 1]],
          hiddenLineRole: "source",
        },
      ],
    };
  }

  function exportButton(el: HTMLElement, label: string): HTMLButtonElement {
    const match = [...el.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === label,
    );
    if (match === undefined) throw new Error(`no ${label} button`);
    return match;
  }

  function shadingDisclosure(el: HTMLElement): HTMLDetailsElement {
    const match = [...el.querySelectorAll("details")].find((details) =>
      details.querySelector("summary")?.textContent?.includes(
        "Shading",
      ),
    );
    if (match === undefined) throw new Error("no Shading");
    return match;
  }

  function readBlobText(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
  }

  function historyWriteCount(): number {
    return (
      historyCapture.atomic.length +
      historyCapture.transactionCommits.length +
      historyCapture.cancels.length
    );
  }

  const shadingParamEntries = (params: Params) =>
    createShadingComputeIdentity({
      sketchId: toneCalibration.id,
      schema: toneCalibration.schema,
      params,
      seed: 0,
      compositionFrame: DEFAULT_COMPOSITION_FRAME,
    }).params;

  it("ignores an actual Tone inactive-branch-only Preset edit without disturbing current Shading", async () => {
    const initialParams = defaultParams(toneCalibration.schema);
    const initialSeed = newSeed(() => 0.125);
    vi.spyOn(Math, "random").mockReturnValue(0.125);
    listPresets.mockResolvedValue(["inactive-stippling"]);
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: toneCalibration.id,
      name: "inactive-stippling",
      seed: initialSeed,
      params: {
        ...initialParams,
        stippleDensity: 1.75,
        distributionFidelity: 0.8,
        voronoiRelaxation: 0.65,
      },
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });

    const el = mount(<SketchControls sketch={toneCalibration} />);
    await flush();
    expect(shadingJob.starts[0]!.identity.params).toEqual(
      shadingParamEntries(initialParams),
    );
    await completeShading(0, preparedScene(70));

    const canvas = el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!;
    const presentation = {
      sourceInputRevision: canvas.dataset.sourceInputRevision,
      contentRevision: canvas.dataset.contentRevision,
      diagnostics: shadingDisclosure(el).textContent,
      cancelCount: shadingJob.cancelCount,
    };
    const picker = el.querySelector<HTMLSelectElement>(
      'select[aria-label="saved presets"]',
    )!;
    selectValue(picker, "inactive-stippling");
    clickButton(el, "Reload");
    await flush();

    expect(historyCapture.atomic.at(-1)!.after.present.params).toMatchObject({
      strategy: "scribble",
      stippleDensity: 1.75,
      distributionFidelity: 0.8,
      voronoiRelaxation: 0.65,
    });
    expect(shadingJob.starts).toHaveLength(1);
    expect(shadingJob.cancelCount).toBe(presentation.cancelCount);
    expect(canvas.dataset.sourceInputRevision).toBe(
      presentation.sourceInputRevision,
    );
    expect(canvas.dataset.contentRevision).toBe(presentation.contentRevision);
    expect(shadingDisclosure(el).textContent).toBe(presentation.diagnostics);
  });

  it("treats missing and explicit-zero relaxation as the same current Stippling identity", async () => {
    const initialParams: Params = {
      ...defaultParams(toneCalibration.schema),
      strategy: "stippling",
    };
    const {
      voronoiRelaxation: _omitted,
      ...paramsWithoutRelaxation
    } = initialParams;
    const initialSeed = newSeed(() => 0.125);
    vi.spyOn(Math, "random").mockReturnValue(0.125);
    listPresets.mockResolvedValue(["missing-zero", "explicit-zero"]);
    loadPreset.mockImplementation(async (_sketchId, name) => ({
      version: 2,
      sketch: toneCalibration.id,
      name,
      seed: initialSeed,
      params:
        name === "missing-zero"
          ? paramsWithoutRelaxation
          : { ...initialParams, voronoiRelaxation: 0 },
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    }));

    const el = mount(<SketchControls sketch={toneCalibration} />);
    await flush();
    await completeShading(0, preparedScene(75));
    selectValue(choiceParamSelect(el, "strategy"), "stippling");
    await completeShading(1, preparedScene(76), {
      ...diagnostics,
      fidelity: { kind: "stippling", distributionError: 0.02 },
    });
    expect(shadingJob.starts[1]!.identity.params).not.toContainEqual({
      key: "voronoiRelaxation",
      value: 0,
    });

    const starts = shadingJob.starts.length;
    const cancels = shadingJob.cancelCount;
    const picker = el.querySelector<HTMLSelectElement>(
      'select[aria-label="saved presets"]',
    )!;
    for (const name of ["missing-zero", "explicit-zero"]) {
      selectValue(picker, name);
      clickButton(el, "Reload");
      await flush();
      expect(paramInput(el, "voronoiRelaxation").value).toBe("0");
      expect(shadingJob.starts).toHaveLength(starts);
      expect(shadingJob.cancelCount).toBe(cancels);
    }
  });

  it("settles actual Tone previews once and switches strategies with only the restored active branch", async () => {
    const authored = defaultParams(toneCalibration.schema);
    const el = mount(<SketchControls sketch={toneCalibration} />);
    expect(shadingJob.starts[0]!.identity.params).toEqual(
      shadingParamEntries(authored),
    );
    await completeShading(0, preparedScene(71));

    const pathDensity = paramInput(el, "pathDensity");
    act(() => pathDensity.focus());
    setInput(pathDensity, "1.5");
    setInput(pathDensity, "2");
    setInput(pathDensity, "2.5");
    expect(shadingJob.starts).toHaveLength(1);
    act(() => pathDensity.blur());

    authored.pathDensity = 2.5;
    expect(shadingJob.starts).toHaveLength(2);
    expect(shadingJob.starts[1]!.identity.params).toEqual(
      shadingParamEntries(authored),
    );
    await completeShading(1, preparedScene(72));

    const commitsBeforeStippling = historyCapture.transactionCommits.length;
    selectValue(choiceParamSelect(el, "strategy"), "stippling");
    authored.strategy = "stippling";
    expect(historyCapture.transactionCommits).toHaveLength(
      commitsBeforeStippling + 1,
    );
    expect(shadingJob.starts).toHaveLength(3);
    expect(shadingJob.starts[2]!.identity.params).toEqual(
      shadingParamEntries(authored),
    );
    expect(shadingJob.starts[2]!.identity.params).not.toContainEqual({
      key: "pathDensity",
      value: 2.5,
    });
    await completeShading(2, preparedScene(73));

    const stippleDensity = paramInput(el, "stippleDensity");
    act(() => stippleDensity.focus());
    setInput(stippleDensity, "1.5");
    act(() => stippleDensity.blur());
    authored.stippleDensity = 1.5;
    expect(shadingJob.starts).toHaveLength(4);
    expect(shadingJob.starts[3]!.identity.params).toEqual(
      shadingParamEntries(authored),
    );
    await completeShading(3, preparedScene(74));

    const commitsBeforeScribble = historyCapture.transactionCommits.length;
    selectValue(choiceParamSelect(el, "strategy"), "scribble");
    authored.strategy = "scribble";
    expect(historyCapture.transactionCommits).toHaveLength(
      commitsBeforeScribble + 1,
    );
    expect(shadingJob.starts).toHaveLength(5);
    expect(shadingJob.starts[4]!.identity.params).toEqual(
      shadingParamEntries(authored),
    );
    expect(paramInput(el, "pathDensity").value).toBe("2.5");
    expect(shadingJob.starts[4]!.identity.params).not.toContainEqual({
      key: "stippleDensity",
      value: 1.5,
    });
  });

  it("scales, pans, applies, and resets a fixed Page without restarting Shading or revising painted provenance", async () => {
    const el = mount(<SketchControls sketch={toneCalibration} />);
    await completeShading(0, preparedScene(77));
    const canvas = el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!;
    const sourceRevision = canvas.dataset.sourceInputRevision;
    const contentRevision = canvas.dataset.contentRevision;
    expect(shadingJob.starts).toHaveLength(1);

    clickButton(el, "Crop");
    act(() =>
      el
        .querySelector<HTMLInputElement>('input[name="keepPageSizeFixed"]')!
        .click(),
    );
    setInput(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Composition scale percentage"]',
      )!,
      "150",
    );
    const scaled = lastPageFrameEditDraft;
    if (scaled?.mode !== "fixed-page") {
      throw new Error("fixed Page draft was not active");
    }
    act(() =>
      lastOnPageFrameDraftChange?.({
        ...scaled.frame,
        x: scaled.frame.x + scaled.compositionFrame.width * 0.1,
        y: scaled.frame.y - scaled.compositionFrame.height * 0.05,
      }),
    );
    expect(lastPageFrameEditDraft?.frame).not.toEqual(scaled.frame);
    expect(historyCapture.atomic).toHaveLength(0);
    expect(shadingJob.starts).toHaveLength(1);
    clickButton(el, "Apply");
    expect(historyCapture.atomic).toHaveLength(1);
    expect(shadingJob.starts).toHaveLength(1);
    expect(canvas.dataset.sourceInputRevision).toBe(sourceRevision);
    expect(canvas.dataset.contentRevision).toBe(contentRevision);

    clickButton(el, "Crop");
    act(() =>
      el
        .querySelector<HTMLInputElement>('input[name="keepPageSizeFixed"]')!
        .click(),
    );
    clickButton(el, "Reset Frame");
    expect(historyCapture.atomic).toHaveLength(2);
    expect(shadingJob.starts).toHaveLength(1);
    expect(canvas.dataset.sourceInputRevision).toBe(sourceRevision);
    expect(canvas.dataset.contentRevision).toBe(contentRevision);
  });

  it("restyles retained Outline through fixed-page scale and pan without generation or preparation", async () => {
    autoFireOutlineComputed = false;
    const generate = vi.fn(toneCalibration.generate);
    const el = mount(
      <SketchControls sketch={{ ...toneCalibration, generate }} />,
    );
    const source = preparedScene(78);
    source.primitives[0]!.stroke = { color: "navy", width: 7 };
    await completeShading(0, source);
    clickButton(el, "Outline");
    act(() => lastOnOutlineComputed?.());
    expect(outlineJob.starts).toBe(1);
    expect(lastRenderScene?.primitives[0]?.stroke?.width).toBe(7);
    expect(lastOutlineFinalizationStrokePolicy).toMatchObject({
      kind: "physical-tool",
      target: {
        toolWidthMillimeters: 0.3,
        millimetersPerSceneUnit: 0.18,
      },
    });
    const cachedOutlineScene = lastRenderScene;

    generate.mockClear();
    generateDuringLiveCanvasRender = true;
    clickButton(el, "Crop");
    act(() =>
      el
        .querySelector<HTMLInputElement>('input[name="keepPageSizeFixed"]')!
        .click(),
    );
    setInput(
      el.querySelector<HTMLInputElement>(
        'input[aria-label="Composition scale percentage"]',
      )!,
      "150",
    );
    const scaled = lastPageFrameEditDraft;
    if (scaled?.mode !== "fixed-page" || lastProfile === null) {
      throw new Error("fixed Page draft was not active");
    }
    const drawableWidth =
      lastProfile.width - lastProfile.insets.left - lastProfile.insets.right;
    const targetScale = drawableWidth / scaled.frame.width;
    expect(lastRenderScene).toBe(cachedOutlineScene);
    expect(lastOutlineFinalizationStrokePolicy?.target).toEqual({
      toolWidthMillimeters: 0.3,
      millimetersPerSceneUnit: targetScale,
    });
    expect(outlineJob.starts).toBe(1);
    expect(shadingJob.starts).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();

    const scaledStrokePolicy = lastOutlineFinalizationStrokePolicy;
    act(() =>
      lastOnPageFrameDraftChange?.({
        ...scaled.frame,
        x: scaled.frame.x + 40,
        y: scaled.frame.y - 25,
      }),
    );
    expect(lastRenderScene).toBe(cachedOutlineScene);
    expect(lastOutlineFinalizationStrokePolicy).toBe(scaledStrokePolicy);
    expect(outlineJob.starts).toBe(1);
    expect(shadingJob.starts).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();

    clickButton(el, "Apply");
    expect(outlineJob.starts).toBe(1);
    expect(shadingJob.starts).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();

    clickButton(el, "Crop");
    act(() =>
      el
        .querySelector<HTMLInputElement>('input[name="keepPageSizeFixed"]')!
        .click(),
    );
    const panOnly = lastPageFrameEditDraft;
    if (panOnly?.mode !== "fixed-page") {
      throw new Error("fixed Page pan draft was not active");
    }
    act(() =>
      lastOnPageFrameDraftChange?.({
        ...panOnly.frame,
        x: panOnly.frame.x - 15,
      }),
    );
    clickButton(el, "Apply");
    expect(lastRenderScene).toBe(cachedOutlineScene);
    expect(lastOutlineFinalizationStrokePolicy).toBe(scaledStrokePolicy);
    expect(outlineJob.starts).toBe(1);
    expect(shadingJob.starts).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();

    clickButton(el, "Export Hidden-line SVG");
    expect(outlineJob.exportDerivations).toBe(0);
    expect(outlineJob.lastExportSnapshot?.reusableOutline).toBeDefined();
    expect(outlineJob.lastExportSnapshot?.identity).toMatchObject({
      sourceKind: "completed-scene-sketch",
      outlineTarget: {
        toolWidthMillimeters: 0.3,
        millimetersPerSceneUnit: targetScale,
      },
    });
  });

  it("emits one asymmetric fixed Page consistently through PNG, ordinary SVG, and plotter SVG", async () => {
    const generate = vi.fn(toneCalibration.generate);
    const sketch = {
      ...toneCalibration,
      id: "fixed-page-output-parity",
      defaultOutputProfile: FIXED_PAGE_PARITY_PROFILE,
      generate,
    };
    const source = fixedPageParityScene();
    const toBlob = vi.fn((callback: BlobCallback) => {
      callback(new Blob([MINIMAL_PNG], { type: "image/png" }));
    });
    fakeCanvasToBlob = toBlob as HTMLCanvasElement["toBlob"];
    const el = mount(<SketchControls sketch={sketch} />);
    await flush();
    expect(lastCompositionFrame).toEqual(FIXED_PAGE_PARITY_COMPOSITION);
    await completeShading(0, source);

    // Drive the public editor: 2× absolute scale, then the asymmetric origin.
    clickButton(el, "Crop");
    act(() => el.querySelector<HTMLInputElement>('input[name="keepPageSizeFixed"]')!.click());
    setInput(
      el.querySelector<HTMLInputElement>('input[aria-label="Composition scale percentage"]')!,
      "200",
    );
    setInput(el.querySelector<HTMLInputElement>('input[name="x"]')!, "-10");
    setInput(el.querySelector<HTMLInputElement>('input[name="y"]')!, "25");
    expect(lastPageFrameEditDraft?.mode).toBe("fixed-page");
    expect(lastPageFrameEditDraft?.frame).toEqual(FIXED_PAGE_PARITY_FRAME);
    expect(lastProfile).toBe(lastPageFrameEditDraft?.profile);
    clickButton(el, "Apply");

    expect(lastProfile).toEqual(FIXED_PAGE_PARITY_PROFILE);
    expect(lastCommittedPageFrame).toEqual(FIXED_PAGE_PARITY_FRAME);
    expect(historyCapture.atomic).toHaveLength(1);
    expect(shadingJob.starts).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();

    // Tone sees the same committed Page; placement bytes are asserted through
    // the real LiveCanvas in its sibling parity test.
    clickButton(el, "Tone");
    expect(lastToneSource).not.toBeNull();
    expect(lastCommittedPageFrame).toEqual(FIXED_PAGE_PARITY_FRAME);
    expect(lastProfile).toEqual(FIXED_PAGE_PARITY_PROFILE);
    clickButton(el, "Fill");

    clickButton(el, "Export PNG");
    await flush();
    expect(toBlob).toHaveBeenCalledOnce();
    const pngCall = downloadBlob.mock.calls.at(-1)!;
    expect(pngCall[0].type).toBe("image/png");
    const pngBytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(pngCall[0]);
    });
    const pngText = new TextDecoder().decode(pngBytes);
    expect(pngText).toContain('"version":3');
    expect(pngText).toContain('"profile":{"width":323,"height":217');
    expect(pngText).toContain(
      `"pageFrame":{"x":${FIXED_PAGE_PARITY_FRAME.x},"y":${FIXED_PAGE_PARITY_FRAME.y},"width":${FIXED_PAGE_PARITY_FRAME.width},"height":${FIXED_PAGE_PARITY_FRAME.height}}`,
    );

    clickButton(el, "Export SVG");
    const ordinaryBlob = downloadBlob.mock.calls.at(-1)![0];
    const ordinarySvg = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(ordinaryBlob);
    });
    const expectedFramed = frameScene(source, FIXED_PAGE_PARITY_FRAME);
    expect(exportSceneCapture.current).toEqual(expectedFramed);
    const ordinaryDocument = new DOMParser().parseFromString(ordinarySvg, "image/svg+xml");
    expect(ordinaryDocument.documentElement.getAttribute("viewBox")).toBe(
      `0 0 ${FIXED_PAGE_PARITY_FRAME.width} ${FIXED_PAGE_PARITY_FRAME.height}`,
    );
    expect(ordinaryDocument.querySelector(":root > rect")?.getAttribute("fill")).toBe("#f4efe6");
    expect(ordinaryDocument.querySelector(":root > path")?.getAttribute("d")).toBe(
      "M129.0994 38.7298 L645.4972 348.5685",
    );

    clickButton(el, "Outline");
    expect(lastCommittedPageFrame).toEqual(FIXED_PAGE_PARITY_FRAME);
    expect(lastOutlineFinalizationStrokePolicy).toEqual({
      kind: "physical-tool",
      target: {
        toolWidthMillimeters: 0.37,
        millimetersPerSceneUnit: 265 / FIXED_PAGE_PARITY_FRAME.width,
      },
    });
    clickButton(el, "Export Hidden-line SVG");
    await flush();
    const fixedPlotterBlob = downloadBlob.mock.calls.at(-1)![0];
    const fixedPlotterSvg = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(fixedPlotterBlob);
    });
    const fixedPlotterDocument = new DOMParser().parseFromString(fixedPlotterSvg, "image/svg+xml");
    const fixedRoot = fixedPlotterDocument.documentElement;
    const fixedPaths = [...fixedRoot.querySelectorAll(":scope > path")];
    expect(fixedRoot.getAttribute("width")).toBe("323mm");
    expect(fixedRoot.getAttribute("height")).toBe("217mm");
    expect(fixedRoot.getAttribute("viewBox")).toBe("0 0 323 217");
    expect(fixedPaths.map((path) => path.getAttribute("d"))).toEqual([
      "M70 34.9 L282 162.1",
      "M17 19 L282 19 L282 178 L17 178 L17 19",
    ]);
    expect(fixedPaths.map((path) => path.getAttribute("stroke-width"))).toEqual(["0.37", "0.37"]);
    expect(fixedPlotterSvg).not.toContain("#f4efe6");
    expect(fixedPlotterSvg).not.toMatch(/<rect\b/);

    // Undo the fixed operation and apply the identical frame through ordinary
    // scale-preserving editing. Its physical scale stays unchanged, so only the
    // paper extent/physical placement differs; the framed ordinary SVG remains
    // the same local Page geometry.
    expect(pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(lastCommittedPageFrame).toBeNull();
    clickButton(el, "Fill");
    clickButton(el, "Crop");
    for (const [name, value] of Object.entries({
      x: -10,
      y: 25,
      width: 50,
      height: 50,
    })) {
      setInput(el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!, String(value));
    }
    expect(lastPageFrameEditDraft?.mode).toBe("scale-preserving");
    clickButton(el, "Apply");
    expect(lastCommittedPageFrame).toEqual(FIXED_PAGE_PARITY_FRAME);
    expect(lastProfile).toEqual({
      ...FIXED_PAGE_PARITY_PROFILE,
      width: 190.5,
      height: 137.5,
    });
    expect(
      (lastProfile!.width - lastProfile!.insets.left - lastProfile!.insets.right) /
        FIXED_PAGE_PARITY_FRAME.width,
    ).toBeCloseTo(265 / FIXED_PAGE_PARITY_COMPOSITION.width, 12);
    expect(shadingJob.starts).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();

    clickButton(el, "Export SVG");
    const ordinaryScalePreservingSvg = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(downloadBlob.mock.calls.at(-1)![0]);
    });
    const ordinaryScalePreservingDocument = new DOMParser().parseFromString(
      ordinaryScalePreservingSvg,
      "image/svg+xml",
    );
    expect(ordinaryScalePreservingDocument.documentElement.getAttribute("viewBox")).toBe(
      `0 0 ${FIXED_PAGE_PARITY_FRAME.width} ${FIXED_PAGE_PARITY_FRAME.height}`,
    );
    expect(ordinaryScalePreservingDocument.querySelector(":root > path")?.getAttribute("d")).toBe(
      "M129.0994 38.7298 L645.4972 348.5685",
    );

    clickButton(el, "Outline");
    clickButton(el, "Export Hidden-line SVG");
    await flush();
    const ordinaryPlotterSvg = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(downloadBlob.mock.calls.at(-1)![0]);
    });
    const ordinaryPlotterDocument = new DOMParser().parseFromString(
      ordinaryPlotterSvg,
      "image/svg+xml",
    );
    const ordinaryRoot = ordinaryPlotterDocument.documentElement;
    const ordinaryPaths = [...ordinaryRoot.querySelectorAll(":scope > path")];
    expect(ordinaryRoot.getAttribute("width")).toBe("190.5mm");
    expect(ordinaryRoot.getAttribute("height")).toBe("137.5mm");
    expect(ordinaryPaths.map((path) => path.getAttribute("d"))).toEqual([
      "M43.5 26.95 L149.5 90.55",
      "M17 19 L149.5 19 L149.5 98.5 L17 98.5 L17 19",
    ]);
    expect(ordinaryPaths.map((path) => path.getAttribute("stroke-width"))).toEqual([
      "0.37",
      "0.37",
    ]);
  });

  it.each([
    ["crop", { x: 25, y: 20, width: 50, height: 60 }],
    ["padding", { x: -25, y: -10, width: 150, height: 120 }],
    ["mixed crop and padding", { x: 25, y: -10, width: 100, height: 80 }],
  ] as const)(
    "frames the acknowledged Shading Scene for %s ordinary SVG without recomputation",
    async (_label, percentages) => {
      const generate = vi.fn(toneCalibration.generate);
      const el = mount(
        <SketchControls sketch={{ ...toneCalibration, generate }} />,
      );
      await flush();
      const composition = lastCompositionFrame!;
      const source: Scene = {
        space: { ...composition },
        background: { color: "lavender" },
        primitives: [
          {
            points: [
              [0, composition.height / 2],
              [composition.width, composition.height / 2],
            ],
            stroke: { color: "black", width: 1 },
            hiddenLineRole: "source",
          },
        ],
      };
      await completeShading(0, source);
      const canvas = el.querySelector<HTMLElement>(
        '[data-testid="canvas-seed"]',
      )!;
      const sourceRevision = canvas.dataset.sourceInputRevision;
      const contentRevision = canvas.dataset.contentRevision;

      clickButton(el, "Crop");
      for (const [name, value] of Object.entries(percentages)) {
        setInput(
          el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!,
          String(value),
        );
      }
      clickButton(el, "Apply");

      const frame: PageFrame = {
        x: (composition.width * percentages.x) / 100,
        y: (composition.height * percentages.y) / 100,
        width: (composition.width * percentages.width) / 100,
        height: (composition.height * percentages.height) / 100,
      };
      expect(shadingJob.starts).toHaveLength(1);
      expect(generate).not.toHaveBeenCalled();
      expect(canvas.dataset.sourceInputRevision).toBe(sourceRevision);
      expect(canvas.dataset.contentRevision).toBe(contentRevision);

      clickButton(el, "Export SVG");

      const expected = frameScene(source, frame);
      expect(exportSceneCapture.current).toEqual(expected);
      expect(exportSceneCapture.current).not.toBe(source);
      expect((exportSceneCapture.current as Scene).space).toEqual({
        width: frame.width,
        height: frame.height,
      });
      expect((exportSceneCapture.current as Scene).background).toEqual({
        color: "lavender",
      });
      expect(
        (exportSceneCapture.current as Scene).primitives[0]?.points,
      ).toEqual(expected.primitives[0]?.points);
      const svg = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(downloadBlob.mock.calls.at(-1)![0]);
      });
      const document = new DOMParser().parseFromString(svg, "image/svg+xml");
      const root = document.documentElement;
      expect(root.getAttribute("viewBox")).toBe(
        `0 0 ${frame.width} ${frame.height}`,
      );
      expect(root.querySelector(":scope > rect")?.getAttribute("x")).toBe("0");
      expect(root.querySelector(":scope > rect")?.getAttribute("y")).toBe("0");
      expect(root.querySelector(":scope > rect")?.getAttribute("fill")).toBe(
        "lavender",
      );

      clickButton(el, "Export PNG");
      await flush();
      expect(shadingJob.starts).toHaveLength(1);
      expect(generate).not.toHaveBeenCalled();
      expect(canvas.dataset.sourceInputRevision).toBe(sourceRevision);
      expect(canvas.dataset.contentRevision).toBe(contentRevision);
    },
  );

  it("aborts framed Shading SVG when the retained canvas provenance is stale", async () => {
    const generate = vi.fn(toneCalibration.generate);
    const el = mount(
      <SketchControls sketch={{ ...toneCalibration, generate }} />,
    );
    await flush();
    const source = preparedScene(78);
    await completeShading(0, source);

    clickButton(el, "Crop");
    setInput(el.querySelector<HTMLInputElement>('input[name="x"]')!, "10");
    clickButton(el, "Apply");
    fakeDisplayedScene = {
      scene: source,
      sourceScene: source,
      displayedScene: source,
      t: 0,
      renderMode: "fill",
      tolerance: 0,
      includeFrame: true,
      sourceInputRevision: 0,
      contentRevision: 999,
    };

    clickButton(el, "Export SVG");

    expect(exportSceneCapture.current).toBeNull();
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(shadingJob.starts).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it("reuses one Shading and Outline base through repeated Page history, frame visibility, and exports", async () => {
    autoFireOutlineComputed = false;
    const generate = vi.fn(toneCalibration.generate);
    const el = mount(
      <SketchControls sketch={{ ...toneCalibration, generate }} />,
    );
    await flush();
    const source = preparedScene(79);
    await completeShading(0, source);

    clickButton(el, "Outline");
    expect(outlineJob.starts).toBe(1);
    act(() => lastOnOutlineComputed?.());

    const composition = lastCompositionFrame!;
    clickButton(el, "Crop");
    for (const [name, value] of Object.entries({
      x: 12.5,
      y: -10,
      width: 80,
      height: 115,
    })) {
      setInput(
        el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!,
        String(value),
      );
    }
    clickButton(el, "Apply");
    const expectedFrame: PageFrame = {
      x: composition.width * 0.125,
      y: composition.height * -0.1,
      width: composition.width * 0.8,
      height: composition.height * 1.15,
    };

    clickButton(el, "Export Hidden-line SVG");
    await flush();

    const first = outlineJob.lastExportSnapshot!;
    expect(first.pageFrame).toEqual(expectedFrame);
    expect(first.pageFrame).not.toBe(lastCommittedPageFrame);
    expect(Object.isFrozen(first.pageFrame)).toBe(true);
    expect(first.identity).not.toHaveProperty("pageFrame");
    expect(first.identity).not.toHaveProperty("includeFrame");
    expect(first.reusableOutline).toBeDefined();
    expect(outlineJob.exportDerivations).toBe(0);
    expect(outlineJob.starts).toBe(1);

    act(() => compositionFrameCheckbox(el).click());
    clickButton(el, "Export Hidden-line SVG");
    await flush();

    expect(outlineJob.lastExportSnapshot?.pageFrame).toEqual(expectedFrame);
    expect(outlineJob.lastExportSnapshot?.profile.includeFrame).toBe(false);
    expect(outlineJob.lastExportSnapshot?.reusableOutline).toBeDefined();
    expect(outlineJob.exportDerivations).toBe(0);
    expect(outlineJob.starts).toBe(1);
    expect(shadingJob.starts).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();

    const exportAndExpectFrame = async (pageFrame: PageFrame | null) => {
      clickButton(el, "Export Hidden-line SVG");
      await flush();
      expect(outlineJob.lastExportSnapshot?.pageFrame).toEqual(pageFrame);
      expect(outlineJob.lastExportSnapshot?.reusableOutline).toBeDefined();
      expect(outlineJob.exportDerivations).toBe(0);
      expect(outlineJob.starts).toBe(1);
      expect(shadingJob.starts).toHaveLength(1);
      expect(generate).not.toHaveBeenCalled();
    };

    // Reset, Undo, and Redo traverse only cheap finalization state. Export each
    // settled state so reuse is proven at the actual worker boundary, not merely
    // inferred from the preview job count.
    clickButton(el, "Crop");
    clickButton(el, "Reset Frame");
    await exportAndExpectFrame(null);

    expect(
      pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    await exportAndExpectFrame(expectedFrame);

    expect(
      pressHistoryShortcut(window, { key: "y", ctrlKey: true })
        .defaultPrevented,
    ).toBe(true);
    await exportAndExpectFrame(null);

    // Re-apply an asymmetric mixed crop/pad frame, export it repeatedly, then
    // restore the Page boundary. None is a generation or derivation identity.
    clickButton(el, "Crop");
    for (const [name, value] of Object.entries({
      x: -20,
      y: 10,
      width: 130,
      height: 75,
    })) {
      setInput(
        el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!,
        String(value),
      );
    }
    clickButton(el, "Apply");
    const asymmetricFrame: PageFrame = {
      x: composition.width * -0.2,
      y: composition.height * 0.1,
      width: composition.width * 1.3,
      height: composition.height * 0.75,
    };
    await exportAndExpectFrame(asymmetricFrame);
    await exportAndExpectFrame(asymmetricFrame);

    act(() => compositionFrameCheckbox(el).click());
    expect(outlineJob.lastExportSnapshot?.profile.includeFrame).toBe(false);
    await exportAndExpectFrame(asymmetricFrame);
    expect(outlineJob.lastExportSnapshot?.profile.includeFrame).toBe(true);
    expect(outlineJob.exportStarts).toBe(8);
    expect(outlineJob.exportFinalizations).toBe(8);
  });

  const assetA = "portrait-alpha-000000000001";
  const assetB = "portrait-beta-bbbbbbbbbbbb";

  function resolvedAssetEnvironment(
    id: string,
    gray: number,
  ): SketchEnvironment {
    const pixels = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([gray, gray, gray, 255]),
    };
    return {
      imageAssets: (requested) => (requested === id ? pixels : undefined),
    };
  }

  function managedPhotoScribble(
    generateToneSource: NonNullable<typeof photoScribble.generateToneSource>,
  ) {
    return {
      ...photoScribble,
      schema: {
        ...photoScribble.schema,
        imageAsset: { kind: "image-asset", default: assetA },
      } satisfies ParamSchema,
      generateToneSource,
    };
  }

  function renderModeButtons(el: HTMLElement): HTMLButtonElement[] {
    return [
      ...el.querySelectorAll<HTMLButtonElement>(
        '[role="group"][aria-label="Render mode"] button',
      ),
    ];
  }

  function renderState(el: HTMLElement): string | undefined {
    return el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')?.dataset
      .renderState;
  }

  async function resolveManagedEnvironment(
    id = assetA,
    gray = 96,
    index = 0,
  ): Promise<void> {
    await act(async () => {
      sketchEnvironmentJob.starts[index]!.resolve(
        resolvedAssetEnvironment(id, gray),
      );
      await Promise.resolve();
    });
  }

  it("shows capability-based atomic modes, adding Detail only to Detail-capable Photo Scribble", async () => {
    const el = mount(
      <SketchControls
        key="photo"
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await resolveManagedEnvironment();

    expect(renderModeButtons(el).map(({ textContent }) => textContent)).toEqual([
      "Fill",
      "Outline",
      "Tone",
      "Detail",
    ]);
    const pressed = () =>
      renderModeButtons(el)
        .filter((button) => button.getAttribute("aria-pressed") === "true")
        .map(({ textContent }) => textContent);
    expect(pressed()).toEqual(["Fill"]);

    clickButton(el, "Tone");
    expect(pressed()).toEqual(["Tone"]);
    clickButton(el, "Detail");
    expect(pressed()).toEqual(["Detail"]);
    clickButton(el, "Outline");
    expect(pressed()).toEqual(["Outline"]);
    clickButton(el, "Fill");
    expect(pressed()).toEqual(["Fill"]);
    expect(historyCapture.atomic).toHaveLength(0);
    expect(historyCapture.transactionCommits).toHaveLength(0);

    act(() => {
      root!.render(<SketchControls key="calibration" sketch={toneCalibration} />);
    });
    expect(renderModeButtons(el).map(({ textContent }) => textContent)).toEqual([
      "Fill",
      "Outline",
      "Tone",
    ]);

    act(() => {
      root!.render(<SketchControls key="moon" sketch={scribbleMoon} />);
    });
    expect(renderModeButtons(el).map(({ textContent }) => textContent)).toEqual([
      "Fill",
      "Outline",
      "Tone",
    ]);

    act(() => {
      root!.render(<SketchControls key="plain" sketch={sketchWith("plain", {})} />);
    });
    expect(renderModeButtons(el)).toHaveLength(0);
    expect(
      el.querySelector('[aria-label="Toggle outline render mode"]'),
    ).not.toBeNull();
    expect(el.querySelector('[aria-label="Show Detail reference"]')).toBeNull();
  });

  it("shows Detail loading and safe failure, and retries only Detail preparation", async () => {
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await resolveManagedEnvironment();
    const shadingStarts = shadingJob.starts.length;

    clickButton(el, "Detail");
    expect(renderState(el)).toBe("detail-reference-loading");
    const first = detailJob.starts[0]!;
    await act(async () => {
      detailJob.active = null;
      first.resolve({
        status: "failure",
        jobId: 1,
        identity: first.identity,
        error: "analysis unavailable",
      });
      await Promise.resolve();
    });
    expect(renderState(el)).toBe("detail-reference-failure");
    expect(lastDetailRetry).not.toBeNull();

    act(() => lastDetailRetry?.());
    expect(renderState(el)).toBe("detail-reference-loading");
    expect(detailJob.starts).toHaveLength(2);
    expect(shadingJob.starts).toHaveLength(shadingStarts);
    expect(outlineJob.starts).toBe(0);
  });

  it("cancels active Detail analysis and replaces it by exact asset identity", async () => {
    managedImageAssetJob.list.mockResolvedValue([
      { id: assetA, name: "portrait alpha", url: `/image-assets/${assetA}.png` },
      { id: assetB, name: "portrait beta", url: `/image-assets/${assetB}.png` },
    ]);
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await resolveManagedEnvironment();
    clickButton(el, "Detail");
    expect(detailJob.starts[0]!.identity.imageAssetId).toBe(assetA);

    const assetBChoice = await openAssetBChoice(el);
    act(() => assetBChoice.click());
    expect(detailJob.cancelCount).toBe(1);
    expect(detailJob.starts).toHaveLength(2);
    expect(detailJob.starts[1]!.identity.imageAssetId).toBe(assetB);
    expect(renderState(el)).toBe("unavailable");

    await resolveManagedEnvironment(assetB, 192, 1);
    expect(detailJob.starts).toHaveLength(2);
    expect(renderState(el)).toBe("detail-reference-loading");
    await completeDetail(1, 192);
    expect(renderState(el)).toBe("detail-reference");
  });

  it("unrequests active Detail when a Preset authors a malformed asset identity", async () => {
    const malformed = "../portrait alpha.png?raw=1";
    listPresets.mockResolvedValue(["malformed", "valid"]);
    loadPreset.mockImplementation(async (_sketchId, name) => ({
      version: 2,
      sketch: photoScribble.id,
      name,
      seed: 22,
      params: {
        ...defaultParams(photoScribble.schema),
        imageAsset: name === "malformed" ? malformed : assetA,
      },
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    }));
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await resolveManagedEnvironment();
    await flush();
    clickButton(el, "Detail");
    expect(detailJob.starts).toHaveLength(1);

    // Model a worker that wins its race with cancellation and reports success.
    // Dropping session ownership must still reject that obsolete completion.
    detailJob.resolveOnCancel = false;
    const picker = el.querySelector<HTMLSelectElement>(
      'select[aria-label="saved presets"]',
    )!;
    const selectPreset = (name: string) => {
      act(() => {
        picker.value = name;
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      });
      clickButton(el, "Reload");
    };
    selectPreset("malformed");
    await flush();

    expect(detailJob.cancelCount).toBe(1);
    expect(detailJob.active).toBeNull();
    expect(detailJob.starts).toHaveLength(1);
    expect(renderState(el)).toBe("unavailable");
    await completeDetail(0, 192);
    expect(lastDetailField).toBeNull();
    expect(renderState(el)).toBe("unavailable");
    expect(detailJob.starts).toHaveLength(1);

    // Re-selecting a valid identity must launch again: the late A completion
    // was neither accepted for paint nor retained in the exact-result cache.
    selectPreset("valid");
    await flush();
    expect(detailJob.starts).toHaveLength(2);
    expect(detailJob.starts[1]!.identity.imageAssetId).toBe(assetA);
    expect(renderState(el)).toBe("unavailable");
    await resolveManagedEnvironment(assetA, 96, 2);
    await completeDetail(1, 96);
    expect(renderState(el)).toBe("detail-reference");
  });

  it("keeps sensitivity-only edits outside Fill, Outline, and Shading provenance", async () => {
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await resolveManagedEnvironment();
    await completeShading(0, preparedScene(94));
    const canvas = el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!;
    const initialProvenance = {
      sourceInputRevision: canvas.dataset.sourceInputRevision,
      contentRevision: canvas.dataset.contentRevision,
    };
    const sensitivity = paramInput(el, "detailSensitivity");
    const editSensitivity = (value: string) => {
      act(() => sensitivity.focus());
      setInput(sensitivity, value);
      act(() => sensitivity.blur());
    };

    editSensitivity("0.6");
    expect(shadingJob.starts).toHaveLength(1);
    expect(shadingJob.cancelCount).toBe(0);
    expect(canvas.dataset.sourceInputRevision).toBe(
      initialProvenance.sourceInputRevision,
    );
    expect(canvas.dataset.contentRevision).toBe(
      initialProvenance.contentRevision,
    );
    expect(exportButton(el, "Export SVG").disabled).toBe(false);

    clickButton(el, "Outline");
    const retainedOutline = outlineJob.lastCompletedScene;
    expect(outlineJob.starts).toBe(1);
    expect(outlineJob.lastIdentity?.params).toContainEqual({
      key: "detailSensitivity",
      value: 0.5,
    });
    expect(canvas.dataset.renderMode).toBe("outline");
    editSensitivity("0.7");
    expect(outlineJob.starts).toBe(1);
    expect(outlineJob.lastCompletedScene).toBe(retainedOutline);
    expect(canvas.dataset.renderMode).toBe("outline");
    expect(canvas.dataset.sourceInputRevision).toBe(
      initialProvenance.sourceInputRevision,
    );
    expect(canvas.dataset.contentRevision).toBe(
      initialProvenance.contentRevision,
    );
    expect(exportButton(el, "Export Hidden-line SVG").disabled).toBe(false);

    clickButton(el, "Detail");
    await completeDetail(0);
    editSensitivity("0.8");
    clickButton(el, "Fill");
    await flush();
    expect(shadingJob.starts).toHaveLength(1);
    expect(shadingJob.cancelCount).toBe(0);
    expect(canvas.dataset.sourceInputRevision).toBe(
      initialProvenance.sourceInputRevision,
    );
    expect(canvas.dataset.contentRevision).toBe(
      initialProvenance.contentRevision,
    );
    expect(exportButton(el, "Export SVG").disabled).toBe(false);
  });

  it("replaces positive-influence artwork and carries its completed Scene through Fill and both exports", async () => {
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await resolveManagedEnvironment();
    await completeShading(0, preparedScene(95));

    const influence = paramInput(el, "detailInfluence");
    act(() => influence.focus());
    setInput(influence, "0.5");
    act(() => influence.blur());
    expect(shadingJob.starts).toHaveLength(2);
    await completeShading(1, preparedScene(96));

    const sensitivity = paramInput(el, "detailSensitivity");
    act(() => sensitivity.focus());
    setInput(sensitivity, "0.8");
    act(() => sensitivity.blur());

    expect(shadingJob.starts).toHaveLength(3);
    expect(shadingJob.starts[2]!.identity.params).toContainEqual({
      key: "detailSensitivity",
      value: 0.8,
    });
    const detailScene = preparedScene(97);
    await completeShading(2, detailScene);

    expect(lastRenderScene).toBe(detailScene);
    clickButton(el, "Export SVG");
    expect(exportSceneCapture.current).toBe(detailScene);

    clickButton(el, "Outline");
    expect(outlineJob.starts).toBe(1);
    expect(outlineJob.lastIdentity?.params).toContainEqual({
      key: "detailSensitivity",
      value: 0.8,
    });
    expect(outlineJob.lastIdentity).toMatchObject({
      sourceKind: "legacy-scene",
      sourceScene: detailScene,
    });

    clickButton(el, "Export Hidden-line SVG");
    await flush();
    expect(outlineJob.exportStarts).toBe(1);
    expect(outlineJob.lastExportSnapshot?.identity).toMatchObject({
      sourceKind: "legacy-scene",
      sourceScene: detailScene,
    });
    expect(outlineJob.lastExportSnapshot?.reusableOutline).toBeDefined();
    expect(plotterExportCapture.current?.scene).toEqual(
      finalizedPlotterScene(outlineJob.lastCompletedScene!),
    );
  });

  it("retains visibly stale artwork after required Detail failure and retries only the current identity", async () => {
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await resolveManagedEnvironment();
    const retainedScene = preparedScene(98);
    await completeShading(0, retainedScene);

    const influence = paramInput(el, "detailInfluence");
    act(() => influence.focus());
    setInput(influence, "0.5");
    act(() => influence.blur());
    const longFailure = `analysis failed: ${"x".repeat(700)}`;
    await failShading(1, longFailure);

    const diagnosticsPanel = shadingDisclosure(el);
    expect(lastRenderScene).toBe(retainedScene);
    expect(diagnosticsPanel.textContent).toContain("Displayed result: stale");
    expect(diagnosticsPanel.textContent).toContain("analysis failed:");
    expect(diagnosticsPanel.textContent).not.toContain(longFailure);
    expect(
      ["Export PNG", "Export SVG", "Export Hidden-line SVG"].map(
        (label) => exportButton(el, label).disabled,
      ),
    ).toEqual([true, true, true]);

    clickButton(el, "Outline");
    expect(outlineJob.starts).toBe(0);
    expect(lastRenderScene).toBe(retainedScene);
    clickButton(el, "Fill");

    clickButton(el, "Retry");
    expect(shadingJob.starts).toHaveLength(3);
    expect(shadingJob.starts[2]!.identity).toEqual(
      shadingJob.starts[1]!.identity,
    );
    expect(diagnosticsPanel.textContent).toContain("Preparing replacement");
    expect(diagnosticsPanel.textContent).not.toContain("Preparation failed:");
  });

  it("keeps Detail pixels exactly independent of tone controls and Seed", async () => {
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await resolveManagedEnvironment();
    clickButton(el, "Detail");
    await completeDetail(0);
    const points: [number, number][] = [
      [0, 0],
      [lastCompositionFrame!.width / 2, lastCompositionFrame!.height / 2],
      [lastCompositionFrame!.width, lastCompositionFrame!.height],
    ];
    const samples = () => points.map((point) => lastDetailField!.sample(point));
    const before = samples();

    for (const [key, value] of [
      ["toneGamma", "0.1"],
      ["toneContrast", "0.9"],
      ["tonePivot", "0.2"],
    ] as const) {
      const input = paramInput(el, key);
      act(() => input.focus());
      setInput(input, value);
      act(() => input.blur());
    }
    vi.spyOn(Math, "random").mockReturnValue(0.75);
    clickButton(el, "New seed");

    expect(samples()).toEqual(before);
    expect(detailJob.starts).toHaveLength(1);
  });

  it("binds Detail to the active Composition Frame while Page framing remains display-only", async () => {
    const generateDetailField = vi.fn(photoScribble.generateDetailField!);
    const el = mount(
      <SketchControls
        sketch={{
          ...managedPhotoScribble(photoScribble.generateToneSource!),
          generateDetailField,
        }}
      />,
    );
    await resolveManagedEnvironment();
    const composition = { ...lastCompositionFrame! };
    clickButton(el, "Detail");
    await completeDetail(0);
    expect(generateDetailField.mock.calls.at(-1)?.[1]).toEqual(composition);

    clickButton(el, "Crop");
    for (const [name, value] of Object.entries({
      x: 10,
      y: 20,
      width: 60,
      height: 50,
    })) {
      setInput(
        el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!,
        String(value),
      );
    }
    clickButton(el, "Apply");

    expect(lastCommittedPageFrame).toEqual({
      x: composition.width * 0.1,
      y: composition.height * 0.2,
      width: composition.width * 0.6,
      height: composition.height * 0.5,
    });
    expect(generateDetailField.mock.calls.at(-1)?.[1]).toEqual(composition);
    expect(lastCompositionFrame).toEqual(composition);
    expect(detailJob.starts).toHaveLength(1);
    expect(renderState(el)).toBe("detail-reference");
  });

  it("threads Detail sensitivity through lock, Randomize, Undo/Redo, and current Preset reload", async () => {
    listPresets.mockResolvedValue(["detail-current"]);
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await resolveManagedEnvironment();
    await flush();
    const sensitivity = paramInput(el, "detailSensitivity");
    act(() => sensitivity.focus());
    setInput(sensitivity, "0.73");
    act(() => sensitivity.blur());

    const lock = el.querySelector<HTMLButtonElement>(
      'button[aria-label="detailSensitivity lock"]',
    )!;
    act(() => lock.click());
    vi.spyOn(Math, "random").mockReturnValue(0.12);
    clickButton(el, "Randomize");
    expect(paramInput(el, "detailSensitivity").value).toBe("0.73");

    act(() => lock.click());
    vi.mocked(Math.random).mockReturnValue(0.25);
    clickButton(el, "Randomize");
    expect(paramInput(el, "detailSensitivity").value).toBe("0.25");
    pressHistoryShortcut(window, { ctrlKey: true });
    expect(paramInput(el, "detailSensitivity").value).toBe("0.73");
    pressHistoryShortcut(window, { key: "y", ctrlKey: true });
    expect(paramInput(el, "detailSensitivity").value).toBe("0.25");

    clickButton(el, "Detail");
    await completeDetail(0);
    expect(renderState(el)).toBe("detail-reference");
    setInput(
      el.querySelector<HTMLInputElement>('input[aria-label="preset name"]')!,
      "detail-current",
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    clickButton(el, "Save");
    await flush();
    const saved = savePreset.mock.calls.at(-1)![0];
    expect(saved.params.detailSensitivity).toBe(0.25);
    expect(JSON.stringify(saved)).not.toMatch(/diagnostic|reference|renderMode/i);
    loadPreset.mockResolvedValue(saved);

    const changed = paramInput(el, "detailSensitivity");
    act(() => changed.focus());
    setInput(changed, "0.91");
    act(() => changed.blur());
    const picker = el.querySelector<HTMLSelectElement>(
      'select[aria-label="saved presets"]',
    )!;
    act(() => {
      picker.value = "detail-current";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    clickButton(el, "Reload");
    await flush();
    expect(paramInput(el, "detailSensitivity").value).toBe("0.25");
    expect(renderState(el)).toBe("detail-reference");
    clickButton(el, "Outline");
    expect(
      renderModeButtons(el).find(({ textContent }) => textContent === "Outline")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    clickButton(el, "Fill");
    expect(
      renderModeButtons(el).find(({ textContent }) => textContent === "Fill")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("blocks same-batch Detail PNG, ordinary SVG, and plotter SVG handlers", async () => {
    const toBlob = vi.fn();
    fakeCanvasToBlob = toBlob as HTMLCanvasElement["toBlob"];
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await resolveManagedEnvironment();
    await completeShading(0, preparedScene(117));
    const detail = renderModeButtons(el).find(
      ({ textContent }) => textContent === "Detail",
    )!;
    const exports = ["Export PNG", "Export SVG", "Export Hidden-line SVG"].map(
      (label) =>
        [...el.querySelectorAll<HTMLButtonElement>("button")].find(
          ({ textContent }) => textContent === label,
        )!,
    );

    act(() => {
      detail.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      for (const action of exports) {
        action.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });
    await flush();
    expect(renderState(el)).toBe("detail-reference-loading");
    expect(toBlob).not.toHaveBeenCalled();
    expect(exportSceneCapture.current).toBeNull();
    expect(outlineJob.exportStarts).toBe(0);
    expect(downloadBlob).not.toHaveBeenCalled();

    await completeDetail(0);
    expect(renderState(el)).toBe("detail-reference");
    for (const action of exports) expect(action.disabled).toBe(true);
    exposeAndClick(exports);
    await flush();
    expect(toBlob).not.toHaveBeenCalled();
    expect(exportSceneCapture.current).toBeNull();
    expect(outlineJob.exportStarts).toBe(0);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("suspends Shading before requesting Detail and rejects stale pre-entry paint", async () => {
    const generateDetailField = vi.fn(photoScribble.generateDetailField!);
    const el = mount(
      <SketchControls
        sketch={{
          ...managedPhotoScribble(photoScribble.generateToneSource!),
          generateDetailField,
        }}
      />,
    );
    await act(async () => {
      sketchEnvironmentJob.starts[0]!.resolve(
        resolvedAssetEnvironment(assetA, 96),
      );
      await Promise.resolve();
    });
    expect(shadingJob.starts).toHaveLength(1);
    expect(detailJob.starts).toHaveLength(0);

    orchestrationEvents.length = 0;
    clickButton(el, "Detail");
    expect(orchestrationEvents).toEqual(["shading:cancel", "detail:start"]);
    expect(detailJob.starts[0]!.identity).toEqual({
      imageAssetId: assetA,
      analysisDefinitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
    });
    expect(
      el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!.dataset
        .renderState,
    ).toBe("detail-reference-loading");

    await completeShading(0, preparedScene(91));
    expect(
      el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!.dataset
        .renderState,
    ).toBe("detail-reference-loading");
    expect(lastRenderScene).toBeNull();

    await completeDetail(0);
    expect(
      el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!.dataset
        .renderState,
    ).toBe("detail-reference");
    expect(lastDetailField).not.toBeNull();
    expect(generateDetailField).toHaveBeenCalledOnce();

    clickButton(el, "Fill");
    await flush();
    expect(orchestrationEvents.at(-1)).toBe("shading:start");
    expect(shadingJob.starts).toHaveLength(2);
  });

  it("cancels Detail on exit and starts no analysis for later inactive asset changes", async () => {
    managedImageAssetJob.list.mockResolvedValue([
      { id: assetA, name: "portrait alpha", url: `/image-assets/${assetA}.png` },
      { id: assetB, name: "portrait beta", url: `/image-assets/${assetB}.png` },
    ]);
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await act(async () => {
      sketchEnvironmentJob.starts[0]!.resolve(
        resolvedAssetEnvironment(assetA, 64),
      );
      await Promise.resolve();
    });

    clickButton(el, "Detail");
    expect(detailJob.starts).toHaveLength(1);
    clickButton(el, "Fill");
    expect(detailJob.cancelCount).toBe(1);
    expect(detailJob.active).toBeNull();

    await completeDetail(0);
    expect(
      el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!.dataset
        .renderState,
    ).not.toBe("detail-reference");

    const assetBChoice = await openAssetBChoice(el);
    act(() => assetBChoice.click());
    expect(detailJob.starts).toHaveLength(1);
    await act(async () => {
      sketchEnvironmentJob.starts[1]!.resolve(
        resolvedAssetEnvironment(assetB, 192),
      );
      await Promise.resolve();
    });
    expect(detailJob.starts).toHaveLength(1);
  });

  it("reuses one Detail analysis across authored edits and resumes one latest Shading for Outline", async () => {
    managedImageAssetJob.list.mockResolvedValue([
      { id: assetA, name: "portrait alpha", url: `/image-assets/${assetA}.png` },
      { id: assetB, name: "portrait beta", url: `/image-assets/${assetB}.png` },
    ]);
    const generateDetailField = vi.fn(photoScribble.generateDetailField!);
    const el = mount(
      <SketchControls
        sketch={{
          ...managedPhotoScribble(photoScribble.generateToneSource!),
          generateDetailField,
        }}
      />,
    );
    await act(async () => {
      sketchEnvironmentJob.starts[0]!.resolve(
        resolvedAssetEnvironment(assetA, 64),
      );
      await Promise.resolve();
    });
    await completeShading(0, preparedScene(92));
    clickButton(el, "Detail");
    await completeDetail(0);

    for (const [key, value] of [
      ["detailSensitivity", "0.8"],
      ["toneContrast", "0.2"],
    ] as const) {
      const input = paramInput(el, key);
      act(() => input.focus());
      setInput(input, value);
      act(() => input.blur());
    }
    clickButton(el, "New seed");
    expect(detailJob.starts).toHaveLength(1);
    expect(shadingJob.starts).toHaveLength(1);
    expect(generateDetailField.mock.calls.length).toBeGreaterThan(1);

    const assetBChoice = await openAssetBChoice(el);
    act(() => assetBChoice.click());
    expect(shadingJob.starts).toHaveLength(1);
    expect(detailJob.starts).toHaveLength(2);
    expect(detailJob.starts[1]!.identity.imageAssetId).toBe(assetB);
    await act(async () => {
      sketchEnvironmentJob.starts[1]!.resolve(
        resolvedAssetEnvironment(assetB, 192),
      );
      await Promise.resolve();
    });
    expect(detailJob.starts).toHaveLength(2);
    expect(shadingJob.starts).toHaveLength(1);
    await completeDetail(1, 192);

    clickButton(el, "Outline");
    await flush();
    expect(shadingJob.starts).toHaveLength(2);
    expect(outlineJob.starts).toBe(0);
    await completeShading(1, preparedScene(93));
    await flush();
    expect(outlineJob.starts).toBe(1);
  });

  it("resumes no Shading work when Detail exits with authored inputs already current", async () => {
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await act(async () => {
      sketchEnvironmentJob.starts[0]!.resolve(
        resolvedAssetEnvironment(assetA, 80),
      );
      await Promise.resolve();
    });
    await completeShading(0, preparedScene(94));
    clickButton(el, "Detail");
    await completeDetail(0);
    clickButton(el, "Fill");
    await flush();
    expect(shadingJob.starts).toHaveLength(1);

    clickButton(el, "Detail");
    await flush();
    expect(detailJob.starts).toHaveLength(1);
    expect(
      el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!.dataset
        .renderState,
    ).toBe("detail-reference");
    clickButton(el, "Fill");
    expect(shadingJob.starts).toHaveLength(1);
  });

  it("turns synchronous Detail binding assertions into retryable safe failure", async () => {
    const generateDetailField = vi.fn(() => {
      throw new TypeError("malformed prepared binding");
    });
    const el = mount(
      <SketchControls
        sketch={{
          ...managedPhotoScribble(photoScribble.generateToneSource!),
          generateDetailField,
        }}
      />,
    );
    await act(async () => {
      sketchEnvironmentJob.starts[0]!.resolve(
        resolvedAssetEnvironment(assetA, 112),
      );
      await Promise.resolve();
    });
    clickButton(el, "Detail");
    await completeDetail(0);

    expect(
      el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!.dataset
        .renderState,
    ).toBe("detail-reference-failure");
    expect(lastDetailField).toBeNull();
    expect(lastDetailRetry).not.toBeNull();

    act(() => lastDetailRetry?.());
    expect(detailJob.starts).toHaveLength(2);
    expect(
      el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!.dataset
        .renderState,
    ).toBe("detail-reference-loading");
  });

  it.each(["asset", "analysis definition"] as const)(
    "fails closed when Detail asks for a mismatched %s",
    async (mismatch) => {
      const generateDetailField = vi.fn(
        (
          params: Parameters<
            NonNullable<typeof photoScribble.generateDetailField>
          >[0],
          frame: Parameters<
            NonNullable<typeof photoScribble.generateDetailField>
          >[1],
          environment: Parameters<
            NonNullable<typeof photoScribble.generateDetailField>
          >[2],
        ) => {
          environment!.getPreparedImageDetailAnalysis!(
            mismatch === "asset" ? assetB : assetA,
            mismatch === "analysis definition"
              ? ("wrong-analysis" as typeof IMAGE_DETAIL_ANALYSIS_DEFINITION_ID)
              : IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
          );
          return photoScribble.generateDetailField!(
            params,
            frame,
            environment,
          );
        },
      );
      const el = mount(
        <SketchControls
          sketch={{
            ...managedPhotoScribble(photoScribble.generateToneSource!),
            generateDetailField,
          }}
        />,
      );
      await act(async () => {
        sketchEnvironmentJob.starts[0]!.resolve(
          resolvedAssetEnvironment(assetA, 112),
        );
        await Promise.resolve();
      });
      clickButton(el, "Detail");
      await completeDetail(0);

      expect(
        el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!.dataset
          .renderState,
      ).toBe("detail-reference-failure");
      expect(lastDetailField).toBeNull();
      expect(lastDetailRetry).not.toBeNull();
    },
  );

  function chooseImageFile(el: HTMLElement, name = "Imported Beta.webp"): void {
    const input = el.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("no Image Asset file input");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["source"], name, { type: "image/webp" })],
    });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
  }

  async function openAssetBChoice(el: HTMLElement): Promise<HTMLButtonElement> {
    clickButton(el, "Choose image");
    await flush();
    const choice = [
      ...el.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Image Assets"] button',
      ),
    ].find((button) => button.textContent?.includes("portrait beta"));
    if (choice === undefined) throw new Error("no portrait beta choice");
    return choice;
  }

  function exposeAndClick(buttons: readonly HTMLButtonElement[]): void {
    for (const button of buttons) {
      button.disabled = false;
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  }

  it("carries an imported Photo Scribble asset through one undoable atomic edit into exact Tone and payload-free worker inputs", async () => {
    const generateToneSource = vi.fn(
      (
        ...args: Parameters<
          NonNullable<typeof photoScribble.generateToneSource>
        >
      ) =>
        photoScribble.generateToneSource!(...args),
    );
    managedImageAssetJob.import.mockResolvedValueOnce({
      id: assetB,
      created: true,
    });
    const el = mount(
      <SketchControls sketch={managedPhotoScribble(generateToneSource)} />,
    );
    const environmentA = resolvedAssetEnvironment(assetA, 32);
    await act(async () => {
      sketchEnvironmentJob.starts[0]!.resolve(environmentA);
      await Promise.resolve();
    });
    expect(shadingJob.starts).toHaveLength(1);
    clickButton(el, "Tone");
    expect(generateToneSource.mock.calls.at(-1)?.[2]).toBe(environmentA);
    expect(lastToneSource).not.toBeNull();

    clickButton(el, "Choose image");
    await flush();
    chooseImageFile(el);
    clickButton(el, "Import Image Asset");
    await flush();
    await flush();
    await flush();

    expect(managedImageAssetJob.normalize).toHaveBeenCalledTimes(1);
    expect(managedImageAssetJob.import).toHaveBeenCalledTimes(1);
    expect(
      el.querySelector('[aria-label="imageAsset image asset identity"]')
        ?.textContent,
    ).toBe(assetB);
    expect(historyCapture.atomic).toHaveLength(1);
    expect(historyCapture.atomic[0]!.before.present.params.imageAsset).toBe(
      assetA,
    );
    expect(historyCapture.atomic[0]!.after.present.params.imageAsset).toBe(
      assetB,
    );

    // B makes A unusable in the selection render itself. The replacement
    // resolver owns a fresh signal, and no B worker request can escape while
    // that exact decoded environment remains unresolved.
    expect(sketchEnvironmentJob.starts).toHaveLength(2);
    expect(sketchEnvironmentJob.starts[0]!.signal.aborted).toBe(true);
    expect(sketchEnvironmentJob.starts[1]!.params.imageAsset).toBe(assetB);
    expect(lastToneSource).toBeNull();
    expect(shadingJob.starts).toHaveLength(1);

    const environmentB = resolvedAssetEnvironment(assetB, 224);
    await act(async () => {
      sketchEnvironmentJob.starts[1]!.resolve(environmentB);
      await Promise.resolve();
    });

    expect(generateToneSource.mock.calls.at(-1)?.[2]).toBe(environmentB);
    expect(lastToneSource).not.toBeNull();
    expect(shadingJob.starts).toHaveLength(2);
    const workerIdentity = shadingJob.starts[1]!.identity;
    expect(isShadingComputeIdentity(workerIdentity)).toBe(true);
    expect(workerIdentity.params).toContainEqual({
      key: "imageAsset",
      value: assetB,
    });
    expect(Object.keys(workerIdentity)).toEqual([
      "sketchId",
      "params",
      "seed",
      "compositionFrame",
    ]);
    expect(containsBinaryPayload(workerIdentity)).toBe(false);
    expect(
      workerIdentity.params.every(
        ({ value }) => typeof value === "string" || typeof value === "number",
      ),
    ).toBe(true);

    expect(
      pressHistoryShortcut(window, { ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    expect(
      el.querySelector('[aria-label="imageAsset image asset identity"]')
        ?.textContent,
    ).toBe(assetA);
    expect(sketchEnvironmentJob.starts).toHaveLength(3);
    expect(sketchEnvironmentJob.starts[1]!.signal.aborted).toBe(true);
    expect(shadingJob.starts).toHaveLength(2);

    const environmentAAfterUndo = resolvedAssetEnvironment(assetA, 32);
    await act(async () => {
      sketchEnvironmentJob.starts[2]!.resolve(environmentAAfterUndo);
      await Promise.resolve();
    });
    expect(shadingJob.starts).toHaveLength(3);
    expect(shadingJob.starts[2]!.identity.params).toContainEqual({
      key: "imageAsset",
      value: assetA,
    });
  });

  it("routes a persisted asset reselected after catalog refresh through the same exact environment gate", async () => {
    managedImageAssetJob.list
      .mockResolvedValueOnce([
        {
          id: assetA,
          name: "portrait alpha",
          url: `/image-assets/${assetA}.png`,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: assetA,
          name: "portrait alpha",
          url: `/image-assets/${assetA}.png`,
        },
        {
          id: assetB,
          name: "portrait beta",
          url: `/image-assets/${assetB}.png`,
        },
      ]);
    const generateToneSource = vi.fn(
      (
        ...args: Parameters<
          NonNullable<typeof photoScribble.generateToneSource>
        >
      ) =>
        photoScribble.generateToneSource!(...args),
    );
    const el = mount(
      <SketchControls sketch={managedPhotoScribble(generateToneSource)} />,
    );
    const environmentA = resolvedAssetEnvironment(assetA, 64);
    await act(async () => {
      sketchEnvironmentJob.starts[0]!.resolve(environmentA);
      await Promise.resolve();
    });
    clickButton(el, "Tone");

    clickButton(el, "Crop");
    setInput(el.querySelector<HTMLInputElement>('input[name="x"]')!, "10");
    setInput(el.querySelector<HTMLInputElement>('input[name="width"]')!, "80");
    clickButton(el, "Apply");
    const frozenFraming = structuredClone(
      historyCapture.atomic[0]!.after.present.framing,
    );
    const frozenComposition = lastCompositionFrame;

    clickButton(el, "Choose image");
    await flush();
    clickButton(el, "Refresh");
    await flush();
    const persistedB = [
      ...el.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Image Assets"] button',
      ),
    ].find((button) => button.textContent?.includes("portrait beta"));
    if (persistedB === undefined) throw new Error("no persisted B choice");
    act(() => persistedB.click());

    expect(historyCapture.atomic).toHaveLength(2);
    expect(historyCapture.atomic[1]!.after.present.params.imageAsset).toBe(
      assetB,
    );
    expect(historyCapture.atomic[1]!.after.present.framing).toEqual(
      frozenFraming,
    );
    expect(lastCompositionFrame).toBe(frozenComposition);
    expect(sketchEnvironmentJob.starts).toHaveLength(2);
    expect(sketchEnvironmentJob.starts[0]!.signal.aborted).toBe(true);
    expect(lastToneSource).toBeNull();
    expect(shadingJob.starts).toHaveLength(1);

    const environmentB = resolvedAssetEnvironment(assetB, 192);
    await act(async () => {
      sketchEnvironmentJob.starts[1]!.resolve(environmentB);
      await Promise.resolve();
    });
    expect(generateToneSource.mock.calls.at(-1)?.[2]).toBe(environmentB);
    expect(historyCapture.atomic[1]!.after.present.framing).toEqual(
      frozenFraming,
    );
    expect(lastCompositionFrame).toBe(frozenComposition);
    expect(shadingJob.starts).toHaveLength(2);
    expect(shadingJob.starts[1]!.identity.params).toContainEqual({
      key: "imageAsset",
      value: assetB,
    });
    expect(containsBinaryPayload(shadingJob.starts[1]!.identity)).toBe(false);
  });

  it.each([
    ["list", "Could not load the Image Asset library."],
    ["normalize", "Could not prepare the selected image."],
    ["import", "Could not import the prepared Image Asset."],
  ] as const)(
    "keeps A live and starts no replacement environment or worker after a managed asset %s failure",
    async (phase, message) => {
      if (phase === "list") {
        managedImageAssetJob.list.mockRejectedValueOnce(new Error("offline"));
      } else if (phase === "normalize") {
        managedImageAssetJob.normalize.mockRejectedValueOnce(
          new Error("decode failed"),
        );
      } else {
        managedImageAssetJob.import.mockRejectedValueOnce(
          new Error("write failed"),
        );
      }
      const generateToneSource = vi.fn(
        (
          ...args: Parameters<
            NonNullable<typeof photoScribble.generateToneSource>
          >
        ) =>
          photoScribble.generateToneSource!(...args),
      );
      const el = mount(
        <SketchControls sketch={managedPhotoScribble(generateToneSource)} />,
      );
      const environmentA = resolvedAssetEnvironment(assetA, 96);
      await act(async () => {
        sketchEnvironmentJob.starts[0]!.resolve(environmentA);
        await Promise.resolve();
      });
      clickButton(el, "Tone");

      clickButton(el, "Choose image");
      await flush();
      if (phase !== "list") {
        chooseImageFile(el, `Failure ${phase}.png`);
        clickButton(el, "Import Image Asset");
        await flush();
        await flush();
      }

      expect(el.querySelector('[role="alert"]')?.textContent).toContain(message);
      expect(
        el.querySelector('[aria-label="imageAsset image asset identity"]')
          ?.textContent,
      ).toBe(assetA);
      expect(historyCapture.atomic).toHaveLength(0);
      expect(sketchEnvironmentJob.starts).toHaveLength(1);
      expect(sketchEnvironmentJob.starts[0]!.signal.aborted).toBe(false);
      expect(shadingJob.starts).toHaveLength(1);
      expect(generateToneSource.mock.calls.at(-1)?.[2]).toBe(environmentA);
      expect(lastToneSource).not.toBeNull();
    },
  );

  it("keys main-thread asset readiness across Tone and Shading preparation", async () => {
    const presetAssetB = "portrait-beta-000000000002";
    const invalidAsset = "unresolved://not-an-asset-id";
    const schema = {
      ...toneCalibration.schema,
      photo: { kind: "image-asset", default: assetA },
    } satisfies ParamSchema;
    const toneSourceFor = vi.fn(
      (
        params: Readonly<Record<string, unknown>>,
        frame: CoordinateSpace,
        environment?: SketchEnvironment,
      ): ToneSource => {
        // Matching decoded bytes are a required input, not an optional fallback.
        if (environment?.imageAssets(String(params.photo)) === undefined) {
          throw new Error("missing matching test environment");
        }
        return {
          toneField: createToneField(() => 0.5 / Math.max(frame.width, 1)),
          shadingMask: createShadingMask(() => 1),
        };
      },
    );
    const sketch = {
      ...toneCalibration,
      id: "asset-scribble",
      schema,
      generateToneSource: toneSourceFor,
    };
    const pixels = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([1, 2, 3, 255]),
    };
    const resolvedEnvironment = (id: string): SketchEnvironment => ({
      imageAssets: (requested) => (requested === id ? pixels : undefined),
    });
    const preset = (name: string, photo: string): Preset => ({
      version: 2,
      sketch: sketch.id,
      name,
      seed: 22,
      params: { ...defaultParams(schema), photo },
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
    listPresets.mockResolvedValue(["asset-b", "invalid"]);
    loadPreset.mockImplementation(async (_sketchId, name) =>
      name === "asset-b"
        ? preset("asset-b", presetAssetB)
        : preset("invalid", invalidAsset),
    );

    const el = mount(<SketchControls sketch={sketch} />);
    const canvas = el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!;
    expect(sketchEnvironmentJob.starts).toHaveLength(1);
    expect(sketchEnvironmentJob.starts[0]!.params.photo).toBe(assetA);
    expect(shadingJob.starts).toHaveLength(0);
    clickButton(el, "Tone");
    expect(toneSourceFor).not.toHaveBeenCalled();
    expect(lastToneSource).toBeNull();

    const environmentA = resolvedEnvironment(assetA);
    await act(async () => {
      sketchEnvironmentJob.starts[0]!.resolve(environmentA);
      await Promise.resolve();
    });
    expect(shadingJob.starts).toHaveLength(1);
    expect(toneSourceFor).toHaveBeenCalledTimes(1);
    expect(toneSourceFor.mock.calls[0]?.[2]).toBe(environmentA);
    expect(lastToneSource).not.toBeNull();

    // Seed, Tone selection, and ordinary Scribble-param edits retain the exact
    // same decoded environment because the opaque Image Asset ID set is equal.
    clickButton(el, "New seed");
    expect(shadingJob.starts).toHaveLength(2);
    clickButton(el, "Fill");
    clickButton(el, "Tone");
    const density = paramInput(el, "pathDensity");
    act(() => density.focus());
    setInput(density, "2");
    act(() => density.blur());
    expect(shadingJob.starts).toHaveLength(3);
    expect(sketchEnvironmentJob.starts).toHaveLength(1);

    await flush();
    const picker = el.querySelector<HTMLSelectElement>(
      'select[aria-label="saved presets"]',
    )!;
    const selectPreset = (name: string): void => {
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype,
          "value",
        )!.set!;
        setter.call(picker, name);
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };

    selectPreset("asset-b");
    clickButton(el, "Reload");
    await flush();
    expect(sketchEnvironmentJob.starts).toHaveLength(2);
    expect(sketchEnvironmentJob.starts[1]!.params.photo).toBe(presetAssetB);
    expect(shadingJob.starts).toHaveLength(3);
    expect(lastToneSource).toBeNull();

    const environmentB = resolvedEnvironment(presetAssetB);
    await act(async () => {
      sketchEnvironmentJob.starts[1]!.resolve(environmentB);
      await Promise.resolve();
    });
    expect(shadingJob.starts).toHaveLength(4);
    expect(shadingJob.starts[3]!.identity.params).toContainEqual({
      key: "photo",
      value: presetAssetB,
    });
    expect(toneSourceFor.mock.calls.at(-1)?.[2]).toBe(environmentB);
    const startsAfterB = shadingJob.starts.length;
    await flush();
    expect(shadingJob.starts).toHaveLength(startsAfterB);

    selectPreset("invalid");
    clickButton(el, "Reload");
    await flush();
    expect(sketchEnvironmentJob.starts).toHaveLength(3);
    expect(sketchEnvironmentJob.starts[2]!.params.photo).toBe(invalidAsset);
    expect(historyCapture.atomic.at(-1)?.after.present.params.photo).toBe(
      invalidAsset,
    );
    expect(shadingJob.starts).toHaveLength(startsAfterB);
    expect(lastToneSource).toBeNull();
    await act(async () => {
      sketchEnvironmentJob.starts[2]!.reject(new Error("invalid-id"));
      await Promise.resolve();
    });
    expect(shadingJob.starts).toHaveLength(startsAfterB);
    expect(toneSourceFor.mock.calls.at(-1)?.[2]).toBe(environmentB);
    expect(lastToneSource).toBeNull();
    expect(canvas.dataset.renderState).toBe("unavailable");
    expect(canvas.dataset.unavailableStatus).toBe("error");
    expect(canvas.dataset.unresolvedAssetIds).toBe(invalidAsset);
    expect(el.textContent).toContain("Image Asset is unavailable");
  });

  it("fails closed through loading and missing, then retries the unchanged exact ID once", async () => {
    const generateToneSource = vi.fn(
      (
        ...args: Parameters<
          NonNullable<typeof photoScribble.generateToneSource>
        >
      ) => photoScribble.generateToneSource!(...args),
    );
    const el = mount(
      <SketchControls sketch={managedPhotoScribble(generateToneSource)} />,
    );
    const canvas = el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!;

    expect(canvas.dataset.renderState).toBe("unavailable");
    expect(canvas.dataset.unavailableStatus).toBe("loading");
    expect(canvas.dataset.unresolvedAssetIds).toBe(assetA);
    expect(el.textContent).toContain("Loading exact Image Asset");
    expect(shadingJob.starts).toHaveLength(0);

    clickButton(el, "Tone");
    expect(generateToneSource).not.toHaveBeenCalled();
    expect(lastToneSource).toBeNull();

    await act(async () => {
      sketchEnvironmentJob.starts[0]!.reject(
        new ImageAssetResolutionError("missing", assetA),
      );
      await Promise.resolve();
    });
    expect(canvas.dataset.renderState).toBe("unavailable");
    expect(canvas.dataset.unavailableStatus).toBe("missing");
    expect(el.textContent).toContain("Image Asset is missing");
    expect(shadingJob.starts).toHaveLength(0);

    clickButton(el, "Retry exact asset");
    expect(sketchEnvironmentJob.starts).toHaveLength(2);
    expect(sketchEnvironmentJob.starts[1]!.params.imageAsset).toBe(assetA);
    expect(canvas.dataset.unavailableStatus).toBe("loading");

    const recovered = resolvedAssetEnvironment(assetA, 143);
    await act(async () => {
      sketchEnvironmentJob.starts[1]!.resolve(recovered);
      await Promise.resolve();
    });

    expect(generateToneSource).toHaveBeenCalledTimes(1);
    expect(generateToneSource.mock.calls[0]?.[2]).toBe(recovered);
    expect(canvas.dataset.renderState).toBe("tone-reference");
    expect(shadingJob.starts).toHaveLength(1);
    expect(shadingJob.starts[0]!.identity.params).toContainEqual({
      key: "imageAsset",
      value: assetA,
    });
    await flush();
    expect(shadingJob.starts).toHaveLength(1);
  });

  it("ignores late A, then retries unchanged B into exactly one B job", async () => {
    managedImageAssetJob.list.mockResolvedValue([
      {
        id: assetB,
        name: "portrait beta",
        url: `/image-assets/${assetB}.png`,
      },
    ]);
    const generateToneSource = vi.fn(
      (
        ...args: Parameters<
          NonNullable<typeof photoScribble.generateToneSource>
        >
      ) => photoScribble.generateToneSource!(...args),
    );
    const el = mount(
      <SketchControls sketch={managedPhotoScribble(generateToneSource)} />,
    );
    const canvas = el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!;
    const pendingA = sketchEnvironmentJob.starts[0]!;
    const choice = await openAssetBChoice(el);

    act(() => choice.click());
    const pendingB = sketchEnvironmentJob.starts[1]!;
    expect(pendingA.signal.aborted).toBe(true);
    expect(pendingB.params.imageAsset).toBe(assetB);
    expect(historyCapture.atomic).toHaveLength(1);
    expect(historyCapture.atomic[0]!.after.present.params.imageAsset).toBe(
      assetB,
    );
    expect(shadingJob.starts).toHaveLength(0);

    await act(async () => {
      pendingB.reject(new ImageAssetResolutionError("missing", assetB));
      await Promise.resolve();
    });
    expect(canvas.dataset.renderState).toBe("unavailable");
    expect(canvas.dataset.unavailableStatus).toBe("missing");
    expect(canvas.dataset.unresolvedAssetIds).toBe(assetB);
    expect(
      el.querySelector('[aria-label="imageAsset image asset identity"]')
        ?.textContent,
    ).toBe(assetB);
    clickButton(el, "Tone");
    expect(generateToneSource).not.toHaveBeenCalled();

    await act(async () => {
      pendingA.resolve(resolvedAssetEnvironment(assetA, 32));
      await Promise.resolve();
    });
    expect(canvas.dataset.unavailableStatus).toBe("missing");
    expect(canvas.dataset.unresolvedAssetIds).toBe(assetB);
    expect(shadingJob.starts).toHaveLength(0);

    const historyAfterSelection = historyCapture.atomic[0]!.after;
    clickButton(el, "Retry exact asset");
    expect(sketchEnvironmentJob.starts).toHaveLength(3);
    expect(sketchEnvironmentJob.starts[2]!.params.imageAsset).toBe(assetB);
    expect(historyCapture.atomic).toHaveLength(1);
    expect(historyCapture.atomic[0]!.after).toBe(historyAfterSelection);
    expect(
      el.querySelector('[aria-label="imageAsset image asset identity"]')
        ?.textContent,
    ).toBe(assetB);

    const recoveredB = resolvedAssetEnvironment(assetB, 224);
    await act(async () => {
      sketchEnvironmentJob.starts[2]!.resolve(recoveredB);
      await Promise.resolve();
    });
    expect(generateToneSource).toHaveBeenCalledTimes(1);
    expect(generateToneSource.mock.calls[0]?.[2]).toBe(recoveredB);
    expect(shadingJob.starts).toHaveLength(1);
    expect(shadingJob.starts[0]!.identity.params).toContainEqual({
      key: "imageAsset",
      value: assetB,
    });
    await flush();
    expect(shadingJob.starts).toHaveLength(1);
  });

  it("keeps a malformed authored ID visible and handler-guards every unavailable action", async () => {
    const malformed = "../Portrait Beta.png?raw=1";
    listPresets.mockResolvedValue(["malformed"]);
    loadPreset.mockResolvedValue({
      version: 2,
      sketch: photoScribble.id,
      name: "malformed",
      seed: 22,
      params: {
        ...defaultParams(photoScribble.schema),
        imageAsset: malformed,
      },
      locks: [],
      profile: HARNESS_FALLBACK_PLOT_PROFILE,
    });
    const generateToneSource = vi.fn(
      (
        ...args: Parameters<
          NonNullable<typeof photoScribble.generateToneSource>
        >
      ) => photoScribble.generateToneSource!(...args),
    );
    const toBlob = vi.fn();
    fakeCanvasToBlob = toBlob as HTMLCanvasElement["toBlob"];
    const el = mount(
      <SketchControls sketch={managedPhotoScribble(generateToneSource)} />,
    );
    await flush();
    const picker = el.querySelector<HTMLSelectElement>(
      'select[aria-label="saved presets"]',
    )!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(picker, "malformed");
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    clickButton(el, "Reload");
    await flush();

    expect(sketchEnvironmentJob.starts.at(-1)?.params.imageAsset).toBe(
      malformed,
    );
    await act(async () => {
      sketchEnvironmentJob.starts
        .at(-1)!
        .reject(new ImageAssetResolutionError("invalid-id", malformed));
      await Promise.resolve();
    });

    const canvas = el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!;
    expect(
      el.querySelector('[aria-label="imageAsset image asset identity"]')
        ?.textContent,
    ).toBe(malformed);
    expect(canvas.dataset.renderState).toBe("unavailable");
    expect(canvas.dataset.unavailableStatus).toBe("error");
    expect(canvas.dataset.unresolvedAssetIds).toBe(malformed);
    expect(generateToneSource).not.toHaveBeenCalled();
    expect(shadingJob.starts).toHaveLength(0);

    const guarded = [
      exportButton(el, "Export PNG"),
      exportButton(el, "Export SVG"),
      exportButton(el, "Outline"),
      exportButton(el, "Export Hidden-line SVG"),
    ];
    expect(guarded.every(({ disabled }) => disabled)).toBe(true);
    act(() => exposeAndClick(guarded));
    await flush();
    expect(toBlob).not.toHaveBeenCalled();
    expect(exportSceneCapture.current).toBeNull();
    expect(plotterExportCapture.current).toBeNull();
    expect(outlineJob.starts).toBe(0);
    expect(outlineJob.exportStarts).toBe(0);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("disables and handler-guards every export and Outline until the exact asset resolves", async () => {
    const toBlob = vi.fn();
    fakeCanvasToBlob = toBlob as HTMLCanvasElement["toBlob"];
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    const guarded = [
      exportButton(el, "Export PNG"),
      exportButton(el, "Export SVG"),
      exportButton(el, "Outline"),
      exportButton(el, "Export Hidden-line SVG"),
    ];

    expect(guarded.every(({ disabled }) => disabled)).toBe(true);
    act(() => exposeAndClick(guarded));
    await flush();
    expect(toBlob).not.toHaveBeenCalled();
    expect(exportSceneCapture.current).toBeNull();
    expect(outlineJob.starts).toBe(0);
    expect(outlineJob.exportStarts).toBe(0);
    expect(downloadBlob).not.toHaveBeenCalled();
    for (const button of guarded) button.disabled = true;

    await act(async () => {
      sketchEnvironmentJob.starts[0]!.reject(
        new ImageAssetResolutionError("missing", assetA),
      );
      await Promise.resolve();
    });
    const missingGuards = [
      exportButton(el, "Export PNG"),
      exportButton(el, "Export SVG"),
      exportButton(el, "Outline"),
      exportButton(el, "Export Hidden-line SVG"),
    ];
    expect(missingGuards.every(({ disabled }) => disabled)).toBe(true);
    act(() => exposeAndClick(missingGuards));
    expect(toBlob).not.toHaveBeenCalled();
    expect(outlineJob.starts).toBe(0);
    expect(outlineJob.exportStarts).toBe(0);

    clickButton(el, "Retry exact asset");
    await act(async () => {
      sketchEnvironmentJob.starts[1]!.resolve(
        resolvedAssetEnvironment(assetA, 128),
      );
      await Promise.resolve();
    });
    await completeShading(0, preparedScene(50));
    expect(
      ["Export PNG", "Export SVG", "Outline", "Export Hidden-line SVG"].map(
        (label) => exportButton(el, label).disabled,
      ),
    ).toEqual([false, false, false, false]);
  });

  it("rejects forced same-batch exports and Outline after the authored asset ID changes", async () => {
    managedImageAssetJob.list.mockResolvedValue([
      {
        id: assetB,
        name: "portrait beta",
        url: `/image-assets/${assetB}.png`,
      },
    ]);
    const toBlob = vi.fn();
    fakeCanvasToBlob = toBlob as HTMLCanvasElement["toBlob"];
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await act(async () => {
      sketchEnvironmentJob.starts[0]!.resolve(
        resolvedAssetEnvironment(assetA, 64),
      );
      await Promise.resolve();
    });
    await completeShading(0, preparedScene(51));
    const choice = await openAssetBChoice(el);
    const forced = [
      exportButton(el, "Export PNG"),
      exportButton(el, "Export SVG"),
      exportButton(el, "Outline"),
      exportButton(el, "Export Hidden-line SVG"),
    ];

    act(() => {
      choice.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      exposeAndClick(forced);
    });
    await flush();

    expect(historyCapture.atomic.at(-1)?.after.present.params.imageAsset).toBe(
      assetB,
    );
    expect(sketchEnvironmentJob.starts.at(-1)?.params.imageAsset).toBe(assetB);
    expect(toBlob).not.toHaveBeenCalled();
    expect(exportSceneCapture.current).toBeNull();
    expect(outlineJob.starts).toBe(0);
    expect(outlineJob.exportStarts).toBe(0);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("drops PNG metadata and download when asset availability changes in flight", async () => {
    managedImageAssetJob.list.mockResolvedValue([
      {
        id: assetB,
        name: "portrait beta",
        url: `/image-assets/${assetB}.png`,
      },
    ]);
    let resolveBytes!: (value: ArrayBuffer) => void;
    const bytes = new Promise<ArrayBuffer>((resolve) => {
      resolveBytes = resolve;
    });
    const pendingBlob = new Blob([MINIMAL_PNG], { type: "image/png" });
    vi.spyOn(pendingBlob, "arrayBuffer").mockReturnValue(bytes);
    fakeCanvasToBlob = ((callback: BlobCallback) => {
      callback(pendingBlob);
    }) as HTMLCanvasElement["toBlob"];
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await act(async () => {
      sketchEnvironmentJob.starts[0]!.resolve(
        resolvedAssetEnvironment(assetA, 64),
      );
      await Promise.resolve();
    });
    await completeShading(0, preparedScene(52));
    const choice = await openAssetBChoice(el);

    clickButton(el, "Export PNG");
    expect(pendingBlob.arrayBuffer).toHaveBeenCalledOnce();
    act(() => choice.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => {
      resolveBytes(MINIMAL_PNG.slice().buffer);
      await Promise.resolve();
    });

    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("cancels Outline completion when asset availability changes in flight", async () => {
    managedImageAssetJob.list.mockResolvedValue([
      {
        id: assetB,
        name: "portrait beta",
        url: `/image-assets/${assetB}.png`,
      },
    ]);
    autoFireOutlineComputed = false;
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await act(async () => {
      sketchEnvironmentJob.starts[0]!.resolve(
        resolvedAssetEnvironment(assetA, 64),
      );
      await Promise.resolve();
    });
    await completeShading(0, preparedScene(53));
    const choice = await openAssetBChoice(el);

    clickButton(el, "Outline");
    const active = outlineJob.active;
    expect(active).not.toBeNull();
    act(() => choice.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(outlineJob.active).toBeNull();
    await act(async () => {
      active!.resolve({
        status: "success",
        jobId: 1,
        identity: active!.identity,
        scene: preparedScene(99),
      });
      await Promise.resolve();
    });

    const canvas = el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!;
    expect(canvas.dataset.renderState).toBe("unavailable");
    expect(exportButton(el, "Outline").getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("cancels hidden-line finalization and download when asset availability changes in flight", async () => {
    managedImageAssetJob.list.mockResolvedValue([
      {
        id: assetB,
        name: "portrait beta",
        url: `/image-assets/${assetB}.png`,
      },
    ]);
    outlineJob.exportMode = "pending";
    const el = mount(
      <SketchControls
        sketch={managedPhotoScribble(photoScribble.generateToneSource!)}
      />,
    );
    await act(async () => {
      sketchEnvironmentJob.starts[0]!.resolve(
        resolvedAssetEnvironment(assetA, 64),
      );
      await Promise.resolve();
    });
    await completeShading(0, preparedScene(54));
    const choice = await openAssetBChoice(el);

    clickButton(el, "Export Hidden-line SVG");
    const pending = outlineJob.pendingExport;
    expect(pending).not.toBeNull();
    act(() => choice.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(outlineJob.pendingExport).toBeNull();
    pending!.succeed();
    await flush();

    expect(downloadBlob).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain("Preparing SVG");
  });

  it("rejects obsolete environment and worker completions without changing current presentation", async () => {
    const assetC = "portrait-charlie-cccccccccccc";
    managedImageAssetJob.list.mockResolvedValue([
      {
        id: assetB,
        name: "portrait beta",
        url: `/image-assets/${assetB}.png`,
      },
      {
        id: assetC,
        name: "portrait charlie",
        url: `/image-assets/${assetC}.png`,
      },
    ]);
    const generateToneSource = vi.fn(
      (
        ...args: Parameters<
          NonNullable<typeof photoScribble.generateToneSource>
        >
      ) => photoScribble.generateToneSource!(...args),
    );
    const el = mount(
      <SketchControls sketch={managedPhotoScribble(generateToneSource)} />,
    );
    const canvas = el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!;
    const selectManagedAsset = async (name: string): Promise<void> => {
      if (el.textContent?.includes("Choose image")) {
        clickButton(el, "Choose image");
        await flush();
      }
      const choice = [
        ...el.querySelectorAll<HTMLButtonElement>(
          '[aria-label="Image Assets"] button',
        ),
      ].find((button) => button.textContent?.includes(name));
      if (choice === undefined) throw new Error(`no ${name} choice`);
      act(() => choice.click());
    };

    const environmentA = resolvedAssetEnvironment(assetA, 32);
    await act(async () => {
      sketchEnvironmentJob.starts[0]!.resolve(environmentA);
      await Promise.resolve();
    });
    await completeShading(0, preparedScene(40));
    clickButton(el, "Tone");
    expect(generateToneSource.mock.calls.at(-1)?.[2]).toBe(environmentA);

    // Leave a same-environment replacement active so its late completion races
    // the two subsequent exact-asset selections.
    clickButton(el, "New seed");
    expect(shadingJob.starts).toHaveLength(2);
    await selectManagedAsset("portrait beta");
    const obsoleteEnvironment = sketchEnvironmentJob.starts[1]!;
    expect(canvas.dataset.renderState).toBe("unavailable");
    expect(canvas.dataset.unresolvedAssetIds).toBe(assetB);
    expect(shadingDisclosure(el).textContent).not.toContain("Converged");
    expect(lastToneSource).toBeNull();
    expect(shadingJob.cancelCount).toBeGreaterThan(0);

    await selectManagedAsset("portrait charlie");
    expect(obsoleteEnvironment.signal.aborted).toBe(true);
    expect(canvas.dataset.unresolvedAssetIds).toBe(assetC);
    const currentEnvironment = sketchEnvironmentJob.starts[2]!;

    await act(async () => {
      obsoleteEnvironment.resolve(resolvedAssetEnvironment(assetB, 128));
      await Promise.resolve();
    });
    expect(canvas.dataset.renderState).toBe("unavailable");
    expect(canvas.dataset.unresolvedAssetIds).toBe(assetC);
    expect(generateToneSource.mock.calls.at(-1)?.[2]).toBe(environmentA);
    expect(shadingJob.starts).toHaveLength(2);

    const environmentC = resolvedAssetEnvironment(assetC, 224);
    await act(async () => {
      currentEnvironment.resolve(environmentC);
      await Promise.resolve();
    });
    expect(generateToneSource.mock.calls.at(-1)?.[2]).toBe(environmentC);
    expect(shadingJob.starts).toHaveLength(3);
    expect(shadingJob.starts[2]!.identity.params).toContainEqual({
      key: "imageAsset",
      value: assetC,
    });

    clickButton(el, "Fill");
    expect(canvas.dataset.renderState).toBe("fill-held");
    expect(shadingDisclosure(el).textContent).toContain(
      "Displayed result: stale",
    );
    const presentationBeforeLateWorker = {
      sourceInputRevision: canvas.dataset.sourceInputRevision,
      contentRevision: canvas.dataset.contentRevision,
      diagnostics: shadingDisclosure(el).textContent,
      toneCalls: generateToneSource.mock.calls.length,
    };

    await completeShading(1, preparedScene(99));
    expect(canvas.dataset.sourceInputRevision).toBe(
      presentationBeforeLateWorker.sourceInputRevision,
    );
    expect(canvas.dataset.contentRevision).toBe(
      presentationBeforeLateWorker.contentRevision,
    );
    expect(shadingDisclosure(el).textContent).toBe(
      presentationBeforeLateWorker.diagnostics,
    );
    expect(generateToneSource).toHaveBeenCalledTimes(
      presentationBeforeLateWorker.toneCalls,
    );
    expect(shadingJob.starts).toHaveLength(3);

    await completeShading(2, preparedScene(41));
    expect(shadingDisclosure(el).textContent).not.toContain(
      "Displayed result: stale",
    );
    expect(canvas.dataset.contentRevision).not.toBe(
      presentationBeforeLateWorker.contentRevision,
    );
  });

  it("keeps asset-free Shading sketches on the existing immediate path", () => {
    const el = mount(<SketchControls sketch={toneCalibration} />);
    const canvas = el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!;

    expect(sketchEnvironmentJob.starts).toHaveLength(0);
    expect(shadingJob.starts).toHaveLength(1);
    expect(canvas.dataset.renderState).toBe("fill-held");
    expect(canvas.dataset.unavailableStatus).toBe("");
    expect(el.textContent).not.toContain("Loading exact Image Asset");
  });

  it("shows diagnostics only for Shading-capable Sketches", () => {
    const ordinary = mount(<SketchControls sketch={leafField} />);
    expect(ordinary.textContent).not.toContain("Shading");

    act(() => root!.unmount());
    root = null;
    container!.remove();
    container = null;

    const shading = mount(<SketchControls sketch={toneCalibration} />);
    expect(shadingDisclosure(shading).open).toBe(false);
    expect(shadingDisclosure(shading).textContent).toContain("Preparing");
  });

  it("attributes Tone progress, cancellation, stale metrics, failure, and budget completion to the right result", async () => {
    const generate = vi.fn(toneCalibration.generate);
    const el = mount(
      <SketchControls sketch={{ ...toneCalibration, generate }} />,
    );
    const diagnosticsPanel = shadingDisclosure(el);

    // The fixed diagnostic source stays immediately available while artwork is
    // held in the worker. Its outer and inner vertical ramps oppose one another.
    clickButton(el, "Tone");
    const frame = lastCompositionFrame!;
    const source = lastToneSource!;
    expect(source.toneField.sample([0, frame.height * 0.2])).toBeLessThan(
      source.toneField.sample([0, frame.height * 0.8]),
    );
    expect(
      source.toneField.sample([frame.width / 2, frame.height * 0.2]),
    ).toBeGreaterThan(
      source.toneField.sample([frame.width / 2, frame.height * 0.8]),
    );
    expect(generate).not.toHaveBeenCalled();

    reportShadingProgress(0, 25, 100, {
      kind: "remaining",
      revision: 2,
      remainingMs: 12_500,
    });
    act(() => {
      diagnosticsPanel
        .querySelector("summary")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(diagnosticsPanel.textContent).toContain("25% (25 of 100 work units)");
    expect(diagnosticsPanel.textContent).toContain("12.5 s");

    await completeShading(0, preparedScene(1));
    expect(diagnosticsPanel.textContent).toContain("Converged");
    expect(diagnosticsPanel.textContent).not.toContain("Current result:");
    expect(diagnosticsPanel.textContent).toContain("Residual error1.00%");

    const density = paramInput(el, "pathDensity");
    act(() => density.focus());
    setInput(density, "2");
    expect(diagnosticsPanel.textContent).toContain("Displayed result: stale");
    act(() => density.blur());
    expect(shadingJob.starts).toHaveLength(2);
    reportShadingProgress(1, 40, 100, {
      kind: "remaining",
      revision: 2,
      remainingMs: 2_000,
    });
    expect(diagnosticsPanel.textContent).toContain("Preparing 40%");
    expect(diagnosticsPanel.textContent).toContain("Preparing replacement");

    // Beginning a newer transaction deterministically cancels that replacement;
    // its later result and progress are ignored while the retained metrics stay stale.
    act(() => density.focus());
    setInput(density, "3");
    expect(shadingJob.cancelCount).toBe(1);
    expect(diagnosticsPanel.textContent).toContain("Displayed result: stale");
    expect(diagnosticsPanel.textContent).not.toContain("Preparing replacement");
    reportShadingProgress(1, 90, 100, {
      kind: "remaining",
      revision: 3,
      remainingMs: 100,
    });
    expect(diagnosticsPanel.textContent).not.toContain("Preparing 90%");
    await completeShading(1, preparedScene(99));
    expect(diagnosticsPanel.textContent).toContain("Residual error1.00%");
    act(() => density.blur());
    expect(shadingJob.starts).toHaveLength(3);

    await failShading(2, "safe worker detail");
    expect(diagnosticsPanel.textContent).toContain("Preparation failed");
    expect(diagnosticsPanel.textContent).toContain("safe worker detail");
    expect(diagnosticsPanel.textContent).toContain("Displayed result: stale");

    clickButton(el, "New seed");
    await completeShading(3, preparedScene(4), {
      ...diagnostics,
      termination: "budget-exhausted",
      fidelity: { kind: "scribble", residualError: 0.3 },
    });
    expect(diagnosticsPanel.textContent).toContain("Budget exhausted");
    expect(diagnosticsPanel.textContent).not.toContain("Current result:");
    expect(diagnosticsPanel.textContent).toContain("Residual error30.00%");
    clickButton(el, "Fill");
    expect(exportButton(el, "Export SVG").disabled).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps a Scribble → Stippling race on exact displayed and current identities through retry, paint, and bounded completion", async () => {
    const toBlob = vi.fn((callback: BlobCallback) => {
      callback(new Blob([MINIMAL_PNG], { type: "image/png" }));
    });
    fakeCanvasToBlob = toBlob as HTMLCanvasElement["toBlob"];
    const el = mount(<SketchControls sketch={toneCalibration} />);
    const canvas = el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!;
    const diagnosticsPanel = shadingDisclosure(el);
    const png = exportButton(el, "Export PNG");
    const svg = exportButton(el, "Export SVG");
    const scribbleScene = preparedScene(120);

    await completeShading(0, scribbleScene, {
      ...diagnostics,
      fidelity: { kind: "scribble", residualError: 0.04 },
    });
    expect([png.disabled, svg.disabled]).toEqual([false, false]);
    expect(diagnosticsPanel.textContent).toContain("Residual error4.00%");
    expect(diagnosticsPanel.textContent).not.toContain("Distribution error");

    // Keep the initial Scribble paint acknowledged, then require explicit paint
    // acknowledgement for every replacement below.
    autoAcknowledgeDisplayedScene = false;
    const density = paramInput(el, "pathDensity");
    act(() => density.focus());
    setInput(density, "2");
    act(() => density.blur());
    expect(shadingJob.starts).toHaveLength(2);

    selectValue(choiceParamSelect(el, "strategy"), "stippling");
    expect(shadingJob.cancelCount).toBeGreaterThan(0);
    expect(shadingJob.starts).toHaveLength(3);
    expect(shadingJob.starts[2]!.identity.params).toEqual([
      { key: "strategy", value: "stippling" },
      { key: "stippleDensity", value: 1 },
      { key: "distributionFidelity", value: 0.5 },
    ]);
    expect(lastRenderScene).toBe(scribbleScene);
    expect(canvas.dataset.sourceInputRevision).toBe("0");
    expect(diagnosticsPanel.textContent).toContain("Displayed result: stale");
    expect(diagnosticsPanel.textContent).toContain("Residual error4.00%");
    expect(diagnosticsPanel.textContent).not.toContain("Distribution error");
    expect([png.disabled, svg.disabled]).toEqual([true, true]);

    reportShadingProgress(2, 35, 100, {
      kind: "remaining",
      revision: 2,
      remainingMs: 4_000,
    });
    expect(diagnosticsPanel.textContent).toContain(
      "35% (35 of 100 work units)",
    );
    expect(diagnosticsPanel.textContent).toContain("4.0 s");

    // The canceled Scribble worker may still have callbacks queued. Neither its
    // progress nor its successful completion may replace the retained Scribble
    // metrics or the current Stippling progress lane.
    reportShadingProgress(1, 90, 100, {
      kind: "remaining",
      revision: 3,
      remainingMs: 100,
    });
    await completeShading(1, preparedScene(121));
    expect(lastRenderScene).toBe(scribbleScene);
    expect(diagnosticsPanel.textContent).toContain(
      "35% (35 of 100 work units)",
    );
    expect(diagnosticsPanel.textContent).not.toContain("Preparing 90%");
    expect(diagnosticsPanel.textContent).toContain("Residual error4.00%");

    const writesAfterStrategy = historyWriteCount();
    await failShading(2, "safe retryable Stippling failure");
    expect(diagnosticsPanel.textContent).toContain("Preparation failed");
    expect(diagnosticsPanel.textContent).toContain(
      "safe retryable Stippling failure",
    );
    const failedIdentity = shadingJob.starts[2]!.identity;
    clickButton(el, "Retry");
    expect(shadingJob.starts).toHaveLength(4);
    expect(shadingJob.starts[3]!.identity).toEqual(failedIdentity);
    expect(historyWriteCount()).toBe(writesAfterStrategy);

    // An active relaxation edit supersedes that exact retry. Its late failure
    // is ignored, while only the newly-authored identity owns current progress.
    const cancelsBeforeRelaxation = shadingJob.cancelCount;
    const relaxation = paramInput(el, "voronoiRelaxation");
    act(() => relaxation.focus());
    setInput(relaxation, "0.6");
    expect(shadingJob.cancelCount).toBe(cancelsBeforeRelaxation + 1);
    expect([png.disabled, svg.disabled]).toEqual([true, true]);
    expect(lastRenderScene).toBe(scribbleScene);
    act(() => relaxation.blur());
    expect(shadingJob.starts).toHaveLength(5);
    expect(shadingJob.starts[4]!.identity.params).toContainEqual({
      key: "voronoiRelaxation",
      value: 0.6,
    });
    expect(JSON.stringify(shadingJob.starts[4]!.identity)).not.toMatch(
      /completedWorkUnits|totalWorkUnits|remainingMs|diagnostics|computeTimeMs/,
    );
    reportShadingProgress(4, 20, 100, {
      kind: "remaining",
      revision: 2,
      remainingMs: 8_000,
    });
    await failShading(3, "obsolete retry failure");
    expect(diagnosticsPanel.textContent).not.toContain(
      "obsolete retry failure",
    );
    expect(diagnosticsPanel.textContent).toContain(
      "20% (20 of 100 work units)",
    );

    const stipplingScene = preparedScene(122);
    await completeShading(4, stipplingScene, {
      ...diagnostics,
      fidelity: {
        kind: "stippling",
        distributionError: 0.08,
        relaxation: {
          objective: 0.012,
          requestedWorkUnits: 100,
          completedWorkUnits: 100,
          iterationsCompleted: 4,
          relocationsAccepted: 12,
        },
      },
    });
    expect(lastRenderScene).toBe(stipplingScene);
    expect(diagnosticsPanel.textContent).toContain("Distribution error8.00%");
    expect(diagnosticsPanel.textContent).not.toContain("Residual error");
    expect([png.disabled, svg.disabled]).toEqual([true, true]);
    act(() => acknowledgeDisplayedScene?.());
    expect([png.disabled, svg.disabled]).toEqual([false, false]);

    // Exercise an honest bounded Stippling completion while observational state
    // is live, then prove none of it enters history or a saved Preset.
    const distributionFidelity = paramInput(el, "distributionFidelity");
    act(() => distributionFidelity.focus());
    setInput(distributionFidelity, "0.75");
    act(() => distributionFidelity.blur());
    expect(shadingJob.starts).toHaveLength(6);
    reportShadingProgress(5, 60, 100, {
      kind: "remaining",
      revision: 2,
      remainingMs: 3_000,
    });
    expect(diagnosticsPanel.textContent).toContain("3.0 s");
    reportShadingProgress(5, 80, 100, {
      kind: "remaining",
      revision: 3,
      remainingMs: 1_000,
    });
    expect(diagnosticsPanel.textContent).toContain("1.0 s");
    const authoredWrites = historyWriteCount();
    expect(JSON.stringify(historyCapture)).not.toMatch(
      /completedWorkUnits|totalWorkUnits|remainingMs|diagnostics|computeTimeMs/,
    );
    setInput(
      el.querySelector('input[aria-label="preset name"]') as HTMLInputElement,
      "stippling-race",
    );
    clickButton(el, "Save");
    await flush();
    expect(historyWriteCount()).toBe(authoredWrites);
    const savedPreset = savePreset.mock.calls.at(-1)![0];
    expect(savedPreset.params.voronoiRelaxation).toBe(0.6);
    expect(JSON.stringify(savedPreset)).not.toMatch(
      /completedWorkUnits|totalWorkUnits|remainingMs|diagnostics|computeTimeMs/,
    );

    // A truthful ceiling terminal can complete below the configured work cap.
    // The completed lane keeps the work usage but no longer shows an ETA.
    reportShadingProgress(
      5,
      80,
      100,
      { kind: "remaining", revision: 4, remainingMs: 0 },
      true,
    );
    expect(diagnosticsPanel.textContent).toContain("Preparation complete");
    expect(diagnosticsPanel.textContent).toContain(
      "80% (80 of 100 work units)",
    );
    expect(diagnosticsPanel.textContent).not.toContain(
      "Estimated time remaining",
    );

    const boundedScene = preparedScene(123);
    await completeShading(5, boundedScene, {
      ...diagnostics,
      termination: "budget-exhausted",
      fidelity: {
        kind: "stippling",
        distributionError: 1.25,
        relaxation: {
          objective: 0.02,
          requestedWorkUnits: 100,
          completedWorkUnits: 80,
          iterationsCompleted: 3,
          relocationsAccepted: 9,
        },
      },
    });
    expect(lastRenderScene).toBe(boundedScene);
    expect(diagnosticsPanel.textContent).toContain("Budget exhausted");
    expect(diagnosticsPanel.textContent).toContain(
      "bounded partial result, not a computation error",
    );
    expect(diagnosticsPanel.textContent).toContain(
      "Distribution error125.00%",
    );
    expect(diagnosticsPanel.textContent).toContain(
      "Relaxation work80 of 100 work units",
    );
    expect([png.disabled, svg.disabled]).toEqual([true, true]);
    act(() => acknowledgeDisplayedScene?.());
    expect([png.disabled, svg.disabled]).toEqual([false, false]);

    clickButton(el, "Export SVG");
    expect(exportSceneCapture.current).toBe(boundedScene);
    clickButton(el, "Export PNG");
    await flush();
    expect(toBlob).toHaveBeenCalledOnce();
    expect(downloadBlob).toHaveBeenCalledTimes(2);
    expect(historyWriteCount()).toBe(authoredWrites);

    const svgText = await readBlobText(downloadBlob.mock.calls[0]![0]);
    const pngText = await readBlobText(downloadBlob.mock.calls[1]![0]);
    for (const reproduction of [svgText, pngText]) {
      expect(reproduction).toContain('"voronoiRelaxation":0.6');
      expect(reproduction).not.toMatch(
        /completedWorkUnits|totalWorkUnits|remainingMs|diagnostics|computeTimeMs/,
      );
    }
  });

  it("gates every export on current painted provenance and never generates Shading synchronously", async () => {
    const toBlob = vi.fn((callback: BlobCallback) => {
      callback(new Blob([MINIMAL_PNG], { type: "image/png" }));
    });
    fakeCanvasToBlob = toBlob as HTMLCanvasElement["toBlob"];
    const generate = vi.fn(toneCalibration.generate);
    const el = mount(
      <SketchControls sketch={{ ...toneCalibration, generate }} />,
    );
    const png = exportButton(el, "Export PNG");
    const svg = exportButton(el, "Export SVG");
    const hidden = exportButton(el, "Export Hidden-line SVG");

    expect([png.disabled, svg.disabled, hidden.disabled]).toEqual([
      true,
      true,
      true,
    ]);
    act(() => {
      for (const candidate of [png, svg, hidden]) {
        candidate.disabled = false;
        candidate.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });
    await flush();
    expect(toBlob).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(outlineJob.exportStarts).toBe(0);
    expect(downloadBlob).not.toHaveBeenCalled();

    clickButton(el, "Tone");
    clickButton(el, "Outline");
    expect(generate).not.toHaveBeenCalled();

    const exactScene = preparedScene(10);
    await completeShading(0, exactScene);
    await flush();
    expect([png.disabled, svg.disabled, hidden.disabled]).toEqual([
      false,
      false,
      false,
    ]);

    clickButton(el, "Export SVG");
    expect(exportSceneCapture.current).toBe(exactScene);
    expect(generate).not.toHaveBeenCalled();
    clickButton(el, "Export PNG");
    await flush();
    expect(toBlob).toHaveBeenCalledTimes(1);
    clickButton(el, "Export Hidden-line SVG");
    await flush();
    expect(outlineJob.exportStarts).toBe(1);
    expect(generate).not.toHaveBeenCalled();
    expect(downloadBlob).toHaveBeenCalledTimes(3);

    toBlob.mockClear();
    downloadBlob.mockClear();
    exportSceneCapture.current = null;
    outlineJob.exportStarts = 0;
    const newSeedButton = exportButton(el, "New seed");
    act(() => {
      // React has not painted the disabled state yet; the synchronous session
      // snapshot must still make these same-batch programmatic calls inert.
      newSeedButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      png.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      svg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      hidden.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect([png.disabled, svg.disabled, hidden.disabled]).toEqual([
      true,
      true,
      true,
    ]);
    expect(toBlob).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(exportSceneCapture.current).toBeNull();
    expect(outlineJob.exportStarts).toBe(0);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("keeps one acknowledged ordered Stippling Scene through SVG, cached physical Outline, and proportional Page output", async () => {
    autoFireOutlineComputed = false;
    const generate = vi.fn(toneCalibration.generate);
    const el = mount(
      <SketchControls sketch={{ ...toneCalibration, generate }} />,
    );
    selectValue(choiceParamSelect(el, "strategy"), "stippling");
    expect(shadingJob.starts).toHaveLength(2);
    expect(shadingJob.starts[1]!.identity.params).toEqual([
      { key: "strategy", value: "stippling" },
      { key: "stippleDensity", value: 1 },
      { key: "distributionFidelity", value: 0.5 },
    ]);

    const composition = lastCompositionFrame!;
    const stipples: Scene = {
      space: { ...composition },
      primitives: [
        {
          points: [[150, 250], [150.5, 250]],
          closed: false,
          stroke: { color: "black", width: 1 },
          hiddenLineRole: "source",
        },
        {
          points: [[400, 300], [400, 300.5]],
          closed: false,
          stroke: { color: "black", width: 1 },
          hiddenLineRole: "source",
        },
        {
          points: [[800, 700], [799.5, 700]],
          closed: false,
          stroke: { color: "black", width: 1 },
          hiddenLineRole: "source",
        },
      ],
    };
    const sourcePoints = stipples.primitives.map(({ points }) => points);
    autoAcknowledgeDisplayedScene = false;
    await completeShading(1, stipples, {
      ...diagnostics,
      fidelity: { kind: "stippling", distributionError: 0.02 },
    });

    const ordinary = exportButton(el, "Export SVG");
    const plotter = exportButton(el, "Export Hidden-line SVG");
    expect([ordinary.disabled, plotter.disabled]).toEqual([true, true]);
    act(() => {
      for (const candidate of [ordinary, plotter]) {
        candidate.disabled = false;
        candidate.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });
    await flush();
    expect(exportSceneCapture.current).toBeNull();
    expect(outlineJob.exportStarts).toBe(0);
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();

    act(() => acknowledgeDisplayedScene?.());
    expect([ordinary.disabled, plotter.disabled]).toEqual([false, false]);
    clickButton(el, "Export SVG");
    expect(exportSceneCapture.current).toBe(stipples);
    expect(
      (exportSceneCapture.current as Scene).primitives.map(
        ({ points }) => points,
      ),
    ).toEqual(sourcePoints);
    expect(
      (exportSceneCapture.current as Scene).primitives.every(
        ({ points, closed }) => points.length === 2 && closed === false,
      ),
    ).toBe(true);
    expect(generate).not.toHaveBeenCalled();

    clickButton(el, "Outline");
    expect(outlineJob.starts).toBe(1);
    const preparedIdentity = outlineJob.lastIdentity;
    expect(preparedIdentity).toMatchObject({
      sourceKind: "completed-scene-sketch",
      compositionFrame: composition,
      sourceScene: stipples,
      outlineTarget: {
        toolWidthMillimeters: 0.3,
        millimetersPerSceneUnit: 0.18,
      },
    });
    if (preparedIdentity?.sourceKind !== "completed-scene-sketch") {
      throw new Error("expected completed-Scene Stippling identity");
    }
    expect(preparedIdentity.sourceScene).not.toBe(stipples);
    expect(
      preparedIdentity.sourceScene.primitives.map(({ points }) => points),
    ).toEqual(sourcePoints);
    act(() => lastOnOutlineComputed?.());
    await flush();
    const cachedOutline = outlineJob.lastCompletedScene!;
    expect(cachedOutline.primitives.map(({ points }) => points)).toEqual(
      sourcePoints,
    );
    expect(
      cachedOutline.primitives.every(
        ({ points, closed }) => points.length === 2 && closed !== true,
      ),
    ).toBe(true);

    const margin = el.querySelector<HTMLInputElement>(
      'input[aria-label="Linked paper margin (mm)"]',
    )!;
    act(() => margin.focus());
    setInput(margin, "20");
    act(() => margin.blur());
    const toolWidth = el.querySelector<HTMLInputElement>(
      'input[aria-label="Tool width (mm)"]',
    )!;
    act(() => toolWidth.focus());
    setInput(toolWidth, "0.5");
    act(() => toolWidth.blur());

    expect(shadingJob.starts).toHaveLength(2);
    expect(outlineJob.starts).toBe(1);
    expect(outlineJob.lastIdentity).toBe(preparedIdentity);
    expect(outlineJob.lastCompletedScene).toBe(cachedOutline);
    expect(cachedOutline.primitives.map(({ points }) => points)).toEqual(
      sourcePoints,
    );
    expect(lastCompositionFrame).toBe(composition);
    expect(lastOutlineFinalizationStrokePolicy).toEqual({
      kind: "physical-tool",
      target: {
        toolWidthMillimeters: 0.5,
        millimetersPerSceneUnit: 0.16,
      },
    });

    clickButton(el, "Fill");
    clickButton(el, "Crop");
    for (const [name, value] of Object.entries({
      x: 10,
      y: 20,
      width: 80,
      height: 60,
    })) {
      setInput(
        el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!,
        String(value),
      );
    }
    clickButton(el, "Apply");
    const pageFrame: PageFrame = {
      x: 100,
      y: 200,
      width: 800,
      height: 600,
    };
    expect(lastCommittedPageFrame).toEqual(pageFrame);
    expect(lastProfile).toEqual({
      width: 168,
      height: 136,
      insets: { top: 20, right: 20, bottom: 20, left: 20 },
      includeFrame: true,
      toolWidthMillimeters: 0.5,
    });
    expect(lastCompositionFrame).toBe(composition);
    expect(shadingJob.starts).toHaveLength(2);
    expect(outlineJob.starts).toBe(1);
    expect(outlineJob.lastCompletedScene).toBe(cachedOutline);

    clickButton(el, "Export SVG");
    expect(exportSceneCapture.current).toEqual({
      space: { width: 800, height: 600 },
      primitives: [
        {
          points: [[50, 50], [50.5, 50]],
          closed: false,
          stroke: { color: "black", width: 1 },
          hiddenLineRole: "source",
        },
        {
          points: [[300, 100], [300, 100.5]],
          closed: false,
          stroke: { color: "black", width: 1 },
          hiddenLineRole: "source",
        },
        {
          points: [[700, 500], [699.5, 500]],
          closed: false,
          stroke: { color: "black", width: 1 },
          hiddenLineRole: "source",
        },
      ],
    });
    const ordinarySvg = await readBlobText(downloadBlob.mock.calls.at(-1)![0]);
    const ordinaryDocument = new DOMParser().parseFromString(
      ordinarySvg,
      "image/svg+xml",
    );
    expect(ordinaryDocument.documentElement.getAttribute("viewBox")).toBe(
      "0 0 800 600",
    );
    expect(
      [...ordinaryDocument.querySelectorAll(":root > path")].map((path) =>
        path.getAttribute("d"),
      ),
    ).toEqual([
      "M50 50 L50.5 50",
      "M300 100 L300 100.5",
      "M700 500 L699.5 500",
    ]);

    clickButton(el, "Outline");
    expect(outlineJob.starts).toBe(1);
    clickButton(el, "Export Hidden-line SVG");
    await flush();
    expect(outlineJob.exportStarts).toBe(1);
    expect(outlineJob.exportDerivations).toBe(0);
    expect(outlineJob.lastExportSnapshot).toMatchObject({
      pageFrame,
      identity: {
        sourceKind: "completed-scene-sketch",
        compositionFrame: composition,
        sourceScene: stipples,
        outlineTarget: {
          toolWidthMillimeters: 0.5,
          millimetersPerSceneUnit: 0.16,
        },
      },
      reusableOutline: { scene: cachedOutline },
    });
    expect(plotterExportCapture.current?.scene).toEqual({
      space: { width: 800, height: 600 },
      primitives: [
        {
          points: [[50, 50], [50.5, 50]],
          stroke: { color: "black", width: 3.125 },
        },
        {
          points: [[300, 100], [300, 100.5]],
          stroke: { color: "black", width: 3.125 },
        },
        {
          points: [[700, 500], [699.5, 500]],
          stroke: { color: "black", width: 3.125 },
        },
        {
          points: [[0, 0], [800, 0], [800, 600], [0, 600], [0, 0]],
          stroke: { color: "black", width: 3.125 },
        },
      ],
    });
    const plotterSvg = await readBlobText(downloadBlob.mock.calls.at(-1)![0]);
    const plotterDocument = new DOMParser().parseFromString(
      plotterSvg,
      "image/svg+xml",
    );
    const paths = [...plotterDocument.querySelectorAll(":root > path")];
    expect(paths.map((path) => path.getAttribute("d"))).toEqual([
      "M28 28 L28.08 28",
      "M68 36 L68 36.08",
      "M132 100 L131.92 100",
      "M20 20 L148 20 L148 116 L20 116 L20 20",
    ]);
    expect(paths.map((path) => path.getAttribute("stroke-width"))).toEqual([
      "0.5",
      "0.5",
      "0.5",
      "0.5",
    ]);
    expect(plotterSvg).not.toMatch(/<rect\b|fill="(?!none)/);
    expect(generate).not.toHaveBeenCalled();

    clickButton(el, "Crop");
    clickButton(el, "Reset Frame");
    expect(lastCommittedPageFrame).toBeNull();
    expect(lastCompositionFrame).toBe(composition);
    expect(shadingJob.starts).toHaveLength(2);
    expect(outlineJob.starts).toBe(1);

    downloadBlob.mockClear();
    exportSceneCapture.current = null;
    outlineJob.exportStarts = 0;
    const paperWidth = el.querySelector<HTMLInputElement>(
      'input[aria-label="Paper width (mm)"]',
    )!;
    act(() => paperWidth.focus());
    setInput(paperWidth, "300");
    act(() => paperWidth.blur());

    expect(lastCompositionFrame).not.toBe(composition);
    expect(shadingJob.starts).toHaveLength(3);
    expect(shadingJob.starts[2]!.identity.compositionFrame).toEqual(
      lastCompositionFrame,
    );
    expect(outlineJob.starts).toBe(1);
    const staleOrdinary = exportButton(el, "Export SVG");
    const stalePlotter = exportButton(el, "Export Hidden-line SVG");
    expect([staleOrdinary.disabled, stalePlotter.disabled]).toEqual([
      true,
      true,
    ]);
    act(() => {
      for (const candidate of [staleOrdinary, stalePlotter]) {
        candidate.disabled = false;
        candidate.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });
    await flush();
    expect(exportSceneCapture.current).toBeNull();
    expect(outlineJob.exportStarts).toBe(0);
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("carries the exact painted Shading Scene through completed-Scene Outline identity and reuse", async () => {
    autoFireOutlineComputed = false;
    const generate = vi.fn(toneCalibration.generate);
    const deriveOutlineSource = vi.fn((completed: Readonly<Scene>) =>
      structuredClone(completed),
    );
    const el = mount(
      <SketchControls
        sketch={{ ...toneCalibration, generate, deriveOutlineSource }}
      />,
    );
    const exactScene = preparedScene(21);
    exactScene.primitives[0]!.stroke = { color: "navy", width: 0.75 };
    await completeShading(0, exactScene);

    clickButton(el, "Outline");
    expect(outlineJob.starts).toBe(1);
    const identity = outlineJob.lastIdentity;
    expect(identity?.sourceKind).toBe("completed-scene-sketch");
    if (identity?.sourceKind !== "completed-scene-sketch") {
      throw new Error("expected completed-Scene identity");
    }
    expect(identity.sourceScene).toEqual(exactScene);
    expect(identity.sourceScene).not.toBe(exactScene);
    expect(identity.outlineTarget).toEqual({
      toolWidthMillimeters: 0.3,
      millimetersPerSceneUnit: expect.any(Number),
    });
    expect(generate).not.toHaveBeenCalled();
    expect(deriveOutlineSource).not.toHaveBeenCalled();

    act(() => lastOnOutlineComputed?.());
    clickButton(el, "Export Hidden-line SVG");
    await flush();
    expect(outlineJob.exportStarts).toBe(1);
    expect(outlineJob.exportDerivations).toBe(0);
    expect(outlineJob.lastExportSnapshot?.identity.sourceKind).toBe(
      "completed-scene-sketch",
    );
    expect(outlineJob.lastExportSnapshot?.reusableOutline).toBeDefined();
    expect(generate).not.toHaveBeenCalled();
    expect(deriveOutlineSource).not.toHaveBeenCalled();

    outlineJob.exportStarts = 0;
    clickButton(el, "New seed");
    act(() => {
      const hidden = exportButton(el, "Export Hidden-line SVG");
      hidden.disabled = false;
      hidden.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(outlineJob.exportStarts).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    ["Tone Calibration", toneCalibration],
    ["Scribble Moon", scribbleMoon],
  ] as const)(
    "repaints cached %s geometry for physical style and replaces it at the frame-aspect boundary",
    async (_name, sketch) => {
      autoFireOutlineComputed = false;
      const generate = vi.fn(sketch.generate);
      const el = mount(<SketchControls sketch={{ ...sketch, generate }} />);
      const firstFrame = lastCompositionFrame!;
      const firstScene: Scene = {
        ...preparedScene(31),
        space: { ...firstFrame },
      };
      firstScene.primitives[0]!.stroke = { color: "black", width: 9 };
      await completeShading(0, firstScene);

      clickButton(el, "Outline");
      expect(outlineJob.starts).toBe(1);
      const initialOutline = outlineJob.lastIdentity;
      expect(initialOutline).toMatchObject({
        sourceKind: "completed-scene-sketch",
        compositionFrame: firstFrame,
        sourceScene: firstScene,
        outlineTarget: {
          toolWidthMillimeters: 0.3,
          millimetersPerSceneUnit: 0.18,
        },
      });
      act(() => lastOnOutlineComputed?.());
      await flush();
      expect(lastRenderScene?.primitives[0]?.stroke?.width).toBe(9);
      expect(lastOutlineFinalizationStrokePolicy?.target).toEqual({
        toolWidthMillimeters: 0.3,
        millimetersPerSceneUnit: 0.18,
      });
      const cachedOutlineScene = lastRenderScene;

      const margin = el.querySelector<HTMLInputElement>(
        'input[aria-label="Linked paper margin (mm)"]',
      )!;
      act(() => margin.focus());
      setInput(margin, "20");
      act(() => margin.blur());

      expect(shadingJob.starts).toHaveLength(1);
      expect(lastCompositionFrame).toBe(firstFrame);
      expect(outlineJob.starts).toBe(1);
      expect(outlineJob.lastIdentity).toBe(initialOutline);
      expect(lastRenderScene).toBe(cachedOutlineScene);
      expect(lastOutlineFinalizationStrokePolicy?.target).toEqual({
        toolWidthMillimeters: 0.3,
        millimetersPerSceneUnit: 0.16,
      });

      const toolWidth = el.querySelector<HTMLInputElement>(
        'input[aria-label="Tool width (mm)"]',
      )!;
      act(() => toolWidth.focus());
      setInput(toolWidth, "0.5");
      act(() => toolWidth.blur());

      expect(shadingJob.starts).toHaveLength(1);
      expect(lastCompositionFrame).toBe(firstFrame);
      expect(outlineJob.starts).toBe(1);
      expect(outlineJob.lastIdentity).toBe(initialOutline);
      expect(lastRenderScene).toBe(cachedOutlineScene);
      expect(lastOutlineFinalizationStrokePolicy?.target).toEqual({
        toolWidthMillimeters: 0.5,
        millimetersPerSceneUnit: 0.16,
      });

      expect(exportButton(el, "Export Hidden-line SVG").disabled).toBe(false);
      clickButton(el, "Export Hidden-line SVG");
      expect(outlineJob.exportStarts).toBe(1);
      expect(outlineJob.exportDerivations).toBe(0);
      expect(outlineJob.lastExportSnapshot?.reusableOutline).toBeDefined();
      expect(outlineJob.lastExportSnapshot?.identity).toMatchObject({
        sourceKind: "completed-scene-sketch",
        outlineTarget: {
          toolWidthMillimeters: 0.5,
          millimetersPerSceneUnit: 0.16,
        },
      });

      const width = el.querySelector<HTMLInputElement>(
        'input[aria-label="Paper width (mm)"]',
      )!;
      act(() => width.focus());
      setInput(width, "300");
      act(() => width.blur());

      expect(lastCompositionFrame).not.toBe(firstFrame);
      expect(shadingJob.starts).toHaveLength(2);
      expect(shadingJob.starts[1]?.identity.compositionFrame).toEqual(
        lastCompositionFrame,
      );
      expect(outlineJob.starts).toBe(1);

      const replacementScene: Scene = {
        ...preparedScene(32),
        space: { ...lastCompositionFrame! },
      };
      await completeShading(1, replacementScene);
      await flush();
      expect(outlineJob.starts).toBe(2);
      expect(outlineJob.lastIdentity).toMatchObject({
        sourceKind: "completed-scene-sketch",
        compositionFrame: lastCompositionFrame!,
        sourceScene: replacementScene,
        outlineTarget: { toolWidthMillimeters: 0.5 },
      });
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it("waits for a cache re-promotion to repaint before re-enabling export", async () => {
    const el = mount(<SketchControls sketch={toneCalibration} />);
    await completeShading(0, preparedScene(1));
    const svg = exportButton(el, "Export SVG");
    expect(svg.disabled).toBe(false);

    autoAcknowledgeDisplayedScene = false;
    const density = paramInput(el, "pathDensity");
    act(() => density.focus());
    setInput(density, "2");
    act(() => {
      density.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(shadingJob.starts).toHaveLength(1);
    expect(svg.disabled).toBe(true);
    act(() => acknowledgeDisplayedScene?.());
    expect(svg.disabled).toBe(false);
  });

  it("drops an asynchronous PNG snapshot when its Shading provenance becomes stale", async () => {
    let finishToBlob: BlobCallback | null = null;
    fakeCanvasToBlob = vi.fn((callback: BlobCallback) => {
      finishToBlob = callback;
    }) as HTMLCanvasElement["toBlob"];
    const el = mount(<SketchControls sketch={toneCalibration} />);
    await completeShading(0, preparedScene(2));

    clickButton(el, "Export PNG");
    expect(finishToBlob).not.toBeNull();
    clickButton(el, "New seed");
    await act(async () => {
      (finishToBlob as BlobCallback)(
        new Blob([MINIMAL_PNG], { type: "image/png" }),
      );
      await Promise.resolve();
    });
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("exports a proven current Outline and rejects a stale displayed Outline", async () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={toneCalibration} />);
    await completeShading(0, preparedScene(3));
    clickButton(el, "Outline");
    act(() => lastOnOutlineComputed?.());
    const currentOutline = outlineJob.lastCompletedScene!;

    fakeDisplayedScene = {
      scene: currentOutline,
      t: 0,
      renderMode: "outline",
      tolerance: 0,
      includeFrame: true,
      sourceInputRevision: 0,
      contentRevision: 0,
    };
    clickButton(el, "Export Hidden-line SVG");
    expect(outlineJob.exportStarts).toBe(0);
    expect(downloadBlob).not.toHaveBeenCalled();

    fakeDisplayedScene = {
      ...fakeDisplayedScene,
      contentRevision: 1,
    };
    clickButton(el, "Export Hidden-line SVG");
    await flush();
    expect(outlineJob.exportStarts).toBe(1);
    expect(outlineJob.exportDerivations).toBe(0);
    expect(plotterExportCapture.current?.scene).toEqual(
      finalizedPlotterScene(currentOutline),
    );
    expect(downloadBlob).toHaveBeenCalledTimes(1);
  });

  it("keeps an acknowledged budget-exhausted Stippling result current across Fill and every export", async () => {
    autoFireOutlineComputed = false;
    const toBlob = vi.fn((callback: BlobCallback) => {
      callback(new Blob([MINIMAL_PNG], { type: "image/png" }));
    });
    fakeCanvasToBlob = toBlob as HTMLCanvasElement["toBlob"];
    const generate = vi.fn(toneCalibration.generate);
    const el = mount(
      <SketchControls sketch={{ ...toneCalibration, generate }} />,
    );
    selectValue(choiceParamSelect(el, "strategy"), "stippling");
    expect(shadingJob.starts).toHaveLength(2);

    const stipples: Scene = {
      space: { ...lastCompositionFrame! },
      primitives: [
        {
          points: [[150, 250], [150.5, 250]],
          closed: false,
          stroke: { color: "black", width: 1 },
          hiddenLineRole: "source",
        },
        {
          points: [[400, 300], [400, 300.5]],
          closed: false,
          stroke: { color: "black", width: 1 },
          hiddenLineRole: "source",
        },
        {
          points: [[800, 700], [799.5, 700]],
          closed: false,
          stroke: { color: "black", width: 1 },
          hiddenLineRole: "source",
        },
      ],
    };
    const sourcePoints = stipples.primitives.map(({ points }) => points);
    autoAcknowledgeDisplayedScene = false;
    await completeShading(1, stipples, {
      ...diagnostics,
      termination: "budget-exhausted",
      fidelity: { kind: "stippling", distributionError: 0.3 },
    });

    const diagnosticsPanel = shadingDisclosure(el);
    expect(diagnosticsPanel.textContent).toContain("Budget exhausted");
    expect(diagnosticsPanel.textContent).toContain(
      "bounded partial result, not a computation error",
    );
    expect(diagnosticsPanel.textContent).toContain("Distribution error30.00%");
    expect(diagnosticsPanel.textContent).not.toContain("Residual error");

    const png = exportButton(el, "Export PNG");
    const svg = exportButton(el, "Export SVG");
    const hidden = exportButton(el, "Export Hidden-line SVG");
    expect([png.disabled, svg.disabled, hidden.disabled]).toEqual([
      true,
      true,
      true,
    ]);
    act(() => {
      for (const candidate of [png, svg, hidden]) {
        candidate.disabled = false;
        candidate.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });
    await flush();
    expect(toBlob).not.toHaveBeenCalled();
    expect(exportSceneCapture.current).toBeNull();
    expect(outlineJob.exportStarts).toBe(0);
    expect(downloadBlob).not.toHaveBeenCalled();

    act(() => acknowledgeDisplayedScene?.());
    expect([png.disabled, svg.disabled, hidden.disabled]).toEqual([
      false,
      false,
      false,
    ]);
    expect(diagnosticsPanel.textContent).toContain("Budget exhausted");
    clickButton(el, "Fill");
    expect(lastRenderScene).toBe(stipples);

    clickButton(el, "Export SVG");
    expect(exportSceneCapture.current).toBe(stipples);
    expect(
      (exportSceneCapture.current as Scene).primitives.map(
        ({ points }) => points,
      ),
    ).toEqual(sourcePoints);
    clickButton(el, "Export PNG");
    await flush();
    expect(toBlob).toHaveBeenCalledOnce();

    const includeFrame = compositionFrameCheckbox(el);
    expect(includeFrame.checked).toBe(true);
    act(() => includeFrame.click());
    clickButton(el, "Outline");
    expect(outlineJob.starts).toBe(1);
    const identity = outlineJob.lastIdentity;
    expect(identity).toMatchObject({
      sourceKind: "completed-scene-sketch",
      sourceScene: stipples,
    });
    if (identity?.sourceKind !== "completed-scene-sketch") {
      throw new Error("expected completed-Scene Stippling identity");
    }
    expect(identity.sourceScene).not.toBe(stipples);
    expect(identity.sourceScene.primitives.map(({ points }) => points)).toEqual(
      sourcePoints,
    );
    act(() => lastOnOutlineComputed?.());
    await flush();
    const cachedOutline = outlineJob.lastCompletedScene!;
    expect(cachedOutline.primitives.map(({ points }) => points)).toEqual(
      sourcePoints,
    );

    clickButton(el, "Export Hidden-line SVG");
    await flush();
    expect(outlineJob.exportStarts).toBe(1);
    expect(outlineJob.exportDerivations).toBe(0);
    expect(outlineJob.lastExportSnapshot).toMatchObject({
      identity: { sourceKind: "completed-scene-sketch" },
      reusableOutline: { scene: cachedOutline },
    });
    const plotterScene = plotterExportCapture.current?.scene as Scene;
    expect(plotterScene.primitives.map(({ points }) => points)).toEqual(
      sourcePoints,
    );
    expect(
      plotterScene.primitives.every(
        ({ points, closed }) => points.length === 2 && closed !== true,
      ),
    ).toBe(true);
    expect(shadingJob.starts).toHaveLength(2);
    expect(generate).not.toHaveBeenCalled();
    expect(downloadBlob).toHaveBeenCalledTimes(3);

    toBlob.mockClear();
    downloadBlob.mockClear();
    exportSceneCapture.current = null;
    outlineJob.exportStarts = 0;
    const density = paramInput(el, "stippleDensity");
    act(() => density.focus());
    setInput(density, "1.4");
    act(() => density.blur());
    expect(shadingJob.starts).toHaveLength(3);
    expect([png.disabled, svg.disabled, hidden.disabled]).toEqual([
      true,
      true,
      true,
    ]);
    act(() => {
      for (const candidate of [png, svg, hidden]) {
        candidate.disabled = false;
        candidate.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });
    await flush();
    expect(toBlob).not.toHaveBeenCalled();
    expect(exportSceneCapture.current).toBeNull();
    expect(outlineJob.exportStarts).toBe(0);
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("holds empty/current/stale artwork and settles one latest edit without main-thread generation", async () => {
    const generate = vi.fn(toneCalibration.generate);
    const sketch = { ...toneCalibration, generate };
    const el = mount(<SketchControls sketch={sketch} />);
    const canvas = el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!;

    expect(shadingJob.starts).toHaveLength(1);
    expect(canvas.dataset.renderState).toBe("fill-held");
    expect(canvas.dataset.contentRevision).toBe("");
    expect(generate).not.toHaveBeenCalled();

    await completeShading(0, preparedScene(1));
    expect(canvas.dataset.sourceInputRevision).toBe("0");
    expect(canvas.dataset.contentRevision).toBe("1");

    const density = paramInput(el, "pathDensity");
    act(() => density.focus());
    setInput(density, "2");
    setInput(density, "3");
    expect(canvas.dataset.sourceInputRevision).toBe("0");
    expect(canvas.dataset.contentRevision).toBe("1");
    expect(shadingJob.starts).toHaveLength(1);

    act(() => density.blur());
    expect(shadingJob.starts).toHaveLength(2);
    expect(shadingJob.starts[1]!.identity.params).toContainEqual({
      key: "pathDensity",
      value: 3,
    });
    expect(generate).not.toHaveBeenCalled();

    await completeShading(1, preparedScene(2));
    expect(canvas.dataset.sourceInputRevision).toBe("2");
    expect(canvas.dataset.contentRevision).toBe("2");
  });

  it("keeps Scribble Moon Tone live while artwork is pending and retains its completed contours", async () => {
    const generate = vi.fn(scribbleMoon.generate);
    const el = mount(
      <SketchControls sketch={{ ...scribbleMoon, generate }} />,
    );
    clickButton(el, "Tone");
    const originalSource = lastToneSource;
    const lightAngle = paramInput(el, "lightAngle");

    act(() => lightAngle.focus());
    setInput(lightAngle, "180");

    expect(lastToneSource).not.toBeNull();
    expect(lastToneSource).not.toBe(originalSource);
    expect(shadingJob.starts).toHaveLength(1);
    act(() => lightAngle.blur());
    expect(shadingJob.starts).toHaveLength(2);
    expect(shadingJob.starts[1]!.identity.params).toContainEqual({
      key: "lightAngle",
      value: 180,
    });

    const structural = createScribbleMoonStructuralScene(
      lastCompositionFrame!,
    );
    const completeMoon: Scene = {
      space: { ...structural.space },
      primitives: [
        ...structural.primitives,
        {
          points: [[1, 1], [2, 2]],
          closed: false,
          stroke: { color: "black", width: 0.1 },
          hiddenLineRole: "source",
        },
      ],
    };
    await completeShading(1, completeMoon);
    clickButton(el, "Fill");
    clickButton(el, "Export SVG");
    expect(exportSceneCapture.current).toBe(completeMoon);
    expect(
      (exportSceneCapture.current as Scene).primitives.slice(
        0,
        structural.primitives.length,
      ),
    ).toEqual(structural.primitives);
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps progress observational and out of params, Presets, history, and export metadata", async () => {
    const el = mount(<SketchControls sketch={toneCalibration} />);
    reportShadingProgress(0, 30, 100, {
      kind: "remaining",
      revision: 2,
      remainingMs: 7_000,
    });

    expect(
      [...el.querySelectorAll('#inspector input[id^="control-"]')].map(
        (input) => input.id,
      ),
    ).toEqual([
      "control-pathDensity",
      "control-scribbleScale",
      "control-momentum",
      "control-chaos",
      "control-toneFidelity",
      "control-stopPoint",
    ]);
    expect(historyCapture.atomic).toHaveLength(0);
    expect(historyCapture.transactionCommits).toHaveLength(0);
    expect(historyCapture.cancels).toHaveLength(0);

    setInput(
      el.querySelector('input[aria-label="preset name"]') as HTMLInputElement,
      "observational-state",
    );
    clickButton(el, "Save");
    await flush();
    const saved = JSON.stringify(savePreset.mock.calls[0]![0]);
    expect(saved).not.toMatch(
      /completedWorkUnits|totalWorkUnits|remainingMs|diagnostics|computeTimeMs/,
    );

    await completeShading(0, preparedScene(8));
    clickButton(el, "Export SVG");
    const svgBlob = downloadBlob.mock.calls[0]![0];
    const svg = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(svgBlob);
    });
    const embedded = svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1];
    expect(embedded).toBeDefined();
    expect(embedded).not.toMatch(
      /completedWorkUnits|totalWorkUnits|remainingMs|diagnostics|computeTimeMs/,
    );

    clickButton(el, "Export Hidden-line SVG");
    await flush();
    expect(plotterExportCapture.current?.metadata).toBeDefined();
    expect(plotterExportCapture.current?.metadata).not.toMatch(
      /completedWorkUnits|totalWorkUnits|remainingMs|diagnostics|computeTimeMs/,
    );

    clickButton(el, "Export PNG");
    await flush();
    const pngBlob = downloadBlob.mock.calls[2]![0];
    const pngText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(pngBlob);
    });
    expect(pngText).toContain("tone-calibration");
    expect(pngText).not.toMatch(
      /completedWorkUnits|totalWorkUnits|remainingMs|diagnostics|computeTimeMs/,
    );
  });

  it("waits for the current paint before Outline and preserves its provenance", async () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={toneCalibration} />);
    const canvas = el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!;
    await completeShading(0, preparedScene(1));

    const density = paramInput(el, "pathDensity");
    act(() => density.focus());
    setInput(density, "4");
    act(() => density.blur());
    clickButton(el, "Outline");
    expect(outlineJob.starts).toBe(0);
    expect(canvas.dataset.sourceInputRevision).toBe("0");

    await completeShading(1, preparedScene(2));
    await flush();
    expect(outlineJob.starts).toBe(1);
    expect(outlineJob.lastIdentity?.params).toContainEqual({
      key: "pathDensity",
      value: 4,
    });

    act(() => lastOnOutlineComputed?.());
    expect(canvas.dataset.renderMode).toBe("outline");
    expect(canvas.dataset.sourceInputRevision).toBe("1");
    expect(canvas.dataset.contentRevision).toBe("2");

    act(() => density.focus());
    setInput(density, "5");
    expect(canvas.dataset.renderMode).toBe("fill");
    expect(canvas.dataset.sourceInputRevision).toBe("1");
    expect(canvas.dataset.contentRevision).toBe("2");
    expect(outlineJob.starts).toBe(1);
  });

  it("releases an Outline-only edit after active export with the painted Shading provenance", async () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={toneCalibration} />);
    const canvas = el.querySelector<HTMLElement>('[data-testid="canvas-seed"]')!;
    await completeShading(0, preparedScene(1));

    clickButton(el, "Outline");
    expect(outlineJob.starts).toBe(1);
    act(() => lastOnOutlineComputed?.());
    expect(canvas.dataset.renderMode).toBe("outline");

    fakeDisplayedScene = {
      scene: outlineJob.lastCompletedScene!,
      t: 0,
      renderMode: "outline",
      tolerance: 0,
      includeFrame: true,
      inputRevision: 0,
      sourceInputRevision: 0,
      contentRevision: 1,
    };
    outlineJob.exportMode = "pending";
    clickButton(el, "Export Hidden-line SVG");

    const tolerance = el.querySelector<HTMLInputElement>("#sketch-tolerance")!;
    act(() => tolerance.focus());
    setInput(tolerance, "1");
    act(() => tolerance.blur());
    expect(outlineJob.starts).toBe(1);

    await act(async () => {
      outlineJob.pendingExport!.succeed();
      await Promise.resolve();
    });
    expect(outlineJob.starts).toBe(2);
    expect(outlineJob.lastIdentity?.tolerance).toBe(1);
    expect(canvas.dataset.sourceInputRevision).toBe("0");
    expect(canvas.dataset.contentRevision).toBe("2");

    act(() => lastOnOutlineComputed?.());
    expect(canvas.dataset.renderMode).toBe("outline");
    expect(
      [...el.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Export Hidden-line SVG",
      )?.disabled,
    ).toBe(false);
  });

  it("disposes each Shading coordinator across StrictMode and keyed switches", () => {
    mount(
      <StrictMode>
        <SketchControls key="calibration" sketch={toneCalibration} />
      </StrictMode>,
    );
    expect(shadingJob.coordinators).toBe(2);
    expect(shadingJob.disposals).toBe(1);

    act(() => {
      root!.render(
        <StrictMode>
          <SketchControls key="moon" sketch={scribbleMoon} />
        </StrictMode>,
      );
    });
    expect(shadingJob.coordinators).toBe(4);
    expect(shadingJob.disposals).toBe(3);

    act(() => root!.unmount());
    root = null;
    expect(shadingJob.disposals).toBe(4);
  });
});

describe("SketchControls — background Outline session (#289)", () => {
  it("creates a live coordinator after StrictMode rehearsal and disposes each lifetime", () => {
    autoFireOutlineComputed = false;
    const el = mount(
      <StrictMode>
        <SketchControls sketch={sketchWith("a", {})} />
      </StrictMode>,
    );

    expect(outlineJob.coordinators).toBe(2);
    expect(outlineJob.disposals).toBe(1);
    clickButton(el, "Fill");
    expect(outlineJob.starts).toBe(1);
    act(() => lastOnOutlineComputed?.());
    expect(canvasRenderMode(el)).toBe("outline");
    expect(el.textContent).not.toContain("Outline failed");

    act(() => root!.unmount());
    root = null;
    expect(outlineJob.disposals).toBe(2);
  });

  it("cancels at edit begin, launches no preview jobs, and starts one final changed job", () => {
    autoFireOutlineComputed = false;
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", { radius: numberSpec({ default: 10 }) })}
      />,
    );
    clickButton(el, "Fill");
    expect(outlineJob.starts).toBe(1);
    expect(outlineJob.active).not.toBeNull();

    const radius = paramInput(el, "radius");
    act(() => radius.focus());
    setInput(radius, "42");
    expect(outlineJob.starts).toBe(1);
    expect(outlineJob.active).toBeNull();
    expect(canvasRenderMode(el)).toBe("fill");
    expect(
      el
        .querySelector('[data-testid="canvas-seed"]')
        ?.getAttribute("data-render-state"),
    ).toBe("fill-live");

    act(() =>
      radius.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(outlineJob.starts).toBe(2);
    expect(canvasRenderMode(el)).toBe("fill");
    act(() => lastOnOutlineComputed?.());
    expect(canvasRenderMode(el)).toBe("outline");
  });

  it("reveals Cancel outline only after the 750ms quiet period and keeps ordinary actions usable", () => {
    autoFireOutlineComputed = false;
    const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
    vi.useFakeTimers();
    try {
      clickButton(el, "Fill");
      expect(el.textContent).not.toContain("Cancel outline");
      act(() => vi.advanceTimersByTime(749));
      expect(el.textContent).not.toContain("Cancel outline");
      act(() => vi.advanceTimersByTime(1));
      expect(el.textContent).toContain("Cancel outline");
      expect(
        [...el.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Export PNG"),
        )?.disabled,
      ).toBe(false);
      expect(
        [...el.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Export SVG"),
        )?.disabled,
      ).toBe(false);
      expect(
        [...el.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Export Hidden-line SVG"),
        )?.disabled,
      ).toBe(true);
      clickButton(el, "Cancel outline");
      expect(el.textContent).not.toContain("Cancel outline");
      expect(el.querySelector("progress")).toBeNull();
      expect(
        el.querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle outline render mode"]',
        )?.textContent,
      ).toBe("Fill");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not flash or delay the UI when Outline succeeds during the grace period", () => {
    autoFireOutlineComputed = false;
    vi.useFakeTimers();
    try {
      const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
      clickButton(el, "Fill");
      act(() => lastOnOutlineComputed?.());
      expect(canvasRenderMode(el)).toBe("outline");
      expect(el.textContent).not.toContain("Cancel outline");

      act(() => vi.advanceTimersByTime(750));
      expect(el.textContent).not.toContain("Cancel outline");
      expect(el.querySelector('progress[aria-label="Outline progress"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows native progress, integer percentage, and rolling ETA after reveal", () => {
    autoFireOutlineComputed = false;
    vi.useFakeTimers();
    try {
      const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
      clickButton(el, "Fill");
      reportOutlineProgress(1, 4);
      act(() => vi.advanceTimersByTime(750));

      const progress = el.querySelector<HTMLProgressElement>(
        'progress[aria-label="Outline progress"]',
      )!;
      expect(progress.value).toBe(1);
      expect(progress.max).toBe(4);
      expect(el.textContent).toContain("25%");
      expect(el.textContent).toContain("Estimating time remaining…");
      expect(
        el
          .querySelector('button[aria-label="Toggle outline render mode"]')
          ?.getAttribute("aria-busy"),
      ).toBe("true");

      reportOutlineProgress(2, 4, {
        kind: "remaining",
        revision: 2,
        remainingMs: 4_200,
      });
      expect(progress.value).toBe(2);
      expect(progress.max).toBe(4);
      expect(el.textContent).toContain("50%");
      expect(el.textContent).toContain("5 seconds remaining");
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces availability politely once without making every update a live status", () => {
    autoFireOutlineComputed = false;
    vi.useFakeTimers();
    try {
      const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
      clickButton(el, "Fill");
      reportOutlineProgress(1, 3);
      act(() => vi.advanceTimersByTime(750));

      const statuses = el.querySelectorAll('[role="status"][aria-live="polite"]');
      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.textContent).toContain("Outline processing");
      expect(statuses[0]?.textContent).not.toContain("33%");
      expect(statuses[0]?.textContent).not.toContain("Estimating");
      expect(el.querySelector("progress")?.closest('[aria-live]')).toBeNull();

      reportOutlineProgress(2, 3, {
        kind: "remaining",
        revision: 2,
        remainingMs: 61_000,
      });
      expect(statuses[0]?.textContent).toContain("Outline processing");
      expect(el.textContent).toContain("67%");
      expect(el.textContent).toContain("2 minutes remaining");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the quiet period for replacements before and after reveal", () => {
    autoFireOutlineComputed = false;
    let randomValue = 0.1;
    vi.spyOn(Math, "random").mockImplementation(() => {
      randomValue += 0.1;
      return randomValue;
    });
    const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
    vi.useFakeTimers();
    try {
      clickButton(el, "Fill");
      expect(outlineJob.starts).toBe(1);
      act(() => vi.advanceTimersByTime(749));
      clickButton(el, "New seed");
      expect(outlineJob.starts).toBe(2);
      act(() => vi.advanceTimersByTime(1));
      expect(el.textContent).not.toContain("Cancel outline");
      act(() => vi.advanceTimersByTime(748));
      expect(el.textContent).not.toContain("Cancel outline");
      act(() => vi.advanceTimersByTime(1));
      expect(el.textContent).toContain("Cancel outline");

      clickButton(el, "New seed");
      expect(outlineJob.starts).toBe(3);
      expect(el.textContent).not.toContain("Cancel outline");
      act(() => vi.advanceTimersByTime(749));
      expect(el.textContent).not.toContain("Cancel outline");
      act(() => vi.advanceTimersByTime(1));
      expect(el.textContent).toContain("Cancel outline");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets progress on replacement and ignores callbacks from the stale token", () => {
    autoFireOutlineComputed = false;
    let randomValue = 0.1;
    vi.spyOn(Math, "random").mockImplementation(() => (randomValue += 0.1));
    vi.useFakeTimers();
    try {
      const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
      clickButton(el, "Fill");
      const staleObserver = outlineJob.active!.observeProgress!;
      reportOutlineProgress(1, 4);
      act(() => vi.advanceTimersByTime(750));
      expect(el.textContent).toContain("25%");

      clickButton(el, "New seed");
      expect(el.textContent).not.toContain("25%");
      act(() => {
        staleObserver({
          snapshot: {
            completedWorkUnits: 3,
            totalWorkUnits: 4,
            terminal: false,
          },
          eta: { kind: "remaining", revision: 2, remainingMs: 1_000 },
        });
        vi.advanceTimersByTime(750);
      });
      expect(el.textContent).not.toContain("75%");

      reportOutlineProgress(1, 2);
      expect(el.textContent).toContain("50%");
      expect(
        el.querySelector<HTMLProgressElement>("progress")?.max,
      ).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears revealed progress on success and keyed remount", () => {
    autoFireOutlineComputed = false;
    vi.useFakeTimers();
    try {
      const el = mount(
        <SketchControls key="a" sketch={sketchWith("a", {})} />,
      );
      clickButton(el, "Fill");
      reportOutlineProgress(1, 2);
      act(() => vi.advanceTimersByTime(750));
      expect(el.textContent).toContain("50%");

      act(() => lastOnOutlineComputed?.());
      expect(el.querySelector("progress")).toBeNull();
      expect(
        el
          .querySelector('button[aria-label="Toggle outline render mode"]')
          ?.getAttribute("aria-busy"),
      ).toBe("false");

      act(() => {
        root!.render(
          <SketchControls key="b" sketch={sketchWith("b", {})} />,
        );
      });
      expect(el.querySelector("progress")).toBeNull();
      expect(el.textContent).not.toContain("50%");
      expect(
        el
          .querySelector('button[aria-label="Toggle outline render mode"]')
          ?.getAttribute("aria-busy"),
      ).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a sanitized recoverable failure while logging technical detail", () => {
    autoFireOutlineComputed = false;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const el = mount(<SketchControls sketch={sketchWith("a", {})} />);
      clickButton(el, "Fill");
      reportOutlineProgress(1, 2);
      act(() => vi.advanceTimersByTime(750));
      expect(el.querySelector("progress")).not.toBeNull();

      const active = outlineJob.active!;
      act(() => {
        outlineJob.active = null;
        active.resolve({
          status: "failure",
          jobId: 1,
          error: "geometry\u0000 exploded",
        });
      });
      expect(el.querySelector("progress")).toBeNull();
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(
        "Outline failed: geometry  exploded",
      );
      const toggle = el.querySelector<HTMLButtonElement>(
        'button[aria-label="Toggle outline render mode"]',
      )!;
      expect(toggle.textContent).toBe("Fill");
      expect(toggle.disabled).toBe(false);
      expect(consoleError).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the full active interval and clears it on keyed unmount", () => {
    autoFireOutlineComputed = false;
    const changes: boolean[] = [];
    const el = mount(
      <SketchControls
        sketch={sketchWith("a", {})}
        onHiddenLineBusyChange={(busy) => changes.push(busy)}
      />,
    );
    clickButton(el, "Fill");
    expect(changes.at(-1)).toBe(true);
    act(() => root!.unmount());
    root = null;
    expect(changes.at(-1)).toBe(false);
  });
});
