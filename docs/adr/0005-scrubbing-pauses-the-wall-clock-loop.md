# Scrubbing pauses the wall-clock loop; the scrubber and the rAF clock are one `t` behind a play/pause

The time scrubber (#7) and the wall-clock animation loop (#6) are two modes of a **single** `t`, not two independent clocks. An animated Sketch mounts *playing* — the `requestAnimationFrame` loop drives `t = elapsedSeconds` (wrapped/clamped per ADR-0002 time semantics) and the scrubber thumb merely *follows* it. Grabbing the scrubber **pauses** the loop and `t` becomes the scrubber's value directly; the play/pause control resumes wall-clock advance **from the scrubbed `t`** (the `performance.now()` baseline is recaptured net of the scrubbed offset, not snapped back to 0). We chose pause-on-scrub because a Sketch is a pure function of `(params, seed, t)` (ADR-0002) and the whole reason to scrub is to *inspect or export one exact frame* — an always-live scrubber fighting a running clock contradicts that "freeze this frame" intent and is fiddlier to reason about.

This is a deliberate **rework of #6's single-owner clock**, not an addition beside it: the loop effect gains a "playing" gate and the baseline recapture has to net off the scrubbed `t`. A future reader seeing #7 reach back into the [LiveCanvas](../../apps/studio/src/LiveCanvas.tsx) clock should know that was intended — the clock was always meant to become the *playing* half of a transport, with the scrubber as the *paused* half, sharing one `t`.

## Consequences

- There is exactly one `t` in the studio. Whether it advances (rAF) or is held (scrub) is a transport mode, never a second source of truth — so any frame the canvas shows is reproducible from `(params, seed, t)` and is a valid export target (#9).
- Playback is **loop-only** for now, matching #6 (no one-shot Sketch exists yet). The scrubber's *range and clamp/wrap* are metadata-driven for both `loop` and `one-shot`, but the rAF *play* path stays loop-only until the first one-shot Sketch arrives.
- Resuming from a scrubbed `t` (rather than 0) is the behavior that makes scrub-then-play feel continuous; getting the baseline math wrong would snap the animation, which is the regression this ADR names.
