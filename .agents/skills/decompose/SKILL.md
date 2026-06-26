---
name: decompose
description: Decompose any tier-bearing spec into native sub-issues one tier smaller (`size:initiative` to features, `size:feature` to slices, `size:slice` to tasks). Use when the user wants to break a spec down into children for the next loop iteration.
---

# Decompose

Tier-aware decomposition. Reads the input spec's `size:*` label and produces children one tier smaller, attached as native GitHub sub-issues.

| Input             | Children produced                                         |
| ----------------- | --------------------------------------------------------- |
| `size:initiative` | `size:feature` children                                   |
| `size:feature`    | `size:slice` children                                     |
| `size:slice`      | `size:task` children                                      |

Children land with `size:<child-tier>` + `needs-triage` only. `/triage` handles per-child routing (state label, `needs-grilling` at the initiative→feature boundary, integration-branch declaration for `size:feature` / `size:slice`, sticky progress comment for `size:initiative`).

This skill is the *writer*; `/execute` is the *runner*. Integration branches are not created on origin here. `/execute` seeds them lazily on first use, walking the parent chain per [ADR-0001](../../../docs/adr/0001-issues-branch-from-parent-integration-branch.md) (or the slot it landed in if `0001` was already taken).

For tracker mechanics see [docs/agents/issue-tracker.md](../../../docs/agents/issue-tracker.md); for label vocabulary see [docs/agents/triage-labels.md](../../../docs/agents/triage-labels.md); for the canonical end-of-run output see [docs/agents/output-format.md](../../../docs/agents/output-format.md).

## When to use

- A `size:initiative`, `size:feature`, or `size:slice` spec is ready to break down.

## When NOT to use

- The input is `size:task` (tasks are leaves; run `/execute` instead).
- The input has no size label (run `/triage` first to size it).

## Process

### 1. Fetch the input spec

Pull the spec via `gh issue view <N> --comments`. Read body, labels, and any comments that update the contract. If the spec is `size:slice`, also check for an agent brief comment on the `ready-for-agent` transition.

If the spec has a parent (`**Part of:** #<P>` line near the top of the body), fetch the parent for context (out-of-scope items, Definition of done, surrounding decisions). Don't read sibling children. That's noise.

### 2. Determine the child tier

Read the input's size label:

- `size:initiative` → produce `size:feature` children
- `size:feature` → produce `size:slice` children
- `size:slice` → produce `size:task` children

If the input has no size label or carries `size:task`, stop and tell the user. Recommend `/triage <N>` or `/execute <N>` respectively.

### 3. Ground the decomposition

Read `CONTEXT.md` if present and respect ADRs in the touched area. Use the project's domain glossary throughout.

- **`size:feature` and `size:slice` inputs**: explore the codebase using the spec's named modules, types, and packages as entry points. Children should land grounded in real file paths and existing module boundaries.
- **`size:initiative` inputs**: codebase exploration is optional. Initiatives are outcome-shaped; feature children are still under-specified at this point.

### 4. Draft the children

Build the per-child plan using these rules:

- **One child per cohesive unit.** Each child is the smallest end-to-end shippable thing at the child tier. Tasks are one PR's worth of work; slices are one demoable vertical cut; features are one cohesive user-facing capability.
- **Vertical slices, not horizontal layers.** Each child cuts through every relevant layer (schema, API, UI, tests). Never a "tests only" or "migration only" child unless that's genuinely the whole shippable unit.
- **Demoable progressions where possible.** Sequence children so each one lands a visible checkpoint. Foundational work (schema, plumbing) goes early; user-visible work follows.
- **Reordering allowed.** Deviate from any implied sequencing in the input spec if a different order is more demoable or testable.
- **Many thin over few thick.** When in doubt, split.

### 5. Quiz the user

Present the proposed breakdown as a numbered list. For each child show:

- **Title**: short, descriptive.
- **One-line scope**: what this child ships.
- **Blocked by**: sibling numbers, only when non-linear.

Ask:

- Does the granularity feel right (too coarse / too fine)?
- Are the dependency edges correct?
- Should any children merge or split?

Iterate until approved.

### 6. Publish the children

For each approved child, in dependency order so later children can reference real prior numbers:

