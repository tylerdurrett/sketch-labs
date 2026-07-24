# Flowing Contours performance campaign

This benchmark pins the default Flower and Pinecone workloads used by issue
#403. It measures the headless phases in Node and the exact generator plus the
shared Canvas renderer in a production bundle under pinned Chrome.

## Commands

From the repository root:

```sh
FLOWING_CONTOURS_BENCHMARK_SAMPLES=5 \
FLOWING_CONTOURS_BENCHMARK_WARMUPS=1 \
packages/core/node_modules/.bin/vitest run \
  --config packages/core/vitest.flowing-contours-benchmark.config.ts

node packages/core/benchmarks/flowing-contours-browser-cli.js --samples=3
node packages/core/benchmarks/flowing-contours-browser-cli.js --profile=pinecone
node packages/core/benchmarks/flowing-contours-browser-cli.js \
  --profile=pinecone \
  --precise-call-coverage
```

The Node benchmark refuses any result whose complete Scene-plus-diagnostics
checksum changes. The Chrome probe additionally pins the submitted Scene, the
1000 × 1000 pixel readback, primitive count, and point count. Browser timing
alternates Flower/Pinecone order between samples. The optional named-function
CDP profile is diagnostic and intentionally unminified; ordinary browser timing
uses a minified production bundle. `--precise-call-coverage` requires a named
`--profile` case and adds `callCoverage.aggregated` totals plus source-line
entries in `callCoverage.functions`. Each named profile now refuses output,
pixel, primitive-count, or point-count drift before returning evidence.

Precise V8 coverage disables some normal JIT optimization and materially slows
the workload. Use its integer call counts to reproduce amplification only; do
not compare its observation timings, CPU-profile duration, or sampled shares
with ordinary profile or benchmark results. The recorded closeout used
Headless Chrome 144 on macOS with 12 logical CPUs. Function counts are
deterministic for the pinned fixture and controls, while source line numbers
may move as the bundle changes.

## Baseline

Revision `117cb0d` (correctness revision `34bc26c` plus signed-direct follow-up
`0da7ff6`), macOS, 12 logical CPUs, Node 23.9.0 / Vitest 1.6.1:

| Workload / phase | median | p95 | n |
| --- | ---: | ---: | ---: |
| Flower raster preparation | 4.91 ms | 7.17 ms | 3 |
| Flower field ensemble | 402.53 ms | 421.98 ms | 3 |
| Flower whole-curve pipeline | 30,284.95 ms | 30,340.36 ms | 3 |
| Flower end-to-end generation | 30,123.77 ms | 30,143.25 ms | 3 |
| Pinecone raster preparation | 3.25 ms | 3.90 ms | 3 |
| Pinecone field ensemble | 310.02 ms | 312.19 ms | 3 |
| Pinecone whole-curve pipeline | 7,533.89 ms | 8,806.58 ms | 3 |
| Pinecone end-to-end generation | 7,732.74 ms | 7,735.07 ms | 3 |

The n=3 run was recorded on `34bc26c`; an n=1 parity run after `117cb0d`
retained the exact checksums, work inventories, and timing class: Flower
31,147.64 ms end-to-end and Pinecone 7,815.75 ms.

Exact Node output gates:

| Workload | SHA-256 | anchors | candidates | accepted | Scene points |
| --- | --- | ---: | ---: | ---: | ---: |
| Flower | `5cca872ad48b725449bd8575ddfac8c01ba248ccbd5fc5e6917d40929ee4bdd1` | 1,184 | 852 | 111 | 1,399 |
| Pinecone | `0fab1114c582b8a20d4afb26722884b2cde4f70e6f8e9b17b43362c5a78181ec` | 428 | 304 | 27 | 321 |

Pinned headless Chrome 144, minified production bundle, 1000 × 1000 Canvas:

| Workload / browser observation | median | p95 | n |
| --- | ---: | ---: | ---: |
| Flower generation | 26,732.60 ms | 27,359.60 ms | 3 |
| Flower Canvas command submission | 0.20 ms | 8.30 ms | 3 |
| Flower forced full-canvas readback | 1.60 ms | 1.60 ms | 3 |
| Flower edit-handler blocking | 26,734.40 ms | 27,369.50 ms | 3 |
| Flower 50 ms heartbeat delay | 26,685.30 ms | 27,320.80 ms | 3 |
| Pinecone generation | 7,299.10 ms | 7,302.70 ms | 3 |
| Pinecone Canvas command submission | 0.10 ms | 0.10 ms | 3 |
| Pinecone forced full-canvas readback | 1.30 ms | 1.30 ms | 3 |
| Pinecone edit-handler blocking | 7,300.50 ms | 7,304.10 ms | 3 |
| Pinecone 50 ms heartbeat delay | 7,251.00 ms | 7,254.60 ms | 3 |

Every browser observation produced one Long Task spanning essentially the full
handler. Canvas submission and forced raster completion are negligible beside
generation; the current user-visible freeze is core work running synchronously
in Studio's static-Fill edit path.

