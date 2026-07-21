# O1 dense relocation grid — rejected, 2026-07-21

## Decision

**DO NOT RETAIN.** O1 preserved every exact output pin and substantially improved
positive-relaxation preparation, but it reproducibly regressed p95 on the
high-N zero-relaxation case. The campaign requires candidate p95 to be no higher
than its paired baseline in every full-matrix case, so the strict gate rejects
the experiment.

No O1 production or test code is retained. The optimization baseline remains
clean commit `4dbe144826cd63266d46762d76a8d92ca512348f`, the preregistered
practical p95 target remains `3,825.599570 ms`, and all pinned output/work
counters remain unchanged. This rejection is the campaign's first
no-retained-safe-candidate review pass; the clean-review counter is now `1 / 2`.

## Hypothesis

Profiling found relocation dominated the practical positive-relaxation path.
The candidate replaced the string-keyed `Map` and bucket arrays rebuilt during
each spacing-conflict scan with one reusable dense integer grid. It preserved
ascending site traversal, synchronous conflict snapshots, the strict
`distanceSquared < minimumSpacingSquared` predicate, and the existing
backtracking sequence.

## Positive-relaxation evidence

The targeted safe-relocation screen improved by about 80.6% at p95:

| Source | Samples | Median | p95 |
| --- | ---: | ---: | ---: |
| Baseline | 5 | 977.824 ms | 1,053.427 ms |
| O1 | 9 | 195.461 ms | 203.974 ms |

Two independently ordered practical screens used the preregistered analytic
ramp, density `100`, relaxation `0.5`, two warmups, and nine samples per source:

| Order | Source | Median | p95 | Paired p95 change |
| --- | --- | ---: | ---: | ---: |
| 1 | Baseline | 3,675.821 ms | 3,863.821 ms | — |
| 1 | O1 | 1,253.265 ms | 1,347.110 ms | -65.1% |
| 2 | O1 | 1,264.950 ms | 1,318.886 ms | -67.0% |
| 2 | Baseline | 3,871.182 ms | 3,991.232 ms | — |

Both O1 medians improved and both p95 results cleared the absolute practical
target. These gains are real but insufficient for retention because the full
matrix has a stricter per-case no-regression gate.

## Full-matrix fidelity

The serial baseline/O1 comparison covered all 27 target × density × relaxation
cases with two warmups and nine samples. Every pair retained exact parity for:

- ordered geometry checksum;
- termination and complete diagnostics JSON;
- placement and Distribution-refinement attempts;
- Voronoi work and accepted-relocation counts; and
- deterministic sequence and completed work.

In particular, zero relaxation continued to report no Voronoi work and no
accepted relocation. The candidate therefore did not win by skipping work or
altering output.

## Strict zero-relaxation failure

The failure is the high-N `flat:density=400:relaxation=0` case. Its exact pin is
checksum `6d8f06de7e8b8ef1ff38a0074d6197b4e816fe4476293853f406ede072e7676f`,
termination `completed`, distribution error `0.23928676757801687`, 411,884
placement attempts, 500,000 refinement attempts, `voronoi: null`, and zero
accepted relocations.

| Probe | Baseline p95 | O1 p95 | Change |
| --- | ---: | ---: | ---: |
| Initial full-matrix case, 9 samples | 1,279.033 ms | 1,403.416 ms | +9.72% |
| Immediate rerun, 9 samples | 1,253.793 ms | 1,286.966 ms | +2.65% |
| Independent confirmation, 25 samples | 1,240.799 ms | 1,339.405 ms | +7.95% |
| Alternating same-process causality, 25 samples | 1,261.691 ms | 1,292.687 ms | **+2.46%** |

The same-process probe alternated baseline/O1 in AB/BA order after five warmups.
Its medians were `1,170.696 ms` and `1,197.506 ms` respectively, a `+2.29%`
candidate regression. A baseline-A/baseline-B control under the same alternating
protocol measured p95 `1,322.389 ms` versus `1,309.945 ms` (`-0.94%`) and nearly
identical medians. This rules out separate-process drift as a sufficient
explanation for the O1 direction. Because zero enters no relocation work and all
work pins are identical, the observed penalty is a runtime/code-layout effect of
the candidate rather than changed solver work. The exact runtime mechanism does
not affect the retention decision: any repeated positive p95 delta fails.

The 25-sample confirmation also checked zero-relaxation
`exact-zero-barrier:density=1` and `exact-zero-barrier:density=100`; their p95
did not regress. The failure is isolated to the demonstrated high-N case, but a
single case is enough to reject the candidate.

## Artifacts

- Targeted relocation: `/private/tmp/stippling-relaxation-o1-candidate-relocation.raw.json`
- Practical pairs: `/private/tmp/stippling-relaxation-o1-order{1,2}-{baseline,candidate}.raw.json`
- Complete per-case serial evidence: `/private/tmp/389-o1-serial/{b,c}-<case-id>.raw.json`
- 25-sample zero confirmations: `/private/tmp/389-o1-confirm/{b,c}-<case-id>.raw.json`
- Alternating causality and control: `/private/tmp/389-o1-causality.json`
- Earlier sharded checkpoints: `/private/tmp/389-o1-full-{b0,b2,c0,c1}.raw.json`

`b` artifacts use baseline `4dbe144826cd63266d46762d76a8d92ca512348f`;
`c` artifacts use isolated rejected candidate
`b82d236628db2f83fae0ecb4b34ec4c20a3052ef`.

## Benchmark commands

Targeted and practical screens used the durable CLI from `packages/core`:

```sh
node benchmarks/stippling-relaxation/cli.js run \
  --mode=smoke --warmups=2 --samples=9 \
  --target=ramp --density=100 --relaxation=0.5 \
  --phase=safe-relocation --output=<relocation-artifact>

node benchmarks/stippling-relaxation/cli.js run \
  --mode=smoke --warmups=2 --samples=9 \
  --target=ramp --density=100 --relaxation=0.5 \
  --phase=end-to-end-preparation --output=<practical-artifact>
```

Each serial matrix case used the full canonical campaign and retained all phase
records:

```sh
node benchmarks/stippling-relaxation/cli.js run \
  --mode=full --confirm-full --warmups=2 --samples=9 \
  --case-id=<case-id> --output=<serial-artifact>
```

The strict zero confirmations used the same command with `--warmups=5` and
`--samples=25`. The causality artifact records its complete input, AB/BA order,
25 raw samples per source, exact shared pin, summaries, and baseline-only control.
