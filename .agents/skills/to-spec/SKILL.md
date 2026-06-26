---
name: to-spec
description: Capture the current conversation context as a spec on the project issue tracker — sized at one of initiative / feature / slice / task — and recommend `/triage` as the next step. Use when the user wants to publish what's been aligned-on so far.
---

# To Spec

Synthesize the current conversation into a spec and publish it to the tracker. Do NOT interview the user — work from what you already know.

A "spec" is the generic captured artifact regardless of tier. Size is set at publish time; `/triage` verifies that call and handles the structural bookkeeping that follows (integration branch declaration, sticky progress comment).

For tracker mechanics see [docs/agents/issue-tracker.md](../../../docs/agents/issue-tracker.md); for label vocabulary see [docs/agents/triage-labels.md](../../../docs/agents/triage-labels.md); for the canonical end-of-run output see [docs/agents/output-format.md](../../../docs/agents/output-format.md).

## Process

1. **Ground the spec.** Read `CONTEXT.md` if present, respect ADRs in the touched area, use the project's domain glossary throughout. Sketch the major modules you'd build or modify; favor deep modules (testable in isolation, simple interface, rarely-changing).

2. **Pick a size.** State the call inline so the user can override; commit unless they push back.

   | Size              | Scope                                                                              |
   | ----------------- | ---------------------------------------------------------------------------------- |
   | `size:initiative` | Multi-feature effort. Goal/purpose document. Months.                               |
   | `size:feature`    | Cohesive unit of user-facing value spanning multiple slices. Weeks.                |
   | `size:slice`      | Vertical cut of a feature, demoable end-to-end, multiple tasks. Days.              |
   | `size:task`       | One PR's worth of work. Hours.                                                     |

   Default toward the larger tier when scope is ambiguous. A mis-sized `size:task` blows up mid-execution; a mis-sized `size:feature` is fixed by `/triage`.

3. **Infer a parent.** Walk the conversation for explicit `#N` references first; use that if present. Otherwise, when scope suggests the spec belongs under existing work, list candidates one tier larger:

   ```bash
   gh issue list --label "size:initiative" --label "size:feature" --label "size:slice" --state open \
     --json number,title,labels
   ```

   Match conversationally; confirm with the user before attaching. The parent should be exactly one tier larger (initiative → feature → slice → task). Flag mismatched parentage to the user but follow their direction if they push through.

   Skip silently if no parent fits — orphan specs at any size are first-class.

4. **Write the body** using the template for the chosen size (see [Body templates](#body-templates)).

5. **Publish to the tracker.**

   ```bash
   gh issue create \
     --title "<title>" \
     --body-file - \
     --label "size:<tier>" \
     --label "needs-triage"
   ```

   `needs-triage` signals that the bookkeeping pass is still pending: `/triage` will declare the integration branch (for `size:feature` / `size:slice`), seed the sticky `<!-- progress-comment:initiative -->` comment (for `size:initiative`), and apply the state label (`ready-for-agent` / `needs-grilling` / etc.).

6. **Attach as a native sub-issue (only when a parent was inferred).** Resolve the child's database `id` first, then POST, then prepend `**Part of:** #<P>` to the body:

   ```bash
   child_id=$(gh api repos/<owner>/<repo>/issues/<N> --jq .id)
   gh api -X POST repos/<owner>/<repo>/issues/<P>/sub_issues -F sub_issue_id="$child_id"
   gh issue edit <N> --body-file -   # rewritten body with **Part of:** #<P> on the first line
   ```

   `**Part of:**` is a load-bearing greppable anchor used by `/ship` (at the slice and feature tiers) to walk upward.

7. **Print the end-of-run output** following the three-block template:

   ```
   Spec #<N> published at <size> size.

   - <issue URL>

   > Next step: `/triage <N>`. Verify size, apply state, seed bookkeeping.
   ```

## Body templates

### `size:initiative`

```markdown
## Outcome

The user/business outcome being chased. One paragraph. The thing that, if true a year from now, makes this initiative worth having existed.

## Problem

Why this initiative exists — the gap between today and the outcome. One or two paragraphs.

## Definition of done

The user-visible result of "shipped." NOT a checklist of features. Describe what is true in the world when the initiative closes — what someone using the system can now do, see, or rely on that they couldn't before.

## Out of scope

Explicit non-goals. One bullet per non-goal, focusing on adjacent work that would naturally creep in.

## Candidate features

One-line bullets, no issue links. Each bullet is a feature the author imagines will exist, sketched lightly enough to have a real conversation about whether the initiative is shaped right. As candidates materialize via `/to-spec` (initiative as parent) or `/decompose <I>`, bullets are removed and rows appear in the sticky `<!-- progress-comment:initiative -->` comment seeded by `/triage`.

- candidate one — one-line description
- candidate two — one-line description
```

### `size:feature`

```markdown
## Problem Statement

The problem the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A long, numbered list:

1. As an <actor>, I want a <capability>, so that <benefit>.

Cover all aspects of the feature.

## Implementation Decisions

- Modules to build or modify
- Module interfaces
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include file paths or code snippets — they go stale quickly.

## Testing Decisions

- What makes a good test for this feature (test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests

## Out of Scope

Explicit non-goals.

## Further Notes

Anything else worth capturing.
```

### `size:slice`

```markdown
## Scope

The vertical cut of the parent feature this slice ships. End-to-end demoable when all child tasks land.

## Candidate tasks

One-line bullets sketching the tasks this slice will decompose into. `/decompose <S>` materializes these into `size:task` children.

- task one — one-line description
- task two — one-line description

## Acceptance criteria

- [ ] criterion one
- [ ] criterion two

## Out of scope

Adjacent things explicitly not in this slice.
```

### `size:task`

```markdown
## Scope

The single PR's worth of work.

## Acceptance criteria

- [ ] criterion one
- [ ] criterion two

## Notes

Anything else worth surfacing — file references, prior art, sequencing constraints.
```

## Verification

Manual end-to-end checklist.

1. **Run `/to-spec` from a real alignment context.** The skill synthesizes without interviewing. The size call appears in the conversation before publish.
2. **Inspect the published issue.** Carries `size:<tier>` and `needs-triage`. No `type:*` labels. No `**Integration Branch:**` line. Body matches the template for the picked size.
3. **Parent inferred case.** Body's first line is `**Part of:** #<P>` (case-sensitive). `gh issue view <P>` lists the new spec in its Sub-issues panel.
4. **No parent case.** Body has no `**Part of:**` line. The spec is a top-level entry.
5. **Output format.** Three-block template, ending with a `/triage <N>` next-step line.

If any step surfaces drift, fix the skill in a follow-up — the skill is the source of truth.
