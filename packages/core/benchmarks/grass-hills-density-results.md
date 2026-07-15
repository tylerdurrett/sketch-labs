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

The initial benchmark is intentionally an opt-in smoke check: it generates and
processes the fixture once, reports those one-shot local timings, and asserts the
pinned inventory. It is not a statistically meaningful runner. Later issue #305
work may add explicit measurement modes without weakening this baseline.
