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
  computePlotMapping,
  defaultParams,
  exportFilename,
  insertPngMetadata,
  newSeed,
  plotDrawableAspectsEquivalent,
  plotDrawableRectangle,
  randomize,
  renderToSVG,
  resolveOutputProfile,
  resolvePlotCompositionFrame,
  type Preset,
  type PlotProfile,
  type CoordinateSpace,
  type OutlineTarget,
  type Scene,
  type Sketch,
} from "@harness/core";

import { ControlPanel } from "./ControlPanel";
import { Button } from "./components/ui/button";
import { downloadBlob } from "./downloadBlob";
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
  detectHistoryShortcutPlatform,
  fieldOwnsHistoryShortcut,
  historyShortcutFor,
} from "./historyShortcuts";
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
  outlineComputeIdentitiesEqual,
} from "./outlineComputeProtocol";
import {
  createOutlineSessionState,
  outlineSessionReducer,
  type OutlineSessionAction,
} from "./outlineSession";
import { PaperSection } from "./PaperSection";
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
import { selectCurrentScribbleResult } from "./scribbleSession";
import {
  acknowledgedCurrentScribble,
  type ScribblePaintAcknowledgement,
} from "./scribbleExportReadiness";
import {
  useScribblePreparation,
  type ScribbleAuthoredState,
} from "./useScribblePreparation";
import { useSketchEnvironment } from "./useSketchEnvironment";

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

function outlineIdentitySourceFor(
  sketch: Sketch,
  profile: PlotProfile,
  frame: CoordinateSpace,
  sourceScene: Scene,
):
  | { sourceScene: Scene }
  | { outlineTarget: OutlineTarget }
  | { sourceScene: Scene; outlineTarget: OutlineTarget } {
  const outlineTarget = {
    toolWidthMillimeters: profile.toolWidthMillimeters,
    millimetersPerSceneUnit: computePlotMapping(frame, profile).scale,
  };
  if (sketch.deriveOutlineSource !== undefined) {
    return { sourceScene, outlineTarget };
  }
  if (sketch.generateOutlineSource !== undefined) return { outlineTarget };
  return { sourceScene };
}

/** Whether moving between two authored states invalidates prepared Outline geometry. */
function outlineInputsChanged(
  previous: StudioEditState,
  next: StudioEditState,
  usesPhysicalTool: boolean,
): boolean {
  if (
    !sameParams(previous.params, next.params) ||
    previous.seed !== next.seed ||
    previous.tolerance !== next.tolerance ||
    previous.profile.includeFrame !== next.profile.includeFrame ||
    !Object.is(
      previous.profile.toolWidthMillimeters,
      next.profile.toolWidthMillimeters,
    )
  ) {
    return true;
  }

  const previousDrawable = plotDrawableRectangle(previous.profile);
  const nextDrawable = plotDrawableRectangle(next.profile);
  if (
    usesPhysicalTool &&
    (!Object.is(previousDrawable.width, nextDrawable.width) ||
      !Object.is(previousDrawable.height, nextDrawable.height))
  ) {
    return true;
  }
  return !plotDrawableAspectsEquivalent(
    previousDrawable.width / previousDrawable.height,
    nextDrawable.width / nextDrawable.height,
  );
}

/** Whether an edit changes the time-invariant Scribble worker identity. */
function scribbleInputsChanged(
  previous: StudioEditState,
  next: StudioEditState,
): boolean {
  if (!sameParams(previous.params, next.params) || previous.seed !== next.seed) {
    return true;
  }
  const previousDrawable = plotDrawableRectangle(previous.profile);
  const nextDrawable = plotDrawableRectangle(next.profile);
  return !plotDrawableAspectsEquivalent(
    previousDrawable.width / previousDrawable.height,
    nextDrawable.width / nextDrawable.height,
  );
}

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
 * (via `PresetControls` → `makePreset`), re-resolved on a Preset reload (a v2
 * Preset's stored profile wins; a v1 falls back to the Sketch default / Harness
 * fallback), and embedded into every export's reproduction metadata. Its drawable
 * aspect resolves the ONE Composition Frame shared by preview and vector exports.
 */
