import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { presetsPlugin, sketchesStaticPlugin } from "./src/presetsPlugin";

/**
 * Absolute path to the folder that holds every Sketch (one folder per Sketch,
 * each colocating its code and `presets/` per ADR-0006). This is the single knob
 * the Presets slice's write middleware and dev static-serve mapping will resolve
 * against, so pointing it elsewhere relocates sketches out of the harness without
 * touching anything else. Layout/knob only here — no middleware or static serving
 * is wired up yet (later tasks in slice #8).
 *
 * Resolved relative to THIS config file (`import.meta.url`), never the process
 * CWD, so it stays correct however Vite is launched. Uses the standard WHATWG
 * `URL` resolver rather than `node:path`/`node:url` so it needs no `@types/node`
 * (the repo's supply-chain lockdown keeps that dependency out).
 */
export const sketchesRoot = decodeURIComponent(
  new URL("../../packages/core/src/sketches", import.meta.url).pathname,
);

/**
 * The pnpm workspace root (this config lives at `<root>/apps/studio/`). Added to
 * `server.fs.allow` so Vite is permitted to serve files under `sketchesRoot`,
 * which sits outside the studio's own root in `packages/core` (ADR-0006).
 */
const workspaceRoot = decodeURIComponent(
  new URL("../..", import.meta.url).pathname,
);

export default defineConfig({
  plugins: [
    react(),
    // Dev-only preset write + list middleware, and the read-one static-serve
    // mapping that exposes sketchesRoot at /sketches/ (ADR-0006). Both resolve
    // against the single sketchesRoot knob above.
    presetsPlugin(sketchesRoot),
    sketchesStaticPlugin(sketchesRoot),
  ],
  server: {
    fs: {
      // Allow serving sketch/preset files from packages/core, outside the
      // studio's own Vite root.
      allow: [workspaceRoot],
    },
  },
});
