/** Construct the dedicated module Worker Vite bundles for Scribble preparation. */
export function createScribbleWorker(): Worker {
  return new Worker(new URL("./scribbleWorker.ts", import.meta.url), {
    type: "module",
  });
}
