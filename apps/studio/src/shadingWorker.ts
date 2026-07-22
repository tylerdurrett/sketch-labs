/// <reference lib="webworker" />

import { handleShadingWorkerMessage } from "./shadingWorkerRuntime";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  void handleShadingWorkerMessage(
    event.data,
    undefined,
    (progress) => self.postMessage(progress),
  ).then((response) => {
    if (response !== null) self.postMessage(response);
  });
});

export {};
