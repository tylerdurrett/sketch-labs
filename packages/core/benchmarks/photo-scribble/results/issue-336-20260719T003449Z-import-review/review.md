# Product Studio Image Asset review — issue 336

Result: **pass**. No product defect was reproduced, so this block changes no
production code.

## Environment

- Input commit: `6e7cce8a3e0b7219ad7f2205e0fb0d88b4300d4a`
- Product surface: the normal Studio entry at `/`, not the benchmark evidence page
- Browser: Chrome `144.0.7559.96`, visible (non-headless) Puppeteer session
- OS: macOS `15.6.1` (`24G90`), Darwin `24.6.0` arm64
- Viewport: `1440 × 1000`, device scale factor `1`
- Existing assets: `img-0672-79d639daec62` and `pinecone-4330aa0314f7`
- Trial source: an external, byte-identical copy of the committed pinecone PNG,
  named `issue-336-trial-pinecone-import.png` and SHA-256
  `4330aa0314f7b0acb150c7c22eab41e2a15008a04a3a17dd54cc1df03ac32c79`

The executable browser procedure and complete request/response, storage, picker,
identity, and assertion record are in `browser-import-review.mjs` and
`raw-browser-import-review.json` beside this report.

## Exact pass

1. Started the actual Studio through its normal Vite configuration and loaded
   Photo Scribble. The default selected `pinecone` ID resolved and the library
   returned both committed assets as readable names with project-relative PNG
   thumbnails.
2. Selected the prefixed staged PNG in the real file input, kept the editable
   canonical name `issue-336-trial-import-review`, and confirmed import.
3. Studio decoded, alpha-preserved, PNG-normalized, and persisted a `512 × 768`,
   358,178-byte asset. Its SHA-256 was
   `e78487d08d1a0a446292cc28f5e1952bdd2ed800200a554cd1a9b43011a69292`;
   the selected stable ID was
   `issue-336-trial-import-review-e78487d08d1a`, whose hash suffix matches the
   persisted normalized bytes.
4. Imported the same staged source under the same name again. The two POSTs
   returned the same ID with `created: true` followed by `created: false`.
   Fetching the stored PNG before and after the second import produced identical
   size, dimensions, content type, and SHA-256, confirming immutable dedup.
5. Reused each picker choice in turn: flowers, pinecone, then the imported
   asset. Every visible thumbnail/name resolved to its exact ID, and returning
   to the imported choice restored the same ID without another import.
6. Saved `issue-336-trial-import-review`, performed a full page reload, selected
   that Preset, and clicked Reload. The live selection and picker `Current`
   marker both returned to `issue-336-trial-import-review-e78487d08d1a`; the
   saved JSON contains that exact opaque ID. (A bare page reload correctly starts
   from Photo Scribble's default; the durable reload contract is the Preset.)
7. Checked visible text, browser storage, captured managed-asset/Preset traffic,
   and saved Preset JSON for `/Users/`, `/tmp/`, and the staged filename. There
   were no matches, and the file input was empty after import. Storage contained
   only `sketch-labs.paper-display-unit=mm`; session storage, IndexedDB, cookies,
   and machine paths were absent.

All relevant asset list/import/read and Preset list/save/read requests returned
HTTP 200. There were no page exceptions. Chrome's lone console 404 was its
unrelated missing favicon request; it does not appear in the captured product
API traffic. The Preset POST response-body observer raced the deliberate page
reload and records a CDP body-read error, while the response status was 200 and
the subsequently fetched committed bytes were valid and exact.

## Captures

- `2026-07-18_193700_initial-picker.jpg`: both committed assets, readable names,
  thumbnails, and pinecone marked current.
- `2026-07-18_193710_imported-selected.jpg`: normalized trial ID selected and
  reused alongside both committed assets.
- `2026-07-18_193720_reload-picker-reuse.jpg`: exact trial selection and Current
  marker restored after full page reload plus Preset reload.

## Cleanup proof

Before Studio startup, the complete asset and Photo Scribble Preset directories
were copied outside the repository and verified against their sorted
relative-path, byte-length, and SHA-256 manifest. After stopping Studio, the two
directories were restored from that backup and only the new, exactly prefixed
trial asset and Preset were removed. The post-run path/size manifest and SHA-256
manifest compare byte-for-byte equal to the pre-run manifests.

Restored inventory:

| Path | SHA-256 |
| --- | --- |
| `assets/image-assets/img-0672-79d639daec62.png` | `79d639daec62a2af4a59954b9d102e51ff30d11cd14246fffc52a53250858a7d` |
| `assets/image-assets/pinecone-4330aa0314f7.png` | `4330aa0314f7b0acb150c7c22eab41e2a15008a04a3a17dd54cc1df03ac32c79` |
| `packages/core/src/sketches/photo-scribble/presets/flowers-dense-chaotic.json` | `d96c7917fa170f53cd67e66237653285098b9132823cfe95c40fd4e89d57112c` |
| `packages/core/src/sketches/photo-scribble/presets/flowers-dense.json` | `e74b5b72a2a44f66c86aca0d7e2117920820aff1ab8393f92b1126016ceb4e67` |
| `packages/core/src/sketches/photo-scribble/presets/neat.json` | `25b34ea7b25a273cf62940c5338c1328e5bb70fd4c0634abe24a4a4cebd36cd0` |

No trial asset or Preset remains in the product inventory.

## Verification

- Focused Studio Image Asset and App suite: 7 files, 146 tests passed.
- Studio TypeScript: `tsc --noEmit -p apps/studio/tsconfig.json` passed.
- Production Studio Vite build passed. Its existing large-entry-chunk advisory
  remains non-blocking; there was no build error.
- `git diff --check` passed.
