# SUPERSEDED — Grass Hills #305 production acceptance, 2026-07-15

> **SUPERSEDED BY [#309](https://github.com/tylerdurrett/sketch-labs/issues/309).**
> This record approved a six-point, tool-selected, hill-only approximation and
> is historical evidence only. It is not the current production fidelity gate.
> Current Outline retains every exact seven-point Fill blade and hill ring as
> both source and occluder; the current 10k/50k paired evidence and comparative
> attestation live in `src/sketches/grass-hills/reference/` and
> [`faithful-outline-evidence-2026-07-15.md`](faithful-outline-evidence-2026-07-15.md).

<details>
<summary><strong>Historical #305 acceptance record (superseded; preserved verbatim below)</strong></summary>

## Archived acceptance text

## Outcome

**PASS.** The shipped inverse-square, root-keyed implementation passes the Fill,
Outline, and physical-plot gate at the adopted full-composition target. The
`dense-grass` Preset and production reference are ready for wind work.

This result replaces the equal-per-hill decision prototype as the production
visual reference. That prototype remains archived under
`src/sketches/grass-hills/reference/decision-prototype/` as historical decision
evidence.

## Pinned production input and output

- Preset: `dense-grass`, seed `12345`, time `0`.
- Composition Frame: `1000 × 1000`; ten hills; `bladeDensity: 2`.
- Physical profile: `200 × 200 mm`, `10 mm` insets, frame enabled.
- Mapping: `0.18 mm` per Scene unit at offset `(10, 10) mm`.
- Tool: `0.30 mm`, or `1.6666666666666667` Scene units. Grass and ridge
  strokes serialize at exactly `0.30 mm`; the one-unit Composition Frame
  serializes at `0.18 mm`.
- Inverse-square hill allocation, far to near:
  `3,094 / 1,928 / 1,316 / 955 / 724 / 568 / 457 / 376 / 315 / 267`.
- Fill: `10,000` blades; `10,033` clipped primitives; `71,312` points.
- Outline source: `8,179` selected blade spines, ten ridges, ten nearer-hill
  masks; `8,199` primitives and `51,724` points.
- Final Outline/plot: `7,798` paths including the frame; `44,601` points.
- Hidden-line workload: `10` filled masks, `42,195` source segments, `5,742`
  overlapping pairs, `3,897,390` estimated segment-edge comparisons, and
  `4,158,122` total work units.

Reference hashes:

| Artifact | SHA-256 |
| --- | --- |
| Fill SVG | `385b37a4f07ba842dcd10600df42164f1dd254726c5fd0d551ccd93cc106eb28` |
| Outline SVG | `720ed77598cc0feac36f3794bc85651a1b83f989b1ab68a501d9cfa72f2f4b36` |
| Physical plot SVG | `ff7ae34fbec456a09c95127b8df3943927d77e0a71962756149cbe4eb18687d8` |
| Clipped Outline Scene | `1d5227f202c1323480fad2ecccbcfd5615a3d545c02bf206c333a9741e9a1c5c` |

The actual Studio hidden-line export carried reproduction metadata, so its
whole-file hash intentionally differed. All `7,798` emitted `<path>` lines were
byte-identical to `physical-plot.svg`; preview and export therefore reused the
same processed geometry rather than independently reprocessing it.

## Actual Studio and Chrome profile

Chrome `144.0.0.0` headless on macOS loaded the committed Preset in the real
Studio `LiveCanvas`. The cold interaction run covered Preset reload, a
`958 → 688 → 958` canvas resize round-trip, Fill → Outline, and hidden-line SVG
export.

| Observation | Result |
| --- | ---: |
| Preset reload through two rAF commits | `447.92 ms` |
| Resize round-trip through two rAF commits | `32.80 ms` |
| Fill → completed Outline | `545.93 ms` |
| Main-thread long tasks in measured window | `1` (`389 ms`, cold Preset generation) |
| rAF intervals, median / p95 / max (`240` samples) | `8.3 / 9.3 / 383.3 ms` |
| rAF intervals over `16.7 ms` | `6 / 240` |
| Canvas submissions, median / p95 / max (`8` draws) | `4.1 / 4.9 / 7.4 ms` |
| JS heap after explicit GC, before / after | `22,459,271 / 32,884,118 bytes` |

The `389 ms` main-thread task is the expected cold 10k Preset generation. The
`545.93 ms` Outline interaction completed in the worker and introduced no
second main-thread long task. The post-GC `10,424,847`-byte increase includes
the retained production Fill/Outline session cache; it is an observed retained
state delta, not a leak claim or memory SLA. rAF cadence is headless scheduling
evidence, not a frame-rate claim. Canvas durations measure JavaScript submission
through the actual Canvas2D context, not raster or GPU completion.

### Committed lean round-trip

A fresh run committed `windLean 0 → 0.25 → 0` through the real NumberControl.
Automation selected the whole browser field, inserted one value through CDP,
allowed one animation frame for React's draft state, then pressed Enter and
waited for blur and the resulting canvas draws. This avoids mistaking a DOM-only
value assignment for a React transaction.

| Observation | Result |
| --- | ---: |
| Commit `0 → 0.25` | `479.2 ms` |
| Commit `0.25 → 0` | `492.9 ms` |
| Complete round-trip | `972.1 ms` |
| Main-thread long tasks | `2` (`410 / 383 ms`) |
| rAF intervals, median / p95 / max (`180` samples) | `8.3 / 9.2 / 408.2 ms` |
| rAF intervals over `16.7 ms` | `5 / 180` |
| Canvas submissions, median / p95 / max (`4` draws) | `4.4 / 4.6 / 5.3 ms` |
| JS heap after explicit GC, before / after | `28,483,992 / 28,650,593 bytes` |

A separate identity run exported the displayed SVG at each committed value.
The initial and restored exports were byte-identical (`2,012,905` bytes,
SHA-256 `7b42fc609fef2e71dda66a22d3a71e22aaf989ebf3d10475947882a9619ac888`),
while the committed `0.25` export changed (`2,014,171` bytes, SHA-256
`d3f3031544ca5c31255367590292eb61a63112c603f8dfc03ecb0bd5a6db9b4e`).
All authored controls also matched after restoration. This is exact displayed
Scene restoration.

Chrome's raw Canvas2D backing pixels changed as expected at `0.25`, but did not
return to a byte-identical raster for the byte-identical restored geometry:
initial `4515ee1c…`, changed `c84a6a1d…`, restored `70ff599b…`. That is recorded
as a browser raster/state observation, not hidden as a successful pixel-hash
round-trip and not treated as a Grass Hills geometry determinism failure.

The two long tasks track the two production 10k regenerations. The `166,601`-byte
post-GC increase is one observed retained-state delta, not a leak claim or a
memory SLA. These timings are measurements from one headless Chrome run, not a
latency SLA.

## Independent visual gate

Reviewer: `/root/impl_p4/p4_visual_review`. Overall verdict: **PASS**.

The reviewer inspected three timestamped temporary captures at original detail:

| Capture | SHA-256 | Verdict |
| --- | --- | --- |
| `2026-07-15_192900_grass-hills-production-fill.png` | `889fabbef603c88129b20a2045508c95fbe339f00730ee76ea4e289e1c8f3dbc` | PASS |
| `2026-07-15_192901_grass-hills-production-outline.png` | `622ecaa875e8c7066623cd2698af5b025c1fc853146de359bc2a4eac6ea2be27` | PASS |
| `2026-07-15_193001_grass-hills-production-physical-96dpi.png` | `cde557793432c76f11a9df7f44247957fb1b97c631dd308e60ae2a41088419a9` | PASS |

The Fill reads unmistakably as curved tapered grass over rolling hills. All ten
bands remain traceable with continuous depth scaling and no grid or artificial
row gaps. Outline preserves the crests, depth, gesture, and massing without
pathological tangles. At the exact `756 × 756` CSS-pixel rendering of the
`200 mm` sheet at 96 dpi, individual `0.30 mm` marks and terrain hierarchy
remain legible; horizon crossings stay bounded and never form a solid bar.

The captures, local servers, browser endpoint, downloaded export, and temporary
profiling scripts were removed after the verdict. Durable provenance is this
record plus the capture hashes and reviewer identity; the reference SVGs and
manifest remain reproducible.

</details>
