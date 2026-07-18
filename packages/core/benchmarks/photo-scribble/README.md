# Photo Scribble browser-review protocol — issue #336

This directory freezes the inputs and decision rule for the final managed-photo
review. `fixtures.json` is the byte-level inventory; `protocol.json` is the
machine-readable frame, parameter, capture, threshold, and limit-candidate
contract. Observations belong under `results/` and must identify the protocol
and fixture manifest hashes they used.

`hash-oracles.ts` defines the exact benchmark-only SHA-256 encodings used for
determinism evidence. The target hash contains frame/lattice metadata followed
by every production-model tone, permission, and effective-tone sample in
row-major order. Scene hashes cover the complete Scene IR; diagnostics hashes
cover deterministic scalar diagnostics and deliberately exclude compute time.
A Preset reproduces exactly only when both its Scene and diagnostics hashes
match. These evidence helpers are not exported from `@harness/core`.

Typecheck the hash oracle, its tests, and the production modules they import
from the repository root with the package-local compiler:

```sh
packages/core/node_modules/.bin/tsc \
  -p packages/core/benchmarks/photo-scribble/tsconfig.json
```

This focused project is what enforces the `keyof` inventories in
`hash-oracles.ts`; a new Scene or Scribble diagnostics field fails the command
until its canonical encoding is defined.

## Real-worker evidence page

`apps/studio/photo-scribble-evidence.html` is the benchmark-only Vite entry. It
constructs the real `ScribbleCoordinator` and a fresh real DedicatedWorker for
each run. Worker profile selection travels in the benchmark Worker's name and
raw solver telemetry travels on a run-specific `BroadcastChannel`; the
coordinator still receives only the unchanged strict product protocol.

Build it without running a campaign:

```sh
apps/studio/node_modules/.bin/vite build \
  --config packages/core/benchmarks/photo-scribble/studio-worker.vite.config.ts
```

The page exposes `window.__PHOTO_SCRIBBLE_EVIDENCE__` with `runProduction`,
`runCandidate`, and `runExactEquivalence`. Every call requires a non-empty
`rightsEvidence` identifier and remains blocked while the gate below is
unsatisfied. Exact equivalence runs the registered production generator and an
injected run at the explicitly reported production-resolved four-limit tuple,
then compares the full identity, canonical Scene, and canonical diagnostics
hashes. `performance.memory`, when present, is labeled page/main-process only;
worker heap is unavailable, so duration, geometry counts, serialized bytes,
and response-ready-to-main-receipt latency are recorded as proxies.

The committed opaque flowers cover an ordinary photo and a `3:4` source in a
square frame. The dark alpha pinecone covers Tone adjustment, a `2:3` source,
276,857 fully transparent pixels, and 2,860 partial alpha pixels. Git proves
only when these files entered the repository. Their acquisition, creator,
rights holder, license, and redistribution permission are unknown; committer
identity is not ownership evidence.

The browser campaign is therefore **blocked** until a dated maintainer
attestation confirms ownership and redistribution rights for every selected
fixture, or each unknown fixture is replaced by an owned or compatibly licensed
fixture with recorded provenance. Do not run measurements, adopt limits, add a
binary, or download substitute material while this gate is unsatisfied.

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

Every run records a candidate ID and all four effective limits. Form the tuple
token and evidence paths exactly from `evidenceNaming` in `protocol.json`:

```text
results/<campaignId>/<scenarioId>/<candidateId>--<tupleToken>/
<captureStem>--<candidateId>--<tupleToken>--<captureSuffix>
```

Control runs use candidate ID `production-control` and their actual production
tuple. This makes reruns at different limits collision-proof. A capture is
absent only when that candidate's `metrics.json` records `not-applicable` and
why. Metrics record browser/OS versions, frame, params, seed, complete tuple,
termination, residual, stop guard, accepted segments, polylines/points/bytes,
compute time, every heartbeat timestamp/gap, all fixed interaction probes,
cancellation and terminal-to-display latency, export hashes/counts, and memory
samples when exposed. Keep paths repository-relative; never record a home
directory or picker path.

## Trial isolation and cleanup

Before any write or Studio startup, create a campaign-specific backup directory
outside the repository. Copy the complete byte contents and directory layout of
`assets/image-assets/` and
`packages/core/src/sketches/photo-scribble/presets/` into it, then record `git
status` plus a sorted relative-path/byte-length/SHA-256 manifest. Confirm the
backup files reproduce that manifest before proceeding. Retain the restorable
backup with raw observations until cleanup is verified.

All temporary asset filenames, import names, Preset names, and captures start
with exactly `issue-336-trial-`. To exercise import without risking either
committed asset, stage a byte-identical copy outside the repository under that
prefix and select the staged copy. Never overwrite or rename the inventory
paths.

After review, stop Studio. Restore every pre-existing asset and Preset from the
external byte backup, then remove only new files that were absent from the
manifest and start with the exact prefix. Generate a fresh sorted
relative-path/byte-length/SHA-256 manifest and require byte-for-byte list and
digest equality with the pre-run manifest; compare `git status` too. Any
changed/missing pre-existing byte or unprefixed new artifact fails cleanup.
Promote only reviewed observations/captures into `results/`; trial Image Assets
and Presets never become fixtures by accident.

## Manual workflow pass

Run the two control scenarios in a production Studio browser, serially:

1. Import the prefixed staged copy, confirm normalized persistence, stable-ID
   selection, name/thumbnail reuse, reload, and no machine-local path in UI or
   saved data. Return to the inventory asset before fixed captures.
2. Capture Tone at centered `0.5 / 0.5` and at the authored values. Increasing
   either control must follow the fixed `0 / 0.5 / 1` sweeps at the exact source
   pixels and derived frame points in `measurement.toneSampling`. Sample the
   production Tone Field and Shading Mask directly, without screenshot
   quantization. Centered values equal raw tone; gamma decreases; contrast
   decreases at named light probes and increases at named dark probes. Check
   all nine control pairs at each named letterbox/transparent zero probe and
   the exact `14 / 255` permission at the pinecone partial-alpha probe.
3. Set the primary seed, wait for settlement, then re-seed. Tone and permission
   hashes must remain identical while routing and Fill geometry visibly change.
4. During a fresh realistic job, make three inspector/control interaction
   probes at the fixed viewport, target-relative coordinates, actions, and
   timing boundaries in `measurement.interactionProbes`. Cancel the active job
   with the exact `control-chaos` superseding edit in `measurement.cancellation`.
   Retained geometry must be labeled stale until the latest result settles;
   progress is monotonic, ETA is explicitly estimating or remaining, and
   cancellation produces no late replacement.
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

Heartbeat timing begins immediately before the coordinator posts compute,
includes request-to-first, every progress-message interval, and last-to-end,
and uses coordinator receipt timestamps. The three UI round trips use a
`1440 × 1000`, device-scale-factor `1` viewport and the exact DOM targets,
center coordinates, actions, and page-clock start/end boundaries in
`protocol.json`. Do not substitute a convenient interaction after seeing
results.

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

No result can pass or be adopted unless the rights gate was satisfied before
the first campaign write and the evidence record identifies the qualifying
attestation or replacement-fixture provenance.

Run the manifest guard from the repository root:

```sh
apps/studio/node_modules/.bin/vitest run \
  packages/core/benchmarks/photo-scribble/protocol.test.js
```
