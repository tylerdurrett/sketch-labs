import { PanelRightClose, PanelRightOpen } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  applyPreset,
  buildReproMetadata,
  clipSceneToBounds,
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  defaultParams,
  exportFilename,
  fitPageFramePlotProfileToAspect,
  frameScene,
  insertPngMetadata,
  newSeed,
  plotDrawableAspectsEquivalent,
  plotDrawableRectangle,
  randomize,
  renderToSVG,
  resizePageFramePlotProfileProportionally,
  resolveOutputProfile,
  type PlotProfile,
  type Preset,
  type PresetFraming,
  type DetailField,
  type OutlineTarget,
  type PlotSequenceDeclaration,
  type Scene,
  type Sketch,
  type SketchEnvironment,
} from "@harness/core";

import { ControlPanel, type ControlPanelProps } from "./ControlPanel";
import type { ImageAssetControlRecomposeRequest } from "./ImageAssetControl";
import { Button } from "./components/ui/button";
import { downloadBlob } from "./downloadBlob";
import {
  createDetailPreparationIdentity,
  detailPreparationIdentitiesEqual,
  type DetailPreparationIdentity,
} from "./detailPreparationProtocol";
import {
  beginEditTransaction,
  canRedo,
  canUndo,
  cancelEditTransaction,
  commitEditState,
  commitEditTransaction,
  createEditHistory,
  hasActiveTransaction,
  previewEditState,
  redoEdit,
  undoEdit,
  type EditHistory,
  type StudioEditState,
} from "./editHistory";
import {
  applyPageFrameEditDraft,
  initialPageFrameForEdit,
  recomposePageToProfile,
  resetPageFrameEditDraft,
  resolveStudioCompositionFrame,
  sameStudioPhysicalScale,
  studioGenerationAspect,
  studioMillimetersPerCompositionUnit,
  setPageAspectLocked,
} from "./pageFrameEditing";
import {
  openPageFrameEditDraft,
  pageFrameEditDraftProfile,
  panFixedPageFrame,
  setScalePreservingPageFrame,
  type PageFrameEditDraft,
} from "./pageFrameEditDraft";
import {
  detectHistoryShortcutPlatform,
  fieldOwnsHistoryShortcut,
  historyShortcutFor,
} from "./historyShortcuts";
import { exactEnvironmentReady } from "./exactEnvironmentReadiness";
import {
  LiveCanvas,
  type DisplayedSceneSnapshot,
  type FillCapture,
  type LiveCanvasHandle,
  type LiveCanvasRenderState,
} from "./LiveCanvas";
import {
  HiddenLineCoordinator,
  type HiddenLineProgressUpdate,
} from "./hiddenLineCoordinator";
import {
  createHiddenLineExportSnapshot,
  createOutlineComputeIdentity,
  mutableScene,
  outlineGeometryIdentitiesEqual,
} from "./outlineComputeProtocol";
import type { OutlineFinalizationStrokePolicy } from "./outlineScene";
import {
  createOutlineSessionState,
  outlineSessionReducer,
  type OutlineSessionAction,
} from "./outlineSession";
import {
  PaperSection,
  type PaperProfileCandidateDecision,
  type PaperProfileCandidateSource,
} from "./PaperSection";
import { readPaperDisplayUnit } from "./paperDisplayUnit";
import { PageFrameEditor } from "./PageFrameEditor";
import type { PageFrameAspectConstraint } from "./pageFrameManipulation";
import { PlotSequenceStageControls } from "./PlotSequenceStageControls";
import {
  readPlotterSvgIncludePaperMargins,
  writePlotterSvgIncludePaperMargins,
} from "./plotterSvgPreference";
import { PresetControls } from "./PresetControls";
import { SeedControl } from "./SeedControl";
import {
  ShadingDiagnostics,
  type DisplayedShadingDiagnostics,
  type ShadingPreparationDiagnostics,
} from "./ShadingDiagnostics";
import { SimplifyControl } from "./SimplifyControl";
import { selectCurrentShadingResult } from "./shadingSession";
import {
  acknowledgedCurrentShading,
  type ShadingPaintAcknowledgement,
} from "./shadingExportReadiness";
import { shadingIdentityParams } from "./shadingComputeProtocol";
import {
  useShadingPreparation,
  type ShadingAuthoredState,
} from "./useShadingPreparation";
import { useSketchEnvironment } from "./useSketchEnvironment";
import { STUDIO_IMAGE_ASSET_LONG_EDGE_CAP } from "./studioConfig";
import { useDetailPreparation } from "./useDetailPreparation";
import type { PlotSequencePresentation } from "./plotSequencePresentation";
import { usePlotSequencePresentation } from "./usePlotSequencePresentation";
import {
  useRegisteredStagePreparation,
  type RegisteredStageAuthoredState,
  type RegisteredStagePreparationSketch,
} from "./useRegisteredStagePreparation";

type DiagnosticSelection = null | "tone" | "detail";

function presentationIsIsolatedPrimary(
  declaration: PlotSequenceDeclaration | undefined,
  presentation: PlotSequencePresentation,
): boolean {
  if (declaration === undefined) return true;
  const primary = declaration.stages.find(
    (stage) => stage.source.kind === "primary",
  );
  return (
    primary !== undefined &&
    presentation.kind === "isolated" &&
    presentation.stageId === primary.id
  );
}

type DetailReferenceDerivation =
  | { readonly kind: "ready"; readonly field: DetailField }
  | { readonly kind: "loading" }
  | {
      readonly kind: "failure";
      readonly rejection?: {
        readonly token: number;
        readonly identity: DetailPreparationIdentity;
        readonly error: unknown;
      };
    };

