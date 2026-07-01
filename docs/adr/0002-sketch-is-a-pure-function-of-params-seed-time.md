# A Sketch is a pure function of (params, seed, time)

A **Sketch**'s entire output is produced by a deterministic `generate(params, seed, t)` — given the same inputs it returns the same frame, always, with no per-frame or cross-frame mutable state. We chose this because the same function must serve three callers without divergence: live exploration (sampling `t` at wall-clock), Remotion (sampling `t = frame/fps`), and static/plotter export (freezing `t` and exporting that frame's vector IR exactly). A stateful, realtime-only animation loop would have been more convenient to write but would make any given frame irreproducible — breaking deterministic video rendering, frame scrubbing, and "freeze and export this exact frame to the plotter."

## Consequences

- Animation must be expressed as a function of `t` (e.g. periodic noise for seamless loops), never as accumulated state. Reaching for `requestAnimationFrame`-driven mutable state inside a Sketch is the anti-pattern this ADR exists to prevent.
- Any randomness flows from the explicit **Seed**, not from `Math.random()` or time, so a `(params, seed, t)` tuple fully determines the image.
- Expensive, export-only work (hidden-line removal, path simplification, pen ordering) stays outside the per-frame path, which is only `generate → bake → draw`.
  - _Vocabulary note (added later):_ the "bake" in that line predates the term's repurposing in CONTEXT.md, where **Bake** now means simulation trajectory precompute (see [ADR-0003](0003-stateful-sketches-are-harness-driven-fixed-timestep-folds.md)) and **Draw** is the Sketch's internal `draw(state) → Scene` step. In the refined vocabulary the studio-level per-frame path is `generate(params, seed, t) → Scene → render`: `generate` already returns a fully-drawn Scene (for a stateless Sketch the draw is internal to it), and the **Scene Renderer** renders that Scene in painter's order. No bake occurs for a stateless Sketch.
