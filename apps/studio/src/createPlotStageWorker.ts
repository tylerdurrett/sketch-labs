import type { PlotStagePreparationRequest } from "./plotStagePreparationProtocol";
import type { WorkerFactory, WorkerPort } from "./workerBoundary";

export type PlotStageWorkerPort = WorkerPort<PlotStagePreparationRequest>;
export type PlotStageWorkerFactory = WorkerFactory<PlotStagePreparationRequest>;

/** Construct the dedicated module Worker for supporting Plot Stage preparation. */
export function createPlotStageWorker(): PlotStageWorkerPort {
  return new Worker(new URL("./plotStageWorker.ts", import.meta.url), {
    type: "module",
  });
}
