/** Construct the dedicated module Worker for Flowing Contours Scene generation. */
export function createFlowingContoursWorker(): Worker {
  return new Worker(new URL("./flowingContoursWorker.ts", import.meta.url), {
    type: "module",
  });
}
