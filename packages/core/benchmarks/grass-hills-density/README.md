# Grass Hills density campaign protocol

This directory owns the isolated benchmark infrastructure for issue #305: the
subprocess protocol, literal workload manifest, reusable metric collectors, and
an explicit browser profiling seam. It contains no dense-grass candidate
algorithm or production Studio instrumentation.

Every candidate × fixture pair runs in a fresh Node child. The parent runs jobs
serially, applies a wall-clock deadline, polls RSS against the mode's hard
ceiling, and also starts V8 with a smaller old-space allowance. A timeout,
observed RSS breach, V8 out-of-memory termination, candidate exception, or
invalid child response produces a `status: "censored"` result instead of
hanging or dropping the job.

## Modes

| Mode | Per-child deadline | Per-child RSS ceiling | Measured samples (prepare / cold / warm) |
| --- | ---: | ---: | ---: |
| `smoke` (default) | 30 s | 1 GiB | 1 / 1 / 1 |
| `screen` | 90 s | 1 GiB | 3 / 3 / 12 |
| `full` | 600 s | 2 GiB | 20 / 20 / 60 |
| `adopted` | 600 s | 2 GiB | 20 / 20 / 60 |

The sample plans are protocol constants, not CLI knobs. `full` and `adopted`
also require `--confirm-long-campaign`, so neither the default config nor an
accidental script invocation can start a long campaign. The legacy quadratic
candidate descriptor is rejected for every fixture except a `baseline` or
`tiny` control.

## M2b candidate/config seam

A future config module exports a non-empty `jobs` array. Each job has this
JSON-serializable shape:

```js
export const jobs = [{
  candidate: {
    id: 'stable-candidate-id',
    moduleUrl: new URL('./candidate.js', import.meta.url).href,
    complexity: 'linear', // or 'legacy-quadratic'
  },
  fixture: {
    id: 'stable-fixture-id',
    scale: 'baseline', // or 'tiny' / 'dense'
    payload: { /* candidate-owned, JSON-serializable fixture data */ },
  },
}]
```

The candidate module exports `benchmarkCandidate` (or a default value):

```js
export const benchmarkCandidate = {
  id: 'stable-candidate-id',
  complexity: 'linear',
  prepare(payload) { return (t) => samplePreparedFrame(payload, t) },
  generate(payload, t) { return generateColdFrame(payload, t) },
  guard(result) { return finiteNonZeroWorkGuard(result) },
  inspect({ phase, value, payload }) { return collectEvidence(value, payload) },
}
```

`prepare` must return a callable varying-time sampler. `guard` must return a
finite, non-zero number so a candidate cannot benchmark omitted work. The runner
does not interpret candidate results or fixture payloads. `inspect` is optional;
the worker calls it once for the first measured value in each phase and records
its return value as `sample.metrics`. Inspection is outside the operation timer
and memory snapshots, so export evidence cannot inflate prep/cold/warm
measurements. For preparation, `value` is the retained sampler; for cold/warm it
is the generated value.

Invoke the generic CLI with the package directory as the current directory:

```sh
node benchmarks/grass-hills-density/cli.js --config=./candidate-config.js
node benchmarks/grass-hills-density/cli.js --mode=screen --config=./candidate-config.js
node benchmarks/grass-hills-density/cli.js --mode=full --confirm-long-campaign --config=./candidate-config.js
```

## Timing and memory contract

Protocol version 1 reports three disjoint phase slots:

- `preparation`: construction of `prepare(payload)` only. Sampling is excluded.
- `cold`: the complete `generate(payload, 0)` call with no retained preparation.
- `warm`: calls to one retained prepared sampler at a deterministic varying `t`.
  Its construction is excluded.

Warmups are unreported. Before every measured sample the child runs an explicit
full GC (`--expose-gc`), then captures `heapUsed`, RSS, and process-lifetime
`maxRSS`. The timer surrounds only the candidate operation. A second memory
snapshot is taken immediately after the operation and before another GC. Sizes
are bytes; Node's KiB `resourceUsage().maxRSS` value is multiplied by 1,024.
Each sample records before/after snapshots plus signed heap/RSS/maxRSS deltas.
`maxRSS` is a process-lifetime high-water mark, so its delta means “this sample
set a new child-process high-water mark,” not an isolated per-phase peak.

## Literal workload manifest and collectors

[`fixtures.js`](fixtures.js) pins six requests: the historical 10-hill/400-blade
baseline, one-hill 5k and 10k targets, and full-composition 10k, 25k, and 50k
targets. Every request repeats the seed, frame, time, complete Grass Hills param
set, and physical profile. The 200 × 200 mm paper with 10 mm insets supplies a
180 × 180 mm drawable region: 0.18 mm per Scene unit. A 0.30 mm fineliner is
therefore 1.6666666666666667 Scene units. Requested counts are evidence targets,
not claims about the current implementation.

[`metrics.js`](metrics.js) collects source/outline/clipped primitive and point
counts, SHA-256 checksums, serialized and geometry byte sizes, Hidden-line
workload/time, bounds clipping, ordinary SVG and plotter SVG time/bytes/path
counts, and nearest root/path-start spacing percentiles in physical millimeters.
Its Canvas metric invokes core's actual `drawSceneFitted` through a counting
port; the result is explicitly structural JS submission only and excludes
rasterization, compositor, and GPU completion. Heap/RSS comes from the protocol
worker. Both the worker and collector capture machine/runtime metadata.

## Explicit browser seam

The benchmark-local Vite page loads checksum-pinned serialized fill and Outline
Scene JSON and passes either Scene to core's actual `drawSceneFitted` on a real
browser Canvas2D context. Start it explicitly from the repository root:

```sh
apps/studio/node_modules/.bin/vite --config packages/core/benchmarks/grass-hills-density/browser/vite.config.js
```

Nothing starts it from normal tests, package scripts, or Studio. In Chrome
DevTools, use `__GRASS_HILLS_DENSITY_BENCHMARK__.draw('fill')`,
`.draw('outline')`, or `.drawMany({ kind: 'fill', iterations: 30 })` as stable
profiling hooks. These submission durations are not raster/compositor evidence;
Chrome tracing owns that later measurement.

The committed fixture artifacts are intentionally compact JSON. To regenerate
them after a deliberate baseline change, run the dedicated benchmark test once
with `UPDATE_GRASS_HILLS_BROWSER_FIXTURES=1`, inspect the files, and update the
two SHA-256 literals in `browser/fixture-manifest.js`. A normal run only verifies
the pinned bytes.

```sh
UPDATE_GRASS_HILLS_BROWSER_FIXTURES=1 packages/core/node_modules/.bin/vitest run --config packages/core/vitest.grass-hills-density-benchmark.config.ts packages/core/benchmarks/grass-hills-density/browser-fixtures.benchmark.js
```
