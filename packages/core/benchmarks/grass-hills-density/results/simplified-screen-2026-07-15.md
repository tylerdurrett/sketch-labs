# Simplified Grass Hills screen — 2026-07-15

This Y3a screen compares one representation—open six-point blades grouped into
stable five-member tufts—across four processing variants. It deliberately uses
only the literal historical 400-blade baseline and one-hill 5k fixture. It is
not the full campaign and does not change production code.

The compact machine-readable summary and selection is in
[`simplified-screen-2026-07-15.json`](simplified-screen-2026-07-15.json). The
complete protocol envelope is retained verbatim in
[`simplified-screen-2026-07-15.campaign-raw.json`](simplified-screen-2026-07-15.campaign-raw.json),
including every timed sample, memory snapshot, HLR reference workload, clipping,
SVG, plotter, Canvas, and detailed spacing measurement. The complete browser
envelope is retained verbatim in
[`simplified-screen-2026-07-15.browser-raw.json`](simplified-screen-2026-07-15.browser-raw.json),
including all 12 redraw samples for each of 16 source/processed observations.

## Policy and outcome

- Mode: `screen`; 90-second deadline and 1 GiB RSS ceiling per child.
- Samples: 3 preparation, 3 cold, 12 warm, plus 1 unreported warmup.
- Jobs: 4 processing variants × 2 fixtures = 8.
- Result: 8 complete, 0 censored.
- Browser: actual core `drawSceneFitted` on a 1000 × 1000 Canvas2D context;
  source and processed Scenes were checksum-verified before first draw and 12
  redraws each.

The 5k preparation/cold operation medians were about 2.3 seconds. Those medians
cover only the timed candidate operation. Each child also performs the warmup,
explicit GC and memory snapshots around every sample, and three fresh
post-measurement materializations for inspection. That repeated work accounts
for the previously observed roughly 23–30-second end-to-end child time even
though the sum of reported timed operations is about 14 seconds. The structured
censoring path remained enabled; no child reached it.

## Measured comparison

Times are medians in milliseconds. `root min` and `clearance p50` are physical
millimeters; the pinned fineliner width is 0.30 mm. Browser columns describe the
processed Scene.

| Fixture | Occluders | Density | Prep | Cold | Warm | Max RSS MiB | Process ms | Paths | Root min mm | Clearance p50 mm | Colliding path pairs | Load ms | First draw ms | Redraw ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline 400 | hill | same | 185.7 | 183.7 | 4.0 | 154.1 | 3.6 | 395 | 0.056 | 0.288 | 115 | 4.3 | 0.3 | 0.2 |
| one-hill 5k | hill | same | 2193.8 | 2236.9 | 11.9 | 194.3 | 9.6 | 5000 | 0.038 | 0.241 | 3514 | 18.0 | 1.0 | 1.0 |
| baseline 400 | hill | plotter LOD | 181.8 | 184.6 | 3.4 | 145.8 | 3.2 | 320 | 0.303 | 0.472 | 28 | 2.1 | 0.1 | 0.1 |
| one-hill 5k | hill | plotter LOD | 2222.3 | 2245.7 | 11.7 | 186.1 | 10.4 | 4863 | 0.302 | 0.260 | 3174 | 16.9 | 1.0 | 1.0 |
| baseline 400 | hill + clump | same | 184.0 | 198.2 | 4.8 | 175.2 | 4.8 | 395 | 0.056 | 0.288 | 115 | 2.1 | 0.1 | 0.1 |
| one-hill 5k | hill + clump | same | 2243.1 | 2267.0 | 35.0 | 200.6 | 30.0 | 2994 | 0.038 | 0.334 | 959 | 8.6 | 0.6 | 0.6 |
| baseline 400 | hill + clump | plotter LOD | 184.1 | 191.6 | 4.3 | 154.0 | 3.8 | 320 | 0.303 | 0.472 | 28 | 1.7 | 0.2 | 0.1 |
| one-hill 5k | hill + clump | plotter LOD | 2228.7 | 2284.7 | 33.6 | 202.2 | 34.0 | 2950 | 0.302 | 0.340 | 903 | 9.1 | 0.6 | 0.5 |

