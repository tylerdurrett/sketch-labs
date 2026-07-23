# Watercolor Forms comparison evidence

These four PNGs are deterministic review inputs for issue #402. Each image
places Pencil Contour on the left and Watercolor Forms on the right at the same
scale. The full-frame pair shows the complete 1000 × 1000 Composition Frame;
the dense-detail pair uses the exact shared crop recorded in `manifest.json`.
Both sides render the actual production `Scene` geometry through the production
Canvas2D Scene Renderer.

`manifest.json` pins the Watercolor tuning and fixture commits, stable
path-sorted production-content hashes, source and fixture identities, exact
controls and frame, metric definitions and results, geometry hashes, coverage,
bounded-work diagnostics, crop rectangles, and PNG hashes. The metrics use the
same helper as the committed Watercolor Forms reference gates.

The artifacts are generated comparison evidence, not a visual-review verdict.
This directory intentionally has no generated review attestation; independent
review must remain a separate human action.

## Reproduce

Run from the repository root with the pinned production browser:

```sh
node apps/studio/scripts/capture-watercolor-forms-reference.mjs \
  --scope evidence \
  --write \
  --tuning-commit f567708cd04b2771bdcccde9965fc738d63bf1d4 \
  --fixture-commit c793c507359373262dc87aae301d0b4efe554515

node apps/studio/scripts/capture-watercolor-forms-reference.mjs \
  --scope evidence
```

The verify command recomputes the decoded rasters, production Scenes, metrics,
diagnostics, geometry hashes, and PNG bytes, then checks every committed file.
It refuses dirty or commit-divergent Watercolor, Pencil, or fixture inputs.
