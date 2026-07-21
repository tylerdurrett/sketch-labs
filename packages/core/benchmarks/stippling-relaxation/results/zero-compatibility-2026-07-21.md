# Stippling zero-relaxation compatibility, 2026-07-21

## Outcome

**PASS.** Candidate zero remains inside the allowed 5% median and p95 envelope
and exactly reproduces the pre-slice ordered geometry and diagnostics JSON.

The paired probe ran the pinned pre-slice worktree first and candidate zero
second in one Node process. It used the same analytic ramp, `100 × 100` Frame,
Seed `stippling-relaxation-benchmark-v1`, Stipple density `100`, Distribution
fidelity `0.5`, Voronoi relaxation `0`, two warmups, and nine recorded samples
for each source.

| Source | Commit | Samples | Median | p95 |
| --- | --- | ---: | ---: | ---: |
| Pre-slice | `21d195439f4ee48fa5bb0c8c3bdda01186c97610` | 9 | 417.432 ms | 486.124 ms |
| Candidate zero | `ea3327222d380deb62af29dff17855938cac6061` | 9 | 424.807 ms | 474.191 ms |

Candidate/base ratios were `1.0177` for median and `0.9755` for p95. Both are
below the maximum allowed `1.05` ratio. These observed timings describe this
run; they are not normal-suite timing assertions.

Both sources produced ordered geometry checksum
`50c10c112f222db0ec473d5ef3b0a64bb77b53fcacf4c47edbf797ad400326bd`
and exact diagnostics JSON
`{"termination":"completed","distributionError":0.38171899999998793}`.
The candidate does not add a null or zero relaxation diagnostic.

The source-level structural probe separately verifies that zero resolves to
zero production relaxation work, never invokes the relaxation factory, and
returns the exact post-refinement marks array reference through the
orchestrator boundary. It uses structural identity and call counts rather than
heap deltas or allocator noise.

## Environment and command

- macOS 15.6.1 / Darwin 24.6.0, arm64
- Apple M2 Max, 12 logical CPUs
- Node `v23.9.0` at
  `/Users/tylerdurrett/.nvm/versions/node/v23.9.0/bin/node`
- Benchmark/probe commit `ea3327222d380deb62af29dff17855938cac6061`
- Both source worktrees were clean when measurement began.

```sh
STIPPLING_RELAXATION_BASE_ROOT=/private/tmp/sketch-labs-389-baseline \
STIPPLING_RELAXATION_CANDIDATE_ROOT=/private/tmp/sketch-labs-389-n \
STIPPLING_RELAXATION_ZERO_OUTPUT=/private/tmp/sketch-labs-389-n/packages/core/benchmarks/stippling-relaxation/results/zero-baseline-2026-07-21.raw.json \
packages/core/node_modules/.bin/vitest run \
  --config packages/core/vitest.stippling-zero-baseline-benchmark.config.ts
```

The durable raw artifact contains all 18 elapsed samples, exact sample counts,
environment, commits, configuration, checksums, diagnostics, and computed gate
ratios: [`zero-baseline-2026-07-21.raw.json`](zero-baseline-2026-07-21.raw.json).
