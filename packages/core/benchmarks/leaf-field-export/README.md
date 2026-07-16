# Leaf Field hidden-line export evidence

This harness runs Leaf Field's `busy-leaves-balls` preset through Studio's real
module Worker and production coordinator. It records Outline preview, cold
direct export, warm exact-cache reuse, and a separately cancelled cold export.

Run from the repository root:

```sh
node packages/core/benchmarks/leaf-field-export/studio-worker-browser-cli.js \
  --out=packages/core/benchmarks/leaf-field-export/results/issue-302-browser-observations.json
apps/studio/node_modules/.bin/vitest run \
  packages/core/benchmarks/leaf-field-export/studio-worker-evidence.test.js
```

The JSON pins protocol shapes, message counts, work units, ETA observations,
geometry hashes/counts, cache reuse, and cancellation. Timings describe one
machine run only and are deliberately not test limits or SLAs.
