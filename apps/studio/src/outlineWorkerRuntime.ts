import {
  isOutlineComputeRequest,
  mutableScene,
  type OutlineComputeFailure,
  type OutlineComputeResponse,
} from "./outlineComputeProtocol";
import { outlineScene } from "./outlineScene";

function safeError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message.slice(0, 500);
  }
  return "Outline computation failed";
}

export function handleOutlineWorkerMessage(
  value: unknown,
  derive: typeof outlineScene = outlineScene,
): OutlineComputeResponse | null {
  if (!isOutlineComputeRequest(value)) return null;
  try {
    return {
      type: "success",
      jobId: value.jobId,
      identity: value.identity,
      scene: derive(
        mutableScene(value.identity.sourceScene),
        value.identity.tolerance,
        value.identity.includeFrame,
      ),
    };
  } catch (error) {
    const failure: OutlineComputeFailure = {
      type: "failure",
      jobId: value.jobId,
      identity: value.identity,
      error: safeError(error),
    };
    return failure;
  }
}