All four variants produced the same source checksum for a given fixture. The 5k
source is 5,000 primitives / 30,000 points with checksum
`4d84d096c90f1be0b1d081bc6b377a6dd65db700409f3bc6d15c009a0dc4719f`.
The selected processed Scene is 2,950 primitives / 14,548 points with checksum
`5a1fb74ae8d486af03d8878fb07f75011e706cc26272e547cc69993c5194cf97`.

## Visual screen

All eight processed Scenes were inspected sequentially in the actual browser
harness. The 400-blade baseline remains intentionally sparse. Every 5k variant
reads as grass-covered hilly terrain. Hill-only output is darkest but retains
many sub-nib overlaps. Clump masks remove about 40% of the paths while keeping
the silhouette. At 1000 × 1000, same-density and plotter-LOD clump output are
visually indistinguishable, while only plotter LOD guarantees nib-width root
spacing. Temporary validation captures were removed after inspection.

## Decision

Select exactly one simplified finalist:

> **Open six-point blades / stable five-member tufts with `hill-and-clump`
> occluders and `plotter-lod` density.**

It preserves the deterministic source Scene, retains the intended grass/hill
read, reduces the 5k processed output from 5,000 to 2,950 paths, raises minimum
root spacing from 0.038 mm to 0.302 mm, lowers colliding path pairs from 3,514 to
903, and gives a 0.5 ms median Canvas redraw. Its roughly 34 ms processing cost
is an accepted screen-stage tradeoff beside the roughly 2.3-second generation
operation. This is screen evidence only; a full matrix or production adoption
requires a separate explicit decision.

## Reproduction

From the repository root:

```sh
node packages/core/benchmarks/grass-hills-density/bundle-cli.js \
  --entry=packages/core/benchmarks/grass-hills-density/simplified-candidate.js \
  --out=/tmp/grass-hills-simplified-y3a.mjs

cd packages/core
GRASS_HILLS_SIMPLIFIED_BUNDLE_URL=file:///tmp/grass-hills-simplified-y3a.mjs \
  node benchmarks/grass-hills-density/cli.js --mode=screen \
  --config=./benchmarks/grass-hills-density/simplified-screen-config.js \
  > /tmp/grass-hills-simplified-y3a-screen.json
cd ../..

GRASS_HILLS_SIMPLIFIED_BUNDLE_URL=file:///tmp/grass-hills-simplified-y3a.mjs \
  node packages/core/benchmarks/grass-hills-density/simplified-browser-cli.js \
  --out=packages/core/benchmarks/grass-hills-density/browser/.simplified-screen

apps/studio/node_modules/.bin/vite \
  --config packages/core/benchmarks/grass-hills-density/browser/vite.config.js \
  --port 4316 --strictPort

node .claude/skills/chrome-devtools/scripts/evaluate.js \
  --url http://127.0.0.1:4316/ \
  --script "globalThis.__GRASS_HILLS_DENSITY_BENCHMARK__.screenScenes('./.simplified-screen/manifest.json', { redraws: 12 })" \
  > /tmp/grass-hills-simplified-y3a-browser.json

node packages/core/benchmarks/grass-hills-density/simplified-screen-report.js \
  --node=/tmp/grass-hills-simplified-y3a-screen.json \
  --browser=/tmp/grass-hills-simplified-y3a-browser.json \
  --out-dir=packages/core/benchmarks/grass-hills-density/results
```

The browser artifact directory and generated candidate bundle are temporary and
must not be committed. The generator copies both raw inputs byte-for-byte into
the results directory and derives the compact summary from them. Port 4316 was
the exact screen port because the configured 4315 was already occupied; any
explicitly controlled local port is equivalent.
