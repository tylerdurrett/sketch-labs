import type { DisplayedSceneSnapshot } from "./LiveCanvas";
import {
  selectCurrentFlowingContoursResult,
  type DisplayedFlowingContoursResult,
  type FlowingContoursSessionState,
} from "./flowingContoursSession";

export interface FlowingContoursPaintAcknowledgement {
  readonly sourceInputRevision: number;
  readonly contentRevision: number;
}

/** Require current authored identity, completed paint, and fresh canvas truth. */
export function acknowledgedCurrentFlowingContours(
  session: FlowingContoursSessionState,
  acknowledgement: FlowingContoursPaintAcknowledgement | null,
  displayed: DisplayedSceneSnapshot | null,
): DisplayedFlowingContoursResult | null {
  const current = selectCurrentFlowingContoursResult(session);
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
