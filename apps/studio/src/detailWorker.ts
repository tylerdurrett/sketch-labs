/// <reference lib="webworker" />

import { handleDetailWorkerMessage } from "./detailWorkerRuntime";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  void handleDetailWorkerMessage(event.data).then((response) => {
    if (response === null) return;
    if (response.type === "success") {
      self.postMessage(response, [response.prepared.data.buffer]);
      return;
    }
    self.postMessage(response);
  });
});

export {};
