# Grass Hills faithful Outline evidence — 2026-07-15

## Outcome

The production-equivalent Fill → exact Fill-derived Outline source → indexed
Hidden-line → bounds/profile/serialization pipeline completed at both the
adopted 10,000-blade Preset and the supported 50,000-blade ceiling. This is an
implementation evidence record, not a visual approval: the paired fidelity
verdict remains `PENDING-INDEPENDENT-REVIEW` in the manifest.

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
| Preparation | `109.05` | `187.95` |
| Fill sampling | `16.35` | `33.44` |
| Fill-derived source | `5.06` | `13.05` |
| Standalone plan analysis | `102.99` | `728.11` |
| Indexed Hidden-line, including its own plan | `426.55` | `4,012.36` |
| Fill / Outline bounds clipping | `4.07 / 8.15` | `12.52 / 18.77` |
| Fill / Outline / physical serialization | `21.65 / 28.53 / 28.60` | `106.83 / 170.38 / 159.02` |
| Complete evidence scenario | `2,576.16` | `9,211.76` |

The scenario total also includes deterministic review rasterization/contact-sheet
work. Stage-sampled RSS peaked at `431,046,656` bytes for 10k and
`1,252,442,112` bytes for 50k; sampled heap used peaked at `286,054,640` and
`993,262,896` bytes. `process.resourceUsage()` reported process-lifetime maximum
RSS of `462,929,920` and `1,425,391,616` bytes at the end of each scenario. The
outer `/usr/bin/time -lp` run observed `1,495,990,272` bytes maximum RSS for the
complete two-scenario process. The raw stage samples are committed in
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
Scene JSON values outside git. An independent reviewer should compare each Fill
and Outline as one pair, check the physical plot, and replace the manifest's
placeholder only after that paired gate. Generation itself never writes a PASS.
