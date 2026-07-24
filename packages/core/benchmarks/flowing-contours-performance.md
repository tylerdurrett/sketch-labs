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
```

The Node benchmark refuses any result whose complete Scene-plus-diagnostics
checksum changes. The Chrome probe additionally pins the submitted Scene, the
1000 × 1000 pixel readback, primitive count, and point count. Browser timing
alternates Flower/Pinecone order between samples. The optional named-function
CDP profile is diagnostic and intentionally unminified; ordinary browser timing
uses a minified production bundle.

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
