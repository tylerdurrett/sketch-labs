---
name: check
description: Single-agent read-only sanity check on any tier-bearing spec's decomposition. Tier-aware via the input's `size:*` label. Surfaces uncovered scope, out-of-scope drift, hallucinated APIs, oversized children, and sequencing reversals before any executing agent burns a session on a flawed plan. Use when the user wants a fast dry-run; reach for `/audit` when the cost of a wrong decomposition is high.
---

# Check

Read-only sanity check on a tier-bearing spec's decomposition. The skill reads the input's `size:*` label and runs the appropriate per-tier checks: coverage at initiative and feature tier, codebase grounding + sizing + sequencing at slice tier, narrow spot-check at task tier.

Issue-shape hygiene (template fields, body sections, label conventions) is `/decompose`'s and `/triage`'s job. This skill is purely about correctness.

This skill is read-only. No issue body edits, no comments, no working-tree changes. Output is a conversation. Surface findings one at a time and discuss them with the user. The terminal `## Findings` block at the end of the run is the only structured artifact; `/audit` parses it identically across all four tiers.

For label vocabulary see [docs/agents/triage-labels.md](../../../docs/agents/triage-labels.md); for the canonical end-of-run output (and the explicit exception covering this skill) see [docs/agents/output-format.md](../../../docs/agents/output-format.md).

## When to use

- After `/decompose` publishes a spec's children, before kicking off `/execute` against any task. The `/decompose` end-of-run line recommends running this skill at exactly that moment.
- After the maintainer hand-edits a spec body or a child body in a way that might have shifted coverage or scope.
- On a single `size:task` when you want a narrow codebase-grounding pass before execution.

## When NOT to use

- The spec has no size label. Run `/triage` first to size it.
- The spec is closed. Coverage of closed work is meaningless.
- You want to **edit** the spec or its children. That's `/audit` (write path) or `/decompose` (re-decompose path).

## Input

The user passes an issue reference: `#<N>`, a bare number, or a full `https://github.com/<owner>/<repo>/issues/<N>` URL. Resolve to a number, then fetch the spec:

```bash
gh issue view <N> --comments --json number,title,body,labels,state
```

Read the body and every comment before doing anything else.

### Mode dispatch

The spec's size label picks the mode:

| Size label        | Mode       | Checks performed                                                                                  |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `size:initiative` | initiative | DoD coverage + out-of-scope drift against feature children                                        |
| `size:feature`    | feature    | User-stories coverage + out-of-scope drift against slice children                                 |
| `size:slice`      | slice      | AC coverage + out-of-scope drift + codebase grounding + per-task sizing + sequencing              |
| `size:task`       | task       | Codebase grounding + AC sanity-check, plus lightweight sibling-context checks if a parent exists  |

### Refusal paths

Stop and tell the user clearly when any of these hold. Do not guess, do not improvise.

- **Missing issue.** `gh issue view` errored (404, network, auth). Surface the error verbatim and exit.
- **Closed spec.** `state` is `CLOSED`. Exit.
- **No size label.** Spec carries none of `size:initiative` / `size:feature` / `size:slice` / `size:task`. Tell the user to run `/triage <N>` first.
- **Body lacks the tier's required forward-coverage section.** Per the table below. Surface and tell the user to re-run `/to-spec` (which writes the section by template) or hand-add the section before re-running.

| Mode       | Required body section          |
| ---------- | ------------------------------ |
| initiative | `## Definition of done`        |
| feature    | `## User Stories`              |
| slice      | `## Acceptance criteria`       |
| task       | `## Acceptance criteria`       |

### Soft skip

If the body lacks `## Out of Scope` (or `## Out of scope`, case varies by template), continue with the forward (coverage) check only. Note the negative-check skip in the conversation's opening line so the user knows the run was partial. The `## Findings` block at the end is unchanged in shape, just absent any out-of-scope-drift bullets.

If the user passes a non-issue argument (a branch name, a file path, a PR URL), refuse politely and tell them the shape: `/check #<N>` against an open size-labeled spec. Decomposition lives on the tracker as native sub-issues, not as files in a `.plans/` directory; a path argument is almost certainly a stale habit.

## Fetching children

All modes except task mode (without a parent) fetch children once, up front:

```bash
gh issue list --search "parent-issue:<owner>/<repo>#<N>" \
  --state all \
  --json number,title,state,labels,body \
  --limit 100
```

