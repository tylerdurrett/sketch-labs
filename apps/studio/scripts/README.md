# Studio capture scripts

`capture-pencil-contour-reference.mjs` verifies the committed flower
`AnalyzedRaster` and compact downstream diagnostic baseline. The JSON pins the
source and authored tuple, fixture and geometry hashes, and count, spatial, and
turn summaries. Candidate arrays and sampled path points are recomputed from
the binary instead of duplicated in JSON. The capture runs the real Studio
decoder in Chromium through Vite; a plain Node image decoder is deliberately
not a substitute.

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