## Targets and gates

- Preserve the exact Node and Chrome output checksums, diagnostics/work counts,
  pixel checksums, control semantics, and deterministic ordering.
- Move generation off the main thread with latest-input-wins cancellation; main
  thread edit-handler p95 must be below 50 ms.
- Reduce completion p95 below 5 seconds for Flower and 2 seconds for Pinecone,
  then continue only while a safe candidate is expected to clear the 5%
  minimum worthwhile gain.
- Retain a candidate only when its median gain repeats, p95 does not regress,
  and focused tests, broader tests, and typechecks remain green.

## Ranked falsifiable hypotheses

1. `search.ts` performs a full 9-plane, 43–49k-sample `hasValidField` scan for
   every anchor search and again for guide-to-local certification. CDP sampling
   ranks it first. Brand or memoize a successfully validated immutable field,
   while retaining fail-closed validation at untrusted boundaries. Prediction:
   the pipeline and end-to-end medians improve well beyond 5% with exact output.
2. Each anchor/certification repeatedly snapshots the same already-validated
   limits and defensive inputs, allocating and freezing short-lived records.
   Add a pipeline-private trusted path after one public-boundary validation.
   Prediction: another repeatable >=5% pipeline gain and lower GC sampling,
   without weakening the public hostile-input contract.
3. Every accepted curve snapshots its trajectory, rebuilds cross-hypothesis
   suppression projections, canonicalizes occupancy with decimal strings, and
   reconstructs spatial indexes. Preserve immutable structural sharing and
   increment only new occupancy. Prediction: the gain grows with Flower's 111
   accepted curves and clears 5% there without changing suppression answers.
4. Guide hypotheses are searched and then locally recertified with repeated
   field sampling. Cache exact local samples/certificates within one candidate
   audition. Prediction: guide-heavy cases improve >=5% while candidate and
   provenance inventories remain byte-exact.
5. Regardless of total compute wins, a cancellable Flowing Contours preparation
   worker should remove the 7–27 second Long Tasks. Prediction: edit dispatch
   and stale-job cancellation remain below 50 ms p95 while completed worker
   output matches the synchronous checksum exactly. This is a responsiveness
   win, not evidence of faster generation, and must be reported separately.

The five-plane Gaussian field build is currently only about 0.3–0.4 seconds, so
it is not an initial optimization target. Re-profile it after the pipeline
dominance is removed.

## Campaign results

All retained and rejected experiments preserved the exact Node and Chrome
checksums and work inventories above. Percentage changes are reductions unless
marked as regressions. The field-authentication and fused-tube rows report
separate n=3 comparisons at their respective experiment boundaries; the worker
row is a responsiveness result and is not counted as a core-compute win.

| Candidate | Flower result | Pinecone result | Decision |
| --- | --- | --- | --- |
| Authenticate production fields after one public-boundary validation | pipeline median 15.28%; end-to-end median 12.59%; no p95 regression | pipeline median 18.74%; end-to-end median 16.25%; end-to-end p95 16.07% | Retain |
| Elide duplicate fair-proof work | end-to-end median 4.65% | end-to-end median 0.94% | Reject: below the 5% worthwhile threshold in both cases |
| Fuse tube evidence sampling | pipeline median 24,058.13 → 18,977.90 ms (21.12%), p95 25,379.33 → 22,191.16 ms (12.56%); end-to-end median 24,500.28 → 19,232.75 ms (21.50%), p95 25,813.60 → 19,311.50 ms (25.19%) | pipeline median 5,935.54 → 4,292.20 ms (27.69%), p95 6,122.90 → 4,345.19 ms (29.03%); end-to-end median 6,112.36 → 4,690.64 ms (23.26%), p95 8,292.40 → 4,692.74 ms (43.41%) | Retain |
| Replace scalar-distance proof records with scalars | end-to-end median 19,263.11 → 17,922.48 ms (6.96%), p95 19,331.32 → 18,069.91 ms (6.53%) | end-to-end median 4,629.97 → 4,256.05 ms (8.08%), but p95 4,635.15 → 5,398.65 ms (16.47% regression) | Reject: Pinecone p95 gate failed |
| Move generation to a latest-input-wins worker | edit handlers at or below 0.1 ms; heartbeat p95 at or below 13 ms | edit handlers at or below 0.1 ms; heartbeat p95 at or below 13 ms | Retain as responsiveness architecture |

## Final retained core

Revision `42f1966` includes field authentication, fused tube sampling, and the
Studio worker integration. The final Node run used one warmup and n=5 measured
samples:

