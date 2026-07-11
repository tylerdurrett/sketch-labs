# Prepared frames are caller-owned stateless samplers

A stateless **Sketch** may optionally split time-invariant work from repeated time
sampling as `prepare(params, seed, compositionFrame) → (t) → Scene`. This is an optimization of
ADR-0002's `generate(params, seed, t, compositionFrame)`, not a second frame contract: the prepared
sampler must return the same Scene as `generate` for every `t`, retain only
immutable data derived from params, seed, and Composition Frame, and accumulate no cross-frame state.

The **Harness caller owns preparation**. A sequential caller such as Studio may
retain one sampler while Sketch identity, params, seed, and Composition Frame hold, then invalidate it
when any changes. The Sketch holds no hidden global cache, so independent callers,
random-access rendering, parallel Remotion frames, and export remain isolated.
Callers that do not benefit simply continue using `generate`.

`definePreparedSketch` derives cold `generate(params, seed, t, compositionFrame)` mechanically as
`prepare(params, seed, compositionFrame)(t)`. That single implementation prevents cold and warm
paths from drifting. A generic `prepareSketch` Harness helper selects the optional
fast path or adapts an ordinary stateless Sketch with a zero-state closure over
`generate`.

## Consequences

- Preparation is distinct from ADR-0003 simulation state: the sampler is pure in
  `t`; frame N never depends on sampling frame N−1.
- Prepared private data must not leak mutable references into returned Scenes. A
  caller may mutate one Scene without changing any later sample.
- Studio preparation is keyed on `(sketch, params, seed, compositionFrame)` and deliberately does
  not key or reset the ADR-0005 wall clock. A changed layout is sampled at the
  continuing `t` on the next frame.
- Every generated Scene uses its Composition Frame's exact coordinate space, so
  Harness layout is known without `SketchBase.space` or a throwaway frame sample.
- Exact Scene equality across cold/warm paths is the correctness gate; performance
  benchmarks measure cold preparation separately from warm varying-`t` sampling.
