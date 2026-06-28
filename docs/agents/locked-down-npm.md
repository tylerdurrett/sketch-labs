# Locked-down npm / pnpm

This machine intentionally hardens npm/pnpm against the npm supply-chain attacks that were rampant
through 2026. The lockdown is **deliberate**. An agent's job is to work *within* it, never to weaken it.

## The policy (global, in `~/.npmrc` and pnpm's global rc)

- `ignore-scripts=true` — dependency install/postinstall scripts do not run by default.
- `min-release-age=7` / `minimumReleaseAge: 10080` — packages published less than 7 days ago are refused.
- `blockExoticSubdeps: true` — non-registry (git/tarball/etc.) subdependencies are blocked.

Build scripts are gated, not banned: pnpm only runs the build script of a package that has been
**explicitly allowlisted per-repo**.

## What you'll see, and what it means

A fresh git worktree has no `node_modules`, so a stage runs `pnpm install`. Under the lockdown that
install will **not** run postinstall builds and may print something like *"Ignored build scripts:
esbuild — run `pnpm approve-builds` ..."* or exit non-zero. **This is the gate working, not a bug.**

## Do NOT

- ❌ `pnpm config set dangerouslyAllowAllBuilds true` — this writes to the **global** config and disables
  build-script gating for *every* install on the machine. It is the single worst thing you can do here.
  (It has happened: a flailing agent set it globally and silently defeated the whole lockdown.)
- ❌ Lower or unset `min-release-age` / `minimumReleaseAge`, or edit `~/.npmrc` / the global pnpm rc.
- ❌ Thrash trying random incantations to force an install through.

## Do

- ✅ **Typecheck without building.** `tsc --noEmit` needs no build script. Use the package-local binary
  (`packages/<pkg>/node_modules/.bin/tsc --noEmit`), or `pnpm install --ignore-scripts` then typecheck.
- ✅ **If a step genuinely needs a blocked build script** (e.g. running the vitest suite needs `esbuild`'s
  native binary built), do **not** disable protection. Stop and surface it to the human with exactly
  which package needs building and why.
- ✅ **Allow a trusted package the right way — per-repo and committed.** A human (or you, with approval)
  adds it to the repo's root `package.json`:

  ```json
  "pnpm": { "onlyBuiltDependencies": ["esbuild"] }
  ```

  This is explicit, auditable, scoped to one trusted package, and lives in git — the opposite of a
  silent global flag. It does not touch `min-release-age` or any other layer.

## If you find the global flag set

Revert it: `pnpm config delete dangerouslyAllowAllBuilds`, then confirm
`pnpm config get dangerously-allow-all-builds` returns `undefined`. Tell the human it was set and when.
