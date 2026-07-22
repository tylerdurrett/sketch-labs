# Stippling relaxation performance campaign, 2026-07-21

## Outcome

The campaign retained three exact-output optimizations and stopped after two
consecutive post-winner passes found no further safe candidate worth at least
5% on the practical path:

- `8080f84d770d4b5002d0b6e180a2cc930101c8ae`: numeric sparse relocation
  buckets, equivalent to reviewed commit `807539a`;
- `5bd3c9770d61311e645312ae63fba738c8355922`: incrementally maintained
  relocation conflicts, equivalent to reviewed commit `1a97023`; and
- `aa52a9ddeb778a4b607439e233ec435581370c2b`: numeric sparse
  Distribution-refinement buckets, equivalent to reviewed commit `762672f`.

On the preregistered `ramp:density=100:relaxation=0.5` screen, the original
baseline measured `3,846.303 ms` median and `4,026.947 ms` p95. The final
retained source measured `1,152.62 ms` median and `1,170.14 ms` p95 in the O6
profiling pass. These separate runs describe an approximately 70% reduction on
the same pinned machine and protocol; individual candidates were retained
using paired or consecutive comparisons, not that cross-run headline.

Every candidate decision required exact ordered output, diagnostics,
termination, deterministic sequences, and work counts. No retained change
reduced geometry, fidelity, or requested work.

## Approved gate and audit history

The [original preregistration](practical-baseline-2026-07-21.md) said candidate
p95 must be less than or equal to paired baseline p95 in every full-matrix
case. An independent audit correctly flagged that this literal rule conflicted
with the campaign's earlier use of a 5% material-regression boundary. The
tentative optimization commits were reverted while the conflict was resolved.

After reviewing the evidence and tradeoff, the user expressly approved the
performance-campaign default material threshold on 2026-07-21 and approved
retaining the valuable wins. The final gate is therefore:

- exact output and work for every case;
- practical end-to-end p95 improves by at least 5%;
- practical median does not regress; and
- no confirmed full-matrix end-to-end p95 regression exceeds 5%.

This is an explicit user-approved gate change, not a reinterpretation of the
original text. Confirmed p95 ratio `<= 1.05` passes the material-regression
gate; a ratio `> 1.05` rejects the candidate. The final commits above reapply
the reviewed changes after the audit reverts.

Campaign environment and protocol:

- macOS 15.6.1 / Darwin 24.6.0, arm64
- Apple M2 Max, 12 logical CPUs
- Node `v23.9.0`
- Frame `100 × 100`, Seed `stippling-relaxation-benchmark-v1`
- practical case: analytic ramp, density `100`, relaxation `0.5`
- full matrix: `flat`, `ramp`, and `exact-zero-barrier` × densities `1`, `100`,
  and `400` × relaxation `0`, `0.5`, and `1`
- full protocol: six phases, two warmups, nine recorded samples per case

## Experiment decisions

| Pass | Result | Decision | Clean counter |
| --- | --- | --- | ---: |
| O1 | Dense relocation grid preserved exactness and accelerated relaxed cases, but high-N zero p95 regressed beyond 5%. | Rejected. | `1 / 2` |
| O2 | Numeric sparse relocation maps preserved exactness, improved practical p95 32.8–45.0%, and kept confirmed matrix regressions within 5%. | Retained; counter reset. | `0 / 2` |
| O3 | Numeric sparse refinement maps initially improved practical p95 only 3.80%. | Rejected below threshold. | `1 / 2` |
| O4 | Incremental conflict maintenance preserved exactness and cleared the practical and full-matrix material gates. | Retained; counter reset. | `0 / 2` |
| O5 | Re-evaluating O3 after O4 shifted the bottleneck produced a 7.43–8.25% practical p95 gain with no confirmed matrix regression above 5%. | Retained; counter reset. | `0 / 2` |
| O6 | Fresh profiling and opportunity review found no safe candidate expected to clear 5%. | No change. | `1 / 2` |
| O7 | Permission caching improved practical p95, but repeatedly regressed a zero-path case by more than 5%. | Rejected; campaign stopped. | `2 / 2` |

O1's evidence is recorded in
[`o1-dense-relocation-grid-rejected-2026-07-21.md`](o1-dense-relocation-grid-rejected-2026-07-21.md).
That record predates the approved gate change, but O1 remains rejected under
either rule because its confirmed high-N regression exceeded 5%.

## Retained evidence

### O2 — numeric sparse relocation buckets

The isolated measured candidate was
`6904f651219dda0d8b1caa5029ad60b44f773cb8`; the reviewed production change
was `807539a` and the final post-audit reapplication is `8080f84`. It replaced
serialized cell keys and per-cell point arrays with sparse nested numeric maps
while preserving fresh round snapshots, traversal, and spacing predicates.

Two paired practical orders measured p95 `3,479.99 → 2,337.96 ms` (-32.8%)
and `3,503.17 → 1,927.87 ms` (-45.0%). The authoritative serial comparison
measured `3,520.88 → 2,301.36 ms` (-34.6%). All 1,458 candidate phase pins and
work records were exact.

No confirmed matrix ratio exceeded `1.05`. The positive confirmed ratios that
triggered the gate audit were `1.0347` for barrier density `1`, relaxation `0`;
`1.0267` for barrier density `100`, relaxation `0`; `1.0443` for flat density
`1`, relaxation `0`; and `1.0172` for flat density `100`, relaxation `0.5`.
They fail the original literal rule but pass the explicitly approved material
threshold.

Artifacts:

- `/private/tmp/389-o2-serial/candidate-full.raw.json`
- `/private/tmp/389-o2-serial/comparison-summary.json`
- `/private/tmp/389-o2-serial/balanced-confirmations.raw.json`
- `/private/tmp/389-o2-serial/interleaved-confirmations.raw.json`

