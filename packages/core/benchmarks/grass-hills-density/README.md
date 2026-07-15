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
does not interpret candidate results or fixture payloads. `inspect` is optional.
Only after every prep/cold/warm sample and memory snapshot is complete, the
worker materializes fresh preparation/cold/warm values, then inspects each and
records the return value on that phase's first `sample.metrics`. No measured
operation runs after inspection starts, so a collector's retained allocations
cannot become a later phase's heap/RSS/maxRSS baseline. For preparation, `value`
is a fresh sampler; for cold/warm it is a fresh generated value.

Invoke the generic CLI with the package directory as the current directory:

```sh
node benchmarks/grass-hills-density/cli.js --config=./candidate-config.js
node benchmarks/grass-hills-density/cli.js --mode=screen --config=./candidate-config.js
node benchmarks/grass-hills-density/cli.js --mode=full --confirm-long-campaign --config=./candidate-config.js
```

## Exact filled-blade prototypes

The four bundle-ready `exact-{poisson,stratified}-{33,7}.js` entries compare a
fixed-capacity smaller-radius Poisson root field with jittered stable cells, and
the current 33-point filled blade with a seven-point filled blade. They share
the protocol interface above and return explicit source roots for the physical
spacing collectors.

Their supplied processing Scene comes from the benchmark-local exact spatial
Hidden-line prototype. It replaces only the quadratic Primitive AABB scan with
a uniform grid: painter order, exact AABB acceptance, production polygon
preparation/subtraction, and production final simplification remain
authoritative. Long, non-finite, or over-cap AABBs take a conservative overflow
path. `exactSpatialHiddenLine` evidence reports plan/index/subtraction time,
index heap delta and structural byte estimate, occupied cells/references,
overflow count, grid candidate pairs, accepted overlapping pairs, and estimated
segment-edge comparisons. This is isolated benchmark evidence, not a production
Hidden-line or spatial-index change.

## Candidate bundle boundary

Campaign workers are deliberately plain Node processes. Core source is
TypeScript with extensionless internal imports, so a source candidate that
directly imports `metrics.js` or `src/*.ts` is not a valid `moduleUrl`: Vitest and
Vite transform that graph during tests/browser builds, while Node correctly
fails it. Do not add a runtime loader to the worker; its transform service,
module graph, and retained allocations would become part of every measured
heap/RSS baseline.

Bundle each candidate before constructing campaign jobs. From the repository
root, using the locked package-local Vite toolchain:

```sh
node packages/core/benchmarks/grass-hills-density/bundle-cli.js \
  --entry=packages/core/benchmarks/grass-hills-density/my-candidate.js \
  --out=/tmp/grass-hills-my-candidate.mjs
```

The bundler runs Vite SSR in the orchestration process, inlines the candidate,
collector, core TypeScript, and non-Node dependencies into one plain ESM file,
and leaves Node builtins external. It refuses a missing entry, an in-place
output, or a non-`.mjs` output. It neither starts a campaign nor changes mode,
timeout, memory, legacy-complexity, or long-campaign confirmation policy.

Point the plain-JavaScript config at that artifact:

```js
import { pathToFileURL } from 'node:url'
import { DENSITY_FIXTURES } from './benchmarks/grass-hills-density/fixtures.js'

export const jobs = [{
  candidate: {
    id: 'my-candidate',
    moduleUrl: pathToFileURL('/tmp/grass-hills-my-candidate.mjs').href,
    complexity: 'linear',
  },
  fixture: DENSITY_FIXTURES[1],
}]
```

Then invoke `cli.js` with the config and explicit mode flags shown above. The
fresh worker imports only the completed bundle before taking any phase memory
snapshot; Vite/esbuild never runs in the measured child. Rebuild whenever the
candidate, collector, or imported core source changes.

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

[`metrics.js`](metrics.js) collects source/processed/clipped primitive and point
counts, SHA-256 checksums, serialized and geometry byte sizes, the generic
Hidden-line workload reference, candidate processing time, bounds clipping,
ordinary SVG and plotter SVG time/bytes/path counts, explicit-root spacing, and
spatial inter-path clearance evidence in physical millimeters and nib widths.
Its Canvas metric invokes core's actual `drawSceneFitted` through a counting
port; the result is explicitly structural JS submission only and excludes
rasterization, compositor, and GPU completion. Heap/RSS comes from the protocol
worker. Both the worker and collector capture machine/runtime metadata.

Candidates pass their root coordinates explicitly; the collector never guesses
roots from closed shapes or path starts. They may let the collector measure
core's Hidden-line pass, supply `{ processing: { scene, durationMs } }` for an
already-measured custom Outline/LOD result, or supply
`{ processing: { run(source) { ... } } }` for a callback timed by the collector.
The supplied processed Scene is what clipping and both serializers consume, so
open stroke/tuft representations are not silently replaced by generic filled
Primitive Hidden-line output. `nibWidthSceneUnits` is also explicit; the fixture
manifest pins it to 1.6666666666666667 (0.30 mm).

Collision accounting is exact at the nib threshold. Segments are traversed
through a uniform grid whose cells are four nib widths wide; collision occupancy
expands one cell, then exact segment distance confirms each candidate. A
deterministic owner cell prevents duplicate pair counts. Long ridges occupy cells
along their length rather than forcing every grass segment into one global
x-overlap sweep.

Nearest-clearance percentiles are deliberately resource-bounded rather than
misrepresented as an all-pairs exact measurement. The literal manifest pins an
even segment-index sample of at most 4,096 segments and an eight-nib spatial
search cap. Reports label this contract, record segment/path coverage, and count
search-censored samples separately; resolved distances receive per-segment and
sampled-path millimeter/nib percentiles. Exact segment-pair/path-pair and
colliding-segment/path counts remain separate from the capped sample. Candidates
should pass `payload.metrics.clearanceSampling` into `collectSceneMetrics` so a
result records the manifest policy it used.

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
