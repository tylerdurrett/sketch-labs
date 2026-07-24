import {
  registry,
  type ParamSchema,
  type Params,
  type Scene,
  type SketchEnvironment,
  type StatelessSketch,
} from "@harness/core";

import {
  createFlowingContoursComputeIdentity,
  FLOWING_CONTOURS_COMPUTE_ERROR_MAX_LENGTH,
  FLOWING_CONTOURS_SKETCH_ID,
  flowingContoursComputeIdentitiesEqual,
  isFlowingContoursComputeRequest,
  isFlowingContoursComputeResponse,
  type FlowingContoursComputeIdentity,
  type FlowingContoursComputeResponse,
} from "./flowingContoursComputeProtocol";
import { resolveSketchEnvironment } from "./imageAssetResolver";

export type FlowingContoursSceneExecutor = (
  generate: StatelessSketch["generate"],
  identity: FlowingContoursComputeIdentity,
  params: Params,
  environment: SketchEnvironment,
) => Scene;

export type FlowingContoursEnvironmentResolver = (
  schema: ParamSchema,
  params: Params,
) => Promise<SketchEnvironment>;

function paramsFromIdentity(identity: FlowingContoursComputeIdentity): Params {
  const params = Object.create(null) as Params;
  for (const entry of identity.params) params[entry.key] = entry.value;
  return params;
}

function schemaMismatch(): TypeError {
  return new TypeError(
    `Flowing Contours request parameters do not match ${FLOWING_CONTOURS_SKETCH_ID} schema`,
  );
}

interface ResolvedRequest {
  readonly generate: StatelessSketch["generate"];
  readonly schema: ParamSchema;
  readonly params: Params;
}

function resolveRequest(
  identity: FlowingContoursComputeIdentity,
): ResolvedRequest {
  // Registry lookup is deliberately strict. The caller may opt in only by the
  // exact stable id, and this worker independently resolves the canonical
  // registered Sketch instead of trusting a main-thread function reference.
  const sketch = registry.get(identity.sketchId);
  if (sketch.id !== FLOWING_CONTOURS_SKETCH_ID) throw schemaMismatch();

  const params = paramsFromIdentity(identity);
  let canonical: FlowingContoursComputeIdentity;
  try {
    canonical = createFlowingContoursComputeIdentity({
      sketchId: sketch.id,
      schema: sketch.schema,
      params,
      seed: identity.seed,
      compositionFrame: identity.compositionFrame,
    });
  } catch {
    throw schemaMismatch();
  }
  if (!flowingContoursComputeIdentitiesEqual(identity, canonical)) {
    throw schemaMismatch();
  }
  return { generate: sketch.generate, schema: sketch.schema, params };
}

export const executeFlowingContoursScene: FlowingContoursSceneExecutor = (
  generate,
  identity,
  params,
  environment,
) =>
  generate(
    params,
    identity.seed,
    0,
    {
      width: identity.compositionFrame.width,
      height: identity.compositionFrame.height,
    },
    environment,
  );

function safeError(error: unknown): string {
  if (error instanceof Error) {
    try {
      const detail = error.message.trim();
      if (detail !== "") {
        return detail.slice(0, FLOWING_CONTOURS_COMPUTE_ERROR_MAX_LENGTH);
      }
    } catch {
      // Fall through to stable boundary text.
    }
  }
  return "Flowing Contours computation failed";
}

function elapsed(startedAt: number, completedAt: number): number {
  const duration = completedAt - startedAt;
  return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

/**
 * Execute one identity-only request. Fetch and decode happen independently in
 * this worker environment; no pixel storage joins the protocol.
 */
export async function handleFlowingContoursWorkerMessage(
  value: unknown,
  execute: FlowingContoursSceneExecutor = executeFlowingContoursScene,
  now: () => number = () => performance.now(),
  resolveEnvironment: FlowingContoursEnvironmentResolver = (schema, params) =>
    resolveSketchEnvironment(schema, params),
): Promise<FlowingContoursComputeResponse | null> {
  if (!isFlowingContoursComputeRequest(value)) return null;

  try {
    const { generate, schema, params } = resolveRequest(value.identity);
    const environment = await resolveEnvironment(schema, params);
    const startedAt = now();
    const scene = execute(generate, value.identity, params, environment);
    const response: FlowingContoursComputeResponse = {
      type: "success",
      jobId: value.jobId,
      identity: value.identity,
      scene,
      computeTimeMs: elapsed(startedAt, now()),
    };
    if (!isFlowingContoursComputeResponse(response)) {
      throw new TypeError("Flowing Contours worker produced an invalid Scene");
    }
    return response;
  } catch (error) {
    const failure: FlowingContoursComputeResponse = {
      type: "failure",
      jobId: value.jobId,
      identity: value.identity,
      error: safeError(error),
    };
    if (!isFlowingContoursComputeResponse(failure)) {
      throw new TypeError(
        "Flowing Contours worker produced an invalid failure",
      );
    }
    return failure;
  }
}
