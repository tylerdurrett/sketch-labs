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
install prints `ERR_PNPM_IGNORED_BUILDS` (e.g. `esbuild`) and **exits 1**. **This is the gate working,
not a broken environment** — and, crucially, **the deps still work**: esbuild and vitest ship prebuilt
platform binaries (`@esbuild/<platform>`), so they run fine without their postinstall script. Verified:
under this exact lockdown, `vitest run` transforms TypeScript and passes. So the exit-1 is *noise* — do
not chase it, do not "fix" it, and above all do not disable the gate to make it go away.

Run the package-local binaries directly rather than `pnpm run <script>` (pnpm's pre-flight rejects the
ignored-builds state and re-surfaces the same exit-1):

```bash
./node_modules/.bin/tsc --noEmit      # typecheck
./node_modules/.bin/vitest run        # test
```

> Note: `pnpm.onlyBuiltDependencies` **in `package.json` is ignored by pnpm 11** — the setting moved to
> `pnpm-workspace.yaml`. Don't try to allow a build via the `package.json` field; it does nothing.

## Do NOT

- ❌ `pnpm config set dangerouslyAllowAllBuilds true` — this writes to the **global** config and disables
  build-script gating for *every* install on the machine. It is the single worst thing you can do here.
  (It has happened: a flailing agent set it globally and silently defeated the whole lockdown.)
- ❌ Lower or unset `min-release-age` / `minimumReleaseAge`, or edit `~/.npmrc` / the global pnpm rc.
- ❌ Thrash trying random incantations to force an install through.

## Do

- ✅ **Typecheck without building.** `tsc --noEmit` needs no build script. Use the package-local binary
  (`packages/<pkg>/node_modules/.bin/tsc --noEmit`), or `pnpm install --ignore-scripts` then typecheck.
- ✅ **If a package genuinely needs its build script** *and has no prebuilt fallback* (most don't —
  esbuild/vitest do, so they're already fine), do **not** disable protection. Stop and surface it to the
  human with exactly which package needs building and why.
- ✅ **Allow a trusted package the right way — per-repo and committed.** A human (or you, with approval)
  adds it to the repo's `pnpm-workspace.yaml` (pnpm 11's home for this setting — the old
  `package.json` `"pnpm".onlyBuiltDependencies` field is silently ignored):

  ```yaml
  onlyBuiltDependencies:
    - esbuild
  ```

  This is explicit, auditable, scoped to one trusted package, and lives in git — the opposite of a
  silent global flag. It does not touch `min-release-age` or any other layer.

## If you find the global flag set

Revert it: `pnpm config delete dangerouslyAllowAllBuilds`, then confirm
`pnpm config get dangerously-allow-all-builds` returns `undefined`. Tell the human it was set and when.
