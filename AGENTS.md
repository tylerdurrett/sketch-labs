Any instructions in this file must be VERY concise since this loads in every agent session. Add a short instruction and link out to a more detailed doc.

## Agent skills

This repo uses the tdog engineering skill set; its conventions live under [docs/agents/](docs/agents/) — read [docs/agents/README.md](docs/agents/README.md) first. Specs are GitHub issues on `tylerdurrett/experiment-harness`.

Skill sources live in `.agents/skills/<name>/`; each `.claude/skills/<name>` is a symlink to it. Author and edit the `.agents/skills/` copy, and symlink any new skill the same way (`ln -s ../../.agents/skills/<name> .claude/skills/<name>`).

## Recording decisions

ADRs in [docs/adr/](docs/adr/) are for **system** decisions (Harness, Sketch contract, renderers, determinism, workflow). A decision local to one **sketch** gets **no** ADR — put its rationale in that sketch's own module header comments. See [ADR-0007](docs/adr/0007-adrs-record-system-decisions-not-sketch-decisions.md).

## Landing changes

Small, low-risk tweaks (skill text, docs, config) not tied to an issue-spec: commit straight to `main`, no branch or PR. Reserve branch + PR for issue-spec work (via `/ship`), risky/large changes, or when a review gate is wanted.

## Installing dependencies (locked down)

npm/pnpm is deliberately hardened (no install scripts, no <7-day-old packages, no exotic subdeps). A fresh `pnpm install` exits 1 on `ERR_PNPM_IGNORED_BUILDS` (esbuild) — expected and benign; the toolchain runs on prebuilt binaries, so use the package-local binaries (`packages/<pkg>/node_modules/.bin/tsc`, `.../vitest`), not `pnpm run`. NEVER weaken it globally (no `pnpm config set dangerouslyAllowAllBuilds`, no lowering `min-release-age`, no editing `~/.npmrc` or the global pnpm rc). To allow a trusted package's build, add `allowBuilds: { <pkg>: true }` to `pnpm-workspace.yaml` (per-repo, committed, reviewable) — pnpm 11's mechanism; the old `onlyBuiltDependencies` key is removed/ignored. See [docs/agents/locked-down-npm.md](docs/agents/locked-down-npm.md).