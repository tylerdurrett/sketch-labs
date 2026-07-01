# @harness/video

A [Remotion](https://www.remotion.dev/) consumer of `@harness/core`. It exists to
prove core is genuinely **headless**: the circles Sketch is driven from a second,
independent caller (this package) through the SAME shared render pipeline the
studio uses (`drawSceneFitted`), and cross-caller parity is proven headlessly.

`@harness/core` is consumed as **TypeScript source** (its `package.json` exports
`./src/index.ts`), so there is no build step — the same arrangement as the studio.

## What CI gates (and what it does not)

The CI gate for this package is the **headless typecheck + test suite**, not a
video render:

- `frameToScene` pins the frame→time sampling: `t = frame / fps`.
- The cross-caller parity test asserts a **byte-identical** ordered draw-call log
  between a studio-shaped and a video-shaped invocation of `drawSceneFitted`,
  including the contain-fit `setTransform` call.

Run them with the package-local binaries (the repo's supply-chain lockdown blocks
`pnpm run` pre-flight when install scripts are ignored — see
[docs/agents/locked-down-npm.md](../../docs/agents/locked-down-npm.md)):

```sh
./node_modules/.bin/tsc --noEmit   # typecheck
./node_modules/.bin/vitest run     # tests
```

The actual `.mp4` is a **manual** artifact — it is deliberately NOT CI-gated (a
real video render needs a headless browser and is slow; the headless proof above
is what guards correctness).

## Rendering the video (manual)

The Remotion entry is `src/index.ts` and the circles composition id is `Circles`:

```sh
npx remotion render src/index.ts Circles out/circles.mp4
```

Render Settings and determinism inputs are **input props**, overridable per
render (defaults: `fps` 30, `width`/`height` from the Sketch's coordinate space,
`params` = the Sketch's schema defaults, `seed` = 1). `durationInFrames` is
derived by `calculateMetadata` from the Sketch's `time.duration`. Override any of
them with `--props`, e.g.:

```sh
npx remotion render src/index.ts Circles out/circles.mp4 \
  --props='{"fps":60,"width":1920,"height":1080,"seed":7}'
```

You can also explore interactively in the Remotion Studio (also a manual step):

```sh
npx remotion studio src/index.ts
```

## Remotion version pin

`remotion` and every `@remotion/*` package are pinned to **`4.0.482`** (exact, no
`^`). The repo's supply-chain lockdown rejects any package published less than 7
days ago (`min-release-age=7`); `4.0.482` was published 2026-06-22, the newest
Remotion release that clears that window. Bump the pin only to another version
that is at least 7 days old, and keep `remotion` and all `@remotion/*` on the
**same** version (Remotion requires its packages to match exactly).
