/**
 * @deprecated Temporary bridge for untouched SketchControls wiring. Remove in
 * block G when export readiness uses strategy-neutral Shading names.
 */
export {
  acknowledgedCurrentShading as acknowledgedCurrentScribble,
  isAcknowledgedCurrentShading as isAcknowledgedCurrentScribble,
} from "./shadingExportReadiness";
export type {
  ShadingPaintAcknowledgement as ScribblePaintAcknowledgement,
} from "./shadingExportReadiness";