export function SketchControls({
  sketch,
  switcher,
  collapsed = false,
  onToggleCollapse,
  onHiddenLineBusyChange,
}: SketchControlsProps) {
  const [history, setHistory] = useState<EditHistory>(() =>
    createEditHistory({
      params: defaultParams(sketch.schema),
      seed: newSeed(Math.random),
      locks: new Set<string>(),
      profile: resolveOutputProfile(undefined, sketch.defaultOutputProfile),
      tolerance: 0,
    }),
  );
  // Event lifecycles can emit begin/preview/commit in one React batch. Mirror the
  // latest transition synchronously so every signal sees the preceding result.
  const historyRef = useRef(history);
  historyRef.current = history;
  const { params, seed, locks, profile, tolerance } = history.present;
  // Tone reference is diagnostic Studio chrome, not authored state. Keeping it
  // beside (rather than inside) the edit-history model excludes it from Undo,
  // Presets, locks, profiles, and every reproduction envelope by construction.
  const [toneReferenceActive, setToneReferenceActive] = useState(false);
  // Mirror selection synchronously so even a programmatic export dispatched in
  // the same React batch as mode entry hits the handler-level guard.
  const toneReferenceActiveRef = useRef(toneReferenceActive);
  useLayoutEffect(() => {
    toneReferenceActiveRef.current = toneReferenceActive;
  }, [toneReferenceActive]);
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

  // Physical magnitude belongs to later device mapping. Composition depends only
  // on the drawable rectangle's aspect, so equivalent profiles share this cache
  // boundary and do not rebuild prepared geometry.
  const drawable = plotDrawableRectangle(profile);
  const drawableAspect = drawable.width / drawable.height;
  // Stabilize the memo key across machine-noise-only quotient differences (for
  // example a 1.2× proportional scale of non-binary A4 dimensions/insets). The
  // same core equivalence drives commit invalidation below, so frame identity and
  // the Computing affordance cannot disagree about whether geometry changed.
  const drawableAspectIdentityRef = useRef(drawableAspect);
  if (
    !plotDrawableAspectsEquivalent(
      drawableAspectIdentityRef.current,
      drawableAspect,
    )
  ) {
    drawableAspectIdentityRef.current = drawableAspect;
  }
  const drawableAspectIdentity = drawableAspectIdentityRef.current;
  const compositionFrame = useMemo(
    () => resolvePlotCompositionFrame(profile),
    [drawableAspectIdentity],
  );

  const sketchEnvironment = useSketchEnvironment({
    schema: sketch.schema,
    params,
  });

  const hasScribblePreparation = sketch.generateScribbleArtwork !== undefined;
  const scribbleInputRevisionRef = useRef(0);
  const scribblePreparation = useScribblePreparation({
    sketch,
    enabled: hasScribblePreparation && sketchEnvironment.ready,
    initial: {
      params: history.present.params,
      seed: history.present.seed,
      compositionFrame,
      inputRevision: scribbleInputRevisionRef.current,
    },
  });
  const currentScribble = selectCurrentScribbleResult(
    scribblePreparation.session,
  );
  const displayedShadingDiagnostics: DisplayedShadingDiagnostics | null =
    scribblePreparation.session.displayed === null
      ? null
      : {
          freshness: currentScribble === null ? "stale" : "current",
          diagnostics: scribblePreparation.session.displayed.diagnostics,
          computeTimeMs: scribblePreparation.session.displayed.computeTimeMs,
        };
  const activeScribbleToken =
    scribblePreparation.session.active?.token ??
    scribblePreparation.session.pending?.token ??
    null;
  const shadingPreparationDiagnostics: ShadingPreparationDiagnostics =
    activeScribbleToken !== null
      ? {
          kind: "preparing",
          progress:
            scribblePreparation.progress?.token === activeScribbleToken
              ? scribblePreparation.progress.update.snapshot
              : null,
          eta:
            scribblePreparation.progress?.token === activeScribbleToken
              ? scribblePreparation.progress.update.eta
              : { kind: "estimating", revision: 0 },
        }
      : scribblePreparation.session.failure === null
        ? { kind: "idle" }
        : {
            kind: "failure",
            message: scribblePreparation.session.failure,
          };
  const [acknowledgedScribble, setAcknowledgedScribble] =
    useState<ScribblePaintAcknowledgement | null>(null);
  const acknowledgedScribbleRef = useRef(acknowledgedScribble);
  acknowledgedScribbleRef.current = acknowledgedScribble;
  const scribblePaintIsCurrent =
    currentScribble !== null &&
    acknowledgedScribble?.sourceInputRevision ===
      currentScribble.sourceInputRevision &&
    acknowledgedScribble.contentRevision === currentScribble.contentRevision;
  const emptyScribbleScene = useMemo<Scene>(
    () => ({ space: compositionFrame, primitives: [] }),
    [compositionFrame],
  );

  const authoredScribbleState = (
    edit: StudioEditState = historyRef.current.present,
  ): ScribbleAuthoredState => ({
    params: edit.params,
    seed: edit.seed,
    compositionFrame: resolvePlotCompositionFrame(edit.profile),
    inputRevision: scribbleInputRevisionRef.current,
  });

  // Sample-source derivation intentionally reads the live transaction preview
  // params and Composition Frame directly. Seed, timeline, profile magnitude,
  // and the Outline session are absent from this capability seam.
  const toneSource = useMemo(
    () =>
      toneReferenceActive
        ? sketchEnvironment.ready
          ? sketch.generateToneSource?.(
              params,
              compositionFrame,
              sketchEnvironment.environment,
            )
          : undefined
        : undefined,
    [
      toneReferenceActive,
      sketch,
      params,
      compositionFrame,
      sketchEnvironment.ready,
      sketchEnvironment.environment,
    ],
  );

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

  const requestOutlineForCurrentInputs = (): void => {
    dispatchOutline({
      type: "request-outline",
      launch: !hasScribblePreparation || scribblePaintIsCurrent,
      ...(scribblePaintIsCurrent && currentScribble !== null
        ? {
            provenance: {
              sourceInputRevision: currentScribble.sourceInputRevision,
              contentRevision: currentScribble.contentRevision,
            },
          }
        : {}),
    });
  };

  const updateHistory = (
    transition: (current: EditHistory) => EditHistory,
    launchOutline = true,
    scribbleAction: "preview" | "atomic" | null = null,
  ): void => {
    const current = historyRef.current;
    const next = transition(current);
    if (next === current) return;
    historyRef.current = next;
    const scribbleChanged = scribbleInputsChanged(current.present, next.present);
    if (hasScribblePreparation && scribbleChanged) {
      scribbleInputRevisionRef.current += 1;
    }
    if (hasScribblePreparation && scribbleAction === "preview") {
      scribblePreparation.previewAuthoredState(
        authoredScribbleState(next.present),
      );
    } else if (
      hasScribblePreparation &&
      scribbleAction === "atomic" &&
      scribbleChanged
    ) {
      scribblePreparation.requestAtomic(authoredScribbleState(next.present));
    }
    const invalidated = outlineInputsChanged(
      current.present,
      next.present,
      sketch.generateOutlineSource !== undefined ||
        sketch.deriveOutlineSource !== undefined,
    );
    if (invalidated) {
      cancelOutlineCoordinator();
      const retainsPaintedScribble =
        hasScribblePreparation && !scribbleChanged && scribblePaintIsCurrent;
      dispatchOutline({
        type: "inputs-changed",
        launch: launchOutline && !hasScribblePreparation,
        ...(retainsPaintedScribble && currentScribble !== null
          ? {
              provenance: {
                sourceInputRevision: currentScribble.sourceInputRevision,
                contentRevision: currentScribble.contentRevision,
              },
            }
          : {}),
        waitForSource: hasScribblePreparation && !retainsPaintedScribble,
      });
    }
    setHistory(next);
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

  const beginTransaction = (): void => {
    // Every authored transaction is a preview boundary even before its first
    // valid value: cancel stale work and paint live Fill while retaining intent
    // and the one exact-result cache for settlement.
    cancelOutlineCoordinator();
    dispatchOutline({ type: "transaction-began" });
    updateHistory(beginEditTransaction, false);
    if (hasScribblePreparation) scribblePreparation.beginTransaction();
  };
  const settleTransaction = (
    transition: (current: EditHistory) => EditHistory,
  ): void => {
    updateHistory(transition, false);
    if (hasScribblePreparation) {
      scribblePreparation.settleTransaction(authoredScribbleState());
    }
    // Settlement belongs to the session reducer: outside export it resamples the
    // final Fill exactly once; during export it retains only a deferred request,
    // which the export terminal action releases after relinquishing the slot.
    dispatchOutline({
      type: "transaction-settled",
      launch: !hasScribblePreparation,
    });
  };
  const commitTransaction = (): void => settleTransaction(commitEditTransaction);
  const cancelTransaction = (): void => settleTransaction(cancelEditTransaction);

  // The read-only window into LiveCanvas (the live <canvas> + current t) the PNG
  // export snapshots. It is a ref, not state — export reads it imperatively on a
  // button click, never during render.
  const canvasHandle = useRef<LiveCanvasHandle>(null);

  // Value type mirrors ControlPanel's onChange seam: `number` from a
  // NumberControl, a hex color `string` from a ColorControl. The params state
  // itself is `Record<string, unknown>`, so only this handler widens.
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
    if (outlineSessionRef.current.desired === "outline") {
      cancelOutlineCoordinator();
      dispatchOutline({ type: "request-fill" });
    } else {
      requestOutlineForCurrentInputs();
    }
  };

  const selectFill = (): void => {
    setToneReferenceActive(false);
    if (outlineSessionRef.current.desired === "outline") {
      cancelOutlineCoordinator();
      dispatchOutline({ type: "request-fill" });
    }
  };

  const selectOutline = (): void => {
    setToneReferenceActive(false);
    if (outlineSessionRef.current.desired !== "outline") {
      requestOutlineForCurrentInputs();
    }
  };

  const selectToneReference = (): void => {
    if (sketch.generateToneSource === undefined) return;
    // Tone has no Outline phase of its own. Relinquish preview ownership and
    // reset intent to Fill before switching LiveCanvas to the pixel source.
    cancelOutlineCoordinator();
    dispatchOutline({ type: "request-fill" });
    toneReferenceActiveRef.current = true;
    setToneReferenceActive(true);
  };

  const onFillCaptured = (capture: FillCapture): void => {
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
      params: edit.params,
      seed: edit.seed,
      sampledT: capture.t,
      compositionFrame,
      tolerance: edit.tolerance,
      includeFrame: edit.profile.includeFrame,
      ...outlineIdentitySourceFor(
        sketch,
        edit.profile,
        compositionFrame,
        capture.scene,
      ),
    });
    const next = dispatchOutline({
      type: "fill-captured",
      token: capture.token,
      inputRevision: capture.inputRevision,
      identity,
      scene: capture.scene,
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
    if (coordinator === null) return;
    void coordinator
      .start(identity, (update) => {
        // Worker callbacks can already be queued when a job is replaced. The
        // session token, rather than coordinator/job identity alone, owns UI
        // progress so an old worker can never repaint a newer request.
        if (outlineSessionRef.current.active?.token !== capture.token) return;
        setOutlineProgress({ token: capture.token, update });
      })
      .then((result) => {
        if (coordinatorRef.current !== coordinator) return;
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
        if (coordinatorRef.current !== coordinator) return;
        reportFailure(error instanceof Error ? error.message : "Outline worker failed");
      });
  };

  const onDisplayedSceneCommitted = (
    snapshot: DisplayedSceneSnapshot,
  ): void => {
    const latestScribble = selectCurrentScribbleResult(
      scribblePreparation.getSessionSnapshot(),
    );
    if (
      latestScribble === null ||
      snapshot.renderMode !== "fill" ||
      snapshot.sourceInputRevision !== latestScribble.sourceInputRevision ||
      snapshot.contentRevision !== latestScribble.contentRevision
    ) {
      return;
    }
    const provenance = {
      sourceInputRevision: latestScribble.sourceInputRevision,
      contentRevision: latestScribble.contentRevision,
    };
    acknowledgedScribbleRef.current = provenance;
    setAcknowledgedScribble((current) =>
      current?.sourceInputRevision === provenance.sourceInputRevision &&
      current.contentRevision === provenance.contentRevision
        ? current
        : provenance,
    );
    dispatchOutline({ type: "source-ready", provenance });
  };

  const renderState: LiveCanvasRenderState =
    toneSource !== undefined
      ? { kind: "tone-reference", source: toneSource }
      : hasScribblePreparation && outlineSession.phase.kind === "fill-live"
        ? scribblePreparation.session.displayed === null
          ? { kind: "fill-held", scene: emptyScribbleScene, t: 0 }
          : {
              kind: "fill-held",
              scene: scribblePreparation.session.displayed.scene,
              t: 0,
              sourceInputRevision:
                scribblePreparation.session.displayed.sourceInputRevision,
              contentRevision:
                scribblePreparation.session.displayed.contentRevision,
            }
        : outlineSession.phase.kind === "fill-live"
        ? { kind: "fill-live" }
        : outlineSession.phase.kind === "fill-held-pending"
          ? {
              kind: "fill-held",
              scene: outlineSession.phase.scene,
              t: outlineSession.phase.t,
              ...(outlineSession.phase.sourceInputRevision === undefined
                ? {}
                : {
                    sourceInputRevision:
                      outlineSession.phase.sourceInputRevision,
                  }),
              ...(outlineSession.phase.contentRevision === undefined
                ? {}
                : { contentRevision: outlineSession.phase.contentRevision }),
            }
          : outlineSession.phase;

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
  // `applyPreset` (the authority on which keys exist), then hydrate all three
  // state axes TOGETHER. The array→Set conversion on `locks` is this owner's
  // job — including preserved color keys, which remain inert rather than being
  // filtered or migrated just because ColorControl has no Lock affordance.
  const reloadPreset = (preset: Preset) => {
    const current = historyRef.current.present;
    const state = applyPreset(sketch.schema, preset);
    const resolvedProfile = resolveOutputProfile(
      state.profile,
      sketch.defaultOutputProfile,
    );
    // Resolve the active profile through #265's precedence: a v2 Preset's stored
    // profile (`state.profile`) wins; a v1 Preset (`state.profile === undefined`)
    // falls back to this Sketch's default / the Harness fallback. `applyPreset`
    // passes the stored profile through verbatim WITHOUT resolving the fallback —
    // resolving it here at the session boundary is #267's job.
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
        }),
      true,
      "atomic",
    );
  };

  /** Re-prove Scribble session and canvas provenance at an export side effect. */
  const captureCurrentScribbleExport = () => {
    if (!hasScribblePreparation) return null;
    const displayed = canvasHandle.current?.captureDisplayedFrame() ?? null;
    const result = acknowledgedCurrentScribble(
      scribblePreparation.getSessionSnapshot(),
      acknowledgedScribbleRef.current,
      displayed,
    );
    return result === null || displayed === null ? null : { result, displayed };
  };

  const sameScribbleExportRevision = (
    expected: ReturnType<typeof captureCurrentScribbleExport>,
  ): boolean => {
    if (!hasScribblePreparation) return true;
    if (expected === null) return false;
    const current = captureCurrentScribbleExport();
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
    if (toneReferenceActiveRef.current) return;
    const handle = canvasHandle.current;
    const canvas = handle?.getCanvas();
    if (handle == null || canvas == null) return;
    const scribbleExport = captureCurrentScribbleExport();
    if (hasScribblePreparation && scribbleExport === null) return;
    // Time-gate the `-t{t}` filename segment on `sketch.time`: a time-driven
    // Sketch carries its captured moment, a static one omits `t` entirely.
    const t = sketch.time === undefined ? undefined : handle.getCurrentT();
    // The reproduction envelope embedded into BOTH exports (issue #76), built
    // once from the same displayed `(params, seed, locks, t)` spine. The active
    // Plot Profile (#247) rides along too, so the exported PNG's metadata is a v2
    // Preset carrying the physical-plot output dimensions.
    const metadata = buildReproMetadata({
      sketchId: sketch.id,
      seed,
      params,
      locks,
      t,
      profile,
    });
    // Re-read the synchronous session and the canvas at the pixel side effect.
    if (!sameScribbleExportRevision(scribbleExport)) return;
    canvas.toBlob((blob) => {
      if (blob === null) return;
      const filename = exportFilename({ sketchId: sketch.id, seed, t }, "png");
      // Splice the iTXt reproduction chunk into the PNG bytes before saving, so
      // the downloaded file traces back to this exact frame. Byte work is core's
      // (`insertPngMetadata`); the Studio only does the Blob ⇄ ArrayBuffer dance.
      void blob.arrayBuffer().then((buffer) => {
        if (!sameScribbleExportRevision(scribbleExport)) return;
        const withMeta = insertPngMetadata(new Uint8Array(buffer), metadata);
        // `withMeta` spans its whole backing buffer (core's `concat` allocates a
        // fresh, offset-0 array), so `.buffer` is exactly these bytes.
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
  // geometry with core's `renderToSVG`. Ordinary Sketches retain their cold
  // `generate` path. Scribble-capable Sketches serialize the exact acknowledged
  // worker Scene and never regenerate expensive artwork on the main thread.
  //
  // `t` is read from the handle and TIME-GATED on `sketch.time` exactly as the
  // PNG path does, so the regenerated Scene and the `-t{t}` filename segment both
  // reflect the same displayed moment (static Sketches pass `undefined`, not 0).
  const exportSvg = () => {
    if (toneReferenceActiveRef.current) return;
    const handle = canvasHandle.current;
    if (handle == null) return;
    const scribbleExport = captureCurrentScribbleExport();
    if (hasScribblePreparation && scribbleExport === null) return;
    const t = sketch.time === undefined ? undefined : handle.getCurrentT();
    // `generate` takes a concrete `t` (static Sketches conventionally get 0 and
    // ignore it); the gated `t` above — `undefined` for a static Sketch — is the
    // filename's time-segment source, so both reflect the same displayed moment.
    const scene =
      scribbleExport?.result.scene ??
      sketch.generate(params, seed, t ?? 0, compositionFrame);
    // Clip the generated geometry to the canvas rectangle so the exported plot
    // contains nothing beyond the Scene's own `space` (issue #237). Export-time
    // ONLY — this pure Scene→Scene transform never runs in the live fill loop.
    const exportScene = scribbleExport === null ? clipSceneToBounds(scene) : scene;
    // Embed the same reproduction envelope as a <metadata> element (issue #76),
    // built from the displayed `(params, seed, locks, t)` spine plus the active
    // Plot Profile (#247) — core's `renderToSVG` does the injection (ADR-0004:
    // serialization lives in core).
    const metadata = buildReproMetadata({
      sketchId: sketch.id,
      seed,
      params,
      locks,
      t,
      profile,
    });
    if (!sameScribbleExportRevision(scribbleExport)) return;
    const svg = renderToSVG(exportScene, metadata);
    const blob = new Blob([svg], { type: "image/svg+xml" });
    if (!sameScribbleExportRevision(scribbleExport)) return;
    downloadBlob(blob, exportFilename({ sketchId: sketch.id, seed, t }, "svg"));
  };

  // Capture exactly one retained displayed-frame record, then freeze the entire
  // export envelope before handing it to the worker. No completion callback
  // reads React state or the live canvas again.
  const exportHiddenLineSvg = () => {
    if (toneReferenceActiveRef.current || hiddenLineBusy) return;
    const handle = canvasHandle.current;
    if (handle == null) return;
    const capturedDisplayed = handle.captureDisplayedFrame();
    if (capturedDisplayed === null) return;
    const scribbleExport = captureCurrentScribbleExport();
    if (hasScribblePreparation && scribbleExport === null) return;
    const displayed = scribbleExport?.displayed ?? capturedDisplayed;

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
      scribbleExport?.result.scene ??
      (displayed.renderMode !== "outline"
        ? displayed.scene
        : cachedSourceScene ??
          (sketch.deriveOutlineSource === undefined &&
          sketch.generateOutlineSource !== undefined
            ? displayed.scene
            : undefined));
    if (sourceScene === undefined) return;
    const identity = createOutlineComputeIdentity({
      sketchId: sketch.id,
      schema: sketch.schema,
      params: edit.params,
      seed: edit.seed,
      sampledT: displayed.t,
      compositionFrame,
      tolerance: displayed.tolerance,
      includeFrame: displayed.includeFrame,
      ...outlineIdentitySourceFor(
        sketch,
        edit.profile,
        compositionFrame,
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
    });
    const filename = exportFilename(
      { sketchId: sketch.id, seed: edit.seed, t, variant: "hidden-line" },
      "svg",
    );
    const snapshot = createHiddenLineExportSnapshot({
      identity,
      profile: edit.profile,
      metadata,
      includePaperMargins,
      filename,
      ...(cachedOutline !== null &&
      outlineComputeIdentitiesEqual(identity, cachedOutline.identity)
        ? {
            reusableOutline: {
              identity: cachedOutline.identity,
              scene: cachedOutline.scene,
            },
          }
        : {}),
    });
    if (!sameScribbleExportRevision(scribbleExport)) return;
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
    if (coordinator === null) {
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
        if (update.phase === "finalizing") {
          dispatchOutline({ type: "export-finalizing", token: active.token });
        } else {
          setExportProgress({ token: active.token, update });
        }
      })
      .then((result) => {
        if (
          coordinatorRef.current !== coordinator ||
          outlineSessionRef.current.exportActive?.token !== active.token
        ) {
          return;
        }
        if (result.status === "success") {
          dispatchOutline({
            type: "export-succeeded",
            token: active.token,
            completedOutline: result.completedOutline,
          });
          if (!sameScribbleExportRevision(scribbleExport)) return;
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
          outlineSessionRef.current.exportActive?.token !== active.token
        ) {
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
            compositionFrame={compositionFrame}
            profile={profile}
            inputRevision={outlineSession.inputRevision}
            fillCaptureRequest={outlineSession.capture}
            onFillCaptured={onFillCaptured}
            onDisplayedSceneCommitted={onDisplayedSceneCommitted}
            renderState={renderState}
            tolerance={tolerance}
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
        <PaperSection
          profile={profile}
          transaction={{
            onBegin: beginTransaction,
            onPreview: (next) => previewLeaf("profile", next),
            onCommit: commitTransaction,
            onCancel: cancelTransaction,
          }}
          onAtomicChange={(next) => commitLeaf("profile", next)}
          includePaperMargins={includePaperMargins}
          onIncludePaperMarginsChange={commitIncludePaperMargins}
        />
        <ControlPanel
          schema={sketch.schema}
          params={params}
          locks={locks}
          onChange={setParam}
          editHistory={{
            onBegin: beginTransaction,
            onPreview: (next) => previewLeaf("params", next),
            onCommit: commitTransaction,
            onCancel: cancelTransaction,
          }}
          onToggleLock={toggleLock}
        />
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
            onReload={reloadPreset}
          />
        </div>
        <SeedControl
          value={seed}
          editHistory={{
            onBegin: beginTransaction,
            onPreview: (next) => previewLeaf("seed", next),
            onCommit: commitTransaction,
            onCancel: cancelTransaction,
          }}
        />
        {hasScribblePreparation ? (
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
        <div className="mt-auto flex items-center gap-2">
          <span className="flex-none min-w-16 text-sm text-muted-foreground">
            render
          </span>
          {sketch.generateToneSource === undefined ? (
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
              disabled={exportBusy}
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
                  !toneReferenceActive && outlineSession.desired === "fill"
                    ? "default"
                    : "outline"
                }
                size="sm"
                className="flex-1"
                aria-pressed={
                  !toneReferenceActive && outlineSession.desired === "fill"
                }
                onClick={selectFill}
                disabled={exportBusy}
              >
                Fill
              </Button>
              <Button
                type="button"
                variant={
                  !toneReferenceActive && outlineSession.desired === "outline"
                    ? "default"
                    : "outline"
                }
                size="sm"
                className="flex-1"
                aria-pressed={
                  !toneReferenceActive && outlineSession.desired === "outline"
                }
                aria-busy={outlineBusy}
                onClick={selectOutline}
                disabled={exportBusy}
              >
                Outline
              </Button>
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
        {/*
         * Export controls — the shared home for every export path (PNG snapshots
         * the live canvas frame; SVG serializes ordinary cold geometry or the
         * acknowledged Scribble Scene; Hidden-line SVG reuses an exact displayed
         * Scene when available, then occlusion-clips as needed for plotting). The
         * buttons split the row
         * (`flex-1`) and wrap as the group grows.
         */}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={exportPng}
            disabled={
              toneReferenceActive ||
              (!scribblePaintIsCurrent && hasScribblePreparation)
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
            disabled={
              toneReferenceActive ||
              (!scribblePaintIsCurrent && hasScribblePreparation)
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
                disabled={
                  toneReferenceActive ||
                  hiddenLineBusy ||
                  (!scribblePaintIsCurrent && hasScribblePreparation)
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
      </aside>
    </div>
  );
}
