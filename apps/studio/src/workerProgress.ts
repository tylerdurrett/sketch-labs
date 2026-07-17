const PROGRESS_INTERVAL_MS = 100;

export type MonotonicClock = () => number;

/**
 * Limit ordinary worker progress traffic while preserving the snapshots that
 * establish and complete a job's progress lifecycle.
 */
export function createWorkerProgressEmitter<
  Snapshot extends { readonly terminal: boolean },
>(
  emit: (snapshot: Snapshot) => void,
  now: MonotonicClock,
): (snapshot: Snapshot) => void {
  let hasEmitted = false;
  let lastEmittedAt = 0;

  return (snapshot) => {
    if (snapshot.terminal) {
      emit(snapshot);
      return;
    }

    const observedAt = now();
    if (hasEmitted && observedAt - lastEmittedAt < PROGRESS_INTERVAL_MS) {
      return;
    }
    hasEmitted = true;
    lastEmittedAt = observedAt;
    emit(snapshot);
  };
}
