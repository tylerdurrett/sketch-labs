# Photo Scribble Preset and missing-asset review

- Date: 2026-07-18 CDT / 2026-07-19 UTC
- Issue: #336
- Product surface: production Studio in headful Chrome 144.0.7559.96 on Darwin arm64
- Production policy: `1,000,000 / 16,000 / 32,000 / 16,000` accepted segments / polylines / stagnations / restarts

## Result

Pass. The actual Studio preserved the complete Photo Scribble reproduction
identity through save and full reload, failed closed when the selected managed
Image Asset was absent, and recovered the exact original result after the exact
asset bytes returned. No product defect was reproduced, so this block changes
no product code.

The uniquely prefixed trial Preset captured:

- name `issue-336-trial-preset-missing-review`
- Image Asset `pinecone-4330aa0314f7`
- seed `5036310400360331`
- params `toneContrast=1`, `toneGamma=1`, `pathDensity=20`,
  `scribbleScale=0.5`, `momentum=1`, `chaos=0.72`, `toneFidelity=1`
- `200 × 200 mm` profile, `10 mm` insets, frame included, and `0.3 mm` tool

The saved Preset bytes were 568 bytes with SHA-256
`c6ca2c549b98fc99984f69bf48a967048648ecabfd2361260ea2130aa1a1b752`.
The temporary file was removed after review.

## Exact reproduction proof

The settled pre-save result, the result after a full page reload followed by
loading the saved Preset, and the result after missing-asset recovery all had:

- Scene SHA-256 `ff214bb0ed506be55e621521af93f5011aa035a421ee5f91edfdcc7fd00d2645`
- ScribbleDiagnostics SHA-256 `43e7aedb84afda3fe5338e11bb34ebf939bbc26872b720812865fd9a10d40d76`
- identity SHA-256 `68eaf51a2141567645edc9a1f0d1b2c63e941546b5fd81bfa930e04512d241dd`
- termination `completed`, residual `0.004998970876759262`
- 17 polylines, 158,948 points

Asset ID, ordered params, seed, and Composition Frame were also compared
directly and were exactly equal before save, after full reload, and after
recovery. Compute time is observational and excluded from the diagnostics hash.

## Missing-asset proof

Studio was stopped before only
`assets/image-assets/pinecone-4330aa0314f7.png` was moved to an external
quarantine. After Studio restarted, the saved Preset loaded with:

- an HTTP 404 for exactly `/image-assets/pinecone-4330aa0314f7.png`
- the authored ID still present in the Image Asset control and Preset params
- explicit `Image Asset unavailable` canvas and `Image Asset is missing` control states
- a hidden, uniform transparent canvas (`886 × 886`, RGBA `[0,0,0,0]`)
- zero Scribble Worker requests for the unresolved input
- PNG, SVG, and Hidden-line SVG export controls all disabled
- zero downloads after DOM-level click attempts against all disabled controls
- no request for a different Image Asset, thumbnail, fallback, or substitution

The quarantined asset was restored by exact byte-preserving rename. Its size
remained 333,669 bytes and its SHA-256 remained
`4330aa0314f7b0acb150c7c22eab41e2a15008a04a3a17dd54cc1df03ac32c79`.
The product's `Retry exact asset` action resolved it without parameter mutation
and produced the exact original Scene, diagnostics, and identity hashes above.

## Cleanup

The complete before/after path, byte-size, and SHA-256 inventories for
`assets/image-assets/` and
`packages/core/src/sketches/photo-scribble/presets/` are identical. The
selected asset is restored, the trial Preset is absent, Studio and Chrome are
stopped, and the external backup is removed. All 24 executable review
assertions passed and no page error occurred.

Repository verification also passed: 210 focused Studio tests across Presets,
environment resolution, canvas fail-closed behavior, and Sketch controls; Studio
TypeScript checking; the production Vite build; script syntax checking; and
`git diff --check`. The focused test run emitted the suite's existing React
`act(...)` warnings but had no failure.

Raw actions, network and Worker logs, hashes, inventories, UI snapshots, and
assertions are in `raw-browser-preset-missing-review.json`. The four timestamped
screenshots show pre-save settlement, full-reload equivalence, explicit
missing-asset failure, and exact recovery.
