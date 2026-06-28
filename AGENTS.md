Any instructions in this file must be VERY concise since this loads in every agent session. Add a short instruction and link out to a more detailed doc.

## Agent skills

This repo uses the tdog engineering skill set; its conventions live under [docs/agents/](docs/agents/) — read [docs/agents/README.md](docs/agents/README.md) first. Specs are GitHub issues on `tylerdurrett/experiment-harness`.

## Landing changes

Small, low-risk tweaks (skill text, docs, config) not tied to an issue-spec: commit straight to `main`, no branch or PR. Reserve branch + PR for issue-spec work (via `/ship`), risky/large changes, or when a review gate is wanted.

## Installing dependencies (locked down)

npm/pnpm is deliberately hardened (no install scripts, no <7-day-old packages, no exotic subdeps). A fresh worktree's `pnpm install` exits 1 on `ERR_PNPM_IGNORED_BUILDS` (e.g. esbuild) — expected and benign; the deps still work (esbuild/vitest ship prebuilt binaries). Run package-local binaries directly (`./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/vitest run`), not `pnpm run`. NEVER weaken the lockdown to silence it: no `pnpm config set dangerouslyAllowAllBuilds`, no lowering `min-release-age`, no editing `~/.npmrc` or the global pnpm rc. See [docs/agents/locked-down-npm.md](docs/agents/locked-down-npm.md).