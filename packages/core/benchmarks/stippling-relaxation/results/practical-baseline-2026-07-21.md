# Stippling relaxation campaign preregistration, 2026-07-21

## Practical screen

Optimization retention is preregistered against one exact practical screen:

- analytic ramp target, `100 × 100` Frame
- Seed `stippling-relaxation-benchmark-v1`
- Stipple density `100`
- Distribution fidelity `0.5`
- Voronoi relaxation `0.5`
- end-to-end Shading preparation
- two warmups followed by nine recorded samples

The pre-optimization source at
`2b44adf1af55aebd7a0b8a5225f242f2b0e04481` measured a
`3,846.303 ms` median and `4,026.947 ms` p95. The practical p95 retention
target is therefore **`3,825.599570 ms` or lower**, an end-to-end improvement
of at least 5%. A candidate must also keep its practical median at or below
`3,846.303 ms`; shifting work from the median into the tail, or vice versa, is
not a retained win.

The nine raw elapsed samples in milliseconds were:

```text
3932.045459, 3807.310959, 3828.031417, 4000.316625, 3813.167042,
4026.946916, 3798.458625, 3846.303250, 3915.619417
```

## Exact-output and full-matrix gates

Every candidate must preserve this practical screen's exact ordered checksum
`b0a34300c7f7e945eb317594ab8c0a47da32caf06d21cac74645a45eed54b31d`,
termination, diagnostics, deterministic sequence, and exact work counts. The
pinned practical work is 159,490 placement attempts, 400,000 Distribution
fidelity attempts, three completed relaxation iterations, 480,000 requested and
360,000 completed relaxation work units, and 36,871 accepted relocations. The
exact final diagnostics are retained in the raw artifact.

Passing the practical screen is necessary but not sufficient. Before retention,
the same candidate and its immediate baseline must run the full 27-case matrix
consecutively with the same Node binary, machine, environment, Frame, Seed,
controls, two warmups, and nine samples. For every target × density × relaxation
case, candidate end-to-end p95 must be less than or equal to its paired baseline
p95. All ordered checksums, diagnostics, deterministic sequences, termination,
and exact work must remain pinned. A regression in any one case rejects the
candidate even if the practical case improves.

The p95 and median conditions are benchmark review gates, not flaky wall-clock
assertions in the normal test suite.

## Environment and command

- macOS 15.6.1 / Darwin 24.6.0, arm64
- Apple M2 Max, 12 logical CPUs
- Node `v23.9.0` at
  `/Users/tylerdurrett/.nvm/versions/node/v23.9.0/bin/node`
- Source and benchmark commit
  `2b44adf1af55aebd7a0b8a5225f242f2b0e04481`; clean at measurement start

```sh
cd /private/tmp/sketch-labs-389-n/packages/core
/Users/tylerdurrett/.nvm/versions/node/v23.9.0/bin/node \
  benchmarks/stippling-relaxation/cli.js run \
  --mode=smoke --warmups=2 --samples=9 \
  --target=ramp --density=100 --relaxation=0.5 \
  --phase=end-to-end-preparation \
  --output=/private/tmp/sketch-labs-389-n/packages/core/benchmarks/stippling-relaxation/results/practical-baseline-2026-07-21.raw.json
```

The durable raw artifact records the nine samples, environment, commit,
complete canonical protocol, exact pin, and sample IDs:
[`practical-baseline-2026-07-21.raw.json`](practical-baseline-2026-07-21.raw.json).
