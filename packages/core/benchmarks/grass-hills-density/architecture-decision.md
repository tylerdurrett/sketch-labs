# Grass Hills dense architecture decision — issue #305

## Decision

Adopt **`stratified-7-centerline-lod` at 10,000 blades across the ten-hill
composition**. This is the lowest full-composition fixture that completed the
fixed campaigns, clears the approved grass-covered-hill visual gate in Fill,
Outline, and a physical plot preview, and leaves the prepared sampling seam
lean enough for wind work.

The production architecture is deliberately representation-specific:

- Canonical roots come from a seeded, stable-cell `100 × 100` stratified bank
  per reduced hill identity. Density selects a nested priority prefix. Root
  identity, four fixed variation rolls, continuous depth scale, and the final
  count-driven terrain reprojection remain separate.
- Fill preview uses one curved seven-point closed silhouette per descriptor.
  A small seeded baseline lean is part of fixed per-blade variation; future
  wind adds sampling-time lean to it instead of rebuilding roots or variation.
  Normal far-to-near painter order keeps live filled-blade occlusion exact.
- Outline and plot use curved six-point spines derived from the same descriptor
  set and lean. A deterministic LOD rejects roots closer than the active tool
  width, nearer hill polygons are the only occluders, and visible ridge strokes
  are retained. There is no tuft aggregation and no blade-to-blade or clump
  occlusion in this representation.
- Fill keeps all 10,000 descriptors. The pinned 0.30 mm profile selects 9,298
  roots and emits 8,939 clipped Outline paths. Different density is therefore
  intentional, but composition, identities, terrain, and lean stay shared.
- One processed stroke-only Scene is the geometry boundary for both Outline
  Canvas preview and physical plotter SVG. The plot serializer only maps that
  value into the `200 × 200 mm` sheet with `10 mm` insets; it does not rerun LOD
  or occlusion. This preserves ADR-0011.

This is a sketch-local decision under ADR-0007, not a system ADR. The generic
Scene, Canvas/SVG renderers, Hidden-line pass, and prepared-Sketch contract do
not change.

## Approved fixture and visual threshold

The fixture pins seed `12345`, time `0`, a `1000 × 1000` Composition Frame, ten
hills, 10,000 descriptors, a `200 × 200 mm` paper profile with `10 mm` insets,
and a 0.30 mm tool. The drawable square is `180 mm`, which is approximately
`680 px` at 96 dpi.

“A hill of grass” means all three outputs pass together:

1. Fill unmistakably reads as curved, tapered grass covering rolling hills,
   rather than sticks, stubble, rain, conifers, or an undifferentiated texture.
2. Continuous depth scaling and ten terrain bands remain traceable without a
   rectangular root grid or artificial row-gap banding.
3. Outline preserves the same hill crests, depth order, blade gesture, and
   overall massing without pathological black tangles or misleading loss.
4. The 96 dpi physical preview retains terrain hierarchy and individually
   plot-legible marks at the pinned 0.30 mm tool width. Local crossings are
   acceptable; a solid bar or collision-dominated region is not.

The approved byte-pinned artifacts are
`src/sketches/grass-hills/reference/{fill.svg,outline.svg,manifest.json}`.
The manifest also pins the physical plot checksum and proves that its input
Scene checksum is exactly the Outline Scene checksum.

Independent visual provenance: `/root/decision_d/decision_visual_review`.
That reviewer first rejected both stock finalists in every mode at full 10k,
then independently passed the bounded shared-root revision in all three modes.
The revised Fill reads as rolling green grass, Outline preserves all ten hill
bands without black knots, and the exact-0.30-mm physical plot retains curved
individual marks with only bounded local collisions.

## Measured evidence at the adopted target

The exact stratified descriptor foundation completed the fixed `full` policy
(`20` preparation, `20` cold, `60` warm, three warmups) at full 10k on the
recorded Apple M2 Max / Node 23.9 machine:

| Phase                           |     Median |
| ------------------------------- | ---------: |
| Preparation                     |  148.41 ms |
| Cold generation                 |  116.47 ms |
| Warm varying-`t` sample         |    8.83 ms |
| Exact spatial Outline prototype |  382.20 ms |
| Peak sampled RSS                | 167.55 MiB |

