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

## Stippling relaxation performance benchmark

The opt-in smoke campaign measures placement, Distribution refinement, Voronoi
assignment/centroids, safe relocation, geometry materialization, and end-to-end
Shading preparation:

```sh
pnpm --filter @harness/core benchmark:stippling-relaxation
```

The explicit 27-case campaign, filtering/sharding flags, raw evidence format,
and resumable aggregator are documented in
[`packages/core/benchmarks/stippling-relaxation/README.md`](packages/core/benchmarks/stippling-relaxation/README.md).

## Grass Hills density baseline

Run the opt-in smoke benchmark for the historical maximum-density Grass Hills
scene with the package-local Vitest binary:

```sh
packages/core/node_modules/.bin/vitest run --config packages/core/vitest.grass-hills-density-benchmark.config.ts
```

Or, from an environment where workspace scripts are allowed:

```sh
pnpm --filter @harness/core benchmark:grass-hills-density
```

The literal manifest pins each fixture's seed, time, Composition Frame, complete
parameter set, plot profile, and pen geometry. The baseline asserts 10 hills,
400 blades, 410 Scene primitives, 14,540 source
points, and the literal fixture's reproducible 11,584,278 deterministic
Hidden-line work units. The initial runner is smoke-only: it executes cold
generation and Hidden-line processing once and prints diagnostic local timings,
rather than claiming statistically meaningful performance results.

The benchmark-local campaign subprocess protocol is documented in
[`packages/core/benchmarks/grass-hills-density/README.md`](packages/core/benchmarks/grass-hills-density/README.md).
Its generic CLI is also smoke-only by default; screen/full/adopted modes require
explicit flags, and long finalist/adopted campaigns require an additional
confirmation flag. The same directory documents the 5k–50k request manifest,
reusable structural/export collectors, and explicit checksum-pinned real-browser
Canvas seam. The same record now includes the completed candidate campaigns,
architecture decision, and production Studio acceptance evidence from issue
#305.

The original measurement machine observed approximately 248 ms cold generation
and approximately 44 ms Hidden-line processing. Those timings are historical
observations, not budgets or SLAs. The durable record and protocol notes live in
[`packages/core/benchmarks/grass-hills-density-results.md`](packages/core/benchmarks/grass-hills-density-results.md),
including the issue body's unreproducible 11,372,294-work-unit observation and
the evidence-based distinction from the executable fixture.

## Layout

- `packages/core` — headless engine, Scene IR, renderers, Sketches
- `packages/video` — Remotion compositions
- `apps/studio` — React studio shell