### O4 — incremental relocation conflicts

O4 retained the conflict set between backtracking rounds and updated only
cells affected by accepted moves. It preserved simultaneous round semantics,
ascending site order, strict spacing comparison, mask behavior, and rollback.
The isolated experiment was `5026d48`; the reviewed commit was `1a97023` and
the final reapplication is `5bd3c97`.

The two practical orders measured p95 `2,034.61 → 1,860.40 ms` (-8.6%) and
`2,048.92 → 1,191.85 ms` (-41.8%). The full matrix preserved exact pins in all
1,458 candidate phase samples. On the six relaxed density-400 cases, p95 ratios
against O2 ranged from `0.2925` to `0.3837`, reductions of about 61.6–70.8%.
Confirmation left no p95 regression above the approved 5% limit.

Artifacts:

- `/private/tmp/389-o4-serial/candidate-full.raw.json`
- `/private/tmp/389-o4-serial/candidate-full.summary.json`
- `/private/tmp/389-o4-serial/comparison-summary.json`
- `/private/tmp/389-o4-serial/interleaved-zero-confirmations.raw.json`
- `/private/tmp/389-o4-{baseline,candidate}-practical*.raw.json`

### O5 — numeric sparse refinement buckets

O3 first tested this change at `a5d25da`, where practical p95 improved only
3.80% and correctly failed the minimum-worthwhile threshold. O4 then shifted
the bottleneck, so O5 re-evaluated the hypothesis. The isolated O5 source was
`980be1c`; the reviewed commit was `762672f` and the final reapplication is
`aa52a9d`.

Against O4, balanced practical p95 improved `1,170.183 → 1,083.277 ms`
(-7.43%); the reverse order measured `1,159.616 → 1,063.979 ms` (-8.25%). The
full matrix preserved exact output and work in all 1,458 candidate phase
samples. The decisive 50-sample barrier density `400`, relaxation `1`
confirmation produced a p95 ratio of `1.0223`, within the approved material
limit.

Artifacts:

- `/private/tmp/389-o5-balanced-practical.raw.json`
- `/private/tmp/389-o5-balanced-highn-zero.raw.json`
- `/private/tmp/389-o5-serial/candidate-full.raw.json`
- `/private/tmp/389-o5-serial/confirm-*.raw.json`

## Final profiling and stop decision

O6 profiled the final retained implementation and found no bounded,
fidelity-safe candidate reasonably expected to improve the practical path by
at least 5%. It was clean pass one:

| Phase | Median | p95 |
| --- | ---: | ---: |
| End-to-end preparation | 1,152.62 ms | 1,170.14 ms |
| Placement | 97.33 ms | 110.62 ms |
| Distribution refinement | 219.82 ms | 241.51 ms |
| Voronoi assignment and centroid | 121.47 ms | 151.69 ms |
| Safe relocation | 189.17 ms | 204.49 ms |
| Geometry materialization | 3.20 ms | 4.42 ms |

O7 then tested relocation-permission caching at isolated commit `c3adf95`.
Practical p95 improved 8.82% and 6.99% in paired orders, and output remained
exact, but two 50-sample same-process confirmations for
`flat:density=100:relaxation=0` measured p95 ratios `1.0555` and `1.0731`.
Both exceed `1.05`, so O7 was rejected and became clean pass two. The campaign
then stopped.

Artifacts:

- O6: `/private/tmp/389-o6-*.raw.json`
- O7 full matrix: `/private/tmp/389-o7-serial/candidate-full.raw.json`
- O7 confirmations:
  `/private/tmp/389-o7-serial/confirm-flat-d100-r0-n50*.raw.json`
- O7 balanced practical: `/private/tmp/sketch-labs-389-o7-balanced.json`

## Remaining high-density limits

The retained O5-equivalent source is much faster at density `400`, but positive
relaxation still has multi-second end-to-end p95 ceilings:

| Target | Relaxation `0.5` | Relaxation `1` |
| --- | ---: | ---: |
| Exact-zero barrier | 5,581.61 ms | 10,288.23 ms |
| Flat | 4,996.97 ms | 10,304.94 ms |
| Ramp | 5,301.20 ms | 5,453.41 ms |

These measurements execute the exact full pipeline and retain all pinned work.
They show that requested relaxation still carries material high-density cost;
they do not identify any one phase as dominant. The source is the clean O5
experiment `980be1c6db7f41201ae771bf2ebfcfccb09a2e5f`, behavior-equivalent to
final commit `aa52a9d`, in
`/private/tmp/389-o5-serial/candidate-full.raw.json`, using two warmups and nine
samples per case.

## Correctness and reproduction

The retained practical pin is checksum
`b0a34300c7f7e945eb317594ab8c0a47da32caf06d21cac74645a45eed54b31d`,
termination `completed`, 159,490 placement attempts, 400,000 Distribution
refinement attempts, three completed relaxation iterations, 480,000 requested
and 360,000 completed relaxation work units, and 36,871 accepted relocations.
Zero relaxation continues to bypass Voronoi and relocation work entirely.

From `packages/core`, the durable full campaign command is:

```sh
node benchmarks/stippling-relaxation/cli.js run \
  --mode=full --confirm-full --warmups=2 --samples=9 \
  --output=/tmp/stippling-relaxation-full.raw.json
```

Compare future candidates and their immediate baseline consecutively on the
same clean machine and Node binary. Confirm apparent timing noise with a
balanced-order or same-process probe, preserve exact output and work, and
apply the approved material rule: no confirmed full-matrix p95 ratio may
exceed `1.05`. Large raw artifacts remain outside the repository; this file
records the durable decisions and their provenance.
