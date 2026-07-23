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
clean and byte-identical to the pinned commits, and refuses drift:

```sh
node apps/studio/scripts/capture-watercolor-forms-reference.mjs \
  --scope evidence \
  --write \
  --tuning-commit 4375a50acc29737b7719b2edcb6e6fbeee78c022 \
  --fixture-commit 871311f7c6caefbadb08f4853fc9f904cdff4eb4
```

Recompute the complete evidence bundle, including PNG bytes, without writing:

```sh
node apps/studio/scripts/capture-watercolor-forms-reference.mjs \
  --scope evidence
```

With no arguments, verify fixtures and, once a committed evidence manifest is
present, evidence as well.

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
