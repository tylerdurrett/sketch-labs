# Grass Hills density campaign protocol

This directory owns the benchmark-only subprocess protocol for issue #305. It
does not contain candidate algorithms, fixture manifests, result collectors, or
browser measurements; those plug into this boundary in later work.

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
}
```

`prepare` must return a callable varying-time sampler. `guard` must return a
finite, non-zero number so a candidate cannot benchmark omitted work. The runner
does not interpret candidate results or fixture payloads.

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
