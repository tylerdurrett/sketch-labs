---
name: performance-campaign
description: Runs a measurement-first, worktree-isolated performance campaign that preserves behavior and rejects unproven optimizations. Use when the user asks to speed up part of the app, improve frame rate or latency, diagnose slowness, or iterate until no worthwhile performance opportunities remain.
---

# Performance Campaign

Improve one named path without changing its output or contracts. Measure median
and p95, test real behavior, and stop only when the target is met and further
safe changes fall below the agreed threshold.

## 1. Map and baseline

1. Read `AGENTS.md`, `CONTEXT.md`, and relevant ADRs before touching code.
2. Trace the target top-to-bottom through its callers, core work, rendering or
   I/O, and user-visible loop. Keep export-only work separate from live work.
3. Build a deterministic feedback loop. Pin representative inputs and record
   work counts plus an output checksum or equivalent correctness oracle.
4. Measure phases separately and end-to-end. For UI work, distinguish generation,
   command submission, completed browser work, cold edits, and sustained playback.
5. Report median, p95, sample count, environment, and a plain overall baseline.
   Never rely on one run or an average alone.
6. Present 3–5 ranked, falsifiable hypotheses before changing code. State the
   performance target, fidelity gate, and minimum worthwhile gain; default to
   exact output, p95 under the user-facing budget, and a 5% threshold.

## 2. Isolate experiments

1. Keep the user's checkout clean. Create an integration branch/worktree and one
   worktree per independent candidate.
2. Use sub-agents for bounded candidates that can run independently. Never let
   two agents edit the same worktree.
3. Change one variable at a time. Capture the before result in the same worktree
   and alternate baseline/candidate order to reduce JIT and machine bias.
4. Remove temporary probes and stop local servers after every experiment.

## 3. Gate every candidate

Retain a candidate only when all are true:

- output and deterministic sequences remain exact, unless the user explicitly
  approved a visual or semantic tradeoff;
- focused tests, broader regression tests, and typechecks pass;
- the gain repeats in the real target environment and clears the threshold;
- p95 does not regress, and the speedup does not come from skipping work;
- the change respects existing ownership, caching, parity, and determinism ADRs.

Revert rejected experiments completely and record why they lost.

## 4. Integrate and iterate

1. Cherry-pick only winners into the integration worktree.
2. Re-run the durable benchmark and full correctness suite on the combination.
3. Profile again; previous secondary costs may become dominant.
4. Ask independent agents for another read-only opportunity review.
5. Stop when the user-facing target passes and two independent review/profiling
   passes find no safe candidate expected to improve the target path by at least
   the threshold.

## 5. Land and explain

Open a review PR for substantial or risky work. Include:

- before and after phase tables, environment, median, and p95;
- one headline metric such as `31 ms → 6 ms, about 80% less frame time`;
- correctness evidence, tests, checksums, and real-browser or production probes;
- retained changes, measured rejections, and remaining risks;
- the durable benchmark command future agents should run.

Do not call Canvas timing “rendering” unless raster/paint completion was forced.
Do not pool or share mutable output merely to win a benchmark. Do not reduce
geometry, quality, or fidelity without explicit user approval.

## Example requests

- “Run a performance campaign on Leaf Field so it can animate at 60 fps.”
- “Use worktrees and testing to reduce Studio parameter-edit latency.”
- “Profile this export path and iterate until no 5% opportunities remain.”
