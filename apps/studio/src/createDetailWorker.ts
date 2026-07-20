/** Construct the dedicated module Worker for reusable Detail preparation. */
export function createDetailWorker(): Worker {
  return new Worker(new URL("./detailWorker.ts", import.meta.url), {
    type: "module",
  });
}
