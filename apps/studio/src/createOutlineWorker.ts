export function createOutlineWorker(): Worker {
  return new Worker(new URL("./outlineWorker.ts", import.meta.url), {
    type: "module",
  });
}