The revised on-demand hill-only LOD/occlusion reference took approximately
`150 ms` for one processing pass. That cost is outside the live
`prepare → sample(t) → drawSceneFitted` loop. The stock simplified full-10k
candidate instead measured about `4.50 s` preparation, `4.67 s` cold, and
`151 ms` warm because its prototype couples processing to sampling; full 25k
and 50k were timeout-censored. It is not the wind foundation.

Chrome 144 on macOS loaded the checksum-verified revised Scenes and invoked
core's actual `drawSceneFitted`, not an SVG image or local renderer. At
`1000 × 1000` and after `680 ↔ 1000` resize plus Fill/Outline interaction:

| Observation                                 | Revised full 10k |
| ------------------------------------------- | ---------------: |
| Fill draw median / p95 over 180 rAF samples |   2.80 / 3.10 ms |
| Initial Fill / 680 px Fill                  |   3.20 / 4.60 ms |
| 680 px Outline / 1000 px Outline            |   3.00 / 2.00 ms |
| Long tasks during isolated interaction      |                0 |
| rAF intervals over 16.7 ms                  |         60 / 180 |
| JS heap before / after                      |  31.7 / 10.0 MiB |

The rAF cadence is an observed headless scheduling result, not a 60 fps claim;
the measured Canvas submissions themselves stayed below 4 ms. The negative
heap delta reflects collection and is evidence of no retained-growth signal in
that run, not an allocation bound. Earlier fresh stock-finalist runs similarly
recorded no isolated long tasks. Temporary browser Scenes, captures, servers,
and heap probes are not durable artifacts.

The plotter LOD enforces a minimum root separation of one nib
(`1.6666666666666667` Scene units = `0.30 mm`) before hill masking. Every
Outline primitive uses that Scene width, so the physical serializer emits an
exact 0.30 mm stroke. Long blades and ridge intersections can still cross; the
visual threshold explicitly accepts the bounded crossings present in the
pinned fixture rather than claiming collision-free output.

## Rejected alternatives

- **Stock exact stratified seven-point blades plus exact spatial Hidden-line:**
  deterministic and fast enough through full 50k, but full-10k Outline grows to
  13,299 paths, its root minimum is 0.0076 mm, and the physical output becomes a
  collision-dominated tangle. Its fixed black 2-unit blade contours also make
  Fill read as jagged forest texture. Exact blade-to-blade Outline occlusion is
  rejected for production.
- **Stock simplified six-point strokes, five-member tufts, clump occluders:**
  mechanically cleaner plot output but the vertical marks read as stubble or
  rain, clump processing removes the hill composition, and its preparation and
  full-matrix completion fail the adopted wind gate. Tufts and clump masks are
  rejected rather than retained as a fallback.
- **Exact Fill spliced to the stock simplified Outline:** rejected because the
  two measured candidates own different roots, lean, and composition. The
  adopted revision is not that splice: it derives both representations from one
  exact descriptor set and verifies them together.
- **Same density in Fill and plot:** rejected because physical tool width is a
  real output constraint. Full density is correct for color exploration;
  deterministic tool-aware LOD is correct for Outline and paper.
- **25k or 50k as the initial production target:** exact prototypes complete at
  those counts, but the stock visuals become denser than the already-rejected
  full-10k exact output, while simplified full campaigns censor. Higher targets
  need a new pinned fixture and the same three-mode visual gate.

## Production and fallback boundary

The committed generator and SVGs are **decision evidence, not production
implementation**. The later implementation blocks must:

1. Land the stratified stable-cell bank, nested selection, shared descriptor
   preparation, and 10k density mapping without weakening stable hill/root
   identities or count-driven reprojection.
2. Land seven-point Fill blades and shared fixed baseline lean, preserving the
   ADR-0012 rule that preparation owns immutable descriptors and `sample(t)`
   performs only time-varying deformation plus fresh Scene projection.
3. Land the representation-specific, on-demand six-point Outline processor,
   tool-profile LOD, nearer-hill masks, ridge visibility, caching/invalidation,
   and the single processed-Scene handoff to Outline preview and SVG export.

Until all three land and reproduce the pinned reference, the existing sparse
closed-blade Sketch remains the production fallback and wind work must not
raise its numeric density cap as a substitute. The generic Hidden-line pass may
remain a compatibility/debug fallback for the legacy sparse Scene, but it must
not silently process the 10k production source or replace the selected
representation-specific Outline path. There is no automatic quality downgrade:
failure to build the shared processed Scene is surfaced rather than exporting a
different composition.
