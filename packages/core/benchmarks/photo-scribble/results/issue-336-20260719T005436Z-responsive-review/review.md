# Issue 336 Studio responsiveness review

## Outcome

The production Studio passed the final product-level responsiveness review in
real Chrome with the adopted production policy of `1,000,000 / 16,000 / 32,000
/ 16,000`. No product defect was reproduced and no product code changed.

The run used Chrome 144.0.7559.96 on Darwin 24.6.0 arm64 at the protocol's
`1440 × 1000`, device-scale-factor `1` viewport. The committed `neat` Preset and
committed pinecone photo were driven only through the actual Studio UI. The
observational Worker wrapper did not replace the production coordinator,
worker runtime, generator, controls, Scene, or renderer.

Every fail-closed assertion in `raw-browser-responsive-review.json` is `true`.

## Exact product transitions

1. Studio loaded Photo Scribble and settled its initial real Worker result.
   Shading truthfully reported `Converged` with residual `0.016467643258161416`.
2. The committed `neat` Preset was selected and Reload was clicked. Its primary
   seed `5036310400360331` settled as converged in 1,367.7 ms with residual
   `0.004998970876759262`.
3. `#sketch-seed` was triple-clicked, typed to fixed reseed
   `5036310400360332`, and left uncommitted for 100 ms. All 16 real input events
   were recorded and **no Worker existed before Enter**. Enter launched Worker
   3 at page clock 4,848.9 ms.
4. After non-terminal progress had spanned at least 1,000 ms, the three fixed
   probes used target-border-box center coordinates and one primary-pointer
   click:

   | Probe | Center `(x, y)` | Boundary | Duration |
   | --- | ---: | --- | ---: |
   | Hide inspector | `(1094, 26)` | mark before mouse-down → first rAF after `aria-label=Show inspector` | 37.9 ms |
   | Show inspector | `(1414, 26)` | mark before mouse-down → first rAF after `aria-label=Hide inspector` | 29.1 ms |
   | Toggle Shading | `(1273, 936)` | mark before mouse-down → first rAF after `details.open=true` | 14.3 ms |

   Studio showed `Displayed result: stale`, `Preparing 6%`, `58,281 of
   908,160 work units`, and a rolling ETA of `14.7 s`. The three export buttons
   remained disabled while the displayed result was stale.
5. The active reseed job was superseded through the required product control:
   `#control-chaos` was triple-clicked, typed from scenario `0.72` to `0.71`,
   and committed with Enter. The first input event occurred at 6,061.0 ms and
   the real Worker's `terminate()` ran at 6,061.2 ms: **0.2 ms cancellation
   latency**. Again, no replacement Worker existed before Enter; Enter launched
   Worker 4.
6. The stale canvas RGBA hash remained exactly
   `234f6b9d0cb3f85b7d6b63882578ad904c3768ffbaea4a21f38f6614273f4e2a`
   across the whole cancellation/supersession boundary. The latest result then
   replaced it with
   `c5d026d03f95ff49e166e76c845a7658c967a590d513be1ed37d4d14d66afaa7`.
   The canceled Worker produced no success or failure response before or after
   the latest result settled, including the two-second late-result observation.
7. Chaos was restored to `0.72` and the fixed reseed completed. The canonical
   target was exactly invariant while routing identity and Scene both changed:

   | Hash | Primary seed | Fixed reseed | Relation |
   | --- | --- | --- | --- |
   | Target | `3a4237f5fe2b4d9bbcfc9160feb24c27a7d1c89ad2e108e8e3dd1e79a4bad2c7` | same | exact match |
   | Identity | `68eaf51a2141567645edc9a1f0d1b2c63e941546b5fd81bfa930e04512d241dd` | `aac86bfd47153fad9fcecb141ab41539dbc5dcb8c82bf012d90aa5bd24903671` | changed |
   | Scene | `ff214bb0ed506be55e621521af93f5011aa035a421ee5f91edfdcc7fd00d2645` | `a5b351815397316df5896a34febe647ff3f3f8fa71b1168fb4e5d8adb76fdcfb` | changed |

8. The primary seed was restored, then `#control-scribbleScale` was committed
   to `0.1`. The production job ran 18,039.4 ms and truthfully displayed
   `Budget exhausted`, residual `0.062259759099295466`, and the bounded-partial
   explanation. Its production target and Scene hashes exactly matched the
   adopted 1m campaign:

   - Target: `96738e63053982deb8f7b0afd042311f827b88280434024ad17e086826b72008`
   - Scene: `6a2dbad0f2e899b0dff72d726b513495034adf01205c42e5472f191719fce57b`

The canceled control job's request-to-progress heartbeat gaps were monotonic
and topped out at 131.5 ms. All three interaction probes remained far below the
250 ms protocol limit, cancellation remained far below 500 ms, no page error
occurred, and the latest input won.

## Durable artifacts

- `raw-browser-responsive-review.json` contains all input events, exact page
  clock boundaries, Worker requests/progress/termination/success records,
  diagnostics, production hashes, canvas hashes, assertions, console records,
  screenshots, and cleanup manifests.
- `browser-responsive-review.mjs` is the rerunnable product host.
- The seven timestamped JPEGs cover initial convergence, committed-Preset
  settlement, retained stale geometry, live progress/ETA, the superseding chaos
  edit, latest-result settlement, and adopted-1m budget exhaustion. The final
  progress and budget screenshots were visually inspected at original
  resolution after capture.
- Video is intentionally absent. An initial CDP-to-MediaRecorder bridge stalled
  before the first product edit, so the accepted run removed that host-side
  variable and retained timestamped screenshots plus the higher-fidelity raw
  Worker/DOM timing log.

## Cleanup

No Image Asset or Preset was created, saved, imported, or overwritten. Sorted
path/byte-length/SHA-256 manifests for `assets/image-assets/` and the Photo
Scribble Preset directory match exactly before and after the run. The isolated
browser closed and no trial session state remains.

## Verification

- 199 focused Studio tests passed across Shading diagnostics, composition,
  preparation, session, coordinator, and Worker runtime.
- Studio TypeScript check passed.
- Studio production Vite build passed. Its existing chunk-size advisory remained
  non-failing.
- The evidence host passed `node --check`; the raw assertion/cleanup gate passed.
- `git diff --check` passed, and neither `CONTEXT.md` nor any ADR changed.