Read every child's body. Closed children matter for the forward check (a target addressed by a shipped child is covered, not uncovered) and for sequencing (they're part of the dependency graph regardless). Closed children are out of scope for per-child sizing checks (they've shipped).

## Initiative mode (`size:initiative`)

Audit feature children against the initiative's `## Definition of done` and `## Out of scope` sections.

### Forward check: Definition-of-done coverage

For each distinct outcome described in `## Definition of done`:

- **Covered.** Some open or closed feature child's body delivers the outcome. The match is semantic; initiatives describe outcomes in user-visible terms, not feature names, so judge by reading the child body. No finding.
- **Uncovered.** No feature child appears to deliver this outcome. Severity `blocker`. The initiative promised the outcome and the decomposition doesn't.
- **Partially covered.** A child references the area but its body doesn't fully deliver the outcome. Severity `concern`. Cite the child's URL plus a one-line note on what's missing.

`## Outcome` and `## Problem` provide context for understanding the DoD but are not themselves audited. `## Candidate features` is a soft pointer for the maintainer, not a contract.

### Negative check: out-of-scope drift

For each item in `## Out of scope`, flag any feature child whose body appears to scope in excluded work. Severity normally `concern`; promote to `blocker` only on unambiguous contradictions.

## Feature mode (`size:feature`)

Audit slice children against the feature's `## User Stories` and `## Out of Scope` sections.

### Forward check: user-story coverage

For each numbered story in `## User Stories`:

- **Covered.** Some open or closed slice child's body delivers the story's actor + capability + benefit triple. Match by substance, not by lexical keywords. No finding.
- **Uncovered.** No slice child delivers this story. Severity `blocker`.
- **Partially / ambiguously covered.** A child references the story's area but its body doesn't fully cover the triple. Common shapes: different actor, half the capability, ACs that stop short of the benefit. Severity `concern`. Cite the child's URL plus a one-line note on what's missing.

Children are not required to literally cite story numbers. When in doubt, prefer `concern` over silently calling something covered.

### Negative check: out-of-scope drift

For each item in `## Out of Scope`, flag any slice child whose body appears to scope in excluded work. Severity normally `concern`; promote to `blocker` only on unambiguous contradictions.

## Slice mode (`size:slice`)

Five categories. Skip any category cleanly if it doesn't apply rather than padding the report.

If an agent brief comment exists on the slice (rescue layer from a thin-body `/triage` run, per [triage/AGENT-BRIEF.md](../triage/AGENT-BRIEF.md)), read it for additional context. The slice body remains the canonical contract; the brief is not a third source of truth.

### 1. AC coverage and out-of-scope drift

For each item in the slice body's `## Acceptance criteria`, verify at least one open or closed task child's body delivers it. Uncovered ACs are severity `blocker`. Partially covered ACs (the child touches the area but the AC's exact criterion isn't met) are severity `concern`.

For each item in `## Out of scope`, flag any task child whose body appears to scope in excluded work. Severity normally `concern`; promote to `blocker` only on unambiguous contradictions.

### 2. Codebase grounding

The highest-value check. Every concrete claim about existing code in the slice body or any child body is a potential hallucination. Read the cited code and verify the claim holds.

#### Establish the baseline ref first

Before grounding any code assertion, establish WHICH branch's code the spec builds on and inspect FILE CONTENTS AT THAT REF — not the ambient working tree. The working tree's current branch is NOT a safe proxy for the spec's baseline: it is often on `main`, which lacks in-flight feature code, so a file or symbol that is absent there may be fully present on the branch the slice actually builds on.

Pick the baseline ref in this order:

1. The spec body's `**Integration Branch:**` line (e.g. `slice/issue-207-path-simplification`) — use it IF it exists on origin.
2. If the spec's own integration branch does NOT exist yet (slice not started — common when auditing right after `/decompose`), fall back to the PARENT's: read the `**Part of:** #<P>` line, `gh issue view <P>` for the parent body, and use ITS `**Integration Branch:**`. Walk up the parent chain until you find a branch that exists on origin.
3. Ultimate fallback, only if nothing in the chain exists on origin: the repo default branch (`main`).

`git fetch` the chosen ref, then read contents at it — `git show <ref>:path/to/file.ts` — for every grounding check below. Absence of a file or symbol in the working tree must NEVER be reported as "doesn't exist / hallucinated" without first confirming absence against the established baseline ref.

> Cautionary example (the #207 false halt): a check ran against the ambient working tree, which was on `main`. `main` lacked the in-flight feature's `outlineScene.ts`, so the check reported the file and a dependency as hallucinated — both were real on the feature's integration branch, which was never fetched. Establishing the baseline ref first is what prevents this.

For every concrete assertion the slice or a child makes about existing code ("the API client at `packages/.../stripe-client.ts` exposes a rate-limited fetch", "`resolveCheckoutUrl` returns `{ url, expiresAt }`", "`orders.primary_payment_method_id` already exists with `ON DELETE SET NULL`"), open the cited file at the baseline ref and confirm. Don't just check the file exists; check the **claim** about the file.

**Citations must be grounded in content actually read.** Do not emit a `file:line → <specific claim>` (or a claim about a specific call or symbol) unless you opened that path at the established baseline ref and the cited line or symbol is really there — quote or paraphrase the line you actually read. A finding asserting a symbol or call is ABSENT must state which ref was inspected to conclude absence. Reconstructed, inferred, or merely plausible citations are banned; a precise `file:line` claim that was never read is a fabrication, not a finding.

Watch especially for:

- **Hallucinated APIs.** Functions, methods, or modules named that don't exist, or exist with a different signature than the body implies.
- **Wrong assumptions about behavior.** The body says module X does Y; reading the code shows it does Z. Common with "the existing helper handles caching/auth/rate-limiting" claims.
- **Stale schema claims.** Column names, enum values, FK behaviors, RLS policies asserted to exist or behave a certain way. Check the project's schema directory against each claim.
- **External-API hallucinations.** Bodies touching third-party SDKs (Stripe, Supabase, AWS, Trigger.dev) sometimes invent endpoints or method names. Sanity-check against the SDK actually installed.
- **"Existing pattern" claims.** "Reuse the existing X pattern from Y". Open Y and confirm the pattern is there and shaped the way the body thinks.

When in doubt, read the file.

### 3. Per-task sizing

For each open task child, sanity-check its body:

- Flag tasks with more than ~6 AC items (likely needs further splitting).
- Flag tasks with no clear verification step (typecheck, test, manual smoke).
- Flag vague or non-actionable AC items ("update the relevant code", "refactor as needed").
- Flag tasks that bundle code changes with unrelated test additions, or vice versa, in ways that won't produce a coherent PR.

### 4. Sequencing

Native GitHub sub-issue order is the implicit default sequence; non-linear dependencies are encoded as `Blocked by #<N>` markers in a child's body. Read both. Keep closed children in scope; they're part of the dependency graph even after they ship.

Flag only the cases where wrong sequencing produces a broken intermediate state, not table prettiness:

- A task that imports a symbol introduced by a later task. The intermediate tree won't compile.
- Schema changes referenced by code in an earlier task. Types won't exist yet.
- Breaking type changes (collapsing a discriminated union, removing a public field) split across multiple tasks. The intermediate state has half-migrated consumers.
- Drops that precede the consumer rewrite that frees them (e.g. dropping a column in task 2 when task 4 still reads it).

A `Blocked by #X` marker pointing at a non-existent sibling, a closed-but-unmerged task, or a task outside this slice is a finding too; the marker won't gate execution as intended.

## Task mode (`size:task`)

Narrow spot-check on the task itself.

Resolve the parent first. If the body's first line is `**Part of:** #<P>`, fetch the parent body and the sibling task bodies (open + closed) once up front:

```bash
gh issue list --search "parent-issue:<owner>/<repo>#<P>" \
  --state all \
  --json number,title,state,body \
  --limit 100
```

If no `**Part of:**` line is present, the task is a standalone leaf. Skip the parent fetch and run the two narrow checks below without sibling context.

### 1. Codebase grounding

Same rules as slice mode's codebase grounding, scoped to this task's `## Scope` and `## Notes` only. Read every concrete claim about existing code and verify against the actual files.

### 2. AC sanity-check

Sanity-check the task's `## Acceptance criteria`:

- Flag more than ~6 AC items.
- Flag missing verification ("how does the executing agent know they're done?").
- Flag vague or non-actionable items.

### Sibling-context checks (only when a parent exists)

When the parent was fetched, two additional narrow checks run:

- **Lightweight sequencing.** If this task's body references a symbol, helper, or schema change that would come from a later open sibling, flag it as a sequencing finding. Closed siblings count as shipped, so references to their output are fine. Not a full slice-wide sequencing pass.
- **AC duplication or drift.** If this task's `## Acceptance criteria` repeats or contradicts the parent's `## Acceptance criteria` or any sibling's ACs, flag as `concern`.

Skip the full forward (coverage) and negative (out-of-scope drift) checks. Coverage is a sibling-shape question that belongs to slice mode; the task is a leaf.

## Output

Discuss findings with the user one at a time. The skill is conversational. Surface a finding, talk it through, move to the next.

If a soft-skip applies (negative check skipped because the body lacks an out-of-scope section), open the conversation with a one-line preamble noting the skip, e.g. `_<Tier> #<N> has no_ \`## Out of Scope\` _section. Running forward (coverage) check only._`. The preamble is conversational, not part of the `## Findings` block.

At the end of every completed run, print the canonical end-of-run output. This skill is an explicit exception to the three-block template (per [docs/agents/output-format.md](../../../docs/agents/output-format.md#skills-that-are-exceptions-to-the-template)): the `## Findings` block IS the structured artifact orchestrators parse, sandwiched between a one-sentence outcome line and a single `> Next step:` line.

### End-of-run shape

```
Audited <tier> #<N>; <N> findings surfaced (or "clean bill").

## Findings

- [<severity>] <one-line claim>. <ref> [<ref> ...]
- [<severity>] <one-line claim>. <ref>

> Next step: `/<skill> [args]`. <one-sentence reason>.
```

The outcome line names the audited tier in plain English (`initiative`, `feature`, `slice`, `task`). The next-step line is one of:

- `/decompose <N>` if the audit was clean and the next loop iteration is decomposition into children. (Initiative or feature, no findings.)
- `/execute <N>` if a task audit was clean and the task is ready to ship.
- If findings exist, omit the skill name and write `> Next step: resolve the findings above before continuing.` so the maintainer resolves them before the loop advances.

The `## Findings` block must sit between the outcome and next-step lines so orchestrators parsing the bottom-most `## Findings` heading reach it deterministically.

### Block shape

```
## Findings

- [<severity>] <one-line claim>. <ref> [<ref> ...]
- [<severity>] <one-line claim>. <ref>
```

- `<severity>` is one of `blocker`, `concern`, `nit`. Use `blocker` for things that will break execution (hallucinated APIs, missing schema, sequencing that won't compile, uncovered ACs, uncovered user stories, unambiguous out-of-scope contradictions). Use `concern` for things that probably need addressing but aren't tree-killing (partial coverage, ordinary out-of-scope drift, AC duplication). Use `nit` for everything else.
- The one-line claim is the same one-sentence summary used when raising the finding in conversation. No multi-sentence explanations; those belong above.
- `<ref>` is a `path/to/file.ts:line` (bare path is fine when the whole file is the cite) or an issue/comment URL. Coverage findings cite tracker URLs (the spec or specific children); grounding findings cite file paths. Multiple references are space-separated on the same bullet.
- One bullet per finding, in the order they were surfaced in conversation.

### Clean-bill case

If no issues were surfaced, still emit the block with the canonical sentinel so a parser doesn't have to special-case "absent":

```
## Findings

_No issues surfaced._
```

The italic-underscore form is load-bearing. Orchestrators use it to distinguish "ran cleanly" from "ran but the block is missing or malformed" (which they treat as a failed leg).

### Refusal paths do not emit the block

When the skill exits via any of the [refusal paths](#refusal-paths) (missing issue, closed spec, no size label, missing required body section, non-issue argument), surface the refusal message and stop. Do not append `## Findings`, do not append the clean-bill sentinel. The orchestrator distinguishes "leg refused" from "leg ran clean" by the absence vs presence of the block; emitting the sentinel on refusal collapses those two outcomes and breaks the parser.

The soft-skip path (body lacks an out-of-scope section) is **not** a refusal; the forward check still runs, so the block is still emitted.

## Hard rules

- **Read-only.** No `gh issue edit`, no `gh issue comment`, no `gh issue create`, no working-tree modifications. The skill emits a `## Findings` block to the terminal and exits.
- **Output contract is uniform across tiers.** `## Findings` heading, bullet shape, severity vocabulary, clean-bill sentinel. `/audit` parses any tier's output with one parser; deviating from the contract breaks the orchestrator.
- **Semantic judgement, not lexical.** Children are not required to cite stories or AC numbers in their bodies. Judge coverage by reading the bodies. When in doubt, prefer `concern` over silent coverage. A false-positive concern is cheap; a false-negative miss is the failure mode this skill exists to prevent.
- **The slice body is the contract, not the brief.** When an agent brief comment exists, it's additional context, not a third source of truth.

## What this skill does NOT do

- It does not write anywhere. No comments, no body edits, no new issues. `/audit` is the write path.
- It does not audit a spec's `## Implementation Decisions` against the codebase at the feature tier. That's the slice-level codebase grounding check.
- It does not require children to cite story or AC numbers.
- It does not auto-fix anything it surfaces. The maintainer reads the findings and decides.
- It does not run automatically from `/decompose`. The integration is a printed nudge in `/decompose`'s end-of-run line.
