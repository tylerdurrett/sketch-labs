# Simplified Grass Hills screen — 2026-07-15

This Y3a screen compares one representation—open six-point blades grouped into
stable five-member tufts—across four processing variants. It deliberately uses
only the literal historical 400-blade baseline and one-hill 5k fixture. It is
not the full campaign and does not change production code.

The machine-readable evidence, including complete metrics, checksums, runtime
metadata, and all 16 browser observations, is in
[`simplified-screen-2026-07-15.json`](simplified-screen-2026-07-15.json).

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
| baseline 400 | hill | same | 194.0 | 191.3 | 4.3 | 160.4 | 3.8 | 395 | 0.056 | 0.288 | 115 | 3.9 | 0.3 | 0.2 |
| one-hill 5k | hill | same | 2286.3 | 2316.8 | 13.0 | 203.4 | 11.8 | 5000 | 0.038 | 0.241 | 3514 | 17.9 | 1.1 | 1.1 |
| baseline 400 | hill | plotter LOD | 189.7 | 191.0 | 3.6 | 157.5 | 3.3 | 320 | 0.303 | 0.472 | 28 | 1.9 | 0.1 | 0.1 |
| one-hill 5k | hill | plotter LOD | 2291.3 | 2312.8 | 12.4 | 207.6 | 9.6 | 4863 | 0.302 | 0.260 | 3174 | 15.8 | 0.9 | 1.0 |
| baseline 400 | hill + clump | same | 188.1 | 193.8 | 5.1 | 163.4 | 5.0 | 395 | 0.056 | 0.288 | 115 | 3.2 | 0.1 | 0.1 |
| one-hill 5k | hill + clump | same | 2267.6 | 2313.5 | 36.6 | 201.8 | 32.9 | 2994 | 0.038 | 0.334 | 959 | 8.9 | 0.5 | 0.6 |
| baseline 400 | hill + clump | plotter LOD | 189.4 | 193.3 | 5.5 | 164.6 | 4.0 | 320 | 0.303 | 0.472 | 28 | 1.9 | 0.0 | 0.1 |
| one-hill 5k | hill + clump | plotter LOD | 2263.0 | 2296.4 | 37.1 | 196.1 | 33.7 | 2950 | 0.302 | 0.340 | 903 | 8.6 | 0.6 | 0.6 |

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
903, and gives a 0.6 ms median Canvas redraw. Its roughly 34 ms processing cost
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
  > /tmp/grass-hills-simplified-y3a-report.json
```

The browser artifact directory and generated candidate bundle are temporary and
must not be committed. Port 4316 was the exact screen port because the configured
4315 was already occupied; any explicitly controlled local port is equivalent.
