# Locked-down npm / pnpm

This machine intentionally hardens npm/pnpm against the supply-chain attacks that were rampant through
2026. The lockdown is **deliberate**. An agent's job is to work *within* it, never to weaken it.

All claims below were verified against the [pnpm settings docs](https://pnpm.io/settings) and reproduced
on this machine (pnpm 11.1.3) on 2026-06-28.

## The policy

Global, in `~/.npmrc` **and** pnpm's global rc (`~/Library/Preferences/pnpm/rc`):

- `ignore-scripts=true` — npm-style blanket disable of lifecycle scripts.
- `min-release-age=7` / `minimumReleaseAge: 10080` — packages published less than 7 days ago are refused
  (the docs' default is 1 day; this machine raises it to 7).
- `blockExoticSubdeps: true` — non-registry (git/tarball/etc.) subdependencies are blocked.

Plus a pnpm v11 default that does the heavy lifting for dependency builds:

- `strictDepBuilds: true` (v11 default) — if any dependency has an **unreviewed** build script, `pnpm
  install` **fails** with `ERR_PNPM_IGNORED_BUILDS`. Build scripts are gated, not banned: a package's
  build runs only if it's explicitly reviewed in `allowBuilds` (see below).

## What you'll see, and what it means

A fresh git worktree has no `node_modules`, so a stage runs `pnpm install`. Under the lockdown that
install prints `ERR_PNPM_IGNORED_BUILDS` (e.g. `esbuild`) and **exits 1**. **This is the gate working,
not a broken environment** — and, crucially, **the deps still work**: esbuild and vitest run on prebuilt
platform binaries (`@esbuild/<platform>`), so they work without their postinstall build. Verified under
this exact lockdown: `tsc --noEmit` exits 0 and `vitest run` passes the full suite. So the exit-1 is
*noise* — do not chase it, do not "fix" it, and above all do not disable the gate to make it go away.

Run the package-local binaries directly rather than `pnpm run <script>` (pnpm's pre-flight re-surfaces
the same `ERR_PNPM_IGNORED_BUILDS`). They live under each package, **not** the repo root:

```bash
packages/core/node_modules/.bin/tsc --noEmit      # typecheck
packages/core/node_modules/.bin/vitest run        # test
```

## How build approval actually works in pnpm 11

> **`onlyBuiltDependencies` / `neverBuiltDependencies` were removed in pnpm v11** and replaced by
> `allowBuilds`. ([pnpm settings docs](https://pnpm.io/settings).) A `onlyBuiltDependencies:` block in
> `pnpm-workspace.yaml` is **silently ignored** by pnpm 11 — it does nothing. That's why pnpm keeps
> injecting an `allowBuilds: <pkg>: set this to true or false` block on every install: it's a migration
> prompt, not stray garbage.

The v11 mechanism is a per-package map in `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  esbuild: true     # reviewed → run its build script
  some-pkg: false   # reviewed → deliberately do NOT build (silences the error, runs zero scripts)
```

- `allowBuilds: { <pkg>: true }` — install exits 0 and runs that one package's build. **Verified.**
- `allowBuilds: { <pkg>: false }` — install exits 0, runs no script for it, and the
  `ERR_PNPM_IGNORED_BUILDS` error and the placeholder nag both disappear. **Verified.**

This is explicit, auditable, scoped to one reviewed package, committed to git — the opposite of a silent
global flag. It does not touch `min-release-age`, `ignore-scripts`, or any global layer.
`pnpm approve-builds` writes the same `allowBuilds` entries interactively.

## Do NOT

- ❌ `pnpm config set dangerouslyAllowAllBuilds true` — per the docs this runs **all** dependency build
  scripts (current and future) with no approval, and it writes to the **global** config, so it disables
  the gate for *every* repo on the machine. It is the single worst thing you can do here. (It has
  happened: a flailing agent set it globally and silently defeated the whole lockdown.)
- ❌ Lower or unset `min-release-age` / `minimumReleaseAge`, or edit `~/.npmrc` / the global pnpm rc.
- ❌ `pnpm config set ...` of anything — that writes global config. Per-repo `pnpm-workspace.yaml` only.
- ❌ Thrash trying random incantations to force an install through.

## Do

- ✅ **Treat the fresh-install exit-1 as benign.** Typecheck and test with the package-local binaries
  above. `tsc --noEmit` and `vitest run` both work without any build script.
- ✅ **If a trusted package genuinely needs its build script** — add `allowBuilds: { <pkg>: true }` to
  `pnpm-workspace.yaml` (per-repo, committed, reviewable in the diff). Get a human's OK first; the entry
  is the audit record. Most packages don't need it (esbuild/vitest don't — prebuilt binaries cover them).
- ✅ **To silence the nag without running anything**, use `allowBuilds: { <pkg>: false }` — it records
  that you reviewed the package and chose not to build it.

## If you find the global flag set

Revert it: `pnpm config delete dangerouslyAllowAllBuilds`, then confirm
`pnpm config get dangerouslyAllowAllBuilds` returns `undefined`. Tell the human it was set and when.
