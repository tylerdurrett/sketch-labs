# Autopilot stages — skip checks and sub-agent briefs

One section per stage: the idempotency skip check (always run first, against live tracker state), then how the stage runs — a `Task` sub-agent brief for stages 1–4, or the inline procedure the orchestrator itself follows for stage 5 (batch) — and the summary shape the run must produce. Prompts are shapes to adapt, not scripts to paste — but keep their load-bearing sentences (marked inline) intact.

Shared conventions:

- Every sub-agent (stages 1–4) is a general-purpose Claude agent with full tools.
- Every sub-agent brief ends with the same closing instruction: *"Return, as your entire final message, only the structured summary described above — no transcript, no file dumps."* The orchestrator keeps only that summary.
- `<S>` is the slice issue number throughout.

## Stage 1: Decompose

**Skip check** — the slice already has `size:task` children:

```bash
gh api "repos/{owner}/{repo}/issues/<S>/sub_issues" \
  --jq '[.[] | select([.labels[].name] | index("size:task"))] | length'
```

Non-zero → skip (record `decompose: skipped, <n> existing task children`). Zero → dispatch.

**Sub-agent brief:**

> Run the `/decompose` skill against issue `#<S>` in this repo, to completion. The slice is already triaged; produce its `size:task` children per the skill. **You are running unattended under `/autopilot`: at the skill's quiz step (Step 5), act as the approver yourself — sanity-check the granularity and dependency edges, then proceed to publish without waiting for a human.** Return a structured summary: the child issue numbers and titles created (with any `Blocked by` edges), and the parent's label transition.

**Summary shape:** `decomposed #<S> into tasks #<X>..#<Y>` + one line per child (`#<N> <title> [blocked by #<M>]`).

## Stage 2 (+3): Audit and apply

**Skip check** — a dated audit synthesis comment already exists on the slice:

```bash
gh api "repos/{owner}/{repo}/issues/<S>/comments" \
  --jq '[.[] | select(.body | startswith("## Audit synthesis ("))] | length'
```

Non-zero → skip stages 2 and 3 (record `audit: skipped, synthesis comment exists`). Zero → dispatch.

**Sub-agent brief:**

> Run the `/audit` skill against issue `#<S>` in this repo, to completion, in **auto-approve-routine mode**. `/audit`'s approval gate (its Step 9) normally walks a human through each finding; **you are running under `/autopilot`, whose invocation is the standing approval for ROUTINE findings only** — so classify each surviving finding before the gate:
>
> - **BLOCKING** — exactly these four categories: (1) a "task" child that is actually slice-sized; (2) slice scope drift — uncovered scope that changes the slice's boundary; (3) a sequencing reversal that breaks the dependency DAG; (4) hallucinated API surface that a task depends on. When genuinely unsure, classify as blocking.
> - **ROUTINE** — everything else (wording, coverage gaps closable by a per-child body edit, small task tweaks).
>
> If there are **zero blocking findings**: approve every routine finding and every spec-level write yourself, and let `/audit` land its writes per its own Step 10 (per-child `## Audit findings` body edits, the dated synthesis comment, any in-bar propagation comments). If there are **any blocking findings**: land NO writes tied to them; still land the routine writes and the synthesis comment (tag the blocking bullets clearly), then report the blockers — do not attempt to fix them.
>
> Return a structured summary: total findings by provenance; the routine findings applied (one line each: severity, provenance, claim, which child was edited); the synthesis comment URL; and a `BLOCKING:` section listing each blocking finding (category, claim, provenance, affected child) — or `BLOCKING: none`.

**Orchestrator decision:** `BLOCKING: none` → emit the non-blocking audit-boundary checkpoint (counts, what was auto-applied, provenance) and proceed to stage 4. Any blocking finding → **HALT**: summarize the blockers and hand back per the SKILL.md halted-run output. Do not proceed to triage or batch.

If the audit sub-agent reports its Codex leg fell through, that is not a halt — `/audit` itself continues single-leg. Note it in the checkpoint.

## Stage 4: Triage tasks

**Skip check** — per task. List the slice's `size:task` children and partition by the `needs-triage` label:

```bash
gh api "repos/{owner}/{repo}/issues/<S>/sub_issues" \
  --jq '.[] | select(.state == "open") | {number, title, labels: [.labels[].name]}'
```

Children without `needs-triage` are already triaged — skip them. If none carry `needs-triage`, skip the whole stage. Otherwise dispatch **one sub-agent per untriaged task, all in parallel** (one `Task` call each, same response).

**Per-task sub-agent brief:**

> Run the `/triage` skill against task issue `#<T>` in this repo, to completion. It is a `size:task` child of slice `#<S>`, produced by `/decompose`. **You are running unattended under `/autopilot`: where `/triage` would confirm with a human (size verification, state choice), make the call yourself per the skill's own tables.** The expected happy path is `ready-for-agent`; if the task genuinely warrants a non-happy-path state (`needs-info`, `ready-for-human`, …), apply it honestly — do not force `ready-for-agent`. Return a structured summary: the size verified (or changed), the state applied, and one sentence of reasoning.

**Orchestrator decision:** all tasks ended `ready-for-agent` (whether via this stage or already) → proceed. Any task ended elsewhere → **HALT** and report which tasks aren't ready and why — a batch run against a partially-ready slice cannot open the promotion PR, so it would be a wasted run. The user resolves those tasks and re-runs `/autopilot <S>`.

## Stage 5: Batch (runs inline in the orchestrator)

**Skip check:** none. `/batch` handles its own resume, pre-flight filtering, and DAG internally — just hand off to it. (Closed/already-shipped tasks simply aren't eligible on a re-run.)

**This stage does NOT run as a sub-agent.** The orchestrator runs `/batch #<S>` in its own loop, because batch is built to be driven from the calling agent loop and its background `Workflow` re-notifies *that* loop on completion — a settle handshake proven in the main loop but uncertain when nested inside a backgrounded `Task`. Batch already fans every task into worktree-isolated agents, so running it inline costs the orchestrator no extra context (it only ever holds batch's final summary) while removing the await/settle risk of nesting it.

**Inline procedure** — the orchestrator itself performs batch's steps:

1. Run `/batch #<S>` per the batch skill. At batch's **Step 4 approval gate**, the autopilot invocation *is* the plan approval — do not stop for a human; record the inferred DAG (waves) so it lands in the end-of-run output, then proceed.
2. Invoke the `Workflow` tool (batch's Step 5) from the orchestrator's own loop. It runs in the background; let its completion notification return to this loop, and let batch's Settle phase finish (auto-defer, reconcile, slice promotion PR, cleanup).
3. Read batch's structured `{ results, summary }` and its end-of-run report — tasks squash-merged, tasks held by code review (finding counts + PR URLs), failed/skipped tasks with reasons, deferred issues filed, and the slice promotion PR URL (or exactly why it was not opened).

**Report to relay:** the approved DAG plus batch's own end-of-run report content, folded into autopilot's end-of-run output.

**Orchestrator decision:** Slice PR opened → completed-run shape. Slice PR withheld (held/failed tasks, pre-flight blockers) → this is still the end of the autopilot run, not a halt-and-retry: report what batch reported, loudly, with the user's unblocking actions as the next step.
