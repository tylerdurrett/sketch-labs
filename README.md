# Experiments Harness

A browser studio for generative-graphics **Sketches** — parametric, seedable scenes
previewed live and exported through multiple backends. See [CONTEXT.md](CONTEXT.md).

## Prerequisites

- Node >= 20
- pnpm 11 (`corepack enable`)

## Setup

```sh
pnpm install
```

> npm/pnpm is deliberately locked down. A fresh install may exit 1 on
> `ERR_PNPM_IGNORED_BUILDS` (esbuild) — expected and benign. Run the toolchain via
> package-local binaries (`.../node_modules/.bin/...`), not `pnpm run`.
> See [docs/agents/locked-down-npm.md](docs/agents/locked-down-npm.md).

## Run the studio

```sh
pnpm dev
```

Or launch the binary directly:

```sh
cd apps/studio && node_modules/.bin/vite
```

Open the printed URL (default http://localhost:5173) to watch the `circles` Sketch
render live.

> `pnpm dev` is a root convenience script (like `pnpm test` / `pnpm typecheck`). The
> "package-local binaries, not `pnpm run`" note above is about the typecheck/test/build
> toolchain, where the benign `ERR_PNPM_IGNORED_BUILDS` exit-1 otherwise gets chased — a
> dev-server launch never hits it.

## Tests

```sh
packages/core/node_modules/.bin/vitest run    # headless engine
```

## Layout

- `packages/core` — headless engine, Scene IR, renderers, Sketches
- `packages/video` — Remotion compositions
- `apps/studio` — React studio shell
