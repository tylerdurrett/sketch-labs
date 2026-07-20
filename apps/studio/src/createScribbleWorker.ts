import { createShadingWorker } from "./createShadingWorker";

/**
 * @deprecated Temporary bridge for `useScribblePreparation`; remove when that
 * hook migrates to the strategy-neutral Shading lifecycle.
 */
export const createScribbleWorker = createShadingWorker;
