# Simplified Grass Hills full campaign — 2026-07-15

This Y3b campaign runs only the Y3a finalist: open six-point blades in stable
five-member tufts, `hill-and-clump` occlusion, and `plotter-lod` density. The
literal jobs are one-hill 5k/10k and full-composition 10k/25k/50k. No competing
representation or processing variant is present.

The compact summary is in
[`simplified-full-2026-07-15.json`](simplified-full-2026-07-15.json). The
verbatim 244 KiB protocol envelope is in
[`simplified-full-2026-07-15.campaign-raw.json`](simplified-full-2026-07-15.campaign-raw.json);
it retains every completed timing and memory sample, complete collector payload,
runtime/machine record, and structured censor result. Reproducible SVG checksums
and inventories are in
[`simplified-full-2026-07-15.svg-manifest.json`](simplified-full-2026-07-15.svg-manifest.json).

## Fixed policy and status

- Mode: explicit `full` with long-campaign confirmation.
- Per child: 600-second deadline and 2 GiB RSS ceiling.
- Fixed samples: 20 preparation, 20 cold, 60 warm, and 3 unreported warmups.
- Complete: one-hill 5k, one-hill 10k, full 10k.
- Censored: full 25k and full 50k, both by the 600-second timeout.
- Machine: Apple M2 Max, 12 logical CPUs, 64 GiB system memory, Node v23.9.0.

No sample count was reduced. The timeout kills occurred at 600,010.874 ms and
600,009.361 ms with `SIGKILL`. A killed worker cannot return a trustworthy
partial phase payload, so those jobs retain the censor record rather than
inventing or reusing partial measurements. The 2 GiB memory ceiling was not
observed exceeded or tripped; the censor envelopes retain no RSS proximity
evidence for those killed workers.

## Completed results

Times are medians in milliseconds. RSS is the process high-water mark. Root
minimum is physical millimeters against the pinned 0.30 mm nib. Sampling
coverage is the deterministic capped nearest-clearance contract; collision
counts remain exact at one nib width.

| Fixture | Prep | Cold | Warm | Max RSS MiB | Custom process | Source paths | Outline paths | Root min mm | Colliding path pairs | Segment coverage | Path coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| one-hill 5k | 2236.8 | 2296.0 | 35.3 | 236.9 | 30.4 | 5000 | 2950 | 0.3024 | 903 | 35.3% | 89.5% |
| one-hill 10k | 4478.9 | 4607.9 | 77.5 | 261.6 | 71.7 | 10000 | 3441 | 0.3000 | 1147 | 39.0% | 81.1% |
| full 10k | 4497.0 | 4674.6 | 151.3 | 263.4 | 167.9 | 10000 | 4892 | 0.3000 | 1043 | 23.5% | 74.5% |

All three completed jobs contain exactly 20/20/60 samples. The raw envelope
also retains per-sample before/after heap, RSS and maxRSS snapshots; complete
source/processed/clipped inventories and checksums; generic HLR reference work;
structural Canvas calls; ordinary SVG and plotter serialization; and full root,
clearance, collision, spatial-index, and sampling evidence.

## SVG handoff artifacts

The artifact generator produced source (`fill`) and selected processed
(`outline`) ordinary SVGs for all five literal fixtures. The files intentionally
live outside Git at stable paths of the form:

```text
/tmp/issue-305-y3b-<fixture>-fill.svg
/tmp/issue-305-y3b-<fixture>-outline.svg
```

The ten files range from 455 KiB to 8.5 MiB and are not committed. The manifest
pins their SHA-256, exact bytes, path counts, Scene checksums, primitive/point
inventories, serializer, candidate, and absolute handoff path. Artifact
generation is independent of the timed campaign: a single deterministic render
can succeed for 25k/50k without implying that the full 100-sample benchmark
completed inside 600 seconds.

## Interpretation

The finalist preserves the 0.30 mm root-spacing guarantee and materially reduces
Outline paths at every generated scale. Full-mode evidence is complete through
10k. Under the fixed policy, 25k and 50k are timeout-censored and therefore are
not supported as successful full-campaign densities. This is benchmark evidence
only; it does not adopt the candidate or change production code.

## Reproduction

From the repository root:

```sh
node packages/core/benchmarks/grass-hills-density/bundle-cli.js \
  --entry=packages/core/benchmarks/grass-hills-density/simplified-candidate.js \
  --out=/tmp/issue-305-y3b-simplified-finalist.mjs

cd packages/core
GRASS_HILLS_SIMPLIFIED_BUNDLE_URL=file:///tmp/issue-305-y3b-simplified-finalist.mjs \
  node benchmarks/grass-hills-density/cli.js --mode=full \
  --confirm-long-campaign \
  --config=./benchmarks/grass-hills-density/simplified-full-config.js \
  > /tmp/issue-305-y3b-campaign-raw.json
cd ../..

node packages/core/benchmarks/grass-hills-density/simplified-full-report.js \
  --campaign=/tmp/issue-305-y3b-campaign-raw.json \
  --out-dir=packages/core/benchmarks/grass-hills-density/results

node packages/core/benchmarks/grass-hills-density/bundle-cli.js \
  --entry=packages/core/benchmarks/grass-hills-density/simplified-full-artifacts-cli.js \
  --out=/tmp/issue-305-y3b-artifacts-cli.mjs

node /tmp/issue-305-y3b-artifacts-cli.mjs \
  --manifest=packages/core/benchmarks/grass-hills-density/results/simplified-full-2026-07-15.svg-manifest.json
```

The report generator copies the raw campaign envelope byte-for-byte before
deriving the summary. Re-running the artifact bundle must reproduce the manifest
and all ten `/tmp` SVG checksums byte-for-byte.
