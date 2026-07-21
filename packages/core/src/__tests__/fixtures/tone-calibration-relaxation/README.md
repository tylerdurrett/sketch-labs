# Tone Calibration relaxation visual oracle

These committed ordinary-SVG fixtures use the exact flat-tone and analytic-ramp
workloads pinned by `stipplingStrategy-relaxation-quantitative.test.ts`. `before`
is Voronoi relaxation zero; `after` is maximum relaxation. The 100×100 frame,
Seed, Stipple density, and Distribution fidelity are fixed in
`tone-calibration-relaxation-visual.test.ts`.

Regenerate all four files from the repository root with:

```sh
UPDATE_TONE_CALIBRATION_RELAXATION_VISUAL_FIXTURES=1 packages/core/node_modules/.bin/vitest run --config packages/core/vitest.config.ts packages/core/src/__tests__/tone-calibration-relaxation-visual.test.ts
```

The normal test path never writes fixtures. It regenerates the actual ordinary
SVG in memory and checks both the committed bytes and pinned SHA-256 checksums.
Treat a checksum change as an intentional visual-contract change, not routine
snapshot churn.

Review each before/after pair at the same zoom:

- `after` has fewer isolated voids and clumps than `before`.
- Neither image develops grid, scanline, horizontal, vertical, or diagonal
  alignment.
- The ramp settles more evenly while preserving the same light-to-dark
  abundance.
- No Stipple enters the ramp's exact-zero demand edge.
- Stipple count, ordered identity, two-point shape, and fixed micro-stroke length
  do not change.
