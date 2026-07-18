# Photo Scribble machine-ceiling decision — issue #336

The largest fully passing tuple is **1,000,000 accepted segments / 16,000
polylines / 32,000 stagnations / 16,000 restarts**. The 500k and 1m campaigns
both completed both fine scenarios through the real coordinator and worker. The
first 2m job then crossed the 300-second operation boundary and remained hung
for 366.732 seconds before Puppeteer's own protocol timeout returned. That is
the first hard boundary, so 4m and 8m were not run.

This selection follows the maintainer's machine-ceiling override. Residual,
visual, and heartbeat values are observations, not adoption gates. Production
defaults are intentionally unchanged in this evidence change.

## Fully passing tuples

| Tuple | Scenario | Worker compute | Coordinator result | Instrumented envelope | Residual | Result bytes | Page heap after |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 500k / 16k / 32k / 16k | Flowers | 13,850.6 ms | 14,420.1 ms | 15,275.3 ms | 0.447848646 | 76,867,824 | 307,846,353 |
| 500k / 16k / 32k / 16k | Pinecone | 9,040.7 ms | 9,237.7 ms | 10,123.5 ms | 0.107489742 | 19,093,567 | 144,319,620 |
| 1m / 16k / 32k / 16k | Flowers | 27,338.9 ms | 28,490.9 ms | 29,331.7 ms | 0.402586458 | 153,737,102 | 415,059,064 |
| 1m / 16k / 32k / 16k | Pinecone | 18,298.2 ms | 19,066.9 ms | 19,912.4 ms | 0.062259759 | 86,470,358 | 343,364,856 |

All four runs bound only `accepted-segment-limit`. Their polyline, stagnation,
and restart counters remained well below 16k/32k/16k, so those three guards
were not raised. Identity, production resolver, Scene, diagnostics, ordinary
SVG geometry, Outline Scene, and plotter SVG geometry checks all matched.
Canvas and export checks completed. Every captured PNG is the exact 1000×1000
Canvas output, and its artifact SHA-256 equals the SHA-256 measured in-page.

The direct coordinator cancellation probe passed after non-terminal progress in
all four runs. It does not exercise a superseding Studio control edit and makes
no claim about `#control-chaos` stale-result behavior.

## 2m hard boundary

The Flowers 2m job started at `2026-07-18T23:31:14.256Z`. No raw job outcome or
checkpoint was durable while it remained externally hung beyond six minutes.
At `2026-07-18T23:37:20.988Z`, 366.732 seconds after start, Puppeteer surfaced
`Runtime.callFunctionOn timed out`; only then did the old host write the failed
raw record and checkpoint.

The old runner incorrectly treated that protocol timeout as a generic failure
and continued to the Pinecone job, which completed. That post-boundary record is
preserved immutably but is excluded from selection: the tuple had already hit a
hard boundary and did not fully pass both scenarios. Termination was requested
after the six-minute observation, but the host had just returned and completed
before the interrupt arrived.

The runner is corrected separately with an outer host watchdog so a
never-settling browser boundary produces a durable failure/checkpoint and
cleanup without waiting for the browser channel.
