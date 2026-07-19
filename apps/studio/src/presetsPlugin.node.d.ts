/**
 * Minimal ambient declarations for the slice of `node:fs/promises` the preset
 * middleware uses. The repo's supply-chain lockdown deliberately keeps
 * `@types/node` out (see AGENTS.md / docs/agents/locked-down-npm.md), so the
 * bare `node:fs/promises` import has no type declarations and `tsc --noEmit`
 * would otherwise fail with TS2307. Declaring only the functions we call
 * keeps the plugin source node-free for typechecking without pulling in the
 * whole Node type surface. Paths are built as strings (no `node:path`) the same
 * way `vite.config.ts` resolves `sketchesRoot` via the WHATWG `URL`.
 */
declare module "node:fs/promises" {
  export function lstat(path: string): Promise<{
    isSymbolicLink(): boolean;
    isFile(): boolean;
  }>;
  export function readdir(path: string): Promise<string[]>;
  export function realpath(path: string): Promise<string>;
  export function readFile(path: string): Promise<Uint8Array>;
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
  export function writeFile(path: string, data: Uint8Array): Promise<void>;
  export function writeFile(
    path: string,
    data: Uint8Array,
    options: { flag: "wx" },
  ): Promise<void>;
  // Used only by the tests, to stage and tear down a temp sketchesRoot.
  export function mkdtemp(prefix: string): Promise<string>;
  export function rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
  export function symlink(
    target: string,
    path: string,
    type: "file",
  ): Promise<void>;
}

declare module "node:os" {
  export function tmpdir(): string;
}
