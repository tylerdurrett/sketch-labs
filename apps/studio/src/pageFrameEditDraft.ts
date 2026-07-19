/** Pure transient state for scale-preserving and fixed-page framing edits. */

import {
  centeredFixedPageFrame,
  derivePageFramePlotProfile,
  fixedPageCompositionScale,
  fullCompositionPageFrame,
  resizePageFrameFromPhysicalDimension,
  resolveCompositionFrame,
  scaleFixedPageFrame,
  validatePageFrame,
  type CoordinateSpace,
  type PageFrame,
  type PageFramePhysicalDimension,
  type PlotProfile,
} from "@harness/core";

const RELATIVE_TOLERANCE = Number.EPSILON * 8;

export type PageFrameEditMode = "scale-preserving" | "fixed-page";

export interface PageFrameCenter {
  readonly x: number;
  readonly y: number;
}

/** Exact committed values from which one transient editor session opens. */
export interface PageFrameEditEntry {
  readonly profile: PlotProfile;
  readonly representedFrame: PageFrame;
  readonly compositionFrame: CoordinateSpace;
  readonly generationAspect: number;
}

/**
 * Ordinary framing keeps one exact profile/frame basis for the whole run.
 * Every draft profile is derived from that basis, never from the prior draft.
 */
export interface ScalePreservingPageFrameEditDraft
  extends PageFrameEditEntry {
  readonly mode: "scale-preserving";
  readonly frame: PageFrame;
}

/**
 * Fixed-page framing locks the exact profile represented at mode entry.
 * `fitFrame` is the immutable scale-one reference and `center` is the stable
 * anchor used by absolute scale changes.
 */
export interface FixedPageFrameEditDraft {
  readonly mode: "fixed-page";
  readonly profile: PlotProfile;
  readonly frame: PageFrame;
  readonly fitFrame: PageFrame;
  readonly compositionScale: number;
  readonly center: PageFrameCenter;
  readonly compositionFrame: CoordinateSpace;
  readonly generationAspect: number;
}

export type PageFrameEditDraft =
  | ScalePreservingPageFrameEditDraft
  | FixedPageFrameEditDraft;

/** Open a transient editor in the existing scale-preserving mode. */
export function openPageFrameEditDraft(
  entry: PageFrameEditEntry,
): ScalePreservingPageFrameEditDraft {
  validateEntry(entry, "openPageFrameEditDraft");
  const draft: ScalePreservingPageFrameEditDraft = {
    mode: "scale-preserving",
    profile: entry.profile,
    representedFrame: entry.representedFrame,
    frame: entry.representedFrame,
    compositionFrame: entry.compositionFrame,
    generationAspect: entry.generationAspect,
  };
  validatePageFrameEditDraft(draft);
  return draft;
}

/**
 * Replace an ordinary frame without changing its exact derivation basis.
 * This is the geometry seam for pointer and percentage-field edits.
 */
export function setScalePreservingPageFrame(
  draft: ScalePreservingPageFrameEditDraft,
  frame: PageFrame,
): ScalePreservingPageFrameEditDraft {
  validatePageFrameEditDraft(draft);
  validatePageFrame(frame);
  // Validate the proposed frame against the original basis now, rather than
  // allowing a bad transient pair to reach Apply or a later mode switch.
  derivePageFramePlotProfile(draft.profile, draft.representedFrame, frame);
  if (sameFrame(draft.frame, frame)) return draft;

  const next = { ...draft, frame };
  validatePageFrameEditDraft(next);
  return next;
}

/** Resize one ordinary total-paper dimension from the session's exact basis. */
export function resizeScalePreservingPageFrame(
  draft: ScalePreservingPageFrameEditDraft,
  dimension: PageFramePhysicalDimension,
  millimeters: number,
): ScalePreservingPageFrameEditDraft {
  validatePageFrameEditDraft(draft);
  const frame = resizePageFrameFromPhysicalDimension(
    draft.profile,
    draft.representedFrame,
    draft.frame,
    dimension,
    millimeters,
  );
  return setScalePreservingPageFrame(draft, frame);
}

/** Resolve the exact profile currently represented by either draft variant. */
export function pageFrameEditDraftProfile(
  draft: PageFrameEditDraft,
): PlotProfile {
  validatePageFrameEditDraft(draft);
  return draft.mode === "fixed-page"
    ? draft.profile
    : derivePageFramePlotProfile(
        draft.profile,
        draft.representedFrame,
        draft.frame,
      );
}

