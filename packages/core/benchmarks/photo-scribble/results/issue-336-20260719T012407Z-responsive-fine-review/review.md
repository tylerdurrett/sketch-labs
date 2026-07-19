# Issue 336 corrected fine/high-density Studio responsiveness review

## Outcome

The production Studio passed the corrected product-level review in real Chrome
with the exact pinecone fine/high-density scenario active before and throughout
all three interaction probes and the required `#control-chaos` superseding edit.
All 25 fail-closed assertions in `raw-browser-responsive-fine-review.json` are
`true`.

This run supersedes only the probe, heartbeat, ETA, and cancellation timing
scope of `../issue-336-20260719T005436Z-responsive-review/`, whose corresponding
job mistakenly used `scribbleScale: 0.5`. The older run is retained and marked
as superseded rather than rewritten.

The corrected run used Chrome 144.0.7559.96 on Darwin 24.6.0 arm64 at
`1440 × 1000`, device-scale-factor `1`, with the adopted production tuple
`1,000,000 / 16,000 / 32,000 / 16,000`.

## Fine-worker identity and timing boundary

Before any probe, the product had committed and launched Worker 4 with this
exact production identity:

- Image Asset: `pinecone-4330aa0314f7`
- Tone contrast / gamma: `1 / 1`
- Path density / Scribble scale: `20 / 0.1`
- Momentum / chaos / Tone fidelity: `1 / 0.72 / 1`
- Seed: `5036310400360332`
- Composition Frame: `1000 × 1000`

The Worker request was posted at page clock 29,582.3 ms. The first probe began
at 30,975.6 ms, the last probe ended at 32,149.2 ms, and the Worker remained
active with no success response until `#control-chaos` terminated it at
33,422.3 ms. The same exact fine Worker therefore spanned every probe; no scale
`0.5` timing is used below.

## Product transitions

1. Studio loaded normally and truthfully reported its initial result as
   converged.
2. The committed `neat` Preset loaded, then `#control-scribbleScale` was selected
   completely, typed to `0.1`, and committed with Enter. No Worker launched
   during the input events; Enter launched the fine primary job.
3. The fixed primary fine job completed in 17,680.9 ms and truthfully displayed
   `Budget exhausted`, residual `0.062259759099295466`, and the bounded-partial
   explanation. Its target, Scene, and residual exactly match the adopted 1m
   campaign.
4. `#sketch-seed` was selected completely and typed to fixed reseed
   `5036310400360332`. No Worker launched while typing; Enter launched the exact
   fine Worker identified above.
5. After more than one second of real non-terminal progress, the fixed probes
   used target-border-box centers and one primary-pointer click:

   | Probe | Center `(x, y)` | Boundary | Duration |
   | --- | ---: | --- | ---: |
   | Hide inspector | `(1094, 26)` | mark before mouse-down → first rAF after `aria-label=Show inspector` | 188.0 ms |
   | Show inspector | `(1414, 26)` | mark before mouse-down → first rAF after `aria-label=Hide inspector` | 199.4 ms |
   | Toggle Shading | `(1280.5, 958)` | mark before mouse-down → first rAF after `details.open=true` | 98.3 ms |

   All three remain below 250 ms under the actual fine workload. Studio showed
   the retained budget-exhausted result as stale, live progress at 12%
   (`119,730 / 1,032,000` work units), and rolling ETA `16.6 s`.
6. `#control-chaos` was selected completely and typed from `0.72` to `0.71`.
   The first input event occurred at 33,422.2 ms and invoked the fine Worker's
   `terminate()` at 33,422.3 ms: **0.1 ms cancellation latency**. No replacement
   Worker launched while typing; Enter launched a latest-input Worker that
   retained `scribbleScale: 0.1`.
7. The previously completed fine canvas remained byte-identical before the
   probes and across cancellation:
   `d876472f49908a6992f7d5cb007c1e0ffab121a05a63a2e308230c0cab81f274`.
   The latest result replaced it with
   `9e866826e95cc23d992dffde4527165471c0f541d62a1bad871d05ad845fab47`.
   The canceled Worker never produced a success or failure response, including
   after the latest result and a two-second late-result observation.
8. Restoring chaos to `0.72` completed the fixed fine reseed. Both the primary
   and reseeded jobs truthfully ended budget-exhausted. Their canonical target
   hashes are identical while identity and Scene hashes change:

   | Hash | Primary fine seed | Fixed fine reseed | Relation |
   | --- | --- | --- | --- |
   | Target | `96738e63053982deb8f7b0afd042311f827b88280434024ad17e086826b72008` | same | exact match |
   | Identity | `2a62930556a24b446b7d0e2a09b78faf1d169fb7a28d95a05891cf7f00edf87c` | `4f22bb7515068cbe24527ca2d9ff886109bc4643d0f1601cd70d3c7218cbf3b9` | changed |
   | Scene | `6a2dbad0f2e899b0dff72d726b513495034adf01205c42e5472f191719fce57b` | `024efc36ea025cc129d9a06d63c06f4071c2109ec56265366a2a838f9469e03d` | changed |

The fine canceled job's request-to-progress heartbeat gaps were monotonic and
topped out at 471.1 ms, below the 1,000 ms limit. No page error occurred.

## Durable artifacts and cleanup

- `raw-browser-responsive-fine-review.json` contains exact input events, page
  clocks, the fine Worker identity/probe-window proof, every Worker heartbeat,
  termination/success records, DOM diagnostics, canonical hashes, canvas
  hashes, assertions, console records, screenshot paths, and cleanup manifests.
- `browser-responsive-fine-review.mjs` is the fail-closed rerunnable host.
- Eight timestamped JPEGs cover initial and Preset settlement, primary fine
  budget exhaustion, active fine stale retention/progress/ETA, the exact chaos
  supersession, latest replacement, and fixed fine reseed. The active fine,
  chaos-supersession, and final budget screenshots were visually inspected at
  original resolution after capture.
- No video recorder was injected into the corrected fine path. Timestamped
  screenshots are paired with higher-fidelity raw Worker/DOM clocks and hashes.
- No Image Asset or Preset was created, saved, imported, or overwritten. Sorted
  path/byte-length/SHA-256 manifests match exactly before and after. The browser
  closed and no trial session state remains.

## Verification

- 199 focused Studio tests passed across Shading diagnostics, composition,
  preparation, session, coordinator, and Worker runtime.
- Studio TypeScript check passed.
- Studio production Vite build passed. Its existing chunk-size advisory remained
  non-failing.
- The correction host passed `node --check`; the raw evidence gate independently
  required all assertions, the exact scale `0.1` / density `20` active-Worker
  proof, cleanup equality, and zero page errors.
- `git diff --check` passed, and neither `CONTEXT.md` nor any ADR changed.
