/// <reference lib="webworker" />

import {
  handleHiddenLineWorkerMessage,
  handleOutlineWorkerMessage,
} from "./outlineWorkerRuntime";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const response = handleHiddenLineWorkerMessage(
    event.data,
    {},
    (message) => self.postMessage(message),
  ) ??
    handleOutlineWorkerMessage(
      event.data,
      undefined,
      (progress) => self.postMessage(progress),
    );
  if (response !== null) self.postMessage(response);
});

export {};
