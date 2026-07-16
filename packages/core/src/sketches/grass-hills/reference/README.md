# Grass Hills faithful visible-line reference — issue #309

This directory is the production reference for Grass Hills Fill-to-Outline
fidelity. For identical parameters, seed, frozen time, and Composition Frame,
Outline starts from the exact seven-point Fill geometry: every hill ring and
every tapered blade is retained in painter order as both a contour source and an
occluder. Physical tool width changes stroke width only. It does not select
roots, substitute centerline spines, or reduce the scene.

## Paired review assets

The adopted `dense-grass` Preset uses seed `12345`, time `0`, a `1000 × 1000`
Composition Frame, ten hills, and `bladeDensity: 2` for exactly 10,000 blades.
Its committed exact vectors are:

- `fill.svg`: 10,033 clipped paths
- `outline.svg`: 20,079 visible contour fragments
- `physical-plot.svg`: the same 20,079 processed Outline paths mapped to the
  `200 × 200 mm` profile with `10 mm` insets and a `0.30 mm` tool

The matching `adopted-10k-{fill,outline}.png` files and
`adopted-10k-fill-outline-contact-sheet.png` make the comparison reviewable at
original raster detail.

The supported ceiling uses the same fixture with `bladeDensity: 10`, for
exactly 50,000 Fill blades and 50,000 Outline-source blades. Its committed
`supported-ceiling-50k-{fill,outline}.png` pair and contact sheet review the
full-quality result. The exact 50k Fill, Outline, and physical SVGs contain
50,149, 134,773, and 134,773 paths respectively; their hashes and Scene counts
are pinned in `manifest.json`, while the large vectors are reproduced outside
git on demand.

## Evidence boundary

`manifest.json` is generated evidence for both scenarios. It pins the complete
Preset and physical profile, source/Fill geometry hashes, exact blade inventory,
Hidden-line index/workload counts, output Scene counts, artifact hashes, and
reproduction commands. Its fidelity fields attest that source geometry equals
Fill geometry, no primitive was rejected, no six-point centerline appeared,
and no representation fallback or physical-tool root rejection occurred.

`observations.json` records one machine's durations and memory samples. They are
observations, not SLAs or test limits.

`studio-worker-observations.json` is the complementary real-browser record. Its
Studio entry point uses the production `HiddenLineCoordinator`, module
`DedicatedWorker`, worker response validators, and `outlineSessionReducer`
cache. At both 10k and 50k it records the `postMessage` structured-clone
boundaries, terminal progress, completed preview Scene count/bytes/hash, and a
matching physical export that reuses the cached Scene with zero export
derivation messages. The wrapper observes Worker traffic only; it never replaces
source generation, Hidden-line derivation, clipping, or serialization.

`review-attestation.json` is maintained separately from generated evidence. It
records the independent comparative PASS for both the adopted 10k and supported
50k Fill/Outline pairs. Regeneration never creates, changes, or deletes it, so
reproducibility cannot overwrite reviewer provenance.

## Reproduction

Run from the repository root:

```sh
node packages/core/benchmarks/grass-hills-density/bundle-cli.js \
  --entry=packages/core/benchmarks/grass-hills-density/production-reference-cli.js \
  --out=/tmp/issue-309-production-reference-cli.mjs

node --expose-gc /tmp/issue-309-production-reference-cli.mjs \
  --out=packages/core/src/sketches/grass-hills/reference

node --expose-gc /tmp/issue-309-production-reference-cli.mjs \
  --out=/tmp/issue-309-reference \
  --full-50k-out=/tmp/issue-309-reference/full-50k

node packages/core/benchmarks/grass-hills-density/studio-worker-browser-cli.js \
  --out=packages/core/src/sketches/grass-hills/reference/studio-worker-observations.json
```

The second command reproduces the committed 10k reference and the bounded 50k
review assets. The third also writes the full 50k vectors and clipped Scene JSON
outside git. Focused benchmark tests reproduce the committed artifacts without
writing them.

The fourth command uses the chrome-devtools skill's existing Puppeteer package
and cached Chromium, starts a strict local Studio Vite server, captures both
densities serially, and closes browser/server in `finally`. If Puppeteer lives
elsewhere, set `PUPPETEER_MODULE` to its existing ESM package entry; the script
does not install a browser or dependency.

## Historical issue #305 evidence

`decision-prototype/` preserves the earlier equal-per-hill, six-point spine,
tool-width LOD, and hill-only occlusion prototype as historical architecture
evidence. It is not a production reference or an acceptable fidelity contract;
issue #309 superseded it.
