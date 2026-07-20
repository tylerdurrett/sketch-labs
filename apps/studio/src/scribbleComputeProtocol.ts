/**
 * @deprecated Temporary compatibility surface for the remaining preparation
 * lifecycle blocks. Remove once session, coordinator, hook, and Studio wiring
 * consume `shadingComputeProtocol` directly.
 */
export {
  copyShadingComputeIdentity as copyScribbleComputeIdentity,
  createShadingComputeIdentity as createScribbleComputeIdentity,
  isShadingComputeFailure as isScribbleComputeFailure,
  isShadingComputeIdentity as isScribbleComputeIdentity,
  isShadingComputeProgress as isScribbleComputeProgress,
  isShadingComputeRequest as isScribbleComputeRequest,
  isShadingComputeResponse as isScribbleComputeResponse,
  isShadingComputeSuccess as isScribbleComputeSuccess,
  isShadingWorkerMessage as isScribbleWorkerMessage,
  shadingComputeIdentitiesEqual as scribbleComputeIdentitiesEqual,
} from "./shadingComputeProtocol";
export type {
  CreateShadingComputeIdentityInput as CreateScribbleComputeIdentityInput,
  ShadingComputeFailure as ScribbleComputeFailure,
  ShadingComputeIdentity as ScribbleComputeIdentity,
  ShadingComputeProgress as ScribbleComputeProgress,
  ShadingComputeRequest as ScribbleComputeRequest,
  ShadingComputeResponse as ScribbleComputeResponse,
  ShadingComputeSuccess as ScribbleComputeSuccess,
  ShadingParamEntry as ScribbleParamEntry,
  ShadingParamValue as ScribbleParamValue,
  ShadingWorkerMessage as ScribbleWorkerMessage,
} from "./shadingComputeProtocol";
