# Studio capture scripts

`capture-pencil-contour-reference.mjs` verifies the committed flower
`AnalyzedRaster` and compact downstream diagnostic baseline. The JSON pins the
source and authored tuple, fixture and geometry hashes, and count, spatial, and
turn summaries. Candidate arrays and sampled path points are recomputed from
the binary instead of duplicated in JSON. The capture runs the real Studio
decoder in Chromium through Vite; a plain Node image decoder is deliberately
not a substitute.

`capture-watercolor-forms-reference.mjs` captures compact, bounded preparation
planes for the flower and pinecone through the same production Studio resolver.
It also captures Pencil Contour's pinecone `AnalyzedRaster`; the existing
Pencil Contour flower fixture remains its reviewed source of truth. The
Watercolor Forms fixtures are provisional inputs for later evidence and tuning,
not visual-quality gates or an attestation.

The same CLI also captures Watercolor Forms comparison evidence. It renders the
actual production Pencil and Watercolor `Scene`s through the production Canvas
renderer, at the same scale in full-frame and dense-detail comparisons. The
manifest recomputes the current reference-gate metrics and pins source, fixture,
production-content, geometry, cap-diagnostic, crop, and PNG hashes. Generated
evidence is not a review verdict, and the script never creates or changes a
`review-attestation.json`.

From the repository root, install the workspace and the browser tool owned by
the checked-in Chrome DevTools skill:

```sh
pnpm install
npm --prefix .agents/skills/chrome-devtools/scripts ci --ignore-scripts
npm --prefix .agents/skills/chrome-devtools/scripts exec -- puppeteer browsers install chrome
```

The skill-local `npm ci` follows its committed lockfile and writes only its
gitignored `node_modules`; it does not add or relax a workspace dependency.
Install scripts remain disabled. The second, explicit command installs only the
Chrome version pinned by that local Puppeteer package.

Verify the committed bytes and JSON:

```sh
node apps/studio/scripts/capture-pencil-contour-reference.mjs
```

Use `--write` only when intentionally replacing the reviewed baseline:

```sh
node apps/studio/scripts/capture-pencil-contour-reference.mjs --write
```

Capture the provisional Watercolor Forms inputs and Pencil Contour pinecone
comparison input with an explicit full commit SHA for the production
preparation code:

```sh
node apps/studio/scripts/capture-watercolor-forms-reference.mjs \
  --scope fixtures \
  --write \
  --provenance-commit "$(git rev-parse HEAD)"
```

The recorded `preparedFromCommit` remains stable after the fixture commit.
Verify the committed bytes and all other metadata against the current
production decoder and preparation functions without rewriting provenance:

```sh
node apps/studio/scripts/capture-watercolor-forms-reference.mjs \
  --scope fixtures
```

Capture the comparison evidence only after the tuning and fixture commits have
been finalized. Both arguments must be lowercase full SHAs; the script verifies
their ancestry, checks that Watercolor/Pencil production and fixture inputs are
clean and byte-identical to the pinned commits, and refuses drift. Set
`TUNING_COMMIT` and `FIXTURE_COMMIT` to those finalized lowercase full SHAs:

```sh
node apps/studio/scripts/capture-watercolor-forms-reference.mjs \
  --scope evidence \
  --write \
  --tuning-commit "$TUNING_COMMIT" \
  --fixture-commit "$FIXTURE_COMMIT"
```

Recompute the complete evidence bundle, including PNG bytes, without writing:

```sh
node apps/studio/scripts/capture-watercolor-forms-reference.mjs \
  --scope evidence
```

With no arguments, verify fixtures and, once a committed evidence manifest is
present, evidence as well.

## Flowing Contours prepared inputs

`prepare-flowing-contours-reference.mjs` creates or verifies only the canonical
FC23 prepared-input fixtures for the flower and pinecone references. It uses a
script-owned, inert Vite harness that never boots Studio's App or registry,
serves only the two exact source assets, decodes them through
`decodeImageAsset`, and runs `prepareFlowingContoursRaster`. The FC23 helper
performs the canonical three-plane Float64LE encoding and strict metadata
round-trip.

The fixture metadata pins the exact source bytes and dimensions, Composition
Frame, authored Flowing Contours controls, full-frame and dense-detail crops,
named regions, topology checks, and Pencil Contour and Watercolor Forms
comparator revisions. Every run also refuses dirty or commit-divergent
Flowing production, comparator, FC23 test-contract, Studio decoder, preparation
tool, Vite package/lock, and browser-pin inventories. Installed Vite,
Puppeteer, and `@puppeteer/browsers` must match those protected locks. Chrome
is resolved from the exact Puppeteer build ID in its package-managed cache;
environment executable overrides are ignored, and the launched executable and
product version must match that pin. Its JSON result reports the SHA-256 of
every protected file and each aggregate inventory.

The command is deliberately input-only. It does not import the Flowing Contours
generator, produce a `Scene`, compute quality metrics, render or compose PNGs,
or create review evidence.

Exercise the non-browser guards:

```sh
node apps/studio/scripts/prepare-flowing-contours-reference.mjs --help
node apps/studio/scripts/prepare-flowing-contours-reference.mjs --self-test
```

Use `--dry-run` with an exact clean commit to exercise the complete pinned
browser decode and canonical preparation twice without reading or writing any
fixture:

```sh
node apps/studio/scripts/prepare-flowing-contours-reference.mjs \
  --dry-run \
  --provenance-commit "$(git rev-parse HEAD)"
```

After the Flowing Contours production implementation is calibrated and
committed, write both provisional prepared inputs with that exact full commit
SHA:

```sh
node apps/studio/scripts/prepare-flowing-contours-reference.mjs \
  --write \
  --provenance-commit "$(git rev-parse HEAD)"
```

The production tree must be byte-identical to the supplied commit. The script
captures each input in two fresh browser contexts and refuses nondeterministic
browser decoding or preparation. A write stages and fsyncs all four files in
the fixture directory, then replaces them as one rollback-protected
transaction; a failed replacement cannot leave a mixed fixture set. Fixture
bytes are committed only in the later freeze step.

Once the two `.f64le` files and their JSON sidecars are committed, verify them
without changing their recorded preparation commit:

```sh
node apps/studio/scripts/prepare-flowing-contours-reference.mjs
```

## Optional weak-component replay

The expensive counterfactual weak-evidence replay is an offline diagnostic,
not part of the permanent test suite:

```sh
packages/core/node_modules/.bin/vitest run \
  --config packages/core/vitest.pencil-contour-diagnostic.config.ts
```

It evaluates one predefined policy over the 64 highest-ranked weak components.
A failed result means that bounded policy did not clear its recovery threshold;
it is not evidence that every possible hysteresis strategy is ineffective. The
current decision not to ship hysteresis also relies on the accepted visual
result and the absence of major contour gaps.
