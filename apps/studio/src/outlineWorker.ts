/// <reference lib="webworker" />

import { handleOutlineWorkerMessage } from "./outlineWorkerRuntime";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const response = handleOutlineWorkerMessage(
    event.data,
    undefined,
    (progress) => {
      self.postMessage(progress);
    },
  );
  if (response !== null) self.postMessage(response);
});

export {};
