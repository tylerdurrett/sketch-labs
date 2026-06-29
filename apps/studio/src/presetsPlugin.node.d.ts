/**
 * Minimal ambient declarations for the slice of `node:fs/promises` the preset
 * middleware uses. The repo's supply-chain lockdown deliberately keeps
 * `@types/node` out (see AGENTS.md / docs/agents/locked-down-npm.md), so the
 * bare `node:fs/promises` import has no type declarations and `tsc --noEmit`
 * would otherwise fail with TS2307. Declaring only the three functions we call
 * keeps the plugin source node-free for typechecking without pulling in the
 * whole Node type surface. Paths are built as strings (no `node:path`) the same
 * way `vite.config.ts` resolves `sketchesRoot` via the WHATWG `URL`.
 */
declare module "node:fs/promises" {
  export function readdir(path: string): Promise<string[]>;
  export function readFile(path: string, encoding: "utf-8"): Promise<string>;
  export function mkdir(
    path: string,
    options: { recursive: boolean },
  ): Promise<string | undefined>;
  export function writeFile(
    path: string,
    data: string,
    encoding: "utf-8",
  ): Promise<void>;
}