| Workload / phase | median | p95 | change from baseline median | change from baseline p95 |
| --- | ---: | ---: | ---: | ---: |
| Flower raster preparation | 3.71 ms | 4.88 ms | 24.44% | 31.94% |
| Flower field ensemble | 403.14 ms | 429.65 ms | 0.15% regression | 1.82% regression |
| Flower whole-curve pipeline | 18,667.95 ms | 18,708.43 ms | 38.36% | 38.34% |
| Flower end-to-end generation | 19,246.79 ms | 19,544.00 ms | 36.11% | 35.16% |
| Pinecone raster preparation | 2.51 ms | 4.10 ms | 22.77% | 5.13% regression |
| Pinecone field ensemble | 305.45 ms | 336.52 ms | 1.47% | 7.79% regression |
| Pinecone whole-curve pipeline | 4,321.41 ms | 4,355.86 ms | 42.64% | 50.54% |
| Pinecone end-to-end generation | 4,666.49 ms | 4,688.76 ms | 39.65% | 39.38% |

Small preparation-phase p95 movement is immaterial to the retained candidate
gate: the expensive pipeline and end-to-end p95 values improve substantially,
and exact outputs remain unchanged.

Worker instrumentation separated wall time from worker compute:

| Revision / workload | wall completion | worker compute |
| --- | ---: | ---: |
| Before retained core wins / Flower | 27,123.1 ms | 27,047.9 ms |
| Before retained core wins / Pinecone | 9,524.8 ms | 9,417.0 ms |
| Integrated retained core / Flower | 16,581.7 ms | 16,515.4 ms |
| Integrated retained core / Pinecone | 5,663.8 ms | 5,575.1 ms |

The worker does not make computation free, but it removes generation from the
UI edit handler: handler observations were at or below 0.1 ms and heartbeat p95
was at or below 13 ms, versus baseline Long Tasks of 7–27 seconds.

## Target status

| Target | Status | Evidence |
| --- | --- | --- |
| Preserve output, diagnostics, ordering, and controls | Met | Node Scene-plus-diagnostics, Chrome Scene, pixel, primitive, and point-count gates stayed exact |
| Latest-input-wins worker and main-thread edit-handler p95 below 50 ms | Met | handler observations <= 0.1 ms; heartbeat p95 <= 13 ms |
| Flower completion p95 below 5 seconds | Not met | final Node end-to-end p95 19,544.00 ms; integrated worker compute observation 16,515.4 ms |
| Pinecone completion p95 below 2 seconds | Not met | final Node end-to-end p95 4,688.76 ms; integrated worker compute observation 5,575.1 ms |
| Continue only for safe candidates expected to clear 5% without p95 regression | Met: stop | residual profile and rejected experiments leave no qualifying cross-workload candidate |

## Residual profile and closeout

An uninstrumented named-function CDP profile of the retained core recorded
16,702.50 ms / 11,254 samples for Flower and 4,537.04 ms / 3,065 samples for
Pinecone. In the original Pinecone profile, `hasValidField` accounted for
10.83% of sampled self time. It no longer appears among the retained profile's
top 25 functions. Precise call coverage explains the removed amplification:

| Function | Flower calls | Pinecone calls |
| --- | ---: | ---: |
| `searchFlowingContoursCandidateDetailed` | 1,184 | 428 |
| `certifyFlowingContoursCandidateAgainstField` | 576 | 213 |
| `hasValidField` | 1,760 | 641 |
| `evaluate` | 8,511,347 | 2,387,400 |
| `sampleFlowingContoursEvidenceInto` | 8,246,184 | 2,315,047 |
| `locateArc` | 8,109,661 | 2,282,064 |
| `segmentDistance` | 46,661,555 | 14,424,413 |
| `canonicalNumber` | 10,896,360 | 563,916 |
| `occupancyKey` | 2,724,090 | 140,979 |

Before authentication, every `hasValidField` call scanned all planes and
samples. The retained path preserves the same call boundary but answers it from
the field's authenticated state. Reproduce either workload with the documented
`--profile=<case> --precise-call-coverage` command and read
`callCoverage.aggregated`; the command exact-gates the Scene and rendered
pixels. Precise coverage materially slows execution, so its timing and sampled
shares are deliberately excluded; only its exact call counts are retained
here.

The remaining hotspots are workload-specific. Pinecone's `gaussianSmooth`
self time is 5.02%, but it is only 1.52% for Flower and the complete Flower
field phase is only about 2.1% of final end-to-end time. Flower instead spends
6.39% in `canonicalNumber`, at least 3.01% in `occupancyKey`, and additional
time rebuilding suppression state; those costs are much smaller in Pinecone.
The common tube-proof work is distributed across `evaluate`,
`sampleFlowingContoursEvidenceInto`, `locateArc`, and `segmentDistance` after
the retained fusion, and further removal changes proof semantics.

There is therefore no remaining exact, safe candidate reasonably expected to
improve both workloads by at least 5% without a p95 regression. The duplicate
fair-proof experiment failed the gain threshold, and the scalar-distance
experiment demonstrated the p95 risk in the next proof-level simplification.
The campaign closes here even though the absolute compute targets remain
unmet. A future campaign may pursue Flower-specific incremental suppression
state, or a broader algorithmic redesign with separately approved output
changes; neither is an exact cross-workload optimization for this campaign.