/**
 * Switch framing operations without changing the displayed Page Frame.
 * Entering fixed-page mode materializes the ordinary transient profile;
 * returning rebases ordinary derivation onto the exact fixed profile/frame.
 */
export function setPageFrameEditMode(
  draft: PageFrameEditDraft,
  mode: PageFrameEditMode,
): PageFrameEditDraft {
  validatePageFrameEditDraft(draft);
  if (draft.mode === mode) return draft;

  if (mode === "fixed-page") {
    if (draft.mode !== "scale-preserving") {
      throw new Error(
        `setPageFrameEditMode: unsupported source mode ${String(draft.mode)}`,
      );
    }
    const profile = derivePageFramePlotProfile(
      draft.profile,
      draft.representedFrame,
      draft.frame,
    );
    const fitFrame = centeredFixedPageFrame(
      profile,
      draft.compositionFrame,
    );
    const fixed: FixedPageFrameEditDraft = {
      mode: "fixed-page",
      profile,
      frame: draft.frame,
      fitFrame,
      compositionScale: fixedPageCompositionScale(
        profile,
        fitFrame,
        draft.frame,
      ),
      center: frameCenter(draft.frame),
      compositionFrame: draft.compositionFrame,
      generationAspect: draft.generationAspect,
    };
    validatePageFrameEditDraft(fixed);
    return fixed;
  }

  if (draft.mode !== "fixed-page") {
    throw new Error(
      `setPageFrameEditMode: unsupported source mode ${String(draft.mode)}`,
    );
  }
  const ordinary: ScalePreservingPageFrameEditDraft = {
    mode: "scale-preserving",
    profile: draft.profile,
    representedFrame: draft.frame,
    frame: draft.frame,
    compositionFrame: draft.compositionFrame,
    generationAspect: draft.generationAspect,
  };
  validatePageFrameEditDraft(ordinary);
  return ordinary;
}

/** Apply an absolute fixed-page composition scale at the stable current center. */
export function setFixedPageCompositionScale(
  draft: FixedPageFrameEditDraft,
  compositionScale: number,
): FixedPageFrameEditDraft {
  validatePageFrameEditDraft(draft);
  if (equivalent(draft.compositionScale, compositionScale)) return draft;

  const anchoredCurrent = frameAroundCenter(
    draft.center,
    draft.frame.width,
    draft.frame.height,
  );
  const frame = scaleFixedPageFrame(
    draft.profile,
    draft.fitFrame,
    anchoredCurrent,
    compositionScale,
  );
  const representedScale = fixedPageCompositionScale(
    draft.profile,
    draft.fitFrame,
    frame,
  );
  if (
    sameFrame(draft.frame, frame) &&
    equivalent(draft.compositionScale, representedScale)
  ) {
    return draft;
  }

  const next: FixedPageFrameEditDraft = {
    ...draft,
    frame,
    compositionScale: representedScale,
  };
  validatePageFrameEditDraft(next);
  return next;
}

/**
 * Accept a translated fixed-page frame and move its stable scale anchor.
 * Extent changes belong to the absolute scale operation and are rejected here.
 */
export function panFixedPageFrame(
  draft: FixedPageFrameEditDraft,
  frame: PageFrame,
): FixedPageFrameEditDraft {
  validatePageFrameEditDraft(draft);
  validatePageFrame(frame);
  if (
    frame.width !== draft.frame.width ||
    frame.height !== draft.frame.height
  ) {
    throw new Error(
      "panFixedPageFrame: panning must not change the fixed Page Frame extents",
    );
  }
  if (sameFrame(draft.frame, frame)) return draft;

  const next: FixedPageFrameEditDraft = {
    ...draft,
    frame,
    center: frameCenter(frame),
  };
  validatePageFrameEditDraft(next);
  return next;
}

/** Fit and recenter the full frozen Composition without changing the profile. */
export function resetFixedPageFrame(
  draft: FixedPageFrameEditDraft,
): FixedPageFrameEditDraft {
  validatePageFrameEditDraft(draft);
  const center = frameCenter(draft.fitFrame);
  if (
    sameFrame(draft.frame, draft.fitFrame) &&
    draft.compositionScale === 1 &&
    sameCenter(draft.center, center)
  ) {
    return draft;
  }

  const next: FixedPageFrameEditDraft = {
    ...draft,
    frame: draft.fitFrame,
    compositionScale: 1,
    center,
  };
  validatePageFrameEditDraft(next);
  return next;
}

