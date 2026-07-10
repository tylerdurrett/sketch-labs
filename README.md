# Sketch Labs

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

## Leaf Field performance benchmark

Run the pinned Leaf Field feedback loop with the package-local Vitest binary:

```sh
packages/core/node_modules/.bin/vitest run --config packages/core/vitest.leaf-field-benchmark.config.ts
```

Or, from an environment where workspace scripts are allowed:

```sh
pnpm --filter @harness/core benchmark:leaf-field
```

It reports median and p95 timings for fixed-time cold/full generation through
`generate`, warm varying-time generation, Canvas-port submission, and the warm
whole frame. Here "cold/full" means each frame has no caller-owned prepared
state; the timing loop is still JIT-warmed to reduce startup noise. Until a
Sketch provides the optional `prepare(params, seed) → (t) → Scene` fast path,
the warm line clearly reports that it is using the `generate` fallback.

The seed, params, scene counts, and a full-geometry checksum are pinned so an
apparent speedup cannot silently omit work. `LEAF_BENCH_SAMPLES` (minimum 20,
default 30) and `LEAF_BENCH_WARMUPS` (default 5) tune run length.

The Canvas number measures traversal and submission through the injected
`Canvas2DContext` port using a counting context. It does not include a browser's
rasterization, compositor, or GPU flush; use a browser profile for those costs.

## Layout

- `packages/core` — headless engine, Scene IR, renderers, Sketches
- `packages/video` — Remotion compositions
- `apps/studio` — React studio shell
