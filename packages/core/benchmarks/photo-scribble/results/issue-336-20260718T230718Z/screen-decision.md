# Photo Scribble fine-budget screen decision — issue #336 (superseded)

This decision is not adoption authority. On 2026-07-18 the maintainer explicitly
overrode its residual, visual, and heartbeat gates and required a machine-ceiling
campaign. Stopping before 500k/1m was not authorized by the original protocol's
“if none passes” rule. The raw records remain immutable observations.

The exact frozen six-job prefix ran serially in Chromium through the real
`ScribbleCoordinator` and a fresh real DedicatedWorker per operation. No
candidate survives, so the current production limits remain unchanged and the
500k/1m candidates were not run.

The earlier `issue-336-20260718T225430Z` campaign remains immutable valid
compute-only evidence. This campaign supersedes it for the decision because it
adds canonical target hashes, named Tone/Fill/Outline captures, Canvas and
export checks, cancellation/latest-result evidence, and terminal-display
anchors.

## Quantitative result

| Candidate | Flowers residual | Flowers improvement | Pinecone residual | Pinecone improvement | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| current-fine-baseline | 0.488620747 | baseline | 0.148269259 | baseline | reference |
| fine-100k | 0.484086089 | 0.928% | 0.143725942 | 3.064% | fail |
| fine-250k | 0.470498258 | 3.709% | 0.130109558 | 12.248% | fail |

Every run terminated `budget-exhausted`, with
`bindingGuard: accepted-segment-limit`. Each accepted exactly its segment cap;
all polyline, stagnation, and restart counters remained non-binding. Both
larger tuples miss the frozen 20% residual-improvement requirement in both
scenarios.

## Operational and output evidence

- All six jobs completed without browser/Worker crash, OOM, invalid Canvas
  state, protocol error, structured-clone failure, or export failure.
- Production-resolved tuple equivalence passed identity, Scene, and diagnostics
  hashes for every job.
- Target hashes stayed fixed by scenario across all candidates:
  flowers `1f3698a6fe91a53046fed7178b25ff09184db28a90ed367c466bfa77e48dd7bd`;
  pinecone `96738e63053982deb8f7b0afd042311f827b88280434024ad17e086826b72008`.
- Canvas PNG, ordinary SVG, Outline, and plotter SVG completed for every run.
  Geometry/export parity passed; SVG checks found no raster source or diagnostic
  marker in output. The largest ordinary SVG was 18,734,386 bytes and the
  largest plotter SVG was 17,715,627 bytes.
- Cancellation began after a non-terminal heartbeat, acknowledged as
  `cancelled`, and produced no late replacement in every run. Recorded
  coordinator cancellation round trips were below timer resolution (`0 ms`).
- Terminal progress reached the displayed Fill in 984.6–1517.3 ms, below the
  frozen 5000 ms limit. Page-main-process heap samples remained below the
  exposed 4.1 GiB limit; Worker heap remains unavailable by browser contract.
- The isolated budget page has no Studio inspector, so the three fixed inspector
  round trips are explicitly `not-applicable` here and remain promotion-control
  checks. No candidate reached promotion eligibility.

Heartbeat correction: actual between-progress gaps were at most 111 ms. The
previously reported 1037.8–1370.5 ms maxima were entirely the
terminal-progress-to-final-response interval, inflated by benchmark-only target
hashing and artwork serialization after terminal progress. They are instrumented
observer overhead, not a production responsiveness failure.

## Visual decision

The separate `visual-attestation.md` records all six named criteria. The 100k
candidate has no visible regression but cannot overcome the quantitative and
heartbeat gates. The 250k candidate is additionally rejected for worse plot
readiness in both scenarios and worse routing legibility on the pinecone.

Historical result: no production-limit change. The omitted 500k/1m work is now
superseded by the maintainer-authorized machine-ceiling series.
