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
