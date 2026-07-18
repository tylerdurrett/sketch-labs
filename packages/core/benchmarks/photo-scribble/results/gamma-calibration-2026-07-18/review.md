# Issue 336 source-only gamma calibration

Date: 2026-07-18  
Reviewer: Codex development agent (`/root/run_336_gamma`)  
Browser: Chrome for Testing 144.0.7559.96, headless, `1440 × 1000`, device scale factor 1

## Decision

Do **not** adopt the proposed global `[0.25, 4]` exponent mapping in block 9.
It materially improves the dark alpha pine cone, but it fails the predeclared
no-worse visual rule on the ordinary opaque flowers: at the frozen authored
controls (`gamma 1`, `contrast 0.96`) it turns nearly one third of opaque source
pixels into exact paper and visibly removes petal texture. Keep the production
`[0.5, 2]` mapping unchanged unless a later, separately measured candidate can
add highlight headroom without that ordinary-photo regression. Do not add a
Levels control from this two-fixture result.

This block intentionally made no production calibration change and did not run
Scribble geometry, solver limits, exports, or plot simulation.

## Method

The benchmark-only browser seam decoded both committed photographs through
Studio's production Image Asset resolver. Full source distributions use every
decoded straight-RGBA8 texel and the production adapter's sRGB-to-linear
luminance equation; fixed probes, target hashes, permission, and captures use
the actual contain-fitted production fields. Each mapping was evaluated at all
nine `gamma × contrast` pairs from `{0, 0.5, 1}`, plus the frozen authored
controls. Quantiles use `floor(q × (n - 1))` over the complete named population.

The four screenshots were painted by Studio's real
`rasterizeToneReference` function at `512 × 512`, then captured from the canvas
element. They are evidence outputs, not replacement image fixtures.

## Preserved contract

Both fixtures passed every source-only invariant:

- normalized controls remain `[0, 1]`;
- centered `0.5 / 0.5` is exact identity, including identical canonical target
  hashes between mappings;
- all fixed gamma and contrast probe comparisons are monotonic;
- all nine control pairs preserve exact-zero permission and effective tone at
  transparent and letterbox probes;
- the pine-cone partial-alpha probe remains exactly `14 / 255` permission;
- the observed profile outputs equal gamma-before-contrast composition;
- contrast is unchanged and no Levels control is introduced.

Centered target hashes:

| Fixture | Canonical target hash |
|---|---|
| flowers | `87b3db52a7bed459131b18828772458da1bd5e02b3c961a3c731978107bbe24b` |
| pine cone | `61adf9a26fb4cd376a9a6f745226d206f94779537e2f4df9f770bb3484bb496c` |

## Authored-control distributions

Percentages below are over every fully opaque decoded source pixel. Tone is
ink darkness (`0` paper, `1` black).

| Fixture | Mapping | Paper white | Black | q05 | q25 | q50 | q75 | q95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| flowers | current `[0.5, 2]` | 9.70% | 40.15% | 0 | 0.275 | 0.859 | 1 | 1 |
| flowers | candidate `[0.25, 4]` | 32.41% | 25.92% | 0 | 0 | 0.485 | 1 | 1 |
| pine cone | current `[0.5, 2]` | 3.65% | 56.97% | 0.060 | 0.591 | 1 | 1 | 1 |
| pine cone | candidate `[0.25, 4]` | 19.16% | 44.74% | 0 | 0.133 | 0.874 | 1 | 1 |

The pine-cone result reproduces the issue comment's prediction on the complete
production-decoded population: substantially more paper-white highlights and
less black clipping. The flowers expose the tradeoff the single dark fixture
could not: paper-white clipping rises by 22.71 percentage points and the median
target drops from `0.859` to `0.485`.

Authored target hashes:

| Fixture | Mapping | Canonical target hash |
|---|---|---|
| flowers | current | `070fc192e94b4d4abbd5e09ea506aeea0702fe1b414699841795558ebf534f04` |
| flowers | candidate | `2e4a618a29d44555b3fdebffab693c1ad60571cf94565dd733787234fbd90bff` |
| pine cone | current | `3a4237f5fe2b4d9bbcfc9160feb24c27a7d1c89ad2e108e8e3dd1e79a4bad2c7` |
| pine cone | candidate | `2e422794ad1109f647d24353a10826312671a2de04baa6eeba629d91aac577fa` |

## Manual visual verdicts

Verdicts compare the candidate to current at each fixture's frozen authored
controls. `not assessed` is explicit because source-only evidence cannot make a
truthful geometry or export claim.

| Criterion | Flowers | Pine cone | Observation |
|---|---|---|---|
| tone-target-faithfulness | **worse** | **better** | Candidate reveals pine-scale highlights, but washes out broad flower-petal texture and merges many light petals into flat paper. |
| routing-legibility | not assessed | not assessed | Requires Scribble geometry, excluded from this block. |
| letterbox-permission | equal | equal | Both captures retain exact white contain-fit bands; fixed probes remain permission/effective-tone zero. |
| alpha-permission | not applicable | equal | Candidate preserves the same hard transparent exterior and soft partial-alpha boundary; permission is unchanged. |
| geometry-and-export-parity | not assessed | not assessed | Requires generated geometry and exports, excluded from this block. |
| plot-readiness | not assessed | not assessed | Requires the fixed physical profile and geometry, excluded from this block. |

The candidate fails the predeclared rule because the flowers have one `worse`
verdict. The pine-cone improvement does not override that global regression.

## Captures and raw evidence

- `2026-07-18_180800_issue-336-trial-gamma-flowers-before-current.png` — SHA-256 `a1f9e74dab28b27f80589a7996e31d334d53bad65ed2232f230b0d6e4ea73a96`
- `2026-07-18_180800_issue-336-trial-gamma-flowers-after-candidate.png` — SHA-256 `2e3120d72f8b33550d5901e7d380562e836575b032cc3c6ca3ba11e38841cc68`
- `2026-07-18_180800_issue-336-trial-gamma-pinecone-before-current.png` — SHA-256 `7134ad1391c9513e2347c926757adca28fce96ebd325271fe860a6b284484c2f`
- `2026-07-18_180800_issue-336-trial-gamma-pinecone-after-candidate.png` — SHA-256 `9f2c717a069749a56cdec0e6cdb4a022bfd35990d953651a0e65e42625747e54`
- `metrics.json` — all full distributions, fixed-probe observations,
  canonical hashes, raster summaries, and computed invariants.
