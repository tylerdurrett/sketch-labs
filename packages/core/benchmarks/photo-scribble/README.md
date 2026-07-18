# Photo Scribble browser-review protocol — issue #336

This directory freezes the inputs and decision rule for the final managed-photo
review. `fixtures.json` is the byte-level inventory; `protocol.json` is the
machine-readable frame, parameter, capture, threshold, and limit-candidate
contract. Observations belong under `results/` and must identify the protocol
and fixture manifest hashes they used.

No new image is needed. The committed opaque flowers cover an ordinary photo
and a `3:4` source in a square frame. The dark alpha pinecone covers Tone
adjustment, a `2:3` source, 276,857 fully transparent pixels, and 2,860 partial
alpha pixels. Both are existing maintainer-supplied project fixtures. History
does **not** record an external source, original-capture attribution, license,
or explicit redistribution statement, so the inventory deliberately makes no
stronger ownership claim. Do not download or substitute third-party material.

## Fixed matrix

Every scenario uses the `1000 × 1000` Composition Frame and `200 × 200 mm`
profile in `protocol.json`. Parameters and both seeds are literal protocol
inputs; do not tune them during measurement.

- `flowers-opaque-control`: ordinary opaque, mismatched aspect, and full
  workflow control.
- `pinecone-dark-alpha-control`: dark/Tone, partial and hard alpha,
  mismatched aspect, and full workflow control.
- `flowers-opaque-fine` and `pinecone-dark-alpha-fine`: the same effective
  targets at `pathDensity: 20` and `scribbleScale: 0.1`, used only for the
  ordered safety-limit comparison.

For each scenario, name captures `<captureStem>--<captureSuffix>`, using the
stem and complete suffix list in `protocol.json`. A capture is absent only when
`metrics.json` records `not-applicable` and why. `metrics.json` records browser
and OS versions, frame, params, seed, candidate tuple, termination, residual,
stop guard, accepted segments, polylines/points/bytes, compute time, heartbeat
gaps, interaction probes, cancellation latency, terminal-to-display latency,
export hashes/counts, and memory samples when the browser exposes them. Keep
paths repository-relative; never record a home directory or picker path.

## Trial isolation and cleanup

Before starting Studio, snapshot `git status`, the two fixture hashes, and the
names plus hashes under `assets/image-assets/` and
`packages/core/src/sketches/photo-scribble/presets/`. Retain that snapshot with
the raw observations outside git until review is accepted.

All temporary asset filenames, import names, Preset names, and captures start
with exactly `issue-336-trial-`. To exercise import without risking either
committed asset, stage a byte-identical copy outside the repository under that
prefix and select the staged copy. Never overwrite or rename the inventory
paths.

After the attestation is decided, stop Studio and remove only files that both
(a) were absent from the pre-run snapshot and (b) start with the exact prefix.
Re-hash the inventory and compare `git status` with the snapshot. Any changed
pre-existing file or any unprefixed trial artifact fails cleanup and must be
restored from the snapshot before evidence is accepted. Promote only reviewed
observations/captures into `results/`; trial Image Assets and Presets never
become fixtures by accident.

## Manual workflow pass

Run the two control scenarios in a production Studio browser, serially:

1. Import the prefixed staged copy, confirm normalized persistence, stable-ID
   selection, name/thumbnail reuse, reload, and no machine-local path in UI or
   saved data. Return to the inventory asset before fixed captures.
2. Capture Tone at centered `0.5 / 0.5` and at the authored values. Increasing
   either control must be monotonic at fixed probes; centered values are
   identity; fully transparent permission and exact zero tone remain zero.
3. Set the primary seed, wait for settlement, then re-seed. Tone and permission
   hashes must remain identical while routing and Fill geometry visibly change.
4. During a fresh realistic job, make three inspector/control interaction
   probes, start a superseding edit, and cancel once. Retained geometry must be
   labeled stale until the latest result settles; progress is monotonic, ETA is
   explicitly estimating or remaining, and cancellation produces no late
   replacement.
5. Save a prefixed Preset, reload the page, and load it. Asset ID, params, seed,
   Tone hash, termination/residual, and generated geometry hash must match the
   pre-reload record exactly. Separately load a prefixed Preset with a missing
   asset ID; it must fail closed, name the missing asset, export nothing, and
   recover after selecting the exact inventory asset.
6. Capture Tone reference, Fill, Outline, ordinary PNG/SVG, and plotter SVG.
   Source pixels and diagnostic imagery must be absent from every export.
   Fill, Outline, and both SVG paths must originate from the acknowledged
   completed geometry; hashes/counts record exact reuse or the named,
   deterministic output transform.

The flowers and pinecone must contain-fit without cropping. Blank square-frame
bands are exactly unplottable. The pinecone's fully transparent area admits no
segment; partial alpha produces soft permission rather than a binary edge.

## Named visual attestation

Generated metrics never write reviewer identity or verdict. A separate dated
attestation names the reviewer and records `better`, `equal`, or `worse` for
each candidate against `current-fine-baseline` on every criterion:

- `tone-target-faithfulness`: light/dark structure follows the Tone reference;
  zero target remains paper.
- `routing-legibility`: added work resolves photographic structure instead of
  producing visibly aimless tangles.
- `letterbox-permission`: no mark enters a contain-fit band.
- `alpha-permission`: no mark enters full transparency and partial alpha keeps
  a visibly soft boundary.
- `geometry-and-export-parity`: Fill, Outline, and exports represent the same
  acknowledged result without missing or invented regions.
- `plot-readiness`: at the fixed physical profile, added density preserves or
  improves coherent, drawable detail.

`equal` means no reviewer-visible regression at original capture resolution
and at the fixed physical size. A single `worse` verdict fails that candidate.

## Predeclared adoption rule

Run `current-fine-baseline` first for both fine scenarios, then the remaining
tuples in listed order. Later candidates are optional once one passes. For
baseline residual `r0` and candidate residual `rc`, relative improvement is
`(r0 - rc) / r0`. If `r0` is zero, the case is already converged and later
candidates must also converge.

A candidate passes only when all of the following hold for both fine scenarios:

- it terminates as `completed`, **or** its residual improvement is at least the
  frozen `0.20` threshold;
- all six named visual verdicts are `equal` or `better`;
- no job exceeds 300,000 ms, no non-terminal progress heartbeat gap exceeds
  1,000 ms, each of three main-thread interaction round trips is at most 250
  ms, cancellation acknowledges within 500 ms, and terminal progress reaches
  displayed completion within 5,000 ms;
- there is no browser/worker crash, OOM, invalid Canvas state, protocol or
  structured-clone failure, export failure, partial download, or source/diagnostic
  pixels in output;
- determinism, permission, Preset reload, and output parity checks above pass.

Adopt the **first** passing tuple in `orderedLimitCandidates`; never choose a
larger tuple for extra residual improvement. If none passes, retain the current
production limits and record the failure rather than relaxing a threshold after
measurement. A tone/default/normalization change uses the same control pass and
may be promoted only with a named before/after metric or attestation; this
protocol does not pre-authorize such a change.

Run the manifest guard from the repository root:

```sh
apps/studio/node_modules/.bin/vitest run \
  packages/core/benchmarks/photo-scribble/protocol.test.js
```
