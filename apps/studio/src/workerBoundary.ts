const MAX_WORKER_DETAIL_LENGTH = 500;

export interface WorkerPort<Request> {
  postMessage(message: Request): void;
  terminate(): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(
    type: "error" | "messageerror",
    listener: (event: Event) => void,
  ): void;
}

export type WorkerFactory<Request> = () => WorkerPort<Request>;

export type WorkerBoundaryFailureKind =
  | "construction"
  | "listener"
  | "post-message"
  | "worker-error"
  | "message-error"
  | "invalid-message"
  | "message-handler";

export interface WorkerBoundaryFailure {
  readonly kind: WorkerBoundaryFailureKind;
  readonly detail: string;
}

export type WorkerBoundaryOutcome<Completion> =
  | { readonly status: "completed"; readonly value: Completion }
  | { readonly status: "cancelled" }
  | {
      readonly status: "failure";
      readonly failure: WorkerBoundaryFailure;
    };

export interface WorkerBoundaryControls<Completion> {
  /**
   * Completes the transport session with a caller-owned domain value.
   * Returns false when the session has already settled.
   */
  complete(value: Completion): boolean;
  /**
   * Rejects a structurally invalid inbound message at the shared boundary.
   * Protocol validation itself remains the caller's responsibility.
   */
  rejectMessage(detail?: string): boolean;
  /**
   * Runs observational work without allowing it to own worker lifecycle.
   * The callback is skipped once the session has settled.
   */
  observe(observer: () => void): boolean;
}

export interface WorkerBoundaryOptions<Request, Completion> {
  readonly createWorker: WorkerFactory<Request>;
  readonly request: Request;
  readonly onMessage: (
    message: unknown,
    controls: WorkerBoundaryControls<Completion>,
  ) => void;
}

export interface WorkerBoundarySession<Completion> {
  readonly outcome: Promise<WorkerBoundaryOutcome<Completion>>;
  readonly active: boolean;
  cancel(): boolean;
  dispose(): void;
}

function boundedDetail(detail: unknown, fallback: string): string {
  return typeof detail === "string" && detail.trim() !== ""
    ? detail.slice(0, MAX_WORKER_DETAIL_LENGTH)
    : fallback;
}

export function workerErrorDetail(error: unknown, fallback: string): string {
  return boundedDetail(
    error instanceof Error ? error.message : undefined,
    fallback,
  );
}

export function workerEventDetail(event: Event, fallback: string): string {
  return boundedDetail(
    (event as Event & { message?: unknown }).message,
    fallback,
  );
}

export function terminateWorkerOnce(worker: { terminate(): void }): () => void {
  let terminated = false;
  return () => {
    if (terminated) return;
    terminated = true;
    worker.terminate();
  };
}

type OwnedListener =
  | {
      readonly type: "message";
      readonly listener: (event: MessageEvent<unknown>) => void;
    }
  | {
      readonly type: "error" | "messageerror";
      readonly listener: (event: Event) => void;
    };

interface RemovableWorkerListeners {
  removeEventListener(type: string, listener: EventListener): void;
}

const FAILURE_FALLBACKS: Readonly<Record<WorkerBoundaryFailureKind, string>> = {
  construction: "Worker construction failed",
  listener: "Worker listener registration failed",
  "post-message": "Worker request could not be posted",
  "worker-error": "Worker failed",
  "message-error": "Worker response could not be decoded",
  "invalid-message": "Worker returned an invalid response",
  "message-handler": "Worker message handler failed",
};

function failure(
  kind: WorkerBoundaryFailureKind,
  detail?: unknown,
): WorkerBoundaryFailure {
  const fallback = FAILURE_FALLBACKS[kind];
  return {
    kind,
    detail:
      detail instanceof Event
        ? workerEventDetail(detail, fallback)
        : detail instanceof Error
          ? workerErrorDetail(detail, fallback)
          : boundedDetail(detail, fallback),
  };
}

/**
 * Owns one worker's structural transport lifecycle.
 *
 * Domain coordinators remain responsible for job identity, protocol
 * validation, progress reduction, and result shapes. This boundary only owns
 * construction, listeners, posting, cancellation, and terminal cleanup.
 */
export function createWorkerBoundary<Request, Completion>(
  options: WorkerBoundaryOptions<Request, Completion>,
): WorkerBoundarySession<Completion> {
  let worker: WorkerPort<Request> | undefined;
  let terminateWorker: (() => void) | undefined;
  let settled = false;
  const listeners: OwnedListener[] = [];
  let resolveOutcome!: (outcome: WorkerBoundaryOutcome<Completion>) => void;
  const outcome = new Promise<WorkerBoundaryOutcome<Completion>>((resolve) => {
    resolveOutcome = resolve;
  });

  function removeOwnedListeners(): void {
    const removable = worker as
      | (WorkerPort<Request> & Partial<RemovableWorkerListeners>)
      | undefined;
    if (removable?.removeEventListener === undefined) return;
    for (const owned of listeners) {
      try {
        removable.removeEventListener(
          owned.type,
          owned.listener as EventListener,
        );
      } catch {
        // Listener cleanup and worker termination are both best-effort.
      }
    }
    listeners.length = 0;
  }

  function settle(next: WorkerBoundaryOutcome<Completion>): boolean {
    if (settled) return false;
    settled = true;
    removeOwnedListeners();
    try {
      terminateWorker?.();
    } catch {
      // A throwing terminate() cannot prevent the typed outcome from settling.
    }
    resolveOutcome(next);
    return true;
  }

  function fail(kind: WorkerBoundaryFailureKind, detail?: unknown): boolean {
    return settle({ status: "failure", failure: failure(kind, detail) });
  }

  const controls: WorkerBoundaryControls<Completion> = {
    complete(value) {
      return settle({ status: "completed", value });
    },
    rejectMessage(detail) {
      return fail("invalid-message", detail);
    },
    observe(observer) {
      if (settled) return false;
      try {
        observer();
      } catch {
        // Observation cannot fail or settle the transport session.
      }
      return true;
    },
  };

  const onMessage = (event: MessageEvent<unknown>): void => {
    if (settled) return;
    try {
      options.onMessage(event.data, controls);
    } catch (error) {
      fail("message-handler", error);
    }
  };
  const onError = (event: Event): void => {
    if (!settled) fail("worker-error", event);
  };
  const onMessageError = (event: Event): void => {
    if (!settled) fail("message-error", event);
  };

  try {
    worker = options.createWorker();
    terminateWorker = terminateWorkerOnce(worker);
  } catch (error) {
    fail("construction", error);
  }

  if (!settled && worker !== undefined) {
    try {
      listeners.push({ type: "message", listener: onMessage });
      worker.addEventListener("message", onMessage);
      if (!settled) {
        listeners.push({ type: "error", listener: onError });
        worker.addEventListener("error", onError);
      }
      if (!settled) {
        listeners.push({
          type: "messageerror",
          listener: onMessageError,
        });
        worker.addEventListener("messageerror", onMessageError);
      }
    } catch (error) {
      fail("listener", error);
    }
  }

  if (!settled && worker !== undefined) {
    try {
      worker.postMessage(options.request);
    } catch (error) {
      fail("post-message", error);
    }
  }

  return {
    outcome,
    get active() {
      return !settled;
    },
    cancel() {
      return settle({ status: "cancelled" });
    },
    dispose() {
      settle({ status: "cancelled" });
    },
  };
}