/** Reject forged or stale transient states at every public operation boundary. */
export function validatePageFrameEditDraft(draft: PageFrameEditDraft): void {
  const operation = "validatePageFrameEditDraft";
  validateGenerationBasis(
    draft.compositionFrame,
    draft.generationAspect,
    operation,
  );
  validatePageFrame(draft.frame);

  if (draft.mode === "scale-preserving") {
    derivePageFramePlotProfile(
      draft.profile,
      draft.representedFrame,
      draft.frame,
    );
    return;
  }

  if (draft.mode !== "fixed-page") {
    throw new Error(
      `${operation}: mode must be "scale-preserving" or "fixed-page"`,
    );
  }
  const expectedFit = centeredFixedPageFrame(
    draft.profile,
    draft.compositionFrame,
  );
  if (!sameFrame(draft.fitFrame, expectedFit)) {
    throw new Error(
      `${operation}: fixed-page fitFrame must be the centered scale-one reference`,
    );
  }

  const representedScale = fixedPageCompositionScale(
    draft.profile,
    draft.fitFrame,
    draft.frame,
  );
  if (!equivalent(draft.compositionScale, representedScale)) {
    throw new Error(
      `${operation}: fixed-page compositionScale must match the represented frame`,
    );
  }
  if (
    !Number.isFinite(draft.center.x) ||
    !Number.isFinite(draft.center.y) ||
    !equivalentCoordinate(
      draft.center.x,
      draft.frame.x + draft.frame.width / 2,
      draft.frame.x,
      draft.frame.width,
    ) ||
    !equivalentCoordinate(
      draft.center.y,
      draft.frame.y + draft.frame.height / 2,
      draft.frame.y,
      draft.frame.height,
    )
  ) {
    throw new Error(
      `${operation}: fixed-page center must match the represented frame center`,
    );
  }
}

function validateEntry(entry: PageFrameEditEntry, operation: string): void {
  validateGenerationBasis(
    entry.compositionFrame,
    entry.generationAspect,
    operation,
  );
  // The identity derivation validates both the profile and the exact Page extent
  // it represents at one uniform physical scale without replacing either value.
  derivePageFramePlotProfile(
    entry.profile,
    entry.representedFrame,
    entry.representedFrame,
  );
}

function validateGenerationBasis(
  compositionFrame: CoordinateSpace,
  generationAspect: number,
  operation: string,
): void {
  fullCompositionPageFrame(compositionFrame);
  if (!Number.isFinite(generationAspect) || generationAspect <= 0) {
    throw new Error(
      `${operation}: generationAspect must be a finite positive number, got ${generationAspect}`,
    );
  }
  const expectedCompositionFrame = resolveCompositionFrame(generationAspect);
  if (
    compositionFrame.width !== expectedCompositionFrame.width ||
    compositionFrame.height !== expectedCompositionFrame.height
  ) {
    throw new Error(
      `${operation}: compositionFrame must exactly match the canonical frame resolved from generationAspect`,
    );
  }
}

function frameCenter(frame: PageFrame): PageFrameCenter {
  return {
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  };
}

function frameAroundCenter(
  center: PageFrameCenter,
  width: number,
  height: number,
): PageFrame {
  const frame = {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  };
  validatePageFrame(frame);
  return frame;
}

function sameFrame(left: PageFrame, right: PageFrame): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function sameCenter(left: PageFrameCenter, right: PageFrameCenter): boolean {
  return left.x === right.x && left.y === right.y;
}

function equivalent(left: number, right: number): boolean {
  if (
    !Number.isFinite(left) ||
    left <= 0 ||
    !Number.isFinite(right) ||
    right <= 0
  ) {
    return false;
  }
  if (left === right) return true;
  return (
    Math.abs(left - right) <=
    RELATIVE_TOLERANCE * Math.max(Math.abs(left), Math.abs(right))
  );
}

function equivalentCoordinate(
  left: number,
  right: number,
  origin: number,
  extent: number,
): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (left === right) return true;
  return (
    Math.abs(left - right) <=
    RELATIVE_TOLERANCE *
      Math.max(Math.abs(left), Math.abs(right), Math.abs(origin), extent)
  );
}
