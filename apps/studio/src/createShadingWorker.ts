/** Construct the dedicated module Worker Vite bundles for Shading preparation. */
export function createShadingWorker(): Worker {
  return new Worker(new URL("./shadingWorker.ts", import.meta.url), {
    type: "module",
  });
}
