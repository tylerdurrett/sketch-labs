/// <reference lib="webworker" />

import { handleScribbleWorkerMessage } from "./scribbleWorkerRuntime";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const response = handleScribbleWorkerMessage(
    event.data,
    undefined,
    (progress) => self.postMessage(progress),
  );
  if (response !== null) self.postMessage(response);
});

export {};
