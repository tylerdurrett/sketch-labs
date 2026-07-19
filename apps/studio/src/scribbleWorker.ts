/// <reference lib="webworker" />

import { handleScribbleWorkerMessage } from "./scribbleWorkerRuntime";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  void handleScribbleWorkerMessage(
    event.data,
    undefined,
    (progress) => self.postMessage(progress),
  ).then((response) => {
    if (response !== null) self.postMessage(response);
  });
});

export {};
