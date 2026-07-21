# Stippling relaxation benchmark

This opt-in harness measures the deterministic Stippling preparation pipeline.
It is excluded from the normal test suite and owns every clock; production code
contains no timing branches or observers for it.

The smoke campaign is preregistered as the representative zero-relaxation flat
case plus `ramp:density=100:relaxation=0.5` (one warmup, three samples). The full
campaign is the explicit 27-case product of targets `flat`, `ramp`, and
`exact-zero-barrier`; densities `1`, `100`, and `400`; and relaxation `0`, `0.5`,
and `1` (two warmups, nine samples). Overrides are capped at 10 warmups and 25
samples.

```sh
pnpm --filter @harness/core benchmark:stippling-relaxation
pnpm --filter @harness/core benchmark:stippling-relaxation:full
```

`run` accepts `--target`, `--density`, `--relaxation`, `--phase`, `--case-id`,
`--shard-index`, and `--shard-count` filters. Comma-separated values are
supported. Filtering precedes stable ID sorting and sharding. Use `--output` to
select a raw JSON artifact; otherwise the harness writes under `/tmp`. Reusing a
compatible output path resumes without rerunning completed sample IDs. Resume
compatibility is exact: environment, canonical campaign, filters, shard index,
selected cases, and phases must all match. Each completed case is checkpointed
through an atomic temporary-file replacement, so an interruption preserves all
earlier cases.

Each sample records its case and phase, status, duration, ordered geometry
checksum, termination, exact work, and diagnostics. The artifact also records
the environment/commit fingerprint and complete campaign configuration. Zero
relaxation records the Voronoi and relocation phases as skipped without calling
them or reading the benchmark clock for those phases.

Combine partial or repeated shards and derive a human summary with:

```sh
pnpm --filter @harness/core benchmark:stippling-relaxation:aggregate -- \
  /tmp/stippling-relaxation-full-shard-*.raw.json \
  --output=/tmp/stippling-relaxation-full.merged.json
```

Aggregation uses the looser canonical campaign identity, so distinct filters and
shards from the same environment can be combined. It rejects mismatched shared
campaigns, deduplicates exact sample IDs, and derives missing IDs from the whole
canonical matrix rather than only from the shards that happened to be supplied.
