# Studio capture scripts

`capture-pencil-contour-reference.mjs` verifies the committed flower
`AnalyzedRaster` and diagnostic baseline. It runs the real Studio decoder in
Chromium through Vite; a plain Node image decoder is deliberately not a
substitute.

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