1. **Write the body** using the [`/to-spec` template for the child tier](../to-spec/SKILL.md#body-templates). Prepend `**Part of:** #<P>` as the first line of the body. That line is the canonical greppable parent anchor.

2. **Add a `## Blocked by` section** only for non-linear sibling dependencies. List one prerequisite per line as `Blocked by #<N>`. For the natural linear case (each child depends only on the previous), GitHub's sub-issue order is sufficient, so omit the section entirely. Don't write `Blocked by: None`.

3. **Create the issue**:

   ```bash
   gh issue create \
     --title "<exact child title>" \
     --label "size:<child-tier>" \
     --label "needs-triage" \
     --body-file -
   ```

4. **Attach as a native sub-issue** of the input spec using the [sub-issue attach helper](#sub-issue-attach-helper) below. The native attach is in addition to the body's `**Part of:**` line, not a replacement. The body link is for human readability; the attach gives GitHub the auto-rollup count.

### 7. Transition the parent's label

After all children are published, swap whatever state label the parent carried for `in-progress`:

```bash
gh issue edit <N> \
  --remove-label "needs-triage" \
  --remove-label "ready-for-agent" \
  --remove-label "needs-grilling" \
  --add-label "in-progress"
```

`gh issue edit` tolerates removing labels that aren't present, so the call is idempotent. If the parent is closed (re-decompose after a premature auto-close), reopen it first:

```bash
gh issue reopen <N> --comment "Reopening to extend the decomposition via /decompose."
```

### 8. Print the end-of-run output

Follow the three-block template:

```
Decomposed <tier> #<P> into N <child-tier>s (#<X>–#<Y>).

- https://github.com/<owner>/<repo>/issues/<P>
- new <child-tier>s: #<X>, #<X+1>, ..., #<Y>

> Next step: `/check #<P>`. Verify the decomposition covers what the spec promised before triaging children. Reach for `/audit #<P>` when the cost of a flawed decomposition is high.
```

Use plain words for `<tier>` and `<child-tier>` (feature, slice, task). No `size:` prefix in the outcome line. Compress the child list onto one line per the [output format's voice rules](../../../docs/agents/output-format.md#compress-related-artifacts).

## Re-decompose

Running `/decompose` against a spec that already has open children is supported. In Step 6, list existing open children first:

```bash
gh issue list --search "parent-issue:<owner>/<repo>#<P> is:open"
```

Skip creating any child whose title exactly matches an existing open child. Append new children after the existing ones. Don't modify or close existing children. If the maintainer needs to remove a stale child, they close it manually.

## Sub-issue attach helper

Reusable procedure for attaching a child issue as a native sub-issue of its parent. GitHub renders the relationship in the parent's Sub-issues panel and tracks the auto-rollup count.

### Call shape

The REST endpoint expects the child's database `id` (numeric, e.g. `4377823883`), not its human-facing `number` (e.g. `72`). Resolve the `id` first, then POST:

```bash
child_id=$(gh api repos/<owner>/<repo>/issues/<child-number> --jq .id)

gh api -X POST repos/<owner>/<repo>/issues/<parent-number>/sub_issues \
  -F sub_issue_id="$child_id"
```

Two ways this 422s:

- **Passing `number` instead of `id`**: the API only accepts the database ID.
- **Using `-f` instead of `-F`**: `-f` quotes the value as a string, but `sub_issue_id` must be a typed integer.

### Loud-failure semantics

On any non-2xx response (network error, 422, 404, 403, etc.), log a single line:

```
[sub-issue attach failed] #<child> → #<parent>: <error>
```

and **continue**. Never abort the calling skill on attach failure. The child issue is already published and the relationship can be repaired by hand.

### One-parent constraint

GitHub enforces one parent per child. Re-attaching an already-attached child returns 422 with a body like `"Issue may not contain duplicate sub-issues and Sub issue may only have one parent"`. Treat that case as "already attached, log and continue" so idempotent re-runs are safe.

## Verification

Manual end-to-end checklist.

1. **Run `/decompose` against a `size:feature` spec.** Children land carrying `size:slice` + `needs-triage`. The parent's state label is swapped for `in-progress`.
2. **Run `/decompose` against a `size:slice` spec.** Children land carrying `size:task` + `needs-triage`.
3. **Inspect a child body.** First line is `**Part of:** #<P>` (case-sensitive). Body matches the [`/to-spec` template](../to-spec/SKILL.md#body-templates) for the child tier.
4. **Native sub-issue panel.** `gh issue view <P>` lists each new child in its Sub-issues panel. Auto-rollup count reflects open/closed state.
5. **Re-run on the same parent.** Existing children are preserved; new children are appended only.
6. **Output format.** Three-block template, ending with a `/check <P>` next-step line.

If any step surfaces drift, fix the skill in a follow-up. The skill is the source of truth.
