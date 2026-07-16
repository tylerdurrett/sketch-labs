# Grass Hills density baseline

This is the historical maximum-density default scene captured before the dense
Grass Hills architecture work in issue #305. The fixture is executable in
[`grass-hills-density.benchmark.js`](grass-hills-density.benchmark.js), where its
seed, time, `1000 × 1000` Composition Frame, and every parameter are written as
literals so later schema-default changes cannot silently move the baseline.

| Inventory | Pinned value |
| --- | ---: |
| Hills | 10 |
| Blades | 400 |
| Scene primitives | 410 |
| Source points | 14,540 |
| Deterministic Hidden-line work (literal fixture at issue #305 head) | 11,584,278 units |
| Work recorded in the issue body | 11,372,294 units |

The original measurement machine observed approximately **248 ms** for cold
generation and approximately **44 ms** for Hidden-line processing. These are
historical observations, not performance budgets or SLAs. Machine, runtime,
thermal state, and sampling protocol affect elapsed timings.

Issue #305 also records 11,372,294 deterministic Hidden-line work units, but it
does not include the seed, frame, and parameter metadata that produced that
number. The reviewer-approved reconstruction — seed `12345`, time `0`, a
`1000 × 1000` frame, maximum `bladeDensity: 2`, and literal defaults for every
other parameter — reproduces every recorded structural count but produces
11,584,278 work units at the issue head. The executable smoke gate therefore
asserts the reproducible value and retains 11,372,294 as an explicit historical
observation; it does not misrepresent the latter as reproducible from different
fixture metadata.

The initial benchmark remains an opt-in smoke check: it generates and processes
the fixture once, reports those one-shot local timings, and asserts the pinned
inventory. It is not a statistically meaningful runner. Subsequent issue #305
work added explicit bounded measurement modes, candidate campaigns, the
architecture decision, and production acceptance evidence without weakening
this baseline.

## X3a exact-filled screen

On 2026-07-15, all four internal exact-filled variants were run only against
the literal `historical-baseline-400` and `one-hill-5000` fixtures. The generic
M2 runner used `screen` mode unchanged: a 90-second/1-GiB child limit, 3
preparation samples, 3 cold samples, 12 warm samples, and 1 warmup. All eight
jobs completed; none was censored. The Node host was v23.9.0 on Darwin arm64,
an Apple M2 Max with 12 logical CPUs and 64 GiB physical memory.

Each source candidate was bundled first with `bundle-cli.js`, then the eight
candidate/fixture jobs were passed to `runCampaign({ mode: 'screen', jobs })`.
No `full` or `adopted` campaign was run. Timings below are milliseconds;
preparation/cold/warm are medians, and RSS is the greatest measured after-sample
RSS across the three phases.

| Candidate | Fixture | Status | Prepare | Cold | Warm | Peak RSS MiB |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| exact-poisson-33 | baseline-400 | complete | 724.07 | 720.12 | 1.63 | 122.63 |
| exact-poisson-33 | one-hill-5000 | complete | 86.53 | 97.75 | 11.36 | 126.72 |
| exact-poisson-7 | baseline-400 | complete | 737.03 | 755.17 | 0.64 | 122.42 |
| exact-poisson-7 | one-hill-5000 | complete | 89.04 | 93.88 | 4.48 | 116.95 |
| exact-stratified-33 | baseline-400 | complete | 78.22 | 79.23 | 1.66 | 118.33 |
| exact-stratified-33 | one-hill-5000 | complete | 22.24 | 39.57 | 11.62 | 134.38 |
| exact-stratified-7 | baseline-400 | complete | 84.43 | 77.45 | 0.65 | 123.27 |
| **exact-stratified-7** | **one-hill-5000** | **complete** | **21.88** | **24.32** | **4.36** | **118.72** |

### Structural, processing, and export evidence

The processing time is candidate-supplied exact spatial Hidden-line time. The
processed and clipped columns are complete SHA-256 checksums; source checksum is
also the checksum independently observed after browser loading. Node Canvas is
the structural `drawSceneFitted` counting-port submission time, not raster time.

| Candidate / fixture | Source primitives / points | Source SHA-256 | Exact processing ms | Processed primitives / points | Processed SHA-256 | Clipped SHA-256 | Plotter paths | Node Canvas ms |
| --- | ---: | --- | ---: | ---: | --- | --- | ---: | ---: |
| poisson-33 / baseline | 410 / 14,540 | `6caf0c25fb0d1fd65d080c76aa621b64e4a5a9d165b2c6c5f516d352e23332d8` | 33.33 | 477 / 13,268 | `966e10e46601abf12c6ce1bad24ead34c191b48da644c4caf02aeb49b2520537` | `f68b40ddafae14c7f4774e07a27bbcf2bfccd38fd020fabde36ea269b8c86727` | 470 | 0.60 |
| poisson-33 / 5k | 5,001 / 165,134 | `9191416823daa0f255d9df58c7b73998aad11d4cc6db6da72771d55dfe345a2c` | 129.29 | 6,095 / 144,564 | `939827efe18fb432f7a7f75886a9b0fb61792642ead322958ec386aef8943302` | `4acb4fc526e00fa1d84f1f91c5b59776c39b046f7897d7a0e28ac0508109046c` | 6,109 | 3.33 |
| poisson-7 / baseline | 410 / 4,140 | `b6fb601127e6412ed423a4defb99858d6ffd09d4be4b61b724972af60e8e68e5` | 18.44 | 476 / 4,137 | `e7019eaebff1b4f451daf24ae0b0a3d86f7a88e27a3d002a82396a84b852870a` | `dcf7f03b51496af463a63db947bb2e094b6151eb6d5fcf0e7a3613d4acae7f98` | 469 | 0.27 |
| poisson-7 / 5k | 5,001 / 35,134 | `b1625be70520ea4d01db3eac0bd902eae4740a368f17d290d7ed53d3b7b93b31` | 77.56 | 6,053 / 35,623 | `807d6785667359180c4bf90a30b68826fad32aa47940bd366ad9f728a1a61b37` | `00110f8ed8f3b9a18856b5dec88af599969af0f639e0f24508fb9004ca796e6e` | 6,067 | 1.24 |
| stratified-33 / baseline | 410 / 14,540 | `a56f0279cc8d8447be5be1d11e65ce4afcab7b264f7d519364a2cecde0a21528` | 22.27 | 483 / 12,987 | `349840ddd2fd3dabc804971988e875a73c48ed049a309784bdb670a7da21df76` | `aea4a143550bc296042f02a9902abef856e488d18ea0cbd2d08e0dd6a5dea3f9` | 474 | 0.88 |
| stratified-33 / 5k | 5,001 / 165,134 | `a8b03f45d2832198f19e3b458f5b2e61bb3ce0f6c4423c41cda1d54a9abeab4a` | 167.04 | 6,146 / 149,751 | `3530642e214502aed1b3f6fd69c26b6232a8de9b8ff86a6379c81aedb60c090f` | `2f1fe221be49667ec6ad4ba7d6da4c867c8964f028604dbcf16f890b0f0da356` | 6,154 | 3.33 |
| stratified-7 / baseline | 410 / 4,140 | `af5ff261c266f80cdf623b5a94f43af94ad6280b3c310dca629ab00141fb8abf` | 16.07 | 484 / 4,121 | `408917186d75d70ab30ad4edd902888aa5293d14d584a72303f3476b6270afa5` | `832d086e49320e155a493b8db885b95382e664d62926d59b2bcedae0155f20a2` | 475 | 0.26 |
| **stratified-7 / 5k** | **5,001 / 35,134** | `99624b23a81d67fa967a03e8234c0f1aa440c70fe80e6a434bbadc717a451e2b` | **72.70** | **6,139 / 36,058** | `ed7d5d0c5d1c467b6b535f9b1b304694bc46558cf8aaa343c80fffd41b8da8fc` | `40e4d1676f670c618d6be5727305d22f387daf08af946f8ed01d1821691a5cf4` | **6,147** | **1.20** |

### Physical spacing and exact-index evidence

Root distances are millimeters. Path clearances are nib widths from the capped,
deterministic nearest-clearance sample. Collision pairs remain exact at the
one-nib threshold. Dense path coverage is about two thirds because the policy
caps the sample at 4,096 paths; baseline coverage is at least 97.2% and is 100%
for both seven-point candidates.

| Candidate / fixture | Root min / p50 / p95 mm | Path clearance p50 / p95 nibs | Exact colliding path pairs | Grid candidates / exact overlaps | Index build ms / estimated bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| poisson-33 / baseline | 0.264 / 2.837 / 7.864 | 0.722 / 6.737 | 330 | 3,323 / 2,507 | 0.70 / 56,936 |
| poisson-33 / 5k | 0.117 / 0.926 / 1.823 | 0.674 / 2.753 | 10,279 | 36,454 / 10,539 | 2.02 / 277,192 |
| poisson-7 / baseline | 0.264 / 2.837 / 7.864 | 0.000 / 6.737 | 327 | 3,323 / 2,507 | 0.46 / 56,936 |
| poisson-7 / 5k | 0.117 / 0.926 / 1.823 | 0.260 / 2.235 | 9,851 | 36,454 / 10,539 | 1.86 / 277,192 |
| stratified-33 / baseline | 0.300 / 3.118 / 8.439 | 0.326 / 6.277 | 350 | 3,182 / 2,494 | 0.56 / 56,792 |
| stratified-33 / 5k | 0.035 / 0.959 / 2.026 | 0.804 / 3.362 | 8,786 | 29,667 / 9,116 | 2.25 / 310,784 |
| stratified-7 / baseline | 0.300 / 3.118 / 8.439 | 0.000 / 6.277 | 360 | 3,182 / 2,494 | 0.51 / 56,792 |
| **stratified-7 / 5k** | **0.035 / 0.959 / 2.026** | **0.378 / 2.729** | **8,562** | **29,667 / 9,116** | **2.17 / 310,784** |

### Real Chrome Canvas observations

The benchmark Vite page loaded each source Scene by its exact serialized bytes
and invoked core's real `drawSceneFitted` on its 1000×1000 Canvas. Chrome 144
headless on macOS reported 12 logical CPUs, 8 GiB device memory, and device pixel
ratio 1. Each row has one first submission followed by 30 redraw submissions.
These numbers end at Canvas command submission; they do not claim raster or
compositor completion. Occasional dense p95 spikes are reported, not hidden.

| Candidate / fixture | Fetch / parse ms | First draw ms | Redraw median / p95 ms | Loaded bytes |
| --- | ---: | ---: | ---: | ---: |
| poisson-33 / baseline | 5.20 / 2.30 | 0.50 | 0.60 / 0.96 | 581,405 |
| poisson-33 / 5k | 15.60 / 14.20 | 3.90 | 3.20 / 51.23 | 6,756,470 |
| poisson-7 / baseline | 1.70 / 0.50 | 0.10 | 0.10 / 0.20 | 182,985 |
| poisson-7 / 5k | 4.20 / 3.80 | 1.70 | 1.50 / 32.17 | 1,802,671 |
| stratified-33 / baseline | 2.20 / 1.20 | 0.30 | 0.30 / 0.30 | 581,755 |
| stratified-33 / 5k | 13.50 / 15.80 | 3.60 | 3.20 / 42.88 | 6,771,699 |
| stratified-7 / baseline | 1.90 / 0.40 | 0.20 | 0.10 / 0.20 | 183,111 |
| **stratified-7 / 5k** | **3.80 / 3.90** | **1.60** | **1.45 / 24.73** | **1,806,099** |

Eight timestamped Canvas captures were file-validated and visually inspected,
then removed rather than committed. The baseline controls all still read as the
known sparse scene. All four 5k variants clearly read as a grass-covered hill.
No stable-cell grid banding was visible, and the seven-point silhouettes were
not distinguishable from the 33-point silhouettes at the whole-frame 1000×1000
view.

### Selection

**`exact-stratified-7` is the one exact-filled finalist.** Its canonical field
and geometry retain the deterministic identity/nesting/four-roll contracts, its
source and processed checksums are pinned above, and X2 proves the supplied
processor checksum-equivalent to current Hidden-line. Visually it clears the
dense-grass threshold without visible cell banding or visible loss against the
33-point blade.

It also owns the best dense preparation/cold medians (21.88/24.32 ms), the best
seven-point warm median (4.36 ms), the best dense browser first draw and redraw
median/p95 (1.60 and 1.45/24.73 ms), fewer exact colliding plotter path pairs
than either Poisson variant, and better p50/p95 root spacing than Poisson. Its
0.035 mm minimum root distance is worse than Poisson's 0.117 mm and both are
below the 0.30 mm nib; this is an explicit local-collision tradeoff, not omitted
evidence. The observed exact index, export path count, and peak RSS remain
tractable at 5k, so no second exact finalist is retained.

## X3b sole-finalist full matrix

On 2026-07-15, `exact-stratified-7` alone ran the five dense fixtures under the
unchanged M2 `full` policy: a 600-second/2-GiB child limit, 20 preparation
samples, 20 cold samples, 60 warm samples, and 3 warmups. The serial campaign
finished in 247.53 seconds on Node v23.9.0, Darwin arm64, an Apple M2 Max with
12 logical CPUs and 64 GiB physical memory. All five jobs completed and none
was censored. Timings below are milliseconds; phase values are medians and peak
RSS is the greatest after-sample RSS observed across all three phases.

| Fixture | Status | Prepare | Cold | Warm | Exact processing | Peak RSS MiB | Plotter paths |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| one-hill-5000 | complete | 16.69 | 22.25 | 3.30 | 70.01 | 140.86 | 6,147 |
| one-hill-10000 | complete | 25.67 | 34.75 | 5.48 | 179.74 | 148.39 | 13,397 |
| full-10000 | complete | 148.41 | 116.47 | 8.83 | 382.20 | 167.55 | 13,299 |
| full-25000 | complete | 119.30 | 162.38 | 21.65 | 1,393.06 | 196.30 | 35,023 |
| full-50000 | complete | 196.27 | 253.33 | 46.32 | 5,088.89 | 278.97 | 68,244 |

The committed [raw result](grass-hills-density/results/exact-stratified-7-full.raw.json)
retains every sample, memory snapshot, runtime/machine field, full root/hill
identity inventory, checksum, Hidden-line/index metric, clip/export metric, and
physical-spacing distribution. The compact [summary](grass-hills-density/results/exact-stratified-7-full.summary.json)
retains phase timing and memory distributions plus all numeric structural,
processing, Hidden-line/index, clipping, Canvas, SVG, plotter, spacing, runtime,
and machine evidence. Its root inventories are represented by count and
SHA-256 and point back to the complete raw evidence instead of duplicating up
to 50,000 keys per row.

For the downstream fill-versus-Outline decision, the run also generated a
clipped source-fill SVG and an exact-Hidden-line clipped Outline SVG for every
fixture. The ten SVGs occupy about 38 MiB at the stable directory
`/tmp/issue-305-x3b-exact-stratified-7`; their exact paths, byte counts, scene
checksums, SVG SHA-256 checksums, exact-index evidence, and regeneration command
are pinned in the committed [artifact manifest](grass-hills-density/results/exact-stratified-7-full.artifacts.json).
They are decision artifacts only and make no production renderer or candidate
change.

Reproduce the full campaign and all artifacts from the repository root:

```sh
node packages/core/benchmarks/grass-hills-density/exact-finalist-full.js
```

To rebuild only the compact summary from the committed complete evidence:

```sh
node packages/core/benchmarks/grass-hills-density/exact-finalist-full.js --summary-only
```
