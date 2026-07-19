# Superseded timing scope

This run remains valid evidence for Studio's functional edit, cancellation,
stale-result, hash, and truthful-termination behavior. Its three interaction
probes and required `#control-chaos` cancellation were mistakenly measured
while the committed control scenario (`scribbleScale: 0.5`) was active, rather
than while the frozen fine/high-density scenario (`scribbleScale: 0.1`) was
active.

Do not use this run's probe, heartbeat, ETA, or cancellation timings as the
issue 336 fine/high-density product review. The immutable correction is
`../issue-336-20260719T012407Z-responsive-fine-review/`.
