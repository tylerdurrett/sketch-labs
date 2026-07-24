/// <reference lib="webworker" />

import { handleFlowingContoursWorkerMessage } from "./flowingContoursWorkerRuntime";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  void handleFlowingContoursWorkerMessage(event.data).then((response) => {
    if (response !== null) self.postMessage(response);
  });
});

export {};
