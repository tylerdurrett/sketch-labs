import {
  isOutlineComputeRequest,
  mutableScene,
  type OutlineComputeFailure,
  type OutlineComputeProgress,
  type OutlineComputeResponse,
} from "./outlineComputeProtocol";
import { outlineScene } from "./outlineScene";

/**
 * Caps ordinary progress traffic at ten messages per second. The first useful
 * snapshot and terminal snapshot bypass the interval, so a job emits at most
 * one initial message, one message per elapsed interval, and one terminal.
 */
const PROGRESS_INTERVAL_MS = 100;

type ProgressSink = (progress: OutlineComputeProgress) => void;
type MonotonicClock = () => number;

function systemMonotonicClock(): number {
  return performance.now();
}

function createProgressReporter(
  jobId: number,
  emit: ProgressSink,
  now: MonotonicClock,
) {
  let hasEmitted = false;
  let lastEmittedAt = 0;

  return (snapshot: OutlineComputeProgress["snapshot"]): void => {
    if (snapshot.terminal) {
      emit({ type: "progress", jobId, snapshot });
      return;
    }

    const observedAt = now();
    if (hasEmitted && observedAt - lastEmittedAt < PROGRESS_INTERVAL_MS) {
      return;
    }
    hasEmitted = true;
    lastEmittedAt = observedAt;
    emit({ type: "progress", jobId, snapshot });
  };
}

function safeError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message.slice(0, 500);
  }
  return "Outline computation failed";
}

export function handleOutlineWorkerMessage(
  value: unknown,
  derive: typeof outlineScene = outlineScene,
  emitProgress?: ProgressSink,
  now: MonotonicClock = systemMonotonicClock,
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
        emitProgress === undefined
          ? undefined
          : createProgressReporter(value.jobId, emitProgress, now),
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
