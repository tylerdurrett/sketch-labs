# End-of-run output format

What every workflow skill prints on completion — tight and consistent so the maintainer can pick up the next step without re-reading prose.

## Three-block template

When a skill produces a durable artifact (new issue, posted comment, opened PR, body edit, label transition, branch push), end the run with:

```
<one-sentence plain-English outcome>

- <durable artifact URL or ref>
- <additional artifact, if any>

> Next step: `/<skill> [args]`. <one-sentence reason>.
```

Rules the template doesn't show:

- **Block 1**: one sentence a non-developer could read. Branch names, SHAs, jargon belong in block 2. No "Successfully..." filler, no multi-sentence summary, no listing what the skill did NOT do.
- **Block 2**: concrete clickable URLs or refs. Skip the block (no leading blank line) when nothing durable to link.
- **Block 3**: the natural next move in the lifecycle loop. Must match the run's actual state (no hard-coded next step) and stay inside the loop — never `/diagnose` or `/improve-codebase-architecture` as a handoff. If the chain genuinely terminates, omit the block and write `Stop.` on its own line.

Example — a `/ship` run at the task tier:

```
Shipped task #143 via PR #144. The export-pipeline slice now has 3 of 4 tasks landed.

- https://github.com/tylerdurrett/experiment-harness/pull/144
- on branch: slice/issue-83-export-pipeline
- task issue closed: #143

> Next step: `/execute #145`. Last open task on the same slice.
```

## Skills that are exceptions to the template

These skills' entire output IS the report:

- **`/status`**: multi-section warm-prose report reading like a stakeholder status update — the lead paragraph names active work by title, and "What to do next" gives one recommendation. Voice rules below still apply.
- **`/triage`** in conversational mode: prose survey, recommendation embedded in the body.
- **`/grill-with-docs`**: interview format; no canonical wrap-up line.
- **`/check`**: the terminal `## Findings` block is the structured artifact `/audit` parses.

`/audit` follows the three-block template — its durable artifacts (synthesis comment, edited child bodies, new children, propagation comments) go in the links block. Every other workflow skill follows the template.

## Voice rules

These apply to the three-block template AND the exception skills above.

### Plain English over git/GitHub jargon

"Shipped"/"landed" over "merged"; the feature title over the kebab-case slug. PR numbers as parentheticals are fine: "(PR #45)".

### Lead with the thing being built

"You're shipping the inbox feature" beats "You're on `feature/issue-12-inbox`."

### No conventional-commit prefixes in user-facing prose

`feat(assets):` belongs in commit subjects, not the outcome line.

### Compress related artifacts

Five tiny things in one bucket: one summary line plus the URLs, not five repetitive bullets.

### Be specific

"Three sub-tasks: a server action, the tab body, a reconnect banner" beats "Phase 2 work."
