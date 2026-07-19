/** Pure Studio history commands for committed Page Frame state (ADR-0015). */

import {
  derivePageFramePlotProfile,
  fullCompositionPageFrame,
  plotDrawableRectangle,
  resolveCompositionFrame,
  resolvePlotCompositionFrame,
  type CoordinateSpace,
  type PageFrame,
} from "@harness/core";

import {
  commitEditState,
  type EditHistory,
  type StudioEditState,
  type StudioFramingState,
} from "./editHistory";

const UNFRAMED: StudioFramingState = Object.freeze({ kind: "unframed" });

/** Resolve the aspect that generation must continue to use for this state. */
export function studioGenerationAspect(state: StudioEditState): number {
  if (state.framing.kind === "framed") {
    return state.framing.generationAspect;
  }
  const drawable = plotDrawableRectangle(state.profile);
  return drawable.width / drawable.height;
}

/** Resolve Composition from the frozen basis when framed, otherwise the profile. */
export function resolveStudioCompositionFrame(
  state: StudioEditState,
): CoordinateSpace {
  return state.framing.kind === "framed"
    ? resolveCompositionFrame(state.framing.generationAspect)
    : resolvePlotCompositionFrame(state.profile);
}

/** Initial numeric-editor value; creating or changing it does not touch history. */
export function initialPageFrameForEdit(state: StudioEditState): PageFrame {
  return state.framing.kind === "framed"
    ? Object.freeze({ ...state.framing.pageFrame })
    : fullCompositionPageFrame(resolveStudioCompositionFrame(state));
}

/**
 * Commit a Page Frame and its physical profile as one history state.
 *
 * The first Apply freezes the unframed profile's generation aspect. Re-edits
 * retain that exact basis and derive physical size from the currently committed
 * Page Frame, preserving the existing Scene-to-physical scale.
 */
export function applyPageFrameEdit(
  history: EditHistory,
  pageFrame: PageFrame,
): EditHistory {
  const current = history.present;
  const generationAspect = studioGenerationAspect(current);
  const currentPageFrame =
    current.framing.kind === "framed"
      ? current.framing.pageFrame
      : fullCompositionPageFrame(resolveStudioCompositionFrame(current));
  const profile = derivePageFramePlotProfile(
    current.profile,
    currentPageFrame,
    pageFrame,
  );
  const framing: StudioFramingState = Object.freeze({
    kind: "framed",
    pageFrame: Object.freeze({ ...pageFrame }),
    generationAspect,
  });

  return commitEditState(history, { ...current, profile, framing });
}

/**
 * Restore full Composition at the current physical scale, then clear framing in
 * the same history commit. Unframed Reset is an exact no-op.
 */
export function resetPageFrame(history: EditHistory): EditHistory {
  const current = history.present;
  if (current.framing.kind === "unframed") return history;

  const fullComposition = fullCompositionPageFrame(
    resolveCompositionFrame(current.framing.generationAspect),
  );
  const profile = derivePageFramePlotProfile(
    current.profile,
    current.framing.pageFrame,
    fullComposition,
  );

  return commitEditState(history, { ...current, profile, framing: UNFRAMED });
}
