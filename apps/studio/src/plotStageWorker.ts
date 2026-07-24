/// <reference lib="webworker" />

import { handlePlotStageWorkerMessage } from "./plotStageWorkerRuntime";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  void handlePlotStageWorkerMessage(event.data).then((response) => {
    if (response !== null) self.postMessage(response);
  });
});

export {};
