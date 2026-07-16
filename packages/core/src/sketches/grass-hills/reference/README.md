# Issue 305 production acceptance artifacts

`fill.svg`, `outline.svg`, `physical-plot.svg`, and `manifest.json` are the
approved reference for the shipped inverse-square Grass Hills implementation.
They start from the committed `dense-grass` Preset, use seed `12345`, full
`bladeDensity: 2`, the square `200 × 200 mm` profile with `10 mm` insets, and
Studio's fixed `0.30 mm` tool.

The reference contains 10,000 production Fill blades, 8,179 tool-selected
Outline spines, and 7,798 final processed paths including the Composition
Frame. `outline.svg` and `physical-plot.svg` serialize the exact same clipped
processed Scene; the manifest pins its checksum, allocation, workload, mapping,
artifact hashes, reproduction commands, and independent visual verdict.

The prior equal-per-hill `9,298`-selected / `8,939`-path decision prototype is
preserved under `decision-prototype/`. It remains honest architecture evidence,
but is not the production visual reference.

Regenerate from the repository root with the two commands recorded in
`manifest.json`. Normal benchmark tests reproduce every committed artifact
without writing it.