function formatOutlineEta(remainingMs: number): string {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1_000));
  if (seconds < 60) {
    return `${seconds} ${seconds === 1 ? "second" : "seconds"} remaining`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} remaining`;
}

function safeExportFailureDetail(detail: string): string {
  return detail.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160);
}

/** Preset params are flat schema values; preserve identity when reload is equal. */
function sameParams(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]),
    )
  );
}

const DETAIL_REFERENCE_ONLY_PARAM = "detailSensitivity";
const DETAIL_INFLUENCE_PARAM = "detailInfluence";

/** Normalize sensitivity out of artwork identity only when Detail is disabled. */
function artworkGenerationParams(
  sketch: Pick<Sketch, "schema" | "generateDetailField">,
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const spec = sketch.schema[DETAIL_REFERENCE_ONLY_PARAM];
  const influenceSpec = sketch.schema[DETAIL_INFLUENCE_PARAM];
  const influence =
    influenceSpec?.kind === "number" &&
    typeof params[DETAIL_INFLUENCE_PARAM] === "number"
      ? params[DETAIL_INFLUENCE_PARAM]
      : influenceSpec?.kind === "number"
        ? influenceSpec.default
        : 0;
  if (
    sketch.generateDetailField === undefined ||
    spec?.kind !== "number" ||
    influence > 0 ||
    Object.is(params[DETAIL_REFERENCE_ONLY_PARAM], spec.default)
  ) {
    return params;
  }
  return { ...params, [DETAIL_REFERENCE_ONLY_PARAM]: spec.default };
}

function artworkGenerationParamsEqual(
  sketch: Pick<Sketch, "schema" | "generateDetailField">,
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  return sameParams(
    artworkGenerationParams(sketch, left),
    artworkGenerationParams(sketch, right),
  );
}

/** Keep only normalized controls that affect the Primary Shading Stage. */
function shadingArtworkParams(
  sketch: Pick<
    Sketch,
    "schema" | "plotSequence" | "generateDetailField"
  >,
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return shadingIdentityParams(
    sketch,
    sketch.plotSequence === undefined
      ? artworkGenerationParams(sketch, params)
      : params,
  );
}

function shadingArtworkParamsEqual(
  sketch: Pick<
    Sketch,
    "schema" | "plotSequence" | "generateDetailField"
  >,
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  return sameParams(
    shadingArtworkParams(sketch, left),
    shadingArtworkParams(sketch, right),
  );
}

function isDetailReferenceOnlyParam(sketch: Sketch, key: string): boolean {
  return (
    key === DETAIL_REFERENCE_ONLY_PARAM &&
    sketch.generateDetailField !== undefined &&
    sketch.schema[key]?.kind === "number"
  );
}

/** Convert committed Studio framing to the persistence/export envelope shape. */
function persistedFramingFor(
  edit: StudioEditState,
): PresetFraming | undefined {
  return edit.framing.kind === "unframed"
    ? undefined
    : {
        pageFrame: { ...edit.framing.pageFrame },
        generationAspect: edit.framing.generationAspect,
        aspectLocked: edit.framing.aspectLocked,
      };
}

function outlineIdentitySourceFor(
  sketch: Sketch,
  edit: StudioEditState,
  sourceScene: Scene,
):
  | { sourceScene: Scene }
  | { outlineTarget: OutlineTarget }
  | { sourceScene: Scene; outlineTarget: OutlineTarget } {
  const outlineTarget = outlineTargetFor(edit);
  if (sketch.deriveOutlineSource !== undefined) {
    return { sourceScene, outlineTarget };
  }
  if (sketch.generateOutlineSource !== undefined) return { outlineTarget };
  return { sourceScene };
}

function outlineTargetFor(edit: StudioEditState): OutlineTarget {
  return {
    toolWidthMillimeters: edit.profile.toolWidthMillimeters,
    millimetersPerSceneUnit: studioMillimetersPerCompositionUnit(edit),
  };
}

/** Resolve the transient Page editor's physical target without committing it. */
function outlineEditForPageDraft(
  edit: StudioEditState,
  draft: PageFrameEditDraft | null,
): StudioEditState {
  if (draft === null) return edit;
  return {
    ...edit,
    profile: pageFrameEditDraftProfile(draft),
    framing: {
      kind: "framed",
      pageFrame: draft.frame,
      generationAspect: draft.generationAspect,
      aspectLocked:
        edit.framing.kind === "framed" && edit.framing.aspectLocked,
    },
  };
}

type OutlineEditChange =
  | "geometry"
  | "physical-style"
  | "placement"
  | "none";

/** Classify authored edits by the cheapest work needed for current Outline. */
function classifyOutlineEdit(
  sketch: Sketch,
  previous: StudioEditState,
  next: StudioEditState,
): OutlineEditChange {
  if (
    !(sketch.plotSequence === undefined
      ? artworkGenerationParamsEqual(sketch, previous.params, next.params)
      : shadingArtworkParamsEqual(sketch, previous.params, next.params)) ||
    previous.seed !== next.seed ||
    previous.tolerance !== next.tolerance ||
    !plotDrawableAspectsEquivalent(
      studioGenerationAspect(previous),
      studioGenerationAspect(next),
    )
  ) {
    return "geometry";
  }

  if (
    (sketch.generateOutlineSource !== undefined ||
      sketch.deriveOutlineSource !== undefined) &&
    (!Object.is(
      previous.profile.toolWidthMillimeters,
      next.profile.toolWidthMillimeters,
    ) ||
      !sameStudioPhysicalScale(previous, next))
  ) {
    return "physical-style";
  }

  if (
    previous.profile !== next.profile ||
    previous.framing !== next.framing
  ) {
    return "placement";
  }
  return "none";
}

/** Whether an edit changes the time-invariant Shading worker identity. */
function shadingInputsChanged(
  sketch: Sketch,
  previous: StudioEditState,
  next: StudioEditState,
): boolean {
  if (
    !shadingArtworkParamsEqual(sketch, previous.params, next.params) ||
    previous.seed !== next.seed
  ) {
    return true;
  }
  return !plotDrawableAspectsEquivalent(
    studioGenerationAspect(previous),
    studioGenerationAspect(next),
  );
}

/**
 * Hook-order placeholder for non-Sequence mounts.
 *
 * Its sole Primary has no capability, so D3 constructs no worker or generated
 * coordinator. Legacy rendering remains owned by its existing Shading hook.
 */
const INERT_PLOT_SEQUENCE: PlotSequenceDeclaration = Object.freeze({
  sharedParameters: Object.freeze([]),
  stages: Object.freeze([
    Object.freeze({
      id: "legacy-primary",
      name: "Legacy Primary",
      source: Object.freeze({
        kind: "primary",
        generatorId: "legacy-primary",
      }),
      parameters: Object.freeze([]),
      dependencies: Object.freeze({ usesSeed: false, usesTime: false }),
    }),
  ]),
});

/**
 * Props for {@link SketchControls}.
 */
export interface SketchControlsProps {
  /** The selected Sketch whose schema drives the controls and whose Scene renders. */
  sketch: Sketch;
  /**
   * The Sketch switcher, owned by App (it drives selection, which lives ABOVE
   * this keyed-remount instance) and rendered as a slot at the inspector
   * sidebar's top. Passed in rather than built here so switching Sketch — which
   * remounts this component — never resets the switcher's own selection state.
   * Optional: the control-wiring tests mount this component without a switcher,
   * in which case the sidebar simply renders no switcher slot.
   */
  switcher?: ReactNode;
  /**
   * Whether the inspector sidebar is hidden (#154). Owned by App (above this
   * keyed remount) so it persists across Sketch switches. When true the sidebar
   * is not rendered and the canvas region takes the full width. Defaults to
   * shown for the wiring tests, which mount without this prop.
   */
  collapsed?: boolean;
  /** Toggle the {@link collapsed} state — wired to the canvas-region toggle button. */
  onToggleCollapse?: () => void;
  /** Reports the complete capture/compute interval to App's navigation guard. */
  onHiddenLineBusyChange?: (busy: boolean) => void;
  /** Longest normalized source edge for Image Asset imports. */
  imageAssetLongEdgeCap?: number;
  /**
   * Internal deterministic seam for focused Plot Sequence wiring tests.
   * Production omits it, so every keyed mount starts on Primary.
   */
  initialPlotSequencePresentation?: PlotSequencePresentation;
}

/**
 * The single owner of one Sketch's live param values, wiring the control surface
 * to the live canvas.
 *
 * It seeds its state from {@link defaultParams} (the Sketch's schema defaults,
 * #47) and renders the {@link ControlPanel} (which tweaks those values) and the
 * {@link LiveCanvas} (which consumes them) over the SAME `params` state, so a
 * control tweak updates the canvas in real time.
 *
 * RESET-BY-REMOUNT: App mounts this with `key={sketch.id}`, so selecting a
 * different Sketch unmounts this instance and mounts a fresh one — the lazy
 * `useState` initializers re-run against the new Sketch and the params AND seed
 * reset (params to that Sketch's defaults, seed to a fresh roll). There is
 * deliberately NO manual reset effect; the key remount IS the reset mechanism.
 *
 * SEED is the FIRST randomness axis — a plain numeric value (groundwork for
 * Presets #8: the seed is the literal value a Preset captures and copies). The
 * studio backs the engine's `rand` with `Math.random` (the `value()` [0, 1)
 * shape). Editing the seed re-renders the canvas (LiveCanvas reads `seed`
 * through a ref) WITHOUT touching any param value — the two axes are independent.
 *
 * LOCKS are Randomize-EXCLUSION ONLY: the studio owns a generic `Set<string>` of
 * locked param keys, passed solely into `randomize` so a locked numeric key keeps
 * its value across a roll. Numeric controls expose the Lock affordance and stay
 * fully hand-editable while locked. Color controls expose no Lock because colors
 * never randomize; a persisted color key may still inhabit the generic Set and
 * round-trip unchanged as harmless inert data. Like `seed` and `params`, `locks`
 * lives in keyed-remount state, so a Sketch switch clears every lock for free.
 *
 * PROFILE is the session's ONE active Plot Profile — the physical-plot output
 * dimensions (#247). Like params/seed/locks it lives in keyed-remount state, so
 * it is RESOLVED fresh per Sketch: the lazy initializer runs `resolveOutputProfile`
 * against THIS Sketch's own `defaultOutputProfile` (#265's precedence: preset ??
 * sketch default ?? Harness fallback), so a Sketch switch re-resolves from the
 * newly-mounted Sketch and NEVER reuses the previous Sketch's dimensions. It is
 * threaded through persistence and composition — captured into a saved Preset
 * (via `PresetControls` → `makePreset`), re-resolved on a Preset reload (a v2/v3
 * Preset's stored profile wins; a v1 falls back to the Sketch default / Harness
 * fallback), and embedded into every export's reproduction metadata. A v3 reload
 * also restores the exact committed Page Frame and frozen generation aspect.
 * The active drawable aspect resolves the ONE Composition Frame shared by
 * preview and vector exports.
 */
export function SketchControls({
  sketch,
  switcher,
  collapsed = false,
  onToggleCollapse,
  onHiddenLineBusyChange,
  imageAssetLongEdgeCap = STUDIO_IMAGE_ASSET_LONG_EDGE_CAP,
  initialPlotSequencePresentation,
}: SketchControlsProps) {
  const [history, setHistory] = useState<EditHistory>(() =>
    createEditHistory({
      params: defaultParams(sketch.schema),
      seed: newSeed(Math.random),
      locks: new Set<string>(),
      profile: resolveOutputProfile(undefined, sketch.defaultOutputProfile),
      framing: { kind: "unframed" },
      tolerance: 0,
    }),
  );
  // Event lifecycles can emit begin/preview/commit in one React batch. Mirror the
  // latest transition synchronously so every signal sees the preceding result.
  const historyRef = useRef(history);
  historyRef.current = history;
  const { params, seed, locks, profile, tolerance } = history.present;
  const [pageFrameEditDraft, setPageFrameEditDraft] =
    useState<PageFrameEditDraft | null>(null);
  // Aspect is editing chrome, not authored state. It survives closing and
  // reopening the editor within this keyed Sketch session, but never enters
  // history, Presets, reproduction metadata, or the committed Page Frame.
  const [pageFrameAspectConstraint, setPageFrameAspectConstraint] =
    useState<PageFrameAspectConstraint>({ kind: "free" });
  const cropButtonRef = useRef<HTMLButtonElement>(null);
  const restoreCropFocusRef = useRef(false);
  // Page Frame percentages are relative to the Composition basis captured on
  // mode entry. Keep history fixed until Apply, Cancel, or Reset closes the mode
  // so a draft can never outlive the basis its strings describe.
  const pageFrameEditDraftRef = useRef(pageFrameEditDraft);
  pageFrameEditDraftRef.current = pageFrameEditDraft;
  // Diagnostic selection is Studio chrome, not authored state. Keeping the
  // mutually-exclusive Tone/Detail choice beside edit history excludes it from
  // Undo, Presets, locks, profiles, and every reproduction envelope.
  const [diagnosticSelection, setDiagnosticSelection] =
    useState<DiagnosticSelection>(null);
  // Event handlers also update this mirror before React renders. Same-batch
  // transitions and side effects therefore see one atomic diagnostic choice.
  const diagnosticSelectionRef = useRef(diagnosticSelection);
  diagnosticSelectionRef.current = diagnosticSelection;
  const toneReferenceActive = diagnosticSelection === "tone";
  const diagnosticReferenceActive = diagnosticSelection !== null;
  // Export-document intent is Studio-wide and deliberately independent of the
  // keyed Sketch session: remounts lazily restore the persisted preference,
  // while Plot Profile, Preset, reproduction, and composition state stay pure.
  const [includePaperMargins, setIncludePaperMargins] = useState(
    readPlotterSvgIncludePaperMargins,
  );

  const commitIncludePaperMargins = (next: boolean): void => {
    setIncludePaperMargins(next);
    writePlotterSvgIncludePaperMargins(next);
  };

  // Physical magnitude belongs to later device mapping. Before framing,
  // Composition follows the profile's drawable aspect; after framing it follows
  // the original frozen generation aspect instead. Equivalent generation bases
  // share this cache boundary and do not rebuild prepared geometry.
  const generationAspect = studioGenerationAspect(history.present);
  // Stabilize the memo key across machine-noise-only quotient differences (for
  // example a 1.2× proportional scale of non-binary A4 dimensions/insets). The
  // same core equivalence drives commit invalidation below, so frame identity and
  // the Computing affordance cannot disagree about whether geometry changed.
  const generationAspectIdentityRef = useRef(generationAspect);
  if (
    !plotDrawableAspectsEquivalent(
      generationAspectIdentityRef.current,
      generationAspect,
    )
  ) {
    generationAspectIdentityRef.current = generationAspect;
  }
  const generationAspectIdentity = generationAspectIdentityRef.current;
  const compositionFrame = useMemo(
    () => resolveStudioCompositionFrame(history.present),
    [generationAspectIdentity],
  );

  const sketchEnvironment = useSketchEnvironment({
    schema: sketch.schema,
    params,
  });
  const sketchEnvironmentRef = useRef(sketchEnvironment);
  sketchEnvironmentRef.current = sketchEnvironment;
  // Resolution state is usable only for the exact authored ID-set identity.
  // Recompute from the imperative history mirror so an authored edit and a
  // forced export in one React batch cannot reuse the prior resolved bytes.
  const environmentReadyNow = (): boolean =>
    exactEnvironmentReady(
      sketch.schema,
      historyRef.current.present.params,
      sketchEnvironmentRef.current,
    );
  // Asset-free Sketches resolve synchronously through this same gate.
  const environmentReady = environmentReadyNow();
  const unavailableEnvironmentStatus = environmentReady
    ? null
    : sketchEnvironment.status === "resolved"
      ? ("error" as const)
      : sketchEnvironment.status;

  const detailPreparation = useDetailPreparation();
  const detailImageAssetId =
    sketch.generateDetailField !== undefined &&
    sketchEnvironment.requiredIds.length === 1
      ? sketchEnvironment.requiredIds[0]!
      : null;
  const detailIdentity = useMemo(
    () => {
      if (detailImageAssetId === null) return null;
      try {
        return createDetailPreparationIdentity({
          imageAssetId: detailImageAssetId,
          analysisDefinitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
        });
      } catch {
        // Authored malformed IDs are already surfaced by environment readiness;
        // diagnostic identity construction must not become a render crash.
        return null;
      }
    },
    [detailImageAssetId],
  );

  useEffect(() => {
    if (diagnosticSelection !== "detail") return;
    if (detailIdentity === null) {
      detailPreparation.unrequest();
      return;
    }
    detailPreparation.request(detailIdentity);
  }, [
    diagnosticSelection,
    detailIdentity,
    detailPreparation.request,
    detailPreparation.unrequest,
  ]);

  const plotSequence = sketch.plotSequence;
  const hasPlotSequence = plotSequence !== undefined;
  const hasShadingCapability = sketch.generateShadingArtwork !== undefined;
  const hasLegacyShadingPreparation = !hasPlotSequence && hasShadingCapability;
  const shadingInputRevisionRef = useRef(0);
  const shadingPreparation = useShadingPreparation({
    sketch,
    enabled: hasLegacyShadingPreparation && environmentReady,
    initial: {
      params: shadingArtworkParams(sketch, history.present.params),
      seed: history.present.seed,
      compositionFrame,
      inputRevision: shadingInputRevisionRef.current,
    },
  });
  const registeredStageSketch = useMemo<RegisteredStagePreparationSketch>(
    () =>
      plotSequence === undefined
        ? {
            id: sketch.id,
            schema: {},
            plotSequence: INERT_PLOT_SEQUENCE,
          }
        : {
            ...sketch,
            plotSequence,
          },
    [plotSequence, sketch],
  );
  const registeredStagePreparation = useRegisteredStagePreparation({
    sketch: registeredStageSketch,
    enabled: hasPlotSequence && environmentReady,
    initial: {
      params: history.present.params,
      seed: history.present.seed,
      sampledT: 0,
      compositionFrame,
      inputRevision: shadingInputRevisionRef.current,
    },
  });
  const plotSequencePresentation = usePlotSequencePresentation({
    declaration: plotSequence ?? INERT_PLOT_SEQUENCE,
    records: registeredStagePreparation.records,
    demand: registeredStagePreparation.demand,
    ...(initialPlotSequencePresentation === undefined
      ? {}
      : { initialPresentation: initialPlotSequencePresentation }),
  });
  // Plot Stage selection is transient presentation state, but legacy actions
  // need an imperative authority just like authored history. A Stage-button
  // click updates this mirror before React renders so another click in the same
  // batch cannot capture, generate, launch, or download Primary Ink output.
  const plotSequencePresentationRef = useRef(
    plotSequencePresentation.presentation,
  );
  plotSequencePresentationRef.current = plotSequencePresentation.presentation;
  const primaryLegacyActionsAvailable = presentationIsIsolatedPrimary(
    plotSequence,
    plotSequencePresentation.presentation,
  );
  const primaryLegacyActionsAvailableNow = (): boolean =>
    presentationIsIsolatedPrimary(
      plotSequence,
      plotSequencePresentationRef.current,
    );
  const primaryShadingPreparation = hasPlotSequence
    ? registeredStagePreparation.primaryShadingPreparation
    : shadingPreparation;
  const currentShading = environmentReady
    ? selectCurrentShadingResult(primaryShadingPreparation.session)
    : null;
  const displayedShadingDiagnostics: DisplayedShadingDiagnostics | null =
    !environmentReady || primaryShadingPreparation.session.displayed === null
      ? null
      : {
          freshness: currentShading === null ? "stale" : "current",
          diagnostics: primaryShadingPreparation.session.displayed.diagnostics,
          computeTimeMs:
            primaryShadingPreparation.session.displayed.computeTimeMs,
        };
  const activeShadingToken = environmentReady
    ? (primaryShadingPreparation.session.active?.token ??
      primaryShadingPreparation.session.pending?.token ??
      null)
    : null;
  const shadingPreparationDiagnostics: ShadingPreparationDiagnostics =
    activeShadingToken !== null
      ? {
          kind: "preparing",
          progress:
            primaryShadingPreparation.progress?.token === activeShadingToken
              ? primaryShadingPreparation.progress.update.snapshot
              : null,
          eta:
            primaryShadingPreparation.progress?.token === activeShadingToken
              ? primaryShadingPreparation.progress.update.eta
              : { kind: "estimating", revision: 0 },
        }
      : primaryShadingPreparation.session.failure === null
        ? { kind: "idle" }
        : {
            kind: "failure",
            message: primaryShadingPreparation.session.failure,
            onRetry: primaryShadingPreparation.retry,
          };
  const [acknowledgedShading, setAcknowledgedShading] =
    useState<ShadingPaintAcknowledgement | null>(null);
  const acknowledgedShadingRef = useRef(acknowledgedShading);
  acknowledgedShadingRef.current = acknowledgedShading;
  const shadingPaintIsCurrent =
    environmentReady &&
    currentShading !== null &&
    acknowledgedShading?.sourceInputRevision ===
      currentShading.sourceInputRevision &&
    acknowledgedShading.contentRevision === currentShading.contentRevision;
  const emptyShadingScene = useMemo<Scene>(
    () => ({ space: compositionFrame, primitives: [] }),
    [compositionFrame],
  );

  const authoredShadingState = (
    edit: StudioEditState = historyRef.current.present,
  ): ShadingAuthoredState => ({
    params: shadingArtworkParams(sketch, edit.params),
    seed: edit.seed,
    compositionFrame: resolveStudioCompositionFrame(edit),
    inputRevision: shadingInputRevisionRef.current,
  });
  const authoredRegisteredStageState = (
    edit: StudioEditState = historyRef.current.present,
  ): RegisteredStageAuthoredState => ({
    params: edit.params,
    seed: edit.seed,
    sampledT: 0,
    compositionFrame: resolveStudioCompositionFrame(edit),
    inputRevision: shadingInputRevisionRef.current,
  });

  // Sample-source derivation intentionally reads the live transaction preview
  // params and Composition Frame directly. Seed, timeline, profile magnitude,
  // and the Outline session are absent from this capability seam.
  const toneSource = useMemo(
    () =>
      toneReferenceActive && primaryLegacyActionsAvailable
        ? environmentReady
          ? sketch.generateToneSource?.(
              params,
              compositionFrame,
              sketchEnvironment.environment,
            )
          : undefined
        : undefined,
    [
      toneReferenceActive,
      primaryLegacyActionsAvailable,
      sketch,
      params,
      compositionFrame,
      environmentReady,
      sketchEnvironment.environment,
    ],
  );

  // Bind only the exact prepared record requested for the current asset and
  // analyzer definition. The Sketch capability remains synchronous and pure;
  // a malformed prepared record or binding assertion becomes an honest Detail
  // failure instead of escaping through React or silently substituting zero.
  const detailReferenceDerivation: DetailReferenceDerivation | null = (() => {
    if (
      diagnosticSelection !== "detail" ||
      !primaryLegacyActionsAvailable
    ) {
      return null;
    }
    if (!environmentReady || detailIdentity === null) {
      return { kind: "loading" };
    }

    const failure = detailPreparation.session.failure;
    if (
      failure !== null &&
      detailPreparationIdentitiesEqual(failure.identity, detailIdentity)
    ) {
      return { kind: "failure" };
    }

    const prepared = detailPreparation.session.prepared;
    if (
      prepared === null ||
      !detailPreparationIdentitiesEqual(prepared.identity, detailIdentity)
    ) {
      return { kind: "loading" };
    }

    try {
      const baseEnvironment = sketchEnvironment.environment;
      const generateDetailField = sketch.generateDetailField;
      if (baseEnvironment === undefined || generateDetailField === undefined) {
        throw new TypeError("Detail binding environment is unavailable");
      }
      const detailEnvironment: SketchEnvironment = {
        imageAssets: baseEnvironment.imageAssets,
        getPreparedImageDetailAnalysis(
          imageAssetId,
          analysisDefinitionId,
        ) {
          if (
            imageAssetId !== detailIdentity.imageAssetId ||
            analysisDefinitionId !== detailIdentity.analysisDefinitionId
          ) {
            throw new TypeError("Detail binding identity does not match");
          }
          return prepared.prepared;
        },
      };
      return {
        kind: "ready",
        field: generateDetailField(
          params,
          compositionFrame,
          detailEnvironment,
        ),
      };
    } catch (error) {
      return {
        kind: "failure",
        rejection: {
          token: prepared.token,
          identity: prepared.identity,
          error,
        },
      };
    }
  })();
  const detailBindingRejection =
    detailReferenceDerivation?.kind === "failure"
      ? detailReferenceDerivation.rejection
      : undefined;
  useEffect(() => {
    if (detailBindingRejection === undefined) return;
    detailPreparation.rejectPrepared(
      detailBindingRejection.token,
      detailBindingRejection.identity,
      detailBindingRejection.error,
    );
  }, [detailBindingRejection, detailPreparation.rejectPrepared]);

  const [outlineSession, setOutlineSession] = useState(
    createOutlineSessionState,
  );
  const outlineSessionRef = useRef(outlineSession);
  outlineSessionRef.current = outlineSession;
  const coordinatorRef = useRef<HiddenLineCoordinator | null>(null);
  const dispatchOutline = (action: OutlineSessionAction) => {
    const next = outlineSessionReducer(outlineSessionRef.current, action);
    outlineSessionRef.current = next;
    setOutlineSession(next);
    return next;
  };
  const outlineBusy =
    outlineSession.capture !== null || outlineSession.active !== null;
  const exportBusy = outlineSession.exportActive !== null;
  const hiddenLineBusy = outlineBusy || exportBusy;
  // Capture and worker execution are one logical interval and share a token.
  // A replacement gets a fresh token so its quiet-period clock starts over.
  const outlineWorkToken =
    outlineSession.capture?.token ?? outlineSession.active?.token ?? null;
  const onHiddenLineBusyChangeRef = useRef(onHiddenLineBusyChange);
  onHiddenLineBusyChangeRef.current = onHiddenLineBusyChange;
  const [revealedOutlineToken, setRevealedOutlineToken] = useState<number | null>(
    null,
  );
  const [outlineProgress, setOutlineProgress] = useState<{
    readonly token: number;
    readonly update: HiddenLineProgressUpdate;
  } | null>(null);
  const exportWorkToken = outlineSession.exportActive?.token ?? null;
  const [revealedExportToken, setRevealedExportToken] = useState<number | null>(
    null,
  );
  const [exportProgress, setExportProgress] = useState<{
    readonly token: number;
    readonly update: HiddenLineProgressUpdate;
  } | null>(null);

  useEffect(() => {
    onHiddenLineBusyChangeRef.current?.(hiddenLineBusy);
  }, [hiddenLineBusy]);

  useEffect(() => {
    setRevealedOutlineToken(null);
    setOutlineProgress(null);
    if (outlineWorkToken === null) return;
    const timer = window.setTimeout(
      () => setRevealedOutlineToken(outlineWorkToken),
      750,
    );
    return () => window.clearTimeout(timer);
  }, [outlineWorkToken]);

  useEffect(() => {
    setRevealedExportToken(null);
    setExportProgress(null);
    if (exportWorkToken === null) return;
    const timer = window.setTimeout(
      () => setRevealedExportToken(exportWorkToken),
      750,
    );
    return () => window.clearTimeout(timer);
  }, [exportWorkToken]);

  useEffect(() => {
    // The coordinator's lifetime matches this effect, not the render-retained
    // ref: StrictMode rehearses setup → cleanup → setup without another render.
    const coordinator = new HiddenLineCoordinator();
    coordinatorRef.current = coordinator;
    return () => {
      coordinator.dispose();
      if (coordinatorRef.current === coordinator) {
        coordinatorRef.current = null;
      }
      onHiddenLineBusyChangeRef.current?.(false);
    };
  }, []);

  const cancelCoordinator = (): void => {
    coordinatorRef.current?.cancel();
  };

  const cancelOutlineCoordinator = (): void => {
    if (outlineSessionRef.current.slot?.owner === "outline-preview") {
      cancelCoordinator();
    }
  };

  const cancelUnavailableEnvironmentWork = (): void => {
    if (environmentReadyNow()) return;
    const current = outlineSessionRef.current;
    if (current.slot !== null) cancelCoordinator();
    if (current.exportActive !== null) {
      dispatchOutline({
        type: "export-cancelled",
        token: current.exportActive.token,
      });
    }
    if (current.capture !== null || current.active !== null) {
      dispatchOutline({ type: "cancelled" });
    }
  };

  useEffect(() => {
    cancelUnavailableEnvironmentWork();
  }, [environmentReady]);

  const requestOutlineForCurrentInputs = (): void => {
    if (!primaryLegacyActionsAvailableNow() || !environmentReadyNow()) return;
    dispatchOutline({
      type: "request-outline",
      launch: !hasShadingCapability || shadingPaintIsCurrent,
      ...(shadingPaintIsCurrent && currentShading !== null
        ? {
            provenance: {
              sourceInputRevision: currentShading.sourceInputRevision,
              contentRevision: currentShading.contentRevision,
            },
          }
        : {}),
    });
  };

  const updateHistory = (
    transition: (current: EditHistory) => EditHistory,
    launchOutline = true,
    shadingAction: "preview" | "atomic" | null = null,
  ): void => {
    const current = historyRef.current;
    const next = transition(current);
    if (next === current) return;
    historyRef.current = next;
    cancelUnavailableEnvironmentWork();
    const shadingChanged = shadingInputsChanged(
      sketch,
      current.present,
      next.present,
    );
    if (hasLegacyShadingPreparation && shadingChanged) {
      shadingInputRevisionRef.current += 1;
    }
    const changedRegisteredStageIds = hasPlotSequence
      ? registeredStagePreparation.changedStageIds(
          authoredRegisteredStageState(next.present),
        )
      : [];
    if (
      hasPlotSequence &&
      changedRegisteredStageIds.some(
        (stageId) =>
          plotSequence?.stages.find((stage) => stage.id === stageId)?.source
            .kind === "primary",
      )
    ) {
      shadingInputRevisionRef.current += 1;
    }
    if (
      hasLegacyShadingPreparation &&
      shadingAction === "preview" &&
      shadingChanged
    ) {
      if (!shadingPreparation.getSessionSnapshot().transactionOpen) {
        shadingPreparation.beginTransaction();
      }
      shadingPreparation.previewAuthoredState(
        authoredShadingState(next.present),
      );
    } else if (
      hasLegacyShadingPreparation &&
      shadingAction === "atomic" &&
      shadingChanged
    ) {
      shadingPreparation.requestAtomic(authoredShadingState(next.present));
    }
    if (
      hasPlotSequence &&
      shadingAction === "preview" &&
      changedRegisteredStageIds.length > 0
    ) {
      registeredStagePreparation.previewAuthoredState(
        authoredRegisteredStageState(next.present),
      );
    } else if (
      hasPlotSequence &&
      shadingAction === "atomic" &&
      changedRegisteredStageIds.length > 0
    ) {
      registeredStagePreparation.requestAtomic(
        authoredRegisteredStageState(next.present),
      );
    }
    const outlineChange = classifyOutlineEdit(
      sketch,
      current.present,
      next.present,
    );
    if (outlineChange === "geometry") {
      cancelOutlineCoordinator();
      // Paper transactions defer this boundary until their first geometry edit.
      // Target/style-only previews can therefore keep painting retained Outline.
      if (
        hasActiveTransaction(next) &&
        !outlineSessionRef.current.transactionOpen
      ) {
        dispatchOutline({ type: "transaction-began" });
      }
      const retainsPaintedShading =
        hasShadingCapability && !shadingChanged && shadingPaintIsCurrent;
      dispatchOutline({
        type: "inputs-changed",
        launch: environmentReadyNow() && launchOutline && !hasShadingCapability,
        ...(retainsPaintedShading && currentShading !== null
          ? {
              provenance: {
                sourceInputRevision: currentShading.sourceInputRevision,
                contentRevision: currentShading.contentRevision,
              },
            }
          : {}),
        waitForSource: hasShadingCapability && !retainsPaintedShading,
      });
    }
    setHistory(next);
  };

  const currentImageAssetRecord = (
    request: ImageAssetControlRecomposeRequest,
  ) => {
    const spec = sketch.schema[request.paramKey];
    if (spec?.kind !== "image-asset") return undefined;

    const currentParams = historyRef.current.present.params;
    const currentImageAssetId =
      typeof currentParams[request.paramKey] === "string"
        ? currentParams[request.paramKey]
        : spec.default;
    if (
      currentImageAssetId !== request.imageAssetId ||
      !environmentReadyNow()
    ) {
      return undefined;
    }
    return sketchEnvironmentRef.current.environment?.imageAssets(
      currentImageAssetId,
    );
  };

  const recomposeToImageAspect = (
    request: ImageAssetControlRecomposeRequest,
  ): void => {
    // The row's dimensions are presentation only. Re-prove its schema, authored
    // ID, exact resolution, and decoded record at both sides of the warning so
    // stale callbacks and synchronous state changes fail closed.
    if (currentImageAssetRecord(request) === undefined) return;
    if (
      !window.confirm(
        "Recomposing to this image’s aspect will recompose the Scene and reset the Page Frame. Continue?",
      )
    ) {
      return;
    }

    const currentRecord = currentImageAssetRecord(request);
    if (currentRecord === undefined) return;
    const fitted = fitPageFramePlotProfileToAspect(
      historyRef.current.present.profile,
      currentRecord.width / currentRecord.height,
    );
    updateHistory(
      (historyState) => recomposePageToProfile(historyState, fitted),
      true,
      "atomic",
    );
  };

  // History belongs to this keyed Sketch session, so its keyboard listener does
  // too. Text/numeric editors keep native Undo while a preview transaction is
  // active; once Enter/blur settles it, the same focused authored field may
  // traverse Studio history. Explicitly excluded text remains native always.
  useEffect(() => {
    const shortcutPlatform = detectHistoryShortcutPlatform();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const command = historyShortcutFor(event, shortcutPlatform);
      if (command === null) return;

      // Page Frame edit mode owns a transient draft outside Studio history.
      // Ignoring the shortcut (without preventing it) keeps global history and
      // the Composition basis stable while preserving native input Undo/Redo.
      if (pageFrameEditDraftRef.current !== null) return;

      const current = historyRef.current;
      if (
        fieldOwnsHistoryShortcut(
          event.target,
          hasActiveTransaction(current),
        )
      ) {
        return;
      }
      if (command === "undo" ? !canUndo(current) : !canRedo(current)) return;

      event.preventDefault();
      updateHistory(
        command === "undo" ? undoEdit : redoEdit,
        true,
        "atomic",
      );
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const previewLeaf = <Key extends keyof StudioEditState>(
    key: Key,
    value: StudioEditState[Key],
  ): void => {
    updateHistory(
      (current) =>
        previewEditState(current, { ...current.present, [key]: value }),
      false,
      "preview",
    );
  };

  const commitLeaf = <Key extends keyof StudioEditState>(
    key: Key,
    value: StudioEditState[Key],
  ): void => {
    updateHistory(
      (current) =>
        commitEditState(current, { ...current.present, [key]: value }),
      true,
      "atomic",
    );
  };

  const routePaperProfileCandidate = (
    candidate: PlotProfile,
    source: PaperProfileCandidateSource,
  ): PaperProfileCandidateDecision => {
    const current = historyRef.current.present;
    if (current.framing.kind === "unframed") {
      return { kind: "accept", profile: candidate };
    }

    const currentDrawable = plotDrawableRectangle(current.profile);
    const candidateDrawable = plotDrawableRectangle(candidate);
    const sameAspect = plotDrawableAspectsEquivalent(
      currentDrawable.width / currentDrawable.height,
      candidateDrawable.width / candidateDrawable.height,
    );

    if (current.framing.aspectLocked) {
      if (source === "width" || source === "height") {
        return {
          kind: "accept",
          profile: resizePageFramePlotProfileProportionally(
            current.profile,
            current.framing.pageFrame,
            source,
            candidate[source],
          ),
        };
      }
      return sameAspect
        ? { kind: "accept", profile: candidate }
        : {
            kind: "reject",
            message:
              "Unlock Page aspect before changing the Page proportions.",
          };
    }

    if (sameAspect) return { kind: "accept", profile: candidate };
    if (
      !window.confirm(
        "Changing the Page aspect will recompose the Scene and reset the Page Frame. Continue?",
      )
    ) {
      return { kind: "reject", message: "Page aspect change canceled." };
    }

    updateHistory(
      (historyState) => recomposePageToProfile(historyState, candidate),
      true,
      "atomic",
    );
    return { kind: "handled", profile: candidate };
  };

  const commitPageAspectLocked = (locked: boolean): void => {
    updateHistory(
      (current) => setPageAspectLocked(current, locked),
      true,
      "atomic",
    );
  };

  const beginTransaction = (): void => {
    // Every authored transaction is a preview boundary even before its first
    // valid value: cancel stale work and paint live Fill while retaining intent
    // and the one exact-result cache for settlement.
    cancelOutlineCoordinator();
    dispatchOutline({ type: "transaction-began" });
    updateHistory(beginEditTransaction, false);
    if (hasLegacyShadingPreparation) shadingPreparation.beginTransaction();
  };
  const beginParamTransaction = (key: string): void => {
    if (hasPlotSequence) {
      beginTransaction();
      registeredStagePreparation.beginParamTransaction(key);
      return;
    }
    if (!isDetailReferenceOnlyParam(sketch, key)) {
      beginTransaction();
      return;
    }
    // Sensitivity is a live Detail remap in #367, so merely focusing it must
    // not relinquish retained Fill/Outline ownership or suspend artwork work.
    updateHistory(beginEditTransaction, false);
  };
  const beginSeedTransaction = (): void => {
    beginTransaction();
    if (hasPlotSequence) registeredStagePreparation.beginSeedTransaction();
  };
  const beginProfileTransaction = (): void => {
    // A profile gesture may prove to be physical style or Page placement only.
    // Keep the current Outline until a preview actually crosses a geometry
    // boundary; classification in updateHistory opens the session lazily then.
    updateHistory(beginEditTransaction, false);
  };
  const settleTransaction = (
    transition: (current: EditHistory) => EditHistory,
  ): void => {
    const outlineTransactionOpen = outlineSessionRef.current.transactionOpen;
    const shadingTransactionOpen =
      hasLegacyShadingPreparation &&
      shadingPreparation.getSessionSnapshot().transactionOpen;
    updateHistory(transition, false);
    if (shadingTransactionOpen) {
      shadingPreparation.settleTransaction(authoredShadingState());
    }
    if (hasPlotSequence) {
      registeredStagePreparation.settleTransaction(
        authoredRegisteredStageState(),
      );
    }
    // Settlement belongs to the session reducer: outside export it resamples the
    // final Fill exactly once; during export it retains only a deferred request,
    // which the export terminal action releases after relinquishing the slot.
    if (outlineTransactionOpen) {
      dispatchOutline({
        type: "transaction-settled",
        launch: environmentReadyNow() && !hasShadingCapability,
      });
    }
  };
  const commitTransaction = (): void => settleTransaction(commitEditTransaction);
  const cancelTransaction = (): void => settleTransaction(cancelEditTransaction);

  const openPageFrameEditor = (): void => {
    const current = historyRef.current.present;
    const draft = openPageFrameEditDraft({
      profile: current.profile,
      representedFrame: initialPageFrameForEdit(current),
      compositionFrame: resolveStudioCompositionFrame(current),
      generationAspect: studioGenerationAspect(current),
    });
    pageFrameEditDraftRef.current = draft;
    setPageFrameEditDraft(draft);
  };

  const closePageFrameEditor = (): void => {
    restoreCropFocusRef.current = true;
    pageFrameEditDraftRef.current = null;
    setPageFrameEditDraft(null);
  };

  useLayoutEffect(() => {
    if (pageFrameEditDraft !== null || !restoreCropFocusRef.current) return;
    restoreCropFocusRef.current = false;
    cropButtonRef.current?.focus();
  }, [pageFrameEditDraft]);

  const updatePageFrameEditDraft = (next: PageFrameEditDraft): void => {
    const previous = pageFrameEditDraftRef.current;
    if (previous?.mode === "scale-preserving" && next.mode === "fixed-page") {
      setPageFrameAspectConstraint({ kind: "free" });
    }
    pageFrameEditDraftRef.current = next;
    setPageFrameEditDraft(next);
  };

  const updatePageFrameFromCanvas = (
    frame: PageFrameEditDraft["frame"],
  ): void => {
    const current = pageFrameEditDraftRef.current;
    if (current === null) return;
    updatePageFrameEditDraft(
      current.mode === "fixed-page"
        ? panFixedPageFrame(current, frame)
        : setScalePreservingPageFrame(current, frame),
    );
  };

  const applyPageFrame = (draft: PageFrameEditDraft): void => {
    updateHistory(
      (current) => applyPageFrameEditDraft(current, draft),
      true,
      "atomic",
    );
    closePageFrameEditor();
  };

  const resetFrame = (): void => {
    const draft = pageFrameEditDraftRef.current;
    if (draft === null) return;
    updateHistory(
      (current) => resetPageFrameEditDraft(current, draft),
      true,
      "atomic",
    );
    closePageFrameEditor();
  };

  // The read-only window into LiveCanvas (the live <canvas> + current t) the PNG
  // export snapshots. It is a ref, not state — export reads it imperatively on a
  // button click, never during render.
  const canvasHandle = useRef<LiveCanvasHandle>(null);

  // Value type mirrors ControlPanel's onChange seam: `number` from a
  // NumberControl, a hex color `string` from a ColorControl, or an Image Asset
  // ID from ImageAssetControl. The params state itself is
  // `Record<string, unknown>`, so only this handler widens.
  const setParam = (key: string, value: number | string) => {
    commitLeaf("params", { ...historyRef.current.present.params, [key]: value });
  };

  // Toggle a numeric param's lock membership. Only NumberControl routes here;
  // locks are read ONLY by randomize, never by a control's editability.
  const toggleLock = (key: string) => {
    const next = new Set(historyRef.current.present.locks);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    commitLeaf("locks", next);
  };

  // Flip desired preview intent. Entering Outline first asks LiveCanvas for its
  // exact displayed Fill, then the session's worker coordinator derives geometry;
  // LiveCanvas only paints the held Fill or atomically completed Outline.
  const toggleRenderMode = () => {
    if (!primaryLegacyActionsAvailableNow()) return;
    if (outlineSessionRef.current.desired === "outline") {
      cancelOutlineCoordinator();
      dispatchOutline({ type: "request-fill" });
    } else {
      if (!environmentReadyNow()) return;
      requestOutlineForCurrentInputs();
    }
  };

  const leaveDetailFor = (next: Exclude<DiagnosticSelection, "detail">) => {
    const previous = diagnosticSelectionRef.current;
    if (previous === "detail") {
      detailPreparation.unrequest();
    }
    diagnosticSelectionRef.current = next;
    setDiagnosticSelection(next);
    if (previous === "detail" && hasShadingCapability) {
      primaryShadingPreparation.resumeLatest();
    }
  };

  const selectFill = (): void => {
    if (!primaryLegacyActionsAvailableNow()) return;
    leaveDetailFor(null);
    if (outlineSessionRef.current.desired === "outline") {
      cancelOutlineCoordinator();
      dispatchOutline({ type: "request-fill" });
    }
  };

  const selectOutline = (): void => {
    if (!primaryLegacyActionsAvailableNow()) return;
    leaveDetailFor(null);
    if (!environmentReadyNow()) return;
    if (outlineSessionRef.current.desired !== "outline") {
      requestOutlineForCurrentInputs();
    }
  };

  const selectToneReference = (): void => {
    if (
      !primaryLegacyActionsAvailableNow() ||
      sketch.generateToneSource === undefined
    ) {
      return;
    }
    // Tone has no Outline phase of its own. Relinquish preview ownership and
    // reset intent to Fill before switching LiveCanvas to the pixel source.
    cancelOutlineCoordinator();
    dispatchOutline({ type: "request-fill" });
    leaveDetailFor("tone");
  };

  const selectDetailReference = (): void => {
    if (
      !primaryLegacyActionsAvailableNow() ||
      sketch.generateDetailField === undefined ||
      !environmentReadyNow() ||
      detailIdentity === null ||
      diagnosticSelectionRef.current === "detail"
    ) {
      return;
    }

    // Detail owns no Shading geometry. Retire active ownership synchronously
    // before the diagnostic becomes observable or analysis can be requested.
    if (hasShadingCapability) primaryShadingPreparation.suspend();
    cancelOutlineCoordinator();
    dispatchOutline({ type: "request-fill" });
    diagnosticSelectionRef.current = "detail";
    setDiagnosticSelection("detail");
    detailPreparation.request(detailIdentity);
  };

  const retirePrimaryLegacyActions = (): void => {
    const current = outlineSessionRef.current;
    if (current.slot !== null) cancelCoordinator();
    if (current.exportActive !== null) {
      dispatchOutline({
        type: "export-cancelled",
        token: current.exportActive.token,
      });
    }
    // Resetting to Fill clears capture, active work, deferred intent, and any
    // retained Outline phase before the supporting/Combined Scene can paint.
    dispatchOutline({ type: "request-fill" });

    const previousDiagnostic = diagnosticSelectionRef.current;
    if (previousDiagnostic === "detail") detailPreparation.unrequest();
    diagnosticSelectionRef.current = null;
    setDiagnosticSelection(null);
    if (previousDiagnostic === "detail" && hasShadingCapability) {
      primaryShadingPreparation.resumeLatest();
    }
  };

  const setPlotSequencePresentation = (
    next: PlotSequencePresentation,
  ): void => {
    const leavingPrimary =
      primaryLegacyActionsAvailableNow() &&
      !presentationIsIsolatedPrimary(plotSequence, next);
    // Establish the transient authority before teardown or React state. Any
    // already-queued worker/export callback therefore observes non-Primary and
    // fails closed even if it runs in this event batch.
    plotSequencePresentationRef.current = next;
    if (leavingPrimary) retirePrimaryLegacyActions();
    plotSequencePresentation.setPresentation(next);
  };

  const onFillCaptured = (capture: FillCapture): void => {
    if (!primaryLegacyActionsAvailableNow()) return;
    if (!environmentReadyNow()) {
      cancelUnavailableEnvironmentWork();
      return;
    }
    const current = outlineSessionRef.current;
    if (
      current.capture?.token !== capture.token ||
      current.inputRevision !== capture.inputRevision
    ) {
      return;
    }
    const edit = historyRef.current.present;
    const identity = createOutlineComputeIdentity({
      sketchId: sketch.id,
      schema: sketch.schema,
      params: artworkGenerationParams(sketch, edit.params),
      seed: edit.seed,
      sampledT: capture.t,
      compositionFrame,
      tolerance: edit.tolerance,
      ...outlineIdentitySourceFor(
        sketch,
        edit,
        capture.sourceScene,
      ),
    });
    const next = dispatchOutline({
      type: "fill-captured",
      token: capture.token,
      inputRevision: capture.inputRevision,
      identity,
      scene: capture.sourceScene,
      t: capture.t,
      sourceInputRevision: capture.sourceInputRevision,
      ...(capture.contentRevision === undefined
        ? {}
        : { contentRevision: capture.contentRevision }),
    });
    if (next.active?.token !== capture.token) return;
    const reportFailure = (detail: string): void => {
      console.error("Outline worker failed", detail);
      dispatchOutline({
        type: "failed",
        token: capture.token,
        error: detail.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160),
      });
    };
    const coordinator = coordinatorRef.current;
    if (
      coordinator === null ||
      !primaryLegacyActionsAvailableNow()
    ) {
      return;
    }
    void coordinator
      .start(identity, (update) => {
        // Worker callbacks can already be queued when a job is replaced. The
        // session token, rather than coordinator/job identity alone, owns UI
        // progress so an old worker can never repaint a newer request.
        if (
          !primaryLegacyActionsAvailableNow() ||
          outlineSessionRef.current.active?.token !== capture.token
        ) {
          return;
        }
        if (!environmentReadyNow()) {
          cancelUnavailableEnvironmentWork();
          return;
        }
        setOutlineProgress({ token: capture.token, update });
      })
      .then((result) => {
        if (
          coordinatorRef.current !== coordinator ||
          !primaryLegacyActionsAvailableNow()
        ) {
          return;
        }
        if (!environmentReadyNow()) {
          cancelUnavailableEnvironmentWork();
          return;
        }
        if (result.status === "success") {
          dispatchOutline({
            type: "succeeded",
            token: capture.token,
            identity: result.identity,
            scene: result.scene,
          });
        } else if (result.status === "failure") {
          reportFailure(result.error);
        }
      })
      .catch((error: unknown) => {
        if (
          coordinatorRef.current !== coordinator ||
          !primaryLegacyActionsAvailableNow()
        ) {
          return;
        }
        if (!environmentReadyNow()) {
          cancelUnavailableEnvironmentWork();
          return;
        }
        reportFailure(error instanceof Error ? error.message : "Outline worker failed");
      });
  };

  const onDisplayedSceneCommitted = (
    snapshot: DisplayedSceneSnapshot,
  ): void => {
    if (
      !primaryLegacyActionsAvailableNow() ||
      !environmentReadyNow()
    ) {
      return;
    }
    const latestShading = selectCurrentShadingResult(
      primaryShadingPreparation.getSessionSnapshot(),
    );
    if (
      latestShading === null ||
      snapshot.renderMode !== "fill" ||
      snapshot.sourceInputRevision !== latestShading.sourceInputRevision ||
      snapshot.contentRevision !== latestShading.contentRevision
    ) {
      return;
    }
    const provenance = {
      sourceInputRevision: latestShading.sourceInputRevision,
      contentRevision: latestShading.contentRevision,
    };
    acknowledgedShadingRef.current = provenance;
    setAcknowledgedShading((current) =>
      current?.sourceInputRevision === provenance.sourceInputRevision &&
      current.contentRevision === provenance.contentRevision
        ? current
        : provenance,
    );
    dispatchOutline({ type: "source-ready", provenance });
  };

  const outlineDisplayTarget = outlineTargetFor(
    outlineEditForPageDraft(history.present, pageFrameEditDraft),
  );
  const outlineFinalizationStrokePolicy =
    useMemo<OutlineFinalizationStrokePolicy>(
      () => ({
        kind:
          sketch.generateOutlineSource === undefined &&
          sketch.deriveOutlineSource === undefined
            ? "legacy-scene"
            : "physical-tool",
        target: outlineDisplayTarget,
      }),
      [
        sketch.generateOutlineSource,
        sketch.deriveOutlineSource,
        outlineDisplayTarget.toolWidthMillimeters,
        outlineDisplayTarget.millimetersPerSceneUnit,
      ],
    );

  const renderState: LiveCanvasRenderState = (() => {
    if (unavailableEnvironmentStatus !== null) {
      return {
        kind: "unavailable",
        status: unavailableEnvironmentStatus,
        unresolvedAssetIds: sketchEnvironment.requiredIds,
      };
    }
    if (detailReferenceDerivation?.kind === "ready") {
      return {
        kind: "detail-reference",
        field: detailReferenceDerivation.field,
      };
    }
    if (detailReferenceDerivation?.kind === "loading") {
      return { kind: "detail-reference-loading" };
    }
    if (detailReferenceDerivation?.kind === "failure") {
      return {
        kind: "detail-reference-failure",
        onRetry: detailPreparation.retry,
      };
    }
    if (toneSource !== undefined) {
      return { kind: "tone-reference", source: toneSource };
    }
    if (hasPlotSequence && outlineSession.phase.kind === "fill-live") {
      const isolatedStage =
        plotSequencePresentation.presentation.kind === "isolated"
          ? registeredStagePreparation.records[
              plotSequencePresentation.presentation.stageId
            ]
          : undefined;
      const primaryDisplayed = primaryShadingPreparation.session.displayed;
      const presentedScene = plotSequencePresentation.snapshot.scene;
      return {
        kind: "fill-held",
        scene: presentedScene ?? emptyShadingScene,
        t: 0,
        ...(isolatedStage?.sourceKind === "primary" &&
        primaryDisplayed !== null &&
        presentedScene === primaryDisplayed.scene
          ? {
              sourceInputRevision: primaryDisplayed.sourceInputRevision,
              contentRevision: primaryDisplayed.contentRevision,
            }
          : {}),
      };
    }
    if (
      hasLegacyShadingPreparation &&
      outlineSession.phase.kind === "fill-live"
    ) {
      return shadingPreparation.session.displayed === null
        ? { kind: "fill-held", scene: emptyShadingScene, t: 0 }
        : {
            kind: "fill-held",
            scene: shadingPreparation.session.displayed.scene,
            t: 0,
            sourceInputRevision:
              shadingPreparation.session.displayed.sourceInputRevision,
            contentRevision:
              shadingPreparation.session.displayed.contentRevision,
          };
    }
    if (outlineSession.phase.kind === "fill-live") {
      return { kind: "fill-live" };
    }
    if (outlineSession.phase.kind === "fill-held-pending") {
      return {
        kind: "fill-held",
        scene: outlineSession.phase.scene,
        t: outlineSession.phase.t,
        ...(outlineSession.phase.sourceInputRevision === undefined
          ? {}
          : {
              sourceInputRevision: outlineSession.phase.sourceInputRevision,
            }),
        ...(outlineSession.phase.contentRevision === undefined
          ? {}
          : { contentRevision: outlineSession.phase.contentRevision }),
      };
    }
    return outlineSession.phase;
  })();

  // New seed: roll a fresh arrangement, leaving every param value untouched —
  // the seed axis is independent of the param (Randomize) axis.
  const rollSeed = () => {
    commitLeaf("seed", newSeed(Math.random));
  };

  // Randomize: re-roll the unlocked numeric params. The engine reads the current
  // `locks` set (locked keys pass through unchanged) and a `Math.random`-backed
  // source — no roll logic lives here.
  const rollParams = () => {
    const current = historyRef.current.present;
    commitLeaf(
      "params",
      randomize(sketch.schema, current.params, current.locks, Math.random),
    );
  };

  // Reload a saved Preset: reconcile it against the CURRENT schema via core's
  // `applyPreset` (the authority on which keys exist), then hydrate every
  // authored axis TOGETHER. The array→Set conversion on `locks` is this owner's
  // job — including preserved color keys, which remain inert rather than being
  // filtered or migrated just because ColorControl has no Lock affordance.
  const reloadPreset = (preset: Preset) => {
    const current = historyRef.current.present;
    const state = applyPreset(sketch.schema, preset);
    const resolvedProfile = resolveOutputProfile(
      state.profile,
      sketch.defaultOutputProfile,
    );
    const framing =
      state.framing === undefined
        ? ({ kind: "unframed" } as const)
        : ({
            kind: "framed",
            pageFrame: { ...state.framing.pageFrame },
            generationAspect: state.framing.generationAspect,
            aspectLocked: state.framing.aspectLocked,
          } as const);
    // Resolve the active profile through #265's precedence: a v2/v3 Preset's
    // stored profile wins; a v1 Preset falls back to this Sketch's default / the
    // Harness fallback. Framing absence on v1/v2 explicitly clears any prior
    // framed state. `applyPreset` validates and copies the stored payloads but
    // leaves Studio precedence and framing-state construction to this boundary.
    updateHistory(
      (historyState) =>
        commitEditState(historyState, {
          ...current,
          params: sameParams(current.params, state.params)
            ? current.params
            : state.params,
          seed: state.seed,
          locks: new Set(state.locks),
          profile: resolvedProfile,
          framing,
        }),
      true,
      "atomic",
    );
  };

  /** Re-prove Shading session and canvas provenance at an export side effect. */
  const captureCurrentShadingExport = () => {
    if (!primaryLegacyActionsAvailableNow() || !hasShadingCapability) {
      return null;
    }
    const displayed = canvasHandle.current?.captureDisplayedFrame() ?? null;
    const result = acknowledgedCurrentShading(
      primaryShadingPreparation.getSessionSnapshot(),
      acknowledgedShadingRef.current,
      displayed,
    );
    return result === null || displayed === null ? null : { result, displayed };
  };

  const sameShadingExportRevision = (
    expected: ReturnType<typeof captureCurrentShadingExport>,
  ): boolean => {
    if (
      !primaryLegacyActionsAvailableNow() ||
      !environmentReadyNow()
    ) {
      return false;
    }
    if (!hasShadingCapability) return true;
    if (expected === null) return false;
    const current = captureCurrentShadingExport();
    return (
      current !== null &&
      current.result.sourceInputRevision ===
        expected.result.sourceInputRevision &&
      current.result.contentRevision === expected.result.contentRevision
    );
  };

  // Export the CURRENTLY DISPLAYED frame as a PNG — a one-shot user action that
  // lives OUTSIDE the per-frame generate→bake→draw loop (it never re-renders or
  // re-generates). "Option A": snapshot the live canvas's backing-store pixels
  // (already DPR-sized by sizeToBox), so a retina user gets the crisp image they
  // see, not a downscaled one. `toBlob('image/png')` reads those pixels as-is.
  //
  // The filename's `-t{t}` segment is TIME-GATED on `sketch.time`: a time-driven
  // Sketch passes the captured `t` (the last-drawn moment from the handle), a
  // static Sketch omits `t` entirely so the name carries no segment.
  const exportPng = () => {
    if (
      // LiveCanvas stays mounted in Detail mode, so this handler gate is the
      // final authority preventing its diagnostic backing pixels from escaping.
      diagnosticSelectionRef.current !== null ||
      !primaryLegacyActionsAvailableNow() ||
      !environmentReadyNow()
    ) return;
    const handle = canvasHandle.current;
    const canvas = handle?.getCanvas();
    if (handle == null || canvas == null) return;
    const shadingExport = captureCurrentShadingExport();
    if (hasShadingCapability && shadingExport === null) return;
    const edit = historyRef.current.present;
    // Time-gate the `-t{t}` filename segment on `sketch.time`: a time-driven
    // Sketch carries its captured moment, a static one omits `t` entirely.
    const t = sketch.time === undefined ? undefined : handle.getCurrentT();
    // Build from one whole authored-state snapshot. The active Plot Profile
    // yields v2 metadata while committed framing promotes the same envelope to
    // v3; an unframed session still omits framing exactly.
    const metadata = buildReproMetadata({
      sketchId: sketch.id,
      seed: edit.seed,
      params: edit.params,
      locks: edit.locks,
      t,
      profile: edit.profile,
      framing: persistedFramingFor(edit),
    });
    // Re-read the synchronous session and the canvas at the pixel side effect.
    if (!sameShadingExportRevision(shadingExport)) return;
    canvas.toBlob((blob) => {
      if (blob === null) return;
      if (!sameShadingExportRevision(shadingExport)) return;
      const filename = exportFilename(
        { sketchId: sketch.id, seed: edit.seed, t },
        "png",
      );
      // Splice the iTXt reproduction chunk into the PNG bytes before saving, so
      // the downloaded file traces back to this exact frame. Byte work is core's
      // (`insertPngMetadata`); the Studio only does the Blob ⇄ ArrayBuffer dance.
      void blob.arrayBuffer().then((buffer) => {
        if (!sameShadingExportRevision(shadingExport)) return;
        const withMeta = insertPngMetadata(new Uint8Array(buffer), metadata);
        // `withMeta` spans its whole backing buffer (core's `concat` allocates a
        // fresh, offset-0 array), so `.buffer` is exactly these bytes.
        if (!primaryLegacyActionsAvailableNow()) return;
        downloadBlob(
          new Blob([withMeta.buffer as ArrayBuffer], { type: "image/png" }),
          filename,
        );
      });
    }, "image/png");
  };

  // Export the CURRENTLY DISPLAYED frame as a vector SVG — the sibling export
  // path to {@link exportPng}, also a one-shot click OUTSIDE the per-frame loop.
  // Unlike PNG (which snapshots the live canvas's pixels), SVG serializes Scene
  // geometry with core's `renderToSVG`. Unframed ordinary Sketches retain their
  // cold `generate` path exactly. A committed Page Frame instead transforms the
  // exact retained full-Composition Fill, without preparation, sampling, or
  // generation. Shading-capable Sketches use that same final framing pass on
  // their acknowledged worker Scene and never regenerate expensive artwork on
  // the main thread.
  //
  // `t` is TIME-GATED on `sketch.time` exactly as the PNG path does. Framed
  // ordinary export takes it atomically from the retained Fill record; all
  // existing paths keep reading the handle's current time. Static Sketches pass
  // `undefined`, not 0.
  const exportSvg = () => {
    if (
      diagnosticSelectionRef.current !== null ||
      !primaryLegacyActionsAvailableNow() ||
      !environmentReadyNow()
    ) return;
    const handle = canvasHandle.current;
    if (handle == null) return;
    const shadingExport = captureCurrentShadingExport();
    if (hasShadingCapability && shadingExport === null) return;
    const edit = historyRef.current.present;
    const pageFrame =
      edit.framing.kind === "framed" ? edit.framing.pageFrame : null;
    const framedExport = pageFrame !== null;
    const retainedFill = framedExport && shadingExport === null
      ? handle.captureDisplayedFillFrame()
      : null;
    if (framedExport && shadingExport === null && retainedFill === null) {
      return;
    }
    const sampledT = retainedFill?.t ?? handle.getCurrentT();
    const t = sketch.time === undefined ? undefined : sampledT;
    const environment = sketchEnvironmentRef.current.environment;
    // `generate` takes a concrete `t` (static Sketches conventionally get 0 and
    // ignore it); the gated `t` above — `undefined` for a static Sketch — is the
    // filename's time-segment source, so both reflect the same displayed moment.
    const sourceScene =
      shadingExport?.result.scene ?? retainedFill?.sourceScene ?? null;
    let scene: Scene;
    if (pageFrame !== null && sourceScene !== null) {
      scene = frameScene(sourceScene, pageFrame);
    } else if (sourceScene !== null) {
      scene = sourceScene;
    } else {
      // Cold generation is a legacy Primary Ink fallback. Re-prove the
      // transient view at the exact side-effect boundary.
      if (!primaryLegacyActionsAvailableNow()) return;
      scene =
        environment === undefined
          ? sketch.generate(params, seed, t ?? 0, compositionFrame)
          : sketch.generate(
              params,
              seed,
              t ?? 0,
              compositionFrame,
              environment,
            );
    }
    // Clip the generated geometry to the canvas rectangle so the exported plot
    // contains nothing beyond the Scene's own `space` (issue #237). Export-time
    // ONLY — this pure Scene→Scene transform never runs in the live fill loop.
    const exportScene =
      shadingExport === null && !framedExport
        ? clipSceneToBounds(scene)
        : scene;
    // Embed the same whole authored-state snapshot as a <metadata> element.
    // Core's `renderToSVG` does the injection (ADR-0004: serialization lives in
    // core), including optional committed framing as a v3 envelope.
    const metadata = buildReproMetadata({
      sketchId: sketch.id,
      seed: edit.seed,
      params: edit.params,
      locks: edit.locks,
      t,
      profile: edit.profile,
      framing: persistedFramingFor(edit),
    });
    if (!sameShadingExportRevision(shadingExport)) return;
    const svg = renderToSVG(exportScene, metadata);
    const blob = new Blob([svg], { type: "image/svg+xml" });
    if (!sameShadingExportRevision(shadingExport)) return;
    if (!primaryLegacyActionsAvailableNow()) return;
    downloadBlob(
      blob,
      exportFilename(
        {
          sketchId: sketch.id,
          seed: edit.seed,
          t,
        },
        "svg",
      ),
    );
  };

  // Capture exactly one retained displayed-frame record, then freeze the entire
  // export envelope before handing it to the worker. No completion callback
  // reads React state or the live canvas again.
  const exportHiddenLineSvg = () => {
    if (
      diagnosticSelectionRef.current !== null ||
      !primaryLegacyActionsAvailableNow() ||
      hiddenLineBusy ||
      !environmentReadyNow()
    ) {
      return;
    }
    const handle = canvasHandle.current;
    if (handle == null) return;
    const capturedDisplayed = handle.captureDisplayedFrame();
    if (capturedDisplayed === null) return;
    const shadingExport = captureCurrentShadingExport();
    if (hasShadingCapability && shadingExport === null) return;
    const displayed = shadingExport?.displayed ?? capturedDisplayed;

    const edit = historyRef.current.present;
    const cachedOutline = outlineSessionRef.current.cache;
    // A displayed Outline is processed geometry, never a derivation source. Its
    // cache retains the immutable raw identity source for misses and is offered
    // separately as an exact reuse candidate.
    const cachedSourceScene =
      cachedOutline?.identity.sourceKind === "legacy-scene" ||
      cachedOutline?.identity.sourceKind === "completed-scene-sketch"
        ? mutableScene(cachedOutline.identity.sourceScene)
        : undefined;
    const sourceScene =
      shadingExport?.result.scene ??
      (displayed.renderMode !== "outline"
        ? displayed.sourceScene
        : cachedSourceScene ??
          (sketch.deriveOutlineSource === undefined &&
          sketch.generateOutlineSource !== undefined
            ? displayed.sourceScene
            : undefined));
    if (sourceScene === undefined) return;
    const identity = createOutlineComputeIdentity({
      sketchId: sketch.id,
      schema: sketch.schema,
      params: artworkGenerationParams(sketch, edit.params),
      seed: edit.seed,
      sampledT: displayed.t,
      compositionFrame,
      tolerance: displayed.tolerance,
      ...outlineIdentitySourceFor(
        sketch,
        edit,
        sourceScene,
      ),
    });
    const t = sketch.time === undefined ? undefined : displayed.t;
    const metadata = buildReproMetadata({
      sketchId: sketch.id,
      seed: edit.seed,
      params: edit.params,
      locks: edit.locks,
      t,
      profile: edit.profile,
      framing: persistedFramingFor(edit),
    });
    const filename = exportFilename(
      { sketchId: sketch.id, seed: edit.seed, t, variant: "hidden-line" },
      "svg",
    );
    const snapshot = createHiddenLineExportSnapshot({
      identity,
      profile: edit.profile,
      pageFrame:
        edit.framing.kind === "framed" ? edit.framing.pageFrame : null,
      metadata,
      includePaperMargins,
      filename,
      ...(cachedOutline !== null &&
      outlineGeometryIdentitiesEqual(identity, cachedOutline.identity)
        ? {
            reusableOutline: {
              identity: cachedOutline.identity,
              scene: cachedOutline.scene,
            },
          }
        : {}),
    });
    if (!sameShadingExportRevision(shadingExport)) return;
    const requested = dispatchOutline({
      type: "request-export",
      snapshot,
      ...(displayed.sourceInputRevision === undefined ||
      displayed.contentRevision === undefined
        ? {}
        : {
            provenance: {
              sourceInputRevision: displayed.sourceInputRevision,
              contentRevision: displayed.contentRevision,
            },
          }),
    });
    const active = requested.exportActive;
    if (active === null || active.snapshot !== snapshot) return;
    const coordinator = coordinatorRef.current;
    if (
      coordinator === null ||
      !primaryLegacyActionsAvailableNow()
    ) {
      console.error(
        "Hidden-line export failed",
        "Hidden-line export is unavailable",
      );
      dispatchOutline({
        type: "export-failed",
        token: active.token,
        error: "Hidden-line export is unavailable",
      });
      return;
    }

    void coordinator
      .startExport(snapshot, (update) => {
        if (outlineSessionRef.current.exportActive?.token !== active.token) {
          return;
        }
        if (!primaryLegacyActionsAvailableNow()) return;
        if (!environmentReadyNow()) {
          cancelUnavailableEnvironmentWork();
          return;
        }
        if (update.phase === "finalizing") {
          dispatchOutline({ type: "export-finalizing", token: active.token });
        } else {
          setExportProgress({ token: active.token, update });
        }
      })
      .then((result) => {
        if (
          coordinatorRef.current !== coordinator ||
          !primaryLegacyActionsAvailableNow() ||
          outlineSessionRef.current.exportActive?.token !== active.token
        ) {
          return;
        }
        if (!environmentReadyNow()) {
          cancelUnavailableEnvironmentWork();
          return;
        }
        if (result.status === "success") {
          dispatchOutline({
            type: "export-succeeded",
            token: active.token,
            completedOutline: result.completedOutline,
          });
          if (!sameShadingExportRevision(shadingExport)) return;
          if (!primaryLegacyActionsAvailableNow()) return;
          downloadBlob(
            new Blob([result.svg], { type: "image/svg+xml" }),
            result.filename,
          );
        } else if (result.status === "cancelled") {
          dispatchOutline({ type: "export-cancelled", token: active.token });
        } else {
          console.error("Hidden-line export failed", result.error);
          dispatchOutline({
            type: "export-failed",
            token: active.token,
            error: safeExportFailureDetail(result.error),
          });
        }
      })
      .catch((error: unknown) => {
        if (
          coordinatorRef.current !== coordinator ||
          !primaryLegacyActionsAvailableNow() ||
          outlineSessionRef.current.exportActive?.token !== active.token
        ) {
          return;
        }
        if (!environmentReadyNow()) {
          cancelUnavailableEnvironmentWork();
          return;
        }
        const detail =
          error instanceof Error ? error.message : "Hidden-line export failed";
        console.error("Hidden-line export failed", detail);
        dispatchOutline({
          type: "export-failed",
          token: active.token,
          error: safeExportFailureDetail(detail),
        });
      });
  };

  const cancelExport = (): void => {
    const active = outlineSessionRef.current.exportActive;
    if (active === null) return;
    cancelCoordinator();
    dispatchOutline({ type: "export-cancelled", token: active.token });
  };

  const controlPanelProps = {
    schema: sketch.schema,
    params,
    locks,
    onChange: setParam,
    editHistory: {
      onBegin: beginTransaction,
      onPreview: (next) => previewLeaf("params", next),
      onCommit: commitTransaction,
      onCancel: cancelTransaction,
    },
    onParamEditBegin: beginParamTransaction,
    onToggleLock: toggleLock,
    imageAssetLongEdgeCap,
    imageAssetResolution: {
      status: sketchEnvironment.status,
      failedId: sketchEnvironment.failedId,
      retry: sketchEnvironment.retry,
    },
    getImageAssetDimensions: (imageAssetId: string) => {
      if (!environmentReadyNow()) return undefined;
      const record =
        sketchEnvironmentRef.current.environment?.imageAssets(imageAssetId);
      return record === undefined
        ? undefined
        : { width: record.width, height: record.height };
    },
    onRecomposeToImageAspect: recomposeToImageAspect,
  } satisfies ControlPanelProps;

  // TWO-REGION SHELL (#154): the canvas region (left) fills the remaining space
  // and centers the live canvas; the fixed-width inspector sidebar (right,
  // vertically scrollable) houses EVERY per-sketch control. This is a re-housing
  // of the existing controls — their markup/styling is unchanged, only relocated
  // (shadcn restyling is later sibling work). Both regions read the SAME
  // params/seed/locks state this component owns, which is why the layout lives
  // here rather than in App. The canvas stage hands its full height to
  // LiveCanvas's own layout, which centers the canvas and pins the transport to a
  // slim bar at the bottom of the canvas area (#156). The App-owned `switcher`
  // slot renders at the sidebar top.
  return (
    <div className="studio-shell">
      <section className="canvas-region" aria-label="Canvas">
        {/*
         * The collapse toggle lives in the canvas region — NOT inside the
         * collapsing sidebar — so it stays visible (and the sidebar re-openable)
         * while collapsed. `[` is the equivalent keyboard shortcut (owned by App).
         */}
        <div className="canvas-region__bar">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
            aria-expanded={!collapsed}
            aria-controls="inspector"
            aria-label={collapsed ? "Show inspector" : "Hide inspector"}
            onClick={onToggleCollapse}
            title="Toggle inspector ([)"
          >
            {collapsed ? <PanelRightOpen aria-hidden /> : <PanelRightClose aria-hidden />}
          </Button>
        </div>
        <div className="canvas-region__stage">
          <LiveCanvas
            handleRef={canvasHandle}
            sketch={sketch}
            params={params}
            seed={seed}
            {...(environmentReady && sketchEnvironment.environment !== undefined
              ? { environment: sketchEnvironment.environment }
              : {})}
            compositionFrame={compositionFrame}
            profile={
              pageFrameEditDraft === null
                ? profile
                : pageFrameEditDraftProfile(pageFrameEditDraft)
            }
            inputRevision={outlineSession.inputRevision}
            fillCaptureRequest={outlineSession.capture}
            onFillCaptured={onFillCaptured}
            onDisplayedSceneCommitted={onDisplayedSceneCommitted}
            renderState={renderState}
            tolerance={tolerance}
            outlineFinalizationStrokePolicy={
              outlineFinalizationStrokePolicy
            }
            pageFrameEditDraft={pageFrameEditDraft}
            onPageFrameDraftChange={updatePageFrameFromCanvas}
            pageFrameAspectConstraint={pageFrameAspectConstraint}
            pageFrame={
              history.present.framing.kind === "framed"
                ? history.present.framing.pageFrame
                : null
            }
          />
        </div>
      </section>
      {/*
       * The inspector stays MOUNTED in both states and merely `hidden` while
       * collapsed (#165), rather than being conditionally rendered. The
       * canvas-region toggle carries `aria-controls="inspector"`, so the target
       * element must exist even while collapsed — otherwise the very affordance a
       * screen-reader user relies on to RE-open the panel points at nothing. The
       * `[hidden]` attribute both removes it from the a11y tree and (via the
       * `.inspector[hidden] { display: none }` rule in App.css, which beats the
       * author `display: flex`) collapses it so the canvas takes the full width.
       */}
      <aside
        id="inspector"
        className="inspector"
        aria-label="Inspector"
        hidden={collapsed}
      >
        {switcher}
        {pageFrameEditDraft !== null ? (
          <PageFrameEditor
            editDraft={pageFrameEditDraft}
            displayUnit={readPaperDisplayUnit()}
            aspectConstraint={pageFrameAspectConstraint}
            onAspectConstraintChange={setPageFrameAspectConstraint}
            onEditDraftChange={updatePageFrameEditDraft}
            onApply={applyPageFrame}
            onCancel={closePageFrameEditor}
            onReset={resetFrame}
          />
        ) : (
          <>
        <PaperSection
          profile={profile}
          transaction={{
            onBegin: beginProfileTransaction,
            onPreview: (next) => previewLeaf("profile", next),
            onCommit: commitTransaction,
            onCancel: cancelTransaction,
          }}
          onAtomicChange={(next) => commitLeaf("profile", next)}
          routeProfileCandidate={routePaperProfileCandidate}
          {...(history.present.framing.kind === "framed"
            ? {
                aspectLocked: history.present.framing.aspectLocked,
                onAspectLockedChange: commitPageAspectLocked,
              }
            : {})}
          includePaperMargins={includePaperMargins}
          onIncludePaperMarginsChange={commitIncludePaperMargins}
        />
        {plotSequence === undefined ? (
          <ControlPanel {...controlPanelProps} />
        ) : (
          <PlotSequenceStageControls
            {...controlPanelProps}
            declaration={plotSequence}
            presentation={plotSequencePresentation.presentation}
            records={registeredStagePreparation.records}
            onPresentationChange={setPlotSequencePresentation}
            onCancelStage={registeredStagePreparation.cancel}
            onRetryStage={registeredStagePreparation.retry}
          />
        )}
        <Button
          ref={cropButtonRef}
          type="button"
          variant="outline"
          size="sm"
          onClick={openPageFrameEditor}
        >
          Crop
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={rollSeed}
          >
            New seed
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={rollParams}
          >
            Randomize
          </Button>
          <PresetControls
            sketchId={sketch.id}
            params={params}
            seed={seed}
            locks={locks}
            profile={profile}
            {...(history.present.framing.kind === "framed"
              ? { framing: persistedFramingFor(history.present)! }
              : {})}
            onReload={reloadPreset}
          />
        </div>
        <SeedControl
          value={seed}
          editHistory={{
            onBegin: beginSeedTransaction,
            onPreview: (next) => previewLeaf("seed", next),
            onCommit: commitTransaction,
            onCancel: cancelTransaction,
          }}
        />
        {hasShadingCapability ? (
          <ShadingDiagnostics
            displayed={displayedShadingDiagnostics}
            preparation={shadingPreparationDiagnostics}
          />
        ) : null}
        {/*
         * Render-mode toggle (#219) — swaps the whole preview between the live
         * fill render and the on-demand Hidden-line (outline) render. `mt-auto`
         * pins this to the bottom of the flex-column sidebar so it sits just above
         * the export group (the two anchor together as the sidebar's footer). It
         * is a view-only toggle: `aria-pressed` reflects outline, and flipping it
         * changes nothing about params/seed/locks.
         *
         * Desired Outline remains pressed while the prior Fill stays visible.
         * `aria-busy` covers capture plus worker compute, while the toggle remains
         * usable as the immediate cancel/back-to-Fill action.
         */}
        {hasPlotSequence ? (
          <p
            className="mt-auto text-xs text-muted-foreground"
            data-primary-ink-actions={
              primaryLegacyActionsAvailable ? "available" : "unavailable"
            }
          >
            {primaryLegacyActionsAvailable
              ? "Primary Ink render actions"
              : "Primary Ink actions are available only in the isolated Primary Ink view."}
          </p>
        ) : null}
        <div
          hidden={!primaryLegacyActionsAvailable}
          aria-label={hasPlotSequence ? "Primary Ink render actions" : undefined}
        >
        <div
          className={`${hasPlotSequence ? "" : "mt-auto "}flex items-center gap-2`}
        >
          <span className="flex-none min-w-16 text-sm text-muted-foreground">
            render
          </span>
          {sketch.generateToneSource === undefined &&
          sketch.generateDetailField === undefined ? (
            <Button
              type="button"
              variant={
                outlineSession.desired === "outline" ? "default" : "outline"
              }
              size="sm"
              className="flex-1"
              aria-pressed={outlineSession.desired === "outline"}
              aria-busy={outlineBusy}
              aria-label="Toggle outline render mode"
              onClick={toggleRenderMode}
              disabled={exportBusy || !environmentReady}
            >
              {outlineSession.desired === "outline" ? "Outline" : "Fill"}
            </Button>
          ) : (
            <div
              role="group"
              aria-label="Render mode"
              className="flex min-w-0 flex-1 gap-1"
            >
              <Button
                type="button"
                variant={
                  diagnosticSelection === null &&
                  outlineSession.desired === "fill"
                    ? "default"
                    : "outline"
                }
                size="sm"
                className="flex-1"
                aria-pressed={
                  diagnosticSelection === null &&
                  outlineSession.desired === "fill"
                }
                onClick={selectFill}
                disabled={exportBusy}
              >
                Fill
              </Button>
              <Button
                type="button"
                variant={
                  diagnosticSelection === null &&
                  outlineSession.desired === "outline"
                    ? "default"
                    : "outline"
                }
                size="sm"
                className="flex-1"
                aria-pressed={
                  diagnosticSelection === null &&
                  outlineSession.desired === "outline"
                }
                aria-busy={outlineBusy}
                onClick={selectOutline}
                disabled={exportBusy || !environmentReady}
              >
                Outline
              </Button>
              {sketch.generateToneSource === undefined ? null : (
                <Button
                  type="button"
                  variant={toneReferenceActive ? "default" : "outline"}
                  size="sm"
                  className="flex-1"
                  aria-pressed={toneReferenceActive}
                  aria-label="Show Tone reference"
                  onClick={selectToneReference}
                  disabled={exportBusy}
                >
                  Tone
                </Button>
              )}
              {sketch.generateDetailField === undefined ? null : (
                <Button
                  type="button"
                  variant={
                    diagnosticSelection === "detail" ? "default" : "outline"
                  }
                  size="sm"
                  className="flex-1"
                  aria-pressed={diagnosticSelection === "detail"}
                  aria-label="Show Detail reference"
                  onClick={selectDetailReference}
                  disabled={
                    exportBusy || !environmentReady || detailIdentity === null
                  }
                >
                  Detail
                </Button>
              )}
            </div>
          )}
        </div>
        {revealedOutlineToken === outlineWorkToken && outlineBusy ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p role="status" aria-live="polite" className="sr-only">
              Outline processing. Progress and cancellation controls are available.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                cancelCoordinator();
                dispatchOutline({ type: "cancelled" });
              }}
            >
              Cancel outline
            </Button>
            {outlineProgress?.token === outlineWorkToken ? (
              <>
                <div className="flex items-center gap-2">
                  <progress
                    aria-label="Outline progress"
                    className="min-w-0 flex-1"
                    value={outlineProgress.update.snapshot.completedWorkUnits}
                    max={outlineProgress.update.snapshot.totalWorkUnits}
                  />
                  <span className="shrink-0 tabular-nums">
                    {outlineProgress.update.snapshot.totalWorkUnits === 0
                      ? 100
                      : Math.round(
                          (outlineProgress.update.snapshot.completedWorkUnits /
                            outlineProgress.update.snapshot.totalWorkUnits) *
                            100,
                        )}
                    %
                  </span>
                </div>
                <p>
                  {outlineProgress.update.eta.kind === "estimating"
                    ? "Estimating time remaining…"
                    : formatOutlineEta(outlineProgress.update.eta.remainingMs)}
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <progress
                    aria-label="Outline progress"
                    className="min-w-0 flex-1"
                  />
                  <span className="shrink-0 tabular-nums">0%</span>
                </div>
                <p>Estimating time remaining…</p>
              </>
            )}
          </div>
        ) : null}
        {outlineSession.failure !== null ? (
          <p role="alert" className="text-sm text-destructive">
            <strong>Outline failed</strong>
            {outlineSession.failure === "" ? null : `: ${outlineSession.failure}`}
          </p>
        ) : null}
        {/*
         * Simplification tolerance knob (#232) — a STUDIO-level control (not a
         * per-sketch schema param) driving the Hidden-line pass's final
         * Douglas–Peucker stage. Its single `tolerance` state feeds BOTH the
         * outline preview (LiveCanvas `tolerance` prop) and the hidden-line SVG
         * export (`outlineScene`'s tolerance arg), so simplification is identical
         * in preview and export by construction. Slider + number input are two-way
         * bound to the same value through `setToleranceValue` (continuous, in
         * [0, TOLERANCE_MAX]; 0 = identity, no simplification). It sits between
         * the render toggle and the export group since it only affects the
         * outline preview and the hidden-line export.
         */}
        <SimplifyControl
          value={tolerance}
          editHistory={{
            onBegin: beginTransaction,
            onPreview: (next) => previewLeaf("tolerance", next),
            onCommit: commitTransaction,
            onCancel: cancelTransaction,
          }}
        />
        </div>
        {/*
         * Export controls — the shared home for every export path (PNG snapshots
         * the live canvas frame; SVG serializes ordinary cold geometry or the
         * acknowledged Shading Scene; Hidden-line SVG reuses an exact displayed
         * Scene when available, then occlusion-clips as needed for plotting). The
         * buttons split the row
         * (`flex-1`) and wrap as the group grows.
         */}
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={hasPlotSequence ? "Primary Ink legacy exports" : "Exports"}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={exportPng}
            title={
              hasPlotSequence && !primaryLegacyActionsAvailable
                ? "Export PNG is available only in the isolated Primary Ink view."
                : undefined
            }
            disabled={
              !primaryLegacyActionsAvailable ||
              diagnosticReferenceActive ||
              !environmentReady ||
              (!shadingPaintIsCurrent && hasShadingCapability)
            }
          >
            Export PNG
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={exportSvg}
            title={
              hasPlotSequence && !primaryLegacyActionsAvailable
                ? "Export SVG is available only in the isolated Primary Ink view."
                : undefined
            }
            disabled={
              !primaryLegacyActionsAvailable ||
              diagnosticReferenceActive ||
              !environmentReady ||
              (!shadingPaintIsCurrent && hasShadingCapability)
            }
          >
            Export SVG
          </Button>
          <div className="basis-full space-y-2">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={exportHiddenLineSvg}
                title={
                  hasPlotSequence && !primaryLegacyActionsAvailable
                    ? "Hidden-line export is available only in the isolated Primary Ink view."
                    : undefined
                }
                disabled={
                  !primaryLegacyActionsAvailable ||
                  diagnosticReferenceActive ||
                  !environmentReady ||
                  hiddenLineBusy ||
                  (!shadingPaintIsCurrent && hasShadingCapability)
                }
              >
                Export Hidden-line SVG
              </Button>
              {exportBusy ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={cancelExport}
                >
                  Cancel export
                </Button>
              ) : null}
            </div>
            {revealedExportToken === exportWorkToken && exportBusy ? (
              <div className="space-y-2 text-sm text-muted-foreground">
                <p role="status" aria-live="polite" className="sr-only">
                  Hidden-line export processing. Progress and cancellation
                  controls are available.
                </p>
                {outlineSession.exportActive?.phase === "finalizing" ? (
                  <p>Preparing SVG…</p>
                ) : exportProgress?.token === exportWorkToken ? (
                  <>
                    <div className="flex items-center gap-2">
                      <progress
                        aria-label="Hidden-line export progress"
                        className="min-w-0 flex-1"
                        value={exportProgress.update.snapshot.completedWorkUnits}
                        max={exportProgress.update.snapshot.totalWorkUnits}
                      />
                      <span className="shrink-0 tabular-nums">
                        {exportProgress.update.snapshot.totalWorkUnits === 0
                          ? 100
                          : Math.round(
                              (exportProgress.update.snapshot.completedWorkUnits /
                                exportProgress.update.snapshot.totalWorkUnits) *
                                100,
                            )}
                        %
                      </span>
                    </div>
                    <p>
                      {exportProgress.update.eta.kind === "estimating"
                        ? "Estimating time remaining…"
                        : formatOutlineEta(
                            exportProgress.update.eta.remainingMs,
                          )}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <progress
                        aria-label="Hidden-line export progress"
                        className="min-w-0 flex-1"
                      />
                      <span className="shrink-0 tabular-nums">0%</span>
                    </div>
                    <p>Estimating time remaining…</p>
                  </>
                )}
              </div>
            ) : null}
            {outlineSession.exportFailure !== null ? (
              <p role="alert" className="text-sm text-destructive">
                <strong>Export failed</strong>
                {outlineSession.exportFailure === ""
                  ? null
                  : `: ${outlineSession.exportFailure}`}
              </p>
            ) : null}
          </div>
        </div>
          </>
        )}
      </aside>
    </div>
  );
}
