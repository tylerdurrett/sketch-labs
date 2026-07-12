/// <reference lib="webworker" />

import { handleOutlineWorkerMessage } from "./outlineWorkerRuntime";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const response = handleOutlineWorkerMessage(event.data);
  if (response !== null) self.postMessage(response);
});

export {};
