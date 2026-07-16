# Grass Hills faithful Outline evidence — 2026-07-15

## Outcome

The production-equivalent Fill → exact Fill-derived Outline source → indexed
Hidden-line → bounds/profile/serialization pipeline completed at both the
adopted 10,000-blade Preset and the supported 50,000-blade ceiling. This is an
implementation evidence record. Independent reviewer `/root/review_309_h`
subsequently returned an explicit comparative **PASS** for both the adopted 10k
and supported 50k pairs. That human/agent-owned result and the exact evidence
hashes are durable in `reference/review-attestation.json`; generated
`manifest.json` contains only a stable pointer to it and never overwrites the
attestation.

The harness has no alternative centerline, physical-tool LOD, density reduction,
or proxy-mask route. Runtime guards require every sampled Fill primitive to
appear in the role-annotated source at the same painter index with identical
points and closure metadata. Both runs recorded zero rejected primitives, zero
six-point centerlines, no physical-tool root rejection, and matching Fill/source
geometry hashes.

## Deterministic evidence

| Observation | Adopted 10k | Supported 50k ceiling |
| --- | ---: | ---: |
| Fill / source blades | `10,000 / 10,000` | `50,000 / 50,000` |
| Fill / source primitives | `10,010 / 10,010` | `50,010 / 50,010` |
| Fill / source geometry SHA-256 | `44620635… / 44620635…` | `ec7d0521… / ec7d0521…` |
| Source segments | `61,330` | `301,330` |
| Quadratic-eligible painter pairs | `50,095,045` | `1,250,475,045` |
| Indexed candidates / true overlaps | `68,367 / 68,367` | `902,980 / 902,980` |
| Index entries / cell references | `10,010 / 34,137` | `50,010 / 347,786` |
| Indexed / conservative overflow entries | `10,001 / 9` | `50,000 / 10` |
| Unsafe entries | `0` | `0` |
| Occupied cells | `8,256` | `37,332` |
| Estimated segment-edge comparisons | `38,925,698` | `215,192,268` |
| Total workload units | `40,344,970` | `231,245,348` |
| Final Outline primitives / points | `20,079 / 80,910` | `134,773 / 413,226` |

The few overflow entries are the deliberately conservative full hill-band
polygons whose AABBs exceed the per-entry cell cap. They remain in every query;
there is no dropped geometry. The manifest records the complete plan and index
inventory rather than treating any count as a target or SLA.

## Artifact inventory

The adopted pair and its physical plot are committed as full vectors:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `fill.svg` | `2,012,317` | `385b37a4f07ba842dcd10600df42164f1dd254726c5fd0d551ccd93cc106eb28` |
| `outline.svg` | `2,794,301` | `7867a67bc6a6a89181c3dc8662cd6734fd93b22c46c1ba75cf131cd5e767f398` |
| `physical-plot.svg` | `2,635,316` | `2237c080de94010cd7809eef598657cc36b320b6a8710104e37f650ede3bc7f1` |

The 50k full Fill, Outline, and physical SVGs are respectively `9,965,263`,
`16,337,472`, and `15,436,802` bytes. Their exact hashes are pinned in
`reference/manifest.json`, but those large duplicate vectors and the
18–25 MB Scene JSON values are not committed. Instead the repository carries
lossless 900 × 900 Fill and Outline review PNGs plus a lossless paired contact
sheet:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `supported-ceiling-50k-fill.png` | `90,905` | `d9780fdba95127160ffe08a5c2ad0217353c90a6e95d40e2acbc8775e832c1b8` |
| `supported-ceiling-50k-outline.png` | `85,590` | `09ee23869b622de9a668ba78b0a283e9791e35bbfef913d819dab6efe57e5bc9` |
| `supported-ceiling-50k-fill-outline-contact-sheet.png` | `181,652` | `3660523f2eeccd71a8ad3bbf6d47e2a5002e7aa5f31173cfea377c1eecf76d56` |

The bounded rasterizer is explicitly review-only. It does not participate in
Studio or artifact generation; exact production SVG/Scene hashes and the
full-artifact reproduction command remain authoritative.

## One-machine observations, not SLAs

Captured on an Apple M2 Max with 64 GiB RAM, macOS 15.6, Node 23.9.0. Tests pin
geometry and artifacts but contain no elapsed-time assertions.

| Duration (ms) | Adopted 10k | Supported 50k ceiling |
| --- | ---: | ---: |
| Preparation | `119.96` | `182.93` |
| Fill sampling | `16.84` | `33.92` |
| Fill-derived source | `5.63` | `13.41` |
| Standalone plan analysis | `115.74` | `735.26` |
| Indexed Hidden-line, including its own plan | `403.34` | `3,923.66` |
| Fill / Outline bounds clipping | `3.47 / 10.80` | `12.80 / 19.12` |
| Fill / Outline / physical serialization | `24.19 / 27.14 / 29.25` | `105.64 / 179.48 / 165.83` |
| Complete evidence scenario | `2,620.60` | `9,187.83` |

The scenario total also includes deterministic review rasterization/contact-sheet
work. Stage-sampled RSS peaked at `441,679,872` bytes for 10k and
`1,269,956,608` bytes for 50k; sampled heap used peaked at `281,354,632` and
`993,335,664` bytes. `process.resourceUsage()` reported process-lifetime maximum
RSS of `497,729,536` and `1,448,869,888` bytes at the end of each scenario. A
separate outer `/usr/bin/time -lp` run observed `1,495,990,272` bytes maximum RSS
for the complete two-scenario process. The raw stage samples are committed in
`reference/observations.json`.

## Reproduction and review handoff

From the repository root:

```sh
node packages/core/benchmarks/grass-hills-density/bundle-cli.js \
  --entry=packages/core/benchmarks/grass-hills-density/production-reference-cli.js \
  --out=/tmp/issue-309-production-reference-cli.mjs

node --expose-gc /tmp/issue-309-production-reference-cli.mjs \
  --out=packages/core/src/sketches/grass-hills/reference

node --expose-gc /tmp/issue-309-production-reference-cli.mjs \
  --out=/tmp/issue-309-reference \
  --full-50k-out=/tmp/issue-309-reference/full-50k
```

The third command writes the exact 50k Fill/Outline/physical SVGs and clipped
Scene JSON values outside git. Regeneration intentionally does not write or
modify `review-attestation.json`: generated evidence and independent attestation
remain separate, so reproducibility cannot erase reviewer provenance.
