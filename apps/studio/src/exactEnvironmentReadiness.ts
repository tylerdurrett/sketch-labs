import type { ParamSchema, Params } from "@harness/core";

import {
  imageAssetIdSetKey,
  requiredImageAssetIds,
} from "./imageAssetResolver";
import type { UseSketchEnvironmentResult } from "./useSketchEnvironment";

type EnvironmentReadiness = Pick<
  UseSketchEnvironmentResult,
  "status" | "ready" | "resolutionKey"
>;

/** Whether resolution belongs to the exact Image Asset IDs authored right now. */
export function exactEnvironmentReady(
  schema: ParamSchema,
  params: Params,
  resolution: EnvironmentReadiness,
): boolean {
  return (
    resolution.status === "resolved" &&
    resolution.ready &&
    resolution.resolutionKey ===
      imageAssetIdSetKey(requiredImageAssetIds(schema, params))
  );
}
