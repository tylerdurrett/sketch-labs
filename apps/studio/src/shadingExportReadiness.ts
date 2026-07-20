import type { DisplayedSceneSnapshot } from "./LiveCanvas";
import {
  selectExportableShadingResult,
  type DisplayedShadingResult,
  type ShadingSessionState,
} from "./shadingSession";

/** The exact supplied Scene revision LiveCanvas has acknowledged painting. */
export interface ShadingPaintAcknowledgement {
  readonly sourceInputRevision: number;
  readonly contentRevision: number;
}

/**
 * Return the worker result only when session truth and visible canvas truth agree.
 *
 * The session selector proves the displayed worker identity is the settled desired
 * identity at the current authored-input revision. The acknowledgement proves
 * LiveCanvas committed that result, while the fresh snapshot prevents a stale
 * canvas (including a same-batch programmatic export) from passing the guard.
 */
export function acknowledgedCurrentShading(
  session: ShadingSessionState,
  acknowledgement: ShadingPaintAcknowledgement | null,
  displayed: DisplayedSceneSnapshot | null,
): DisplayedShadingResult | null {
  const current = selectExportableShadingResult(session);
  if (
    current === null ||
    acknowledgement?.sourceInputRevision !== current.sourceInputRevision ||
    acknowledgement?.contentRevision !== current.contentRevision ||
    displayed?.sourceInputRevision !== current.sourceInputRevision ||
    displayed?.contentRevision !== current.contentRevision
  ) {
    return null;
  }
  return current;
}

export function isAcknowledgedCurrentShading(
  session: ShadingSessionState,
  acknowledgement: ShadingPaintAcknowledgement | null,
  displayed: DisplayedSceneSnapshot | null,
): boolean {
  return (
    acknowledgedCurrentShading(session, acknowledgement, displayed) !== null
  );
}
