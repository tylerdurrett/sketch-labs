import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { imageAssetsPlugin } from "./src/imageAssetsPlugin";
import { presetsPlugin, sketchesStaticPlugin } from "./src/presetsPlugin";

/**
 * Resolve a path relative to THIS config file into an absolute filesystem path,
 * without `node:url`/`node:path` (kept out by the supply-chain lockdown, so no
 * `@types/node` either). On Windows `URL.pathname` is the broken `/C:/…` form;
 * strip the leading slash when a drive letter follows so the path is correct
 * cross-platform. On POSIX the drive-letter branch never matches, so the result
 * is unchanged.
 */
function resolveFromHere(relativePath: string): string {
  const pathname = decodeURIComponent(
    new URL(relativePath, import.meta.url).pathname,
  );
  return /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname;
}

/**
 * Absolute path to the folder that holds every Sketch (one folder per Sketch,
 * each colocating its code and `presets/` per ADR-0006). This is the single knob
 * the Presets slice's write middleware and dev static-serve mapping will resolve
 * against, so pointing it elsewhere relocates sketches out of the harness without
 * touching anything else. Layout/knob only here — no middleware or static serving
 * is wired up yet (later tasks in slice #8).
 *
 * Resolved relative to THIS config file (`import.meta.url`), never the process
 * CWD, so it stays correct however Vite is launched. The WHATWG `URL` resolver
 * (rather than `node:path`/`node:url`) keeps `@types/node` out per the repo's
 * supply-chain lockdown; `resolveFromHere` makes it Windows-safe.
 */
export const sketchesRoot = resolveFromHere(
  "../../packages/core/src/sketches",
);

/**
 * Absolute path to the committed project-managed PNG assets. Like
 * `sketchesRoot`, this is resolved from the config rather than the launch CWD,
 * so repointing the repo-relative knob relocates the backing store without
 * changing its logical browser URL.
 */
export const imageAssetsRoot = resolveFromHere("../../assets/image-assets");

/**
 * The pnpm workspace root (this config lives at `<root>/apps/studio/`). Added to
 * `server.fs.allow` so Vite is permitted to serve files under `sketchesRoot`,
 * which sits outside the studio's own root in `packages/core` (ADR-0006).
 */
const workspaceRoot = resolveFromHere("../..");

export default defineConfig({
  plugins: [
    react(),
    // Tailwind v4's Vite plugin: scans the app for utility classes and compiles
    // the CSS entry (src/index.css) via its prebuilt oxide binary (ADR-0008). No
    // config knobs — v4 is CSS-first, driven entirely from the stylesheet.
    tailwindcss(),
    // Dev-only preset write + list middleware, and the read-one static-serve
    // mapping that exposes sketchesRoot at /sketches/ (ADR-0006). Both resolve
    // against the single sketchesRoot knob above.
    presetsPlugin(sketchesRoot),
    sketchesStaticPlugin(sketchesRoot),
    // Read-only, exact-ID static serving for committed Image Assets.
    imageAssetsPlugin(imageAssetsRoot),
  ],
  server: {
    fs: {
      // Allow serving sketch/preset files from packages/core, outside the
      // studio's own Vite root.
      allow: [workspaceRoot],
    },
  },
});
